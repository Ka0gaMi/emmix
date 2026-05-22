const DEFAULT_ENV = {
  PATH: "/usr/bin:/bin",
  HOME: "/home",
  PWD: "/",
};

export class EmmixShell {
  constructor(process, options = {}) {
    this.process = process;
    this.cwd = normalizePath(options.cwd ?? "/");
    this.env = new Map();

    this.setEnviron(options.environ ?? DEFAULT_ENV);
    this.env.set("PWD", this.cwd);
  }

  get environ() {
    return [...this.env.entries()].map(([name, value]) => `${name}=${value}`);
  }

  setEnviron(environ) {
    this.env.clear();

    if (Array.isArray(environ)) {
      for (const entry of environ) {
        const index = entry.indexOf("=");
        if (index > 0) {
          this.env.set(entry.slice(0, index), entry.slice(index + 1));
        }
      }
      return;
    }

    for (const [name, value] of Object.entries(environ ?? {})) {
      this.env.set(name, String(value));
    }
  }

  getEnv(name) {
    return this.env.get(name);
  }

  setEnv(name, value) {
    assertEnvName(name);
    this.env.set(name, String(value));
  }

  unsetEnv(name) {
    assertEnvName(name);
    this.env.delete(name);
  }

  resolve(path = ".") {
    if (path === "") {
      return this.cwd;
    }

    const base = path.startsWith("/") ? path : `${this.cwd.replace(/\/$/, "")}/${path}`;
    return normalizePath(base);
  }

  pwd() {
    return this.cwd;
  }

  async cd(path = "/") {
    const next = this.resolve(path || "/");
    const stat = await this.process.workspace.stat(next);

    if (stat?.type !== "directory") {
      throw new Error(`${next}: not a directory`);
    }

    this.cwd = next;
    this.env.set("PWD", next);
    return next;
  }

  async readDir(path = ".") {
    return this.process.workspace.readDir(this.resolve(path));
  }

  async stat(path = ".") {
    return this.process.workspace.stat(this.resolve(path));
  }

  async mkdir(path) {
    return this.process.workspace.mkdir(this.resolve(requiredPath(path, "mkdir")));
  }

  async readFile(path) {
    return this.process.workspace.readFile(this.resolve(requiredPath(path, "readFile")));
  }

  async readText(path) {
    return new TextDecoder().decode(await this.readFile(path));
  }

  async writeFile(path, contents) {
    return this.process.workspace.writeFile(this.resolve(requiredPath(path, "writeFile")), contents);
  }

  async writeText(path, contents) {
    return this.writeFile(path, contents);
  }

  async removeFile(path) {
    return this.process.workspace.removeFile(this.resolve(requiredPath(path, "removeFile")));
  }

  async removeDirectory(path) {
    return this.process.workspace.removeDirectory(this.resolve(requiredPath(path, "removeDirectory")));
  }

  async rename(oldPath, newPath) {
    return this.process.workspace.rename(
      this.resolve(requiredPath(oldPath, "rename")),
      this.resolve(requiredPath(newPath, "rename")),
    );
  }

  run(wasmBytes, options = {}) {
    return this.process.run(wasmBytes, this.commandOptions(options));
  }

  exec(wasmBytes, options = {}) {
    return this.process.exec(wasmBytes, this.commandOptions(options));
  }

  spawn(wasmBytes, options = {}) {
    return this.process.spawn(wasmBytes, this.commandOptions(options));
  }

  commandOptions(options = {}) {
    const environ = mergeEnviron(this.environ, options.environ);
    const args = options.args ?? ["sh"];

    return {
      ...options,
      args,
      environ,
      cwd: this.cwd,
    };
  }
}

export function normalizePath(path) {
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

function mergeEnviron(base, overlay) {
  if (overlay === undefined) {
    return base;
  }

  const merged = new Map();

  for (const entry of base) {
    const index = entry.indexOf("=");
    if (index > 0) {
      merged.set(entry.slice(0, index), entry.slice(index + 1));
    }
  }

  const overlayEntries = Array.isArray(overlay)
    ? overlay
    : Object.entries(overlay).map(([name, value]) => `${name}=${value}`);

  for (const entry of overlayEntries) {
    const index = entry.indexOf("=");
    if (index > 0) {
      merged.set(entry.slice(0, index), entry.slice(index + 1));
    }
  }

  return [...merged.entries()].map(([name, value]) => `${name}=${value}`);
}

function assertEnvName(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`invalid environment variable name: ${name}`);
  }
}

function requiredPath(path, operation) {
  if (path === undefined || path === "") {
    throw new Error(`${operation} requires a path`);
  }

  return path;
}
