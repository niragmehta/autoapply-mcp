/**
 * Choice matching for questions rendered as a fixed set of options.
 *
 * Employers ask the same question with different option sets: "How did you
 * hear about us?" might offer "Referral", "Employee referral" or "Word of
 * mouth" for the same underlying answer. An ordered preference list lets one
 * stored answer work across all of them without guessing.
 */

import { pickNumericBandIndex } from "./numericBands.js";

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type OptionMatch = {
  /** The value to submit, or empty when nothing suitable was offered. */
  value: string;
  /** True when the question published options and one of them matched. */
  matchedOption: boolean;
};

/**
 * Picks the first preference the employer actually offers.
 *
 * Preference order is primary and match quality is secondary: each candidate is
 * tried exactly, then as a substring, before moving to the next. A stated first
 * choice of "Referral" therefore beats an exact "LinkedIn" option further down
 * the list, which is what an ordered preference means.
 */
export function selectBestOption(preferences: readonly string[], options?: readonly string[]): OptionMatch {
  const candidates = preferences.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (candidates.length === 0) return { value: "", matchedOption: false };

  // Free-text field: no options to reconcile against, so take the top choice.
  if (!options || options.length === 0) {
    return { value: candidates[0]!, matchedOption: false };
  }

  const normalizedOptions = options.map((option) => ({ raw: option, normalized: normalize(option) }));

  for (const candidate of candidates) {
    const target = normalize(candidate);
    if (target.length === 0) continue;

    const exact = normalizedOptions.find((option) => option.normalized === target);
    if (exact) return { value: exact.raw, matchedOption: true };

    // Runs ahead of containment because it is the stricter test: it only fires
    // when exactly one option opens with the answer's polarity, which is a
    // better reading than the first option that happens to contain the word.
    const polarity = leadingPolarityMatch(normalizedOptions, target);
    if (polarity) return { value: polarity, matchedOption: true };

    if (target.length < 3) continue;

    const contains = normalizedOptions.find((option) => option.normalized.includes(target));
    if (contains) return { value: contains.raw, matchedOption: true };

    const reverse = normalizedOptions.find(
      (option) => option.normalized.length >= 3 && target.includes(option.normalized),
    );
    if (reverse) return { value: reverse.raw, matchedOption: true };
  }

  // Options were published and none matched by text: a numeric band may still
  // contain the stated figure.
  const band = pickNumericBandIndex(options, candidates);
  if (band >= 0) return { value: options[band]!, matchedOption: true };

  // Options were published and none matched: submitting an unlisted value
  // would fail, so this is handed back rather than guessed.
  return { value: "", matchedOption: false };
}

/** A stored answer that says nothing beyond its polarity. */
const BARE_POLARITY = /^(?:yes|no|true|false)$/;

/**
 * Employers routinely spell a yes or a no out as a full sentence: Coinbase
 * offers "No, I am not a current or former Government Official" where the
 * stored answer is simply "No". Neither string contains the other, and "no" is
 * too short to be matched as a substring safely, so a question already answered
 * on file was handed back to a person - on every board that writes its options
 * this way.
 *
 * A leading yes or no is the option restating the question's polarity, so it
 * may be taken for a bare answer of the same polarity. This applies only when
 * exactly one option opens with that polarity: Datadog offers both "Yes, no
 * restriction." and "Yes, but I will need sponsorship in the future.", and
 * choosing between two substantively different claims is a decision, not a
 * match. Where the polarity is ambiguous the older containment rules still
 * decide, so nothing that matched before stops matching.
 */
function leadingPolarityMatch(
  options: readonly { raw: string; normalized: string }[],
  target: string,
): string | undefined {
  if (!BARE_POLARITY.test(target)) return undefined;
  const polarity = target === "true" ? "yes" : target === "false" ? "no" : target;
  const leading = new RegExp(`^${polarity}\\b`);
  const matches = options.filter((option) => leading.test(option.normalized));
  return matches.length === 1 ? matches[0]!.raw : undefined;
}
