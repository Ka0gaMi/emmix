export interface EmmixProcessOptions {
  workerUrl?: URL | string;
}

export interface EmmixProcessRunOptions {
  args?: string[];
  environ?: string[];
  stdin?: string | ArrayBuffer | ArrayBufferView;
  runtimeWasm?: BufferSource;
  onStdout?: (chunk: Uint8Array) => void;
  onStderr?: (chunk: Uint8Array) => void;
}

export interface EmmixProcessResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

export class EmmixProcess {
  constructor(options?: EmmixProcessOptions);
  run(
    wasmBytes: Uint8Array | ArrayBuffer | ArrayBufferView,
    options?: EmmixProcessRunOptions,
  ): Promise<EmmixProcessResult>;
  cancel(): boolean;
  terminate(): void;
}
