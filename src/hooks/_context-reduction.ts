import type {
  ContextReductionAccounting,
  ContextReductionSource,
} from "../types.js";

export async function recordContextReduction(input: {
  restUrl: string;
  secret: string;
  accounting?: ContextReductionAccounting;
  source: ContextReductionSource;
  sessionId?: string;
  project?: string;
}): Promise<void> {
  if (!input.accounting) return;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (input.secret) headers["Authorization"] = `Bearer ${input.secret}`;

  try {
    await fetch(`${input.restUrl}/agentmemory/context-reduction/events`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        accounting: input.accounting,
        source: input.source,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.project ? { project: input.project } : {}),
      }),
      signal: AbortSignal.timeout(800),
    });
  } catch {}
}
