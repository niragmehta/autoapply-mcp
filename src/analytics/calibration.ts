import { isInFlight, type ApplicationRow } from "./dataset.js";
import { rate, scoreBand, SCORE_BANDS, spearman, type Rate } from "./stats.js";

/**
 * Does the score predict what employers do?
 *
 * Only resolved applications are evidence: one that got a reply, was closed,
 * or has waited past the ghosting horizon. One still in flight is neither a
 * success nor a failure yet, and a withdrawal says nothing about the
 * employer. Advisory only: nothing here changes scoring.
 */

type CalibrationBand = { band: string; n: number; replied: Rate; advanced: Rate };

export type Calibration = {
  sample: { resolved: number; inFlight: number; excludedWithdrawn: number; unscored: number };
  bands: CalibrationBand[];
  rankCorrelation: { method: "spearman"; rho: number | null; n: number; outcomeScale: string };
  insufficientData: boolean;
  reason: string | null;
  reading: string;
};

/** Below these the numbers are anecdotes, and are reported as such. */
const CALIBRATION_MIN_RESOLVED = 30;
const CALIBRATION_MIN_ADVANCED = 3;
const CALIBRATION_MIN_BAND_N = 5;

const OUTCOME_SCALE =
  "furthest stage reached: 0 none (no reply, or rejected straight away), 1 acknowledged, 2 screen, 3 assessment, 4 interview, 5 offer";

export function calibrate(cohort: readonly ApplicationRow[], now: Date, ghostAfterDays: number): Calibration {
  const inFlight = new Set(cohort.filter((row) => isInFlight(row, now, ghostAfterDays)));
  const withdrawn = new Set(
    cohort.filter((row) => !inFlight.has(row) && row.outcomes.terminal === "withdrawn" && !row.outcomes.responded),
  );
  const settled = cohort.filter((row) => !inFlight.has(row) && !withdrawn.has(row));
  const resolved = settled.filter((row) => row.score !== null);
  const bands = SCORE_BANDS.map((band) => {
    const members = resolved.filter((row) => scoreBand(row.score) === band);
    return {
      band,
      n: members.length,
      replied: rate(members.filter((row) => row.outcomes.respondedBeyondAcknowledgement).length, members.length),
      advanced: rate(members.filter((row) => row.outcomes.furthestRank >= 2).length, members.length),
    };
  });
  const advancedTotal = resolved.filter((row) => row.outcomes.furthestRank >= 2).length;
  const usableBands = bands.filter((band) => band.n >= CALIBRATION_MIN_BAND_N).length;
  const reason =
    resolved.length < CALIBRATION_MIN_RESOLVED
      ? `only ${resolved.length} resolved, scored applications (need ${CALIBRATION_MIN_RESOLVED})`
      : advancedTotal < CALIBRATION_MIN_ADVANCED
        ? `only ${advancedTotal} reached a screen or beyond (need ${CALIBRATION_MIN_ADVANCED})`
        : usableBands < 2
          ? `fewer than two score bands have ${CALIBRATION_MIN_BAND_N} or more applications`
          : null;
  const rho = reason ? null : spearman(resolved.map((row) => row.score ?? 0), resolved.map((row) => row.outcomes.furthestRank));
  return {
    sample: {
      resolved: resolved.length,
      inFlight: inFlight.size,
      excludedWithdrawn: withdrawn.size,
      unscored: settled.length - resolved.length,
    },
    bands,
    rankCorrelation: { method: "spearman", rho, n: resolved.length, outcomeScale: OUTCOME_SCALE },
    insufficientData: reason !== null,
    reason,
    reading: describe(rho, resolved.length, reason),
  };
}

function describe(rho: number | null, n: number, reason: string | null): string {
  if (reason) return `Not enough evidence to judge the score yet: ${reason}.`;
  if (rho === null) return `No variation to correlate across ${n} resolved applications.`;
  const strength = Math.abs(rho) < 0.1 ? "no meaningful" : Math.abs(rho) < 0.3 ? "a weak" : Math.abs(rho) < 0.5 ? "a moderate" : "a strong";
  const direction = rho >= 0 ? "higher scores going further" : "higher scores going less far";
  return strength === "no meaningful"
    ? `Score shows no meaningful relationship with how far applications get (rho ${rho}, n ${n}).`
    : `Score shows ${strength} relationship with how far applications get, ${direction} (rho ${rho}, n ${n}).`;
}
