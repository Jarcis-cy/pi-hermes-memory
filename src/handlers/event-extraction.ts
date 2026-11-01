import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DatabaseManager } from "../store/db.js";
import {
  captureMemoryEvents,
  recordPrincipleFeedback,
  type CaptureEventsResult,
  type EventKind,
  type EventScope,
  type EventSource,
  type MemoryEventDraft,
} from "../store/event-memory-store.js";
import type { MemoryConfig } from "../types.js";
import { execChildPrompt, cleanChildStderr } from "./pi-child-process.js";
import {
  extractPayloadWithArrayKeys,
  runDirectJsonCompletion,
  usesDirectTransport,
} from "./review-memory-ops.js";

const EVENT_SCOPES = new Set<EventScope>(["global", "user", "project"]);
const EVENT_KINDS = new Set<EventKind>([
  "fact",
  "preference",
  "correction",
  "failure",
  "decision",
  "outcome",
  "insight",
  "convention",
  "tool-quirk",
]);

export const EVENT_EXTRACTION_SYSTEM_PROMPT = `You extract episodic memories from a coding-agent conversation.

Your job is to preserve noteworthy concrete events, not to invent permanent rules. Record what happened, what the user decided or corrected, what failed, what succeeded, and stable facts revealed in this episode. A later reflection process will decide whether any event supports a generalized behavioral principle.

Capture an event when forgetting the episode could make later recall, auditing, or reflection materially worse. Task outcomes and one-off corrections are valid episodic memories. Do not discard a useful event merely because it is specific to one task.

Requirements:
- Keep each event concrete and self-contained.
- Use scope "project" only for events tied to the active project, "user" for personal preferences/profile facts, and "global" for cross-project environment or agent facts.
- evidence_quote must be a short verbatim excerpt from the supplied conversation that supports the event. Do not fabricate quotes.
- Do not turn one event into a universal principle or behavioral command.
- Do not create skills, modify memory, or call tools.
- Do not include secrets, credentials, raw tokens, or sensitive authentication data.

Respond with JSON only:
{
  "events": [
    {
      "scope": "project",
      "kind": "correction",
      "content": "Concrete description of what happened",
      "evidence_quote": "Short verbatim supporting quote"
    }
  ]
}

Allowed kind values: fact, preference, correction, failure, decision, outcome, insight, convention, tool-quirk.
If nothing is worth preserving, return {"events":[]}.`;

export interface EventExtractionInput {
  parts: string[];
  projectName?: string | null;
  source: EventSource;
  sourceSessionId?: string | null;
  captureId?: string;
  occurredAt?: string;
  /** Compact "P<id> [scope] summary" lines for the principles that were in
   * force during the episode. When present, the extractor may report which of
   * them the conversation clearly followed or violated; ids are validated
   * against this list before recording. */
  principleIndex?: string[];
}

export interface EventCaptureResult extends CaptureEventsResult {
  ok: boolean;
  transport?: "direct" | "subprocess";
  error?: string;
}

export interface EventExtractionDeps {
  runDirectJsonCompletion?: typeof runDirectJsonCompletion;
  execChildPrompt?: typeof execChildPrompt;
}

export function parseEventExtractionResponse(text: string): MemoryEventDraft[] | null {
  const payload = extractPayloadWithArrayKeys(text, ['events']);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const rawEvents = (payload as { events?: unknown }).events;
  if (!Array.isArray(rawEvents)) return null;

  const events: MemoryEventDraft[] = [];
  for (const raw of rawEvents) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const event = raw as Record<string, unknown>;
    const scope = event.scope as EventScope;
    const kind = event.kind as EventKind;
    const content = typeof event.content === "string" ? event.content.trim() : "";
    const evidenceQuote = typeof event.evidence_quote === "string" ? event.evidence_quote.trim() : "";
    if (!EVENT_SCOPES.has(scope) || !EVENT_KINDS.has(kind) || !content || !evidenceQuote) continue;
    events.push({ scope, kind, content, evidenceQuote });
  }
  return events;
}

export function buildEventExtractionUserPrompt(input: EventExtractionInput): string {
  const feedbackSection = input.principleIndex?.length
    ? [
      "",
      "--- Active Principles (for optional feedback) ---",
      "The agent operated under these principles during the episode:",
      ...input.principleIndex.map((line) => `- ${line}`),
      "If the conversation clearly shows one of the ABOVE principles being followed",
      "(applied) or clearly ignored/contradicted (violated), include an extra key in",
      'your JSON: "principle_feedback": {"applied": [ids], "violated": [ids]}.',
      "Use only ids from the list above, only what is clearly observable, and omit",
      "the key entirely when nothing is clear.",
    ]
    : [];
  return [
    `Source: ${input.source}`,
    `Active project: ${input.projectName?.trim() || "(none)"}`,
    "",
    "--- Conversation Episode ---",
    input.parts.join("\n\n"),
    ...feedbackSection,
  ].join("\n");
}

