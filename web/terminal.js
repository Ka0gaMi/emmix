const A = {
  reset: "",
  bold: "",
  dim: "",
  red: "",
  green: "",
  yellow: "",
  blue: "",
  cyan: "",
  bRed: "",
  bGreen: "",
  bYellow: "",
  bBlue: "",
  bCyan: "",
  bWhite: "",
};

const state = {
  wasmBytes: null,
  wasmName: null,
  args: ["sh"],
  env: ["PATH=/usr/bin:/bin", "HOME=/home"],
  stdin: "",
  running: false,
  cancelRequested: false,
  cwd: "/",
  history: [],
  historyIndex: -1,
};

const terminalWrap = document.getElementById("terminal-wrap");
const statusEl = document.getElementById("status");
const wasmBadge = document.getElementById("wasm-badge");
const wasmLabel = document.getElementById("wasm-label");
const fileInput = document.getElementById("file-input");
const dropOverlay = document.getElementById("drop-overlay");

let process = null;
let outputEl;
let promptEl;
let inputEl;

function createTerminalDom() {
  terminalWrap.innerHTML = "";

  outputEl = document.createElement("div");
  outputEl.className = "terminal-output";

  const inputRow = document.createElement("div");
  inputRow.className = "terminal-input-row";

  promptEl = document.createElement("span");
  promptEl.className = "terminal-prompt";

  inputEl = document.createElement("input");
  inputEl.className = "terminal-input";
  inputEl.autocomplete = "off";
  inputEl.autocapitalize = "off";
  inputEl.spellcheck = false;

  inputRow.append(promptEl, inputEl);
  terminalWrap.append(outputEl, inputRow);
  updatePrompt();

  terminalWrap.addEventListener("pointerdown", () => inputEl.focus());
  inputEl.addEventListener("keydown", handleInputKeydown);
  inputEl.focus();
}

function updatePrompt() {
  const cwd = process?.shell?.pwd() ?? state.cwd;
  const dir = cwd === "/" ? "/" : cwd.split("/").pop();
  promptEl.innerHTML = `<span class="green">emmix</span><span class="muted">:</span><span class="blue">${escapeHtml(dir)}</span><strong>&gt;</strong>`;
}

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = `status-pill ${cls}`;
}

function setWasmName(name) {
  state.wasmName = name;
  wasmLabel.textContent = name ?? "no module loaded";
  wasmBadge.className = "wasm-badge" + (name ? " loaded" : "");
}

function write(text = "", className = "") {
  const span = document.createElement("span");
  if (className) span.className = className;
  span.textContent = text;
  outputEl.appendChild(span);
  scrollToBottom();
}

function writeln(text = "", className = "") {
  write(text + "\n", className);
}

function writeHtml(html = "") {
  const span = document.createElement("span");
  span.innerHTML = html;
  outputEl.appendChild(span);
  scrollToBottom();
}

function writelnHtml(html = "") {
  writeHtml(html + "\n");
}

function echoCommand(line) {
  writelnHtml(`${promptEl.innerHTML} ${escapeHtml(line)}`);
}

function scrollToBottom() {
  terminalWrap.scrollTop = terminalWrap.scrollHeight;
}

async function loadRunner() {
  try {
    const procMod = await import("/js/process.js");
    process = new procMod.EmmixProcess();
    return true;
  } catch (error) {
    console.error(error);
    return false;
  }
}

function handleInputKeydown(event) {
  if (event.key === "Enter") {
    event.preventDefault();
    const line = inputEl.value;
    inputEl.value = "";
    runInputLine(line);
    return;
  }

  if (event.key === "ArrowUp") {
    event.preventDefault();
    if (state.history.length === 0) return;
    if (state.historyIndex < state.history.length - 1) state.historyIndex++;
    inputEl.value = state.history[state.historyIndex] ?? "";
    queueMicrotask(() => inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length));
    return;
  }

  if (event.key === "ArrowDown") {
    event.preventDefault();
    if (state.historyIndex > 0) {
      state.historyIndex--;
      inputEl.value = state.history[state.historyIndex] ?? "";
    } else {
      state.historyIndex = -1;
      inputEl.value = "";
    }
    return;
  }

  if (event.key === "l" && event.ctrlKey) {
    event.preventDefault();
    COMMANDS.clear();
    return;
  }

  if (event.key === "c" && event.ctrlKey) {
    event.preventDefault();
    if (state.running) {
      COMMANDS.kill();
    } else {
      inputEl.value = "";
      writeln("^C", "muted");
    }
  }
}

