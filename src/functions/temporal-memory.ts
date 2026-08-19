import type { ISdk } from "iii-sdk";
import type {
  Authority,
  EpistemicState as CanonicalEpistemicState,
  KnowledgeLayer,
  Memory,
  MemoryConflict,
  TemporalValidity,
} from "../types.js";
import { KV, generateId } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { safeAudit } from "./audit.js";

export const EPISTEMIC_STATES = [
  "hypothesis",
  "observed",
  "verified",
  "disproven",
  "superseded",
  "uncertain",
] as const;

export type EpistemicState = CanonicalEpistemicState;

export const MEMORY_LAYERS = [
  "knowledge",
  "experience",
  "decision",
  "hypothesis",
  "artifact",
  "procedure",
  "working",
  "episodic",
  "semantic",
  "procedural",
] as const;

export type MemoryLayer = KnowledgeLayer;

export type MemoryTemporalValidity = TemporalValidity & Record<string, unknown>;

export interface MemoryMetadata {
  layer?: MemoryLayer;
  epistemicState?: EpistemicState;
  temporal?: MemoryTemporalValidity;
  authority?: Authority;
  evidenceIds?: string[];
  artifactIds?: string[];
  experimentIds?: string[];
  conflictIds?: string[];
}

export type RichMemory = Memory & MemoryMetadata;

export function validateMemoryOrigin(
  value: unknown,
): { value?: NonNullable<Memory["origin"]>; error?: string } {
  if (value === undefined) return {};
  const origin = asRecord(value);
  if (!origin) return { error: "origin must be an object" };
  const channels = ["user", "agent", "tool", "import", "shared"] as const;
  if (!channels.includes(origin.channel as (typeof channels)[number])) {
    return { error: "origin.channel must be one of: user, agent, tool, import, shared" };
  }
  if (!validDate(origin.capturedAt)) return { error: "origin.capturedAt must be a valid timestamp" };
  if (origin.detail !== undefined && typeof origin.detail !== "string") {
    return { error: "origin.detail must be a string" };
  }
  return {
    value: {
      channel: origin.channel as NonNullable<Memory["origin"]>["channel"],
      capturedAt: origin.capturedAt,
      ...(origin.detail !== undefined ? { detail: origin.detail } : {}),
    },
  };
}

export interface MemoryConflictRecord extends Omit<MemoryConflict, "sourceId" | "targetId" | "detectedBy"> {
  sourceId: string;
  targetId: string;
  memoryAId: string;
  memoryBId: string;
  detectedBy: "relation" | "retrieval" | "manual";
}

type InputRecord = Record<string, unknown>;

function asRecord(value: unknown): InputRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as InputRecord)
    : undefined;
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && Number.isFinite(Date.parse(value));
}

function validateDateFields(
  value: InputRecord,
  fields: string[],
  prefix: string,
): string | undefined {
  for (const field of fields) {
    if (value[field] !== undefined && !validDate(value[field])) {
      return `${prefix}.${field} must be a valid timestamp`;
    }
  }
  return undefined;
}

function validateStringArray(
  value: unknown,
  field: string,
): { value?: string[]; error?: string } {
  if (!Array.isArray(value)) return { error: `${field} must be an array` };
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !item.trim()) {
      return { error: `${field} must contain non-empty strings` };
    }
    const normalized = item.trim();
    if (!result.includes(normalized)) result.push(normalized);
  }
  return { value: result };
}

function validateAuthority(value: unknown): { value?: Authority; error?: string } {
  if (typeof value === "string") {
    return value.trim()
      ? { value: { rationale: value.trim() } }
      : { error: "authority must not be blank" };
  }
  const authority = asRecord(value);
  if (!authority) return { error: "authority must be an object or non-empty string" };

  for (const field of ["kind", "level", "source", "detail", "reason", "rationale"]) {
    if (authority[field] !== undefined && typeof authority[field] !== "string") {
      return { error: `authority.${field} must be a string` };
    }
  }
  for (const field of ["confidence", "weight", "score"]) {
    if (
      authority[field] !== undefined &&
      (typeof authority[field] !== "number" ||
        !Number.isFinite(authority[field]) ||
        authority[field] < 0 ||
        authority[field] > 1)
    ) {
      return { error: `authority.${field} must be a number between 0 and 1` };
    }
  }
  return {
    value: {
      ...(typeof authority.source === "string" ? { source: authority.source as Authority["source"] } : {}),
      ...(typeof authority.kind === "string" ? { kind: authority.kind } : {}),
      ...(typeof authority.score === "number" ? { score: authority.score } : {}),
      ...(typeof authority.confidence === "number" ? { confidence: authority.confidence } : {}),
      ...(typeof authority.weight === "number" ? { weight: authority.weight } : {}),
      ...(typeof authority.level === "string" ? { level: authority.level } : {}),
      ...(typeof authority.detail === "string" ? { detail: authority.detail } : {}),
      ...(typeof authority.rationale === "string"
        ? { rationale: authority.rationale }
        : typeof authority.reason === "string"
          ? { rationale: authority.reason }
          : {}),
      ...(typeof authority.reason === "string" ? { reason: authority.reason } : {}),
    },
  };
}

