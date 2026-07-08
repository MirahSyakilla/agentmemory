import type { ISdk } from 'iii-sdk'
import type { StateKVBackend } from './backend-kv.js'

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
}
