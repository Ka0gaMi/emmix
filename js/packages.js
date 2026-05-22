export class EmmixPackageResolver {
  constructor(options = {}) {
    this.policy = {
      network: false,
      ...options.policy,
    };
    this.packages = new Map();
    this.registries = new Map();

    for (const manifest of options.packages ?? []) {
      this.addPackage(manifest);
    }
  }

  addPackage(manifest) {
    validateManifest(manifest);
    const normalized = normalizeManifest(manifest);
    this.packages.set(packageKey(normalized.name, normalized.version), normalized);
    return normalized;
  }

  removePackage(name, version) {
    if (version === undefined) {
      let removed = false;
      for (const key of this.packages.keys()) {
        if (key.startsWith(`${name}@`)) {
          this.packages.delete(key);
          removed = true;
        }
      }
      return removed;
    }

    return this.packages.delete(packageKey(name, version));
  }

  list() {
    return [...this.packages.values()].sort((a, b) =>
      a.name === b.name
        ? compareVersions(a.version, b.version)
        : a.name.localeCompare(b.name),
    );
  }

  addRegistry(name, resolver) {
    if (typeof resolver !== "function") {
      throw new TypeError("package registry resolver must be a function");
    }

    this.registries.set(name, resolver);
  }

  async resolve(spec, options = {}) {
    const parsed = parsePackageSpec(spec);
    const local = this.resolveLocal(parsed.name, parsed.version);

    if (local !== undefined) {
      return local;
    }

    if (!(options.network ?? this.policy.network)) {
      throw new Error(`${spec}: package not found in local package cache`);
    }

    for (const [registryName, resolver] of this.registries) {
      const manifest = await resolver(parsed, options);
      if (manifest !== undefined && manifest !== null) {
        const normalized = this.addPackage({
          ...manifest,
          registry: manifest.registry ?? registryName,
        });
        return normalized;
      }
    }

    throw new Error(`${spec}: package not found`);
  }

  resolveLocal(name, version) {
    if (version !== undefined) {
      return this.packages.get(packageKey(name, version));
    }

    const candidates = [...this.packages.values()].filter((manifest) =>
      manifest.name === name,
    );

    if (candidates.length === 0) {
      return undefined;
    }

    return candidates.sort((a, b) => compareVersions(b.version, a.version))[0];
  }

  async install(spec, commandRegistry, options = {}) {
    const manifest = await this.resolve(spec, options);
    const installed = [];

    for (const command of manifest.commands ?? []) {
      if (command.kind !== "wasi") {
        throw new Error(`${manifest.name}: unsupported package command kind ${command.kind}`);
      }

      if (command.wasmBytes === undefined) {
        throw new Error(`${manifest.name}: command ${command.name} has no wasmBytes`);
      }

      installed.push(commandRegistry.registerWasi(
        command.name,
        command.wasmBytes,
        command.options ?? {},
        {
          description: command.description,
          usage: command.usage,
          package: {
            name: manifest.name,
            version: manifest.version,
          },
        },
      ));
    }

    return {
      manifest,
      commands: installed,
    };
  }
}

export function createPackageResolver(options = {}) {
  return new EmmixPackageResolver(options);
}

export function parsePackageSpec(spec) {
  const text = String(spec ?? "").trim();

  if (text.length === 0) {
    throw new Error("package spec cannot be empty");
  }

  if (text.startsWith("@")) {
    const index = text.indexOf("@", 1);
    if (index === -1) {
      return { name: text, version: undefined };
    }
    return {
      name: text.slice(0, index),
      version: text.slice(index + 1) || undefined,
    };
  }

  const index = text.lastIndexOf("@");
  if (index <= 0) {
    return { name: text, version: undefined };
  }

  return {
    name: text.slice(0, index),
    version: text.slice(index + 1) || undefined,
  };
}

function normalizeManifest(manifest) {
  return {
    ...manifest,
    version: manifest.version ?? "0.0.0",
    commands: (manifest.commands ?? []).map((command) => ({
      kind: "wasi",
      ...command,
    })),
  };
}

function validateManifest(manifest) {
  if (manifest === undefined || manifest === null || typeof manifest !== "object") {
    throw new TypeError("package manifest must be an object");
  }

  validatePackageName(manifest.name);

  if (manifest.version !== undefined && typeof manifest.version !== "string") {
    throw new TypeError("package version must be a string");
  }

  if (manifest.commands !== undefined && !Array.isArray(manifest.commands)) {
    throw new TypeError("package commands must be an array");
  }

  for (const command of manifest.commands ?? []) {
    validateCommand(command);
  }
}

function validateCommand(command) {
  if (command === undefined || command === null || typeof command !== "object") {
    throw new TypeError("package command must be an object");
  }

  if (!/^[A-Za-z0-9._+-]+$/.test(command.name)) {
    throw new Error(`invalid package command name: ${command.name}`);
  }
}

function validatePackageName(name) {
  if (typeof name !== "string" || !/^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(`invalid package name: ${name}`);
  }
}

function packageKey(name, version) {
  return `${name}@${version}`;
}

function compareVersions(a, b) {
  return String(a).localeCompare(String(b), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}