export function validateEpistemicState(value: unknown): EpistemicState | undefined {
  return EPISTEMIC_STATES.includes(value as EpistemicState)
    ? (value as EpistemicState)
    : undefined;
}

export function validateMemoryMetadata(
  data: InputRecord,
  defaults = false,
): { value?: MemoryMetadata; error?: string } {
  if (
    data.state !== undefined &&
    data.epistemicState !== undefined &&
    data.state !== data.epistemicState
  ) {
    return { error: "state and epistemicState must match when both are provided" };
  }
  const stateInput = data.epistemicState ?? data.state;
  let epistemicState: EpistemicState | undefined;
  if (stateInput !== undefined) {
    epistemicState = validateEpistemicState(stateInput);
    if (!epistemicState) {
      return {
        error: `epistemicState must be one of: ${EPISTEMIC_STATES.join(", ")}`,
      };
    }
  } else if (defaults) {
    epistemicState = "observed";
  }

  let layer: MemoryLayer | undefined;
  if (data.layer !== undefined) {
    layer = MEMORY_LAYERS.includes(data.layer as MemoryLayer)
      ? (data.layer as MemoryLayer)
      : undefined;
    if (!layer) {
      return { error: `layer must be one of: ${MEMORY_LAYERS.join(", ")}` };
    }
  } else if (defaults) {
    layer = "knowledge";
  }

  let temporalInput = data.temporal;
  if (temporalInput === undefined) {
    const flatTemporal: InputRecord = {};
    for (const field of ["observedAt", "validFrom", "validUntil", "validTo", "verifiedAt", "supersededAt"]) {
      if (data[field] !== undefined) flatTemporal[field] = data[field];
    }
    if (Object.keys(flatTemporal).length > 0) temporalInput = flatTemporal;
  }

  let temporal: MemoryTemporalValidity | undefined;
  if (temporalInput !== undefined) {
    const temporalRecord = asRecord(temporalInput);
    if (!temporalRecord) return { error: "temporal must be an object" };
    const dateError = validateDateFields(
      temporalRecord,
      ["observedAt", "validFrom", "validUntil", "validTo", "verifiedAt", "supersededAt"],
      "temporal",
    );
    if (dateError) return { error: dateError };
    const start = temporalRecord.validFrom;
    for (const endField of ["validUntil", "validTo"]) {
      if (start !== undefined && temporalRecord[endField] !== undefined && Date.parse(start as string) > Date.parse(temporalRecord[endField] as string)) {
        return { error: `temporal.validFrom must not be after temporal.${endField}` };
      }
    }
    temporal = { ...temporalRecord };
  }

  let authority: Authority | undefined;
  if (data.authority !== undefined) {
    const validated = validateAuthority(data.authority);
    if (validated.error) return { error: validated.error };
    authority = validated.value;
  }

  const references = asRecord(data.references);
  const metadata: MemoryMetadata = {};
  if (layer !== undefined) metadata.layer = layer;
  if (epistemicState !== undefined) metadata.epistemicState = epistemicState;
  if (temporal !== undefined) metadata.temporal = temporal;
  if (authority !== undefined) metadata.authority = authority;

  for (const field of ["evidenceIds", "artifactIds", "experimentIds", "conflictIds"] as const) {
    const input = data[field] ?? references?.[field];
    if (input === undefined) continue;
    const validated = validateStringArray(input, field);
    if (validated.error) return { error: validated.error };
    metadata[field] = validated.value;
  }

  return { value: metadata };
}

