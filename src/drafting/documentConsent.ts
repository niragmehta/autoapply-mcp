/**
 * Telling a consent to a document apart from a claim about the candidate.
 *
 * A required choice offering exactly one option carries no decision, and the
 * drafting layer already resolves those rather than blocking an application
 * over a field with nothing else to select. That rule is deliberately withheld
 * from sensitive categories, because there a lone "I certify..." can state a
 * fact: "I certify that I have never been convicted of a felony" is a single
 * option, reads as a formality, and is a false claim if untrue.
 *
 * The category is the wrong thing to discriminate on. IonQ's Greenhouse form
 * asks "Background Check Disclosure & Consent" and offers exactly one option,
 * "I agree and acknowledge to the IonQ Background Check Disclosure and
 * Consent." That classifies as criminal-history and so blocked the whole
 * application, yet it discloses nothing: it consents to a process the employer
 * will run later. The privacy notice immediately above it on the same form,
 * identical in kind, resolved fine only because it happened to classify as a
 * legal attestation.
 *
 * What actually separates the two is the object of the verb. Consenting to a
 * *document or process* - a notice, a policy, a disclosure, an authorization,
 * a background check - reveals nothing. Asserting something *about the
 * candidate* does. So a sole option in a sensitive category is taken only when
 * it names a document and makes no personal claim.
 */

/** Nouns that make the option's object a document or a process, not the candidate. */
const DOCUMENT_OBJECT =
  /\b(?:notice|notices|policy|policies|disclosure|disclosures|consent|consents|authorizations?|authorisations?|agreements?|terms|statements?|acknowledge?ments?|background check|credit check|reference check|privacy|form|forms|application|declaration|conditions|guidelines?|code of conduct)\b/;

/**
 * Wording that turns the option into an assertion about the candidate rather
 * than an agreement to a document. A negation ("have not been convicted"), a
 * possessive claim of a personal history, or a statement of eligibility is a
 * fact the server has no standing to assert on his behalf.
 */
const PERSONAL_CLAIM =
  /\b(?:i (?:have )?(?:never|not|no)\b|have not been|has not been|i am not|i do not have|i have no\b|convicted|conviction|felony|misdemeanou?r|criminal record|arrested|incarcerated|guilty|plead)\b/;

/**
 * Whether a lone option consents to a named document or process and claims
 * nothing about the candidate, making it safe to resolve even in a category
 * that otherwise stops for a human decision.
 */
export function consentsToDocument(option: string): boolean {
  const normalized = option.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (normalized.length === 0) return false;
  if (PERSONAL_CLAIM.test(normalized)) return false;
  return DOCUMENT_OBJECT.test(normalized);
}
