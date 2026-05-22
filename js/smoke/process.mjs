import { mkdir, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import {
  EmmixProcess,
  EmmixWorkspaceConflictError,
} from "../process-node.js";
import {
  detectRuntimeCapabilities,
  recommendProcessStrategy,
} from "../capabilities.js";

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
const observedEvents = [];
const unsubscribeEvents = process.events.subscribe((event) => {
  observedEvents.push(event);
});

try {
  if (!process.audit.export().some((event) => event.type === "runtime:boot")) {
    throw new Error("expected audit log to include runtime:boot");
  }

  if (process.capabilities.environment !== "node") {
    throw new Error(`expected node capabilities, got ${process.capabilities.environment}`);
  }
  if (process.capabilities.recommendedProcessStrategy !== "node-worker") {
    throw new Error(`expected node-worker strategy, got ${process.capabilities.recommendedProcessStrategy}`);
  }
  if (!process.capabilities.features.nodeWorkerThreads) {
    throw new Error("expected node worker thread capability");
  }

  const syntheticBrowserCapabilities = detectRuntimeCapabilities({
    environment: "browser",
    moduleWorker: true,
    globalThis: {
      WebAssembly,
      Worker: function Worker() {},
      SharedWorker: function SharedWorker() {},
      SharedArrayBuffer,
      Atomics,
      crossOriginIsolated: true,
    },
  });
  if (syntheticBrowserCapabilities.recommendedProcessStrategy !== "module-worker") {
    throw new Error(`expected synthetic browser module-worker strategy, got ${syntheticBrowserCapabilities.recommendedProcessStrategy}`);
  }
  if (!syntheticBrowserCapabilities.blocking) {
    throw new Error("expected synthetic browser SAB blocking capability");
  }
  if (recommendProcessStrategy({
    webAssembly: true,
    wasmCompileStreaming: true,
    classicWorker: true,
    moduleWorker: false,
    sharedWorker: false,
    sharedArrayBuffer: false,
    atomicsWait: false,
    crossOriginIsolated: false,
    nodeWorkerThreads: false,
  }) !== "classic-worker") {
    throw new Error("expected classic-worker fallback strategy");
  }

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

  const transaction = process.workspace.beginTransaction();
  await transaction.writeText("/workspace/transaction.txt", "transaction commit");
  const transactionResult = await transaction.commit();
  if (!transactionResult.changes.some((change) => change.path === "/workspace/transaction.txt")) {
    throw new Error(`expected transaction commit change, got ${JSON.stringify(transactionResult.changes)}`);
  }
  const transactionText = await process.workspace.readText("/workspace/transaction.txt");
  if (transactionText !== "transaction commit") {
    throw new Error(`expected transaction file, got ${JSON.stringify(transactionText)}`);
  }

  const rolledBack = process.workspace.beginTransaction();
  await rolledBack.writeText("/workspace/rolled-back.txt", "nope");
  rolledBack.rollback();
  const rolledBackStat = await process.workspace.stat("/workspace/rolled-back.txt");
  if (rolledBackStat !== undefined) {
    throw new Error(`expected rolled-back file to be absent, got ${JSON.stringify(rolledBackStat)}`);
  }

  await process.workspace.writeText("/workspace/conflict.txt", "base");
  const conflictTransaction = process.workspace.beginTransaction();
  await conflictTransaction.writeText("/workspace/conflict.txt", "incoming");
  await process.workspace.writeText("/workspace/conflict.txt", "current");
  await conflictTransaction.commit().then(
    () => {
      throw new Error("expected transaction conflict");
    },
    (error) => {
      if (!(error instanceof EmmixWorkspaceConflictError)) {
        throw error;
      }
      const [conflict] = error.conflicts;
      if (
        conflict?.path !== "/workspace/conflict.txt" ||
        new TextDecoder().decode(conflict.current?.bytes) !== "current" ||
        new TextDecoder().decode(conflict.incoming?.bytes) !== "incoming"
      ) {
        throw new Error(`unexpected conflict payload: ${JSON.stringify(error.conflicts)}`);
      }
    },
  );

  const overwriteTransaction = process.workspace.beginTransaction();
  await overwriteTransaction.writeText("/workspace/conflict.txt", "incoming-lww");
  await process.workspace.writeText("/workspace/conflict.txt", "current-lww");
  const overwriteResult = await overwriteTransaction.commit({ conflict: "last-write-wins" });
  if (overwriteResult.conflicts.length !== 1) {
    throw new Error(`expected last-write-wins conflict metadata, got ${JSON.stringify(overwriteResult.conflicts)}`);
  }
  const overwriteText = await process.workspace.readText("/workspace/conflict.txt");
  if (overwriteText !== "incoming-lww") {
    throw new Error(`expected last-write-wins text, got ${JSON.stringify(overwriteText)}`);
  }

  if (!observedEvents.some((event) => event.type === "workspace:conflict")) {
    throw new Error("expected observed workspace:conflict event");
  }
  if (!process.audit.export({ type: "workspace:write" }).some((event) =>
    event.detail.path === "/workspace/conflict.txt" && event.detail.byteLength === 12
  )) {
    throw new Error("expected workspace write audit event with byte length metadata");
  }

  if (process.shell.pwd() !== "/") {
    throw new Error(`expected initial shell cwd /, got ${process.shell.pwd()}`);
  }

  await process.shell.cd("/workspace");
  if (process.shell.pwd() !== "/workspace") {
    throw new Error(`expected shell cwd /workspace, got ${process.shell.pwd()}`);
  }

  await process.shell.writeText("relative.txt", "relative shell workspace\n");
  const relativeText = await process.workspace.readText("/workspace/relative.txt");
  if (relativeText !== "relative shell workspace\n") {
    throw new Error(`expected shell relative write, got ${JSON.stringify(relativeText)}`);
  }

  process.shell.setEnv("EMMIX_FIXTURE", "present");
  process.shell.setEnv("SHELL_MARKER", "session");
  process.shell.unsetEnv("SHELL_MARKER");
  const commandOptions = process.shell.commandOptions({
    args: ["fixture", "one", "two words"],
  });
  if (!commandOptions.environ.includes("PWD=/workspace")) {
    throw new Error(`expected command environ to include PWD, got ${JSON.stringify(commandOptions.environ)}`);
  }
  if (!commandOptions.environ.includes("EMMIX_FIXTURE=present")) {
    throw new Error(`expected command environ to include shell env, got ${JSON.stringify(commandOptions.environ)}`);
  }
  if (commandOptions.environ.some((entry) => entry.startsWith("SHELL_MARKER="))) {
    throw new Error(`expected unset env to be removed, got ${JSON.stringify(commandOptions.environ)}`);
  }

  const commandNames = process.commands.list().map((command) => command.name);
  for (const name of ["cat", "cd", "ls", "mkdir", "pwd", "write"]) {
    if (!commandNames.includes(name)) {
      throw new Error(`expected default command registry to include ${name}`);
    }
  }

  await process.commands.execute(["mkdir", "registry"]);
  await process.commands.execute(["write", "registry/note.txt", "hello registry"]);
  const registryCat = await process.commands.execute(["cat", "registry/note.txt"]);
  const registryText = new TextDecoder().decode(registryCat.stdout);
  if (registryText !== "hello registry") {
    throw new Error(`expected registry cat output, got ${JSON.stringify(registryText)}`);
  }

  await process.commands.execute(["cd", "registry"]);
  const registryPwd = new TextDecoder().decode((await process.commands.execute(["pwd"])).stdout);
  if (registryPwd !== "/workspace/registry\n") {
    throw new Error(`expected registry pwd output, got ${JSON.stringify(registryPwd)}`);
  }
  await process.commands.execute(["cd", "/workspace"]);

  const missingCommand = await process.commands.execute(["does-not-exist"]);
  if (missingCommand.exitCode !== 127) {
    throw new Error(`expected missing command exit 127, got ${missingCommand.exitCode}`);
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

  if (!observedEvents.some((event) => event.type === "process:spawn" && event.detail.pid === spawned.pid)) {
    throw new Error("expected process:spawn event for spawned process");
  }
  if (!observedEvents.some((event) => event.type === "process:stdout" && event.detail.pid === spawned.pid)) {
    throw new Error("expected process:stdout event for spawned process");
  }
  if (!observedEvents.some((event) =>
    event.type === "process:exit" &&
    event.detail.pid === spawned.pid &&
    event.detail.exitCode === 0
  )) {
    throw new Error("expected process:exit event for spawned process");
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

  process.commands.registerWasi("persist-read", persistReadBytes, {}, {
    description: "Read the persistence smoke fixture",
  });
  const registeredPersistRead = await process.commands.execute(["persist-read"]);
  const registeredPersistStdout = new TextDecoder().decode(registeredPersistRead.stdout);
  if (registeredPersistStdout !== "persist=kept\n") {
    throw new Error(`expected registered WASI command stdout, got ${JSON.stringify(registeredPersistStdout)}`);
  }

  process.packages.addPackage({
    name: "persist-tools",
    version: "1.0.0",
    commands: [
      {
        name: "pkg-persist-read",
        wasmBytes: persistReadBytes,
        description: "Read persistent smoke state",
      },
    ],
  });
  process.packages.addPackage({
    name: "persist-tools",
    version: "1.1.0",
    commands: [],
  });

  const latestPersistTools = await process.packages.resolve("persist-tools");
  if (latestPersistTools.version !== "1.1.0") {
    throw new Error(`expected latest package version 1.1.0, got ${latestPersistTools.version}`);
  }

  const installedPackage = await process.packages.install("persist-tools@1.0.0", process.commands);
  if (installedPackage.commands.length !== 1 || !process.commands.has("pkg-persist-read")) {
    throw new Error("expected package install to register pkg-persist-read command");
  }

  const packageCommand = await process.commands.execute(["pkg-persist-read"]);
  const packageCommandStdout = new TextDecoder().decode(packageCommand.stdout);
  if (packageCommandStdout !== "persist=kept\n") {
    throw new Error(`expected package command stdout, got ${JSON.stringify(packageCommandStdout)}`);
  }

  const queuedFirst = process.spawn(persistReadBytes);
  const queuedSecond = process.spawn(persistReadBytes);
  if (queuedFirst.status !== "running") {
    throw new Error(`expected first queued test process to run, got ${queuedFirst.status}`);
  }
  if (queuedSecond.status !== "queued") {
    throw new Error(`expected second queued test process to be queued, got ${queuedSecond.status}`);
  }

  const queuedFirstResult = await process.wait(queuedFirst.pid);
  const queuedSecondResult = await process.wait(queuedSecond.pid);
  const queuedFirstStdout = new TextDecoder().decode(queuedFirstResult.stdout);
  const queuedSecondStdout = new TextDecoder().decode(queuedSecondResult.stdout);
  if (queuedFirstStdout !== "persist=kept\n" || queuedSecondStdout !== "persist=kept\n") {
    throw new Error(`expected queued process stdout, got ${JSON.stringify([queuedFirstStdout, queuedSecondStdout])}`);
  }
  if (queuedSecond.status !== "exited") {
    throw new Error(`expected queued process to exit, got ${queuedSecond.status}`);
  }

  await process.wait(999999).then(
    () => {
      throw new Error("expected unknown process wait to fail");
    },
    (error) => {
      if (!error.message.includes("unknown process")) {
        throw error;
      }
    },
  );

  await process.packages.resolve("missing-package").then(
    () => {
      throw new Error("expected missing offline package to fail");
    },
    (error) => {
      if (!error.message.includes("local package cache")) {
        throw error;
      }
    },
  );

  const timedOut = process.spawn(createSpinModule(), { timeoutMs: 25 });
  await timedOut.result.then(
    () => {
      throw new Error("expected spinning process to time out");
    },
    (error) => {
      if (error.message !== "process timed out") {
        throw error;
      }
    },
  );
  if (timedOut.status !== "cancelled") {
    throw new Error(`expected timed out process to be cancelled, got ${timedOut.status}`);
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
  unsubscribeEvents();
  process.terminate();
}

const pool = new EmmixProcess({ runtimeWasm, maxProcesses: 2 });
try {
  await pool.workspace.writeText("/persist.txt", "pool");
  const sharedFirst = pool.spawn(persistReadBytes);
  const sharedSecond = pool.spawn(persistReadBytes);
  if (sharedFirst.status !== "running" || sharedSecond.status !== "running") {
    throw new Error(`expected shared snapshot processes to run, got ${sharedFirst.status}/${sharedSecond.status}`);
  }
  const sharedFirstStdout = new TextDecoder().decode((await sharedFirst.result).stdout);
  const sharedSecondStdout = new TextDecoder().decode((await sharedSecond.result).stdout);
  if (sharedFirstStdout !== "persist=pool\n" || sharedSecondStdout !== "persist=pool\n") {
    throw new Error(`expected shared snapshot stdout, got ${JSON.stringify([sharedFirstStdout, sharedSecondStdout])}`);
  }

  await pool.workspace.writeText("/persist.txt", "before-secondary");
  const secondaryRead = pool.spawn(persistReadBytes);
  const secondaryWrite = pool.spawn(persistWriteBytes);
  await Promise.all([secondaryRead.result, secondaryWrite.result]);
  const mergedPersistText = await pool.workspace.readText("/persist.txt");
  if (mergedPersistText !== "kept") {
    throw new Error(`expected secondary worker write to merge, got ${JSON.stringify(mergedPersistText)}`);
  }

  const first = pool.spawn(createSpinModule());
  const second = pool.spawn(createSpinModule());
  const third = pool.spawn(createSpinModule());

  if (first.status !== "running" || second.status !== "running") {
    throw new Error(`expected first two pool processes to run, got ${first.status}/${second.status}`);
  }
  if (third.status !== "queued") {
    throw new Error(`expected third pool process to queue, got ${third.status}`);
  }

  pool.cancel();

  await Promise.allSettled([first.result, second.result, third.result]).then((results) => {
    for (const result of results) {
      if (result.status !== "rejected" || result.reason.message !== "process cancelled") {
        throw new Error(`expected pool process cancellation, got ${JSON.stringify(results)}`);
      }
    }
  });
} finally {
  pool.terminate();
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
