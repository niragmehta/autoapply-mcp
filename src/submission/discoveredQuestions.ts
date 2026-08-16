import { createHash } from "node:crypto";
import type { DraftAnswer } from "../domain/job.js";

/**
 * Only Greenhouse publishes a question schema ahead of time. On Lever, Ashby
 * and Workday the employer's own questions exist only on the rendered page, so
 * a run is the first moment anything knows they are there. When such a run
 * aborts, the labels it read were previously written into a free-text note and
 * nowhere else, which made the abort a dead end: there was no question key for
 * set_application_content to target, so the next run rediscovered exactly the
 * same fields and aborted identically. Recording them as real draft questions
 * turns one wasted run into the discovery step of answer-then-resubmit.
 */
const DISCOVERED_KEY_PREFIX = "discovered_";

const DISCOVERED_GUIDANCE =
  "Read off the live application form during a submission run. Answer it with set_application_content, then approve and submit again.";

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Derived from the label rather than allocated, so the same question keeps the
 * same key across runs. An answer supplied after the first abort therefore
 * still matches on the second, instead of being orphaned by a fresh key.
 */
export function discoveredQuestionKey(label: string): string {
  const digest = createHash("sha1").update(normalizeLabel(label)).digest("hex");
  return `${DISCOVERED_KEY_PREFIX}${digest.slice(0, 16)}`;
}

export function isDiscoveredQuestionKey(key: string): boolean {
  return key.startsWith(DISCOVERED_KEY_PREFIX);
}

/**
 * Adds a blocked, human-answerable question for each field the live form
 * required and the packet could not fill. Existing answers are never
 * overwritten - a question already answered by hand keeps that answer even
 * though the field failed to fill for some other reason - and a label already
 * present under any key is not duplicated.
 */
export function mergeDiscoveredQuestions(existing: DraftAnswer[], labels: readonly string[]): DraftAnswer[] {
  const merged = [...existing];
  const seenKeys = new Set(existing.map((answer) => answer.questionKey));
  const seenLabels = new Set(existing.map((answer) => normalizeLabel(answer.label)));

  for (const raw of labels) {
    const label = raw.trim();
    if (!label) continue;
    const normalized = normalizeLabel(label);
    const key = discoveredQuestionKey(label);
    if (seenKeys.has(key) || seenLabels.has(normalized)) continue;
    seenKeys.add(key);
    seenLabels.add(normalized);
    merged.push({
      questionKey: key,
      label,
      answer: "",
      source: "blocked",
      citation: "",
      requiresHuman: true,
      required: true,
      category: "employer-specific",
      guidance: DISCOVERED_GUIDANCE,
    });
  }

  return merged;
}
