import init, { EmmixRuntime } from "../pkg/emmix.js";

const DEFAULT_ARGS = ["sh"];
const DEFAULT_ENVIRON = ["PATH=/usr/bin:/bin", "HOME=/home"];

export class EmmixProcessExit extends Error {
  constructor(code) {
    super(`process exited with code ${code}`);
    this.name = "EmmixProcessExit";
    this.code = code;
  }
}

export class EmmixRunner {
  constructor(options = {}) {
    this.runtime = new EmmixRuntime(0);
    this.workspace = new EmmixWorkspace(() => this.runtime);
    this.instance = undefined;
    this.module = undefined;
    this.memory = undefined;
    this.stdoutChunks = [];
    this.stderrChunks = [];
    this.onStdout = undefined;
    this.onStderr = undefined;
    this.configure(options);
  }

  configure(options = {}) {
    const {
      args = DEFAULT_ARGS,
      environ = DEFAULT_ENVIRON,
      stdin,
    } = options;

    this.runtime.set_args(args);
    this.runtime.set_environ(environ);
    this.runtime.set_stdin(stdin === undefined ? new Uint8Array() : toUint8Array(stdin));
    this.onStdout = typeof options.onStdout === "function" ? options.onStdout : undefined;
    this.onStderr = typeof options.onStderr === "function" ? options.onStderr : undefined;
  }

  imports(extraImports = {}) {
    return mergeImports(extraImports, {
      wasi_snapshot_preview1: this.wasiImports(),
    });
  }

  async instantiate(moduleInput, extraImports = {}) {
    const source =
      moduleInput instanceof WebAssembly.Module
        ? moduleInput
        : await WebAssembly.compile(await toArrayBuffer(moduleInput));

    const instance = await WebAssembly.instantiate(source, this.imports(extraImports));
    const memory = instance.exports.memory;

    if (!(memory instanceof WebAssembly.Memory)) {
      throw new TypeError("WASI module must export WebAssembly.Memory as `memory`");
    }

    this.module = source;
    this.instance = instance;
    this.memory = memory;
    this.runtime.attach_guest_memory(memory);

    return instance;
  }

  async run(moduleInput, extraImports = {}, options) {
    if (options !== undefined) {
      this.configure(options);
    }

    this.stdoutChunks = [];
    this.stderrChunks = [];
    this.runtime.take_missing_syscalls();

    const instance = await this.instantiate(moduleInput, extraImports);
    const start = instance.exports._start;

    if (typeof start !== "function") {
      throw new TypeError("WASI module must export `_start`");
    }

    try {
      start();
      return this.result(0);
    } catch (error) {
      if (error instanceof EmmixProcessExit) {
        return this.result(error.code);
      }

      throw error;
    }
  }

  result(exitCode) {
    this.flushOutput();

    return {
      exitCode,
      stdout: concatUint8Arrays(this.stdoutChunks),
      stderr: concatUint8Arrays(this.stderrChunks),
      missingSyscalls: this.runtime.take_missing_syscalls(),
      instance: this.instance,
      runtime: this.runtime,
    };
  }

  flushOutput() {
    const stdout = this.runtime.take_stdout();
    if (stdout.byteLength > 0) {
      this.stdoutChunks.push(stdout);
      this.onStdout?.(stdout);
    }

    const stderr = this.runtime.take_stderr();
    if (stderr.byteLength > 0) {
      this.stderrChunks.push(stderr);
      this.onStderr?.(stderr);
    }
  }

