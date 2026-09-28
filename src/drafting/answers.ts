import type { Campaign } from "../domain/campaign.js";
import type { DraftAnswer } from "../domain/job.js";
import type { Profile } from "../domain/profile.js";
import { classifyQuestion, isBlockedCategory, looksLikeEssay, questionCore, withoutAsides } from "./blockedQuestions.js";
import { isFreeTextFollowUp, resolveConditionalFollowUps } from "./conditionalFollowUps.js";
import { resolveNarrative, type NarrativeContext } from "./narrative.js";
import { selectBestOption } from "./options.js";
import { resolvePersonal } from "./personal.js";
import { resolveExperience } from "./experience.js";
import {
  CURRENT_RESIDENCE_QUESTION as SHARED_RESIDENCE_QUESTION,
  WORK_AUTHORITY_TEXT as SHARED_WORK_AUTHORITY_TEXT,
  namesCandidateLocation,
} from "./residence.js";
import {
  asksWhetherSponsorshipRequired,
  canonicalizeWorkPermission,
  sponsorshipIntentMismatch,
  workPermissionScopeMismatch,
} from "../text/workPermission.js";
import {
  aboutRelocation,
  acceptsRelocationInstead,
  decidesRelocation,
  relocationAssistanceMismatch,
  relocationOption,
  writtenForChoiceList,
} from "../text/questionIntent.js";
import { statesUnrelatedExperience } from "./experienceSubject.js";
import { ratingSubjectMismatch } from "./ratingSubject.js";
import { consentsToDocument } from "./documentConsent.js";
import { valueShapeMismatch, type TextControl } from "./valueShape.js";

/**
 * Answer policy engine.
 *
 * Answers may only come from verified profile data or a pre-approved answer.
 * Anything else is handed back for a human to decide. Nothing is invented here.
 */

export type FormQuestion = {
  key: string;
  label: string;
  required: boolean;
  /** input_text | textarea | multi_value_single_select | input_file | ... */
  type: string;
  options?: string[];
  /**
   * The option the employer itself marked as declining to answer, where the ATS
   * publishes that flag. Only set on voluntary self-identification questions.
   */
  declineOption?: string;
};

const CONTACT_RESOLVERS: ReadonlyArray<readonly [RegExp, (profile: Profile) => string, string]> = [
  // One box for the whole name. "What is your preferred first and last name?"
  // contains "last name", so the surname resolver below answered it with the
  // surname alone (Customer.io, 2026-09-28).
  [
    /\bfirst\s*(?:,|&|\/|\+|and)\s*(?:middle\s*(?:,|&|\/|\+|and)?\s*)?(?:and\s+)?last\s+names?\b/i,
    (p) => p.identity.fullName,
    "identity.fullName",
  ],
  [/\bfirst name\b/i, (p) => p.identity.fullName.split(/\s+/)[0] ?? "", "identity.fullName"],
  [/\blast name\b|\bsurname\b|\bfamily name\b/i, (p) => p.identity.fullName.split(/\s+/).slice(1).join(" "), "identity.fullName"],
  [/\bfull name\b|\bpreferred name\b|^name$/i, (p) => p.identity.fullName, "identity.fullName"],
  [/\bemail\b/i, (p) => p.identity.email, "identity.email"],
  [/\bphone\b|\bmobile\b|\btelephone\b/i, (p) => p.identity.phone, "identity.phone"],
  [/\blinkedin\b/i, (p) => p.identity.links.linkedin ?? "", "identity.links.linkedin"],
  [/\bgithub\b/i, (p) => p.identity.links.github ?? "", "identity.links.github"],
  [/\b(?:portfolio|website|personal site)\b/i, (p) => p.identity.links.website ?? "", "identity.links.website"],
  // Greenhouse's geocoder is labelled "Location (City)" but is a single control
  // standing for the whole location, and it offers "Vancouver, Washington,
  // United States" beside "Vancouver, British Columbia, Canada". A bare city
  // leaves the choice between them to whichever the geocoder happens to rank
  // first, which is a coin toss that would silently place the candidate in the
  // wrong country. The qualified form matches exactly, and the option search
  // falls back to the bare city if a geocoder cannot parse it.
  //
  // Labels naming a component alongside the word "location" ("Location -
  // State") are excluded, because those forms collect the parts separately and
  // each box wants only its own part.
  [
    /\blocation\b(?!.*\b(?:state|province|region|country|zip|postal)\b)/i,
    (p) => formatLocation(p),
    "identity.location",
  ],
  [/\bcity\b/i, (p) => p.identity.location.city, "identity.location.city"],
  [/\b(?:state|province|region)\b/i, (p) => p.identity.location.region, "identity.location.region"],
  [/\bcountry\b/i, (p) => p.identity.location.country, "identity.location.country"],
  [/\blocation\b|\bcurrent location\b/i, (p) => formatLocation(p), "identity.location"],
];

function formatLocation(profile: Profile): string {
  const { city, region, country } = profile.identity.location;
  return [city, region, country].filter((part) => part.length > 0).join(", ");
}

