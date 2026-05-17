import { Terminal }  from 'https://esm.sh/@xterm/xterm@5.5.0';
import { FitAddon }  from 'https://esm.sh/@xterm/addon-fit@0.10.0';

// ── ANSI colour helpers ───────────────────────────────────────────────────────

const A = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  red:     '\x1b[31m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  blue:    '\x1b[34m',
  cyan:    '\x1b[36m',
  bRed:    '\x1b[91m',
  bGreen:  '\x1b[92m',
  bYellow: '\x1b[93m',
  bBlue:   '\x1b[94m',
  bCyan:   '\x1b[96m',
  bWhite:  '\x1b[97m',
};

// ── xterm setup ───────────────────────────────────────────────────────────────

const term = new Terminal({
  theme: {
    background:     '#0d1117',
    foreground:     '#c9d1d9',
    cursor:         '#58a6ff',
    cursorAccent:   '#0d1117',
    selectionBackground: 'rgba(88,166,255,.25)',
    black:          '#0d1117',
    red:            '#ff7b72',
    green:          '#3fb950',
    yellow:         '#d29922',
    blue:           '#58a6ff',
    magenta:        '#bc8cff',
    cyan:           '#39d353',
    white:          '#b1bac4',
    brightBlack:    '#6e7681',
    brightRed:      '#ffa198',
    brightGreen:    '#56d364',
    brightYellow:   '#e3b341',
    brightBlue:     '#79c0ff',
    brightMagenta:  '#d2a8ff',
    brightCyan:     '#56d363',
    brightWhite:    '#f0f6fc',
  },
  cursorStyle: 'block',
  cursorBlink: true,
  fontFamily: "'Cascadia Code', 'Fira Code', 'SF Mono', Consolas, monospace",
  fontSize: 14,
  lineHeight: 1.45,
  scrollback: 10000,
  allowProposedApi: true,
});

const fitAddon = new FitAddon();
term.loadAddon(fitAddon);
term.open(document.getElementById('terminal-wrap'));
fitAddon.fit();
window.addEventListener('resize', () => fitAddon.fit());

// ── Write helpers ─────────────────────────────────────────────────────────────

function write(text) {
  term.write(text.replace(/(?<!\r)\n/g, '\r\n'));
}

function writeln(text = '') {
  write(text + '\n');
}

function nl2crnl(text) {
  return text.replace(/\r?\n/g, '\r\n');
}

// ── Application state ─────────────────────────────────────────────────────────

const state = {
  wasmBytes: null,
  wasmName:  null,
  args:      ['sh'],
  env:       ['PATH=/usr/bin:/bin', 'HOME=/home'],
  stdin:     '',
  running:   false,
  cancelRequested: false,
};

// ── DOM helpers ───────────────────────────────────────────────────────────────

const statusEl    = document.getElementById('status');
const wasmBadge   = document.getElementById('wasm-badge');
const wasmLabel   = document.getElementById('wasm-label');
const fileInput   = document.getElementById('file-input');
const dropOverlay = document.getElementById('drop-overlay');

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = `status-pill ${cls}`;
}

function setWasmName(name) {
  state.wasmName = name;
  wasmLabel.textContent = name ?? 'no module loaded';
  wasmBadge.className = 'wasm-badge' + (name ? ' loaded' : '');
}

// ── Dynamic import of runner (graceful failure if pkg/ not built) ─────────────

let process = null;

async function loadRunner() {
  try {
    // Absolute path - process.js lives at /js/process.js relative to emmix root
    const mod = await import('/js/process.js');
    process = new mod.EmmixProcess();
    return true;
  } catch {
    return false;
  }
}

// ── LineEditor: readline-style single-line input ──────────────────────────────

const PROMPT = `${A.bGreen}emmix${A.reset}${A.bold}>${A.reset} `;

class LineEditor {
  constructor() {
    this.line    = '';
    this.cursor  = 0;
    this.history = [];
    this.histIdx = -1;
    this.saved   = '';
    this._res    = null;
    this._rej    = null;
  }

