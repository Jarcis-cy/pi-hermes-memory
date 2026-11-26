/**
 * Skill manager tool — registers the LLM-callable `skill_manage` tool for procedural memory.
 * Complements the `memory` tool (declarative knowledge) with procedural knowledge.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { SkillStore } from "../store/skill-store.js";
import { SKILL_TOOL_DESCRIPTION } from "../constants.js";
import { tokenSetSimilarity } from "../store/text-similarity.js";
import { slugify } from "../store/skill-utils.js";
import { createSharedToolResultRenderer } from "./shared-output-view.js";
import { skillResultView } from "./tool-result-views.js";

function normalizeTextList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatOrderedList(items: string[]): string {
  return items.map((item, index) => `${index + 1}. ${item}`).join("\n");
}

function formatBulletList(items: string[], fallback: string): string {
  if (items.length === 0) return `- ${fallback}`;
  return items.map((item) => `- ${item}`).join("\n");
}

/** Similarity at or above this means the new skill restates an existing one:
 * the agent is about to write a second copy of a procedure it already has. */
const SKILL_DUPLICATE_SIMILARITY_THRESHOLD = 0.5;

/** Match text for the duplicate gate: the name carries the trigger, the
 * description carries the discovery signals Pi indexes on. Both are compared so
 * either kind of copy — renamed twin, or same trigger reworded — is caught. */
function skillMatchText(name: string, description: string): string {
  return `${name}\n${description}`;
}

interface DuplicateSkillHit {
  skill: { skillId: string; scope: string; name: string; displayName?: string; path: string };
  similarity: number;
  nameCollision: boolean;
}

/**
 * Is `name` + `description` already covered by a visible skill?
 *
 * Creation used to be judged by how hard the finished task felt, so 189 of 271
 * self-built skills were never opened again. The durable question is whether the
 * procedure will recur, and the cheapest evidence for that is a skill that already
 * exists: an identical name (ignoring case), or a description close enough that
 * this is the same trigger stated twice. Visible = every scope the store lists
 * (project + global), because a project workflow duplicating a global skill is the
 * same waste as duplicating it inside one scope.
 */
async function findDuplicateSkill(
  store: SkillStore,
  name: string,
  description: string,
): Promise<DuplicateSkillHit | null> {
  const index = await store.loadIndex();
  const candidateName = name.trim().toLowerCase();
  const candidateSlug = slugify(name);
  const candidateText = skillMatchText(name, description);

  for (const skill of index) {
    const names = [skill.name, skill.displayName ?? ""].map((value) => value.trim().toLowerCase()).filter(Boolean);
    if (names.includes(candidateName) || (candidateSlug && skill.name === candidateSlug)) {
      return { skill, similarity: 1, nameCollision: true };
    }
  }

  let best: DuplicateSkillHit | null = null;
  for (const skill of index) {
    const similarity = tokenSetSimilarity(candidateText, skillMatchText(skill.displayName || skill.name, skill.description));
    if (similarity < SKILL_DUPLICATE_SIMILARITY_THRESHOLD) continue;
    if (!best || similarity > best.similarity) best = { skill, similarity, nameCollision: false };
  }
  return best;
}

function duplicateSkillError(hit: DuplicateSkillHit): string {
  const skill = hit.skill;
  const label = skill.displayName || skill.name;
  const reason = hit.nameCollision
    ? `skill '${label}' already uses this name`
    : `skill '${label}' is ${(hit.similarity * 100).toFixed(0)}% similar (similarity ${hit.similarity.toFixed(2)})`;
  return `Not created: ${reason} — ${skill.skillId} at ${skill.path}.`
    + " Patch or update that skill instead of creating a second copy; create is for a procedure that recurs and is not covered yet.";
}

