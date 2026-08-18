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