/** Cap per feedback class, mirroring the review-path accounting: a reviewer
 * that lists dozens of ids is guessing, not observing. */
const FEEDBACK_IDS_PER_CLASS = 20;

/**
 * Parse principle_feedback from an extraction response, restricted to the ids
 * the prompt actually offered.
 *
 * Contract: never invents ids — anything not in `allowedIds` is dropped, so a
 * hallucinated id cannot pollute the strength accounting. Returns empty lists
 * when the key is absent or malformed; feedback problems never fail extraction.
 */
export function parsePrincipleFeedbackIds(
  text: string,
  allowedIds: Set<number>,
): { applied: number[]; violated: number[] } {
  const payload = extractPayloadWithArrayKeys(text, ['events']);
  const raw = (payload as { principle_feedback?: unknown } | null)?.principle_feedback;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { applied: [], violated: [] };
  const record = raw as { applied?: unknown; violated?: unknown };
  const read = (value: unknown): number[] =>
    (Array.isArray(value) ? value : [])
      .map(Number)
      .filter((id) => Number.isSafeInteger(id) && allowedIds.has(id))
      .slice(0, FEEDBACK_IDS_PER_CLASS);
  return { applied: read(record.applied), violated: read(record.violated) };
}

function emptyCapture(captureId = ""): CaptureEventsResult {
  return { captureId, inserted: 0, existing: 0, blocked: 0, eventIds: [], errors: [] };
}

function subprocessPrompt(input: EventExtractionInput): string {
  return [
    EVENT_EXTRACTION_SYSTEM_PROMPT,
    "",
    buildEventExtractionUserPrompt(input),
  ].join("\n");
}

export async function extractAndCaptureEvents(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
  dbManager: DatabaseManager,
  config: Pick<MemoryConfig,
    "reviewTransport" | "llmModelOverride" | "llmThinkingOverride" | "childExtensionPaths"
  >,
  input: EventExtractionInput,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
  deps: EventExtractionDeps = {},
): Promise<EventCaptureResult> {
  const runDirect = deps.runDirectJsonCompletion ?? runDirectJsonCompletion;
  const runChild = deps.execChildPrompt ?? execChildPrompt;
  const timeoutMs = options.timeoutMs ?? 120000;
  let drafts: MemoryEventDraft[] | null = null;
  let transport: "direct" | "subprocess" | undefined;
  let rawText: string | undefined;

  if (usesDirectTransport(config)) {
    try {
      const direct = await runDirect(ctx, {
        systemPrompt: EVENT_EXTRACTION_SYSTEM_PROMPT,
        userPrompt: buildEventExtractionUserPrompt(input),
        config,
        timeoutMs,
        signal: options.signal,
      });
      if (direct.ok) {
        drafts = parseEventExtractionResponse(direct.text);
        if (drafts !== null) {
          transport = "direct";
          rawText = direct.text;
        }
      }
    } catch {
      // Fall through to the isolated subprocess path.
    }
  }

  if (drafts === null) {
    try {
      const child = await runChild(pi, subprocessPrompt(input), config, {
        timeoutMs,
        signal: options.signal,
        jsonOnly: true,
      });
      if (child.code !== 0) {
        const stderrDetail = cleanChildStderr(child.stderr);
        return {
          ...emptyCapture(input.captureId),
          ok: false,
          error: `Event extraction subprocess exited with code ${child.code}${stderrDetail ? `: ${stderrDetail}` : "."}`,
        };
      }
      drafts = parseEventExtractionResponse(child.stdout ?? "");
      if (drafts === null) {
        return {
          ...emptyCapture(input.captureId),
          ok: false,
          error: "Event extraction returned invalid JSON.",
        };
      }
      transport = "subprocess";
      rawText = child.stdout ?? "";
    } catch (error) {
      return {
        ...emptyCapture(input.captureId),
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }


  try {
    const captured = captureMemoryEvents(dbManager, drafts, {
      captureId: input.captureId,
      project: input.projectName,
      source: input.source,
      sourceSessionId: input.sourceSessionId,
      occurredAt: input.occurredAt,
    });
    // Principle usage accounting rides on the same model call, AFTER the
    // capture committed: if capture fails the episode stays pending and will
    // be re-extracted, so recording feedback first would double-count on the
    // retry. Best-effort by design — a feedback hiccup must never lose events.
    if (input.principleIndex?.length && rawText) {
      try {
        const allowed = new Set(
          input.principleIndex
            .map((line) => /^P(\d+)\s/.exec(line.trim())?.[1])
            .filter((id): id is string => Boolean(id))
            .map(Number),
        );
        const feedback = parsePrincipleFeedbackIds(rawText, allowed);
        if (feedback.applied.length || feedback.violated.length) {
          recordPrincipleFeedback(dbManager, feedback);
        }
      } catch {
        // ignored on purpose
      }
    }
    return { ...captured, ok: true, transport };
  } catch (error) {
    return {
      ...emptyCapture(input.captureId),
      ok: false,
      transport,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