function buildStructuredSkillBody(
  whenToUse: string,
  procedureSteps: string[],
  pitfalls: string[],
  verificationSteps: string[],
): string {
  return [
    "## When to Use",
    whenToUse,
    "",
    "## Procedure",
    formatOrderedList(procedureSteps),
    "",
    "## Pitfalls",
    formatBulletList(pitfalls, "No notable pitfalls recorded yet."),
    "",
    "## Verification",
    formatOrderedList(verificationSteps),
  ].join("\n");
}

const SKILL_ID_PARAM = Type.String({
  description: "Stable skill id for view/patch/update/delete. e.g., 'global:debug-typescript-errors' or 'project:my-repo:release-app'. Legacy alias 'edit' also accepts this field.",
});

const SKILL_TOOL_PARAMETERS = Type.Object({
  action: StringEnum(["create", "view", "patch", "update", "edit", "delete"] as const, {
    description: "The skill action to perform.",
  }),
  name: Type.Optional(Type.String({
    description: "Skill name for create. e.g., 'debug-typescript-errors'.",
  })),
  skill_id: Type.Optional(SKILL_ID_PARAM),
  description: Type.Optional(Type.String({
    description: "Discovery-only summary of what the skill does and when to use it. Include the trigger signals a user would actually type (error strings, symptoms, phrasings) — Pi indexes skills by this field alone. Required for create; optional for update/edit; max 1024 chars.",
  })),
  scope: Type.Optional(StringEnum(["global", "project"] as const, {
    description: "Required for create. Use 'global' for portable procedures and 'project' for repo-specific workflows.",
  })),
  section: Type.Optional(Type.String({
    description: "Required for patch. Section header to patch. e.g., 'Procedure', 'Pitfalls', 'Verification', 'When to Use'.",
  })),
  content: Type.Optional(Type.String({
    description: "Raw markdown body for create/update/edit, or Markdown section body for patch. Prefer structured fields over free-form content when possible. For patch, JSON arrays are auto-coerced for list sections; JSON objects are rejected.",
  })),
  when_to_use: Type.Optional(Type.String({
    description: "Structured create/update/edit field, or structured patch body when section is 'When to Use'. Renders into the skill body only — it does not participate in Pi's skill index, so discoverable trigger signals belong in 'description'.",
  })),
  procedure_steps: Type.Optional(Type.Array(Type.String(), {
    description: "Structured create/update/edit field, or structured patch body when section is 'Procedure'. Ordered concrete steps.",
  })),
  pitfalls: Type.Optional(Type.Array(Type.String(), {
    description: "Structured create/update/edit field, or structured patch body when section is 'Pitfalls'.",
  })),
  verification_steps: Type.Optional(Type.Array(Type.String(), {
    description: "Structured create/update/edit field, or structured patch body when section is 'Verification'.",
  })),
}, { additionalProperties: false });

export const SKILL_MANAGE_TOOL_NAME = "skill_manage";