async function runInputLine(line) {
  const trimmed = line.trim();
  echoCommand(line);
  if (!trimmed) return;

  state.history.unshift(line);
  state.history = state.history.slice(0, 300);
  state.historyIndex = -1;

  const spaceIdx = line.search(/\s/);
  const cmd = spaceIdx === -1 ? line.trim() : line.slice(0, spaceIdx).trim();
  const rest = spaceIdx === -1 ? "" : line.slice(spaceIdx + 1);
  const handler = COMMANDS[cmd] ?? COMMANDS[cmd.toLowerCase()];

  inputEl.disabled = true;
  try {
    if (handler) {
      await handler(rest);
    } else {
      writeln(`unknown command: ${cmd} - type help`, "error");
    }
  } catch (error) {
    writeln(`error: ${error.message}`, "error");
  } finally {
    inputEl.disabled = false;
    updatePrompt();
    inputEl.focus();
  }
}

const COMMANDS = Object.create(null);

COMMANDS.help = function() {
  writeln();
  writeln("Emmix Browser Terminal - browser-first WASI runtime - wasm32-wasip1", "title");
  writeln();
  writeln("WASM commands", "title");
  writeCommand("run [arg ...]", "Run the loaded WASM module");
  writeCommand("kill", "Cancel the running module");
  writeCommand("upload", "Open file picker to load a .wasm file");
  writeCommand("example", "Load the built-in hello.wasm fixture");
  writeCommand("load <url>", "Fetch a .wasm file from a URL or local path");
  writeCommand("stdin [text]", "Set stdin for next run");
  writeCommand("args [arg ...]", "Set program arguments");
  writeCommand("env [K=V ...]", "Set environment variables");
  writeCommand("info", "Show current configuration");
  writeCommand("reset", "Reset args, env, and stdin to defaults");
  writeln();
  writeln("Filesystem commands", "title");
  writeCommand("ls [path]", "List directory contents");
  writeCommand("cd <path>", "Change working directory");
  writeCommand("pwd", "Print working directory");
  writeCommand("mkdir <path>", "Create directory");
  writeCommand("touch <path>", "Create empty file");
  writeCommand("write <path> <text>", "Write text to file");
  writeCommand("cat <path>", "Print file contents");
  writeCommand("rm <path>", "Remove file");
  writeCommand("rmdir <path>", "Remove empty directory");
  writeln();
  writeln("Other", "title");
  writeCommand("clear", "Clear the terminal");
  writeCommand("help", "Show this message");
  writeln();
};

COMMANDS.clear = function() {
  outputEl.textContent = "";
};

COMMANDS.info = function() {
  const mod = state.wasmName
    ? `${state.wasmName} (${fmt(state.wasmBytes.byteLength)})`
    : "none";
  writeln();
  writeln("Configuration", "title");
  writeln(`  module   ${mod}`);
  writeln(`  args     ${JSON.stringify(state.args)}`);
  writeln(`  env      ${JSON.stringify(process?.shell?.environ ?? state.env)}`);
  writeln(`  stdin    ${state.stdin ? JSON.stringify(state.stdin) : "(empty)"}`);
  writeln(`  cwd      ${process?.shell?.pwd() ?? state.cwd}`);
  writeln();
};

COMMANDS.reset = function() {
  state.args = ["sh"];
  state.env = ["PATH=/usr/bin:/bin", "HOME=/home"];
  state.stdin = "";
  process?.shell?.setEnviron(state.env);
  process?.shell?.setEnv("PWD", process.shell.pwd());
  writeln("reset to defaults", "success");
};

COMMANDS.upload = function() {
  fileInput.click();
};

COMMANDS.kill = function() {
  if (!state.running || !process) {
    writeln("no process is running", "muted");
    return;
  }

  state.cancelRequested = true;
  process.cancel();
  writeln("cancelled running process", "warning");
};

COMMANDS.args = function(rest) {
  if (!rest.trim()) {
    writeln(`args: ${JSON.stringify(state.args)}`);
    return;
  }
  state.args = splitArgs(rest);
  writeln(`args -> ${JSON.stringify(state.args)}`, "success");
};

COMMANDS.env = function(rest) {
  if (!rest.trim()) {
    return runRegistryCommand(["env"], { empty: "  (empty)\n" });
  }

  if (!process?.shell) {
    writeln("runtime not loaded", "error");
    return;
  }

  state.env = rest.trim().split(/\s+/).filter(Boolean);
  process.shell.setEnviron(state.env);
  process?.shell?.setEnv("PWD", process.shell.pwd());
  writeln(`env -> ${JSON.stringify(state.env)}`, "success");
};

