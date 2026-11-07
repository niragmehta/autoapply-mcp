import type { DraftAnswer } from "../../domain/job.js";
import { DECLINE_ANSWER_PATTERN } from "./answerVocabulary.js";
import { PHONE_COUNTRY_CODE_KEY, isPhoneCodeField } from "./compatibility.js";
import { normalizeLabel } from "./fieldModel.js";

const PHONE_ANSWER_LABEL = /^(?:phone|phone number|mobile|mobile phone|mobile number|telephone)$/;
const NORTH_AMERICAN_NUMBERING = /^(?:canada|united states(?: of america)?|usa|us)$/i;

/**
 * The country a stored number is dialled in, as the answer to a phone-code
 * question. A number written without an international prefix is a local
 * number in the candidate's own country; "+1" belongs to Canada and the United
 * States alike. Any other prefix names a country this cannot confirm, so
 * nothing is derived and the question is left to the board's own default.
 */
function phoneDialCountry(answers: readonly DraftAnswer[], candidateCountry?: string): DraftAnswer | undefined {
  const country = candidateCountry?.trim();
  if (!country) return undefined;
  // A phone code the candidate actually gave wins; an empty placeholder left by
  // an aborted run is not one.
  if (answers.some((answer) => isPhoneCodeField(normalizeLabel(answer.label)) && answer.answer.trim().length > 0)) {
    return undefined;
  }
  const phone = answers.find(
    (answer) => PHONE_ANSWER_LABEL.test(normalizeLabel(answer.label)) && answer.answer.trim().length > 0,
  );
  if (!phone) return undefined;
  const number = phone.answer.trim();
  const international = /^(?:\+|00)/.test(number);
  const digits = number.replace(/^(?:\+|00)/, "").replace(/\D/g, "");
  if (international && !(digits.startsWith("1") && NORTH_AMERICAN_NUMBERING.test(country))) return undefined;
  return {
    questionKey: PHONE_COUNTRY_CODE_KEY,
    label: "Country Phone Code",
    answer: country,
    source: "profile",
    citation: [phone.citation, "identity.location.country"].filter(Boolean).join("; "),
    requiresHuman: false,
    required: true,
    category: "contact",
    guidance: "",
  };
}

/** Adds deterministic browser-only aliases derived from already approved answers. */
export function augmentAnswersForBrowser(
  answers: readonly DraftAnswer[],
  candidateCountry?: string,
): DraftAnswer[] {
  const firstName = answers.find((answer) => normalizeLabel(answer.label) === "first name");
  const lastName = answers.find((answer) => normalizeLabel(answer.label) === "last name");
  const hasLegalName = answers.some((answer) => normalizeLabel(answer.label) === "legal name");
  const derived: DraftAnswer[] = [];
  if (
    !hasLegalName &&
    firstName &&
    lastName &&
    firstName.answer.trim().length > 0 &&
    lastName.answer.trim().length > 0
  ) {
    const whole = `${firstName.answer.trim()} ${lastName.answer.trim()}`;
    const citation = [firstName.citation, lastName.citation].filter(Boolean).join("; ");
    derived.push({
      ...firstName,
      questionKey: "derived-legal-name",
      label: "Legal Name",
      answer: whole,
      citation,
    });
    derived.push({
      ...firstName,
      questionKey: "derived-full-name",
      label: "Full Name",
      answer: whole,
      citation,
    });
  }

  const hasCountry = answers.some((answer) => normalizeLabel(answer.label) === "country");
  if (!hasCountry && candidateCountry?.trim()) {
    derived.push({
      questionKey: "derived-country",
      label: "Country",
      answer: candidateCountry.trim(),
      source: "profile",
      citation: "identity.location.country",
      requiresHuman: false,
      required: true,
      category: "contact",
      guidance: "",
    });
  }

  const phoneCountry = phoneDialCountry(answers, candidateCountry);
  if (phoneCountry) derived.push(phoneCountry);

  const declinesDemographics = answers.some(
    (answer) => answer.category === "demographic" && DECLINE_ANSWER_PATTERN.test(answer.answer.trim()),
  );
  if (declinesDemographics) {
    derived.push({
      questionKey: "derived-demographic-consent",
      label: "I consent to collecting, storing, and processing my responses to the demographic data surveys",
      answer: "Yes",
      source: "profile",
      citation: "candidate approval 2026-07-31; every demographic response is decline to self-identify",
      requiresHuman: false,
      required: true,
      category: "demographic",
      guidance: "",
    });
  }

  return [...answers, ...derived];
}