/**
 * A contact field asking for someone else's details: a referrer, a reference, a
 * recruiter, a manager or an emergency contact. The profile holds only the
 * candidate's own details, so none of its values can answer one. Tubi's
 * optional "please include the referrer's Tubi or Fox email address" matched the
 * email resolver and was given the candidate's own address, which claims a
 * referral that never happened.
 *
 * The third party has to own the detail asked for, either directly before it
 * ("Recruiter's email") or after it ("phone number of your manager"), so a
 * label such as "your email, so the hiring manager can reach you" still wants
 * the candidate's address.
 */
const THIRD_PARTY =
  "(?:referr(?:er|ers|ing|al)|references?|recruiter|(?:hiring\\s+)?manager|supervisor|emergency\\s+contact|next\\s+of\\s+kin)";
const CONTACT_NOUN = "(?:e-?mail|phone|mobile|telephone|number|name|linkedin)";
// "Phone number for the recruiter to contact you" is the candidate's own number.
const REACHES_CANDIDATE =
  "(?!\\s+(?:to|can|could|will|may|should|would)\\s+(?:reach|contact|call|text|e-?mail|message)\\s+you\\b)";
const THIRD_PARTY_CONTACT = new RegExp(
  `\\b${THIRD_PARTY}(?:'s|\u2019s|s')?(?:\\s+\\S+){0,3}?\\s+${CONTACT_NOUN}\\b` +
    `|\\b${CONTACT_NOUN}\\b[^?.]{0,40}?\\b(?:of|for)\\s+(?:the\\s+|your\\s+|a\\s+)?` +
    `(?:${THIRD_PARTY}|(?:person|employee|colleague)\\s+who\\s+referred)\\b${REACHES_CANDIDATE}`,
  "i",
);

/**
 * A bracketed aside is not the subject of the question; see `withoutAsides`.
 */
/**
 * Anysphere asks "Has someone at Cursor or Graphite referred you for this role?
 * If so, please include their email here", and the candidate's own address was
 * filled in, naming him as his own referrer. "Their" details belong to the
 * person the question is about; it only counts when the label names another
 * person, because "Applicants must provide their phone number" is his own.
 */
const THEIR_CONTACT = new RegExp(`\\btheir(?:\\s+\\S+){0,2}?\\s+${CONTACT_NOUN}\\b`, "i");
const NAMES_ANOTHER_PERSON =
  /\b(?:refer\w*|someone|somebody|anyone|anybody|employee|colleague|friend|recruiter|manager|references?)\b/i;

function contactResolverFor(label: string) {
  const subject = withoutAsides(label);
  if (THIRD_PARTY_CONTACT.test(subject)) return undefined;
  if (THEIR_CONTACT.test(subject) && NAMES_ANOTHER_PERSON.test(subject)) return undefined;
  return CONTACT_RESOLVERS.find(([pattern]) => pattern.test(subject));
}

/**
 * Finds the pre-approved answer whose pattern matches most specifically.
 *
 * Longest match wins rather than array order, because sponsorship questions
 * overlap: a generic "do you require sponsorship" answer must not pre-empt the
 * answer written for "...require sponsorship (e.g. H-1B, E-3, TN, O-1...)",
 * which names a route the candidate would in fact use.
 */
function matchApprovedAnswer(profile: Profile, label: string, offered?: Pick<FormQuestion, "type" | "options">) {
  const haystack = canonicalizeWorkPermission(label.toLowerCase());
  const residenceAsked = CURRENT_RESIDENCE_QUESTION.test(haystack) && !WORK_AUTHORITY_TEXT.test(haystack);
  const asksAboutHome = residenceAsked && namesCandidateLocation(haystack, profile);
  // Watershed's "Are you located in, or willing to relocate to the SF area?" is
  // satisfied by either condition. On a bare Yes/No control the stored "No -
  // based in Vancouver, Canada and willing to relocate." keeps only its "No",
  // so the relocation decision answers instead. Free text keeps the qualified
  // denial, and a richer option list is left to the option matcher, because
  // "Yes" there may be the option claiming he already lives there.
  const relocationAnswers = residenceAsked && offersOnlyYesNo(offered) && acceptsRelocationInstead(haystack);
  const freeText = offered !== undefined && isFreeTextQuestion(offered);
  let best: { entry: Profile["answers"][number]; length: number } | null = null;
  for (const entry of profile.answers) {
    if (relocationAnswers) {
      // Only the residence denial is set aside here; a stored "No" to
      // relocating to the place named is the answer to this very question.
      if (deniesResidence(entry) && !aboutRelocation(entry)) continue;
      if (!statesWhereCandidateLives(entry) && !aboutRelocation(entry)) continue;
    } else if (residenceAsked && !statesWhereCandidateLives(entry)) continue;
    if (freeText && writtenForChoiceList(entry)) continue;
    if (relocationAssistanceMismatch(label, [entry.key, entry.label, ...entry.patterns])) continue;
    // A question naming a subject may only be answered by an entry naming the
    // same subject; see experienceSubject.ts.
    if (statesUnrelatedExperience(haystack, [entry.label, ...entry.patterns])) continue;
    if (ratingSubjectMismatch(haystack, [entry.label, ...entry.patterns])) continue;
    if (workPermissionScopeMismatch(haystack, [entry.label, ...entry.patterns])) continue;
    if (sponsorshipIntentMismatch(label, [entry.key, entry.label, ...entry.patterns])) continue;
    // "Are you located in <somewhere he is not>" is stored once, as a blanket
    // "No - based in Vancouver, Canada". That is true of everywhere except the
    // one place he actually lives, so when the question names Canada, British
    // Columbia or Vancouver the stored answer states the opposite of the truth.
    // Tailscale asked exactly that. A denial cannot answer a question about his
    // own location; resolvePersonal supplies the affirmative instead.
    if (asksAboutHome && deniesResidence(entry)) continue;
    for (const pattern of entry.patterns) {
      const needle = canonicalizeWorkPermission(pattern.toLowerCase());
      if (!haystack.includes(needle)) continue;
      if (!best || needle.length > best.length) best = { entry, length: needle.length };
    }
  }
  // Brex words the alternative "or plan to relocate to", which no stored pattern
  // covers; the question itself names relocation, so the standing decision applies.
  if (!best && relocationAnswers) return profile.answers.find((entry) => decidesRelocation(entry) && canAutoFill(entry));
  return best?.entry;
}

