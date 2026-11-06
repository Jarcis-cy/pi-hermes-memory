import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_TASK_TERMS,
  TASK_RELEVANCE_STRONG,
  buildTaskSearchQuery,
  extractTaskTerms,
  scoreTaskRelevance,
} from "../../src/store/task-terms.js";

describe("extractTaskTerms", () => {
  it("keeps identifiers and drops English function words", () => {
    const terms = extractTaskTerms("Please check why the code-audit server on port 28080 is not starting");
    assert.ok(terms.includes("code-audit"), "repo name should survive");
    assert.ok(terms.includes("28080"), "port should survive");
    assert.ok(!terms.includes("the"), "function word should be dropped");
    assert.ok(!terms.includes("why"), "function word should be dropped");
  });

  it("turns CJK runs into 2-grams and drops single characters", () => {
    const terms = extractTaskTerms("修复报告渲染");
    assert.ok(terms.includes("修复"));
    assert.ok(terms.includes("报告"));
    assert.ok(terms.includes("渲染"));
    assert.ok(!terms.includes("修"), "single characters do not discriminate");
  });

  it("puts ASCII terms before CJK terms so a cap keeps the cross-lingual signal", () => {
    const terms = extractTaskTerms("看看 IAR-2000 这个任务在 code-audit 里的排队逻辑为什么不动");
    assert.ok(terms.indexOf("iar-2000") < terms.findIndex((term) => !/[a-z0-9]/.test(term)));
  });

  it("is deterministic, de-duplicated, and capped", () => {
    const prompt = `${"alpha beta gamma ".repeat(40)}${"重复词语".repeat(40)}`;
    const first = extractTaskTerms(prompt);
    assert.deepEqual(extractTaskTerms(prompt), first);
    assert.ok(first.length <= MAX_TASK_TERMS);
    assert.equal(new Set(first).size, first.length);
  });

  it("returns nothing for empty or whitespace input", () => {
    assert.deepEqual(extractTaskTerms(""), []);
    assert.deepEqual(extractTaskTerms("   \n\t "), []);
  });
});

describe("scoreTaskRelevance", () => {
  const terms = extractTaskTerms("IAR-2000 sidecar pool cap");

  it("scores a text that shares identifiers higher than one that does not", () => {
    const relevant = scoreTaskRelevance("Implemented IAR-2000 sidecar pool cap layering in session_pool.go", terms);
    const unrelated = scoreTaskRelevance("Use pnpm instead of npm for the web build", terms);
    assert.ok(relevant >= TASK_RELEVANCE_STRONG, `expected a strong score, got ${relevant}`);
    assert.equal(unrelated, 0);
  });

  it("returns 0 with no terms, which callers read as 'no signal'", () => {
    assert.equal(scoreTaskRelevance("anything at all", []), 0);
    assert.equal(scoreTaskRelevance("", terms), 0);
  });

  it("ignores case", () => {
    assert.equal(
      scoreTaskRelevance("IAR-2000 SIDECAR POOL CAP", terms),
      scoreTaskRelevance("iar-2000 sidecar pool cap", terms),
    );
  });
});

describe("buildTaskSearchQuery", () => {
  it("quotes every term so prompt syntax cannot reshape the query", () => {
    const query = buildTaskSearchQuery('check "code-audit" OR NOT x');
    assert.ok(query.length > 0);
    assert.ok(!/\bOR\s+NOT\b/.test(query.replace(/"[^"]*"/g, "")), "operators from the prompt must not leak");
    for (const term of query.split(" OR ")) {
      assert.match(term, /^"[^"]+"$/, `unquoted term: ${term}`);
    }
  });

  it("drops terms shorter than the trigram tokenizer can match", () => {
    const query = buildTaskSearchQuery("恢复");
    assert.equal(query, "", "2-char CJK terms cannot match a trigram index");
  });

  it("returns an empty string when nothing is usable", () => {
    assert.equal(buildTaskSearchQuery("   "), "");
    assert.equal(buildTaskSearchQuery("the and for"), "");
  });
});
