import type { DraftAnswer } from "../../domain/job.js";
import {
  bestBankEntry, isReservedForHuman, type ApprovedAnswerEntry, type NarrativeResolver, type PersonalResolver,
} from "./answerBank.js";
import { isIncompatible } from "./compatibility.js";
import { groupIdentity, signatureDateField, type FieldDescriptor } from "./fieldModel.js";
import { matchFields } from "./matching.js";
import { pickOptionIndex } from "./optionMatching.js";
import { optionSearchCandidates } from "./optionSearch.js";

/**
 * Only Greenhouse publishes a question schema, so Ashby and Lever packets are
 * drafted against a baseline field set and omit questions the live page does in
 * fact ask. Draw those extra answers from the pre-approved bank, matched by the
 * same patterns drafting uses, so the reviewer is handed a complete form.
 *
 * Longest pattern wins, mirroring drafting, so a specific entry is never
 * pre-empted by a generic one.
 *//** Views a bank entry as a draft answer so shared compatibility rules apply. */
function bankEntryAsAnswer(entry: ApprovedAnswerEntry): DraftAnswer {
  return {
    questionKey: entry.key,
    label: entry.label,
    answer: entry.answer,
    source: "approved-answer",
    citation: `profile.answers.${entry.key}`,
    requiresHuman: false,
    required: true,
    category: "general",
    guidance: "",
    ...(entry.whenNoDecline ? { whenNoDecline: entry.whenNoDecline } : {}),
  };
}

/**
 * A bank entry states its answer once and lists the other wordings the
 * candidate approved for the same decision, because option lists do not agree
 * on how to say it. Drafting already tries each approved wording against a
 * Greenhouse question's published choices; the live form only ever offered the
 * first. Adobe's Workday asks "Have you ever worked at Adobe in the following
 * capacity:" and offers "Employee", "Intern", "Temporary Agency or Vendor",
 * "Other" and "I have not worked for Adobe in the past." The stored "No" names
 * none of them, so a question already answered - as "I have not worked" - was
 * left blank and held the wizard at its questionnaire step.
 *
 * Only an option group is widened, and only to a wording that names one of its
 * options under the same guards as any other answer. A text box still takes
 * the answer exactly as stored.
 */
function bankWordingForField(
  field: FieldDescriptor,
  entry: ApprovedAnswerEntry,
  fields: readonly FieldDescriptor[],
): string {
  const identity = groupIdentity(field);
  const alternatives = entry.alternatives ?? [];
  if (!identity || alternatives.length === 0) return entry.answer;
  const options = fields
    .filter((other) => groupIdentity(other) === identity)
    .map((other) => other.optionLabel ?? "");
  const asAnswer = { ...bankEntryAsAnswer(entry), label: field.label };
  for (const wording of [entry.answer, ...alternatives]) {
    if (wording.trim().length === 0) continue;
    if (pickOptionIndex(options, optionSearchCandidates(field, { ...asAnswer, answer: wording })) >= 0) {
      return wording;
    }
  }
  return entry.answer;
}

/**
 * Greenhouse renders education and employment as repeatable blocks whose
 * controls share one label vocabulary: both call the graduation year and the
 * year a job ended "End date year". Affirm's form aborted on that field with
 * the answer sitting in the profile the whole time, because no resolver pattern
 * matches "End date year" and matching it loosely would put a graduation year
 * into a job history.
 *
 * The block is only identifiable from the DOM id, where the trailing index ties
 * a date control to the `school--N` or `company--N` it belongs to. A date is
 * only re-labelled when its own index has a school and no company, so a form
 * that numbers both blocks alike is left alone rather than answered wrongly.
 */
const EDUCATION_DATE_ID = /^end-year--(\d+)$/;

/**
 * Every date control of an education block, paired with the synthetic label
 * that reaches the right profile value. The graduation year keeps its original
 * wording so answers already bound to it are unaffected.
 */
const EDUCATION_DATE_IDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^start-month--(\d+)$/, "Education start month"],
  [/^start-year--(\d+)$/, "Education start year"],
  [/^end-month--(\d+)$/, "Education end month"],
  [EDUCATION_DATE_ID, "Graduation year"],
];

export function educationDateLabels(fields: readonly FieldDescriptor[]): Map<number, string> {
  const blocks = new Set<string>();
  const employment = new Set<string>();
  for (const field of fields) {
    const id = field.domId ?? "";
    const school = /^school--(\d+)$/.exec(id);
    if (school) blocks.add(school[1]!);
    const company = /^company--(\d+)$/.exec(id);
    if (company) employment.add(company[1]!);
  }
  const overrides = new Map<number, string>();
  for (const field of fields) {
    const id = field.domId ?? "";
    for (const [pattern, label] of EDUCATION_DATE_IDS) {
      const match = pattern.exec(id);
      if (!match) continue;
      const index = match[1]!;
      if (blocks.has(index) && !employment.has(index)) overrides.set(field.selectorIndex, label);
      break;
    }
  }
  return overrides;
}

