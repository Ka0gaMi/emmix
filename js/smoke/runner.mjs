import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { createEmmixRunner, runWasiModule } from "../runner.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(dirname(here));

const runtimeWasm = await readFile(join(root, "pkg", "emmix_bg.wasm"));
const result = await runWasiModule(createHelloWasiModule(), {
  args: ["hello"],
  runtimeWasm,
});

const stdout = new TextDecoder().decode(result.stdout);

if (result.exitCode !== 0) {
  throw new Error(`expected exit code 0, got ${result.exitCode}`);
}

if (stdout !== "hello\n") {
  throw new Error(`expected stdout "hello\\n", got ${JSON.stringify(stdout)}`);
}

if (result.missingSyscalls.length !== 0) {
  throw new Error(`expected no missing syscalls, got ${JSON.stringify(result.missingSyscalls)}`);
}

const missingResult = await runWasiModule(createMissingSyscallModule(), {
  runtimeWasm,
});

if (missingResult.exitCode !== 0) {
  throw new Error(`expected missing syscall module exit code 0, got ${missingResult.exitCode}`);
}

if (JSON.stringify(missingResult.missingSyscalls) !== JSON.stringify(["poll_oneoff"])) {
  throw new Error(`expected poll_oneoff missing syscall report, got ${JSON.stringify(missingResult.missingSyscalls)}`);
}

const runner = await createEmmixRunner({ runtimeWasm });
runner.workspace.mkdir("/workspace");
runner.workspace.writeText("/workspace/note.txt", "workspace api\n");
runner.workspace.rename("/workspace/note.txt", "/workspace/final.txt");

const entries = runner.workspace.readDir("/workspace");
if (JSON.stringify(entries) !== JSON.stringify(["final.txt"])) {
  throw new Error(`expected workspace dir entry, got ${JSON.stringify(entries)}`);
}

const note = runner.workspace.readText("/workspace/final.txt");
if (note !== "workspace api\n") {
  throw new Error(`expected workspace file contents, got ${JSON.stringify(note)}`);
}

const stat = runner.workspace.stat("/workspace/final.txt");
if (stat?.type !== "file" || stat.size !== 14) {
  throw new Error(`expected workspace file stat, got ${JSON.stringify(stat)}`);
}

runner.workspace.removeFile("/workspace/final.txt");
runner.workspace.removeDirectory("/workspace");

console.log("runner smoke passed");

function createHelloWasiModule() {
  const iovecAndMessage = [
    ...u32le(16),
    ...u32le(6),
    ..."hello\n".split("").map((char) => char.charCodeAt(0)),
  ];

  const module = [
    0x00, 0x61, 0x73, 0x6d,
    0x01, 0x00, 0x00, 0x00,
    ...section(1, [
      ...u32(2),
      0x60,
      ...u32(4),
      0x7f,
      0x7f,
      0x7f,
      0x7f,
      ...u32(1),
      0x7f,
      0x60,
      ...u32(0),
      ...u32(0),
    ]),
    ...section(2, [
      ...u32(1),
      ...name("wasi_snapshot_preview1"),
      ...name("fd_write"),
      0x00,
      ...u32(0),
    ]),
    ...section(3, [
      ...u32(1),
      ...u32(1),
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
      ...u32(1),
    ]),
    ...section(10, [
      ...u32(1),
      ...body([
        0x41,
        ...u32(1),
        0x41,
        ...u32(8),
        0x41,
        ...u32(1),
        0x41,
        ...u32(0),
        0x10,
        ...u32(0),
        0x1a,
        0x0b,
      ]),
    ]),
    ...section(11, [
      ...u32(1),
      0x00,
      0x41,
      ...u32(8),
      0x0b,
      ...u32(iovecAndMessage.length),
      ...iovecAndMessage,
    ]),
  ];

  return new Uint8Array(module);
}

function createMissingSyscallModule() {
  const module = [
    0x00, 0x61, 0x73, 0x6d,
    0x01, 0x00, 0x00, 0x00,
    ...section(1, [
      ...u32(2),
      0x60,
      ...u32(4),
      0x7f,
      0x7f,
      0x7f,
      0x7f,
      ...u32(1),
      0x7f,
      0x60,
      ...u32(0),
      ...u32(0),
    ]),
    ...section(2, [
      ...u32(1),
      ...name("wasi_snapshot_preview1"),
      ...name("poll_oneoff"),
      0x00,
      ...u32(0),
    ]),
    ...section(3, [
      ...u32(1),
      ...u32(1),
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
      ...u32(1),
    ]),
    ...section(10, [
      ...u32(1),
      ...body([
        0x41,
        ...u32(0),
        0x41,
        ...u32(0),
        0x41,
        ...u32(0),
        0x41,
        ...u32(0),
        0x10,
        ...u32(0),
        0x1a,
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

function u32le(value) {
  return [
    value & 0xff,
    (value >> 8) & 0xff,
    (value >> 16) & 0xff,
    (value >> 24) & 0xff,
  ];
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
