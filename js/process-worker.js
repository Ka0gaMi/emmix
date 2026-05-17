import { runWasiModule } from "./runner.js";

const worker = await workerPort();

worker.onMessage(async (message) => {
  await handleMessage(message);
});

async function handleMessage(message) {

  if (!message || message.type !== "run") {
    return;
  }

  const { id, wasmBytes, args, environ, stdin, runtimeWasm } = message;

  try {
    const result = await runWasiModule(wasmBytes, {
      args,
      environ,
      stdin,
      runtimeWasm,
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