  prompt() {
    write(PROMPT);
    return new Promise((res, rej) => { this._res = res; this._rej = rej; });
  }

  _submit() {
    writeln();
    const line = this.line;
    if (line.trim()) {
      this.history.unshift(line);
      if (this.history.length > 300) this.history.pop();
    }
    this.line = ''; this.cursor = 0; this.histIdx = -1; this.saved = '';
    const res = this._res; this._res = null; this._rej = null;
    res(line);
  }

  _cancel() {
    writeln('^C');
    this.line = ''; this.cursor = 0; this.histIdx = -1;
    const rej = this._rej; this._res = null; this._rej = null;
    rej(new Error('cancelled'));
  }

  handleData(data) {
    if (!this._res) return;
    let i = 0;
    while (i < data.length) {
      // Escape sequences
      if (data[i] === '\x1b' && data[i+1] === '[') {
        const rest = data.slice(i + 2);
        if (rest.startsWith('A'))       { this._histUp();   i += 3; continue; }
        if (rest.startsWith('B'))       { this._histDown(); i += 3; continue; }
        if (rest.startsWith('C'))       { this._right();    i += 3; continue; }
        if (rest.startsWith('D'))       { this._left();     i += 3; continue; }
        if (rest.startsWith('H') || rest.startsWith('1~')) {
          const skip = rest.startsWith('H') ? 3 : 4;
          if (this.cursor > 0) { term.write(`\x1b[${this.cursor}D`); this.cursor = 0; }
          i += skip; continue;
        }
        if (rest.startsWith('F') || rest.startsWith('4~')) {
          const skip = rest.startsWith('F') ? 3 : 4;
          const mv = this.line.length - this.cursor;
          if (mv > 0) { term.write(`\x1b[${mv}C`); this.cursor = this.line.length; }
          i += skip; continue;
        }
        if (rest.startsWith('3~')) {    // Delete key
          if (this.cursor < this.line.length) {
            this.line = this.line.slice(0, this.cursor) + this.line.slice(this.cursor + 1);
            this._redrawTail();
          }
          i += 4; continue;
        }
        i += 2; continue;
      }

      const ch = data[i];

      if (ch === '\r' || ch === '\n') { this._submit(); return; }
      if (ch === '\x03') { this._cancel(); return; }        // Ctrl+C

      if (ch === '\x0c') {                                  // Ctrl+L
        term.clear(); this._redrawLine(); i++; continue;
      }
      if (ch === '\x01') {                                  // Ctrl+A – home
        if (this.cursor > 0) { term.write(`\x1b[${this.cursor}D`); this.cursor = 0; }
        i++; continue;
      }
      if (ch === '\x05') {                                  // Ctrl+E – end
        const mv = this.line.length - this.cursor;
        if (mv > 0) { term.write(`\x1b[${mv}C`); this.cursor = this.line.length; }
        i++; continue;
      }
      if (ch === '\x17') {                                  // Ctrl+W – delete word
        const before = this.line.slice(0, this.cursor).replace(/\S+\s*$/, '');
        const del = this.cursor - before.length;
        if (del > 0) {
          this.line = before + this.line.slice(this.cursor);
          this.cursor = before.length;
          this._redrawLine();
        }
        i++; continue;
      }
      if (ch === '\x15') {                                  // Ctrl+U – delete to start
        if (this.cursor > 0) {
          this.line = this.line.slice(this.cursor); this.cursor = 0;
          this._redrawLine();
        }
        i++; continue;
      }
      if (ch === '\x0b') {                                  // Ctrl+K – delete to end
        if (this.cursor < this.line.length) {
          this.line = this.line.slice(0, this.cursor);
          this._redrawTail();
        }
        i++; continue;
      }
      if (ch === '\x7f' || ch === '\b') {                   // Backspace
        if (this.cursor > 0) {
          this.line = this.line.slice(0, this.cursor - 1) + this.line.slice(this.cursor);
          this.cursor--;
          term.write('\b');
          this._redrawTail();
        }
        i++; continue;
      }
      if (ch >= ' ') {                                      // Printable
        this.line = this.line.slice(0, this.cursor) + ch + this.line.slice(this.cursor);
        this.cursor++;
        term.write(ch);
        if (this.cursor < this.line.length) {
          const tail = this.line.slice(this.cursor);
          term.write(tail + `\x1b[${tail.length}D`);
        }
        i++; continue;
      }
      i++;
    }
  }