function todayForSignature(): string {
  const now = new Date();
  const pad = (part: number): string => String(part).padStart(2, "0");
  return `${pad(now.getMonth() + 1)}/${pad(now.getDate())}/${now.getFullYear()}`;
}

/** A stored answer that states nothing, standing in for "no answer". */
export const PLACEHOLDER_ANSWER = /^(?:n\/?a|none|not applicable|-+)\.?$/i;

export function fallbackAnswersForFields(
  fields: readonly FieldDescriptor[],
  answers: readonly DraftAnswer[],
  bank: readonly ApprovedAnswerEntry[],
  resolvePersonalAnswer?: PersonalResolver,
  resolveNarrativeAnswer?: NarrativeResolver,
  resolveExperienceAnswer?: PersonalResolver,
): DraftAnswer[] {
  const eligible = bank.filter((entry) => entry.allowAutoFill && entry.answer.trim().length > 0);
  // A signature date needs no bank entry - it is today by definition - so the
  // shortcut below must not skip a form that has one.
  if (
    eligible.length === 0 &&
    !resolvePersonalAnswer &&
    !resolveNarrativeAnswer &&
    !resolveExperienceAnswer &&
    !fields.some(signatureDateField)
  )
    return [];

  const alreadyAnswered = new Set(answers.map((entry) => entry.questionKey));
  const matched = matchFields(fields, answers);
  const resolverLabels = educationDateLabels(fields);
  const derived: DraftAnswer[] = [];
  const used = new Set<string>();

  for (const match of matched) {
    // The resolvers only ever see a label, so an ambiguous one is replaced by
    // the question the control actually asks. The derived answer keeps the live
    // label so it still binds to this field.
    const resolverLabel = resolverLabels.get(match.field.selectorIndex) ?? match.field.label;
    if (match.answer !== null && match.answer.answer.trim().length > 0) {
      // A radio option counts as answered only if the matched answer actually
      // names it. Ashby's consent radios are labelled "Phone Number", so the
      // phone number matches them without selecting anything.
      const isOption = match.field.type === "radio" && Boolean(match.field.optionLabel);
      const names =
        !isOption ||
        pickOptionIndex([match.field.optionLabel ?? ""], optionSearchCandidates(match.field, match.answer)) >= 0;
      if (names) continue;
    }
    // A form the candidate signs carries the date it was signed, which is today
    // and nothing else. No stored answer can supply it, and leaving it blank
    // stops the disability form from saving. It is decided before employment
    // history: PayPal's declaration asking for today's date also says
    // "disqualified from being considered for employment", which the
    // employment resolver read as a start date.
    if (signatureDateField(match.field)) {
      derived.push({
        questionKey: `signature-date#${match.field.selectorIndex}`,
        label: match.field.label,
        answer: todayForSignature(),
        source: "profile",
        citation: "system.today",
        requiresHuman: false,
        required: match.field.required ?? true,
        category: "general",
        guidance: "",
      });
      continue;
    }

    // Employment history first: these labels are exact, and they name the
    // position being left rather than the one being applied for, so no broader
    // bank pattern should be able to win them.
    //
    // A question reserved for a person takes no answer the profile merely
    // happens to hold. Expedia's undertaking not to use AI tools mentions a
    // "disability accommodation", and the stored disability status answered it.
    // Only a bank entry written about the same subject may, under the rule
    // bestBankEntry applies.
    const reserved = isReservedForHuman(match.field.label) || isReservedForHuman(match.field.questionLabel ?? "");
    const experience = reserved ? null : resolveExperienceAnswer?.(resolverLabel);
    // Standalone controls are pinned to the answer derived for them; option
    // groups bind by label because each option arrives as its own field.
    const pinned = match.field.optionLabel ? {} : { fieldIndex: match.field.selectorIndex };
    if (experience && experience.authorized && experience.answer.trim().length > 0) {
      // Start month and start year cite the same profile value, so the citation
      // alone would let one control spend the other's answer.
      const usedKey = `${experience.citation}#${match.field.selectorIndex}`;
      if (!used.has(usedKey)) {
        used.add(usedKey);
        derived.push({
          questionKey: experience.citation,
          label: match.field.label,
          answer: experience.answer,
          source: "profile",
          citation: experience.citation,
          requiresHuman: false,
          required: match.field.required ?? true,
          category: experience.category,
          guidance: "",
          ...pinned,
        });
      }
      continue;
    }
    // A current role's end date is blank on purpose and "Current role" is
    // ticked instead. Handing the field on let Zuora's employment "End date
    // year" take the graduation year, which the board refused as ending before
    // the job began.
    if (experience && experience.authorized && experience.citation.endsWith(".end")) {
      derived.push({
        questionKey: experience.citation,
        label: match.field.label,
        answer: "",
        source: "profile",
        citation: experience.citation,
        requiresHuman: false,
        required: match.field.required ?? true,
        notApplicable: true,
        category: experience.category,
        guidance: "",
        ...pinned,
      });
      continue;
    }

    const entry = bestBankEntry(match.field, eligible);
    // An optional field the candidate has nothing for is left empty. Zendesk's
    // Workday took "N/A" for "Twitter (Optional)", rejected it as an invalid
    // URL and would not leave My Experience; a placeholder says no more than
    // the empty field does.
    if (entry && match.field.required === false && PLACEHOLDER_ANSWER.test(entry.answer.trim())) continue;
    // A bank entry that cannot serve this field is no reason to leave the field
    // blank - the personal and narrative resolvers below may still hold the
    // right answer. Abridge asks "Which state do you currently reside in?"; a
    // bank entry matched and was correctly rejected as a work-authority answer
    // to a residence question, but the `continue` that followed also discarded
    // personal.address.region, which is exactly the answer wanted. The required
    // field went unanswered and the submission aborted with nothing to show for
    // it. Rejecting a candidate answer must fall through to the next source, not
    // veto the field.
    if (entry && !isIncompatible(match.field, bankEntryAsAnswer(entry))) {
      // Radio options arrive one field per option, so a bank answer may only be
      // spent once across them. Standalone controls are independent, and forms
      // do repeat them - two acknowledgement boxes, or "LinkedIn" alongside
      // "LinkedIn Profile" - so there the same answer may serve each field.
      const usedKey = match.field.optionLabel ? entry.key : `${entry.key}#${match.field.selectorIndex}`;
      // For a standalone control this loop is only reached when the field is
      // still empty, so the packet already holding this key is not a reason to
      // leave it that way. Ashby's baseline field set labels the entry
      // "LinkedIn Profile" while the live page asks for "LinkedIn URL"; the
      // packet answer bound to nothing, and treating the key as spent left a
      // required field blank and aborted the submission. Option groups keep the
      // stricter rule, where spending a bank answer twice can contradict the
      // packet.
      const spent = match.field.optionLabel ? used.has(usedKey) || alreadyAnswered.has(entry.key) : used.has(usedKey);
      if (!spent) {
        used.add(usedKey);
        derived.push({
          questionKey: entry.key,
          // The live label guarantees this answer binds to the field it was chosen for.
          label: match.field.label,
          answer: bankWordingForField(match.field, entry, fields),
          source: "approved-answer",
          citation: `profile.answers.${entry.key}`,
          requiresHuman: false,
          required: match.field.required ?? true,
          category: "general",
          guidance: "",
          ...(entry.whenNoDecline ? { whenNoDecline: entry.whenNoDecline } : {}),
        });
        continue;
      }
    }

    if (reserved) continue;
    const personal = resolvePersonalAnswer?.(resolverLabel);
    if (personal && personal.authorized && personal.answer.trim().length > 0) {
      // Radios arrive one field per option, so an option group keys on the
      // citation to answer once. Standalone controls key on the field: an
      // education start month and start year cite the same profile value, and
      // keying the year on the citation alone left it unanswered, so the final
      // match typed the month name into the year's number box.
      const isOptionGroup = Boolean(match.field.optionLabel);
      const usedKey = isOptionGroup ? personal.citation : `${personal.citation}#${match.field.selectorIndex}`;
      const spent = isOptionGroup ? used.has(usedKey) || alreadyAnswered.has(personal.citation) : used.has(usedKey);
      if (spent) continue;
      used.add(usedKey);
      derived.push({
        questionKey: personal.citation,
        label: match.field.label,
        answer: personal.answer,
        source: "profile",
        citation: personal.citation,
        requiresHuman: false,
        required: match.field.required ?? true,
        category: personal.category,
        guidance: "",
        ...(personal.whenNoDecline ? { whenNoDecline: personal.whenNoDecline } : {}),
        ...pinned,
      });
      continue;
    }

    // Open-ended questions only ever reach a text box, never an option list.
    if (match.field.optionLabel) continue;
    const narrative = resolveNarrativeAnswer?.(resolverLabel);
    if (!narrative || !narrative.authorized || narrative.answer.trim().length === 0) continue;
    if (used.has(narrative.citation) || alreadyAnswered.has(narrative.citation)) continue;
    used.add(narrative.citation);
    derived.push({
      questionKey: narrative.citation,
      label: match.field.label,
      answer: narrative.answer,
      source: "profile",
      citation: narrative.citation,
      requiresHuman: false,
      required: match.field.required ?? true,
      category: "narrative",
      guidance: "",
    });
  }
  return derived;
}
