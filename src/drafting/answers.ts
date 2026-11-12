import type { Campaign } from "../domain/campaign.js";
import type { DraftAnswer } from "../domain/job.js";
import type { Profile } from "../domain/profile.js";
import { classifyQuestion, isBlockedCategory, looksLikeEssay, questionCore, withoutAsides } from "./blockedQuestions.js";
import { isFreeTextFollowUp, resolveConditionalFollowUps } from "./conditionalFollowUps.js";
import { resolveNarrative, type NarrativeContext } from "./narrative.js";
import { resolvePersonal } from "./personal.js";
import { resolveExperience } from "./experience.js";
import { workPermissionScopeMismatch } from "../text/workPermission.js";
import { valueShapeMismatch, type TextControl } from "./valueShape.js";
import {
  OFFERS_DECLINE, blocked, canAutoFill, matchApprovedAnswer, polarAnswerToWhichPlace, relocationChoice,
  resolveApprovedValue, yesNoForEssay,
} from "./answers/approved.js";
import {
  SELF_EVIDENT_CONSENT_CATEGORIES, declinesDemographics, isConsentingAnswer, soleConsentOption,
  soleDocumentConsentOption,
} from "./answers/consent.js";
import { CONTACT_RESOLVERS, contactAlternatives, contactResolverFor } from "./answers/contact.js";
import { citizenshipChoice } from "./answers/citizenship.js";
import type { FormQuestion } from "./answers/formQuestion.js";
import {
  canonicalSponsorshipDecision, canonicalTnSponsorshipDecision, definesSponsorshipWithTn, namesTnRoute, resolveTnChoice,
  tnSponsorshipGuidance,
} from "./answers/sponsorship.js";

/**
 * Answer policy engine.
 *
 * Answers may only come from verified profile data or a pre-approved answer.
 * Anything else is handed back for a human to decide. Nothing is invented here.
 */

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

/**
 * What a person is asked to confirm on a work-authorization question the draft
 * may not settle. A suggestion the form does not offer is no suggestion: every
 * readiness check reads a non-blank answer as given, so Navan's Yes/No/Unknown
 * question carrying the free-text authorization statement looked answered, was
 * sent for submission and failed at the dropdown, as ten others did in the
 * November 2026 round. Blank, it stays outstanding until a person chooses. A
 * stored answer is offered as the choice it resolves to; the statement, written
 * for no list, only where a choice reads exactly the same.
 */
function offeredSuggestion(
  question: FormQuestion,
  resolved: { value: string; unmatchedChoice: boolean } | undefined,
  statement: string,
): string {
  if (resolved) return resolved.unmatchedChoice ? "" : resolved.value;
  const options = question.options ?? [];
  if (options.length === 0) return statement;
  const plain = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return options.find((option) => plain(option) === plain(statement)) ?? "";
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
    const resolved = approved ? (resolveTnChoice(approved, question) ?? resolveApprovedValue(approved, question, profile)) : undefined;
    const unusable = resolved?.unmatchedChoice === true;
    const useApproved = approved !== undefined && canAutoFill(approved) && !reviewAll && !unusable;
    const citizenship = !approved && !reviewAll && category === "citizenship" ? citizenshipChoice(question, profile) : undefined;
    if (citizenship) {
      return {
        questionKey: question.key,
        label: question.label,
        answer: citizenship,
        source: "profile",
        citation: "profile.workAuthorization.citizenships",
        requiresHuman: false,
        category,
        guidance: "",
      };
    }
    const suggestion = useApproved
      ? (resolved?.value ?? approved.answer)
      : offeredSuggestion(question, resolved, profile.workAuthorization.statement);
    const options = question.options ?? [];
    return {
      questionKey: question.key,
      label: question.label,
      answer: suggestion,
      source: approved ? "approved-answer" : "profile",
      citation: approved ? `profile.answers.${approved.key}` : "profile.workAuthorization.statement",
      requiresHuman: !useApproved,
      category,
      guidance:
        unusable && approved
          ? `"${approved.answer}" is not one of the offered options: ${options.join(" | ")}`
          : !approved && tnDefined
            ? tnSponsorshipGuidance(question)
            : !approved && workPermissionScopeMismatch(question.label, [])
              ? "This authorization scope needs an explicit matching decision; a generic work-permission answer does not establish it."
              : !approved && suggestion === "" && options.length > 0
                ? `The work authorization statement is not one of the offered options: ${options.join(" | ")}`
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
  const contactValueAsked = CONTACT_RESOLVERS.some(([pattern]) => pattern.test(withoutAsides(question.label)));
  const factualFallback =
    approvedEarly !== undefined &&
    category === "contact" &&
    contactValueAsked &&
    (resolveApprovedValue(approvedEarly, asked, profile).unmatchedChoice || polarAnswerToWhichPlace(question.label, approvedEarly.answer));
  if (approvedEarly && canAutoFill(approvedEarly) && !factualFallback && !yesNoForEssay(question, approvedEarly.answer)) {
    const stated = resolveApprovedValue(approvedEarly, asked, profile);
    // A required self-identification question that offers no way to decline
    // takes the value the candidate stored for exactly that case.
    const noDecline =
      stated.unmatchedChoice && question.required && approvedEarly.whenNoDecline?.trim() &&
      !(question.options ?? []).some((option) => OFFERS_DECLINE.test(option))
        ? resolveApprovedValue({ answer: approvedEarly.whenNoDecline, alternatives: [] }, asked, profile)
        : undefined;
    const resolved = noDecline && !noDecline.unmatchedChoice ? noDecline : stated;
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
      ...(approvedEarly.whenNoDecline ? { whenNoDecline: approvedEarly.whenNoDecline } : {}),
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
    const resolved = offered
      ? resolveApprovedValue({ answer: personal.answer, alternatives: contactAlternatives(personal.citation, profile) }, question, profile)
      : undefined;
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
      const resolved = resolveApprovedValue({ answer: plain, alternatives: contactAlternatives(resolver[2], profile) }, question, profile);
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
