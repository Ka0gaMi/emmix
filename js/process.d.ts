export interface EmmixProcessOptions {
  workerUrl?: URL | string;
  runtimeWasm?: BufferSource | URL | string;
  maxProcesses?: number;
  sharedWorkspace?: EmmixSharedWorkspaceStrategy;
  sharedWorkspaceConflict?: EmmixSharedWorkspaceConflictPolicy;
  events?: EmmixEventBusOptions;
  shell?: EmmixShellOptions;
  packages?: EmmixPackageResolverOptions;
  capabilities?: EmmixRuntimeCapabilityOptions;
}

export type EmmixSharedWorkspaceStrategy =
  | "auto"
  | "message-broker"
  | "snapshot"
  | "isolated";

export type EmmixSharedWorkspaceConflictPolicy =
  | "fail"
  | "last-write-wins";

export interface EmmixEvent<TDetail = Record<string, unknown>> {
  id: number;
  type: string;
  time: string;
  source: string;
  detail: TDetail;
}

export type EmmixEventFilter =
  | string
  | string[]
  | ((event: EmmixEvent) => boolean);

export interface EmmixEventBusOptions {
  maxEvents?: number;
}

export interface EmmixEventListOptions {
  type?: EmmixEventFilter;
  sinceId?: number;
}

export class EmmixEventBus {
  constructor(options?: EmmixEventBusOptions);
  emit(type: string, detail?: Record<string, unknown>, options?: {
    id?: number;
    time?: string;
    source?: string;
  }): EmmixEvent;
  subscribe(callback: (event: EmmixEvent) => void): () => void;
  subscribe(type: EmmixEventFilter, callback: (event: EmmixEvent) => void): () => void;
  list(options?: EmmixEventListOptions): EmmixEvent[];
  export(options?: EmmixEventListOptions): EmmixEvent[];
  clear(): void;
}

export class EmmixAuditLog {
  constructor(events: EmmixEventBus);
  export(options?: EmmixEventListOptions): EmmixEvent[];
  clear(): void;
}