COMMANDS.stdin = function(rest) {
  state.stdin = rest.trim() ? rest.trim() + "\n" : "";
  writeln(state.stdin ? `stdin set: ${JSON.stringify(state.stdin)}` : "stdin cleared", "success");
};

COMMANDS.load = async function(rest) {
  const url = rest.trim();
  if (!url) {
    writeln("Usage: load <url>", "error");
    return;
  }
  writeln(`Fetching ${url}...`, "muted");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const buf = await res.arrayBuffer();
  onWasmLoaded(new Uint8Array(buf), url.split("/").pop() || url);
};

COMMANDS.example = async function() {
  await COMMANDS.load("/target/emmix-fixtures/direct/hello.wasm");
};

COMMANDS.run = async function(rest) {
  if (state.running) {
    writeln("A module is already running. Press Ctrl+C or use kill to cancel it.", "warning");
    return;
  }

  if (!state.wasmBytes) {
    writeln("No module loaded. Use upload or example.", "error");
    return;
  }

  if (!process) {
    writeln("Emmix runtime not available. Build pkg/ with wasm-pack build --target web.", "error");
    return;
  }

  const runArgs = rest.trim() ? [state.args[0], ...splitArgs(rest)] : state.args;
  state.running = true;
  state.cancelRequested = false;
  setStatus("running", "running");

  writeln();
  writeln(`run ${state.wasmName} args=${JSON.stringify(runArgs)}`, "muted");

  const stdoutDecoder = new TextDecoder();
  const stderrDecoder = new TextDecoder();
  const t0 = performance.now();

  try {
    const result = await process.shell.run(state.wasmBytes, {
      args: runArgs,
      environ: state.env,
      stdin: state.stdin || undefined,
      onStdout(chunk) {
        const text = stdoutDecoder.decode(chunk, { stream: true });
        if (text) write(text);
      },
      onStderr(chunk) {
        const text = stderrDecoder.decode(chunk, { stream: true });
        if (text) write(text, "error");
      },
    });

    const stdoutTail = stdoutDecoder.decode();
    const stderrTail = stderrDecoder.decode();
    if (stdoutTail) write(stdoutTail);
    if (stderrTail) write(stderrTail, "error");

    const elapsed = ((performance.now() - t0) / 1000).toFixed(3);
    const cls = result.exitCode === 0 ? "success" : "error";
    writeln(`exit ${result.exitCode}  ${elapsed}s  stdout ${fmt(result.stdout.byteLength)}  stderr ${fmt(result.stderr.byteLength)}`, cls);

    if (result.missingSyscalls.length > 0) {
      writeln(`missing syscalls: ${result.missingSyscalls.join(", ")}`, "warning");
    }

    setStatus(result.exitCode === 0 ? "ready" : "error", result.exitCode === 0 ? "ready" : "error");
  } catch (error) {
    const cancelled = state.cancelRequested || error.message === "process cancelled";
    writeln(cancelled ? "cancelled" : `runtime error: ${error.message}`, cancelled ? "warning" : "error");
    setStatus(cancelled ? "ready" : "error", cancelled ? "ready" : "error");
  } finally {
    state.running = false;
    state.cancelRequested = false;
  }
};

function requireShell() {
  if (!process?.commands) {
    writeln("VFS not available (runtime not loaded)", "error");
    return false;
  }
  return true;
}

COMMANDS.ls = async function(rest) {
  if (!requireShell()) return;
  await runRegistryCommand(["ls", ...(rest.trim() ? [rest.trim()] : [])], { empty: "(empty)\n" });
};

COMMANDS.cd = async function(rest) {
  if (!requireShell()) return;
  await runRegistryCommand(["cd", rest.trim() || "/"]);
  state.cwd = process.shell.pwd();
  updatePrompt();
};

COMMANDS.pwd = async function() {
  await runRegistryCommand(["pwd"]);
};

COMMANDS.mkdir = async function(rest) {
  if (!requireShell()) return;
  const path = rest.trim();
  if (!path) {
    writeln("Usage: mkdir <path>", "error");
    return;
  }
  const abs = process.shell.resolve(path);
  await runRegistryCommand(["mkdir", path]);
  writeln(`created ${abs}/`, "success");
};

COMMANDS.touch = async function(rest) {
  if (!requireShell()) return;
  const path = rest.trim();
  if (!path) {
    writeln("Usage: touch <path>", "error");
    return;
  }
  const abs = process.shell.resolve(path);
  await runRegistryCommand(["touch", path]);
  writeln(abs, "success");
};

