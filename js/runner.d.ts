import type { EmmixRuntime, InitInput } from "../pkg/emmix.js";

export interface EmmixRunnerOptions {
  args?: string[];
  environ?: string[];
  stdin?: string | ArrayBuffer | ArrayBufferView;
  runtimeWasm?: InitInput;
  imports?: WebAssembly.Imports;
  onStdout?: (chunk: Uint8Array) => void;
  onStderr?: (chunk: Uint8Array) => void;
}

export interface EmmixRunResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
  missingSyscalls: string[];
  instance: WebAssembly.Instance | undefined;
  runtime: EmmixRuntime;
}

export class EmmixProcessExit extends Error {
  readonly code: number;
  constructor(code: number);
}

export class EmmixRunner {
  readonly runtime: EmmixRuntime;
  readonly workspace: EmmixWorkspace;
  instance: WebAssembly.Instance | undefined;
  module: WebAssembly.Module | undefined;
  memory: WebAssembly.Memory | undefined;

  constructor(options?: EmmixRunnerOptions);
  configure(options?: EmmixRunnerOptions): void;
  imports(extraImports?: WebAssembly.Imports): WebAssembly.Imports;
  instantiate(
    moduleInput:
      | WebAssembly.Module
      | BufferSource
      | Response
      | URL
      | Request
      | string,
    extraImports?: WebAssembly.Imports,
  ): Promise<WebAssembly.Instance>;
  run(
    moduleInput:
      | WebAssembly.Module
      | BufferSource
      | Response
      | URL
      | Request
      | string,
    extraImports?: WebAssembly.Imports,
    options?: EmmixRunnerOptions,
  ): Promise<EmmixRunResult>;
  result(exitCode: number): EmmixRunResult;
  flushOutput(): void;
  wasiImports(): WebAssembly.ModuleImports;
  call(callback: (runtime: EmmixRuntime) => number): number;
}

export interface EmmixWorkspaceStat {
  type: "file" | "directory";
  size: number;
}

export class EmmixWorkspace {
  readFile(path: string): Uint8Array;
  readText(path: string): string;
  writeFile(path: string, contents: string | ArrayBuffer | ArrayBufferView): void;
  writeText(path: string, contents: string): void;
  readDir(path?: string): string[];
  mkdir(path: string): void;
  removeFile(path: string): void;
  removeDirectory(path: string): void;
  rename(oldPath: string, newPath: string): void;
  stat(path: string): EmmixWorkspaceStat | undefined;
}

export function createEmmixRunner(options?: EmmixRunnerOptions): Promise<EmmixRunner>;

export function runWasiModule(
  moduleInput:
    | WebAssembly.Module
    | BufferSource
    | Response
    | URL
    | Request
    | string,
  options?: EmmixRunnerOptions,
): Promise<EmmixRunResult>;