export function registerSkillTool(pi: ExtensionAPI, store: SkillStore): void {
  pi.registerTool({
    name: SKILL_MANAGE_TOOL_NAME,
    label: "Skill Manager",
    description: SKILL_TOOL_DESCRIPTION,
    promptSnippet: "Create, inspect, and update reusable procedures and patterns",
    promptGuidelines: [
      "Create a skill only when the same procedure recurs, the user asks for it, or it is a recurring operational workflow — see WHEN TO CREATE A SKILL.",
      "Use 'create' to save a new reusable procedure, 'patch' to update a section of an existing skill by skill_id, and 'update' for a full rewrite.",
      "Scope is required on create: choose scope='global' for transferable procedures and scope='project' when the workflow depends on this repo's paths, scripts, conventions, or deploy steps.",
      "Prefer structured fields for create/update/patch: when_to_use, procedure_steps, pitfalls, and verification_steps. The tool renders valid SKILL.md sections for you. Put the trigger signals a user would type in 'description' — Pi indexes skills by that field alone.",
      "For patch, pass section plus the matching structured field (e.g. section='Procedure' with procedure_steps). Avoid free-form content that is a JSON array/object string.",
      "Prefer 'update' for multi-section rewrites when patch content would be large or format-unstable.",
      "Use 'view' before patching or updating when you need to inspect an existing skill.",
      "Do NOT use skills for temporary task state — only for durable, reusable procedures.",
    ],
    renderResult: createSharedToolResultRenderer(skillResultView),
    parameters: SKILL_TOOL_PARAMETERS,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const skillParams = params as {
        action: "create" | "view" | "patch" | "update" | "edit" | "delete";
        name?: string;
        skill_id?: string;
        description?: string;
        scope?: "global" | "project";
        section?: string;
        content?: string;
        when_to_use?: string;
        procedure_steps?: unknown;
        pitfalls?: unknown;
        verification_steps?: unknown;
      };
      const {
        action,
        name,
        skill_id,
        description,
        scope,
        section,
        content,
        when_to_use,
        procedure_steps,
        pitfalls,
        verification_steps,
      } = skillParams;

      const whenToUse = typeof when_to_use === "string" ? when_to_use.trim() : "";
      const procedureSteps = normalizeTextList(procedure_steps);
      const pitfallItems = normalizeTextList(pitfalls);
      const verificationSteps = normalizeTextList(verification_steps);
      const hasStructuredBody = Boolean(whenToUse) || procedureSteps.length > 0 || pitfallItems.length > 0 || verificationSteps.length > 0;

      const buildBodyOrError = () => {
        if (content?.trim()) return { body: content.trim() };
        if (!hasStructuredBody) {
          return {
            error: "Either content or structured fields are required. Prefer when_to_use, procedure_steps, pitfalls, and verification_steps for create/update.",
          };
        }
        if (!whenToUse) {
          return { error: "when_to_use is required when content is omitted." };
        }
        if (procedureSteps.length === 0) {
          return { error: "procedure_steps is required when content is omitted." };
        }
        if (verificationSteps.length === 0) {
          return { error: "verification_steps is required when content is omitted." };
        }
        return {
          body: buildStructuredSkillBody(whenToUse, procedureSteps, pitfallItems, verificationSteps),
        };
      };

      let result;
      switch (action) {
        case "create":
          if (!name) {
            return {
              content: [{ type: "text", text: JSON.stringify({ success: false, error: "name is required for 'create' action." }) }],
              details: {},
            };
          }
          if (!description) {
            return {
              content: [{ type: "text", text: JSON.stringify({ success: false, error: "description is required for 'create' action." }) }],
              details: {},
            };
          }
          const createBodyResult = buildBodyOrError();
          if (!createBodyResult.body) {
            return {
              content: [{ type: "text", text: JSON.stringify({ success: false, error: createBodyResult.error }) }],
              details: {},
            };
          }
          if (!scope) {
            return {
              content: [{ type: "text", text: JSON.stringify({ success: false, error: "scope is required for 'create' action. Use 'global' or 'project'." }) }],
              details: {},
            };
          }
          const duplicate = await findDuplicateSkill(store, name, description);
          if (duplicate) {
            const rejection = {
              success: false,
              ok: false,
              error: duplicateSkillError(duplicate),
              conflictType: "duplicate",
              similarSkillIds: [duplicate.skill.skillId],
              suggestedAction: "patch",
            };
            return {
              content: [{ type: "text", text: JSON.stringify(rejection) }],
              details: rejection,
            };
          }
          result = await store.create(name, description, createBodyResult.body, scope);
          break;

        case "view":
          if (!skill_id) {
            const index = await store.loadIndex();
            return {
              content: [{ type: "text", text: JSON.stringify({ success: true, skills: index }) }],
              details: { skills: index },
            };
          }
          const doc = await store.loadSkill(skill_id);
          if (!doc) {
            return {
              content: [{ type: "text", text: JSON.stringify({ success: false, error: `Skill '${skill_id}' not found.` }) }],
              details: {},
            };
          }
          result = { success: true, ...doc };
          break;

        case "patch": {
          if (!skill_id) {
            return {
              content: [{ type: "text", text: JSON.stringify({ success: false, error: "skill_id is required for 'patch' action." }) }],
              details: {},
            };
          }
          if (!section) {
            return {
              content: [{ type: "text", text: JSON.stringify({ success: false, error: "section is required for 'patch' action." }) }],
              details: {},
            };
          }

          const sectionKey = section.replace(/^#+\s*/, "").trim().toLowerCase();
          let patchContent = content?.trim() ?? "";

          // Prefer structured fields matching the target section so the LLM
          // does not have to invent Markdown list formatting.
          if (sectionKey === "procedure" && procedureSteps.length > 0) {
            patchContent = formatOrderedList(procedureSteps);
          } else if (sectionKey === "pitfalls" && pitfallItems.length > 0) {
            patchContent = formatBulletList(pitfallItems, "No notable pitfalls recorded yet.");
          } else if (sectionKey === "verification" && verificationSteps.length > 0) {
            patchContent = formatOrderedList(verificationSteps);
          } else if ((sectionKey === "when to use" || sectionKey === "when_to_use") && whenToUse) {
            patchContent = whenToUse;
          } else if (!patchContent && hasStructuredBody) {
            // Allow a single structured field even if section name is non-standard.
            if (procedureSteps.length > 0 && pitfallItems.length === 0 && verificationSteps.length === 0 && !whenToUse) {
              patchContent = formatOrderedList(procedureSteps);
            } else if (pitfallItems.length > 0 && procedureSteps.length === 0 && verificationSteps.length === 0 && !whenToUse) {
              patchContent = formatBulletList(pitfallItems, "No notable pitfalls recorded yet.");
            } else if (verificationSteps.length > 0 && procedureSteps.length === 0 && pitfallItems.length === 0 && !whenToUse) {
              patchContent = formatOrderedList(verificationSteps);
            } else if (whenToUse && procedureSteps.length === 0 && pitfallItems.length === 0 && verificationSteps.length === 0) {
              patchContent = whenToUse;
            } else {
              return {
                content: [{
                  type: "text",
                  text: JSON.stringify({
                    success: false,
                    error: "For patch, provide content or exactly one structured field matching the target section (procedure_steps, pitfalls, verification_steps, or when_to_use). Use update for multi-section rewrites.",
                  }),
                }],
                details: {},
              };
            }
          }

          if (!patchContent) {
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  success: false,
                  error: "content or a matching structured field is required for 'patch' action. Prefer procedure_steps/pitfalls/verification_steps/when_to_use.",
                }),
              }],
              details: {},
            };
          }

          result = await store.patch(skill_id, section, patchContent);
          break;
        }

        case "update":
        case "edit": {
          const updateActionLabel = action === "edit" ? "edit" : "update";
          if (!skill_id) {
            return {
              content: [{ type: "text", text: JSON.stringify({ success: false, error: `skill_id is required for '${updateActionLabel}' action.` }) }],
              details: {},
            };
          }
          const updateBodyResult = buildBodyOrError();
          const nextDescription = description?.trim() || "";
          const nextBody = updateBodyResult.body ?? content?.trim() ?? "";
          if (!nextDescription && !nextBody) {
            return {
              content: [{ type: "text", text: JSON.stringify({ success: false, error: `Provide description, content, or structured fields for '${updateActionLabel}'.` }) }],
              details: {},
            };
          }
          if (hasStructuredBody && !updateBodyResult.body) {
            return {
              content: [{ type: "text", text: JSON.stringify({ success: false, error: updateBodyResult.error }) }],
              details: {},
            };
          }
          result = await store.edit(skill_id, nextDescription, nextBody);
          break;
        }

        case "delete":
          if (!skill_id) {
            return {
              content: [{ type: "text", text: JSON.stringify({ success: false, error: "skill_id is required for 'delete' action." }) }],
              details: {},
            };
          }
          result = await store.delete(skill_id);
          break;

        default:
          result = {
            success: false,
            error: `Unknown action '${action}'. Use: create, view, patch, update, delete`,
          };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  });
}
