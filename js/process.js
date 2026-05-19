export class EmmixProcess {
  constructor(options = {}) {
    this.workerUrl = options.workerUrl ?? new URL("./process-worker.js", import.meta.url);
    this.runtimeWasm = options.runtimeWasm;
    this.workspace = new EmmixProcessWorkspace(this);

    this.nextId = 1;
    this.pending = new Map();
    this.processes = new Map();
    this.worker = undefined;
    this.startWorker();
  }

  startWorker() {
    this.worker = new Worker(this.workerUrl, { type: "module" });
    this.worker.onmessage = (event) => this.handleMessage(event.data);
    this.worker.onerror = (event) => {
      const error = new Error(event.message || "worker error");
      for (const { reject } of this.pending.values()) {
        reject(error);
      }
      this.pending.clear();
    };
  }

  run(wasmBytes, options = {}) {
    return this.spawn(wasmBytes, options).result;
  }

  exec(wasmBytes, options = {}) {
    return this.run(wasmBytes, options);
  }

  spawn(wasmBytes, options = {}) {
    const id = this.nextId++;
    const bytes = toOwnedUint8Array(wasmBytes);
    const active = [...this.processes.values()].filter((process) =>
      process.status === "running",
    );

    if (active.length > 0) {
      throw new Error("process already running");
    }

    const process = new EmmixProcessHandle(this, id, options);
    this.processes.set(id, process);

    process.result = new Promise((resolve, reject) => {
      this.pending.set(id, {
        kind: "run",
        process,
        resolve,
        reject,
      });

      process.status = "running";

      this.worker.postMessage(
        {
          id,
          type: "run",
          wasmBytes: bytes,
          args: options.args,
          environ: options.environ,
          stdin: options.stdin,
          runtimeWasm: options.runtimeWasm ?? this.runtimeWasm,
        },
        [bytes.buffer],
      );
    });

    return process;
  }

  sendWorkspace(operation, payload = {}, transfer = []) {
    const id = this.nextId++;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { kind: "workspace", resolve, reject });
      this.worker.postMessage(
        {
          id,
          type: "workspace",
          operation,
          runtimeWasm: this.runtimeWasm,
          ...payload,
        },
        transfer,
      );
    });
  }

  terminate() {
    this.worker.terminate();
    for (const [id, pending] of this.pending.entries()) {
      const error = new Error("process worker terminated");
      if (pending.kind === "run") {
        pending.process.finish("failed", error);
      }
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  cancel(id) {
    const cancelled = [...this.pending.entries()]
      .filter(([pendingId, pending]) =>
        pending.kind === "run" && (id === undefined || pendingId === id),
      )
      .map(([pendingId]) => pendingId);

    if (cancelled.length === 0) {
      return false;
    }

    this.worker.terminate();

    for (const pendingId of cancelled) {
      const pending = this.pending.get(pendingId);
      const error = new Error("process cancelled");
      pending?.process.finish("cancelled", error);
      pending?.reject(error);
      this.pending.delete(pendingId);
    }

    for (const [pendingId, pending] of this.pending.entries()) {
      const error = new Error("process worker restarted");
      if (pending.kind === "run") {
        pending.process.finish("failed", error);
      }
      pending.reject(error);
      this.pending.delete(pendingId);
    }
    this.startWorker();
    return true;
  }

  get(id) {
    return this.processes.get(id);
  }

  list() {
    return [...this.processes.values()];
  }

  handleMessage(message) {
    const pending = this.pending.get(message.id);

    if (!pending) {
      return;
    }

    if (message.type === "output") {
      if (message.stream === "stdout") {
        pending.process?.pushStdout(message.chunk);
      } else if (message.stream === "stderr") {
        pending.process?.pushStderr(message.chunk);
      }
      return;
    }

    this.pending.delete(message.id);

    if (message.type === "result") {
      const result = {
        pid: message.id,
        exitCode: message.exitCode,
        stdout: message.stdout,
        stderr: message.stderr,
        missingSyscalls: message.missingSyscalls ?? [],
      };
      pending.process?.finish("exited", result);
      pending.resolve(result);
      return;
    }

    if (message.type === "workspaceResult") {
      pending.resolve(message.value);
      return;
    }

    const error = new Error(message.message || "process worker failed");
    error.stack = message.stack || error.stack;
    pending.process?.finish("failed", error);
    pending.reject(error);
  }
}

export class EmmixProcessHandle {
  constructor(manager, id, options = {}) {
    this.manager = manager;
    this.id = id;
    this.pid = id;
    this.status = "starting";
    this.startedAt = Date.now();
    this.finishedAt = undefined;
    this.stdoutChunks = [];
    this.stderrChunks = [];
    this.onStdout = typeof options.onStdout === "function" ? options.onStdout : undefined;
    this.onStderr = typeof options.onStderr === "function" ? options.onStderr : undefined;
    this.result = undefined;
  }

  pushStdout(chunk) {
    this.stdoutChunks.push(chunk);
    this.onStdout?.(chunk);
  }

  pushStderr(chunk) {
    this.stderrChunks.push(chunk);
    this.onStderr?.(chunk);
  }

  finish(status, outcome) {
    this.status = status;
    this.finishedAt = Date.now();
    this.outcome = outcome;
  }

  cancel() {
    return this.manager.cancel(this.id);
  }
}

export class EmmixProcessWorkspace {
  constructor(process) {
    this.process = process;
  }

  readFile(path) {
    return this.process.sendWorkspace("readFile", { path });
  }

  async readText(path) {
    return new TextDecoder().decode(await this.readFile(path));
  }

  writeFile(path, contents) {
    const bytes = toOwnedUint8Array(contents);
    return this.process.sendWorkspace("writeFile", { path, bytes }, [bytes.buffer]);
  }

  writeText(path, contents) {
    return this.writeFile(path, new TextEncoder().encode(contents));
  }

  readDir(path = "/") {
    return this.process.sendWorkspace("readDir", { path });
  }

  mkdir(path) {
    return this.process.sendWorkspace("mkdir", { path });
  }

  removeFile(path) {
    return this.process.sendWorkspace("removeFile", { path });
  }

  removeDirectory(path) {
    return this.process.sendWorkspace("removeDirectory", { path });
  }

  rename(oldPath, newPath) {
    return this.process.sendWorkspace("rename", { oldPath, newPath });
  }

  stat(path) {
    return this.process.sendWorkspace("stat", { path });
  }
}

function toOwnedUint8Array(value) {
  if (value instanceof Uint8Array) {
    return new Uint8Array(value);
  }

  if (typeof value === "string") {
    return new TextEncoder().encode(value);
  }

  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value.slice(0));
  }

  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }

  throw new TypeError("expected wasm bytes as Uint8Array, ArrayBuffer, or typed array");
}
