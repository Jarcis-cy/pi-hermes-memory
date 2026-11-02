import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildEventExtractionUserPrompt,
  parseEventExtractionResponse,
  parsePrincipleFeedbackIds,
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

  it("drops malformed individual candidates but keeps the good ones", () => {
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
        {
          action: "refine",
          scope: "global",
          content: "Refine without exactly one target id.",
          source_event_ids: [2],
          existing_principle_ids: [],
        },
      ],
    });
    const parsed = parseConcretionResponse(response);
    assert.equal(parsed?.length, 1, "one flawed candidate must not void the good one");
    assert.equal(parsed?.[0]?.content, "Valid-looking principle.");
  });

  it("extracts a fenced plan from a chatty response", () => {
    const chatty = [
      "I've analyzed the batch. Here is my reflection decision as JSON:",
      "",
      "```json",
      JSON.stringify({
        candidates: [{
          action: "reinforce",
          scope: "global",
          content: "",
          rationale: "same principle, new evidence",
          source_event_ids: [7],
          existing_principle_ids: [4],
        }],
      }),
      "```",
      "",
      "Trailing explanation that is not JSON.",
    ].join("\n");
    const parsed = parseConcretionResponse(chatty);
    assert.equal(parsed?.length, 1);
    assert.equal(parsed?.[0]?.action, "reinforce");
  });

  it("returns an empty plan and rejects invalid envelopes", () => {
    assert.deepEqual(parseConcretionResponse('{"candidates":[]}'), []);
    assert.equal(parseConcretionResponse('{"events":[]}'), null);
    assert.deepEqual(parseConcretionResponse('{"candidates":[{"action":"bad","source_event_ids":[1],"existing_principle_ids":[]}]}'), [], "only-bad items drop to an empty plan, not a failed parse");
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

describe("concretion out-of-batch sanitization", () => {
  it("keeps in-batch source ids and drops foreign ones instead of failing the run", () => {
    // 语义与 runConcretion 中的净化一致：保留本批 id，丢弃越界 id，
    // 丢弃后没有源事件的候选整条移除（none 动作除外）。
    const batchIds = new Set([11, 12]);
    const parsed = [
      { action: "add", scope: "global", content: "A", sourceEventIds: [11, 999], existingPrincipleIds: [] },
      { action: "add", scope: "global", content: "B", sourceEventIds: [777], existingPrincipleIds: [] },
      { action: "none", scope: "global", content: "C", sourceEventIds: [888], existingPrincipleIds: [] },
    ];
    const sanitized = parsed
      .map((candidate) => ({ ...candidate, sourceEventIds: [...new Set(candidate.sourceEventIds.filter((id) => batchIds.has(id)))] }))
      .filter((candidate) => candidate.action === "none" || candidate.sourceEventIds.length > 0);

    assert.equal(sanitized.length, 2);
    assert.deepEqual(sanitized[0]!.sourceEventIds, [11]);
    assert.equal(sanitized[1]!.action, "none");
  });
});

describe("concretion merge suggestions", () => {
  const principle = (id: number, content: string, scope: "global" | "user" = "global") => ({
    id,
    scope,
    project: null,
    content,
    rationale: null,
    sourceEventIds: [id],
    status: "active" as const,
    supersedesId: null,
    createdAt: "2026-10-01",
    updatedAt: "2026-10-01",
  });

  it("offers lexically near-duplicate pairs with both ids so the model can name merge targets", () => {
    const principles = [
      principle(1, "Back up the data before any bulk write to a datastore."),
      principle(2, "Back up the data before any bulk write to a datastore table."),
    ] as never;
    const prompt = buildConcretionUserPrompt([], principles);
    assert.match(prompt, /Pre-computed Merge Candidates/);
    assert.match(prompt, /P1 ↔ P2/);
    assert.match(prompt, /copy BOTH ids into existing_principle_ids/);
  });

  it("stays silent when nothing is near-duplicate", () => {
    const principles = [
      principle(1, "Back up the data before any bulk write to a datastore."),
      principle(2, "Never rename an existing user-facing concept without asking first."),
    ] as never;
    assert.doesNotMatch(buildConcretionUserPrompt([], principles), /Merge Candidates/);
  });

  it("never pairs principles across scopes", () => {
    const principles = [
      principle(1, "Back up the data before any bulk write to a datastore.", "global"),
      principle(2, "Back up the data before any bulk write to a datastore.", "user"),
    ] as never;
    assert.doesNotMatch(buildConcretionUserPrompt([], principles), /Merge Candidates/);
  });
});

describe("extraction principle feedback", () => {
  it("offers the principle index and feedback instructions only when supplied", () => {
    const withIndex = buildEventExtractionUserPrompt({
      parts: ["[USER] hi"],
      projectName: null,
      source: "background-review",
      principleIndex: ["P1 [global] Back up data before any bulk write."],
    });
    assert.match(withIndex, /Active Principles \(for optional feedback\)/);
    assert.match(withIndex, /P1 \[global\] Back up data before any bulk write\./);
    assert.match(withIndex, /principle_feedback/);

    const withoutIndex = buildEventExtractionUserPrompt({
      parts: ["[USER] hi"],
      projectName: null,
      source: "background-review",
    });
    assert.doesNotMatch(withoutIndex, /Active Principles/);
    assert.doesNotMatch(withoutIndex, /principle_feedback/);
  });

  it("keeps only offered ids and caps each class", () => {
    const text = JSON.stringify({
      events: [],
      principle_feedback: {
        applied: [1, 2, 2.5, 999, ...Array.from({ length: 25 }, () => 3)],
        violated: [42],
      },
    });
    const feedback = parsePrincipleFeedbackIds(text, new Set([1, 2, 3]));
    assert.deepEqual(feedback.applied, [1, 2, ...Array.from({ length: 18 }, () => 3)]);
    assert.deepEqual(feedback.violated, []);
  });

  it("returns empty accounting when the key is absent or malformed", () => {
    assert.deepEqual(parsePrincipleFeedbackIds(JSON.stringify({ events: [] }), new Set([1])), { applied: [], violated: [] });
    assert.deepEqual(parsePrincipleFeedbackIds("not json", new Set([1])), { applied: [], violated: [] });
    assert.deepEqual(
      parsePrincipleFeedbackIds(JSON.stringify({ events: [], principle_feedback: "nope" }), new Set([1])),
      { applied: [], violated: [] },
    );
  });
});

describe("principle feedback id forms", () => {
  it("accepts the display form P<id> as well as bare numbers, drops unknowns", () => {
    const text = JSON.stringify({
      events: [],
      principle_feedback: { applied: ["P304", 221, "p306", "P999", "not-an-id"], violated: ["P221"] },
    });
    const feedback = parsePrincipleFeedbackIds(text, new Set([304, 221, 306]));
    assert.deepEqual(feedback.applied, [304, 221, 306]);
    assert.deepEqual(feedback.violated, [221]);
  });
});
