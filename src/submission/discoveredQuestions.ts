import { createHash } from "node:crypto";
import type { DraftAnswer } from "../domain/job.js";
import { bankAnswerFor, type ApprovedAnswerEntry } from "./formFields.js";

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
 * Strips the diagnostic note a run appends to an unfillable field.
 *
 * A report says why a field failed - the options it offered, the controls it
 * is built from, the reason a fill threw - and that text varies between runs.
 * Keyed on the annotated label, the same question is rediscovered under a new
 * key every attempt, so an answer supplied after one run never matches the
 * next and the blocked list grows without bound. The employer's own wording is
 * the question; everything in the trailing bracket is this tool talking.
 */
const DIAGNOSTIC_NOTE = /\s*\[(?:options|controls?|fill failed|answered)\b[\s\S]*$/i;

export function questionLabelOf(reported: string): string {
  return reported.replace(DIAGNOSTIC_NOTE, "").trim();
}

/**
 * A run's own status lines, which are reported alongside unfillable fields but
 * are not questions any employer asked. Recorded as questions they become
 * required human answers that block every later run until something is typed
 * into them, and answering "N/A" to "the step would not advance" resolves
 * nothing.
 */
const RUN_DIAGNOSTIC = /^(?:current step \d+ of \d+\b|resume\/cv \(upload did not take\)$)/i;

/**
 * Fields belonging to the ATS account itself rather than to the employer's
 * application. A signed-out session drops the run onto a sign-in or
 * create-account screen, whose fields are then reported as unfilled and
 * required. They are credentials, not questions: recording them asks the
 * candidate to "answer" a password prompt, and the blank answer then vetoes
 * every later run of an application that has nothing wrong with it.
 */
const ACCOUNT_FIELD =
  /^(?:(?:verify |confirm |re-?enter |new )*password|email address|username|user name)\b/i;

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
 *
 * Every reported label is recorded, even one the standing bank seems to answer:
 * the run already had the bank and still could not fill the field, so skipping
 * it would leave nothing for a person to answer and the next run would fail
 * the same way.
 *
 * `bank` is the candidate's standing approved answers. A blank block the bank
 * can now answer, or one that is not an employer question at all, is dropped
 * when a later run merges. That only tidies blocks that do not stop a run: the
 * submission guard refuses a packet with a blank required question before any
 * run starts, so a required block has to be answered with
 * set_application_content.
 */
export function mergeDiscoveredQuestions(
  existing: DraftAnswer[],
  labels: readonly string[],
  bank: readonly ApprovedAnswerEntry[] = [],
): DraftAnswer[] {
  const answerable = (label: string): boolean =>
    bank.length > 0 && bankAnswerFor(label, bank) !== undefined;
  const notAQuestion = (label: string): boolean =>
    RUN_DIAGNOSTIC.test(label) || ACCOUNT_FIELD.test(label);

  const merged = existing.filter(
    (answer) =>
      !(
        answer.source === "blocked" &&
        !answer.answer.trim() &&
        (answerable(answer.label) || notAQuestion(answer.label))
      ),
  );
  const seenKeys = new Set(merged.map((answer) => answer.questionKey));
  const seenLabels = new Set(merged.map((answer) => normalizeLabel(answer.label)));

  for (const raw of labels) {
    const label = questionLabelOf(raw);
    if (!label) continue;
    if (notAQuestion(label)) continue;
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
