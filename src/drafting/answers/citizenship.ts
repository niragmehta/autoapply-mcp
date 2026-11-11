import type { Profile } from "../../domain/profile.js";
import { opensAsYesNo } from "../../text/yesNoQuestion.js";
import type { FormQuestion } from "./formQuestion.js";

/**
 * Spire asked "Please select your citizenship." over a list of countries, and
 * "If you have dual citizenship, please select your second citizenship." over
 * the same list with "Not Applicable" added. The profile records the
 * candidate's citizenship as a verified fact, yet both drafts carried the
 * free-text authorization statement, which no country in a list reads.
 *
 * Only a request to name a citizenship is answered here. A yes/no question
 * about citizenship asks something else: Telnyx's OFAC question covers
 * permanent residence too, which the profile does not record. And a candidate
 * holding more than one citizenship has to choose which a form should see.
 */
const SECOND_CITIZENSHIP = /\b(?:second|dual|other|additional)\s+(?:citizenship|nationality)\b/i;
const NOT_APPLICABLE = /^\s*(?:not applicable|n\/?a|none)\b/i;
const NAMES_CITIZENSHIP =
  /\b(?:select|indicate|choose|provide|specify|what|which)\b[^?]*\b(?:citizenship|nationality)\b|^\s*(?:(?:country\s+of\s+)?citizenship|nationality)\s*[:*]?\s*$/i;

export function citizenshipChoice(question: FormQuestion, profile: Profile): string | undefined {
  const options = question.options ?? [];
  const held = profile.workAuthorization.citizenships;
  if (options.length === 0 || held.length !== 1 || opensAsYesNo(question.label)) return undefined;
  if (SECOND_CITIZENSHIP.test(question.label)) return sole(options.filter((option) => NOT_APPLICABLE.test(option)));
  if (!NAMES_CITIZENSHIP.test(question.label)) return undefined;
  const country = normalized(held[0]!);
  const exact = options.filter((option) => normalized(option) === country);
  if (exact.length > 0) return sole(exact);
  // "Canada (CA)" and the like: the country followed by a code or note.
  return sole(options.filter((option) => normalized(option).startsWith(`${country} `)));
}

function sole(options: readonly string[]): string | undefined {
  return options.length === 1 ? options[0] : undefined;
}

function normalized(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