  // Redraw everything from cursor position to end of line, leave cursor where it was
  _redrawTail() {
    const tail = this.line.slice(this.cursor);
    term.write(tail + ' ' + `\x1b[${tail.length + 1}D`);
  }

  // Redraw the whole prompt line
  _redrawLine() {
    term.write('\r\x1b[2K');
    write(PROMPT + this.line);
    const back = this.line.length - this.cursor;
    if (back > 0) term.write(`\x1b[${back}D`);
  }

  _right() {
    if (this.cursor < this.line.length) { this.cursor++; term.write('\x1b[C'); }
  }
  _left() {
    if (this.cursor > 0) { this.cursor--; term.write('\x1b[D'); }
  }
  _histUp() {
    if (this.histIdx === -1) this.saved = this.line;
    if (this.histIdx < this.history.length - 1) {
      this.histIdx++;
      this.line = this.history[this.histIdx];
      this.cursor = this.line.length;
      this._redrawLine();
    }
  }
  _histDown() {
    if (this.histIdx > 0)        { this.histIdx--; this.line = this.history[this.histIdx]; }
    else if (this.histIdx === 0) { this.histIdx = -1; this.line = this.saved; }
    this.cursor = this.line.length;
    this._redrawLine();
  }

  // Called externally when something writes to the terminal mid-input
  interrupt(message) {
    term.write('\r\x1b[2K');
    writeln(message);
    this._redrawLine();
  }
}

// ── StdinCollector: multiline stdin input ─────────────────────────────────────

class StdinCollector {
  constructor() {
    this.lines   = [];
    this.current = '';
    this._res    = null;
  }

  start() {
    writeln(`${A.dim}(type input; Ctrl+D on empty line to finish, Ctrl+C to cancel)${A.reset}`);
    write(`${A.dim}>${A.reset} `);
    return new Promise(res => { this._res = res; });
  }

  handleData(data) {
    if (!this._res) return;
    for (const ch of data) {
      if (ch === '\x04') {            // Ctrl+D
        if (this.current.length) { this.lines.push(this.current); this.current = ''; }
        writeln();
        const res = this._res; this._res = null;
        res(this.lines.join('\n') + (this.lines.length ? '\n' : ''));
        return;
      }
      if (ch === '\x03') {            // Ctrl+C
        writeln('^C');
        const res = this._res; this._res = null;
        res('');
        return;
      }
      if (ch === '\r' || ch === '\n') {
        writeln();
        this.lines.push(this.current);
        this.current = '';
        write(`${A.dim}>${A.reset} `);
        continue;
      }
      if (ch === '\x7f' || ch === '\b') {
        if (this.current.length) { this.current = this.current.slice(0, -1); term.write('\b \b'); }
        continue;
      }
      if (ch >= ' ') { this.current += ch; term.write(ch); }
    }
  }
}

// ── Input dispatch ────────────────────────────────────────────────────────────

let activeHandler = null;
term.onData(data => {
  if (state.running && data.includes('\x03')) {
    COMMANDS.kill();
    return;
  }

  if (activeHandler) activeHandler.handleData(data);
});

// ── Shared editor instance ────────────────────────────────────────────────────

const editor = new LineEditor();

// ── Commands ──────────────────────────────────────────────────────────────────

const COMMANDS = Object.create(null);

