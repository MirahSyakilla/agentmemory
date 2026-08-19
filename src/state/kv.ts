import type { ISdk } from 'iii-sdk'
import type {
  StateKVBackend,
  StateKVClaimResult,
  StateKVGraphNeighborhood,
  StateKVGraphNodePage,
  StateKVGraphObservationIndexEntry,
  StateKVGraphQueryOptions,
  StateKVJsonAggregateRequest,
  StateKVJsonAggregateResult,
  StateKVJsonFilter,
} from './backend-kv.js'
import type { GraphNode } from '../types.js'
import { KV } from './schema.js'

function matchesJsonFilter(
  value: unknown,
  filter: StateKVJsonFilter,
): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const hasField = Object.prototype.hasOwnProperty.call(record, filter.field)
  if (filter.operator === 'exists') return hasField
  if (filter.operator === 'equals_or_missing') {
    return !hasField || record[filter.field] === filter.value
  }
  if (filter.operator === 'equals') return record[filter.field] === filter.value
  return record[filter.field] !== filter.value
}

function aggregateValues(
  values: unknown[],
  request: StateKVJsonAggregateRequest,
): StateKVJsonAggregateResult {
  const stringSets = new Map<string, Set<string>>(
    (request.collectStringFields ?? []).map((field) => [field, new Set()]),
  )
  let count = 0
  let serializedChars = 0
  for (const value of values) {
    if (!(request.filters ?? []).every((filter) => matchesJsonFilter(value, filter))) {
      continue
    }
    count++
    serializedChars += JSON.stringify(value)?.length ?? 0
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const record = value as Record<string, unknown>
    for (const [field, valuesForField] of stringSets) {
      if (typeof record[field] === 'string' && record[field]) {
        valuesForField.add(record[field])
      }
    }
  }
  return {
    count,
    serializedChars,
    stringValues: Object.fromEntries(
      [...stringSets].map(([field, valuesForField]) => [
        field,
        [...valuesForField],
      ]),
    ),
  }
}

function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason
  const error = new Error("state operation aborted")
  error.name = "AbortError"
  return error
}

function awaitWithinDeadline<T>(
  work: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      callback()
    }
    const onAbort = () => finish(() => reject(abortError(signal)))
    const timer = setTimeout(
      () => finish(() => reject(new Error(`state list timed out after ${timeoutMs}ms`))),
      timeoutMs,
    )

    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    work.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    )
  })
}

export class StateKV {
  constructor(
    private sdk: ISdk,
    private backends: StateKVBackend[] = [],
  ) {}

  private backend(scope: string): StateKVBackend | undefined {
    return this.backends.find((b) => b.handles(scope));
  }

  async get<T = unknown>(scope: string, key: string): Promise<T | null> {
    const backend = this.backend(scope);
    if (backend) return backend.get<T>(scope, key);
    return this.sdk.trigger<{ scope: string; key: string }, T | null>({
      function_id: 'state::get',
      payload: { scope, key },
    })
  }

  async set<T = unknown>(scope: string, key: string, value: T): Promise<T> {
    const backend = this.backend(scope);
    if (backend) return backend.set<T>(scope, key, value);
    return this.sdk.trigger<{ scope: string; key: string; value: T }, T>({
      function_id: 'state::set',
      payload: { scope, key, value },
    })
  }

  async claim<T = unknown>(
    scope: string,
    key: string,
    value: T,
  ): Promise<StateKVClaimResult<T>> {
    const backend = this.backend(scope);
    if (!backend?.claim) {
      throw new Error(
        `Atomic KV claims are unavailable for scope "${scope}"`,
      );
    }
    return backend.claim<T>(scope, key, value);
  }

  async update<T = unknown>(
    scope: string,
    key: string,
    ops: Array<{ type: string; path: string; value?: unknown }>,
  ): Promise<T> {
    const backend = this.backend(scope);
    if (backend) return backend.update<T>(scope, key, ops);
    return this.sdk.trigger<
      { scope: string; key: string; ops: Array<{ type: string; path: string; value?: unknown }> },
      T
    >({
      function_id: 'state::update',
      payload: { scope, key, ops },
    })
  }

  async delete(scope: string, key: string): Promise<void> {
    const backend = this.backend(scope);
    if (backend) return backend.delete(scope, key);
    return this.sdk.trigger<{ scope: string; key: string }, void>({
      function_id: 'state::delete',
      payload: { scope, key },
    })
  }

