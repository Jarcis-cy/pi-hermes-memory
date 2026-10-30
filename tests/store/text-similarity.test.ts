import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { queryCoverage, tokenizeForMatch, tokenSetSimilarity } from "../../src/store/text-similarity.js";

describe("text similarity", () => {
  it("tokenizes lowercase content words, folds inflections, drops punctuation", () => {
    assert.deepEqual(
      tokenizeForMatch("Verify the consumer's expected field path, before wiring!"),
      ["verify", "the", "consumer", "expect", "field", "path", "before", "wiring"],
    );
  });

  it("tokenizes CJK runs as overlapping bigrams", () => {
    assert.deepEqual(tokenizeForMatch("窗口索引"), ["窗口", "口索", "索引"]);
    assert.deepEqual(tokenizeForMatch("迁移"), ["迁移"]);
  });

  it("treats a restatement as a near duplicate and a different rule as distinct", () => {
    const original = "Verify the consumer's expected field path before wiring a new adapter boundary.";
    const restated = "Verify the consumer's expected field path before wiring an adapter boundary.";
    const different = "Never hold the task mutex across a blocking channel send; enqueue outside the critical section.";

    assert.ok(tokenSetSimilarity(original, restated) >= 0.8, "restatement should score high");
    assert.ok(tokenSetSimilarity(original, different) < 0.2, "different rule should score low");
  });

  it("scores query coverage by distinct query tokens found", () => {
    const text = "Before restarting a Code Audit backend, classify FAILURE tasks by failure timestamp.";
    assert.ok(queryCoverage("restart backend failure", text) > 0.9);
    assert.equal(queryCoverage("kubernetes helm chart", text), 0);
    assert.equal(queryCoverage("", text), 0);
  });
});
