import type { Profile } from "../../domain/profile.js";
import { withoutAsides } from "../blockedQuestions.js";
import { asksWhetherSponsorshipRequired } from "../../text/workPermission.js";
import { canAutoFill } from "./approved.js";
import type { FormQuestion } from "./formQuestion.js";

/**
 * Employers word the sponsorship question in endlessly many ways, and a stored
 * pattern list can only ever chase them. Abnormal Security asks "Do you need,
 * or will you need in the future, any immigration related support or
 * sponsorship...?" - the same question thirteen stored patterns already cover,
 * phrased so that none of them is a substring - and the application stopped for
 * a decision the candidate had already written down.
 *
 * So a sponsorship question offering nothing but Yes and No may fall back to the
 * candidate's own standing yes/no sponsorship answer. Two limits keep that
 * honest. The question must offer exactly those two choices, because anything
 * else is asking something other than whether sponsorship is needed. And it must
 * not name an immigration classification: a form defining sponsorship to include
 * TN is asking a different question, one this candidate answers the other way,
 * so those stay with the specific stored answer or with a person.
 */
const NAMED_IMMIGRATION_CLASS =
  /\b(h-?1-?b|e-?3|tn|o-?1|l-?1|f-?1|j-?1|usmca|nafta|opt|cpt|green card|permanent residen)/i;
const YES_OR_NO = /^(yes|no)$/i;

/**
 * A form that names TN inside its definition of sponsorship is not asking the
 * usual question. This candidate needs no petition and no lottery, so the plain
 * "do you require sponsorship" answer is No - but TN status does require a
 * letter of support from the employer, and a form that counts that as
 * sponsorship is owed a Yes. A generic stored No must therefore never be handed
 * to a question that names TN; it falls to an answer written for that wording,
 * or to a person. H-1B alone does not trigger this: naming the route the
 * candidate would not use leaves the ordinary question intact.
 */
const TN_DEFINED_SPONSORSHIP = /\b(tn\b|usmca|nafta)/i;

export function namesTnRoute(entry: Profile["answers"][number]): boolean {
  return entry.patterns.some((pattern) => TN_DEFINED_SPONSORSHIP.test(pattern)) || TN_DEFINED_SPONSORSHIP.test(entry.label);
}

/**
 * Whether the form counts TN as sponsorship, in its wording or in one of its
 * choices. Waymo labels the question only "Work Authorization" and puts the
 * definition in an option - "...Waymo's sponsorship to obtain work
 * authorization... (e.g. H-1B, TN, etc.)" - so reading the label alone handed
 * that form the generic "authorized to work for any employer" statement.
 */
export function definesSponsorshipWithTn(question: FormQuestion): boolean {
  const texts = [question.label, ...(question.options ?? [])];
  if (texts.some((text) => TN_DEFINED_SPONSORSHIP.test(text) && /sponsor/i.test(text))) return true;
  // Mintlify asks "...require visa sponsorship? If yes, select the type of
  // sponsorship." and lists "Yes, TN" as one of the types. A bare "TN" is a
  // state abbreviation, not a visa choice. GitLab lists "Yes, USMCA Professional
  // (TN) Visa (USA)" under "...a visa to remain in your current location?" -
  // that asks about where he lives now, which needs no visa at all.
  return (
    /sponsor/i.test(question.label) &&
    !ABOUT_CURRENT_LOCATION.test(question.label) &&
    (question.options ?? []).some(namesTnChoice)
  );
}

const ABOUT_CURRENT_LOCATION =
  /\b(?:current(?:ly)?\s+(?:location|country|residence|city)|remain in|stay in|where you (?:currently )?(?:live|reside|are (?:based|located)))\b/i;

function namesTnChoice(option: string): boolean {
  return TN_DEFINED_SPONSORSHIP.test(option) && option.trim().length > 2;
}

/** The one offered choice that affirms needing sponsorship as TN, such as Mintlify's "Yes, TN". */
function tnAffirmingChoice(question: FormQuestion): string | undefined {
  const choices = (question.options ?? []).filter(
    (option) => namesTnChoice(option) && /^\s*yes\b/i.test(option) && !NEGATED.test(option),
  );
  return choices.length === 1 ? choices[0] : undefined;
}