/** True when the answer opens by denying it, however it then qualifies itself. */
function deniesResidence(entry: Profile["answers"][number]): boolean {
  return /^\s*no\b/i.test(entry.answer.trim());
}

function offersOnlyYesNo(offered: Pick<FormQuestion, "options"> | undefined): boolean {
  const options = offered?.options ?? [];
  return options.length === 2 && options.every((option) => /^(?:yes|no)$/i.test(option.trim()));
}

function isFreeTextQuestion(offered: Pick<FormQuestion, "type" | "options">): boolean {
  return (offered.type === "input_text" || offered.type === "textarea") && !(offered.options?.length);
}

/**
 * Brex asks "Do you currently live in, or plan to relocate to, the specified
 * location?" and offers "Yes, I live here", "Yes, I plan to relocate" and "No".
 * Ridgeline asks whether he is "located in either area or open to relocation"
 * and offers "Yes, I am located in/near the Reno, NV area.", the same for San
 * Ramon, "I am open to relocation." and "I am not open to relocation.". Each
 * stored answer speaks to one half of such a question: the residence denial
 * took Brex's "No", telling the employer he would not relocate, and the bare
 * "Yes" of the based-or-relocating answer took Ridgeline's first option,
 * claiming he lives near Reno. Both were submitted.
 *
 * He lives in neither place and has decided to relocate, so the answer is the
 * option that commits to relocating without claiming residence, and a person
 * chooses when no single option does. A bare Yes/No list stays with
 * matchApprovedAnswer, as does a question naming where he lives.
 */
function relocationChoice(
  question: FormQuestion,
  profile: Profile,
  category: string,
): Omit<DraftAnswer, "required"> | undefined {
  const options = question.options ?? [];
  if (options.length === 0 || offersOnlyYesNo(question) || isFreeTextQuestion(question)) return undefined;
  const haystack = canonicalizeWorkPermission(question.label.toLowerCase());
  if (!CURRENT_RESIDENCE_QUESTION.test(haystack) || WORK_AUTHORITY_TEXT.test(haystack)) return undefined;
  if (!acceptsRelocationInstead(haystack) || namesCandidateLocation(haystack, profile)) return undefined;
  const decision = profile.answers.find((entry) => decidesRelocation(entry) && canAutoFill(entry));
  const option = decision ? relocationOption(options) : undefined;
  if (!decision || !option) {
    return blocked(
      question,
      category,
      decision
        ? "residence-or-relocation question: no single option commits to relocating without claiming residence"
        : "residence-or-relocation question: no relocation decision on file",
      `Options: ${options.join(" | ")}`,
    );
  }
  return {
    questionKey: question.key,
    label: question.label,
    answer: option,
    source: "approved-answer",
    citation: `profile.answers.${decision.key}`,
    requiresHuman: false,
    category,
    guidance: "",
  };
}

/**
 * Boards ask where the candidate is *now* as a compound: "Are you currently
 * located in the San Francisco Bay Area and able to work from our Santa Clara
 * HQ up to 1-2 days weekly?". Only the second clause matched a stored
 * willingness-to-commute "Yes", so Netskope was told the candidate already
 * lives in the Bay Area. He lives in Vancouver. Willingness is a statement
 * about the future and can never answer a question of present fact, so a
 * residence question may only be filled by an answer that is itself about
 * where the candidate lives; anything else leaves it for a person to decide.
 *
 * The equivalent guard in the form-filling layer cannot catch this, because by
 * then the answer carries the question's own label and so looks like a
 * residence answer to any test applied to it.
 */
const CURRENT_RESIDENCE_QUESTION = SHARED_RESIDENCE_QUESTION;
/** Work authorization is phrased as location but asks about legal status. */
const WORK_AUTHORITY_TEXT = SHARED_WORK_AUTHORITY_TEXT;
const RESIDENCE_ANSWER = /\b(based|located|reside|residing|lives?|living)\b/;

