/**
 * Whether a years-of-experience question is asking about a named subject.
 *
 * The answer bank holds one general "how many years of experience" answer. Its
 * broadest pattern is literally "how many years", which also matches "How many
 * years of the Go (Golang) experience do you have?" and "How many years of
 * progressive, hands-on Data Engineering experience do you have?" - both on
 * Teleport's form. Answering those from the general entry states a number of
 * years in a language and a discipline the profile never claims, which is a
 * fabricated qualification rather than a formatting slip.
 *
 * A question that names a subject may therefore only be answered by an entry
 * that names the same subject. Anything else is left for a person, because an
 * unanswered question is honest and a wrong number is not.
 */

/**
 * Words that qualify how experience is counted without naming a different
 * subject. "Years of professional experience" and "years of hands-on software
 * engineering experience" are both the general question.
 */
const GENERIC_QUALIFIERS = new Set([
  "a",
  "an",
  "and",
  "applicable",
  "career",
  "coding",
  "combined",
  "cumulative",
  "development",
  "do",
  "direct",
  "engineering",
  "experience",
  "full",
  "fulltime",
  "general",
  "hands",
  "have",
  "in",
  "industry",
  "of",
  "on",
  "or",
  "overall",
  "paid",
  "post",
  "prior",
  "previous",
  "professional",
  "programming",
  "progressive",
  "graduation",
  "related",
  "relevant",
  "software",
  "technical",
  "the",
  "time",
  "total",
  "using",
  "with",
  "work",
  "working",
  "world",
  "year",
  "years",
  "you",
  "your",
  "yrs",
  "real",
]);

const YEARS_OF_SUBJECT = /\byears?\b[^?.]{0,30}?\bof\b\s+([^?.]{0,80}?)\s*\bexperience\b/i;
const EXPERIENCE_WITH_SUBJECT = /\byears?\b[^?.]{0,40}?\bexperience\s+(?:with|in|using)\s+([^?.,;]{1,60})/i;

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9+#.]+/g, " ")
    .split(/\s+/)
    .map((word) => word.replace(/[.]+$/, ""))
    .filter((word) => word.length > 1);
}

/**
 * The subjects a years-of-experience question names, or an empty list when it
 * asks the general question.
 */
export function experienceSubjects(label: string): string[] {
  // "years of experience with Kubernetes" satisfies both shapes, and the first
  // leaves the subject on the far side of the word "experience", so take both.
  const qualifiers = [label.match(YEARS_OF_SUBJECT)?.[1], label.match(EXPERIENCE_WITH_SUBJECT)?.[1]].filter(
    (part): part is string => typeof part === "string",
  );
  if (qualifiers.length === 0) return [];
  return [...new Set(words(qualifiers.join(" ")).filter((word) => !GENERIC_QUALIFIERS.has(word)))];
}

/**
 * True when the question names a subject and the candidate text never does, so
 * this answer would be stating years of something it does not describe.
 */
export function statesUnrelatedExperience(label: string, describedBy: readonly string[]): boolean {
  const subjects = experienceSubjects(label);
  if (subjects.length === 0) return false;
  const described = words(describedBy.join(" "));
  return !subjects.some((subject) => described.includes(subject));
}
