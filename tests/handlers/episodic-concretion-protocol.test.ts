import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildEventExtractionUserPrompt,
  parseEventExtractionResponse,
} from "../../src/handlers/event-extraction.js";
import { parseConcretionResponse } from "../../src/handlers/concretion.js";

describe("event extraction protocol", () => {
  it("parses concrete events with required evidence", () => {
    const parsed = parseEventExtractionResponse(JSON.stringify({
      events: [{
        scope: "project",
        kind: "correction",
        content: "The user corrected a project-specific narrative.",
        evidence_quote: "That is one outfit, not five outfits.",
      }],
    }));
    assert.deepEqual(parsed, [{
      scope: "project",
      kind: "correction",
      content: "The user corrected a project-specific narrative.",
      evidenceQuote: "That is one outfit, not five outfits.",
    }]);
  });

  it("drops malformed event items and rejects malformed envelopes", () => {
    assert.deepEqual(parseEventExtractionResponse(JSON.stringify({
      events: [
        { scope: "global", kind: "fact", content: "missing quote" },
        { scope: "bad", kind: "fact", content: "bad scope", evidence_quote: "quote" },
      ],
    })), []);
    assert.equal(parseEventExtractionResponse("not json"), null);
  });

  it("includes the active project and conversation episode in the prompt", () => {
    const prompt = buildEventExtractionUserPrompt({
      parts: ["[USER] example", "[ASSISTANT] response"],
      projectName: "demo",
      source: "background-review",
    });
    assert.match(prompt, /Active project: demo/);
    assert.match(prompt, /\[USER\] example/);
  });
});

describe("concretion protocol", () => {
  it("parses sourced add, reinforce, refine, and conflict candidates", () => {
    const parsed = parseConcretionResponse(JSON.stringify({
      candidates: [
        {
          action: "add",
          scope: "global",
          content: "Verify child work has stopped after cancelling a parent task.",
          rationale: "Terminal states can diverge.",
          source_event_ids: [1],
          existing_principle_ids: [],
        },
        {
          action: "reinforce",
          source_event_ids: [2],
          existing_principle_ids: [7],
        },
        {
          action: "conflict",
          scope: "user",
          content: "Default to exhaustive answers.",
          source_event_ids: [3],
          existing_principle_ids: [8],
          conflict_reason: "Contradicts concise preference.",
        },
      ],
    }));
    assert.equal(parsed?.length, 3);
    assert.deepEqual(parsed?.[0].sourceEventIds, [1]);
    assert.deepEqual(parsed?.[1].existingPrincipleIds, [7]);
    assert.equal(parsed?.[2].conflictReason, "Contradicts concise preference.");
  });

  it("rejects malformed candidates instead of partially accepting a plan", () => {
    const response = JSON.stringify({
      candidates: [
        {
          action: "add",
          scope: "global",
          content: "Valid-looking principle.",
          source_event_ids: [1],
          existing_principle_ids: [],
        },
        {
          action: "add",
          scope: "global",
          content: "Missing evidence IDs.",
          source_event_ids: [],
          existing_principle_ids: [],
        },
      ],
    });
    assert.equal(parseConcretionResponse(response), null);
  });

  it("returns an empty plan and rejects invalid envelopes", () => {
    assert.deepEqual(parseConcretionResponse('{"candidates":[]}'), []);
    assert.equal(parseConcretionResponse('{"events":[]}'), null);
    assert.equal(parseConcretionResponse('{"candidates":[{"action":"bad","source_event_ids":[1],"existing_principle_ids":[]}]}'), null);
  });
});
