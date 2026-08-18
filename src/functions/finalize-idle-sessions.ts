import { TriggerAction, type ISdk } from "iii-sdk";
import type { Session, SessionSummary } from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { getSessionIdleTimeoutMs } from "../config.js";
import { recordAudit } from "./audit.js";
import { logger } from "../logger.js";
import { getSessionLastActivity } from "../utils/session-activity.js";

interface FinalizeIdleSessionsInput {
  dryRun?: boolean;
  idleTimeoutMs?: number;
  now?: string;
}

interface FinalizeOutcome {
  sessionId: string;
  status: "finalized" | "skipped" | "failed";
  summaryRefreshQueued: boolean;
}

function getNowMs(value: string | undefined): number | null {
  if (value === undefined) return Date.now();
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function getIdleTimeoutMs(value: number | undefined): number | null {
  const timeout = value ?? getSessionIdleTimeoutMs();
  if (!Number.isFinite(timeout) || timeout <= 0) return null;
  return timeout;
}

export function isSessionIdle(
  session: Pick<Session, "status" | "startedAt" | "updatedAt">,
  nowMs: number,
  idleTimeoutMs: number,
): boolean {
  if (session.status !== "active") return false;
  const lastActivity = getSessionLastActivity(session);
  return (
    lastActivity !== null &&
    nowMs - lastActivity.timestampMs >= idleTimeoutMs
  );
}

export function registerFinalizeIdleSessionsFunction(
  sdk: ISdk,
  kv: StateKV,
): void {
  sdk.registerFunction(
    "mem::finalize-idle-sessions",
    async (data?: FinalizeIdleSessionsInput) => {
      const nowMs = getNowMs(data?.now);
      if (nowMs === null) {
        return { success: false, error: "now must be a valid ISO timestamp" };
      }

      const idleTimeoutMs = getIdleTimeoutMs(data?.idleTimeoutMs);
      if (idleTimeoutMs === null) {
        return {
          success: false,
          skipped: true,
          reason: "idle session finalization is disabled",
        };
      }

      const dryRun = data?.dryRun === true;
      const sessions = await kv.list<Session>(KV.sessions);
      const candidates = sessions.filter((session) =>
        isSessionIdle(session, nowMs, idleTimeoutMs),
      );

      if (dryRun) {
        return {
          success: true,
          dryRun: true,
          checked: sessions.length,
          finalized: candidates.length,
          sessionIds: candidates.map((session) => session.id),
          idleTimeoutMs,
        };
      }

      const outcomes = await Promise.all(
        candidates.map(async (candidate): Promise<FinalizeOutcome> => {
          try {
            const session = await kv.get<Session>(KV.sessions, candidate.id);
            if (!session || !isSessionIdle(session, nowMs, idleTimeoutMs)) {
              return {
                sessionId: candidate.id,
                status: "skipped",
                summaryRefreshQueued: false,
              };
            }

            const lastActivity = getSessionLastActivity(session);
            if (!lastActivity) {
              return {
                sessionId: session.id,
                status: "skipped",
                summaryRefreshQueued: false,
              };
            }

            await kv.update(KV.sessions, session.id, [
              { type: "set", path: "endedAt", value: lastActivity.timestamp },
              { type: "set", path: "status", value: "completed" },
            ]);

            const summary = await kv
              .get<SessionSummary>(KV.summaries, session.id)
              .catch(() => null);
            const summaryNeedsRefresh =
              session.observationCount > 0 &&
              (!summary ||
                (summary.observationCount ?? 0) < session.observationCount);

            if (summaryNeedsRefresh) {
              Promise.resolve(
                sdk.trigger({
                  function_id: "event::session::stopped",
                  payload: { sessionId: session.id },
                  action: TriggerAction.Void(),
                }),
              ).catch((error) => {
                logger.warn("Idle session summary refresh failed", {
                  sessionId: session.id,
                  error: error instanceof Error ? error.message : String(error),
                });
              });
            }

            return {
              sessionId: session.id,
              status: "finalized",
              summaryRefreshQueued: summaryNeedsRefresh,
            };
          } catch (error) {
            logger.warn("Idle session finalization failed", {
              sessionId: candidate.id,
              error: error instanceof Error ? error.message : String(error),
            });
            return {
              sessionId: candidate.id,
              status: "failed",
              summaryRefreshQueued: false,
            };
          }
        }),
      );

      const finalized = outcomes.filter(
        (outcome) => outcome.status === "finalized",
      );
      const summaryRefreshQueued = finalized.filter(
        (outcome) => outcome.summaryRefreshQueued,
      ).length;

      if (finalized.length > 0) {
        await recordAudit(
          kv,
          "session_finalize",
          "mem::finalize-idle-sessions",
          finalized.map((outcome) => outcome.sessionId),
          {
            reason: "idle_timeout",
            finalizedAt: new Date(nowMs).toISOString(),
            idleTimeoutMs,
            summaryRefreshQueued,
          },
        );
        logger.info("Idle sessions finalized", {
          finalized: finalized.length,
          idleTimeoutMs,
          summaryRefreshQueued,
        });
      }

      return {
        success: true,
        dryRun: false,
        checked: sessions.length,
        candidates: candidates.length,
        finalized: finalized.length,
        skipped: outcomes.filter((outcome) => outcome.status === "skipped")
          .length,
        failed: outcomes.filter((outcome) => outcome.status === "failed").length,
        summaryRefreshQueued,
        sessionIds: finalized.map((outcome) => outcome.sessionId),
        idleTimeoutMs,
      };
    },
  );
}