const NEGATED = /\b(?:not|don't|do not|doesn't|does not|never|no longer|won't|will not)\b/i;

export function tnSponsorshipGuidance(question: FormQuestion): string {
  const affirming = (question.options ?? []).filter(
    (option) => TN_DEFINED_SPONSORSHIP.test(option) && /sponsor/i.test(option) && !NEGATED.test(option),
  );
  const choice = affirming.length === 1 ? affirming[0] : tnAffirmingChoice(question);
  const base = "This form counts TN as sponsorship, which the generic sponsorship answer does not cover.";
  return choice ? `${base} The choice that counts TN: ${choice}` : base;
}

export function canonicalSponsorshipDecision(
  profile: Profile,
  question: FormQuestion,
): Profile["answers"][number] | undefined {
  if (!/sponsor/i.test(question.label)) return undefined;
  // Judged with bracketed asides removed. Anduril asks "Will you require
  // sponsorship from Anduril for employment now or in the future (e.g, H1B
  // visa)?" - the ordinary question, illustrated by a route this candidate would
  // not use. Read whole, the illustration made it look like a question about a
  // named class and blocked an answer already on file. A definition stated
  // outside brackets still counts.
  if (NAMED_IMMIGRATION_CLASS.test(withoutAsides(question.label))) return undefined;
  const options = question.options ?? [];
  if (options.length !== 2 || !options.every((option) => YES_OR_NO.test(option.trim()))) return undefined;
  // The TN decision is the opposite of the generic one, so it must never be the
  // entry this fallback happens to find first.
  return profile.answers.find(
    (entry) =>
      canAutoFill(entry) &&
      YES_OR_NO.test(entry.answer.trim()) &&
      !namesTnRoute(entry) &&
      entry.patterns.some((pattern) => /sponsor/i.test(pattern)),
  );
}

/**
 * The candidate's standing decision for a form that counts TN as sponsorship.
 * It was stored under one employer's wording, so CoreWeave's "(e.g. H1-B, H1B1,
 * TN, E3...)" and Ridgeline's "(e.g. H-1B, TN, F1, OPT, etc)" matched only the
 * generic "No", which a TN definition may not take, and went to a person to
 * repeat a decision already on file.
 *
 * Held to the limits of the generic fallback and three more. The question must
 * ask whether sponsorship will be required - "authorized without sponsorship
 * (e.g. H-1B, TN)" takes the opposite answer. It must offer only Yes and No. And
 * a form saying TN is not counted is asking the generic question, so any
 * negation in the sentence naming TN leaves the answer to a person.
 */
export function canonicalTnSponsorshipDecision(
  profile: Profile,
  question: FormQuestion,
): Profile["answers"][number] | undefined {
  if (!asksWhetherSponsorshipRequired(question.label)) return undefined;
  const namingTn = question.label.split(/[.?;]/).filter((clause) => TN_DEFINED_SPONSORSHIP.test(clause));
  if (namingTn.some((clause) => NEGATED.test(clause))) return undefined;
  const options = question.options ?? [];
  const yesOrNo = options.length === 2 && options.every((option) => YES_OR_NO.test(option.trim()));
  // Either the wording names TN over a plain yes/no, or the choices offer TN as
  // one kind of yes; resolveTnChoice then selects that choice.
  if (!(namingTn.length > 0 && yesOrNo) && tnAffirmingChoice(question) === undefined) return undefined;
  return profile.answers.find(
    (entry) =>
      canAutoFill(entry) &&
      YES_OR_NO.test(entry.answer.trim()) &&
      namesTnRoute(entry) &&
      /sponsor/i.test([entry.key, entry.label, ...entry.patterns].join(" ")),
  );
}

/**
 * The TN decision is a plain "Yes", which a list of visa types offers several
 * times over ("Yes, H1B Transfer", "Yes, TN"); only the choice naming TN states it.
 */
export function resolveTnChoice(
  entry: Profile["answers"][number],
  question: FormQuestion,
): { value: string; unmatchedChoice: boolean } | undefined {
  if (!namesTnRoute(entry) || !/^\s*yes\b/i.test(entry.answer)) return undefined;
  const options = question.options ?? [];
  if (options.every((option) => YES_OR_NO.test(option.trim()))) return undefined;
  const choice = tnAffirmingChoice(question);
  return choice ? { value: choice, unmatchedChoice: false } : { value: entry.answer, unmatchedChoice: true };
}