/** Judged from the entry's own wording, never from the question it matched. */
function statesWhereCandidateLives(entry: Profile["answers"][number]): boolean {
  return RESIDENCE_ANSWER.test(entry.label.toLowerCase()) || RESIDENCE_ANSWER.test(entry.answer.toLowerCase());
}

/**
 * An answer may be auto-filled when it is authorized and non-empty, or when it
 * is explicitly marked to be skipped. A blank entry that is neither records
 * that a question is known and still needs a decision.
 */
function canAutoFill(entry: { answer: string; allowAutoFill: boolean; skip?: boolean }): boolean {
  if (entry.skip === true) return true;
  return entry.allowAutoFill && entry.answer.trim().length > 0;
}

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

function namesTnRoute(entry: Profile["answers"][number]): boolean {
  return entry.patterns.some((pattern) => TN_DEFINED_SPONSORSHIP.test(pattern)) || TN_DEFINED_SPONSORSHIP.test(entry.label);
}

/**
 * Whether the form counts TN as sponsorship, in its wording or in one of its
 * choices. Waymo labels the question only "Work Authorization" and puts the
 * definition in an option - "...Waymo's sponsorship to obtain work
 * authorization... (e.g. H-1B, TN, etc.)" - so reading the label alone handed
 * that form the generic "authorized to work for any employer" statement.
 */
