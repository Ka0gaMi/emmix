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
const fixtureOutDir = join(root, "target", "emmix-fixtures", "process");
const fixtureWasm = join(fixtureOutDir, "hello.wasm");
const fixtureOptions = {
  args: ["fixture", "one", "two words"],
  environ: ["PATH=/usr/bin:/bin", "HOME=/home", "EMMIX_FIXTURE=present"],
  stdin: "input from smoke\n",
};
const expectedStdout = [
  "args=fixture,one,two words",
  "env=present",
  "stdin=input from smoke",
  "file=present|input from smoke",
  "entries=message.txt",
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

const wasmBytes = await readFile(fixtureWasm);

const process = new EmmixProcess();

try {
  const stdoutChunks = [];
  const result = await process.run(wasmBytes, {
    ...fixtureOptions,
    runtimeWasm,
    onStdout(chunk) {
      stdoutChunks.push(chunk);
    },
  });

  const stdout = new TextDecoder().decode(result.stdout);
  const streamedStdout = new TextDecoder().decode(joinChunks(stdoutChunks));

  if (result.exitCode !== 0) {
    throw new Error(`expected exit code 0, got ${result.exitCode}`);
  }

  if (stdout !== expectedStdout) {
    throw new Error(`unexpected stdout: ${JSON.stringify(stdout)}`);
  }

  if (streamedStdout !== stdout) {
    throw new Error(`expected streamed stdout to match final stdout, got ${JSON.stringify(streamedStdout)}`);
  }

  const cancelled = process.run(createSpinModule(), { runtimeWasm });
  setTimeout(() => process.cancel(), 25);

  await cancelled.then(
    () => {
      throw new Error("expected spinning process to be cancelled");
    },
    (error) => {
      if (error.message !== "process cancelled") {
        throw error;
      }
    },
  );

  const restartResult = await process.run(wasmBytes, {
    ...fixtureOptions,
    runtimeWasm,
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
