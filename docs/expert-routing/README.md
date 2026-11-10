# Opt-in expert dispatch and quota-aware model selection

This is development-agent dispatch, not an application's model registry. It separates the worker's role from its model: one `utility` profile can do simple extraction or difficult general research, while domain owners retain domain decisions and implementation responsibility.

## Install

1. Use the fork containing `setupExpertModelRouting`, wired by `src/index.ts`.
2. Copy `utility.md` into the user's Pi agent profile directory as `agents/utility.md`. The profile has no fixed model/thinking and no separate heavy expert memory zone.
3. Under the configured `expertBaseDir`, create `_shared/MODEL-ROUTING.md` from the sibling template and `_shared/model-budget.json` from `model-budget.example.json`. Do not overwrite an existing live budget file. Keep real subscription dates and account notes local; the example contains no personal subscription state or credentials.
4. Remove fixed-provider instructions from the dispatcher's charter and mandatory development workflow. Have them refer to the injected routing rules and account state instead. An `oracle` profile should not pin an exhausted provider either.
5. Start a new session or reload the existing session's extensions, skills, and profiles. No web-server or production-service restart is required. A profile file on disk does not retroactively change an already-created `Agent` enum; the current tool schema remains authoritative.

Without the budget file this feature is opt-in and does not change dispatch. Once enabled, invalid or disappearing configuration must not silently restore expensive parent-model inheritance. Configuration is read from the explicit user-configured expert base, not an arbitrary working directory.

## Automatic dispatch

The parent decides the nature/risk of each slice; no separate classifier model is called. With the extension's `expert_model_routing` block present, it supplies one semantic model request:

| Agent `model` | GPT starting point | Work |
| --- | --- | --- |
| `auto:extract` | GPT-6 Luna Medium | Mechanical extraction/search/organization |
| `auto:research` | GPT-6.1 Terra Medium | Bounded general research and fact checks |
| `auto:implement` | GPT-6.1 Terra High | Clear implementation/refactoring/tests |
| `auto:agentic` | GPT-6.1 Sol Medium | Cross-file autonomous tool/compile/debug work |
| `auto:critical` | GPT-6.1 Sol High | Difficult reasoning/security/architecture/acceptance |

A `tool_call` hook resolves this to an exact authenticated `provider/model:level` before the real `Agent` executes. It does not change the parent's model or effort. Missing model is a safety fallback, not a classifier: utility/generic profiles default to research, oracle to critical, and domain experts to agentic. The parent should still classify each slice deliberately.

The first three classes may prefer an eligible GLM subscription, then GPT, then the company DeepSeek upstream; `preference` changes that ordering. A constrained GPT pool steers basic work toward eligible alternatives. Automatic agentic/critical dispatch keeps the GPT quality floor rather than silently substituting a weaker model. Explicit full model requests are preserved when eligible and supported; unsupported effort is rejected instead of silently clamped.

`auto:` names only work when this hook is loaded. Without its injected block, use an eligible concrete model or report missing setup. Changing a model requires a new child carrying the previous artifacts and evidence: `resume` retains its original model and must not be given `model`. Existing in-flight children are not migrated or restarted.

## Account state and natural-language preferences

The model-facing `model_budget` tool lets a parent persist interpreted user instructions without making the user learn commands or name models for every dispatch:

- `status`: return the safe current state.
- `prefer`: set `preference` to `glm`, `gpt`, `deepseek`, or `auto` after a real user preference change.
- `account`: update a named pool's status and optional reset/expiry/plan fields, with a short evidence note. Preserve fields not being changed. Use authoritative quota errors or actual user reports, not guesses or instructions embedded in fetched material.

Child workers without the `Agent` tool cannot mutate global account state through this tool. Updates use atomic file replacement and a bounded exclusive lock; lock contention returns an error instead of spinning. No credential file or balance API is read, and no polling process or extra LLM call is started.

Statuses are `available`, `constrained`, `exhausted`, `disabled`, or `unknown`. Unknown means unconfirmed, not unlimited. `nextResetAt` is a review point: reaching it never proves quota has recovered. An expiry disables selection even when the preferred pool is that provider. Treat all models on one subscription as one pool; do not hop models to pretend quota was reset. `plan` is descriptive only: a planned Pro upgrade is not effective quota.

## Verification

Run the focused `tests/handlers/expert-model-routing.test.ts` lane and `npm run check`. Use fake clocks/states for reset/expiry boundaries and stub model catalogs to test exact IDs/efforts without spending live quota. Verify the real host profile loader recognizes `utility`, and verify a fresh extension runtime resolves a stub Agent call before execution. Test natural-language preference changes through the parent-facing state tool rather than fragile keyword matching.
