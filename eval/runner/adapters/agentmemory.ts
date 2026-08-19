import { createHash } from "node:crypto";
import type { Adapter, RankedDoc, Session } from "../types.js";

interface AgentMemoryState {
  baseUrl: string;
  secret?: string;
  project?: string;
  agentId?: string;
  sessions: Session[];
  observationToSession: Map<string, string>;
  memoryIds: string[];
}

interface RememberResponse {
  memory?: { id?: string };
  observationId?: string;
  id?: string;
  observation?: { id?: string };
}

interface SmartSearchResponse {
  results?: Array<{
    obsId?: string;
    id?: string;
    observationId?: string;
    sessionId?: string;
    score?: number;
    content?: string;
  }>;
  observations?: Array<{
    obsId?: string;
    id?: string;
    sessionId?: string;
    score?: number;
    content?: string;
  }>;
}

function authHeaders(secret?: string): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (secret) h.Authorization = `Bearer ${secret}`;
  return h;
}

function scopeForKey(value: unknown): { project?: string; agentId?: string } {
  if (typeof value !== "string" || !value.trim()) return {};
  const digest = createHash("sha256").update(value.trim()).digest("hex").slice(0, 16);
  const scope = `eval-${digest}`;
  return { project: scope, agentId: scope };
}

export const agentmemoryAdapter: Adapter<AgentMemoryState> = {
  name: "agentmemory-hybrid",
  async init(sessions, config) {
    const baseUrl = (config?.baseUrl as string) ?? process.env.AGENTMEMORY_BASE_URL ?? "http://localhost:3111";
    const secret = (config?.secret as string) ?? process.env.AGENTMEMORY_SECRET;
    const scope = scopeForKey(config?.scopeKey);
    const observationToSession = new Map<string, string>();
    const memoryIds: string[] = [];
    for (const s of sessions) {
      // LongMemEval contains empty non-gold distractor sessions. They have no
      // retrievable signal and /remember rightly rejects blank content.
      if (!s.content.trim()) continue;
      const res = await fetch(`${baseUrl}/agentmemory/remember`, {
        method: "POST",
        headers: authHeaders(secret),
        body: JSON.stringify({
          content: s.content,
          type: "eval-session",
          concepts: [s.id],
          ...(scope.project ? { project: scope.project } : {}),
          ...(scope.agentId ? { agentId: scope.agentId } : {}),
        }),
      });
      if (!res.ok) {
        throw new Error(`remember failed for ${s.id}: ${res.status} ${await res.text()}`);
      }
      const body = (await res.json()) as RememberResponse;
      const obsId =
        body.memory?.id ?? body.observationId ?? body.id ?? body.observation?.id;
      if (!obsId) {
        throw new Error(`remember response missing memory id for ${s.id}`);
      }
      observationToSession.set(obsId, s.id);
      memoryIds.push(obsId);
    }
    return {
      baseUrl,
      secret,
      ...scope,
      sessions,
      observationToSession,
      memoryIds,
    };
  },
  async query(q, state, k) {
    const res = await fetch(`${state.baseUrl}/agentmemory/smart-search`, {
      method: "POST",
      headers: authHeaders(state.secret),
      body: JSON.stringify({
        query: q,
        limit: Math.max(k * 10, 50),
        ...(state.project ? { project: state.project } : {}),
        ...(state.agentId ? { agentId: state.agentId } : {}),
        ...(state.project || state.agentId ? { includeLessons: false } : {}),
      }),
    });
    if (!res.ok) {
      throw new Error(`smart-search failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as SmartSearchResponse;
    const rows = body.results ?? body.observations ?? [];
    const ranked: RankedDoc[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const memId = row.obsId ?? row.id ?? row.observationId;
      // The eval ingests sessions as memories via /remember, so the
      // obsId->session map built in init() is authoritative. Server
      // sessionId values like the literal "memory" bucket must not
      // short-circuit it.
      let sessionId = memId ? state.observationToSession.get(memId) : undefined;
      if (!sessionId && row.sessionId && row.sessionId !== "memory") {
        sessionId = row.sessionId;
      }
      if (!sessionId || seen.has(sessionId)) continue;
      seen.add(sessionId);
      ranked.push({ sessionId, score: row.score ?? 0 });
      if (ranked.length >= k) break;
    }
    return ranked;
  },
  async teardown(state) {
    // LongMemEval initializes a fresh corpus for each question. Removing its
    // own rows prevents later questions from competing against earlier
    // haystacks in the shared lexical/vector indexes.
    for (let i = 0; i < state.memoryIds.length; i += 8) {
      await Promise.all(
        state.memoryIds.slice(i, i + 8).map(async (memoryId) => {
          const res = await fetch(`${state.baseUrl}/agentmemory/forget`, {
            method: "POST",
            headers: authHeaders(state.secret),
            body: JSON.stringify({ memoryId }),
          });
          if (!res.ok) {
            throw new Error(
              `forget failed for ${memoryId}: ${res.status} ${await res.text()}`,
            );
          }
        }),
      );
    }
  },
};
