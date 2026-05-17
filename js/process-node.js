import { Worker } from "node:worker_threads";

export class EmmixProcess {
  constructor(options = {}) {
    this.workerUrl = options.workerUrl ?? new URL("./process-worker.js", import.meta.url);

    this.nextId = 1;
    this.pending = new Map();
    this.worker = undefined;
    this.startWorker();
  }

  startWorker() {
    this.worker = new Worker(this.workerUrl, { type: "module" });
    this.worker.on("message", (message) => this.handleMessage(message));
    this.worker.on("error", (error) => {
      for (const { reject } of this.pending.values()) {
        reject(error);
      }
      this.pending.clear();
    });
  }

  run(wasmBytes, options = {}) {
    const id = this.nextId++;
    const bytes = toOwnedUint8Array(wasmBytes);

    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve,
        reject,
        onStdout: options.onStdout,
        onStderr: options.onStderr,
      });
      this.worker.postMessage(
        {
          id,
          type: "run",
          wasmBytes: bytes,
          args: options.args,
          environ: options.environ,
          stdin: options.stdin,
          runtimeWasm: options.runtimeWasm,
        },
        [bytes.buffer],
      );
    });
  }

  terminate() {
    this.worker.terminate();
    for (const { reject } of this.pending.values()) {
      reject(new Error("process worker terminated"));
    }
    this.pending.clear();
  }

  cancel(id) {
    const cancelled = id === undefined
      ? [...this.pending.keys()]
      : this.pending.has(id)
        ? [id]
        : [];

    if (cancelled.length === 0) {
      return false;
    }

    this.worker.terminate();

    for (const pendingId of cancelled) {
      const pending = this.pending.get(pendingId);
      pending?.reject(new Error("process cancelled"));
      this.pending.delete(pendingId);
    }

    for (const pending of this.pending.values()) {
      pending.reject(new Error("process worker restarted"));
    }
    this.pending.clear();
    this.startWorker();
    return true;
  }

  handleMessage(message) {
    const pending = this.pending.get(message.id);

    if (!pending) {
      return;
    }

    if (message.type === "output") {
      if (message.stream === "stdout") {
        pending.onStdout?.(message.chunk);
      } else if (message.stream === "stderr") {
        pending.onStderr?.(message.chunk);
      }
      return;
    }

    this.pending.delete(message.id);

    if (message.type === "result") {
      pending.resolve({
        exitCode: message.exitCode,
        stdout: message.stdout,
        stderr: message.stderr,
      });
      return;
    }

    const error = new Error(message.message || "process worker failed");
    error.stack = message.stack || error.stack;
    pending.reject(error);
  }
}

function toOwnedUint8Array(value) {
  if (value instanceof Uint8Array) {
    return new Uint8Array(value);
  }

  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value.slice(0));
  }

  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }

  throw new TypeError("expected wasm bytes as Uint8Array, ArrayBuffer, or typed array");
}
