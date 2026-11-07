import { label, num, plural } from "./format.js";

/** How runs read in tables and headers. Run types without a reading here fall back to their status and error. */

export function runTitle(run) {
  return `${label(run.type)} run`;
}

const count = (value) => num(value ?? 0);

/** Items a submit run skipped because the posting is confirmed closed, by their code. */
export function postingClosedCount(summary) {
  if (typeof summary?.postingClosed === "number") return summary.postingClosed;
  return Array.isArray(summary?.items) ? summary.items.filter((item) => item?.code === "posting_closed").length : 0;
}

/** "2 posting closed" appended to submit results, so a closed posting never hides in "skipped". */
function closedNote(summary) {
  const closed = postingClosedCount(summary);
  return closed ? `, ${count(closed)} posting closed` : "";
}

/** A liveness summary: `closed` is the count and `closedPostings` the list. Runs stored before that split carried the list in `closed`. */
export function livenessClosed(summary) {
  const postings = Array.isArray(summary?.closedPostings) ? summary.closedPostings : Array.isArray(summary?.closed) ? summary.closed : [];
  const total = typeof summary?.closed === "number" ? summary.closed : postings.length;
  return { total, postings };
}

const READINGS = {
  discovery: (summary) =>
    summary.boards !== undefined
      ? `${count(summary.newPostings)} new, ${count(summary.evaluation?.accepted)} accepted from ${count(summary.boardsQueried)} boards`
      : "",
  prepare: (summary) =>
    summary.selected !== undefined ? `${count(summary.ready)} ready, ${count(summary.needsHuman)} need you, ${count(summary.failed)} failed` : "",
  submit: (summary) =>
    summary.requested !== undefined
      ? `${count(summary.sent)} sent, ${count(summary.failed)} failed, ${count(summary.skipped)} skipped${closedNote(summary)}${summary.prepared ? `, ${count(summary.prepared)} filled` : ""}`
      : "",
  liveness: (summary) =>
    summary.checked !== undefined
      ? `${count(summary.checked)} checked: ${count(summary.open)} open, ${count(livenessClosed(summary).total)} closed, ${count(summary.unknown)} unconfirmed`
      : "",
  inbox: (summary) =>
    summary.candidates !== undefined
      ? `${summary.dryRun ? "Dry run: " : ""}${count(summary.candidates)} replies read, ${count(summary.recorded)} recorded, ${count(summary.proposed)} to review`
      : "",
  alerts: (summary) => (summary.found !== undefined ? `${count(summary.added)} new leads from ${plural(summary.found ?? 0, "posting")}` : ""),
  funded: (summary) => (summary.added !== undefined ? `${count(summary.added)} new companies, ${count(summary.already)} already known` : ""),
  propose: (summary) =>
    Array.isArray(summary.proposals) ? `${plural(summary.proposals.length, "board proposal")}, ${count(summary.unresolved?.length)} without a board` : "",
  harvest: (summary) => {
    if (!summary.harvest) return "";
    const scan = summary.scan ? `, ${count(summary.scan.matching?.length)} with fitting roles` : "";
    return `${count(summary.harvest.added)} new boards from ${count(summary.harvest.pagesRead)} index pages${scan}`;
  },
  "close-stale": (summary) =>
    Array.isArray(summary.closed)
      ? summary.dryRun
        ? `Dry run: ${plural(summary.closed.length, "application")} would be closed as ghosted; nothing recorded`
        : `${plural(summary.closed.length, "application")} closed as ghosted`
      : "",
};

export function runSummary(run) {
  if (run.status === "failed" || run.status === "interrupted") return run.error ?? "";
  const reading = READINGS[run.type];
  return reading && run.summary && typeof run.summary === "object" ? reading(run.summary) : "";
}

export function isActive(run) {
  return run.status === "queued" || run.status === "running";
}

/** A log line about a posting confirmed closed: the run logs the item's code with it. */
export function isClosedLine(line) {
  return line?.data?.code === "posting_closed";
}

/** Log lines that report an application's fate get their own colour in the log. */
export function logClass(line) {
  if (line.level === "error" || /^(FAIL|ERR)\b/.test(line.message)) return "is-error";
  if (line.level === "warn" || /^(SKIP|CLOSED)\b/.test(line.message)) return "is-warn";
  if (/^(SENT|READY|DONE)\b/.test(line.message)) return "is-sent";
  return undefined;
}
