export class EmmixEventBus {
  constructor(options = {}) {
    this.maxEvents = normalizeMaxEvents(options.maxEvents ?? 1000);
    this.listeners = new Set();
    this.events = [];
    this.nextId = 1;
  }

  emit(type, detail = {}, options = {}) {
    const event = {
      id: options.id ?? this.nextId++,
      type,
      time: options.time ?? new Date().toISOString(),
      source: options.source ?? "runtime",
      detail: sanitizeDetail(detail),
    };

    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }

    for (const listener of [...this.listeners]) {
      if (listener.matches(event)) {
        listener.callback(event);
      }
    }

    return event;
  }

  subscribe(typeOrCallback, maybeCallback) {
    const filter = typeof typeOrCallback === "function" ? undefined : typeOrCallback;
    const callback = typeof typeOrCallback === "function" ? typeOrCallback : maybeCallback;

    if (typeof callback !== "function") {
      throw new TypeError("event subscriber must be a function");
    }

    const listener = {
      callback,
      matches: createEventMatcher(filter),
    };
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  list(options = {}) {
    const matches = createEventMatcher(options.type);
    return this.events
      .filter((event) => matches(event))
      .slice(options.sinceId === undefined ? 0 : this.findSinceIndex(options.sinceId))
      .map(cloneEvent);
  }

  export(options = {}) {
    return this.list(options);
  }

  clear() {
    this.events = [];
  }

  findSinceIndex(sinceId) {
    const index = this.events.findIndex((event) => event.id > sinceId);
    return index === -1 ? this.events.length : index;
  }
}

export class EmmixAuditLog {
  constructor(events) {
    this.events = events;
  }

  export(options = {}) {
    return this.events.export(options);
  }

  clear() {
    this.events.clear();
  }
}

function createEventMatcher(filter) {
  if (filter === undefined) {
    return () => true;
  }

  if (typeof filter === "string") {
    return (event) => event.type === filter;
  }

  if (Array.isArray(filter)) {
    const types = new Set(filter);
    return (event) => types.has(event.type);
  }

  if (typeof filter === "function") {
    return filter;
  }

  throw new TypeError("event filter must be a type string, type array, or predicate");
}

function normalizeMaxEvents(value) {
  const number = Number(value);

  if (!Number.isInteger(number) || number < 1) {
    throw new RangeError("event maxEvents must be a positive integer");
  }

  return number;
}

function sanitizeDetail(value) {
  if (value instanceof Uint8Array) {
    return { byteLength: value.byteLength };
  }

  if (value instanceof ArrayBuffer) {
    return { byteLength: value.byteLength };
  }

  if (ArrayBuffer.isView(value)) {
    return { byteLength: value.byteLength };
  }

  if (Array.isArray(value)) {
    return value.map(sanitizeDetail);
  }

  if (value && typeof value === "object") {
    const sanitized = {};

    for (const [key, entry] of Object.entries(value)) {
      sanitized[key] = isSecretKey(key) ? "[redacted]" : sanitizeDetail(entry);
    }

    return sanitized;
  }

  return value;
}

function isSecretKey(key) {
  return /secret|token|password|credential|key/i.test(key);
}

function cloneEvent(event) {
  return {
    id: event.id,
    type: event.type,
    time: event.time,
    source: event.source,
    detail: structuredCloneSafe(event.detail),
  };
}

function structuredCloneSafe(value) {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }

  return JSON.parse(JSON.stringify(value));
}
