import { createEmmixRunner } from "./runner.js";

const worker = await workerPort();
let runnerPromise;

worker.onMessage(async (message) => {
  await handleMessage(message);
});

async function handleMessage(message) {

  if (!message) {
    return;
  }

  if (message.type === "workspace") {
    await handleWorkspaceMessage(message);
    return;
  }

  if (message.type !== "run") {
    return;
  }

  const { id, wasmBytes, args, environ, stdin, runtimeWasm, workspaceSnapshot } = message;

  try {
    const runner = workspaceSnapshot === undefined
      ? await persistentRunner(runtimeWasm)
      : await snapshotRunner(runtimeWasm, workspaceSnapshot);
    const result = await runner.run(wasmBytes, undefined, {
      args,
      environ,
      stdin,
      onStdout: (chunk) => postOutput(id, "stdout", chunk),
      onStderr: (chunk) => postOutput(id, "stderr", chunk),
    });

    const stdout = result.stdout;
    const stderr = result.stderr;
    const finalWorkspaceSnapshot = exportWorkspaceSnapshot(runner.workspace);
    const transfer = [
      stdout.buffer,
      stderr.buffer,
      ...snapshotTransferList(finalWorkspaceSnapshot),
    ];

    worker.postMessage(
      {
        id,
        type: "result",
        exitCode: result.exitCode,
        stdout,
        stderr,
        missingSyscalls: result.missingSyscalls,
        workspaceSnapshot: finalWorkspaceSnapshot,
      },
      transfer,
    );
  } catch (error) {
    worker.postMessage({
      id,
      type: "error",
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  }
}

async function handleWorkspaceMessage(message) {
  const { id, operation, runtimeWasm } = message;

  try {
    const runner = await persistentRunner(runtimeWasm);
    const value = workspaceOperation(runner.workspace, operation, message);
    const transfer = value instanceof Uint8Array ? [value.buffer] : undefined;

    worker.postMessage(
      {
        id,
        type: "workspaceResult",
        value,
      },
      transfer,
    );
  } catch (error) {
    worker.postMessage({
      id,
      type: "error",
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  }
}

function workspaceOperation(workspace, operation, message) {
  switch (operation) {
    case "readFile":
      return workspace.readFile(message.path);
    case "writeFile":
      workspace.writeFile(message.path, message.bytes);
      return undefined;
    case "readDir":
      return workspace.readDir(message.path);
    case "mkdir":
      workspace.mkdir(message.path);
      return undefined;
    case "removeFile":
      workspace.removeFile(message.path);
      return undefined;
    case "removeDirectory":
      workspace.removeDirectory(message.path);
      return undefined;
    case "rename":
      workspace.rename(message.oldPath, message.newPath);
      return undefined;
    case "stat":
      return workspace.stat(message.path);
    case "exportSnapshot":
      return exportWorkspaceSnapshot(workspace);
    default:
      throw new Error(`unknown workspace operation: ${operation}`);
  }
}

function persistentRunner(runtimeWasm) {
  if (runnerPromise === undefined) {
    runnerPromise = createEmmixRunner({ runtimeWasm });
  }

  return runnerPromise;
}

async function snapshotRunner(runtimeWasm, snapshot) {
  const runner = await createEmmixRunner({ runtimeWasm });
  importWorkspaceSnapshot(runner.workspace, snapshot);
  return runner;
}

function exportWorkspaceSnapshot(workspace, root = "/") {
  const entries = [{ path: "/", type: "directory" }];
  collectWorkspaceSnapshot(workspace, root, entries);
  return entries;
}

function collectWorkspaceSnapshot(workspace, path, entries) {
  for (const name of workspace.readDir(path)) {
    const childPath = (path === "/" ? "" : path) + "/" + name;
    const stat = workspace.stat(childPath);

    if (stat?.type === "directory") {
      entries.push({ path: childPath, type: "directory" });
      collectWorkspaceSnapshot(workspace, childPath, entries);
    } else if (stat?.type === "file") {
      entries.push({
        path: childPath,
        type: "file",
        bytes: workspace.readFile(childPath),
      });
    }
  }
}

function importWorkspaceSnapshot(workspace, snapshot) {
  const entries = [...(snapshot ?? [])].sort((a, b) =>
    pathDepth(a.path) - pathDepth(b.path),
  );

  for (const entry of entries) {
    if (entry.path === "/") {
      continue;
    }

    if (entry.type === "directory") {
      try {
        workspace.mkdir(entry.path);
      } catch {
        // Snapshot import is best-effort for existing directories.
      }
    }
  }

  for (const entry of entries) {
    if (entry.type === "file") {
      workspace.writeFile(entry.path, entry.bytes ?? new Uint8Array());
    }
  }
}

function pathDepth(path) {
  return path.split("/").filter(Boolean).length;
}

function snapshotTransferList(snapshot) {
  const buffers = new Set();

  for (const entry of snapshot) {
    if (entry.type === "file" && entry.bytes instanceof Uint8Array) {
      buffers.add(entry.bytes.buffer);
    }
  }

  return [...buffers];
}

function postOutput(id, stream, chunk) {
  const bytes = new Uint8Array(chunk);
  worker.postMessage(
    {
      id,
      type: "output",
      stream,
      chunk: bytes,
    },
    [bytes.buffer],
  );
}

async function workerPort() {
  if (typeof self !== "undefined" && typeof self.postMessage === "function") {
    return {
      onMessage(callback) {
        self.onmessage = (event) => callback(event.data);
      },
      postMessage(message, transfer) {
        self.postMessage(message, transfer);
      },
    };
  }

  const { parentPort } = await import("node:worker_threads");

  if (!parentPort) {
    throw new Error("process worker must run inside a Worker");
  }

  return {
    onMessage(callback) {
      parentPort.on("message", callback);
    },
    postMessage(message, transfer) {
      parentPort.postMessage(message, transfer);
    },
  };
}
