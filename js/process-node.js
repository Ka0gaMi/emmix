import { Worker } from "node:worker_threads";
import { EmmixShell } from "./shell.js";
import { createDefaultCommandRegistry } from "./commands.js";
import { createPackageResolver } from "./packages.js";
import { detectRuntimeCapabilities } from "./capabilities.js";
import { EmmixAuditLog, EmmixEventBus } from "./events.js";

export class EmmixProcess {
  constructor(options = {}) {
    this.workerUrl = options.workerUrl ?? new URL("./process-worker.js", import.meta.url);
    this.runtimeWasm = options.runtimeWasm;
    this.workspace = new EmmixProcessWorkspace(this);
    this.shell = new EmmixShell(this, options.shell);
    this.commands = createDefaultCommandRegistry(this.shell);
    this.packages = createPackageResolver(options.packages);
    this.capabilities = detectRuntimeCapabilities({
      ...options.capabilities,
      environment: "node",
      nodeWorkerThreads: true,
    });
    this.events = new EmmixEventBus(options.events);
    this.audit = new EmmixAuditLog(this.events);
    this.maxProcesses = normalizeMaxProcesses(options.maxProcesses ?? 1);
    this.sharedWorkspace = normalizeSharedWorkspace(options.sharedWorkspace ?? "auto");
    this.sharedWorkspaceConflict = normalizeSharedWorkspaceConflict(
      options.sharedWorkspaceConflict ?? "fail",
    );

    this.nextId = 1;
    this.pending = new Map();
    this.processes = new Map();
    this.queue = [];
    this.workers = [];
    this.workspaceMirror = new WorkspaceSnapshotMirror();
    this.startWorker();
    this.emitEvent("runtime:boot", {
      environment: this.capabilities.environment,
      maxProcesses: this.maxProcesses,
      sharedWorkspace: this.sharedWorkspace,
    });
  }

  startWorker(slot = this.createWorkerSlot()) {
    slot.worker = new Worker(this.workerUrl, { type: "module" });
    slot.worker.on("message", (message) => this.handleMessage(message, slot));
    slot.worker.on("error", (error) => this.failWorkerSlot(slot, error));
    return slot;
  }

  createWorkerSlot() {
    const slot = {
      id: this.workers.length + 1,
      worker: undefined,
      activeRunId: undefined,
    };
    this.workers.push(slot);
    return slot;
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
    const process = new EmmixProcessHandle(this, id, options);
    this.processes.set(id, process);

    process.result = new Promise((resolve, reject) => {
      const run = {
        kind: "run",
        id,
        process,
        bytes,
        options,
        resolve,
        reject,
        timeout: undefined,
      };

      const slot = this.idleWorkerSlot();
      if (slot !== undefined) {
        this.startRun(run, slot);
      } else {
        process.status = "queued";
        this.queue.push(run);
        this.emitEvent("process:queued", { pid: id, queueLength: this.queue.length });
      }
    });

    return process;
  }

  startRun(run, slot) {
    run.slot = slot;
    slot.activeRunId = run.id;
    this.pending.set(run.id, run);
    run.process.status = "running";
    run.process.startedAt = Date.now();
    this.emitEvent("process:spawn", {
      pid: run.id,
      slot: slot.id,
      args: run.options.args,
      timeoutMs: run.options.timeoutMs,
    });

    if (Number.isFinite(run.options.timeoutMs) && run.options.timeoutMs > 0) {
      run.timeout = setTimeout(() => {
        this.cancel(run.id, new Error("process timed out"));
      }, run.options.timeoutMs);
    }

    const workspaceSnapshot = this.snapshotForRunSlot(slot);
    run.workspaceSnapshot = workspaceSnapshot;
    slot.worker.postMessage(
      {
        id: run.id,
        type: "run",
        wasmBytes: run.bytes,
        workspaceSnapshot,
        args: run.options.args,
        environ: run.options.environ,
        stdin: run.options.stdin,
        runtimeWasm: run.options.runtimeWasm ?? this.runtimeWasm,
      },
      [run.bytes.buffer],
    );
  }