function temporalBounds(memory: RichMemory): { from?: number; to?: number } {
  const temporal = memory.temporal;
  if (!temporal || typeof temporal !== "object") return {};
  const from = validDate(temporal.validFrom) ? Date.parse(temporal.validFrom) : undefined;
  const end = temporal.validUntil ?? temporal.validTo;
  const to = validDate(end) ? Date.parse(end) : undefined;
  return { from, to };
}

function isCurrent(memory: RichMemory, timestamp: number): boolean {
  const bounds = temporalBounds(memory);
  return (bounds.from === undefined || bounds.from <= timestamp) &&
    (bounds.to === undefined || bounds.to >= timestamp);
}

function containsAt(memory: RichMemory, timestamp: number): boolean {
  return isCurrent(memory, timestamp);
}

function overlapsRange(memory: RichMemory, from: number, to: number): boolean {
  const bounds = temporalBounds(memory);
  return (bounds.to === undefined || bounds.to >= from) &&
    (bounds.from === undefined || bounds.from <= to);
}

function validateQueryDate(value: unknown, field: string): { value?: number; error?: string } {
  if (value === undefined) return {};
  if (!validDate(value)) return { error: `${field} must be a valid timestamp` };
  return { value: Date.parse(value) };
}

export async function queryTemporalMemories(
  kv: StateKV,
  input: unknown,
): Promise<Record<string, unknown>> {
  const data = asRecord(input) ?? {};
  const scope = asRecord(data.scope);
  const projectInput = data.project ?? scope?.project;
  const agentInput = data.agentId ?? scope?.agentId;
  for (const field of ["project", "agentId"] as const) {
    const value = field === "project" ? projectInput : agentInput;
    if (value !== undefined && (typeof value !== "string" || !value.trim())) {
      return { success: false, error: `${field} must be a non-empty string when provided` };
    }
  }

  const modeInput = data.mode;
  if (modeInput !== undefined && !["current", "asOf", "range"].includes(modeInput as string)) {
    return { success: false, error: "mode must be current, asOf, or range" };
  }
  const range = asRecord(data.range);
  const asOf = validateQueryDate(data.asOf, "asOf");
  const from = validateQueryDate(data.from ?? range?.from, "from");
  const to = validateQueryDate(data.to ?? range?.to, "to");
  if (asOf.error || from.error || to.error) {
    return { success: false, error: asOf.error ?? from.error ?? to.error };
  }
  if (from.value !== undefined && to.value !== undefined && from.value > to.value) {
    return { success: false, error: "from must not be after to" };
  }
  if (asOf.value !== undefined && (from.value !== undefined || to.value !== undefined)) {
    return { success: false, error: "asOf cannot be combined with from or to" };
  }

  const mode = asOf.value !== undefined
    ? "asOf"
    : from.value !== undefined || to.value !== undefined || modeInput === "range"
      ? "range"
      : modeInput === "asOf"
        ? "asOf"
        : "current";
  if (mode === "asOf" && asOf.value === undefined) {
    return { success: false, error: "asOf is required for asOf mode" };
  }
  if (mode === "range" && from.value === undefined && to.value === undefined) {
    return { success: false, error: "from or to is required for range mode" };
  }

  const id = typeof data.id === "string" && data.id.trim() ? data.id.trim() : undefined;
  const project = typeof projectInput === "string" ? projectInput.trim() : undefined;
  const agentId = typeof agentInput === "string" ? agentInput.trim() : undefined;
  const includeHistory = data.includeHistory === true || mode !== "current";
  const now = Date.now();
  const rangeFrom = from.value ?? Number.NEGATIVE_INFINITY;
  const rangeTo = to.value ?? Number.POSITIVE_INFINITY;
  const memories = await kv.list<RichMemory>(KV.memories);
  const filtered = memories.filter((memory) => {
    if (id && memory.id !== id) return false;
    if (project !== undefined && memory.project !== project) return false;
    if (agentId !== undefined && agentId !== "*" && memory.agentId !== agentId) return false;
    if (!includeHistory && memory.isLatest === false) return false;
    if (mode === "asOf") return containsAt(memory, asOf.value!);
    if (mode === "range") return overlapsRange(memory, rangeFrom, rangeTo);
    return isCurrent(memory, now);
  });

  filtered.sort((a, b) =>
    new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime() ||
    a.id.localeCompare(b.id),
  );
  return {
    success: true,
    mode,
    memories: filtered,
    results: filtered,
    includeHistory,
  };
}

