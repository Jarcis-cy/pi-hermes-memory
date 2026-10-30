import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parsePrincipleFeedback } from "../../src/handlers/review-memory-ops.js";

describe("principle feedback parsing", () => {
  it("reads applied and violated ids alongside the operations payload", () => {
    const text = JSON.stringify({
      operations: [],
      principle_feedback: { applied: [12, "13"], violated: [14, 14, -3, 0] },
    });
    assert.deepEqual(parsePrincipleFeedback(text), { applied: [12, 13], violated: [14] });
  });

  it("returns empty verdicts when the key is absent or malformed", () => {
    assert.deepEqual(parsePrincipleFeedback(JSON.stringify({ operations: [] })), { applied: [], violated: [] });
    assert.deepEqual(parsePrincipleFeedback(JSON.stringify({ operations: [], principle_feedback: "nope" })), { applied: [], violated: [] });
    assert.deepEqual(parsePrincipleFeedback("not json"), { applied: [], violated: [] });
  });

  it("caps the verdict list so a runaway response cannot mass-update counters", () => {
    const ids = Array.from({ length: 60 }, (_, i) => i + 1);
    const parsed = parsePrincipleFeedback(JSON.stringify({ operations: [], principle_feedback: { violated: ids } }));
    assert.equal(parsed.violated.length, 20);
  });
});
