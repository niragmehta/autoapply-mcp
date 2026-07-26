/**
 * Question classification.
 *
 * ATS forms mix harmless contact fields with legally material questions. Each
 * label is mapped to a category so policy can decide what may be auto-filled
 * and what must stop for a human.
 */

const CATEGORY_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["work-authorization", /\b(authoriz|authoris)\w*\b[^?]{0,40}\bwork\b|\bwork\b[^?]{0,30}\b(authoriz|authoris)\w*|\bright to work\b|\blegally (?:able|entitled|eligible) to work\b/i],
  ["sponsorship", /\bsponsor\w*\b|\bvisa\b|\bh-?1b\b|\bwork permit\b|\bimmigration status\b/i],
  ["citizenship", /\bcitizen\w*\b|\bnationality\b|\bpermanent resident\b|\bgreen card\b/i],
  ["clearance", /\bclearance\b|\bts\/sci\b|\btop secret\b|\bpublic trust\b/i],
  ["criminal-history", /\b(convicted|conviction|felony|misdemeanor|criminal (?:record|history)|background check)\b/i],
  ["compensation", /\b(salary|compensation|pay)\b[^?]{0,30}\b(expectation|requirement|range|desired|current)\b|\bdesired (?:salary|compensation)\b|\bcurrent (?:salary|compensation)\b|\bexpected (?:salary|compensation)\b/i],
  ["demographic", /\b(gender|race|racial|ethnic\w*|hispanic|latino|pronoun|sexual orientation|lgbtq|transgender)\b/i],
  ["veteran", /\bveteran\b|\bmilitary service\b|\barmed forces\b/i],
  ["disability", /\bdisabilit\w*\b|\baccommodation\b/i],
  ["legal-attestation", /\b(certify|attest|acknowledge|i agree|consent|gdpr|privacy (?:policy|notice)|terms and conditions)\b/i],
  ["reference", /\breference[sd]?\b|\breferred by\b|\breferral\b/i],
  ["source", /\bhow did you (?:hear|find)\b|\bsource\b/i],
  ["start-date", /\b(start date|available to start|availability|notice period|earliest start)\b/i],
  ["contact", /\b(first name|last name|full name|preferred name|email|phone|mobile|address|city|state|province|postal|zip|country|location|linkedin|github|portfolio|website|resume|cv|cover letter)\b/i],
  ["essay", /\bwhy (?:do you|are you|would you)\b|\btell us\b|\bdescribe\b|\bwhat (?:interests|excites|motivates)\b|\bin your own words\b/i],
];

/**
 * Normalizes an ATS question label before matching.
 *
 * Compliance sections use camel case identifiers such as "DisabilityStatus" and
 * "HispanicLatino", where word-boundary patterns would not fire. Splitting them
 * into words lets one set of patterns cover both styles.
 */
export function normalizeQuestionLabel(label: string): string {
  return label
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function classifyQuestion(label: string): string {
  const raw = label.trim();
  if (raw.length === 0) return "general";
  // Test both forms: normalization splits camel case, which helps compliance
  // labels but would break single-token names such as "LinkedIn".
  const normalized = normalizeQuestionLabel(raw);
  for (const [category, pattern] of CATEGORY_PATTERNS) {
    if (pattern.test(raw) || pattern.test(normalized)) return category;
  }
  return "general";
}

/** True when the category always requires a human decision. */
export function isBlockedCategory(category: string, blockedCategories: readonly string[]): boolean {
  return blockedCategories.includes(category);
}

/** Long free-text questions are never auto-answered, whatever their category. */
export function looksLikeEssay(label: string, fieldType: string): boolean {
  return fieldType === "textarea" && label.trim().length > 0 && classifyQuestion(label) !== "contact";
}