function samePair(conflict: MemoryConflictRecord, sourceId: string, targetId: string): boolean {
  return (conflict.sourceId === sourceId && conflict.targetId === targetId) ||
    (conflict.sourceId === targetId && conflict.targetId === sourceId);
}

export async function createMemoryConflict(
  kv: StateKV,
  source: RichMemory,
  target: RichMemory,
  options: {
    evidenceIds?: string[];
    artifactIds?: string[];
    experimentIds?: string[];
  } = {},
): Promise<{ conflict: MemoryConflictRecord; created: boolean }> {
  const existing = await kv.list<MemoryConflictRecord>(KV.conflicts).catch(() => []);
  const open = existing.find((conflict) => conflict.status === "open" && samePair(conflict, source.id, target.id));
  if (open) return { conflict: open, created: false };

  const now = new Date().toISOString();
  const conflict: MemoryConflictRecord = {
    id: generateId("conf"),
    sourceId: source.id,
    targetId: target.id,
    memoryIds: [source.id, target.id],
    memoryAId: source.id,
    memoryBId: target.id,
    status: "open",
    createdAt: now,
    updatedAt: now,
    detectedBy: "relation",
    ...(source.project && source.project === target.project
      ? { project: source.project }
      : {}),
    ...(source.agentId && source.agentId === target.agentId
      ? { agentId: source.agentId }
      : {}),
    ...(options.evidenceIds && { evidenceIds: [...options.evidenceIds] }),
    ...(options.artifactIds && { artifactIds: [...options.artifactIds] }),
    ...(options.experimentIds && { experimentIds: [...options.experimentIds] }),
  };
  await kv.set(KV.conflicts, conflict.id, conflict);
  return { conflict, created: true };
}

function implicatedIds(conflict: MemoryConflictRecord): string[] {
  return conflict.memoryIds?.length > 0
    ? conflict.memoryIds
    : [conflict.sourceId, conflict.targetId];
}

function stateUpdates(data: InputRecord, conflict: MemoryConflictRecord): { value?: Record<string, EpistemicState>; error?: string } {
  const ids = new Set(implicatedIds(conflict));
  const updates: Record<string, EpistemicState> = {};
  const resolutionInput = asRecord(data.resolution);
  const supplied =
    data.memoryStates ??
    data.epistemicStates ??
    data.states ??
    resolutionInput?.memoryStates ??
    resolutionInput?.epistemicStates ??
    resolutionInput?.states;
  if (supplied !== undefined) {
    const record = asRecord(supplied);
    if (!record) return { error: "memoryStates must be an object keyed by memory id" };
    for (const [id, value] of Object.entries(record)) {
      if (!ids.has(id)) return { error: `memoryStates contains non-implicated memory: ${id}` };
      const state = validateEpistemicState(value);
      if (!state) return { error: `invalid epistemic state for memory ${id}` };
      updates[id] = state;
    }
  }

  const memoryId = typeof data.memoryId === "string" ? data.memoryId.trim() : undefined;
  const singleState = data.epistemicState ?? data.state;
  if (memoryId || singleState !== undefined) {
    if (!memoryId || !ids.has(memoryId)) return { error: "memoryId must identify an implicated memory" };
    const state = validateEpistemicState(singleState);
    if (!state) return { error: "epistemicState is required and must be valid" };
    updates[memoryId] = state;
  }

  const winnerValue =
    data.winnerMemoryId ??
    data.winningMemoryId ??
    data.winnerId ??
    data.acceptedMemoryId ??
    resolutionInput?.winnerMemoryId ??
    resolutionInput?.winningMemoryId ??
    resolutionInput?.winnerId ??
    resolutionInput?.acceptedMemoryId ??
    (typeof data.resolution === "string" ? data.resolution : undefined);
  const winner = typeof winnerValue === "string" ? winnerValue.trim() : undefined;
  if (winner) {
    if (!ids.has(winner)) return { error: "winnerMemoryId must identify an implicated memory" };
    if (!updates[winner]) updates[winner] = "verified";
    for (const id of ids) {
      if (id !== winner && !updates[id]) updates[id] = "disproven";
    }
  }
  return { value: updates };
}

