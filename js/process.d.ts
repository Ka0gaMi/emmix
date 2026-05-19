export interface EmmixProcessOptions {
  workerUrl?: URL | string;
  runtimeWasm?: BufferSource | URL | string;
}

export interface EmmixProcessRunOptions {
  args?: string[];
  environ?: string[];
  stdin?: string | ArrayBuffer | ArrayBufferView;
  runtimeWasm?: BufferSource | URL | string;
  onStdout?: (chunk: Uint8Array) => void;
  onStderr?: (chunk: Uint8Array) => void;
}

export interface EmmixProcessResult {
  pid: number;
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
  missingSyscalls: string[];
}

export type EmmixProcessStatus =
  | "starting"
  | "running"
  | "exited"
  | "cancelled"
  | "failed";

export class EmmixProcess {
  readonly workspace: EmmixProcessWorkspace;
  constructor(options?: EmmixProcessOptions);
  spawn(
    wasmBytes: Uint8Array | ArrayBuffer | ArrayBufferView,
    options?: EmmixProcessRunOptions,
  ): EmmixProcessHandle;
  exec(
    wasmBytes: Uint8Array | ArrayBuffer | ArrayBufferView,
    options?: EmmixProcessRunOptions,
  ): Promise<EmmixProcessResult>;
  run(
    wasmBytes: Uint8Array | ArrayBuffer | ArrayBufferView,
    options?: EmmixProcessRunOptions,
  ): Promise<EmmixProcessResult>;
  get(id: number): EmmixProcessHandle | undefined;
  list(): EmmixProcessHandle[];
  cancel(id?: number): boolean;
  terminate(): void;
}

export class EmmixProcessHandle {
  readonly id: number;
  readonly pid: number;
  status: EmmixProcessStatus;
  readonly startedAt: number;
  finishedAt: number | undefined;
  stdoutChunks: Uint8Array[];
  stderrChunks: Uint8Array[];
  result: Promise<EmmixProcessResult>;
  cancel(): boolean;
}

export interface EmmixProcessWorkspaceStat {
  type: "file" | "directory";
  size: number;
}

export class EmmixProcessWorkspace {
  readFile(path: string): Promise<Uint8Array>;
  readText(path: string): Promise<string>;
  writeFile(path: string, contents: string | ArrayBuffer | ArrayBufferView): Promise<void>;
  writeText(path: string, contents: string): Promise<void>;
  readDir(path?: string): Promise<string[]>;
  mkdir(path: string): Promise<void>;
  removeFile(path: string): Promise<void>;
  removeDirectory(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  stat(path: string): Promise<EmmixProcessWorkspaceStat | undefined>;
}
