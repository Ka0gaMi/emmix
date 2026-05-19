import { mkdir, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { runWasiModule } from "../runner.js";

const runCommand = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(dirname(here));
const fixtureSource = join(root, "fixtures", "hello.rs");
const fixtureOutDir = join(root, "target", "emmix-fixtures", "direct");
const fixtureWasm = join(fixtureOutDir, "hello.wasm");
const runtimeWasm = await readFile(join(root, "pkg", "emmix_bg.wasm"));
const fixtureOptions = {
  args: ["fixture", "one", "two words"],
  environ: ["PATH=/usr/bin:/bin", "HOME=/home", "EMMIX_FIXTURE=present"],
  stdin: "input from smoke\n",
  runtimeWasm,
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

const result = await runWasiModule(await readFile(fixtureWasm), fixtureOptions);

const stdout = new TextDecoder().decode(result.stdout);
const stderr = new TextDecoder().decode(result.stderr);

if (result.exitCode !== 0) {
  throw new Error(`expected exit code 0, got ${result.exitCode}; stderr=${JSON.stringify(stderr)}`);
}

if (stdout !== expectedStdout) {
  throw new Error(`unexpected stdout: ${JSON.stringify(stdout)}`);
}

console.log("rust fixture passed");