  startNextRun() {
    while (this.queue.length > 0) {
      const slot = this.idleWorkerSlot();
      if (slot === undefined) {
        return;
      }

      this.startRun(this.queue.shift(), slot);
    }
  }

  idleWorkerSlot() {
    const existing = this.workers.find((slot) => slot.activeRunId === undefined);

    if (existing !== undefined) {
      return existing;
    }

    if (this.workers.length < this.maxProcesses) {
      return this.startWorker();
    }

    return undefined;
  }

  primaryWorkerSlot() {
    return this.workers[0] ?? this.startWorker();
  }

  snapshotForRunSlot(slot) {
    if (slot === this.primaryWorkerSlot() || this.sharedWorkspace === "isolated") {
      return undefined;
    }

    return this.workspaceMirror.exportSnapshot();
  }

  sendWorkspace(operation, payload = {}, transfer = []) {
    const id = this.nextId++;
    const slot = this.primaryWorkerSlot();

    return new Promise((resolve, reject) => {
      this.pending.set(id, { kind: "workspace", slot, resolve, reject });
      slot.worker.postMessage(
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
    for (const slot of this.workers) {
      slot.worker?.terminate();
      slot.activeRunId = undefined;
    }
    this.emitEvent("runtime:shutdown", { reason: "terminate" });

    for (const [id, pending] of this.pending.entries()) {
      const error = new Error("process worker terminated");
      clearTimeout(pending.timeout);
      if (pending.kind === "run") {
        pending.process.finish("failed", error);
      }
      pending.reject(error);
      this.pending.delete(id);
    }

    for (const queued of this.queue.splice(0)) {
      const error = new Error("process worker terminated");
      queued.process.finish("failed", error);
      queued.reject(error);
    }

    this.workers = [];
  }

  cancel(id, reason) {
    const queuedCancelled = [];

    this.queue = this.queue.filter((queued) => {
      if (id !== undefined && queued.id !== id) {
        return true;
      }

      queuedCancelled.push(queued);
      return false;
    });

    for (const queued of queuedCancelled) {
      const error = reason ?? new Error("process cancelled");
      queued.process.finish("cancelled", error);
      queued.reject(error);
      this.emitEvent("process:cancel", { pid: queued.id, status: "queued", reason: error.message });
    }

    const cancelled = [...this.pending.entries()]
      .filter(([pendingId, pending]) =>
        pending.kind === "run" && (id === undefined || pendingId === id),
      )
      .map(([pendingId]) => pendingId);

    if (cancelled.length === 0) {
      return queuedCancelled.length > 0;
    }

    if (id === undefined) {
      for (const queued of this.queue.splice(0)) {
        const error = reason ?? new Error("process cancelled");
        queued.process.finish("cancelled", error);
        queued.reject(error);
        this.emitEvent("process:cancel", { pid: queued.id, status: "queued", reason: error.message });
      }
    }

    for (const pendingId of cancelled) {
      const pending = this.pending.get(pendingId);
      const error = reason ?? new Error("process cancelled");
      clearTimeout(pending?.timeout);
      pending?.slot?.worker?.terminate();
      if (pending?.slot !== undefined) {
        pending.slot.activeRunId = undefined;
        this.startWorker(pending.slot);
      }
      pending?.process.finish("cancelled", error);
      pending?.reject(error);
      this.pending.delete(pendingId);
      this.emitEvent("process:cancel", { pid: pendingId, status: "running", reason: error.message });
    }

    this.startNextRun();
    return true;
  }

  get(id) {
    return this.processes.get(id);
  }

  list() {
    return [...this.processes.values()];
  }

  wait(id) {
    const process = this.get(id);

    if (process === undefined) {
      return Promise.reject(new Error(`unknown process: ${id}`));
    }

    return process.result;
  }

  async handleMessage(message, slot) {
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
      this.emitEvent(`process:${message.stream}`, {
        pid: message.id,
        byteLength: message.chunk?.byteLength ?? 0,
      });
      return;
    }

    this.pending.delete(message.id);
    if (pending.kind === "run") {
      clearTimeout(pending.timeout);
      pending.slot.activeRunId = undefined;
    }

    if (message.type === "result") {
      try {
        await this.commitRunWorkspaceSnapshot(pending, message.workspaceSnapshot);
        const result = {
          pid: message.id,
          exitCode: message.exitCode,
          stdout: message.stdout,
          stderr: message.stderr,
          missingSyscalls: message.missingSyscalls ?? [],
        };
        pending.process?.finish("exited", result);
        pending.resolve(result);
        this.emitEvent("process:exit", {
          pid: message.id,
          status: "exited",
          exitCode: result.exitCode,
          stdoutBytes: result.stdout.byteLength,
          stderrBytes: result.stderr.byteLength,
          missingSyscalls: result.missingSyscalls,
        });
      } catch (error) {
        pending.process?.finish("failed", error);
        pending.reject(error);
        this.emitEvent("process:exit", {
          pid: message.id,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        this.startNextRun();
      }
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
    this.emitEvent("process:exit", {
      pid: message.id,
      status: "failed",
      error: error.message,
    });
    this.startNextRun();
  }

  async commitRunWorkspaceSnapshot(pending, finalSnapshot) {
    if (finalSnapshot === undefined || pending.kind !== "run") {
      return;
    }

    if (pending.slot === this.primaryWorkerSlot() || pending.workspaceSnapshot === undefined) {
      this.workspaceMirror.importSnapshot(finalSnapshot);
      return;
    }

    if (this.sharedWorkspace === "isolated") {
      return;
    }

    await this.commitWorkspaceDiff(pending.workspaceSnapshot, finalSnapshot);
  }

  async commitWorkspaceDiff(baseSnapshot, finalSnapshot, options = {}) {
    const changes = workspaceSnapshotDiff(baseSnapshot, finalSnapshot);
    const conflictPolicy = normalizeSharedWorkspaceConflict(
      options.conflict ?? this.sharedWorkspaceConflict,
    );

    if (changes.length === 0) {
      return { changes, conflicts: [] };
    }

    const conflicts = this.workspaceMirror.conflicts(baseSnapshot, changes);

    if (conflictPolicy === "fail" && conflicts.length > 0) {
      this.emitEvent("workspace:conflict", { conflicts: summarizeConflicts(conflicts) });
      throw new EmmixWorkspaceConflictError(conflicts);
    }

    await this.applyWorkspaceChanges(changes);
    if (conflicts.length > 0) {
      this.emitEvent("workspace:conflict", {
        policy: conflictPolicy,
        conflicts: summarizeConflicts(conflicts),
      });
    }
    return { changes, conflicts };
  }

  async applyWorkspaceChanges(changes) {
    const deletions = changes
      .filter((change) => change.final === undefined)
      .sort((a, b) => pathDepth(b.path) - pathDepth(a.path));
    const directories = changes
      .filter((change) => change.final?.type === "directory")
      .sort((a, b) => pathDepth(a.path) - pathDepth(b.path));
    const files = changes
      .filter((change) => change.final?.type === "file")
      .sort((a, b) => pathDepth(a.path) - pathDepth(b.path));

    for (const change of [...deletions, ...directories, ...files]) {
      await this.applyWorkspaceChange(change);
    }
  }

  async applyWorkspaceChange(change) {
    if (change.path === "/") {
      return;
    }

    const current = this.workspaceMirror.entry(change.path);

    if (change.final === undefined) {
      if (current?.type === "file") {
        await this.sendWorkspace("removeFile", { path: change.path });
      } else if (current?.type === "directory") {
        await this.sendWorkspace("removeDirectory", { path: change.path });
      }
      this.workspaceMirror.remove(change.path);
      this.emitEvent("workspace:delete", { path: change.path, previousType: current?.type });
      return;
    }

    if (current !== undefined && current.type !== change.final.type) {
      if (current.type === "file") {
        await this.sendWorkspace("removeFile", { path: change.path });
      } else {
        await this.removeDirectoryTree(change.path);
      }
      this.workspaceMirror.remove(change.path);
    }

    if (change.final.type === "directory") {
      if (this.workspaceMirror.entry(change.path)?.type !== "directory") {
        await this.sendWorkspace("mkdir", { path: change.path });
        this.workspaceMirror.mkdir(change.path);
        this.emitEvent("workspace:write", { path: change.path, type: "directory" });
      }
      return;
    }

    const bytes = new Uint8Array(change.final.bytes ?? new Uint8Array());
    const mirrorBytes = new Uint8Array(bytes);
    await this.sendWorkspace("writeFile", { path: change.path, bytes }, [bytes.buffer]);
    this.workspaceMirror.writeFile(change.path, mirrorBytes);
    this.emitEvent("workspace:write", {
      path: change.path,
      type: "file",
      byteLength: mirrorBytes.byteLength,
    });
  }

  async removeDirectoryTree(path) {
    const snapshot = this.workspaceMirror.exportSnapshot()
      .filter((entry) => entry.path === path || entry.path.startsWith(`${path}/`))
      .sort((a, b) => pathDepth(b.path) - pathDepth(a.path));

    for (const entry of snapshot) {
      if (entry.path === "/") {
        continue;
      }

      await this.sendWorkspace(
        entry.type === "file" ? "removeFile" : "removeDirectory",
        { path: entry.path },
      );
    }
  }

  failWorkerSlot(slot, error) {
    for (const [id, pending] of [...this.pending.entries()]) {
      if (pending.slot !== slot) {
        continue;
      }

      clearTimeout(pending.timeout);
      if (pending.kind === "run") {
        pending.process.finish("failed", error);
        this.emitEvent("process:exit", {
          pid: id,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      pending.reject(error);
      this.pending.delete(id);
    }

    slot.activeRunId = undefined;
    this.startWorker(slot);
    this.emitEvent("worker:restart", {
      slot: slot.id,
      error: error instanceof Error ? error.message : String(error),
    });
    this.startNextRun();
  }

  emitEvent(type, detail = {}, options = {}) {
    return this.events.emit(type, detail, {
      source: "process",
      ...options,
    });
  }
}

export class EmmixProcessHandle {
  constructor(manager, id, options = {}) {
    this.manager = manager;
    this.id = id;
    this.pid = id;
    this.status = "starting";
    this.queuedAt = Date.now();
    this.startedAt = undefined;
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

export class EmmixWorkspaceConflictError extends Error {
  constructor(conflicts) {
    super(`shared workspace conflict: ${conflicts.map((conflict) => conflict.path).join(", ")}`);
    this.name = "EmmixWorkspaceConflictError";
    this.conflicts = conflicts;
  }
}

export class EmmixProcessWorkspace {
  constructor(process) {
    this.process = process;
  }

  async readFile(path) {
    const bytes = await this.process.sendWorkspace("readFile", { path });
    this.process.emitEvent("workspace:read", {
      path,
      type: "file",
      byteLength: bytes.byteLength,
    });
    return bytes;
  }

  async readText(path) {
    return new TextDecoder().decode(await this.readFile(path));
  }

  async writeFile(path, contents) {
    const bytes = toOwnedUint8Array(contents);
    const byteLength = bytes.byteLength;
    this.process.workspaceMirror.writeFile(path, bytes);
    await this.process.sendWorkspace("writeFile", { path, bytes }, [bytes.buffer]);
    this.process.emitEvent("workspace:write", { path, type: "file", byteLength });
  }

  writeText(path, contents) {
    return this.writeFile(path, new TextEncoder().encode(contents));
  }

  async readDir(path = "/") {
    const entries = await this.process.sendWorkspace("readDir", { path });
    this.process.emitEvent("workspace:read", {
      path,
      type: "directory",
      entries: entries.length,
    });
    return entries;
  }

  async mkdir(path) {
    this.process.workspaceMirror.mkdir(path);
    await this.process.sendWorkspace("mkdir", { path });
    this.process.emitEvent("workspace:write", { path, type: "directory" });
  }

  async removeFile(path) {
    this.process.workspaceMirror.remove(path);
    await this.process.sendWorkspace("removeFile", { path });
    this.process.emitEvent("workspace:delete", { path, type: "file" });
  }

  async removeDirectory(path) {
    this.process.workspaceMirror.remove(path);
    await this.process.sendWorkspace("removeDirectory", { path });
    this.process.emitEvent("workspace:delete", { path, type: "directory" });
  }

  async rename(oldPath, newPath) {
    this.process.workspaceMirror.rename(oldPath, newPath);
    await this.process.sendWorkspace("rename", { oldPath, newPath });
    this.process.emitEvent("workspace:rename", { oldPath, newPath });
  }

  async stat(path) {
    const stat = await this.process.sendWorkspace("stat", { path });
    this.process.emitEvent("workspace:read", {
      path,
      type: "stat",
      entryType: stat?.type,
      byteLength: stat?.size,
    });
    return stat;
  }

  beginTransaction() {
    return new EmmixWorkspaceTransaction(this.process);
  }
}

export class EmmixWorkspaceTransaction {
  constructor(process) {
    this.process = process;
    this.baseSnapshot = process.workspaceMirror.exportSnapshot();
    this.entries = snapshotMap(this.baseSnapshot);
    this.closed = false;
  }

  async readFile(path) {
    this.assertOpen();
    const entry = this.entry(path);

    if (entry?.type !== "file") {
      throw new Error(`not a file: ${path}`);
    }

    return new Uint8Array(entry.bytes);
  }

  async readText(path) {
    return new TextDecoder().decode(await this.readFile(path));
  }

  async writeFile(path, contents) {
    this.assertOpen();
    this.ensureParentDirectories(path);
    this.entries.set(normalizePath(path), {
      path: normalizePath(path),
      type: "file",
      bytes: toOwnedUint8Array(contents),
    });
  }

  async writeText(path, contents) {
    await this.writeFile(path, new TextEncoder().encode(contents));
  }

  async readDir(path = "/") {
    this.assertOpen();
    const normalized = normalizePath(path);
    const entry = this.entry(normalized);

    if (entry?.type !== "directory") {
      throw new Error(`not a directory: ${path}`);
    }

    const names = new Set();
    const prefix = normalized === "/" ? "/" : `${normalized}/`;

    for (const childPath of this.entries.keys()) {
      if (childPath === normalized || !childPath.startsWith(prefix)) {
        continue;
      }

      const relative = childPath.slice(prefix.length);
      const [name] = relative.split("/");
      if (name) {
        names.add(name);
      }
    }

    return [...names].sort();
  }

  async mkdir(path) {
    this.assertOpen();
    const normalized = normalizePath(path);
    this.ensureParentDirectories(normalized);
    this.entries.set(normalized, { path: normalized, type: "directory" });
  }

  async removeFile(path) {
    this.assertOpen();
    const normalized = normalizePath(path);
    const entry = this.entry(normalized);

    if (entry?.type !== "file") {
      throw new Error(`not a file: ${path}`);
    }

    this.entries.delete(normalized);
  }

  async removeDirectory(path) {
    this.assertOpen();
    const normalized = normalizePath(path);
    const entry = this.entry(normalized);

    if (entry?.type !== "directory") {
      throw new Error(`not a directory: ${path}`);
    }

    for (const key of [...this.entries.keys()]) {
      if (key === normalized || key.startsWith(`${normalized}/`)) {
        this.entries.delete(key);
      }
    }
  }

  async rename(oldPath, newPath) {
    this.assertOpen();
    const oldNormalized = normalizePath(oldPath);
    const newNormalized = normalizePath(newPath);
    const moved = [];

    for (const [path, entry] of this.entries) {
      if (path === oldNormalized || path.startsWith(`${oldNormalized}/`)) {
        moved.push([
          newNormalized + path.slice(oldNormalized.length),
          cloneSnapshotEntry(entry),
        ]);
        this.entries.delete(path);
      }
    }

    if (moved.length === 0) {
      throw new Error(`path not found: ${oldPath}`);
    }

    this.ensureParentDirectories(newNormalized);
    for (const [path, entry] of moved) {
      this.entries.set(path, { ...entry, path });
    }
  }

  async stat(path) {
    this.assertOpen();
    const entry = this.entry(path);

    if (entry === undefined) {
      return undefined;
    }

    return {
      type: entry.type,
      size: entry.type === "file" ? entry.bytes.byteLength : 0,
    };
  }

  snapshot() {
    this.assertOpen();
    return [...this.entries.values()]
      .map(cloneSnapshotEntry)
      .sort((a, b) => pathDepth(a.path) - pathDepth(b.path) || a.path.localeCompare(b.path));
  }

  async commit(options = {}) {
    this.assertOpen();
    const result = await this.process.commitWorkspaceDiff(this.baseSnapshot, this.snapshot(), options);
    this.closed = true;
    this.process.emitEvent("workspace:transaction:commit", {
      changes: result.changes.map((change) => ({
        path: change.path,
        type: change.final?.type,
        deleted: change.final === undefined,
      })),
      conflicts: summarizeConflicts(result.conflicts),
    });
    return result;
  }

  rollback() {
    this.assertOpen();
    this.closed = true;
    this.process.emitEvent("workspace:transaction:rollback", {});
  }

  entry(path) {
    const entry = this.entries.get(normalizePath(path));
    return entry === undefined ? undefined : cloneSnapshotEntry(entry);
  }

  ensureParentDirectories(path) {
    const parts = normalizePath(path).split("/").filter(Boolean);
    let current = "";

    for (const part of parts.slice(0, -1)) {
      current += `/${part}`;
      const entry = this.entries.get(current);
      if (entry !== undefined && entry.type !== "directory") {
        throw new Error(`not a directory: ${current}`);
      }
      this.entries.set(current, { path: current, type: "directory" });
    }
  }

  assertOpen() {
    if (this.closed) {
      throw new Error("workspace transaction is closed");
    }
  }
}

class WorkspaceSnapshotMirror {
  constructor() {
    this.entries = new Map([
      ["/", { type: "directory" }],
    ]);
  }

  mkdir(path) {
    this.entries.set(normalizePath(path), { type: "directory" });
  }

  writeFile(path, bytes) {
    this.ensureParentDirectories(path);
    this.entries.set(normalizePath(path), {
      type: "file",
      bytes: new Uint8Array(bytes),
    });
  }

  remove(path) {
    const normalized = normalizePath(path);
    for (const key of [...this.entries.keys()]) {
      if (key === normalized || key.startsWith(`${normalized}/`)) {
        this.entries.delete(key);
      }
    }
  }

  rename(oldPath, newPath) {
    const oldNormalized = normalizePath(oldPath);
    const newNormalized = normalizePath(newPath);
    const moved = [];

    for (const [path, entry] of this.entries) {
      if (path === oldNormalized || path.startsWith(`${oldNormalized}/`)) {
        moved.push([
          newNormalized + path.slice(oldNormalized.length),
          cloneMirrorEntry(entry),
        ]);
        this.entries.delete(path);
      }
    }

    for (const [path, entry] of moved) {
      this.entries.set(path, entry);
    }
  }

  exportSnapshot() {
    return [...this.entries.entries()]
      .sort(([a], [b]) => pathDepth(a) - pathDepth(b) || a.localeCompare(b))
      .map(([path, entry]) => ({
        path,
        type: entry.type,
        bytes: entry.type === "file" ? new Uint8Array(entry.bytes) : undefined,
      }));
  }

  importSnapshot(snapshot) {
    this.entries = new Map();

    for (const entry of snapshot ?? []) {
      const normalized = normalizePath(entry.path);
      this.entries.set(normalized, cloneSnapshotEntry(entry));
    }

    if (!this.entries.has("/")) {
      this.entries.set("/", { type: "directory" });
    }
  }

  entry(path) {
    const entry = this.entries.get(normalizePath(path));
    return entry === undefined ? undefined : cloneMirrorEntry(entry);
  }

  conflicts(baseSnapshot, changes) {
    const base = snapshotMap(baseSnapshot);
    const conflicts = [];

    for (const change of changes) {
      const current = this.entry(change.path);
      if (!sameSnapshotEntry(current, base.get(change.path))) {
        conflicts.push({
          path: change.path,
          base: cloneOptionalSnapshotEntry(base.get(change.path)),
          current: cloneOptionalSnapshotEntry(current),
          incoming: cloneOptionalSnapshotEntry(change.final),
        });
      }
    }

    return conflicts;
  }

  ensureParentDirectories(path) {
    const parts = normalizePath(path).split("/").filter(Boolean);
    let current = "";

    for (const part of parts.slice(0, -1)) {
      current += `/${part}`;
      this.mkdir(current);
    }
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

function normalizeMaxProcesses(value) {
  const number = Number(value);

  if (!Number.isInteger(number) || number < 1) {
    throw new RangeError("maxProcesses must be a positive integer");
  }

  return number;
}

function normalizeSharedWorkspace(value) {
  if (value === "auto") {
    return "message-broker";
  }

  if (value === "message-broker" || value === "snapshot" || value === "isolated") {
    return value;
  }

  throw new Error(`unsupported sharedWorkspace strategy: ${value}`);
}

function normalizeSharedWorkspaceConflict(value) {
  if (value === "fail" || value === "last-write-wins") {
    return value;
  }

  throw new Error(`unsupported sharedWorkspaceConflict policy: ${value}`);
}

function normalizePath(path) {
  const parts = String(path || "/").split("/");
  const resolved = [];

  for (const part of parts) {
    if (part === "" || part === ".") {
      continue;
    }

    if (part === "..") {
      resolved.pop();
      continue;
    }

    resolved.push(part);
  }

  return `/${resolved.join("/")}`;
}

function pathDepth(path) {
  return path.split("/").filter(Boolean).length;
}

function cloneMirrorEntry(entry) {
  return entry.type === "file"
    ? { type: "file", bytes: new Uint8Array(entry.bytes) }
    : { type: "directory" };
}

function cloneSnapshotEntry(entry) {
  const normalized = {
    path: normalizePath(entry.path),
    type: entry.type,
  };

  if (entry.type === "file") {
    normalized.bytes = new Uint8Array(entry.bytes ?? new Uint8Array());
  }

  return normalized;
}

function cloneOptionalSnapshotEntry(entry) {
  return entry === undefined ? undefined : cloneSnapshotEntry(entry);
}

function snapshotMap(snapshot) {
  const map = new Map();

  for (const entry of snapshot ?? []) {
    map.set(normalizePath(entry.path), cloneSnapshotEntry(entry));
  }

  return map;
}

function workspaceSnapshotDiff(baseSnapshot, finalSnapshot) {
  const base = snapshotMap(baseSnapshot);
  const final = snapshotMap(finalSnapshot);
  const paths = new Set([...base.keys(), ...final.keys()]);
  const changes = [];

  for (const path of paths) {
    if (path === "/") {
      continue;
    }

    const baseEntry = base.get(path);
    const finalEntry = final.get(path);

    if (!sameSnapshotEntry(baseEntry, finalEntry)) {
      changes.push({
        path,
        base: baseEntry,
        final: finalEntry,
      });
    }
  }

  return changes;
}

function summarizeConflicts(conflicts) {
  return conflicts.map((conflict) => ({
    path: conflict.path,
    baseType: conflict.base?.type,
    currentType: conflict.current?.type,
    incomingType: conflict.incoming?.type,
    baseBytes: conflict.base?.bytes?.byteLength,
    currentBytes: conflict.current?.bytes?.byteLength,
    incomingBytes: conflict.incoming?.bytes?.byteLength,
  }));
}

function sameSnapshotEntry(left, right) {
  if (left === undefined || right === undefined) {
    return left === right;
  }

  if (left.type !== right.type) {
    return false;
  }

  if (left.type === "directory") {
    return true;
  }

  const leftBytes = left.bytes ?? new Uint8Array();
  const rightBytes = right.bytes ?? new Uint8Array();

  if (leftBytes.byteLength !== rightBytes.byteLength) {
    return false;
  }

  for (let index = 0; index < leftBytes.byteLength; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) {
      return false;
    }
  }

  return true;
}
