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
