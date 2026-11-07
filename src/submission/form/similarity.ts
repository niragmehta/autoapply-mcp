import type { DraftAnswer } from "../../domain/job.js";
import { canonicalizeWorkPermission } from "../../text/workPermission.js";
import { normalizeLabel, type FieldDescriptor } from "./fieldModel.js";

function tokens(value: string): string[] {
  return normalizeLabel(value).split(" ").filter((token) => token.length > 2);
}

/**
 * True when `needle` appears in `haystack` as whole words rather than as an
 * accident of spelling.
 *
 * Labels are compared by containment so that "Your Full Name" can take the
 * "Full Name" answer. A raw substring test also treats any short label that
 * happens to be spelled inside a longer one as a 0.85 match, which is not a
 * near miss but a confidently wrong fill: NVIDIA's "City" scored 0.85 against
 * "What is your ethnicity?" - because "ethni-city" contains it - and wrote
 * "Decline to self-identify" into the candidate's address. The same trap is
 * waiting in "age" inside "language" and "id" inside "identify".
 */
function containsPhrase(haystack: string, needle: string): boolean {
  for (let from = 0; from <= haystack.length - needle.length; ) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return false;
    const startsWord = at === 0 || haystack[at - 1] === " ";
    const endsWord = at + needle.length === haystack.length || haystack[at + needle.length] === " ";
    if (startsWord && endsWord) return true;
    from = at + 1;
  }
  return false;
}

/**
 * Whether `container` is so much longer than `contained` that finding the one
 * inside the other says nothing about them asking the same thing. A one-word
 * field such as PayPal's "Language" turns up inside any long question that
 * mentions the word, such as "Do you have professional experience working with
 * the specific language or tech stack for this role ...?".
 */
function dwarfs(container: string, contained: string): boolean {
  const containerTokens = tokens(container).length;
  return containerTokens >= 6 && containerTokens >= 4 * Math.max(1, tokens(contained).length);
}

/**
 * Scores how alike a field label and an answer label are, in that order. The
 * order matters for containment: a long field label holding a short answer
 * label ("Please share your LinkedIn profile URL" / "LinkedIn Profile") is the
 * ordinary case, while a short field label found inside a long answer label is
 * only as good as their token overlap once the answer dwarfs it.
 */
export function similarity(a: string, b: string): number {
  const left = normalizeLabel(a);
  const right = normalizeLabel(b);
  if (left.length === 0 || right.length === 0) return 0;
  if (left === right) return 1;
  if (containsPhrase(left, right)) return 0.85;
  if (containsPhrase(right, left) && !dwarfs(right, left)) return 0.85;
  const leftTokens = new Set(tokens(left));
  const rightTokens = tokens(right);
  if (leftTokens.size === 0 || rightTokens.length === 0) return 0;
  const overlap = rightTokens.filter((token) => leftTokens.has(token)).length;
  return overlap / Math.max(leftTokens.size, rightTokens.length);
}

/**
 * A stored answer about where the candidate is. "Are you open to relocation?"
 * contains "location" and "Which office location would you prefer?" names a
 * location, but neither says where he is, and both were typed into a Country
 * or residence field.
 */
export function statesOwnLocation(answerLabel: string): boolean {
  return /\blocation\b/.test(answerLabel) && !/\b(?:office|offices|hub|hubs|prefer|preferred|preference)\b/.test(answerLabel);
}

/**
 * "Based" says where someone is only in its residence sense - "based in",
 * "based out of", "are you based", "where are you currently based". Elsewhere
 * it is reasoning or a compound: The Home Depot's "Based on the job
 * description, do you have the required amount of directly relevant work
 * experience?" and Medtronic's "uses AI-based tools in the recruitment process"
 * both took the stored current location as their answer, so a Yes/No select was
 * searched for "Vancouver" and the required field failed. Location tests read
 * the label with every other "based" removed.
 */
export function withoutReasoningBased(label: string): string {
  return label.replace(/\bbased\b/g, (match, offset: number, whole: string) => {
    const after = whole.slice(offset + match.length);
    if (/^\s+(?:in|out of|at|near|from)\b/.test(after)) return match;
    const before = whole.slice(Math.max(0, offset - 30), offset);
    return /\b(?:are you|you are|currently|where are you|where you are)\s*$/.test(before) ? match : " ";
  });
}

