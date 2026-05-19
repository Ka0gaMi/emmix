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

  const { id, wasmBytes, args, environ, stdin, runtimeWasm } = message;

  try {
    const runner = await persistentRunner(runtimeWasm);
    const result = await runner.run(wasmBytes, undefined, {
      args,
      environ,
      stdin,
      onStdout: (chunk) => postOutput(id, "stdout", chunk),
      onStderr: (chunk) => postOutput(id, "stderr", chunk),
    });

    const stdout = result.stdout;
    const stderr = result.stderr;

    worker.postMessage(
      {
        id,
        type: "result",
        exitCode: result.exitCode,
        stdout,
        stderr,
        missingSyscalls: result.missingSyscalls,
      },
      [stdout.buffer, stderr.buffer],
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
