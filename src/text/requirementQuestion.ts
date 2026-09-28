/**
 * Whether a question asks if the candidate can meet a condition of the job.
 *
 * Such questions often name disability only to exempt it. SCAN Health Plan asks
 * whether the candidate can provide tuberculosis screening "unless you have a
 * disability / medical reason", and the bare word made it read as a
 * self-identification question: the stored disability status was put forward
 * as the answer to a health-screening requirement. Asking whether a requirement
 * can be met is never a request to disclose a characteristic.
 */
const REQUIREMENT_QUESTION =
  /\b(?:are you able to|(?:will|would) you be able to|able to (?:meet|comply with|satisfy)|can you (?:meet|comply with|satisfy|provide|pass|complete)|meet (?:this|these|the|all) (?:requirements?|conditions?))\b/i;

export function asksAbilityToMeetRequirement(label: string): boolean {
  return REQUIREMENT_QUESTION.test(label);
}