COMMANDS.help = function() {
  writeln();
  writeln(`${A.bold}${A.bCyan}Emmix Browser Terminal${A.reset}  ${A.dim}· browser-first WASI runtime · wasm32-wasip1${A.reset}`);
  writeln();
  writeln(`${A.bold}Commands${A.reset}`);
  writeln(`  ${A.bGreen}run${A.reset} ${A.dim}[arg ...]${A.reset}        Run the loaded WASM module`);
  writeln(`  ${A.bGreen}kill${A.reset}                  Cancel the running module`);
  writeln(`  ${A.bGreen}upload${A.reset}               Open file picker to load a .wasm file`);
  writeln(`  ${A.bGreen}example${A.reset}              Load the built-in hello.wasm fixture`);
  writeln(`  ${A.bGreen}load${A.reset} ${A.dim}<url>${A.reset}           Fetch a .wasm file from a URL or local path`);
  writeln(`  ${A.bGreen}stdin${A.reset} ${A.dim}[text]${A.reset}         Set stdin for next run (no arg = multiline mode)`);
  writeln(`  ${A.bGreen}args${A.reset} ${A.dim}[arg ...]${A.reset}       Set program arguments (print current if empty)`);
  writeln(`  ${A.bGreen}env${A.reset} ${A.dim}[K=V ...]${A.reset}        Set environment variables (print current if empty)`);
  writeln(`  ${A.bGreen}info${A.reset}                 Show current configuration`);
  writeln(`  ${A.bGreen}reset${A.reset}                Reset args, env, and stdin to defaults`);
  writeln(`  ${A.bGreen}clear${A.reset}                Clear the terminal`);
  writeln(`  ${A.bGreen}help${A.reset}                 Show this message`);
  writeln();
  writeln(`${A.bold}Keyboard shortcuts${A.reset}`);
  writeln(`  ${A.bYellow}↑ / ↓${A.reset}     Command history`);
  writeln(`  ${A.bYellow}Ctrl+C${A.reset}    Cancel input`);
  writeln(`  ${A.bYellow}Ctrl+C${A.reset}    Cancel a running module`);
  writeln(`  ${A.bYellow}Ctrl+L${A.reset}    Clear screen`);
  writeln(`  ${A.bYellow}Ctrl+W${A.reset}    Delete word`);
  writeln(`  ${A.bYellow}Ctrl+D${A.reset}    End multiline stdin input`);
  writeln();
  writeln(`${A.bold}Tips${A.reset}`);
  writeln(`  Drag and drop a ${A.bBlue}.wasm${A.reset} file onto the window to load it instantly.`);
  writeln(`  Compile: ${A.dim}rustc --target wasm32-wasip1 hello.rs -o hello.wasm${A.reset}`);
  writeln(`  Or:      ${A.dim}cargo build --target wasm32-wasip1 --release${A.reset}`);
  writeln();
};

COMMANDS.clear = function() { term.clear(); };

COMMANDS.info = function() {
  writeln();
  const mod = state.wasmName
    ? `${A.bBlue}${state.wasmName}${A.reset} (${fmt(state.wasmBytes.byteLength)})`
    : `${A.dim}none${A.reset}`;
  writeln(`${A.bold}Configuration${A.reset}`);
  writeln(`  ${A.cyan}module${A.reset}   ${mod}`);
  writeln(`  ${A.cyan}args${A.reset}     ${A.dim}${JSON.stringify(state.args)}${A.reset}`);
  writeln(`  ${A.cyan}env${A.reset}      ${A.dim}${JSON.stringify(state.env)}${A.reset}`);
  const stdinPreview = state.stdin
    ? `${JSON.stringify(state.stdin.slice(0, 80))}${state.stdin.length > 80 ? '…' : ''} (${state.stdin.length} bytes)`
    : `${A.dim}(empty)${A.reset}`;
  writeln(`  ${A.cyan}stdin${A.reset}    ${stdinPreview}`);
  writeln();
};

COMMANDS.reset = function() {
  state.args  = ['sh'];
  state.env   = ['PATH=/usr/bin:/bin', 'HOME=/home'];
  state.stdin = '';
  writeln(`${A.bGreen}✓${A.reset} Reset to defaults.`);
};

COMMANDS.upload = function() { fileInput.click(); };

