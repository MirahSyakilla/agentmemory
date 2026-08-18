import type { ISdk } from 'iii-sdk'
import type {
  StateKVBackend,
  StateKVJsonAggregateRequest,
  StateKVJsonAggregateResult,
  StateKVJsonFilter,
} from './backend-kv.js'

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
