import type { Profile } from "../../domain/profile.js";
import { withoutAsides } from "../blockedQuestions.js";

export const CONTACT_RESOLVERS: ReadonlyArray<readonly [RegExp, (profile: Profile) => string, string]> = [
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
 * Other ways a closed list may write the same contact fact. Dropbox's "Current
 * Location" offers "Canada - British Columbia", which neither contains nor is
 * contained in "Vancouver, British Columbia, Canada", so the region alone is
 * tried next. The country alone is deliberately not: on a list split by
 * province it would pick whichever province happens to come first.
 */
export function contactAlternatives(citation: string, profile: Profile): string[] {
  if (citation !== "identity.location") return [];
  const region = profile.identity.location.region.trim();
  return region.length > 0 ? [region] : [];
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
 * Anysphere asks "Has someone at Cursor or Graphite referred you for this role?
 * If so, please include their email here", and the candidate's own address was
 * filled in, naming him as his own referrer. "Their" details belong to the
 * person the question is about; it only counts when the label names another
 * person, because "Applicants must provide their phone number" is his own.
 */
const THEIR_CONTACT = new RegExp(`\\btheir(?:\\s+\\S+){0,2}?\\s+${CONTACT_NOUN}\\b`, "i");
const NAMES_ANOTHER_PERSON =
  /\b(?:refer\w*|someone|somebody|anyone|anybody|employee|colleague|friend|recruiter|manager|references?)\b/i;

export function contactResolverFor(label: string) {
  // A bracketed aside is not the subject of the question.
  const subject = withoutAsides(label);
  if (THIRD_PARTY_CONTACT.test(subject)) return undefined;
  if (THEIR_CONTACT.test(subject) && NAMES_ANOTHER_PERSON.test(subject)) return undefined;
  return CONTACT_RESOLVERS.find(([pattern]) => pattern.test(subject));
}