  wasiImports() {
    return {
      args_get: (argvPtr, argvBufPtr) =>
        this.call((runtime) => runtime.args_get(argvPtr, argvBufPtr)),
      args_sizes_get: (argcPtr, argvBufSizePtr) =>
        this.call((runtime) => runtime.args_sizes_get(argcPtr, argvBufSizePtr)),
      clock_time_get: (clockId, precision, timePtr) =>
        this.call((runtime) => runtime.clock_time_get(clockId, precision, timePtr)),
      environ_get: (environPtr, environBufPtr) =>
        this.call((runtime) => runtime.environ_get(environPtr, environBufPtr)),
      environ_sizes_get: (countPtr, bufSizePtr) =>
        this.call((runtime) => runtime.environ_sizes_get(countPtr, bufSizePtr)),
      fd_close: (fd) => this.call((runtime) => runtime.fd_close(fd)),
      fd_datasync: (fd) => this.call((runtime) => runtime.fd_datasync(fd)),
      fd_fdstat_get: (fd, statPtr) =>
        this.call((runtime) => runtime.fd_fdstat_get(fd, statPtr)),
      fd_filestat_get: (fd, statPtr) =>
        this.call((runtime) => runtime.fd_filestat_get(fd, statPtr)),
      fd_prestat_dir_name: (fd, pathPtr, pathLen) =>
        this.call((runtime) => runtime.fd_prestat_dir_name(fd, pathPtr, pathLen)),
      fd_prestat_get: (fd, prestatPtr) =>
        this.call((runtime) => runtime.fd_prestat_get(fd, prestatPtr)),
      fd_read: (fd, iovsPtr, iovsLen, nreadPtr) =>
        this.call((runtime) => runtime.fd_read(fd, iovsPtr, iovsLen, nreadPtr)),
      fd_readdir: (fd, bufPtr, bufLen, cookie, bufusedPtr) =>
        this.call((runtime) =>
          runtime.fd_readdir(fd, bufPtr, bufLen, cookie, bufusedPtr),
        ),
      fd_renumber: (fd, to) =>
        this.call((runtime) => runtime.fd_renumber(fd, to)),
      fd_seek: (fd, offset, whence, newoffsetPtr) =>
        this.call((runtime) => runtime.fd_seek(fd, offset, whence, newoffsetPtr)),
      fd_sync: (fd) => this.call((runtime) => runtime.fd_sync(fd)),
      fd_tell: (fd, offsetPtr) =>
        this.call((runtime) => runtime.fd_tell(fd, offsetPtr)),
      fd_write: (fd, iovsPtr, iovsLen, nwrittenPtr) => {
        const errno = this.call((runtime) =>
          runtime.fd_write(fd, iovsPtr, iovsLen, nwrittenPtr),
        );
        this.flushOutput();
        return errno;
      },
      path_create_directory: (dirfd, pathPtr, pathLen) =>
        this.call((runtime) =>
          runtime.path_create_directory(dirfd, pathPtr, pathLen),
        ),
      path_filestat_get: (dirfd, flags, pathPtr, pathLen, statPtr) =>
        this.call((runtime) =>
          runtime.path_filestat_get(dirfd, flags, pathPtr, pathLen, statPtr),
        ),
      path_open: (
        dirfd,
        dirflags,
        pathPtr,
        pathLen,
        oflags,
        rightsBase,
        rightsInheriting,
        fdflags,
        openedFdPtr,
      ) =>
        this.call((runtime) =>
          runtime.path_open(
            dirfd,
            dirflags,
            pathPtr,
            pathLen,
            oflags,
            rightsBase,
            rightsInheriting,
            fdflags,
            openedFdPtr,
          ),
        ),
      path_remove_directory: (dirfd, pathPtr, pathLen) =>
        this.call((runtime) =>
          runtime.path_remove_directory(dirfd, pathPtr, pathLen),
        ),
      path_readlink: (dirfd, pathPtr, pathLen, bufPtr, bufLen, bufusedPtr) =>
        this.call((runtime) =>
          runtime.path_readlink(
            dirfd,
            pathPtr,
            pathLen,
            bufPtr,
            bufLen,
            bufusedPtr,
          ),
        ),
      path_rename: (
        oldFd,
        oldPathPtr,
        oldPathLen,
        newFd,
        newPathPtr,
        newPathLen,
      ) =>
        this.call((runtime) =>
          runtime.path_rename(
            oldFd,
            oldPathPtr,
            oldPathLen,
            newFd,
            newPathPtr,
            newPathLen,
          ),
        ),
      path_unlink_file: (dirfd, pathPtr, pathLen) =>
        this.call((runtime) => runtime.path_unlink_file(dirfd, pathPtr, pathLen)),
      proc_exit: (code) => {
        this.runtime.proc_exit(code);
        this.flushOutput();
        throw new EmmixProcessExit(code);
      },
      random_get: (bufPtr, bufLen) =>
        this.call((runtime) => runtime.random_get(bufPtr, bufLen)),
      sched_yield: () => 0,
      poll_oneoff: () => this.runtime.stub("poll_oneoff"),
    };
  }

  call(callback) {
    return callback(this.runtime);
  }
}

export class EmmixWorkspace {
  constructor(runtime) {
    this.runtime = runtime;
  }

  readFile(path) {
    return this.runtime().workspace_read_file(path);
  }

  readText(path) {
    return new TextDecoder().decode(this.readFile(path));
  }

  writeFile(path, contents) {
    this.runtime().workspace_write_file(path, toUint8Array(contents));
  }

  writeText(path, contents) {
    this.writeFile(path, contents);
  }

  readDir(path = "/") {
    return this.runtime().workspace_read_dir(path);
  }

  mkdir(path) {
    this.runtime().workspace_create_directory(path);
  }

  removeFile(path) {
    this.runtime().workspace_remove_file(path);
  }

  removeDirectory(path) {
    this.runtime().workspace_remove_directory(path);
  }

  rename(oldPath, newPath) {
    this.runtime().workspace_rename(oldPath, newPath);
  }

  stat(path) {
    const type = this.runtime().workspace_entry_type(path);

    if (type === undefined || type === null) {
      return undefined;
    }

    return {
      type,
      size: Number(this.runtime().workspace_entry_size(path)),
    };
  }
}

export async function createEmmixRunner(options = {}) {
  if (options.runtimeWasm === undefined) {
    await init();
  } else {
    await init({ module_or_path: options.runtimeWasm });
  }

  return new EmmixRunner(options);
}

export async function runWasiModule(moduleInput, options = {}) {
  const runner = await createEmmixRunner(options);
  return runner.run(moduleInput, options.imports);
}

function concatUint8Arrays(chunks) {
  const byteLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const joined = new Uint8Array(byteLength);
  let offset = 0;

  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return joined;
}

function mergeImports(base, overlay) {
  const merged = { ...base };

  for (const [namespace, imports] of Object.entries(overlay)) {
    merged[namespace] = {
      ...(merged[namespace] ?? {}),
      ...imports,
    };
  }

  return merged;
}

async function toArrayBuffer(input) {
  if (input instanceof ArrayBuffer) {
    return input;
  }

  if (ArrayBuffer.isView(input)) {
    return input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
  }

  if (typeof Response === "function" && input instanceof Response) {
    return input.arrayBuffer();
  }

  if (
    typeof input === "string" ||
    (typeof URL === "function" && input instanceof URL) ||
    (typeof Request === "function" && input instanceof Request)
  ) {
    return (await fetch(input)).arrayBuffer();
  }

  throw new TypeError("expected WebAssembly.Module, bytes, Response, URL, Request, or path string");
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) {
    return value;
  }

  if (typeof value === "string") {
    return new TextEncoder().encode(value);
  }

  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }

  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  throw new TypeError("expected stdin as string, ArrayBuffer, or typed array");
}