export function semanticSimilarity(field: FieldDescriptor, answer: DraftAnswer): number {
  const fieldLabel = normalizeLabel(field.label);
  const answerLabel = normalizeLabel(answer.label);
  if (fieldLabel === "country" && statesOwnLocation(answerLabel)) return 0.7;
  // "Legal First and Last Name" asks for the whole name, but shares only the
  // word "name" with the stored "Full Name" answer, so token overlap scores it
  // ~0.2 and the required field would be left blank once name fragments are
  // ruled out. Pair whole-name questions with the whole-name answer directly.
  if (BARE_NAME_FIELD.test(fieldLabel) && /^(?:your |applicant |candidate )?(?:full |legal )?name$/.test(answerLabel)) {
    return 0.95;
  }
  // "Permitted", "entitled" and the British "authorised" ask what "authorized"
  // asks. SCAN's "legally permitted to work" missed this pairing and lost the
  // field to the location answer.
  const fieldPermission = canonicalizeWorkPermission(fieldLabel);
  const answerPermission = canonicalizeWorkPermission(answerLabel);
  if (
    fieldPermission.includes("legally") &&
    fieldPermission.includes("work") &&
    answerPermission.includes("legally") &&
    answerPermission.includes("work") &&
    (fieldPermission.includes("eligible") || fieldPermission.includes("authorized")) &&
    (answerPermission.includes("eligible") || answerPermission.includes("authorized"))
  ) {
    return 0.8;
  }
  if (
    statesOwnLocation(answerLabel) &&
    /\b(locat(?:ed|ion)|reside|residing|based)\b/.test(withoutReasoningBased(fieldLabel)) &&
    /\b(where|current|currently|reside|residing|based)\b/.test(withoutReasoningBased(fieldLabel))
  ) {
    return 0.7;
  }
  // Self-identification questions are asked in long statutory prose while the
  // stored answer is a two-word label such as "Disability Status", so token
  // overlap alone never clears the confidence floor. Pair them on the
  // characteristic each one is about instead.
  const characteristic = SELF_ID_CHARACTERISTICS.find(
    (test) => test.field.test(fieldLabel) && test.answer.test(answerLabel),
  );
  if (characteristic) return 0.8;
  // An age question and a stored age answer share almost no wording ("at the
  // time of application, are you 18+ years of age" vs "are you 18 years of age
  // or older"), and the surrounding boilerplate drags token overlap under the
  // floor. Pair them explicitly so the correct answer is reachable.
  if (AGE_QUESTION.test(fieldLabel) && AGE_QUESTION.test(answerLabel)) return 0.8;
  return 0;
}

/** Pairs a self-identification question with an answer about the same characteristic. */
const SELF_ID_CHARACTERISTICS: ReadonlyArray<{ field: RegExp; answer: RegExp }> = [
  { field: /\b(disabilit\w*|chronic condition)\b/, answer: /\b(disabilit\w*|chronic condition)\b/ },
  { field: /\bgender\b|\bpronoun/, answer: /\bgender\b|\bpronoun/ },
  { field: /\b(racial|race|ethnic\w*|hispanic|latino)\b/, answer: /\b(racial|race|ethnic\w*|hispanic|latino)\b/ },
  { field: /\b(veteran|military|armed forces)\b/, answer: /\b(veteran|military|armed forces)\b/ },
  { field: /\b(sexual orientation|lgbtq)\b/, answer: /\b(sexual orientation|lgbtq)\b/ },
  { field: /\btransgender\b/, answer: /\btransgender\b/ },
];

export const MIN_CONFIDENCE = 0.6;

export const BARE_NAME_FIELD =
  /^(?:your |applicant |candidate )?(?:full |legal )?name$|\bfirst\s+(?:and\s+|&\s*|\/\s*)?(?:middle\s+(?:and\s+)?)?last\s+name\b/;
export const PARTIAL_NAME_ANSWER = /^(?:first|last|middle|preferred|nick|given|family|sur)\s?name\b/;
export const AGE_QUESTION = /\b(years of age|age of \d|old enough|legal (?:working )?age|18 or older|18 years or older)\b/;
