# Emmix

Emmix is an experimental, browser-first WASI runtime written in Rust. The goal
is to become an open-source, fully free alternative to WebContainers and
Nodepod: a lightweight runtime for running WASM32-WASI developer tools inside
the browser with a clean TypeScript framework API.

Emmix is **not** a Linux kernel or hardware emulator. It is a Linux-like
userspace environment built on WASI: processes, pipes, an in-memory filesystem,
middleware, lifecycle hooks, package resolution, and snapshots.

## Current Status

The repository currently contains the Rust runtime core:

- `src/memory.rs`: a flat WASM linear-memory helper.
- `src/syscalls.rs`: the in-progress WASI preview1 syscall layer.
- `src/vfs.rs`: a minimal in-memory virtual filesystem.
- `src/lib.rs`: crate module wiring and the public Rust export surface.
- `fixtures/hello.rs`: a Rust `wasm32-wasip1` compatibility fixture.
- `js/runner.js`: an experimental browser-side WASI module runner.
- `js/process.js`: browser `Worker` process wrapper for running modules off
  the UI thread.
- `js/process-worker.js`: shared worker entry used by the browser and Node
  smoke test.
- `js/smoke/runner.mjs`: a Node smoke test that builds a tiny WASI-style
  module and runs it through the runner.
- `js/smoke/rust-fixture.mjs`: compiles `fixtures/hello.rs` to `wasm32-wasip1`
  and runs it through Emmix.
- `js/smoke/process.mjs`: tests the worker process wrapper, streaming output,
  cancellation, worker restart, and the Rust fixture.

Implemented syscall pieces include:

- `fd_write`
- `fd_read`
- `fd_readdir`
- `fd_seek`
- `fd_fdstat_get`
- `fd_prestat_get`
- `fd_prestat_dir_name`
- `fd_close`
- `args_sizes_get`
- `args_get`
- `environ_sizes_get`
- `environ_get`
- `clock_time_get`
- `random_get`
- `path_open`
- `path_create_directory`
- `path_filestat_get`
- `path_unlink_file`
- `path_remove_directory`
- `proc_exit`
- fallback `stub()` for unimplemented syscalls

Current VFS/runtime support includes:

- in-memory directories and files
- directory listing
- file read/write
- descriptor offsets
- real `fd_seek` for file descriptors
- a `wasm-bindgen` `EmmixRuntime` wrapper
- direct guest `WebAssembly.Memory` access for the JavaScript runner
- worker-backed process execution for the browser test terminal
- process cancellation by terminating/restarting the worker
- stdout/stderr streaming callbacks from worker-backed runs

The experimental runner in `js/runner.js` can instantiate a `wasm32-wasi`
module, provide a `wasi_snapshot_preview1` import object, call `_start`, and
return captured stdout/stderr:

```js
import { runWasiModule } from "./js/runner.js";

const result = await runWasiModule("/hello.wasm", {
  args: ["hello"],
  environ: ["PATH=/usr/bin:/bin", "HOME=/home"],
});

console.log(new TextDecoder().decode(result.stdout));
```

The runner attaches the guest module's exported `WebAssembly.Memory` to
`EmmixRuntime`, so WASI pointers are read from and written to the real guest
memory rather than a copied buffer.

The browser terminal at `web/index.html` runs uploaded modules through
`EmmixProcess`, which uses a module `Worker` so `_start` execution does not run
on the UI thread. The terminal streams stdout/stderr while a module runs and
supports cancelling the active run with `Ctrl+C` or the `kill` command.

Run the current JS smoke test after building `pkg/`:

```powershell
wasm-pack build --target web
npm.cmd run smoke
npm.cmd run fixture:rust
npm.cmd run process:smoke
npm.cmd run serve
```

Next targets:

- Add more metadata/mutation syscalls as larger real WASI programs request them.
- Expand the Rust fixture into rename/remove and larger directory/file cases.
- Build the TypeScript framework API.

## Build

Check the Rust crate:

```powershell
cargo check
```

Run tests:

```powershell
cargo test
```

Build the browser-targeted WASM package:

```powershell
wasm-pack build --target web
```

The generated package is written to `pkg/`.

## Architecture

Emmix is WASI-first rather than a hardware emulator. Programs are compiled to
`wasm32-wasi`, and Emmix implements the syscall layer those programs call.

```text
TypeScript framework API
        |
Rust WASI runtime compiled to WASM
        |
WASM32-WASI programs
        |
Browser APIs
```

The Rust layer is responsible for low-level runtime behavior: memory access,
syscall handling, descriptors, process-facing state, and the virtual
filesystem. The TypeScript layer will provide the developer-facing API.

Booting a real Linux kernel would require CPU, MMU, interrupt, timer, and device
emulation. That is intentionally outside Emmix's product scope. Emmix aims for
the WebContainers/Nodepod product space: fast, embeddable, browser-native
developer runtimes.

## Design Notes

- WASI preview1 is the current target.
- File descriptors `0`, `1`, and `2` are stdin, stdout, and stderr.
- Preopened directories start at fd `3`; the default preopen is `/`.
- Unknown syscalls should return `ENOSYS` through `stub()` instead of crashing.
- Stdin is buffered with `VecDeque<u8>`.
- Stdout and stderr are captured in byte buffers for the host layer to drain.

## Roadmap

1. Expand the Rust fixture into rename/remove and larger directory/file cases.
2. Add missing common WASI syscalls as those fixture cases or real binaries
   request them.
3. Build the TypeScript framework API.
4. Run a WASI shell/tooling proof of concept.
5. Add snapshots, package resolution, and terminal integration.
