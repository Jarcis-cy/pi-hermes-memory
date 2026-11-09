import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseBackfillResponse } from "../../src/handlers/backfill-tags.js";
import { parseEventExtractionResponse } from "../../src/handlers/event-extraction.js";
import { normalizeSemanticTags } from "../../src/store/event-memory-store.js";

describe("backfill-tags", () => {
  it("parses tagger responses and drops unknown ids and malformed entries", () => {
    const batchIds = new Set([1, 2, 3]);
    const text = `{"tagged": [
      {"id": 1, "topics": ["docker-daemon", "Rootless Setup"]},
      {"id": 2, "topics": []},
      {"id": 999, "topics": ["not-in-batch"]},
      {"id": 3, "topics": "not-an-array"},
      {"bogus": true}
    ]}`;
    const parsed = parseBackfillResponse(text, batchIds);
    assert.equal(parsed.size, 2, "only known ids with usable topics survive");
    assert.deepEqual(parsed.get(1), ["docker-daemon", "Rootless Setup"]);
    assert.deepEqual(parsed.get(2), []);
    assert.equal(parsed.has(3), false);
  });

  it("normalizes semantic tags into the deterministic token charset", () => {
    assert.deepEqual(
      normalizeSemanticTags(["Postgres Connection", "postgres-connection", "a", "x!", "ok", "fifth", "sixth"]),
      ["postgres-connection", "fifth", "sixth"],
    );
    assert.deepEqual(normalizeSemanticTags(undefined), []);
    assert.deepEqual(normalizeSemanticTags(["!!", "ab", "  ", 42]), []);
  });

  it("extraction parse carries topics into drafts as semanticTags", () => {
    const text = JSON.stringify({
      events: [{
        scope: "project",
        kind: "failure",
        content: "Rootless docker daemon returned 0 containers, misreading the stack as down.",
        evidence_quote: "0 containers",
        topics: ["docker-daemon", "Rootless Setup"],
      }],
    });
    const drafts = parseEventExtractionResponse(text);
    assert.ok(drafts && drafts.length === 1);
    assert.deepEqual(drafts[0]!.semanticTags, ["docker-daemon", "rootless-setup"], "topics are normalized on parse");

    const legacy = parseEventExtractionResponse(JSON.stringify({
      events: [{
        scope: "user",
        kind: "preference",
        content: "User prefers plain-language answers.",
        evidence_quote: "plain-language",
      }],
    }));
    assert.ok(legacy && legacy.length === 1);
    assert.deepEqual(legacy[0]!.semanticTags, [], "responses without topics stay valid");
  });
});
