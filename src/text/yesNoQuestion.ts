/**
 * Whether a form label asks a yes/no question rather than asking for a value.
 *
 * A stored fact - a name, a province, a location - answers a question that asks
 * for it, never one that asks whether something is so. The test used to look
 * only at a label that opened with "do you" or "are you", and live forms put
 * other words first:
 *
 * - a time or condition: Procore's "Within the past 2 years, have you been
 *   employed by a U.S. federal, state or local government entity ...?" and
 *   Breeze Airways' "If you do not currently reside in the area of the position
 *   ..., are you willing to relocate ...?";
 * - a subject other than "you": Breeze's "Do the first and last names provided
 *   on the first page match your legal name ...?";
 * - a statement before the question: Abbott's "State and federal law require
 *   Abbott to track ... Are you: (A) ... (C) None of the above."
 *
 * Each took a stored fact on a shared word ("state", "name", "reside") and failed
 * against a list that offered only Yes, No or lettered choices.
 *
 * Only the first question in the label is read, so "What city do you live in?
 * Are you open to relocating?" still asks for the city. A label opening with a
 * question word asks for a value however it continues: "If you live in the US,
 * which state do you live in?" wants the state.
 */
const NUMBERING = String.raw`(?:(?:\(?\d{1,2}[.):]|\(?[a-z][.)]|q\d{1,2}[.:)]?)\s*)?`;
const QUESTION_WORD = String.raw`(?:what|which|where|when|who|whom|whose|how|why)\b`;
// A time phrase, a condition or a whole sentence ahead of the question.
const LEAD_IN = String.raw`(?:(?!\s*${QUESTION_WORD})[^?]{0,300}?[,.;:]\s+)?`;
const AUXILIARY = String.raw`(?:do|does|did|are|is|was|were|will|would|have|has|had|can|could|may|should|shall)`;
const SUBJECT = String.raw`(?:you|we|i|there|the|this|that|these|those|your|any|all|each|either|neither)`;
const YES_NO_QUESTION = new RegExp(String.raw`^\s*${NUMBERING}${LEAD_IN}${AUXILIARY}\s+${SUBJECT}\b`, "i");

export function opensAsYesNo(label: string): boolean {
  const question = (label.split("?")[0] ?? label).replace(/\s+/g, " ");
  return YES_NO_QUESTION.test(question);
}
