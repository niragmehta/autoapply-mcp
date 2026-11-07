/**
 * Small, honest statistics. Every rate travels with the count it was taken
 * over, so no reader ever sees "50%" without seeing that it was 1 of 2.
 */

export type Rate = { n: number; count: number; rate: number | null };

export const round = (value: number, places = 3): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

export function rate(count: number, n: number): Rate {
  return { n, count, rate: n > 0 ? round(count / n) : null };
}

export type Distribution = { n: number; median: number | null; p75: number | null };

function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const low = sorted[lower]!;
  const high = sorted[upper]!;
  return low + (high - low) * (position - lower);
}

export function distribution(values: readonly number[], places = 1): Distribution {
  const sorted = [...values].sort((a, b) => a - b);
  const median = percentile(sorted, 0.5);
  const p75 = percentile(sorted, 0.75);
  return {
    n: sorted.length,
    median: median === null ? null : round(median, places),
    p75: p75 === null ? null : round(p75, places),
  };
}

/** Ranks with ties sharing their average rank, 1-based. */
export function averageRanks(values: readonly number[]): number[] {
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const ranks = new Array<number>(values.length).fill(0);
  let start = 0;
  while (start < order.length) {
    let end = start;
    while (end + 1 < order.length && order[end + 1]!.value === order[start]!.value) end += 1;
    const shared = (start + end) / 2 + 1;
    for (let position = start; position <= end; position += 1) ranks[order[position]!.index] = shared;
    start = end + 1;
  }
  return ranks;
}

function pearson(xs: readonly number[], ys: readonly number[]): number | null {
  const n = xs.length;
  if (n < 2 || ys.length !== n) return null;
  const meanX = xs.reduce((sum, value) => sum + value, 0) / n;
  const meanY = ys.reduce((sum, value) => sum + value, 0) / n;
  let covariance = 0;
  let varianceX = 0;
  let varianceY = 0;
  for (let index = 0; index < n; index += 1) {
    const dx = xs[index]! - meanX;
    const dy = ys[index]! - meanY;
    covariance += dx * dy;
    varianceX += dx * dx;
    varianceY += dy * dy;
  }
  if (varianceX === 0 || varianceY === 0) return null;
  return covariance / Math.sqrt(varianceX * varianceY);
}

/** Spearman's rank correlation; null when either side has no variation. */
export function spearman(xs: readonly number[], ys: readonly number[]): number | null {
  const rho = pearson(averageRanks(xs), averageRanks(ys));
  return rho === null ? null : round(rho, 3);
}

/** ISO 8601 week, such as 2026-W45, of a UTC instant. */
export function isoWeek(value: string | Date): string {
  const date = typeof value === "string" ? new Date(value) : value;
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((day.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export const SCORE_BANDS = ["<70", "70-79", "80-89", "90+"] as const;

export function scoreBand(score: number | null): string {
  if (score === null || !Number.isFinite(score)) return "unscored";
  if (score >= 90) return "90+";
  if (score >= 80) return "80-89";
  if (score >= 70) return "70-79";
  return "<70";
}

export const DAY_MS = 24 * 60 * 60 * 1000;

export function daysBetween(fromIso: string, toIso: string): number {
  return (Date.parse(toIso) - Date.parse(fromIso)) / DAY_MS;
}
