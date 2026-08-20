import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TantivySearchIndex } from "../src/state/tantivy-search-index.js";
import type { CompressedObservation } from "../src/types.js";

function makeObs(
  overrides: Partial<CompressedObservation> = {},
): CompressedObservation {
  return {
    id: "obs_1",
    sessionId: "ses_1",
    timestamp: new Date().toISOString(),
    type: "file_edit",
    title: "Edit auth middleware",
    subtitle: "JWT validation",
    facts: ["Added token check"],
    narrative: "Modified the auth middleware to validate JWT tokens",
    concepts: ["authentication", "jwt"],
    files: ["src/middleware/auth.ts"],
    importance: 7,
    ...overrides,
  };
}

describe("TantivySearchIndex", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adds, searches, and removes observations", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentmemory-tantivy-"));
    tempDirs.push(dir);
    const index = new TantivySearchIndex({
      path: dir,
      heapSizeBytes: 16 * 1024 * 1024,
      numThreads: 1,
      maxEntries: 100,
    });

    index.add(makeObs({ id: "obs_a", title: "React auth flow" }));
    index.add(
      makeObs({
        id: "obs_b",
        title: "Database migration",
        subtitle: "Schema change",
        facts: ["Added account table"],
        narrative: "Ran a database schema migration",
        concepts: ["database", "migration"],
        files: ["db/schema.sql"],
      }),
    );

    const results = index.search("React auth", 10);
    expect(results[0]?.obsId).toBe("obs_a");
    expect(index.has("obs_a")).toBe(true);

    index.remove("obs_a");
    expect(index.has("obs_a")).toBe(false);
    expect(index.search("React auth", 10)).toEqual([]);
  });

  it("filters scoped candidates before applying the result limit", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentmemory-tantivy-scope-"));
    tempDirs.push(dir);
    const index = new TantivySearchIndex({
      path: dir,
      heapSizeBytes: 16 * 1024 * 1024,
      numThreads: 1,
      maxEntries: 100,
    });

    for (let i = 0; i < 20; i++) {
      index.add(
        makeObs({
          id: `other_${i}`,
          title: `auth feature ${i}`,
          project: "other-project",
          agentId: "agent-other",
        }),
      );
    }
    index.add(
      makeObs({
        id: "in_scope",
        title: "auth feature in scope",
        project: "my-project",
        agentId: "agent-a",
      }),
    );

    expect(index.search("auth", 1, {
      project: "my-project",
      agentId: "agent-a",
    })).toEqual([
      expect.objectContaining({ obsId: "in_scope" }),
    ]);
  });
});
