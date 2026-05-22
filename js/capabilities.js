export function detectRuntimeCapabilities(options = {}) {
  const scope = options.globalThis ?? globalThis;
  const features = {
    webAssembly: typeof scope.WebAssembly === "object",
    wasmCompileStreaming: typeof scope.WebAssembly?.compileStreaming === "function",
    classicWorker: typeof scope.Worker === "function",
    moduleWorker: detectModuleWorker(scope, options),
    sharedWorker: typeof scope.SharedWorker === "function",
    sharedArrayBuffer: typeof scope.SharedArrayBuffer === "function",
    atomicsWait: typeof scope.Atomics?.wait === "function",
    crossOriginIsolated: scope.crossOriginIsolated === true,
    nodeWorkerThreads: options.nodeWorkerThreads === true,
  };
  const environment = detectEnvironment(scope, options);
  const blocking = features.sharedArrayBuffer &&
    features.atomicsWait &&
    (features.crossOriginIsolated || features.nodeWorkerThreads);
  const recommendedProcessStrategy = recommendProcessStrategy(features);
  const diagnostics = diagnosticsFor(features, recommendedProcessStrategy, blocking);

  return {
    environment,
    features,
    blocking,
    recommendedProcessStrategy,
    diagnostics,
  };
}

export function recommendProcessStrategy(features) {
  if (features.nodeWorkerThreads) {
    return "node-worker";
  }

  if (features.moduleWorker) {
    return "module-worker";
  }

  if (features.classicWorker) {
    return "classic-worker";
  }

  return "main-thread";
}

function detectEnvironment(scope, options) {
  if (options.environment !== undefined) {
    return options.environment;
  }

  if (options.nodeWorkerThreads === true) {
    return "node";
  }

  if (typeof scope.window === "object" && scope.window === scope) {
    return "browser";
  }

  if (typeof scope.WorkerGlobalScope === "function" && scope instanceof scope.WorkerGlobalScope) {
    return "worker";
  }

  if (typeof globalThis.process === "object" && globalThis.process?.versions?.node) {
    return "node";
  }

  return "unknown";
}

function detectModuleWorker(scope, options) {
  if (options.moduleWorker !== undefined) {
    return options.moduleWorker;
  }

  if (typeof scope.Worker !== "function") {
    return false;
  }

  if (typeof scope.Blob !== "function" || typeof scope.URL?.createObjectURL !== "function") {
    return false;
  }

  let url;
  let worker;

  try {
    url = scope.URL.createObjectURL(
      new scope.Blob([""], { type: "text/javascript" }),
    );
    worker = new scope.Worker(url, { type: "module" });
    return true;
  } catch {
    return false;
  } finally {
    worker?.terminate?.();
    if (url !== undefined) {
      scope.URL.revokeObjectURL?.(url);
    }
  }
}

function diagnosticsFor(features, recommendedProcessStrategy, blocking) {
  const diagnostics = [];

  if (!features.webAssembly) {
    diagnostics.push({
      level: "error",
      code: "webassembly-unavailable",
      message: "WebAssembly is not available in this environment.",
    });
  }

  if (recommendedProcessStrategy === "main-thread") {
    diagnostics.push({
      level: "warning",
      code: "worker-unavailable",
      message: "No worker implementation was detected; guest execution would run on the main thread.",
    });
  }

  if (!blocking) {
    diagnostics.push({
      level: "info",
      code: "sab-blocking-unavailable",
      message: "SharedArrayBuffer blocking is unavailable; use message-based or cooperative process behavior.",
    });
  }

  if (features.sharedArrayBuffer && !features.crossOriginIsolated && !features.nodeWorkerThreads) {
    diagnostics.push({
      level: "info",
      code: "cross-origin-isolation-missing",
      message: "SharedArrayBuffer exists, but cross-origin isolation is not enabled.",
    });
  }

  return diagnostics;
}
