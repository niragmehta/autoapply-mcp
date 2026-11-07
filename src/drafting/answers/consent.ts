import type { Profile } from "../../domain/profile.js";
import { consentsToDocument } from "../documentConsent.js";
import type { FormQuestion } from "./formQuestion.js";

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
export function declinesDemographics(profile: Profile): boolean {
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
export const SELF_EVIDENT_CONSENT_CATEGORIES = new Set(["legal-attestation", "general", "reference"]);

/**
 * Whether a stored answer is itself an agreement. A sole consent option is only
 * taken on the candidate's behalf when his own stored answer already agrees:
 * a decline must never be converted into consent just because the form offers
 * nothing else.
 */
export function isConsentingAnswer(value: string): boolean {
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
export function soleConsentOption(question: FormQuestion): string | undefined {
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
export function soleDocumentConsentOption(question: FormQuestion): string | undefined {
  const only = soleConsentOption(question);
  return only !== undefined && consentsToDocument(only) ? only : undefined;
}
