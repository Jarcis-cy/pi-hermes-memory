import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_TASK_TERMS,
  TASK_RELEVANCE_STRONG,
  TaskAnchor,
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

describe("TaskAnchor", () => {
  it("keeps the first task for ordinary follow-ups", () => {
    const anchor = new TaskAnchor();
    const first = anchor.resolve("IAR-2000 sidecar pool 的 instance cap 是怎么分层的？");
    assert.equal(anchor.resolve("那 7 是怎么算出来的"), first, "a follow-up must not re-anchor");
    assert.equal(anchor.resolve("继续"), first);
  });

  it("re-anchors when the prompt introduces a new machine identifier", () => {
    const anchor = new TaskAnchor();
    anchor.resolve("IAR-2000 sidecar pool 的 instance cap 是怎么分层的？");
    const next = anchor.resolve("换个问题：vite 25173 端口代理到哪了");
    assert.match(next, /vite 25173/);
  });

  it("keeps the anchor stable across turns, so the injected block is cacheable", () => {
    const anchor = new TaskAnchor();
    const seen = new Set<string>();
    anchor.resolve("IAR-2000 的 ent schema 迁移顺序是什么");
    for (const followUp of ["继续说", "那 IAR-2000 的迁移呢", "好", "还有别的坑吗"]) {
      seen.add(anchor.resolve(followUp));
    }
    assert.equal(seen.size, 1, "all follow-ups must resolve to the same task text");
  });

  it("treats a prompt carrying only brand-new identifiers as a new task", () => {
    const anchor = new TaskAnchor();
    anchor.resolve("IAR-2000 的 ent schema 迁移顺序是什么");
    assert.match(anchor.resolve("顺手看下 deploy/gs-dev/vite.config.ts 的代理"), /vite\.config\.ts/);
  });

  it("reset() drops the task so the next session starts clean", () => {
    const anchor = new TaskAnchor();
    anchor.resolve("IAR-2000 sidecar pool cap");
    anchor.reset();
    assert.equal(anchor.resolve("完全不同的新任务 hello world"), "完全不同的新任务 hello world");
  });
});
