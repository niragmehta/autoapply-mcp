import type { DraftAnswer } from "../domain/job.js";
import { sourceAnswerMismatch } from "./sourceQuestion.js";
import { isAiDetectionPrompt } from "./form/answerBank.js";
import { PLACEHOLDER_ANSWER } from "./form/fallbackAnswers.js";
import {
  alreadyAnswered, groupIdentity, normalizeLabel, type FieldDescriptor, type FieldMatch,
} from "./form/fieldModel.js";
import { matchFields } from "./form/matching.js";
import { pickOptionIndex } from "./form/optionMatching.js";
import { optionSearchCandidates } from "./form/optionSearch.js";
import { MIN_CONFIDENCE, similarity } from "./form/similarity.js";

/**
 * Field matching for web forms, kept free of browser APIs so it can be tested
 * directly.
 */

const TEXT_ENTRY_TYPES = new Set(["text", "url", "email", "tel", "search", "textarea"]);

/** Where each named service's profile addresses live. */
const LINK_SERVICE_HOSTS: ReadonlyArray<readonly [string, RegExp]> = [
  ["linkedin", /\blinkedin\.com\b/i],
  ["github", /\bgithub\.com\b/i],
  ["twitter", /\b(?:twitter|x)\.com\b/i],
  ["facebook", /\b(?:facebook|fb)\.com\b/i],
  ["instagram", /\binstagram\.com\b/i],
];

/**
 * An optional link field whose label names one service while it holds another
 * service's address. KLA's "Please provide your Facebook profile:" ended up with
 * the LinkedIn URL, failed Workday's URL check and held My Experience, though
 * the field is optional. An address for the wrong account answers nothing.
 */
function holdsOtherServiceLink(field: FieldDescriptor): boolean {
  const label = normalizeLabel(field.label).replace(/\s+/g, "");
  const named = LINK_SERVICE_HOSTS.filter(([service]) => label.includes(service));
  if (named.length !== 1) return false;
  const value = (field.value ?? "").trim();
  const held = LINK_SERVICE_HOSTS.find(([, host]) => host.test(value));
  return held !== undefined && held[0] !== named[0]![0];
}

/**
 * Optional text fields still holding a placeholder that nothing now fills.
 * Workday keeps a draft's values between runs, so the "N/A" an earlier run
 * typed into Zendesk's "Twitter (Optional)" stayed, failed URL validation and
 * held My Experience on every later attempt. An empty optional field says
 * the same thing and passes. A link to the wrong service is cleared the same way.
 */
export function stalePlaceholderFields(fields: readonly FieldDescriptor[], plan: FillPlan): FieldDescriptor[] {
  const planned = new Set(plan.toFill.map((match) => match.field.selectorIndex));
  return fields.filter(
    (field) =>
      field.required === false &&
      field.role !== "combobox" &&
      TEXT_ENTRY_TYPES.has(field.type) &&
      !planned.has(field.selectorIndex) &&
      (PLACEHOLDER_ANSWER.test((field.value ?? "").trim()) || holdsOtherServiceLink(field)),
  );
}

export type FillPlan = {
  toFill: FieldMatch[];
  unmatchedRequired: FieldDescriptor[];
  /** Every visible field nothing filled, so a reviewer knows what is left. */
  unfilled: FieldDescriptor[];
  unusedAnswers: DraftAnswer[];
};

/** Fills controls that may re-render the form only after stable text inputs. */
export function orderFieldsForBrowser(matches: readonly FieldMatch[]): FieldMatch[] {
  return [...matches].sort((left, right) => {
    const leftStateful = left.field.type === "checkbox" || left.field.type === "radio" ? 1 : 0;
    const rightStateful = right.field.type === "checkbox" || right.field.type === "radio" ? 1 : 0;
    return leftStateful - rightStateful;
  });
}

/**
 * Radios arrive one descriptor per option, and grouped checkboxes do too. Reduce
 * each group to the single option that states the approved answer, and report an
 * unfilled required group once rather than once per option.
 *
 * Checkboxes have to be collapsed for a stronger reason than tidiness. Nothing
 * stops several options in one "select all that apply" group from each matching
 * the same answer on their shared question label, and every one of them was then
 * ticked: a demographic survey came back claiming every ethnicity and every
 * orientation at once, alongside both "None of the above" and "I prefer not to
 * answer". A single stored answer names a single option, so exactly one is
 * selected - over-ticking a group states things about the candidate that are not
 * true.
 */