COMMANDS.kill = function() {
  if (!state.running || !process) {
    writeln(`${A.dim}no process is running${A.reset}`);
    return;
  }

  state.cancelRequested = true;
  process.cancel();
  writeln(`${A.bYellow}cancelled running process${A.reset}`);
};

COMMANDS.args = function(rest) {
  if (!rest.trim()) {
    writeln(`${A.cyan}args:${A.reset} ${JSON.stringify(state.args)}`);
    return;
  }
  state.args = splitArgs(rest);
  writeln(`${A.bGreen}✓${A.reset} args → ${JSON.stringify(state.args)}`);
};

COMMANDS.env = function(rest) {
  if (!rest.trim()) {
    writeln(`${A.cyan}env:${A.reset}`);
    for (const e of state.env) writeln(`  ${A.dim}${e}${A.reset}`);
    if (!state.env.length) writeln(`  ${A.dim}(empty)${A.reset}`);
    return;
  }
  state.env = rest.trim().split(/\s+/).filter(Boolean);
  writeln(`${A.bGreen}✓${A.reset} env → ${JSON.stringify(state.env)}`);
};

COMMANDS.stdin = async function(rest) {
  if (rest.trim()) {
    state.stdin = rest.trim() + '\n';
    writeln(`${A.bGreen}✓${A.reset} stdin set: ${A.dim}${JSON.stringify(state.stdin)}${A.reset}`);
    return;
  }
  const collector = new StdinCollector();
  activeHandler = collector;
  state.stdin = await collector.start();
  activeHandler = editor;
  if (state.stdin) {
    const lines = state.stdin.split('\n').length - 1;
    writeln(`${A.bGreen}✓${A.reset} stdin set: ${state.stdin.length} bytes, ${lines} line${lines !== 1 ? 's' : ''}`);
  } else {
    writeln(`${A.dim}stdin cleared${A.reset}`);
  }
};

COMMANDS.load = async function(rest) {
  const url = rest.trim();
  if (!url) { writeln(`${A.bRed}✗${A.reset} Usage: load <url>`); return; }
  writeln(`${A.dim}Fetching ${url}…${A.reset}`);
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const buf = await res.arrayBuffer();
    onWasmLoaded(new Uint8Array(buf), url.split('/').pop() || url);
  } catch (e) {
    writeln(`${A.bRed}✗${A.reset} Failed: ${e.message}`);
  }
};

COMMANDS.example = async function() {
  await COMMANDS.load('/target/emmix-fixtures/direct/hello.wasm');
};

