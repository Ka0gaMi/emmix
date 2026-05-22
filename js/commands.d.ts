import type {
  EmmixProcess,
  EmmixProcessRunOptions,
  EmmixShell,
} from "./process.js";

export interface EmmixCommand {
  name: string;
  kind: "builtin" | "wasi";
  description?: string;
  usage?: string;
}

export interface EmmixCommandContext {
  argv: string[];
  args: string[];
  command: EmmixCommand;
  registry: EmmixCommandRegistry;
  shell: EmmixShell;
  process: EmmixProcess;
}

export interface EmmixCommandResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
  result?: unknown;
}

export class EmmixCommandRegistry {
  constructor(shell: EmmixShell);
  registerBuiltin(
    name: string,
    handler: (context: EmmixCommandContext) => unknown | Promise<unknown>,
    metadata?: Omit<Partial<EmmixCommand>, "name" | "kind">,
  ): EmmixCommand;
  registerWasi(
    name: string,
    wasmBytes: Uint8Array | ArrayBuffer | ArrayBufferView,
    options?: EmmixProcessRunOptions,
    metadata?: Omit<Partial<EmmixCommand>, "name" | "kind">,
  ): EmmixCommand;
  register(command: EmmixCommand): EmmixCommand;
  unregister(name: string): boolean;
  resolve(name: string): EmmixCommand | undefined;
  has(name: string): boolean;
  list(): EmmixCommand[];
  execute(input: string | string[], context?: object): Promise<EmmixCommandResult>;
}

export function registerDefaultBuiltins(registry: EmmixCommandRegistry): EmmixCommandRegistry;
export function createDefaultCommandRegistry(shell: EmmixShell): EmmixCommandRegistry;
export function commandResult(result?: Partial<EmmixCommandResult>): EmmixCommandResult;
export function splitCommandLine(input: string): string[];
