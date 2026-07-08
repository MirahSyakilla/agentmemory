export interface StateKVBackend {
  readonly name: string;
  handles(scope: string): boolean;
  get<T = unknown>(scope: string, key: string): Promise<T | null>;
  set<T = unknown>(scope: string, key: string, value: T): Promise<T>;
  update<T = unknown>(
    scope: string,
    key: string,
    ops: Array<{ type: string; path: string; value?: unknown }>,
  ): Promise<T>;
  delete(scope: string, key: string): Promise<void>;
  list<T = unknown>(scope: string): Promise<T[]>;
}

export function applyJsonUpdate<T>(
  current: T | null,
  ops: Array<{ type: string; path: string; value?: unknown }>,
): T {
  const root: unknown =
    current && typeof current === "object"
      ? Array.isArray(current)
        ? [...current]
        : { ...(current as Record<string, unknown>) }
      : {};
  for (const op of ops) {
    if (op.type !== "set") continue;
    const parts = op.path
      .replace(/^\//, "")
      .split(/[/.]/)
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length === 0) continue;
    let cursor = root as Record<string, unknown>;
    for (const part of parts.slice(0, -1)) {
      const next = cursor[part];
      if (!next || typeof next !== "object" || Array.isArray(next)) {
        cursor[part] = {};
      }
      cursor = cursor[part] as Record<string, unknown>;
    }
    cursor[parts[parts.length - 1]] = op.value;
  }
  return root as T;
}
