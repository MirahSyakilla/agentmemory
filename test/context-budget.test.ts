import { describe, expect, it } from "vitest";
import {
  expandContextHandle,
  partitionContext,
  resolveContextBudgets,
} from "../src/functions/context-budget.js";

describe("tiered context budgeting", () => {
  it("derives deterministic weighted budgets from a total", () => {
    expect(resolveContextBudgets({ total: 10 })).toEqual({
      total: 10,
      direct: 6,
      supporting: 2,
      historical: 1,
      provenance: 1,
    });
  });

  it("honors explicit tier budgets, provides omitted handles, and sorts ties by id", () => {
    const result = partitionContext(
      [
        { id: "direct-b", tier: "direct", text: "direct lower", score: 0.5 },
        { id: "direct-a", tier: "direct", text: "direct high", score: 0.9 },
        { id: "support", tier: "supporting", text: "support", score: 0.5 },
        { id: "history", tier: "historical", text: "history", score: 0.5 },
        { id: "proof", tier: "provenance", text: "proof", score: 0.5 },
      ],
      { direct: 4, supporting: 3, historical: 3, provenance: 3 },
    );

    expect(result.budgets).toEqual({
      total: 13,
      direct: 4,
      supporting: 3,
      historical: 3,
      provenance: 3,
    });
    expect(result.tiers.direct.map((item) => item.id)).toEqual(["direct-a"]);
    expect(result.omitted.direct).toEqual(["direct-b"]);
    expect(result.tiers.supporting.map((item) => item.id)).toEqual(["support"]);
    expect(result.tiers.historical.map((item) => item.id)).toEqual(["history"]);
    expect(result.tiers.provenance.map((item) => item.id)).toEqual(["proof"]);
    expect(result.handles.map((handle) => handle.handle)).toContain("ctx:direct:direct-b");
    expect(result.tokensUsed).toBeLessThanOrEqual(result.budgets.total);
    expect(result.truncated).toBe(true);
  });

  it("expands a valid handle under a separate budget without accepting forged handles", () => {
    const items = [
      {
        id: "direct-a",
        tier: "direct" as const,
        text: "This is the complete direct retrieval text.",
      },
    ];
    const partitioned = partitionContext(items, { total: 1 });
    const handle = partitioned.handles[0]!;

    const expanded = expandContextHandle(handle, items, 1_000);
    expect(expanded).toMatchObject({
      itemId: "direct-a",
      content: "This is the complete direct retrieval text.",
      truncated: false,
    });

    expect(
      expandContextHandle({ ...handle, handle: "ctx:direct:other" }, items),
    ).toBeNull();
    expect(expandContextHandle(handle, items, 0)).toMatchObject({
      content: "",
      tokensUsed: 0,
      truncated: true,
    });
  });
});
