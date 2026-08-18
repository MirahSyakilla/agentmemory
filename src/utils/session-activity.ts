import type { Session } from "../types.js";

export interface SessionActivity {
  timestamp: string;
  timestampMs: number;
}

function asTimestamp(value: unknown): SessionActivity | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const timestampMs = new Date(value).getTime();
  if (!Number.isFinite(timestampMs)) return null;
  return { timestamp: value, timestampMs };
}

export function getSessionLastActivity(
  session: Pick<Session, "startedAt" | "updatedAt">,
): SessionActivity | null {
  const candidates = [
    asTimestamp(session.startedAt),
    asTimestamp(session.updatedAt),
  ].filter((value): value is SessionActivity => value !== null);
  if (candidates.length === 0) return null;
  return candidates.reduce((latest, candidate) =>
    candidate.timestampMs > latest.timestampMs ? candidate : latest,
  );
}