  async list<T = unknown>(scope: string): Promise<T[]> {
    const backend = this.backend(scope);
    if (backend) return backend.list<T>(scope);
    return this.sdk.trigger<{ scope: string }, T[]>({
      function_id: 'state::list',
      payload: { scope },
    })
  }

  async listWithTimeout<T = unknown>(
    scope: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T[]> {
    const backend = this.backend(scope);
    if (backend?.listWithTimeout) {
      return backend.listWithTimeout<T>(scope, timeoutMs, signal);
    }
    return awaitWithinDeadline(this.list<T>(scope), timeoutMs, signal)
  }

  async findGraphNodesByNames(
    names: string[],
    limit: number,
    options?: StateKVGraphQueryOptions,
  ): Promise<GraphNode[] | null> {
    const backend = this.backend(KV.graphNodes);
    if (!backend?.findGraphNodesByNames) return null;
    return backend.findGraphNodesByNames(names, limit, options);
  }

  async findGraphNodesByObservationIds(
    observationIds: string[],
    limit: number,
    options?: StateKVGraphQueryOptions,
  ): Promise<GraphNode[] | null> {
    const backend = this.backend(KV.graphNodes);
    if (!backend?.findGraphNodesByObservationIds) return null;
    return backend.findGraphNodesByObservationIds(observationIds, limit, options);
  }

  async getGraphNeighborhood(
    nodeIds: string[],
    maxDepth: number,
    maxNodes: number,
    options?: StateKVGraphQueryOptions,
  ): Promise<StateKVGraphNeighborhood | null> {
    const backend = this.backend(KV.graphNodes);
    if (!backend?.getGraphNeighborhood) return null;
    return backend.getGraphNeighborhood(nodeIds, maxDepth, maxNodes, options);
  }

  async pageGraphNodes(
    afterId: string,
    limit: number,
    options?: StateKVGraphQueryOptions,
  ): Promise<StateKVGraphNodePage | null> {
    const backend = this.backend(KV.graphNodes);
    if (!backend?.pageGraphNodes) return null;
    return backend.pageGraphNodes(afterId, limit, options);
  }

  async mergeGraphObservationIndex(
    entries: StateKVGraphObservationIndexEntry[],
    options?: StateKVGraphQueryOptions,
  ): Promise<boolean> {
    const backend = this.backend(KV.graphNodes);
    if (!backend?.mergeGraphObservationIndex) return false;
    await backend.mergeGraphObservationIndex(entries, options);
    return true;
  }

  async aggregateJson(
    request: StateKVJsonAggregateRequest,
  ): Promise<StateKVJsonAggregateResult> {
    const scopes = [...new Set(request.scopes)]
    if (scopes.length === 0) {
      return {
        count: 0,
        serializedChars: 0,
        stringValues: Object.fromEntries(
          (request.collectStringFields ?? []).map((field) => [field, []]),
        ),
      }
    }

    const backend = this.backend(scopes[0])
    if (
      backend?.aggregateJson &&
      scopes.every((scope) => this.backend(scope) === backend)
    ) {
      return backend.aggregateJson({ ...request, scopes })
    }

    const totals: StateKVJsonAggregateResult = {
      count: 0,
      serializedChars: 0,
      stringValues: Object.fromEntries(
        (request.collectStringFields ?? []).map((field) => [field, []]),
      ),
    }
    const collected = new Map<string, Set<string>>(
      (request.collectStringFields ?? []).map((field) => [field, new Set()]),
    )
    const batchSize = 8
    for (let offset = 0; offset < scopes.length; offset += batchSize) {
      const batches = await Promise.all(
        scopes
          .slice(offset, offset + batchSize)
          .map(async (scope) => aggregateValues(await this.list(scope), request)),
      )
      for (const aggregate of batches) {
        totals.count += aggregate.count
        totals.serializedChars += aggregate.serializedChars
        for (const [field, values] of Object.entries(aggregate.stringValues)) {
          const target = collected.get(field)
          if (!target) continue
          for (const value of values) target.add(value)
        }
      }
    }
    totals.stringValues = Object.fromEntries(
      [...collected].map(([field, values]) => [field, [...values]]),
    )
    return totals
  }
}