COMMANDS.run = async function(rest) {
  if (state.running) {
    writeln(`${A.bYellow}A module is already running. Press Ctrl+C or use ${A.bGreen}kill${A.reset} to cancel it.${A.reset}`);
    return;
  }

  if (!state.wasmBytes) {
    writeln(`${A.bRed}✗${A.reset} No module loaded. Use ${A.bGreen}upload${A.reset} or drag a .wasm file here.`);
    return;
  }
  if (!process) {
    writeln(`${A.bRed}✗${A.reset} Emmix runtime not available.`);
    writeln(`  Make sure ${A.bBlue}pkg/${A.reset} is built: ${A.dim}wasm-pack build --target web${A.reset}`);
    return;
  }

  const runArgs = rest.trim() ? [state.args[0], ...splitArgs(rest)] : state.args;

  state.running = true;
  state.cancelRequested = false;
  setStatus('running', 'running');

  writeln();
  writeln(`${A.dim}┌─ ${A.reset}${A.bold}${state.wasmName}${A.reset}  ${A.dim}args=${JSON.stringify(runArgs)}${A.reset}`);
  if (state.stdin) writeln(`${A.dim}│  stdin=${JSON.stringify(state.stdin.slice(0, 60))}${state.stdin.length > 60 ? '…' : ''}${A.reset}`);
  writeln(`${A.dim}│${A.reset}`);

  const t0 = performance.now();
  const stdoutDecoder = new TextDecoder();
  const stderrDecoder = new TextDecoder();
  let streamedStdout = 0;
  let streamedStderr = 0;
  let result;
  try {
    result = await process.run(state.wasmBytes, {
      args:    runArgs,
      environ: state.env,
      stdin:   state.stdin || undefined,
      onStdout(chunk) {
        streamedStdout += chunk.byteLength;
        const text = stdoutDecoder.decode(chunk, { stream: true });
        if (text) write(nl2crnl(text));
      },
      onStderr(chunk) {
        streamedStderr += chunk.byteLength;
        const text = stderrDecoder.decode(chunk, { stream: true });
        if (text) {
          write(A.red);
          write(nl2crnl(text));
          write(A.reset);
        }
      },
    });
  } catch (e) {
    const cancelled = state.cancelRequested || e.message === 'process cancelled';
    const label = cancelled ? `${A.bYellow}cancelled${A.reset}` : `${A.bRed}✗ runtime error:${A.reset} ${e.message}`;
    writeln(`${A.dim}└─${A.reset} ${label}`);
    writeln();
    state.running = false;
    state.cancelRequested = false;
    setStatus(cancelled ? 'ready' : 'error', cancelled ? 'ready' : 'error');
    return;
  }

  const elapsed = ((performance.now() - t0) / 1000).toFixed(3);
  const stdoutTail = stdoutDecoder.decode();
  if (stdoutTail) write(nl2crnl(stdoutTail));

  const stderrTail = stderrDecoder.decode();
  if (stderrTail) {
    write(A.red);
    write(nl2crnl(stderrTail));
    write(A.reset);
  }

  if (streamedStdout === 0 && result.stdout.byteLength > 0) {
    const stdout = new TextDecoder().decode(result.stdout);
    write(nl2crnl(stdout));
    if (!stdout.endsWith('\n')) writeln();
  }

  if (streamedStderr === 0 && result.stderr.byteLength > 0) {
    const stderr = new TextDecoder().decode(result.stderr);
    write(A.red);
    write(nl2crnl(stderr));
    write(A.reset);
    if (!stderr.endsWith('\n')) writeln();
  }

  const exitOk = result.exitCode === 0;
  const sym    = exitOk ? `${A.bGreen}✓` : `${A.bRed}✗`;
  writeln(`${A.dim}└─${A.reset} ${sym}${A.reset} ${A.dim}exit ${result.exitCode}  ${elapsed}s  stdout ${fmt(result.stdout.byteLength)}  stderr ${fmt(result.stderr.byteLength)}${A.reset}`);
  writeln();

  state.running = false;
  state.cancelRequested = false;
  setStatus(exitOk ? 'ready' : 'error', exitOk ? 'ready' : 'error');
};

// ── Utilities ─────────────────────────────────────────────────────────────────

function fmt(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function splitArgs(str) {
  const args = [];
  let cur = '';
  let q = null;
  for (const ch of str) {
    if (q) { if (ch === q) q = null; else cur += ch; }
    else if (ch === '"' || ch === "'") { q = ch; }
    else if (ch === ' ' || ch === '\t') { if (cur) { args.push(cur); cur = ''; } }
    else { cur += ch; }
  }
  if (cur) args.push(cur);
  return args;
}

// ── File loading ──────────────────────────────────────────────────────────────

function onWasmLoaded(bytes, name) {
  state.wasmBytes = bytes;
  setWasmName(name);
  const msg = `${A.bGreen}✓${A.reset} Loaded ${A.bBlue}${name}${A.reset} (${fmt(bytes.byteLength)}). Type ${A.bGreen}run${A.reset} to execute.`;
  if (activeHandler === editor) {
    editor.interrupt(msg);
  } else {
    writeln(msg);
  }
}

fileInput.addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  onWasmLoaded(new Uint8Array(await file.arrayBuffer()), file.name);
  fileInput.value = '';
});

