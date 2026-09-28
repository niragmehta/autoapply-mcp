import { askedSentences } from "./questionIntent.js";

/**
 * Canonicalizes the way a board words legal permission to work.
 *
 * "Authorized to work", "eligible to work", "entitled to work" and "permitted
 * to work" ask one question, and boards pick freely between them. Stored
 * answers are matched as literal substrings, so an answer written for one
 * wording matched none of the others: Pear VC's required "Are you currently
 * eligible to work in the United States of America?" was left blank while a
 * settled "Yes" for "currently authorized to work in the U.S." sat on file, and
 * the application could not be submitted.
 *
 * Rewriting both the question and the stored pattern to one form lets a single
 * approved answer cover every phrasing, without adding a variant of every
 * pattern to the profile.
 *
 * "Able to work" is deliberately excluded. "Able to work from our Santa Clara
 * office two days a week" asks about commuting, not immigration status, and
 * folding it in here would let a work-authorization answer fill it.
 */
const WORK_PERMISSION_SYNONYM = /\b(?:eligible|entitled|permitted|authorised)\s+to\s+work\b/g;

export function canonicalizeWorkPermission(text: string): string {
  return text.replace(WORK_PERMISSION_SYNONYM, "authorized to work");
}

const WORK_PERMISSION_CONTEXT =
  /\bauthoriz(?:ed|ation)\b.{0,20}\bwork\b|\b(?:work authorization|right to work|permission to work)\b/i;

const WORK_PERMISSION_SCOPES: readonly RegExp[] = [
  /\b(?:any|all)\s+(?:(?:u[\s.]*s\.?|united states)\s+)?employers?\b/i,
  /\bunrestricted\b|\b(?:without|no)\s+(?:(?:any|employment|employer|work)\s+)?restrictions?\b/i,
  /\bindefinite(?:ly)?\b|\bpermanently\b|\bpermanent\s+(?:basis|work authorization|authorization|right to work|residen(?:cy|t))\b/i,
];

/** A general permission does not establish a more specific legal scope. */
export function workPermissionScopeMismatch(question: string, descriptions: readonly string[]): boolean {
  const canonical = canonicalizeWorkPermission(question.toLowerCase());
  if (!WORK_PERMISSION_CONTEXT.test(canonical)) return false;
  const source = descriptions.join(" ");
  return WORK_PERMISSION_SCOPES.some((scope) => scope.test(canonical) && !scope.test(source));
}

/**
 * Whether the candidate needs sponsorship and whether he is authorized to work
 * share most of their wording and take opposite answers. Zip asks "Will you now
 * or in the future require sponsorship to work in the country where this role is
 * located?", and the longest stored pattern inside that sentence belonged to the
 * authorization answer, so the draft told the employer "Yes" - he needs
 * sponsorship. A question asking whether sponsorship is required may only be
 * answered by an entry written about sponsorship.
 *
 * Only the sentence that asks is read, because that is the question; boards
 * surround it with conditions such as "You must be authorized to work without
 * the need for employer sponsorship", before it as often as after.
 * "Authorized ... without requiring sponsorship" asks about authorization and is
 * left to the authorization answer.
 */
const REQUIRES_SPONSORSHIP =
  /\b(?:require[sd]?|requiring|need(?:s|ed)?|needing)\b[^?]{0,80}\bsponsor|\bsponsor\w*\b[^?]{0,40}\b(?:required|needed)\b/;
const WITHOUT_SPONSORSHIP = /\bwithout\b[^?]{0,60}\bsponsor/;
const SPONSORSHIP_SUBJECT = /\bsponsor/;

function writtenAboutSponsorship(text: string): boolean {
  const lower = text.toLowerCase();
  return SPONSORSHIP_SUBJECT.test(lower) && !WITHOUT_SPONSORSHIP.test(lower);
}

/** Whether the question asks if sponsorship will be required, judged from the sentences that ask. */
export function asksWhetherSponsorshipRequired(question: string): boolean {
  // Split before lowercasing: a sentence only ends before a capital letter.
  return askedSentences(question).some((sentence) => {
    const asked = sentence.toLowerCase();
    return REQUIRES_SPONSORSHIP.test(asked) && !WITHOUT_SPONSORSHIP.test(asked);
  });
}

/** True when the question asks if sponsorship is required and the entry is not about sponsorship. */
export function sponsorshipIntentMismatch(question: string, descriptions: readonly string[]): boolean {
  if (!asksWhetherSponsorshipRequired(question)) return false;
  return !descriptions.some(writtenAboutSponsorship);
}

/**
 * This candidate needs no petition and no lottery, so his plain answer to
 * whether he requires sponsorship is "No". TN status does need a support letter
 * from the employer, though, so a form that counts TN as sponsorship is owed
 * the answer he recorded for that definition. Hinge Health defines sponsorship
 * as "(H-1B, H-1B1, E-3, O-1, or TN)" and asks the candidate to certify the
 * answer is true; only an answer written for a definition naming TN may answer
 * a question that uses one. Drafting applies the same rule to questions an
 * employer publishes; these serve the live form, where most boards publish none.
 */
const TN_ROUTE = /\b(?:tn|usmca|nafta)\b/i;
const NEGATED = /\b(?:not|don't|do not|doesn't|does not|never|no longer|won't|will not)\b/i;

/** Whether the text counts TN status as sponsorship. */
export function definesSponsorshipWithTn(text: string): boolean {
  return TN_ROUTE.test(text) && SPONSORSHIP_SUBJECT.test(text.toLowerCase());
}

/** Whether any of an answer's descriptions names the TN route. */
export function namesTnRoute(descriptions: readonly string[]): boolean {
  return descriptions.some((text) => TN_ROUTE.test(text));
}

/** True when the question counts TN as sponsorship and the answer was not written for one that does. */
export function tnSponsorshipMismatch(question: string, descriptions: readonly string[]): boolean {
  return definesSponsorshipWithTn(question) && !namesTnRoute(descriptions);
}

/** "TN status is not considered sponsorship": a clause that names TN only to exclude it. */
export function excludesTnFromSponsorship(question: string): boolean {
  return question.split(/[.?;]/).some((clause) => TN_ROUTE.test(clause) && NEGATED.test(clause));
}
