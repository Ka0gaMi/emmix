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

export function detectRuntimeCapabilities(
  options?: EmmixRuntimeCapabilityOptions,
): EmmixRuntimeCapabilities;

export function recommendProcessStrategy(
  features: EmmixRuntimeCapabilityFeatures,
): EmmixProcessStrategy;