// Drag-and-drop
document.addEventListener('dragenter', e => {
  if ([...e.dataTransfer.items].some(i => i.kind === 'file'))
    dropOverlay.classList.add('active');
});
document.addEventListener('dragleave', e => {
  if (!e.relatedTarget || e.relatedTarget === document.documentElement)
    dropOverlay.classList.remove('active');
});
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', async e => {
  e.preventDefault();
  dropOverlay.classList.remove('active');
  const file = e.dataTransfer.files[0];
  if (!file) return;
  if (!file.name.endsWith('.wasm')) {
    const msg = `${A.bRed}✗${A.reset} Only .wasm files are supported.`;
    if (activeHandler === editor) editor.interrupt(msg); else writeln(msg);
    return;
  }
  onWasmLoaded(new Uint8Array(await file.arrayBuffer()), file.name);
});

// ── REPL ──────────────────────────────────────────────────────────────────────

async function repl() {
  activeHandler = editor;
  while (true) {
    let line;
    try {
      line = await editor.prompt();
    } catch {
      continue; // Ctrl+C
    }
    if (!line.trim()) continue;

    const spaceIdx = line.search(/\s/);
    const cmd      = spaceIdx === -1 ? line.trim() : line.slice(0, spaceIdx).trim();
    const rest     = spaceIdx === -1 ? ''           : line.slice(spaceIdx + 1);
    const handler  = COMMANDS[cmd] ?? COMMANDS[cmd.toLowerCase()];

    if (handler) {
      try { await handler(rest); }
      catch (e) { writeln(`${A.bRed}error:${A.reset} ${e.message}`); }
    } else {
      writeln(`${A.bRed}unknown command:${A.reset} ${cmd}  — type ${A.bGreen}help${A.reset}`);
    }

    // Restore editor as active handler in case a command changed it
    activeHandler = editor;
  }
}

// ── Banner ────────────────────────────────────────────────────────────────────

function banner() {
  writeln(`${A.bBlue}${A.bold}  ███████╗███╗   ███╗███╗   ███╗██╗██╗  ██╗${A.reset}`);
  writeln(`${A.bBlue}${A.bold}  ██╔════╝████╗ ████║████╗ ████║██║╚██╗██╔╝${A.reset}`);
  writeln(`${A.bBlue}${A.bold}  █████╗  ██╔████╔██║██╔████╔██║██║ ╚███╔╝ ${A.reset}`);
  writeln(`${A.bBlue}${A.bold}  ██╔══╝  ██║╚██╔╝██║██║╚██╔╝██║██║ ██╔██╗ ${A.reset}`);
  writeln(`${A.bBlue}${A.bold}  ███████╗██║ ╚═╝ ██║██║ ╚═╝ ██║██║██╔╝ ██╗${A.reset}`);
  writeln(`${A.bBlue}${A.bold}  ╚══════╝╚═╝     ╚═╝╚═╝     ╚═╝╚═╝╚═╝  ╚═╝${A.reset}`);
  writeln();
  writeln(`  ${A.dim}Browser-first WASI runtime  ·  Open-source WebContainers alternative${A.reset}`);
  writeln();
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

async function main() {
  banner();
  write(`  ${A.dim}Initializing Emmix WASM runtime…${A.reset}`);
  setStatus('loading', 'loading');

  const ok = await loadRunner();
  term.write('\r\x1b[2K');   // clear the "Initializing…" line

  if (ok) {
    writeln(`  ${A.bGreen}✓${A.reset} Runtime ready`);
    setStatus('ready', 'ready');
  } else {
    writeln(`  ${A.bRed}✗ Could not load runtime.${A.reset}`);
    writeln(`    The ${A.bBlue}pkg/${A.reset} directory may not be built.`);
    writeln(`    Run: ${A.bYellow}wasm-pack build --target web${A.reset}`);
    writeln(`    Then refresh this page.`);
    writeln();
    setStatus('error', 'error');
  }

  writeln(`  Type ${A.bGreen}help${A.reset} for commands  ·  drag & drop a ${A.bBlue}.wasm${A.reset} file to load it`);
  writeln();

  repl();
}

main();
