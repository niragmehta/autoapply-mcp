import { extractFigures, figureForms, type EvidenceText } from "../text/figures.js";

/**
 * Number fact checks for stories and outreach.
 *
 * A figure the candidate says out loud or puts in writing is the claim most
 * damaging to get wrong, so numbers in stories and outreach must already
 * appear in verified text. The check is deliberately narrow: equal values
 * (with k/M/B scaling), a percentage only ever matching a percentage, no
 * fuzzy matching. Adapted from the provenance gate in career-ops
 * negotiation-roi.mjs (MIT).
 */

export type NumberCheck = {
  checked: Array<{ token: string; verifiedBy: string | null }>;
  /** Distinct tokens found in no evidence text. */
  unverified: string[];
};

/**
 * Checks every figure in `text` against `evidence`, in order: the first
 * evidence entry holding the value is reported, so callers list preferred
 * sources (a story's cited facts) first.
 */
export function checkNumbers(text: string, evidence: readonly EvidenceText[]): NumberCheck {
  const index = evidence.map((entry) => ({ source: entry.source, forms: new Set(extractFigures(entry.text).flatMap(figureForms)) }));
  const checked = extractFigures(text).map((figure) => {
    const forms = figureForms(figure);
    const hit = index.find((entry) => forms.some((form) => entry.forms.has(form)));
    return { token: figure.raw, verifiedBy: hit?.source ?? null };
  });
  const unverified = [...new Set(checked.filter((entry) => entry.verifiedBy === null).map((entry) => entry.token))];
  return { checked, unverified };
}
