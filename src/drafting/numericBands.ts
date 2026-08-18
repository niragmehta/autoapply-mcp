/**
 * Matching for questions whose options are numeric bands.
 *
 * "How many years of professional experience do you have?" is usually a closed
 * list of ranges - Figma offers "0 - 2 years", "3 - 4 years", "5 - 10 years",
 * "10+ years" - while a profile states a single figure such as "5+ years".
 * Neither string contains the other, so an accurate answer matched no option at
 * all and blocked a required field.
 *
 * The band containing the stated figure is the only truthful selection, so that
 * is the only one made here. A band starting above the stated figure is never
 * chosen, which means this can under-state experience but can never over-state
 * it.
 */

type Band = { min: number; max: number };

/**
 * Every option that states a figure must parse as a band before any band
 * matching is attempted. Options carrying no digit at all are set aside rather
 * than disqualifying the list: almost every dropdown opens with a placeholder
 * ("Select One", "Select...", "-"), and treating that as a failed parse
 * switched band matching off on the very forms it exists for. Cisco offered
 * "Select One / 0-1 year / 2-3 years / 4+ years" and matched nothing.
 *
 * A digit-free entry can never be the band containing a figure, so ignoring it
 * cannot change which band is chosen. Two parsed bands are still required, so a
 * list that merely happens to mention a number is not read as a set of ranges.
 */
function parseBand(option: string): Band | undefined {
  const text = option.toLowerCase().replace(/,/g, "").trim();
  if (!/\d/.test(text)) return undefined;

  const range = /^(?:\D*?)(\d+(?:\.\d+)?)\s*(?:-|–|—|to)\s*(\d+(?:\.\d+)?)/.exec(text);
  if (range) return { min: Number(range[1]), max: Number(range[2]) };

  const open = /^(?:\D*?)(\d+(?:\.\d+)?)\s*\+/.exec(text);
  if (open) return { min: Number(open[1]), max: Number.POSITIVE_INFINITY };

  const under = /^(?:less than|under|fewer than|below)\s*(\d+(?:\.\d+)?)/.exec(text);
  if (under) return { min: 0, max: Number(under[1]) };

  const over = /^(?:more than|over|at least|greater than)\s*(\d+(?:\.\d+)?)/.exec(text);
  if (over) return { min: Number(over[1]), max: Number.POSITIVE_INFINITY };

  const single = /^(?:\D*?)(\d+(?:\.\d+)?)\b/.exec(text);
  if (single) return { min: Number(single[1]), max: Number(single[1]) };

  return undefined;
}

/** The figure a stored answer states, e.g. "5+ years" or "5.5" -> 5. */
function parseStatedFigure(candidate: string): number | undefined {
  const text = candidate.toLowerCase().replace(/,/g, "").trim();
  // A candidate that is itself a range is an option label, not a stated figure.
  if (/\d\s*(?:-|–|—|to)\s*\d/.test(text)) return undefined;
  const match = /^(?:\D*?)(\d+(?:\.\d+)?)/.exec(text);
  return match ? Number(match[1]) : undefined;
}

/**
 * Index of the band containing the stated figure, or -1.
 *
 * Where two bands touch at the boundary ("5 - 10" and "10+" both contain 10)
 * the one that starts at the figure wins, because a stored "10+ years" means
 * the open-ended band.
 */
export function pickNumericBandIndex(
  optionTexts: readonly string[],
  candidates: readonly string[],
): number {
  if (optionTexts.length < 2) return -1;

  const bands = optionTexts.map((option) => (/\d/.test(option) ? parseBand(option) : null));
  // A figure-bearing option that is not a band means this list is not a set of
  // ranges, so nothing here can be trusted to read it.
  if (bands.some((band) => band === undefined)) return -1;
  if (bands.filter((band) => band !== null).length < 2) return -1;

  for (const candidate of candidates) {
    const figure = parseStatedFigure(candidate);
    if (figure === undefined) continue;

    let best = -1;
    for (let index = 0; index < bands.length; index += 1) {
      const band = bands[index];
      if (!band) continue;
      if (figure < band.min || figure > band.max) continue;
      if (best < 0 || band.min > bands[best]!.min) best = index;
    }
    if (best >= 0) return best;
  }

  return -1;
}
