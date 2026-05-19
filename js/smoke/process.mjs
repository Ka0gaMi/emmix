import { mkdir, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { EmmixProcess } from "../process-node.js";

const runCommand = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(dirname(here));
const runtimeWasm = await readFile(join(root, "pkg", "emmix_bg.wasm"));
const fixtureSource = join(root, "fixtures", "hello.rs");
const persistWriteSource = join(root, "fixtures", "persist_write.rs");
const persistReadSource = join(root, "fixtures", "persist_read.rs");
const fixtureOutDir = join(root, "target", "emmix-fixtures", "process");
const fixtureWasm = join(fixtureOutDir, "hello.wasm");
const persistWriteWasm = join(fixtureOutDir, "persist_write.wasm");
const persistReadWasm = join(fixtureOutDir, "persist_read.wasm");
const fixtureOptions = {
  args: ["fixture", "one", "two words"],
  environ: ["PATH=/usr/bin:/bin", "HOME=/home", "EMMIX_FIXTURE=present"],
  stdin: "input from smoke\n",
};
const expectedStdout = [
  "args=fixture,one,two words",
  "env=present",
  "stdin=input from smoke",
  "file_prefix=present|input from smoke",
  "file_len=506",
  "file_pos=7",
  "entries=final.txt",
  "",
].join("\n");

await mkdir(fixtureOutDir, { recursive: true });
await runCommand("rustc", [
  "--target",
  "wasm32-wasip1",
  fixtureSource,
  "-O",
  "-o",
  fixtureWasm,
]);
await runCommand("rustc", [
  "--target",
  "wasm32-wasip1",
  persistWriteSource,
  "-O",
  "-o",
  persistWriteWasm,
]);
await runCommand("rustc", [
  "--target",
  "wasm32-wasip1",
  persistReadSource,
  "-O",
  "-o",
  persistReadWasm,
]);

const wasmBytes = await readFile(fixtureWasm);
const persistWriteBytes = await readFile(persistWriteWasm);
const persistReadBytes = await readFile(persistReadWasm);

const process = new EmmixProcess({ runtimeWasm });

try {
  await process.workspace.mkdir("/workspace");
  await process.workspace.writeText("/workspace/note.txt", "worker workspace\n");
  await process.workspace.rename("/workspace/note.txt", "/workspace/final.txt");

  const workspaceEntries = await process.workspace.readDir("/workspace");
  if (JSON.stringify(workspaceEntries) !== JSON.stringify(["final.txt"])) {
    throw new Error(`expected process workspace entry, got ${JSON.stringify(workspaceEntries)}`);
  }

  const workspaceText = await process.workspace.readText("/workspace/final.txt");
  if (workspaceText !== "worker workspace\n") {
    throw new Error(`expected process workspace file, got ${JSON.stringify(workspaceText)}`);
  }

  const workspaceStat = await process.workspace.stat("/workspace/final.txt");
  if (workspaceStat?.type !== "file" || workspaceStat.size !== 17) {
    throw new Error(`expected process workspace stat, got ${JSON.stringify(workspaceStat)}`);
  }

  const stdoutChunks = [];
  const spawned = process.spawn(wasmBytes, {
    ...fixtureOptions,
    onStdout(chunk) {
      stdoutChunks.push(chunk);
    },
  });
  if (spawned.status !== "running") {
    throw new Error(`expected spawned process to be running, got ${spawned.status}`);
  }
  if (process.get(spawned.pid) !== spawned) {
    throw new Error("expected process manager get(pid) to return spawned handle");
  }
  if (!process.list().some((entry) => entry.pid === spawned.pid)) {
    throw new Error("expected process manager list() to include spawned handle");
  }

  const result = await spawned.result;

  const stdout = new TextDecoder().decode(result.stdout);
  const streamedStdout = new TextDecoder().decode(joinChunks(stdoutChunks));
  const handleStdout = new TextDecoder().decode(joinChunks(spawned.stdoutChunks));

  if (result.exitCode !== 0) {
    throw new Error(`expected exit code 0, got ${result.exitCode}`);
  }

  if (result.pid !== spawned.pid) {
    throw new Error(`expected result pid ${spawned.pid}, got ${result.pid}`);
  }

  if (spawned.status !== "exited") {
    throw new Error(`expected spawned process to exit, got ${spawned.status}`);
  }

  if (stdout !== expectedStdout) {
    throw new Error(`unexpected stdout: ${JSON.stringify(stdout)}`);
  }

  if (streamedStdout !== stdout) {
    throw new Error(`expected streamed stdout to match final stdout, got ${JSON.stringify(streamedStdout)}`);
  }

  if (handleStdout !== stdout) {
    throw new Error(`expected handle stdout chunks to match final stdout, got ${JSON.stringify(handleStdout)}`);
  }

  if (result.missingSyscalls.length !== 0) {
    throw new Error(`expected no missing syscalls, got ${JSON.stringify(result.missingSyscalls)}`);
  }

  const persistWrite = await process.exec(persistWriteBytes);
  if (persistWrite.exitCode !== 0) {
    throw new Error(`expected persist writer exit code 0, got ${persistWrite.exitCode}`);
  }

  const persistRead = await process.run(persistReadBytes);
  const persistStdout = new TextDecoder().decode(persistRead.stdout);
  if (persistStdout !== "persist=kept\n") {
    throw new Error(`expected persistent workspace file, got ${JSON.stringify(persistStdout)}`);
  }

  const spinning = process.spawn(createSpinModule());
  setTimeout(() => spinning.cancel(), 25);

  await spinning.result.then(
    () => {
      throw new Error("expected spinning process to be cancelled");
    },
    (error) => {
      if (error.message !== "process cancelled") {
        throw error;
      }
    },
  );
  if (spinning.status !== "cancelled") {
    throw new Error(`expected spinning process to be cancelled, got ${spinning.status}`);
  }

  const restartResult = await process.run(wasmBytes, {
    ...fixtureOptions,
  });
  const restartStdout = new TextDecoder().decode(restartResult.stdout);
  if (restartStdout !== expectedStdout) {
    throw new Error(`expected restarted worker stdout, got ${JSON.stringify(restartStdout)}`);
  }

  console.log("process worker smoke passed");
} finally {
  process.terminate();
}

function joinChunks(chunks) {
  const byteLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const joined = new Uint8Array(byteLength);
  let offset = 0;

  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return joined;
}

function createSpinModule() {
  const module = [
    0x00, 0x61, 0x73, 0x6d,
    0x01, 0x00, 0x00, 0x00,
    ...section(1, [
      ...u32(1),
      0x60,
      ...u32(0),
      ...u32(0),
    ]),
    ...section(3, [
      ...u32(1),
      ...u32(0),
    ]),
    ...section(5, [
      ...u32(1),
      0x00,
      ...u32(1),
    ]),
    ...section(7, [
      ...u32(2),
      ...name("memory"),
      0x02,
      ...u32(0),
      ...name("_start"),
      0x00,
      ...u32(0),
    ]),
    ...section(10, [
      ...u32(1),
      ...body([
        0x03,
        0x40,
        0x0c,
        0x00,
        0x0b,
        0x0b,
      ]),
    ]),
  ];

  return new Uint8Array(module);
}

function section(id, payload) {
  return [id, ...u32(payload.length), ...payload];
}

function body(instructions) {
  const payload = [
    ...u32(0),
    ...instructions,
  ];
  return [...u32(payload.length), ...payload];
}

function name(value) {
  const bytes = [...value].map((char) => char.charCodeAt(0));
  return [...u32(bytes.length), ...bytes];
}

function u32(value) {
  const bytes = [];
  let current = value >>> 0;

  do {
    let byte = current & 0x7f;
    current >>>= 7;

    if (current !== 0) {
      byte |= 0x80;
    }

    bytes.push(byte);
  } while (current !== 0);

  return bytes;
}
