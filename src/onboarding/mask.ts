/**
 * Masking for profile values shown back to an agent.
 *
 * Onboarding tools report what is configured so the agent can ask about what
 * is missing. They never need the value itself to do that, and an email,
 * phone number, address or date of birth echoed into a chat transcript is a
 * value that then lives in someone else's logs.
 */

export function maskEmail(value: string): string {
  const trimmed = value.trim();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return trimmed.length > 0 ? "***" : "";
  return `${trimmed[0]}***@${trimmed.slice(at + 1)}`;
}

/** Keeps the formatting and the last two digits, enough to tell two numbers apart. */
export function maskPhone(value: string): string {
  const digits = value.replace(/\D/g, "").length;
  if (digits === 0) return value.trim().length > 0 ? "***" : "";
  let seen = 0;
  return value.trim().replace(/\d/g, (digit) => {
    seen += 1;
    return seen > digits - 2 ? digit : "*";
  });
}

/** For values with no safe partial form: says only whether something is there. */
export function presence(value: string | undefined | null): "set" | "empty" {
  return value && value.trim().length > 0 ? "set" : "empty";
}
