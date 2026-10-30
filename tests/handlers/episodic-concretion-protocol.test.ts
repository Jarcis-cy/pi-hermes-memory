import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildEventExtractionUserPrompt,
  parseEventExtractionResponse,
} from "../../src/handlers/event-extraction.js";
import { buildConcretionUserPrompt, parseConcretionResponse } from "../../src/handlers/concretion.js";

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

describe("concretion usage signals", () => {
  it("lists per-principle recall evidence and marks never-recalled evidence", () => {
    const principles = [
      {
        id: 3,
        scope: "global" as const,
        project: null,
        content: "Verify the consumer's expected field path before wiring.",
        rationale: null,
        sourceEventIds: [11, 12],
        status: "active" as const,
        supersedesId: null,
        createdAt: "2026-10-01",
        updatedAt: "2026-10-01",
      },
      {
        id: 4,
        scope: "global" as const,
        project: null,
        content: "Never rename an existing user-facing concept.",
        rationale: null,
        sourceEventIds: [13],
        status: "active" as const,
        supersedesId: null,
        createdAt: "2026-10-02",
        updatedAt: "2026-10-02",
      },
    ] as never;
    const signals = new Map([
      [3, { principleId: 3, sourceEventCount: 2, totalHits: 9, lastHitAt: "2026-10-29" }],
      [4, { principleId: 4, sourceEventCount: 1, totalHits: 0, lastHitAt: null }],
    ]);

    const prompt = buildConcretionUserPrompt([], principles, signals);
    assert.match(prompt, /Principle Usage Signals/);
    assert.match(prompt, /P3: 2 source event\(s\), recalled 9× total, last recalled 2026-10-29/);
    assert.match(prompt, /P4: 1 source event\(s\), recalled 0× total, last recalled never/);
    assert.match(prompt, /never been recalled is a weaker keep candidate/);
  });

  it("omits the section when no recall data exists", () => {
    const prompt = buildConcretionUserPrompt([], [], null);
    assert.doesNotMatch(prompt, /Principle Usage Signals/);
  });
});

describe("concretion budget guidance", () => {
  it("states the budget and points at merge when the set is over budget", () => {
    const prompt = buildConcretionUserPrompt([], [], null, { used: 32651, limit: 20000 });
    assert.match(prompt, /Active principles use 32651 of 20000 characters \(163%\)/);
    assert.match(prompt, /OVER budget/);
    assert.match(prompt, /Use merge to combine near-duplicate principles/);
  });

  it("keeps the budget note advisory when there is headroom", () => {
    const prompt = buildConcretionUserPrompt([], [], null, { used: 900, limit: 20000 });
    assert.match(prompt, /900 of 20000 characters \(4%\)/);
    assert.match(prompt, /Prefer merge over add/);
    assert.doesNotMatch(prompt, /OVER budget/);
  });
});