async function resolveConflict(kv: StateKV, input: unknown): Promise<Record<string, unknown>> {
  const data = asRecord(input) ?? {};
  const conflictId = typeof (data.conflictId ?? data.id) === "string"
    ? String(data.conflictId ?? data.id).trim()
    : "";
  if (!conflictId) return { success: false, error: "conflictId is required" };

  const status = data.status;
  const allowed = ["resolved", "rejected", "dismissed", "inconclusive"] as const;
  if (!allowed.includes(status as (typeof allowed)[number])) {
    return { success: false, error: `status must be one of: ${allowed.join(", ")}` };
  }

  return withKeyedLock(`mem:conflict:${conflictId}`, async () => {
    const conflict = await kv.get<MemoryConflictRecord>(KV.conflicts, conflictId);
    if (!conflict) return { success: false, error: "conflict not found" };
    const states = stateUpdates(data, conflict);
    if (states.error) return { success: false, error: states.error };

    const now = new Date().toISOString();
    const updatedMemories: RichMemory[] = [];
    for (const [memoryId, state] of Object.entries(states.value ?? {})) {
      const memory = await kv.get<RichMemory>(KV.memories, memoryId);
      if (!memory) return { success: false, error: `implicated memory not found: ${memoryId}` };
      if (memory.epistemicState === state) continue;
      const updated = { ...memory, epistemicState: state, updatedAt: now };
      await kv.set(KV.memories, memory.id, updated);
      updatedMemories.push(updated);
      await safeAudit(kv, "memory_state_update", "mem::conflict-resolve", [memory.id], {
        conflictId,
        epistemicState: state,
      });
    }

    const resolutionInput = asRecord(data.resolution);
    const resolution = {
      ...(conflict.resolution ?? {}),
      ...(resolutionInput ?? {}),
      ...(typeof data.reason === "string" && data.reason.trim() ? { reason: data.reason.trim() } : {}),
      ...(typeof data.resolvedBy === "string" && data.resolvedBy.trim() ? { resolvedBy: data.resolvedBy.trim() } : {}),
    };
    const updatedConflict: MemoryConflictRecord = {
      ...conflict,
      status: status as MemoryConflictRecord["status"],
      updatedAt: now,
      resolution,
    };
    await kv.set(KV.conflicts, conflict.id, updatedConflict);
    await safeAudit(kv, "conflict_resolve", "mem::conflict-resolve", [conflict.id], {
      status,
      memoryIds: implicatedIds(conflict),
      updatedMemoryIds: updatedMemories.map((memory) => memory.id),
    });
    return {
      success: true,
      conflict: updatedConflict,
      memories: updatedMemories,
      evidencePreserved: true,
    };
  });
}

async function updateMemoryState(kv: StateKV, input: unknown): Promise<Record<string, unknown>> {
  const data = asRecord(input) ?? {};
  const memoryId = typeof data.memoryId === "string" ? data.memoryId.trim() : "";
  if (!memoryId) return { success: false, error: "memoryId is required" };
  const state = validateEpistemicState(data.epistemicState ?? data.state);
  if (!state) return { success: false, error: "epistemicState is required and must be valid" };

  return withKeyedLock(`mem:state:${memoryId}`, async () => {
    const memory = await kv.get<RichMemory>(KV.memories, memoryId);
    if (!memory) return { success: false, error: "memory not found" };
    const updated = { ...memory, epistemicState: state, updatedAt: new Date().toISOString() };
    await kv.set(KV.memories, memory.id, updated);
    await safeAudit(kv, "memory_state_update", "mem::memory-state-update", [memory.id], {
      previousState: memory.epistemicState,
      epistemicState: state,
    });
    return { success: true, memory: updated };
  });
}

export function registerTemporalMemoryFunctions(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction("mem::temporal-memory-query", (input: unknown) => queryTemporalMemories(kv, input));
  sdk.registerFunction("mem::memory-temporal-query", (input: unknown) => queryTemporalMemories(kv, input));
  sdk.registerFunction("mem::conflict-resolve", (input: unknown) => resolveConflict(kv, input));
  sdk.registerFunction("mem::memory-conflict-resolve", (input: unknown) => resolveConflict(kv, input));
  sdk.registerFunction("mem::memory-state-update", (input: unknown) => updateMemoryState(kv, input));
}
