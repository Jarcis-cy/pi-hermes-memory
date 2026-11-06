import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseManager } from "../../src/store/db.js";
import {
  applyConcretionPlan,
  captureMemoryEvents,
  getActivePrinciples,
  getMemoryEvents,
  getPendingPrincipleConflicts,
  startConcretionRun,
} from "../../src/store/event-memory-store.js";

/**
 * The conflict queue is a user-attention surface. Model-mislabelled actions must
 * be repaired before they reach it, and only a genuinely newer, multiply
 * evidenced reversal may retire an unpinned principle without asking.
 */
describe("concretion conflict triage", () => {
  let tmpDir: string;
  let dbManager: DatabaseManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conflict-triage-"));
    dbManager = new DatabaseManager(tmpDir);
  });

  afterEach(() => {
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const capture = (captureId: string, content: string, occurredAt?: string) => captureMemoryEvents(
    dbManager,
    [{ scope: "global", kind: "insight", content, evidenceQuote: content.slice(0, 40) }],
    { source: "manual", captureId, ...(occurredAt ? { occurredAt } : {}) },
  );

  const apply = (candidates: Parameters<typeof applyConcretionPlan>[3], charLimit = 20000) => {
    const events = getMemoryEvents(dbManager, { pendingOnly: true });
    const runId = startConcretionRun(dbManager, "manual", events.length);
    return applyConcretionPlan(dbManager, runId, events, candidates, { charLimit });
  };

  const principleStatus = (id: number): string | undefined => (
    dbManager.getDb().prepare("SELECT status FROM principles WHERE id = ?").get(id) as { status: string } | undefined
  )?.status;

  const seedPrinciple = (content: string, occurredAt?: string) => {
    const caught = capture(`seed-${Math.random().toString(36).slice(2)}`, `${content} evidence`, occurredAt);
    const result = apply([{ action: "add", scope: "global", content, sourceEventIds: caught.eventIds, existingPrincipleIds: [] }]);
    assert.equal(result.added, 1, "seed principle must be added");
    return getActivePrinciples(dbManager).find((principle) => principle.content === content)!.id;
  };

  it("repairs a merge that cites one principle into a refinement", () => {
    const target = seedPrinciple("Verify the runtime binary is actually the one that was rebuilt.");
    const caught = capture("merge-1", "Rebuilt binary kept serving the old behaviour evidence");

    const result = apply([{
      action: "merge", scope: "global", content: "Verify the running binary matches the rebuilt artefact before debugging behaviour.",
      sourceEventIds: caught.eventIds, existingPrincipleIds: [target],
    }]);

    assert.equal(result.conflicts, 0, "a one-principle merge is not a user decision");
    assert.equal(result.repaired, 1);
    assert.equal(result.refined, 1);
    assert.equal(getPendingPrincipleConflicts(dbManager).length, 0);
    assert.equal(principleStatus(target), "superseded");
  });

  it("repairs a merge that cites nothing into an addition", () => {
    seedPrinciple("Check disk headroom before starting a build that writes large artefacts.");
    const caught = capture("merge-2", "Nightly log rotation keeps disk usage bounded evidence");

    const result = apply([{
      action: "merge", scope: "global", content: "Rotate log files nightly to keep disk usage bounded.",
      sourceEventIds: caught.eventIds, existingPrincipleIds: [],
    }]);

    assert.equal(result.conflicts, 0);
    assert.equal(result.repaired, 1);
    assert.equal(result.added, 1);
  });

  it("repairs a conflict with no contradictory principle into an addition", () => {
    const caught = capture("conflict-1", "Provider quota should be the maximum across providers evidence");
    const result = apply([{
      action: "conflict", scope: "global", content: "Provider quota is the maximum across available providers, not the minimum.",
      sourceEventIds: caught.eventIds, existingPrincipleIds: [],
    }]);

    assert.equal(result.conflicts, 0, "nothing was contradicted, so nothing needs a decision");
    assert.equal(result.repaired, 1);
    assert.equal(result.added, 1);
  });

  it("promotes an unscopable project candidate to global instead of parking it", () => {
    // Two projects in one batch: the candidate cannot be project-scoped.
    const first = captureMemoryEvents(dbManager, [{ scope: "project", kind: "insight", content: "alpha project evidence" }], { source: "manual", captureId: "scope-a", project: "alpha" });
    const second = captureMemoryEvents(dbManager, [{ scope: "project", kind: "insight", content: "beta project evidence" }], { source: "manual", captureId: "scope-b", project: "beta" });

    const result = apply([{
      action: "add", scope: "project", content: "Measure real utilisation for an hour before changing a limit.",
      sourceEventIds: [...first.eventIds, ...second.eventIds], existingPrincipleIds: [],
    }]);

    assert.equal(result.conflicts, 0, "scope ambiguity is not a user decision");
    assert.equal(result.repaired, 1);
    const added = getActivePrinciples(dbManager).find((principle) => principle.content.startsWith("Measure real utilisation"));
    assert.equal(added?.scope, "global");
  });

  it("settles a contradiction when the newer evidence is multiply sourced and newer than the target", () => {
    const target = seedPrinciple("Provider quota must be the minimum across providers.", "2026-10-01T00:00:00.000Z");
    const first = capture("rev-a", "Real test shows provider quota is the maximum evidence", "2026-10-24T00:00:00.000Z");
    const second = capture("rev-b", "Second real test confirms the maximum again", "2026-10-25T00:00:00.000Z");

    const result = apply([{
      action: "conflict", scope: "global",
      content: "Provider quota is the MAXIMUM across available providers; pool instance caps stay min().",
      sourceEventIds: [...first.eventIds, ...second.eventIds], existingPrincipleIds: [target],
      conflictReason: "P contradicts the newer measurement.",
    }]);

    assert.equal(result.autoSuperseded, 1);
    assert.equal(result.conflicts, 0);
    assert.equal(principleStatus(target), "superseded", "the old rule leaves the injected set");
    assert.ok(
      getActivePrinciples(dbManager).some((principle) => principle.content.startsWith("Provider quota is the MAXIMUM")),
      "the newer rule is active",
    );
  });

  it("parks the contradiction when a single event contradicts", () => {
    const target = seedPrinciple("Provider quota must be the minimum across providers.", "2026-10-01T00:00:00.000Z");
    const only = capture("single-1", "One remark about the maximum", "2026-10-24T00:00:00.000Z");

    const result = apply([{
      action: "conflict", scope: "global", content: "Provider quota is the maximum across providers.",
      sourceEventIds: only.eventIds, existingPrincipleIds: [target], conflictReason: "contradiction",
    }]);

    assert.equal(result.conflicts, 1, "one remark is not a reversal");
    assert.equal(result.autoSuperseded ?? 0, 0);
    assert.equal(getPendingPrincipleConflicts(dbManager).length, 1);
  });

  it("parks the contradiction when the candidate evidence is older than the target", () => {
    const target = seedPrinciple("Provider quota must be the minimum across providers.", "2026-10-20T00:00:00.000Z");
    const older1 = capture("old-a", "Older note about the maximum", "2026-10-02T00:00:00.000Z");
    const older2 = capture("old-b", "Another older note about the maximum", "2026-10-03T00:00:00.000Z");

    const result = apply([{
      action: "conflict", scope: "global", content: "Provider quota is the maximum across providers.",
      sourceEventIds: [...older1.eventIds, ...older2.eventIds], existingPrincipleIds: [target], conflictReason: "older evidence",
    }]);

    assert.equal(result.conflicts, 1, "older evidence cannot overturn a newer rule");
    assert.equal(result.autoSuperseded ?? 0, 0);
  });

  it("never auto-supersedes a pinned principle", () => {
    const target = seedPrinciple("Never force-push a shared branch.", "2026-10-01T00:00:00.000Z");
    dbManager.getDb().prepare("UPDATE principles SET pinned = 1 WHERE id = ?").run(target);
    const first = capture("pin-a", "Branch recovery note one", "2026-10-24T00:00:00.000Z");
    const second = capture("pin-b", "Branch recovery note two", "2026-10-25T00:00:00.000Z");

    const result = apply([{
      action: "conflict", scope: "global", content: "Force-pushing a shared branch is acceptable after a rebase.",
      sourceEventIds: [...first.eventIds, ...second.eventIds], existingPrincipleIds: [target], conflictReason: "convenience",
    }]);

    assert.equal(result.autoSuperseded ?? 0, 0, "the safety register is never settled silently");
    assert.equal(result.conflicts, 1);
  });
});