function collapseOptionGroups(
  matches: readonly FieldMatch[],
  answers: readonly DraftAnswer[],
): FieldMatch[] {
  const groups = new Map<string, FieldMatch[]>();
  const out: FieldMatch[] = [];
  for (const match of matches) {
    const key = groupIdentity(match.field);
    if (!key) {
      out.push(match);
      continue;
    }
    const existing = groups.get(key);
    if (existing) existing.push(match);
    else groups.set(key, [match]);
  }

  for (const group of groups.values()) {
    const optionLabels = group.map((match) => match.field.optionLabel ?? "");
    const head = group[0]!;
    // Each option is scored alone, so an option the group's own answer
    // contradicts reaches for a neighbouring question's answer instead.
    // Betterment's "Yes" box under "Are you currently based in the NYC metro
    // area?" refused the stored "No" and took the next question's relocation
    // "Yes" at 0.63, while the "No" box held the group's own answer at 1.00;
    // taking the first box's answer said the candidate lived in New York. The
    // answer the group matched best is the group's answer.
    const matched =
      group
        .filter((match) => match.answer !== null)
        .reduce<FieldMatch | undefined>((best, match) => (!best || match.confidence > best.confidence ? match : best), undefined)
        ?.answer ?? null;

    // A group's answer has to name one of its options. Ashby labels the SMS
    // consent radios "Phone Number", so the phone number itself matches first
    // and selects nothing; fall through to answers that do name an option.
    const candidates: DraftAnswer[] = [];
    if (matched) candidates.push(matched);
    for (const answer of answers) {
      if (answer === matched) continue;
      if (sourceAnswerMismatch(normalizeLabel(head.field.label), normalizeLabel(answer.label))) continue;
      if (similarity(head.field.label, answer.label) < MIN_CONFIDENCE) continue;
      candidates.push(answer);
    }

    let selected: { index: number; answer: DraftAnswer } | undefined;
    // A "select all that apply" box group can hold several true answers: GEICO's
    // "Please select all days you are able to work" ticked Monday alone from
    // "Monday through Friday". An answer that lists options with semicolons
    // ticks each of them - only when every item names a distinct option
    // exactly, so nothing beyond what the answer states is ever ticked, and
    // never for radios, which hold one choice by construction.
    const listed = head.field.type === "checkbox" ? listedOptions(optionLabels, candidates) : null;
    if (listed) {
      for (const { index, answer } of listed) {
        out.push({ ...group[index]!, answer, confidence: similarity(head.field.label, answer.label) });
      }
      continue;
    }
    for (const answer of candidates) {
      const index = pickOptionIndex(optionLabels, optionSearchCandidates(head.field, answer));
      if (index >= 0) {
        selected = { index, answer };
        break;
      }
    }

    if (!selected) {
      // Wording rules only ever see one option of the group - the head - so a
      // decision spelled out in a later option is invisible to them. Abridge
      // asks "Where in the United States will you be working from?" and puts
      // "willing to relocate" in the second option; nothing matched and a
      // required question was left unanswered with no explanation. Retry once
      // with the whole group's wording visible. This can only turn a miss into
      // a match - the candidates it produces are still checked against the real
      // option labels by the same rules - so no existing choice can change.
      const groupField = { ...head.field, optionLabel: optionLabels.join(" ") };
      for (const answer of candidates) {
        const index = pickOptionIndex(optionLabels, optionSearchCandidates(groupField, answer));
        if (index >= 0) {
          selected = { index, answer };
          break;
        }
      }
    }

    if (!selected) {
      // The head stands in for the whole group, so it has to carry the group's
      // state: a question already answered on a later option is not missing.
      const answered = head.field.value !== "checked" && group.some((match) => match.field.value === "checked");
      out.push({ ...head, field: answered ? { ...head.field, value: "checked" } : head.field, answer: null });
      continue;
    }
    out.push({
      ...group[selected.index]!,
      answer: selected.answer,
      confidence: similarity(head.field.label, selected.answer.label),
    });
  }
  return out;
}

/**
 * The options a semicolon-separated answer names, one per item, or null unless
 * the answer lists at least two items and each names a distinct option exactly.
 */
function listedOptions(
  optionLabels: readonly string[],
  candidates: readonly DraftAnswer[],
): Array<{ index: number; answer: DraftAnswer }> | null {
  for (const answer of candidates) {
    const items = answer.answer.split(";").map((item) => item.trim()).filter((item) => item.length > 0);
    if (items.length < 2) continue;
    const indexes = items.map((item) => optionLabels.findIndex((label) => normalizeLabel(label) === normalizeLabel(item)));
    if (indexes.some((index) => index < 0) || new Set(indexes).size !== indexes.length) continue;
    return indexes.map((index) => ({ index, answer: { ...answer, answer: optionLabels[index]! } }));
  }
  return null;
}

/**
 * Whether an option control belongs to a group, so the plan chose it with every
 * sibling option in view. A band such as "6-10 years" answers 7, and "Other"
 * answers an unlisted province, only beside the options they were chosen over.
 */
export function isGroupedOption(field: FieldDescriptor): boolean {
  return groupIdentity(field) !== undefined;
}

/** Builds a plan and reports required fields that nothing can safely fill. */
export function buildFillPlan(fields: readonly FieldDescriptor[], answers: readonly DraftAnswer[]): FillPlan {
  const matches = collapseOptionGroups(matchFields(fields, answers), answers).map((match) =>
    isAiDetectionPrompt(match.field.label) || isAiDetectionPrompt(match.field.questionLabel ?? "")
      ? { ...match, answer: null }
      : match,
  );
  const used = new Set(
    matches.filter((match) => match.answer !== null).map((match) => match.answer!.questionKey),
  );
  const unfilled = matches.filter(
    (match) =>
      match.field.type !== "file" &&
      (match.answer === null || match.answer.answer.trim().length === 0),
  );
  return {
    toFill: matches.filter((match) => match.answer !== null && match.answer.answer.trim().length > 0),
    // A field marked notApplicable is finished, not missing. "If yes, please
    // describe" after a "No" has nothing to describe, and reporting it as
    // unfillable aborted an application that was in fact complete.
    unmatchedRequired: unfilled
      .filter((match) => match.field.required && match.answer?.notApplicable !== true)
      .filter((match) => !alreadyAnswered(match.field))
      .map((match) => match.field),
    unfilled: unfilled.map((match) => match.field),
    unusedAnswers: answers.filter((answer) => !used.has(answer.questionKey)),
  };
}
