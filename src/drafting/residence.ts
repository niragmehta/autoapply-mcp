import type { Profile } from "../domain/profile.js";

/**
 * Whether a question asks where the candidate lives *now*, and whether it names
 * the place he actually lives.
 *
 * Shared by the answer bank and the personal-field resolver. The bank stores a
 * single blanket answer for "are you located in ...", which reads "No - based in
 * Vancouver, Canada". That is true of everywhere except the one place he lives,
 * so when a board names his own country, province or city - Tailscale asks "Are
 * you located in or willing to relocate to Canada?" - the stored answer states
 * the opposite of the truth. The bank is stopped from denying it and this
 * module supplies the affirmative from the profile's own location.
 */

/** Asks about present residence. Work authorization is phrased the same way but asks about legal status. */
export const CURRENT_RESIDENCE_QUESTION =
  /\b(currently based|currently located|currently living|currently reside|currently residing|are you based|are you located|do you live|do you reside|do you currently live)\b/;

export const WORK_AUTHORITY_TEXT = /\b(authoriz|sponsor|visa|work permit|eligible to work)/;

/**
 * A question asking the inverse names the same place to mean the opposite, so
 * it is excluded and left to a person rather than answered backwards.
 */
const RESIDENCE_INVERTED =
  /\b(?:outside|other than|besides|apart from|except|not (?:currently )?(?:based|located|living|residing))\b/;

/**
 * True when the question names the candidate's own country, region or city.
 *
 * Nothing here reasons about world geography. Either the question names where
 * the profile says he lives, or it does not and the stored answer keeps
 * applying unchanged.
 */
export function namesCandidateLocation(haystack: string, profile: Profile): boolean {
  if (RESIDENCE_INVERTED.test(haystack)) return false;
  const location = profile.identity?.location;
  if (!location) return false;
  const places = [location.country, location.region, location.city].filter(
    (place): place is string => typeof place === "string" && place.trim().length > 2,
  );
  return places.some((place) => new RegExp(`\\b${escapeRegExp(place.trim().toLowerCase())}\\b`).test(haystack));
}

/** True when the question asks about present residence in the place he lives. */
export function asksAboutOwnResidence(haystack: string, profile: Profile): boolean {
  if (!CURRENT_RESIDENCE_QUESTION.test(haystack)) return false;
  if (WORK_AUTHORITY_TEXT.test(haystack)) return false;
  return namesCandidateLocation(haystack, profile);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