function definesSponsorshipWithTn(question: FormQuestion): boolean {
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

function tnSponsorshipGuidance(question: FormQuestion): string {
  const affirming = (question.options ?? []).filter(
    (option) => TN_DEFINED_SPONSORSHIP.test(option) && /sponsor/i.test(option) && !NEGATED.test(option),
  );
  const choice = affirming.length === 1 ? affirming[0] : tnAffirmingChoice(question);
  const base = "This form counts TN as sponsorship, which the generic sponsorship answer does not cover.";
  return choice ? `${base} The choice that counts TN: ${choice}` : base;
}

function canonicalSponsorshipDecision(
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
function canonicalTnSponsorshipDecision(
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
function resolveTnChoice(
  entry: Profile["answers"][number],
  question: FormQuestion,
): { value: string; unmatchedChoice: boolean } | undefined {
  if (!namesTnRoute(entry) || !/^\s*yes\b/i.test(entry.answer)) return undefined;
  const options = question.options ?? [];
  if (options.every((option) => YES_OR_NO.test(option.trim()))) return undefined;
  const choice = tnAffirmingChoice(question);
  return choice ? { value: choice, unmatchedChoice: false } : { value: entry.answer, unmatchedChoice: true };
}

/**
 * Resolves a stored answer against the choices a question actually offers.
 * Falls back to the plain answer when the question is free text.
 */
function resolveApprovedValue(
  entry: { answer: string; alternatives: string[] },
  question: FormQuestion,
): { value: string; unmatchedChoice: boolean } {
  const hadOptions = (question.options?.length ?? 0) > 0;
  // Declaring no alternatives used to skip option matching entirely, so a
  // stored value was handed to a closed dropdown that might not list it - the
  // form would reject it, or worse, the fill would land on a near neighbour.
  // Whether the answer needs matching is a property of the question, not of how
  // many fallbacks happen to be stored.
  if (!hadOptions) {
    return { value: entry.answer, unmatchedChoice: false };
  }
  const preferences = [entry.answer, ...entry.alternatives].filter((value) => value.trim().length > 0);
  const match = selectBestOption(preferences, question.options);
  return { value: match.value, unmatchedChoice: !match.matchedOption };
}

function blocked(
  question: FormQuestion,
  category: string,
  reason: string,
  guidance = "",
): Omit<DraftAnswer, "required"> {
  return {
    questionKey: question.key,
    label: question.label,
    answer: "",
    source: "blocked",
    citation: reason,
    requiresHuman: true,
    category,
    guidance,
  };
}

/**
 * Produces a draft answer per question. `requiresHuman` marks anything that a
 * person must confirm before the application can be submitted.
 */
export function draftAnswers(
  questions: readonly FormQuestion[],
  profile: Profile,
  campaign: Campaign,
  context?: NarrativeContext,
): { answers: DraftAnswer[]; blockedQuestions: string[]; blockingQuestions: string[] } {
  const blockedCategories = campaign.submission.blockedQuestionCategories;
  const drafted = questions.map((question) => ({
    ...fitToQuestion(question, answerOne(question, profile, blockedCategories, context)),
    // Stamped in one place: answerOne returns from eleven branches and any one
    // of them forgetting this flag would silently make an optional field block
    // submission again.
    required: question.required,
  }));
  // Runs over the whole form because a conditional follow-up is only
  // answerable in the light of the question above it, which answerOne - which
  // sees one question at a time - cannot know about.
  const answers = resolveConditionalFollowUps(questions, drafted);
  const requiredLabels = new Set(questions.filter((question) => question.required).map((question) => question.label));
  const blockedQuestions = answers.filter((answer) => answer.requiresHuman).map((answer) => answer.label);
  // An optional question cannot stop the form being submitted, and a blank
  // optional field asserts nothing, so it is reported but does not gate
  // approval. Lyft's optional pronouns list offers no decline option, so the
  // standing "prefer not to say" has nowhere to go - leaving it empty is the
  // decline. Blocking the whole application over it buried three real
  // applications behind a field the employer marked as skippable.
  const blockingQuestions = blockedQuestions.filter((label) => requiredLabels.has(label));
  return { answers, blockedQuestions, blockingQuestions };
}

function textControlOf(question: FormQuestion): TextControl | null {
  if ((question.options?.length ?? 0) > 0) return null;
  if (question.type === "textarea") return "multi-line";
  if (question.type === "input_text") return "single-line";
  return null;
}

/**
 * Checked once over every branch of answerOne, because the value that does not
 * fit can come from any of them: Jane Street's year question took the stored
 * university from the answer bank, and its university-email question took it
 * from the education resolver. See valueShape.ts. An optional field is left
 * blank, which asserts nothing; a required one goes to a person.
 */
function fitToQuestion(
  question: FormQuestion,
  drafted: Omit<DraftAnswer, "required">,
): Omit<DraftAnswer, "required"> {
  const control = textControlOf(question);
  const reason = control ? valueShapeMismatch(question.label, control, drafted.answer) : null;
  if (!reason) return drafted;
  return {
    ...blocked(
      question,
      drafted.category,
      `value does not fit the question: ${reason}`,
      `"${drafted.answer.slice(0, 60)}" (from ${drafted.citation}) does not answer this question.`,
    ),
    requiresHuman: question.required,
  };
}

function answerOne(
  question: FormQuestion,
  profile: Profile,
  blockedCategories: readonly string[],
  context?: NarrativeContext,
): Omit<DraftAnswer, "required"> {
  const category = classifyQuestion(question.label);
  // A leading "If ..." clause states a precondition, not the question. Matching
  // against the whole label let the condition win: Stripe's "If located in the
  // US, in what city and state do you reside?" took the yes/no answer to "are
  // you located in the US" and asked for a city got "No", and "If this role
  // offers the option to work from a remote location, do you plan to work
  // remotely?" matched the word "location" and got a home address. Resolution
  // runs against the actual interrogative; classification still sees the whole
  // label, since a condition can carry the sensitive part of a question.
  const asked = { ...question, label: questionCore(question.label) };

  // File uploads are satisfied by attaching the resume, not by a typed answer.
  if (question.type === "input_file") {
    return {
      questionKey: question.key,
      label: question.label,
      answer: "",
      source: "profile",
      citation: "profile.resumes (uploaded as a file)",
      requiresHuman: false,
      category: "attachment",
      guidance: "",
    };
  }

  // Hidden fields are populated by the form's own scripts (geocoding, tokens).
  if (question.type === "input_hidden") {
    return {
      questionKey: question.key,
      label: question.label,
      answer: "",
      source: "profile",
      citation: "populated by the application form",
      requiresHuman: false,
      category: "hidden",
      guidance: "",
    };
  }

  // Work authorization gets the verified statement as a suggestion, but the
  // candidate still confirms it: the wording is legally material.
  if (category === "work-authorization" || category === "sponsorship" || category === "citizenship") {
    const matched = matchApprovedAnswer(profile, question.label, question);
    const reviewAll = profile.workAuthorization.alwaysReviewManually;
    // A generic sponsorship answer cannot speak for a form that counts TN as
    // sponsorship; only an entry written for that wording may.
    const tnDefined = definesSponsorshipWithTn(question);
    const eligible = matched && tnDefined && !namesTnRoute(matched) ? undefined : matched;
    // Fall back only when no stored pattern matched at all: an entry that
    // matched but is deliberately left blank is a standing request to be asked.
    // The yes/no fallback reads the label with asides removed, so it cannot see
    // a TN definition in brackets or in the choices and must not answer one; a
    // TN definition falls back to the TN decision instead.
    const proposed = eligible ?? (reviewAll
      ? undefined
      : tnDefined ? canonicalTnSponsorshipDecision(profile, question) : canonicalSponsorshipDecision(profile, question));
    const approved = proposed && !workPermissionScopeMismatch(question.label, [proposed.label, ...proposed.patterns])
      ? proposed : undefined;
    // This branch used to hand the stored answer straight to the form without
    // consulting the choices on offer. "Which countries would you need
    // sponsorship for?" matches the stored "need sponsorship" answer, so a bare
    // "No" was headed for a list of country names. A stored answer the question
    // does not offer is unusable, whatever its wording says.
    const resolved = approved ? (resolveTnChoice(approved, question) ?? resolveApprovedValue(approved, question)) : undefined;
    const unusable = resolved?.unmatchedChoice === true;
    const useApproved = approved !== undefined && canAutoFill(approved) && !reviewAll && !unusable;
    return {
      questionKey: question.key,
      label: question.label,
      answer: useApproved ? (resolved?.value ?? approved.answer) : (approved?.answer ?? profile.workAuthorization.statement),
      source: approved ? "approved-answer" : "profile",
      citation: approved ? `profile.answers.${approved.key}` : "profile.workAuthorization.statement",
      requiresHuman: !useApproved,
      category,
      guidance:
        unusable && approved
          ? `"${approved.answer}" is not one of the offered options: ${(question.options ?? []).join(" | ")}`
          : !approved && tnDefined
            ? tnSponsorshipGuidance(question)
            : !approved && workPermissionScopeMismatch(question.label, [])
              ? "This authorization scope needs an explicit matching decision; a generic work-permission answer does not establish it."
              : "",
    };
  }

  // A conditional follow-up asks nothing on its own: what belongs in it is
  // decided entirely by the question above it. questionCore deliberately strips
  // the leading condition so the remainder can be matched, which let Robinhood's
  // "If you answered "Yes" to the above question, please provide additional
  // information here" match the stored additional-information essay - and print
  // it under both a conflict-of-interest and a government-official question that
  // were each answered "No". Left blank here so resolveConditionalFollowUps can
  // settle it from the governing answer, or hand it to a person when that answer
  // really was yes.
  if (isFreeTextFollowUp(question.label, question.type)) {
    return blocked(
      question,
      category,
      "conditional follow-up: resolved from the question it depends on, never from the answer bank",
    );
  }

  // A pre-approved answer is an explicit prior decision, so it can satisfy an
  // otherwise blocked category. Checked before the block so the candidate's own
  // stored choice is honoured.
  const relocation = relocationChoice(asked, profile, category);
  if (relocation) return { ...relocation, label: question.label };
  const approvedEarly = matchApprovedAnswer(profile, asked.label, asked);
  // A stored answer that the form does not offer as a choice is unusable. When
  // the question is also a contact field, the profile holds the literal value it
  // wants, so preferring the stored answer blocks the application over a fact
  // already on file. Instacart asks "Which state or province do you currently
  // live in?" and lists "(CAN) British Columbia"; the stored residence answer
  // ("No - based in Vancouver...") matched the question's wording, matched none
  // of the 61 options, and so held up an otherwise complete application. A
  // question asking *which* place wants a value, not a yes/no.
  const factualFallback =
    approvedEarly !== undefined &&
    category === "contact" &&
    resolveApprovedValue(approvedEarly, asked).unmatchedChoice &&
    CONTACT_RESOLVERS.some(([pattern]) => pattern.test(withoutAsides(question.label)));
  if (approvedEarly && canAutoFill(approvedEarly) && !factualFallback) {
    const resolved = resolveApprovedValue(approvedEarly, asked);
    // An optional choice question offering none of the stored preferences needs
    // no decision: leaving it blank is the honest outcome, and for a decline
    // preference it is exactly the intended one. Figma's Pronouns list offers
    // only she/he/they/self-describe, so a stored "I prefer not to say" cannot
    // be selected - blocking the whole application over an optional field the
    // candidate has already chosen not to answer helps nobody.
    const skipOptional = resolved.unmatchedChoice && !question.required;
    // A stored "I acknowledge" does not textually match Roblox's option, which
    // is a full sentence naming the notice. The approved-answer branch returns
    // before the sole-consent rule below could apply, so a matched but
    // unselectable consent blocked the whole application over a field offering
    // exactly one submittable value. Check it here as well.
    const consentFallback =
      resolved.unmatchedChoice && isConsentingAnswer(approvedEarly.answer)
        ? soleConsentOption(question)
        : undefined;
    if (consentFallback) {
      return {
        questionKey: question.key,
        label: question.label,
        answer: consentFallback,
        source: "approved-answer",
        citation: `profile.answers.${approvedEarly.key} (sole offered option)`,
        requiresHuman: false,
        category: "acknowledgement",
        guidance: "",
      };
    }
    return {
      questionKey: question.key,
      label: question.label,
      answer: skipOptional ? "" : resolved.value,
      source: "approved-answer",
      citation: `profile.answers.${approvedEarly.key}`,
      // A required choice question offering none of the stored preferences is
      // handed back: submitting a value the form does not list would fail.
      requiresHuman: resolved.unmatchedChoice && question.required,
      category,
      guidance: resolved.unmatchedChoice
        ? `None of the stored preferences match the offered options: ${(question.options ?? []).join(" | ")}${
            skipOptional ? ". Optional, so it is left blank." : ""
          }`
        : "",
    };
  }

  // Employment history: factual resume data, already used at fill time but
  // never consulted during drafting, so "What is your current or previous job
  // title?" blocked applications that the server could answer from the profile.
  const experience = resolveExperience(asked.label, profile);
  if (experience) {
    return {
      questionKey: question.key,
      label: question.label,
      answer: experience.answer,
      source: "profile",
      citation: experience.citation,
      requiresHuman: !experience.authorized,
      category: experience.category,
      guidance: "",
    };
  }

  // Personal and demographic fields: usable only where the candidate opted that
  // specific field in. Otherwise the stored value is offered as a suggestion
  // and the question still stops for a decision.
  const personal = resolvePersonal(asked.label, profile);
  if (personal) {
    // A stored address part handed to a closed list the form does not offer it
    // in fails at submission, after the draft has already been reported
    // complete. Resolved against the options as the contact rule below is, so
    // a decorated entry is taken in its offered spelling and an absent one is
    // handed back. Demographic fields are left to the decline handling at fill
    // time, which knows each board's wording for declining.
    const offered = personal.category === "contact" && personal.answer.trim().length > 0 && (question.options?.length ?? 0) > 0;
    const resolved = offered ? resolveApprovedValue({ answer: personal.answer, alternatives: [] }, question) : undefined;
    const unusable = resolved?.unmatchedChoice === true;
    return {
      questionKey: question.key,
      label: question.label,
      answer: unusable ? "" : (resolved?.value ?? personal.answer),
      source: "profile",
      citation: personal.citation,
      requiresHuman: unusable ? question.required === true : !personal.authorized,
      category: personal.category,
      guidance: unusable
        ? `"${personal.answer}" is not one of the offered options: ${(question.options ?? []).join(" | ")}`
        : "",
    };
  }

  // Voluntary self-identification questions the ATS flags with its own
  // decline-to-answer option. The label of one of these need not name a
  // protected characteristic at all - Greenhouse asks "Which categories
  // describe you?" for race and ethnicity - so pattern matching cannot be
  // relied on to recognise them, and an unrecognised one is classified as an
  // essay and blocks the whole application. Selecting the option the employer
  // marked as declining discloses nothing, so it is safe here, but it is
  // applied only when the candidate has in fact declined the demographics they
  // did store. A candidate who answers demographic questions should be asked.
  if (question.declineOption && declinesDemographics(profile)) {
    return {
      questionKey: question.key,
      label: question.label,
      answer: question.declineOption,
      source: "profile",
      citation: "personal.demographics (declined; option marked decline-to-answer by the employer)",
      requiresHuman: false,
      category: "demographic",
      guidance: "",
    };
  }

  if (isBlockedCategory(category, blockedCategories)) {
    // A required choice offering exactly one consent option carries no decision
    // whatever its category: "Please review and acknowledge our Privacy Notice"
    // classifies as a legal attestation and so was blocked before the
    // sole-consent rule further down could ever be reached. Sensitive
    // categories are excluded, because a lone "I agree" on a demographic or
    // work-authorization question is a disclosure, not a formality.
    // In a sensitive category the sole option is taken only when it consents to
    // a named document or process and claims nothing about the candidate. See
    // documentConsent.ts: IonQ's "Background Check Disclosure & Consent" is a
    // formality, "I certify that I have never been convicted" is not.
    const consentOnly = SELF_EVIDENT_CONSENT_CATEGORIES.has(category)
      ? soleConsentOption(question)
      : soleDocumentConsentOption(question);
    if (consentOnly) {
      return {
        questionKey: question.key,
        label: question.label,
        answer: consentOnly,
        source: "approved-answer",
        citation: "profile.answers.acknowledgement (sole offered option)",
        requiresHuman: false,
        category: "acknowledgement",
        guidance: "",
      };
    }
    // An authorised narrative is not invented text: it is the candidate's own
    // wording, marked allowAutoFill, rendered from this specific posting. The
    // category gate ran before the narrative check below, so "Why do you want
    // to work at X?" - the exact question narratives exist for - was always
    // blocked, while the same template filled a field labelled "Cover Letter"
    // because that classifies as contact. Consult the narrative first and fall
    // through to a human decision when there isn't an authorised one.
    const narrative = context ? resolveNarrative(question.label, profile, context) : null;
    if (narrative?.authorized) {
      return {
        questionKey: question.key,
        label: question.label,
        answer: narrative.answer,
        source: "approved-answer",
        citation: narrative.citation,
        requiresHuman: false,
        category: "narrative",
        guidance: "",
      };
    }
    // A stored entry for a blocked category still supplies a suggestion and
    // guidance, so the person deciding is not starting from a blank field.
    return blocked(
      question,
      category,
      `category "${category}" always requires a human decision`,
      approvedEarly?.note ?? "",
    );
  }

  const approved = approvedEarly;
  if (approved && !factualFallback) {
    return {
      questionKey: question.key,
      label: question.label,
      answer: approved.answer,
      source: "approved-answer",
      citation: `profile.answers.${approved.key}`,
      requiresHuman: !canAutoFill(approved),
      category,
      guidance: canAutoFill(approved) ? "" : approved.note ?? "",
    };
  }

  if (category === "contact" && question.type !== "textarea") {
    // A contact detail is one line; an essay box whose label says "mobile" or
    // "email" is asking about the subject, not for a number or an address.
    const resolver = contactResolverFor(question.label);
    if (resolver) {
      const plain = resolver[1](profile);
      // Boards often render a location field as a closed list whose entries are
      // decorated - Instacart lists "(CAN) British Columbia", not "British
      // Columbia". Handing the bare value to a closed list submits something the
      // form does not offer, so resolve it against the options when there are any.
      const resolved = resolveApprovedValue({ answer: plain, alternatives: [] }, question);
      const value = resolved.unmatchedChoice ? plain : resolved.value;
      const unusable = resolved.unmatchedChoice && (question.options?.length ?? 0) > 0;
      return {
        questionKey: question.key,
        label: question.label,
        answer: unusable ? "" : value,
        source: "profile",
        citation: resolver[2],
        requiresHuman: (value.trim().length === 0 || unusable) && question.required,
        category,
        guidance: unusable
          ? `"${plain}" is not one of the offered options: ${(question.options ?? []).join(" | ")}`
          : "",
      };
    }
  }

  // Open-ended questions can be answered from a narrative template, which is
  // the candidate's own wording filled in from this specific posting.
  if (context) {
    const narrative = resolveNarrative(question.label, profile, context);
    if (narrative) {
      return {
        questionKey: question.key,
        label: question.label,
        answer: narrative.answer,
        source: "approved-answer",
        citation: narrative.citation,
        requiresHuman: !narrative.authorized,
        category: "narrative",
        guidance: "",
      };
    }
  }

  if (looksLikeEssay(question.label, question.type)) {
    return blocked(question, "essay", "free-text response must be written and approved by a human");
  }

  const soleConsent = soleConsentOption(question);
  if (soleConsent) {
    return {
      questionKey: question.key,
      label: question.label,
      answer: soleConsent,
      source: "approved-answer",
      citation: "profile.answers.acknowledgement (sole offered option)",
      requiresHuman: false,
      category: "acknowledgement",
      guidance: "",
    };
  }

  return blocked(question, category, "no verified profile value or pre-approved answer matches this question");
}

/**
 * A lone option written as a bare formality. Inflected forms count: Coinbase's
 * sole option reads "Confirmed", which is the same formality as "Confirm" and
 * was blocking every Coinbase application over a field with nothing else to
 * select.
 */
const SOLE_CONSENT_OPTION =
  /^(?:i )?(?:acknowledged?|agreed?|accepts?|accepted|consented?|certif(?:y|ied)|confirmed?|understands?|understood)\b/;

/**
 * The same formality written as a first-person sentence that puts the verb
 * after a preamble: Vercel's sole option reads "I have reviewed and confirmed
 * that all the information provided is accurate and complete". Requiring the
 * verb is what separates a formality from a claim - a lone option stating a
 * fact about the candidate ("I have 6+ years of experience") has no consent
 * verb and is still blocked for a human.
 */
const ATTESTATION_SENTENCE =
  /^i\b.{0,40}\b(?:acknowledged?|agreed?|accepted|consented?|certified|confirmed?|understood)\b/;

/**
 * Whether the candidate has declined the demographic questions he has stored an
 * answer for. Used to decide whether an unrecognised voluntary self-ID question
 * may be answered with the employer's own decline option: doing so is only
 * consistent with the candidate's wishes if he declined the ones we can read.
 * A candidate who discloses his demographics gets asked instead.
 */
function declinesDemographics(profile: Profile): boolean {
  const stored = Object.values(profile.personal.demographics)
    .map((entry) => (typeof entry === "string" ? entry : (entry?.value ?? "")))
    .filter((value) => value.trim().length > 0);
  if (stored.length === 0) return false;
  return stored.every((value) =>
    /\b(?:decline|prefer not|don'?t wish|do not wish|not (?:to )?(?:answer|disclose|specify)|wish not)\b/i.test(value),
  );
}

/**
 * Categories where a lone consent option is a formality rather than a
 * disclosure. Demographics, veteran status, disability and work authorization
 * are deliberately absent: there, agreeing states a fact about the candidate.
 */
const SELF_EVIDENT_CONSENT_CATEGORIES = new Set(["legal-attestation", "general", "reference"]);

/**
 * Whether a stored answer is itself an agreement. A sole consent option is only
 * taken on the candidate's behalf when his own stored answer already agrees:
 * a decline must never be converted into consent just because the form offers
 * nothing else.
 */
function isConsentingAnswer(value: string): boolean {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return /^(?:yes|true|(?:i )?(?:acknowledge|agree|accept|consent|certify|confirm|understand|understood))\b/.test(
    normalized,
  );
}

/**
 * A required choice offering exactly one consent option carries no decision:
 * the sole option is the only submittable value. Returns it so drafting does
 * not block on a field a person could only ever answer one way.
 */
function soleConsentOption(question: FormQuestion): string | undefined {
  if (!question.required) return undefined;
  const options = question.options ?? [];
  if (options.length !== 1) return undefined;
  const only = options[0] ?? "";
  const normalized = only.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return SOLE_CONSENT_OPTION.test(normalized) || ATTESTATION_SENTENCE.test(normalized) ? only : undefined;
}

/**
 * The same rule under the stricter test used in sensitive categories, where a
 * lone option may only be taken when it agrees to a document or process rather
 * than stating something about the candidate.
 */
function soleDocumentConsentOption(question: FormQuestion): string | undefined {
  const only = soleConsentOption(question);
  return only !== undefined && consentsToDocument(only) ? only : undefined;
}

/** Questions still missing an answer that the form requires. */
export function unresolvedRequired(questions: readonly FormQuestion[], answers: readonly DraftAnswer[]): string[] {
  const byKey = new Map(answers.map((answer) => [answer.questionKey, answer]));
  return questions
    .filter((question) => question.required)
    .filter((question) => {
      const answer = byKey.get(question.key);
      if (answer?.notApplicable) return false;
      return !answer || answer.answer.trim().length === 0;
    })
    .map((question) => question.label);
}
