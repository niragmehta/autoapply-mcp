import type { Campaign } from "../domain/campaign.js";
import type { Job } from "../domain/job.js";
import { normalizeForMatch } from "../text/html.js";

/**
 * Archetype detection against the candidate's own targets: the campaign's
 * tracks. A track matches when the title carries one of its target phrases
 * (and none of its exclusions); its keywords then show how deep the match is.
 *
 * "No target" is a real answer, not a gap to paper over: a role that matches
 * no track scores North Star 1 rather than being forced into the nearest label
 * (career-ops' archetype rule, MIT).
 */

export type TrackMatch = {
  trackId: string | null;
  label: string;
  /** True only when a track's title phrase matched. */
  target: boolean;
  titleMatches: string[];
  keywordHits: string[];
  keywordWeight: number;
  /** North Star on the 1-5 scale. */
  northStar: number;
  reason: string;
  alternatives: Array<{ trackId: string; label: string; keywordHits: number }>;
};

type Candidate = { trackId: string; label: string; titleMatches: string[]; excluded: boolean; keywordHits: string[]; keywordWeight: number };

export function detectTrack(job: Pick<Job, "title" | "descriptionText">, campaign: Campaign): TrackMatch {
  const title = normalizeForMatch(job.title);
  const haystack = normalizeForMatch(`${job.title}\n${job.descriptionText}`);
  const candidates: Candidate[] = campaign.tracks.map((track) => {
    const hits = track.keywords.filter((keyword) =>
      [keyword.term, ...keyword.aliases].some((variant) => haystack.includes(variant.toLowerCase())),
    );
    return {
      trackId: track.id,
      label: track.label,
      titleMatches: track.titleIncludes.filter((needle) => title.includes(needle.toLowerCase())),
      excluded: track.titleExcludes.some((needle) => title.includes(needle.toLowerCase())),
      keywordHits: hits.map((keyword) => keyword.term),
      keywordWeight: hits.reduce((sum, keyword) => sum + keyword.weight, 0),
    };
  });

  const ranked = [...candidates].sort((a, b) => {
    const aTarget = a.titleMatches.length > 0 && !a.excluded ? 1 : 0;
    const bTarget = b.titleMatches.length > 0 && !b.excluded ? 1 : 0;
    return bTarget - aTarget || b.keywordWeight - a.keywordWeight || b.titleMatches.length - a.titleMatches.length;
  });
  const best = ranked[0];
  const alternatives = ranked.slice(1, 3).filter((entry) => entry.keywordWeight > 0)
    .map((entry) => ({ trackId: entry.trackId, label: entry.label, keywordHits: entry.keywordHits.length }));

  if (!best) {
    return { trackId: null, label: "Not a target - no tracks configured", target: false, titleMatches: [], keywordHits: [], keywordWeight: 0, northStar: 1, reason: "the campaign defines no tracks", alternatives };
  }
  const target = best.titleMatches.length > 0 && !best.excluded;
  if (target) {
    const deep = best.keywordWeight >= 3;
    return {
      trackId: best.trackId,
      label: best.label,
      target,
      titleMatches: best.titleMatches,
      keywordHits: best.keywordHits,
      keywordWeight: best.keywordWeight,
      northStar: deep ? 5 : 4,
      reason: `title matches "${best.titleMatches.join('", "')}"${deep ? " and the description carries the track's keywords" : "; few track keywords in the description"}`,
      alternatives,
    };
  }
  const northStar = best.excluded ? 1 : best.keywordWeight >= 3 ? 3 : best.keywordWeight > 0 ? 2 : 1;
  return {
    trackId: northStar >= 2 ? best.trackId : null,
    label: northStar >= 2 ? `Not a target - closest track: ${best.label}` : "Not a target - no close match",
    target: false,
    titleMatches: [],
    keywordHits: best.keywordHits,
    keywordWeight: best.keywordWeight,
    northStar,
    reason: best.excluded
      ? `title carries an exclusion of track "${best.label}"`
      : northStar === 1
        ? "no track's title phrases or keywords appear in the posting"
        : `no track title phrase in the title; ${best.keywordHits.length} keyword(s) of "${best.label}" in the description`,
    alternatives,
  };
}
