export class EmmixCommandRegistry {
  constructor(shell) {
    this.shell = shell;
    this.commands = new Map();
  }

  registerBuiltin(name, handler, metadata = {}) {
    return this.register({
      ...metadata,
      name,
      kind: "builtin",
      handler,
    });
  }

  registerWasi(name, wasmBytes, options = {}, metadata = {}) {
    return this.register({
      ...metadata,
      name,
      kind: "wasi",
      wasmBytes,
      options,
    });
  }

  register(command) {
    validateCommandName(command.name);
    this.commands.set(command.name, command);
    return command;
  }

  unregister(name) {
    return this.commands.delete(name);
  }

  resolve(name) {
    return this.commands.get(name);
  }

  has(name) {
    return this.commands.has(name);
  }

  list() {
    return [...this.commands.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async execute(input, context = {}) {
    const argv = Array.isArray(input) ? input : splitCommandLine(input);

    if (argv.length === 0) {
      return commandResult();
    }

    const [name, ...args] = argv;
    const command = this.resolve(name);

    if (command === undefined) {
      return commandResult({
        exitCode: 127,
        stderr: `${name}: command not found\n`,
      });
    }

    if (command.kind === "builtin") {
      const value = await command.handler({
        ...context,
        argv,
        args,
        command,
        registry: this,
        shell: this.shell,
        process: this.shell.process,
      });
      return normalizeCommandResult(value);
    }

    if (command.kind === "wasi") {
      const result = await this.shell.run(command.wasmBytes, {
        ...(command.options ?? {}),
        ...(context.options ?? {}),
        args: [name, ...args],
      });

      return commandResult({
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        result,
      });
    }

    return commandResult({
      exitCode: 126,
      stderr: `${name}: unsupported command kind ${command.kind}\n`,
    });
  }
}

export function registerDefaultBuiltins(registry) {
  registry.registerBuiltin("pwd", ({ shell }) => `${shell.pwd()}\n`, {
    description: "Print working directory",
  });

  registry.registerBuiltin("cd", async ({ shell, args }) => {
    await shell.cd(args[0] ?? "/");
  }, {
    description: "Change working directory",
    usage: "cd <path>",
  });

  registry.registerBuiltin("ls", async ({ shell, args }) => {
    const path = args[0] ?? ".";
    const abs = shell.resolve(path);
    const names = await shell.readDir(path);
    const lines = [];

    for (const name of names) {
      const fullPath = (abs === "/" ? "" : abs) + "/" + name;
      const info = await shell.process.workspace.stat(fullPath);
      lines.push(info?.type === "directory" ? `${name}/` : name);
    }

    return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
  }, {
    description: "List directory contents",
    usage: "ls [path]",
  });

  registry.registerBuiltin("mkdir", async ({ shell, args }) => {
    requireArg(args, "mkdir <path>");
    await shell.mkdir(args[0]);
  }, {
    description: "Create directory",
    usage: "mkdir <path>",
  });

  registry.registerBuiltin("touch", async ({ shell, args }) => {
    requireArg(args, "touch <path>");
    await shell.writeFile(args[0], new Uint8Array(0));
  }, {
    description: "Create empty file",
    usage: "touch <path>",
  });

  registry.registerBuiltin("write", async ({ shell, args }) => {
    requireArg(args, "write <path> <text>");
    if (args.length < 2) {
      throw new Error("usage: write <path> <text>");
    }
    await shell.writeText(args[0], args.slice(1).join(" "));
  }, {
    description: "Write text to file",
    usage: "write <path> <text>",
  });

  registry.registerBuiltin("cat", async ({ shell, args }) => {
    requireArg(args, "cat <path>");
    return shell.readText(args[0]);
  }, {
    description: "Print file contents",
    usage: "cat <path>",
  });

  registry.registerBuiltin("rm", async ({ shell, args }) => {
    requireArg(args, "rm <path>");
    await shell.removeFile(args[0]);
  }, {
    description: "Remove file",
    usage: "rm <path>",
  });

  registry.registerBuiltin("rmdir", async ({ shell, args }) => {
    requireArg(args, "rmdir <path>");
    await shell.removeDirectory(args[0]);
  }, {
    description: "Remove empty directory",
    usage: "rmdir <path>",
  });

  registry.registerBuiltin("env", ({ shell }) => {
    const environ = shell.environ;
    return environ.length === 0 ? "" : `${environ.join("\n")}\n`;
  }, {
    description: "Print environment",
  });

  return registry;
}

export function createDefaultCommandRegistry(shell) {
  return registerDefaultBuiltins(new EmmixCommandRegistry(shell));
}

export function commandResult({
  exitCode = 0,
  stdout = "",
  stderr = "",
  result,
} = {}) {
  return {
    exitCode,
    stdout: toUint8Array(stdout),
    stderr: toUint8Array(stderr),
    result,
  };
}

export function splitCommandLine(input) {
  const args = [];
  let current = "";
  let quote = null;
  let escaped = false;

  for (const char of String(input)) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (quote !== null) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === " " || char === "\t" || char === "\n") {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaped) {
    current += "\\";
  }

  if (quote !== null) {
    throw new Error(`unterminated ${quote} quote`);
  }

  if (current.length > 0) {
    args.push(current);
  }

  return args;
}

function normalizeCommandResult(value) {
  if (value === undefined) {
    return commandResult();
  }

  if (typeof value === "string" || value instanceof Uint8Array || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return commandResult({ stdout: value });
  }

  return commandResult(value);
}

function requireArg(args, usage) {
  if (args.length === 0) {
    throw new Error(`usage: ${usage}`);
  }
}

function validateCommandName(name) {
  if (!/^[A-Za-z0-9._+-]+$/.test(name)) {
    throw new Error(`invalid command name: ${name}`);
  }
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) {
    return value;
  }

  if (typeof value === "string") {
    return new TextEncoder().encode(value);
  }

  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }

  throw new TypeError("expected command output as string, ArrayBuffer, or typed array");
}
