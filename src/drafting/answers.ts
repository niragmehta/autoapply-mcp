import type { Campaign } from "../domain/campaign.js";
import type { DraftAnswer } from "../domain/job.js";
import type { Profile } from "../domain/profile.js";
import { classifyQuestion, isBlockedCategory, looksLikeEssay, questionCore, withoutAsides } from "./blockedQuestions.js";
import { resolveConditionalFollowUps } from "./conditionalFollowUps.js";
import { resolveNarrative, type NarrativeContext } from "./narrative.js";
import { selectBestOption } from "./options.js";
import { resolvePersonal } from "./personal.js";
import { resolveExperience } from "./experience.js";

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
  [/\bfirst name\b/i, (p) => p.identity.fullName.split(/\s+/)[0] ?? "", "identity.fullName"],
  [/\blast name\b|\bsurname\b|\bfamily name\b/i, (p) => p.identity.fullName.split(/\s+/).slice(1).join(" "), "identity.fullName"],
  [/\bfull name\b|\bpreferred name\b|^name$/i, (p) => p.identity.fullName, "identity.fullName"],
  [/\bemail\b/i, (p) => p.identity.email, "identity.email"],
  [/\bphone\b|\bmobile\b|\btelephone\b/i, (p) => p.identity.phone, "identity.phone"],
  [/\blinkedin\b/i, (p) => p.identity.links.linkedin ?? "", "identity.links.linkedin"],
  [/\bgithub\b/i, (p) => p.identity.links.github ?? "", "identity.links.github"],
  [/\b(?:portfolio|website|personal site)\b/i, (p) => p.identity.links.website ?? "", "identity.links.website"],
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
 * A bracketed aside is not the subject of the question; see `withoutAsides`.
 */
function contactResolverFor(label: string) {
  const subject = withoutAsides(label);
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
function matchApprovedAnswer(profile: Profile, label: string) {
  const haystack = label.toLowerCase();
  const residenceAsked = CURRENT_RESIDENCE_QUESTION.test(haystack) && !WORK_AUTHORITY_TEXT.test(haystack);
  let best: { entry: Profile["answers"][number]; length: number } | null = null;
  for (const entry of profile.answers) {
    if (residenceAsked && !statesWhereCandidateLives(entry)) continue;
    for (const pattern of entry.patterns) {
      const needle = pattern.toLowerCase();
      if (!haystack.includes(needle)) continue;
      if (!best || needle.length > best.length) best = { entry, length: needle.length };
    }
  }
  return best?.entry;
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
const CURRENT_RESIDENCE_QUESTION =
  /\b(currently based|currently located|currently living|currently reside|currently residing|are you based|are you located|do you live|do you reside|do you currently live)\b/;
/** Work authorization is phrased as location but asks about legal status. */
const WORK_AUTHORITY_TEXT = /\b(authoriz|sponsor|visa|work permit|eligible to work)/;
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

function canonicalSponsorshipDecision(
  profile: Profile,
  question: FormQuestion,
): Profile["answers"][number] | undefined {
  if (!/sponsor/i.test(question.label)) return undefined;
  if (NAMED_IMMIGRATION_CLASS.test(question.label)) return undefined;
  const options = question.options ?? [];
  if (options.length !== 2 || !options.every((option) => YES_OR_NO.test(option.trim()))) return undefined;
  return profile.answers.find(
    (entry) =>
      canAutoFill(entry) &&
      YES_OR_NO.test(entry.answer.trim()) &&
      entry.patterns.some((pattern) => /sponsor/i.test(pattern)),
  );
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
    ...answerOne(question, profile, blockedCategories, context),
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
    const matched = matchApprovedAnswer(profile, question.label);
    const reviewAll = profile.workAuthorization.alwaysReviewManually;
    // A generic sponsorship answer cannot speak for a form that counts TN as
    // sponsorship; only an entry written for that wording may.
    const tnDefined = TN_DEFINED_SPONSORSHIP.test(question.label) && /sponsor/i.test(question.label);
    const eligible = matched && tnDefined && !namesTnRoute(matched) ? undefined : matched;
    // Fall back only when no stored pattern matched at all: an entry that
    // matched but is deliberately left blank is a standing request to be asked.
    const approved = eligible ?? (reviewAll ? undefined : canonicalSponsorshipDecision(profile, question));
    // This branch used to hand the stored answer straight to the form without
    // consulting the choices on offer. "Which countries would you need
    // sponsorship for?" matches the stored "need sponsorship" answer, so a bare
    // "No" was headed for a list of country names. A stored answer the question
    // does not offer is unusable, whatever its wording says.
    const resolved = approved ? resolveApprovedValue(approved, question) : undefined;
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
          : "",
    };
  }

  // A pre-approved answer is an explicit prior decision, so it can satisfy an
  // otherwise blocked category. Checked before the block so the candidate's own
  // stored choice is honoured.
  const approvedEarly = matchApprovedAnswer(profile, asked.label);
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
    return {
      questionKey: question.key,
      label: question.label,
      answer: personal.answer,
      source: "profile",
      citation: personal.citation,
      requiresHuman: !personal.authorized,
      category: personal.category,
      guidance: "",
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
    const consentOnly = SELF_EVIDENT_CONSENT_CATEGORIES.has(category)
      ? soleConsentOption(question)
      : undefined;
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

  if (category === "contact") {
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

const SOLE_CONSENT_OPTION = /^(?:i )?(?:acknowledge|agree|accept|consent|certify|confirm|understand)\b/;

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
  return SOLE_CONSENT_OPTION.test(normalized) ? only : undefined;
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
