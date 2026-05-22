import type {
  EmmixCommand,
  EmmixCommandRegistry,
  EmmixProcessRunOptions,
} from "./process.js";

export interface EmmixPackageCommand {
  name: string;
  kind?: "wasi";
  wasmBytes?: Uint8Array | ArrayBuffer | ArrayBufferView;
  options?: EmmixProcessRunOptions;
  description?: string;
  usage?: string;
}

export interface EmmixPackageManifest {
  name: string;
  version?: string;
  registry?: string;
  commands?: EmmixPackageCommand[];
  [key: string]: unknown;
}

export interface EmmixPackageResolverOptions {
  policy?: {
    network?: boolean;
  };
  packages?: EmmixPackageManifest[];
}

export interface EmmixParsedPackageSpec {
  name: string;
  version?: string;
}

export class EmmixPackageResolver {
  constructor(options?: EmmixPackageResolverOptions);
  addPackage(manifest: EmmixPackageManifest): EmmixPackageManifest;
  removePackage(name: string, version?: string): boolean;
  list(): EmmixPackageManifest[];
  addRegistry(
    name: string,
    resolver: (
      spec: EmmixParsedPackageSpec,
      options?: object,
    ) => EmmixPackageManifest | undefined | null | Promise<EmmixPackageManifest | undefined | null>,
  ): void;
  resolve(spec: string, options?: object): Promise<EmmixPackageManifest>;
  resolveLocal(name: string, version?: string): EmmixPackageManifest | undefined;
  install(
    spec: string,
    commandRegistry: EmmixCommandRegistry,
    options?: object,
  ): Promise<{
    manifest: EmmixPackageManifest;
    commands: EmmixCommand[];
  }>;
}

export function createPackageResolver(options?: EmmixPackageResolverOptions): EmmixPackageResolver;
export function parsePackageSpec(spec: string): EmmixParsedPackageSpec;