export interface EmmixProcessRunOptions {
  args?: string[];
  environ?: string[];
  stdin?: string | ArrayBuffer | ArrayBufferView;
  runtimeWasm?: BufferSource | URL | string;
  timeoutMs?: number;
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
  | "queued"
  | "running"
  | "exited"
  | "cancelled"
  | "failed";

export class EmmixProcess {
  readonly workspace: EmmixProcessWorkspace;
  readonly shell: EmmixShell;
  readonly commands: EmmixCommandRegistry;
  readonly packages: EmmixPackageResolver;
  readonly capabilities: EmmixRuntimeCapabilities;
  readonly events: EmmixEventBus;
  readonly audit: EmmixAuditLog;
  readonly maxProcesses: number;
  readonly sharedWorkspace: Exclude<EmmixSharedWorkspaceStrategy, "auto">;
  readonly sharedWorkspaceConflict: EmmixSharedWorkspaceConflictPolicy;
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
  wait(id: number): Promise<EmmixProcessResult>;
  cancel(id?: number): boolean;
  terminate(): void;
}

export class EmmixProcessHandle {
  readonly id: number;
  readonly pid: number;
  status: EmmixProcessStatus;
  readonly queuedAt: number;
  startedAt: number | undefined;
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

export interface EmmixWorkspaceSnapshotEntry {
  path: string;
  type: "file" | "directory";
  bytes?: Uint8Array;
}

export interface EmmixWorkspaceConflict {
  path: string;
  base?: EmmixWorkspaceSnapshotEntry;
  current?: EmmixWorkspaceSnapshotEntry;
  incoming?: EmmixWorkspaceSnapshotEntry;
}

export interface EmmixWorkspaceTransactionCommitOptions {
  conflict?: EmmixSharedWorkspaceConflictPolicy;
}

export interface EmmixWorkspaceTransactionCommitResult {
  changes: Array<{
    path: string;
    base?: EmmixWorkspaceSnapshotEntry;
    final?: EmmixWorkspaceSnapshotEntry;
  }>;
  conflicts: EmmixWorkspaceConflict[];
}

export class EmmixWorkspaceConflictError extends Error {
  readonly name: "EmmixWorkspaceConflictError";
  readonly conflicts: EmmixWorkspaceConflict[];
  constructor(conflicts: EmmixWorkspaceConflict[]);
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
  beginTransaction(): EmmixWorkspaceTransaction;
}

export class EmmixWorkspaceTransaction {
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
  snapshot(): EmmixWorkspaceSnapshotEntry[];
  commit(
    options?: EmmixWorkspaceTransactionCommitOptions,
  ): Promise<EmmixWorkspaceTransactionCommitResult>;
  rollback(): void;
}

export interface EmmixShellOptions {
  cwd?: string;
  environ?: string[] | Record<string, string>;
}

export class EmmixShell {
  cwd: string;
  readonly environ: string[];
  constructor(process: EmmixProcess, options?: EmmixShellOptions);
  setEnviron(environ: string[] | Record<string, string>): void;
  getEnv(name: string): string | undefined;
  setEnv(name: string, value: string): void;
  unsetEnv(name: string): void;
  resolve(path?: string): string;
  pwd(): string;
  cd(path?: string): Promise<string>;
  readDir(path?: string): Promise<string[]>;
  stat(path?: string): Promise<EmmixProcessWorkspaceStat | undefined>;
  mkdir(path: string): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  readText(path: string): Promise<string>;
  writeFile(path: string, contents: string | ArrayBuffer | ArrayBufferView): Promise<void>;
  writeText(path: string, contents: string): Promise<void>;
  removeFile(path: string): Promise<void>;
  removeDirectory(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  run(
    wasmBytes: Uint8Array | ArrayBuffer | ArrayBufferView,
    options?: EmmixProcessRunOptions,
  ): Promise<EmmixProcessResult>;
  exec(
    wasmBytes: Uint8Array | ArrayBuffer | ArrayBufferView,
    options?: EmmixProcessRunOptions,
  ): Promise<EmmixProcessResult>;
  spawn(
    wasmBytes: Uint8Array | ArrayBuffer | ArrayBufferView,
    options?: EmmixProcessRunOptions,
  ): EmmixProcessHandle;
  commandOptions(options?: EmmixProcessRunOptions): EmmixProcessRunOptions & { cwd: string };
}

export interface EmmixCommand {
  name: string;
  kind: "builtin" | "wasi";
  description?: string;
  usage?: string;
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
    handler: (context: {
      argv: string[];
      args: string[];
      command: EmmixCommand;
      registry: EmmixCommandRegistry;
      shell: EmmixShell;
      process: EmmixProcess;
    }) => unknown | Promise<unknown>,
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

export type EmmixRuntimeEnvironment =
  | "browser"
  | "worker"
  | "node"
  | "unknown";

export type EmmixProcessStrategy =
  | "node-worker"
  | "module-worker"
  | "classic-worker"
  | "main-thread";

export interface EmmixRuntimeCapabilityFeatures {
  webAssembly: boolean;
  wasmCompileStreaming: boolean;
  classicWorker: boolean;
  moduleWorker: boolean;
  sharedWorker: boolean;
  sharedArrayBuffer: boolean;
  atomicsWait: boolean;
  crossOriginIsolated: boolean;
  nodeWorkerThreads: boolean;
}

export interface EmmixRuntimeCapabilityDiagnostic {
  level: "info" | "warning" | "error";
  code: string;
  message: string;
}

export interface EmmixRuntimeCapabilities {
  environment: EmmixRuntimeEnvironment;
  features: EmmixRuntimeCapabilityFeatures;
  blocking: boolean;
  recommendedProcessStrategy: EmmixProcessStrategy;
  diagnostics: EmmixRuntimeCapabilityDiagnostic[];
}

export interface EmmixRuntimeCapabilityOptions {
  globalThis?: typeof globalThis;
  environment?: EmmixRuntimeEnvironment;
  moduleWorker?: boolean;
  nodeWorkerThreads?: boolean;
}