COMMANDS.write = async function(rest) {
  if (!requireShell()) return;
  const spaceIdx = rest.search(/\s/);
  if (spaceIdx === -1) {
    writeln("Usage: write <path> <text>", "error");
    return;
  }
  const path = rest.slice(0, spaceIdx);
  const content = rest.slice(spaceIdx + 1);
  const abs = process.shell.resolve(path);
  await runRegistryCommand(["write", path, content]);
  writeln(`wrote ${content.length} bytes to ${abs}`, "success");
};

COMMANDS.cat = async function(rest) {
  if (!requireShell()) return;
  const path = rest.trim();
  if (!path) {
    writeln("Usage: cat <path>", "error");
    return;
  }
  await runRegistryCommand(["cat", path]);
};

COMMANDS.rm = async function(rest) {
  if (!requireShell()) return;
  const path = rest.trim();
  if (!path) {
    writeln("Usage: rm <path>", "error");
    return;
  }
  const abs = process.shell.resolve(path);
  await runRegistryCommand(["rm", path]);
  writeln(`removed ${abs}`, "success");
};

COMMANDS.rmdir = async function(rest) {
  if (!requireShell()) return;
  const path = rest.trim();
  if (!path) {
    writeln("Usage: rmdir <path>", "error");
    return;
  }
  const abs = process.shell.resolve(path);
  await runRegistryCommand(["rmdir", path]);
  writeln(`removed ${abs}/`, "success");
};

async function runRegistryCommand(argv, options = {}) {
  const result = await process.commands.execute(argv);
  const stdout = decodeOutput(result.stdout);
  const stderr = decodeOutput(result.stderr);

  if (stdout.length > 0) {
    write(stdout);
    if (!stdout.endsWith("\n")) writeln();
  } else if (options.empty !== undefined) {
    write(options.empty, "muted");
  }

  if (stderr.length > 0) {
    write(stderr, "error");
    if (!stderr.endsWith("\n")) writeln();
  }

  if (result.exitCode !== 0) {
    throw new Error(`command exited with ${result.exitCode}`);
  }

  return result;
}

function writeCommand(command, description) {
  writelnHtml(`  <span class="green">${escapeHtml(command)}</span><span class="command-gap"></span>${escapeHtml(description)}`);
}

function onWasmLoaded(bytes, name) {
  state.wasmBytes = bytes;
  setWasmName(name);
  writeln(`Loaded ${name} (${fmt(bytes.byteLength)}). Type run to execute.`, "success");
}

fileInput.addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  onWasmLoaded(new Uint8Array(await file.arrayBuffer()), file.name);
  fileInput.value = "";
});

document.addEventListener("dragenter", (event) => {
  if ([...event.dataTransfer.items].some((item) => item.kind === "file")) {
    dropOverlay.classList.add("active");
  }
});

document.addEventListener("dragleave", (event) => {
  if (!event.relatedTarget || event.relatedTarget === document.documentElement) {
    dropOverlay.classList.remove("active");
  }
});

document.addEventListener("dragover", (event) => event.preventDefault());
document.addEventListener("drop", async (event) => {
  event.preventDefault();
  dropOverlay.classList.remove("active");
  const file = event.dataTransfer.files[0];
  if (!file) return;
  if (!file.name.endsWith(".wasm")) {
    writeln("Only .wasm files are supported.", "error");
    return;
  }
  onWasmLoaded(new Uint8Array(await file.arrayBuffer()), file.name);
});

function banner() {
  writeln("EMMIX", "banner");
  writeln("Browser-first WASI runtime - Open-source WebContainers alternative", "muted");
  writeln();
}

async function main() {
  createTerminalDom();
  banner();
  write("Initializing Emmix WASM runtime...", "muted");
  setStatus("loading", "loading");

  const ok = await loadRunner();
  outputEl.textContent = "";
  banner();

  if (ok) {
    writeln("Runtime ready", "success");
    setStatus("ready", "ready");
  } else {
    writeln("Could not load runtime.", "error");
    writeln("Run: wasm-pack build --target web", "warning");
    setStatus("error", "error");
  }

  writeln("Type help for commands. Drag and drop a .wasm file to load it.", "muted");
  writeln();
  updatePrompt();
}

function fmt(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function decodeOutput(bytes) {
  if (bytes.byteLength === 0) {
    return "";
  }

  return new TextDecoder().decode(bytes);
}

function splitArgs(str) {
  const args = [];
  let cur = "";
  let q = null;
  for (const ch of str) {
    if (q) {
      if (ch === q) q = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      q = ch;
    } else if (ch === " " || ch === "\t") {
      if (cur) {
        args.push(cur);
        cur = "";
      }
    } else {
      cur += ch;
    }
  }
  if (cur) args.push(cur);
  return args;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

main();
