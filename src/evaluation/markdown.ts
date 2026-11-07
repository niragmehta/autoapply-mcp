import type { EvaluationScaffold } from "./scaffold.js";
import type { Narrative } from "./report.js";
import { VERDICT_LABELS, type Verdict } from "./scorecard.js";

/**
 * Renders a saved evaluation as Markdown, A-H in the style of career-ops'
 * reports (MIT). Server-computed blocks and the agent's narrative are kept
 * visibly apart, and the posting itself is archived in a fenced block so its
 * markup can never render as links or images.
 */

type ReportDocument = {
  number: number;
  date: string;
  scaffold: EvaluationScaffold;
  narrative: Narrative;
  score: number;
  verdict: Verdict;
  unverifiedFigures: readonly string[];
  descriptionText: string;
};

const LEGITIMACY_LABEL: Readonly<Record<string, string>> = {
  high: "High confidence",
  caution: "Proceed with caution",
  suspicious: "Suspicious",
};

function cell(value: unknown): string {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim() || "-";
}

function table(headers: readonly string[], rows: ReadonlyArray<readonly unknown[]>): string[] {
  if (rows.length === 0) return ["_None._"];
  return [`| ${headers.join(" | ")} |`, `|${headers.map(() => "---").join("|")}|`, ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`)];
}

function fenced(text: string): string[] {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longest + 1);
  return [`${fence}text`, text, fence];
}

function narrativeBlock(text: string | undefined, fallback: string): string[] {
  return text?.trim() ? [text.trim()] : [`_${fallback}_`];
}

function roleSummary(scaffold: EvaluationScaffold): string[] {
  const { job, archetype, level, compensation, liveness } = scaffold;
  return table(
    ["Field", "Value"],
    [
      ["Archetype (track)", archetype.label],
      ["Level", `${level.postingLevel} posting vs ${level.candidateLevel} candidate: ${level.fit}`],
      ["Location", `${job.locations.join(" | ") || "unknown"} (${job.locationClass}, ${job.workplaceType})`],
      ["Employment", job.employmentType],
      ["Posted", job.postedAt ? `${job.postedAt.slice(0, 10)} (${job.ageDays} days ago)` : "not published"],
      ["Compensation", compensation.raw],
      ["Liveness", liveness ? `${liveness.status} (${liveness.detail})` : "not checked"],
      ["Campaign evaluation", `${scaffold.evaluation.decision}, score ${scaffold.evaluation.score}, tier ${scaffold.evaluation.tier}`],
    ],
  );
}

function cvMatch(scaffold: EvaluationScaffold): string[] {
  const rows = scaffold.requirements.slice(0, 15).map((item) => [
    item.text,
    `${item.importance} (${item.weightSource})`,
    item.evidence.tier,
    item.evidence.citations.map((citation) => `${citation.kind} ${citation.ref}: ${citation.quote}`).join("; ") || item.evidence.note || "",
  ]);
  const extra = scaffold.requirements.length > 15 ? [`_${scaffold.requirements.length - 15} more requirement(s) in the stored scaffold._`] : [];
  const gap = scaffold.skillGap;
  return [
    ...table(["Requirement", "Importance", "Evidence", "Source"], rows),
    ...extra,
    "",
    `**Skills already listed:** ${gap.existing.map((entry) => entry.term).join(", ") || "none"}`,
    `**Supported by facts or experience:** ${gap.supportedByProfile.map((entry) => entry.term).join(", ") || "none"}`,
    `**Gaps (never claim these):** ${gap.gap.map((entry) => entry.term).join(", ") || "none"}`,
    "",
    `**Keyword coverage:** ${scaffold.keywords.coveragePercent}% of weighted posting keywords (${scaffold.keywords.document}); safe to emphasise: ${scaffold.keywords.missingSupported.join(", ") || "none"}; missing and unsupported: ${scaffold.keywords.missingUnsupported.join(", ") || "none"}`,
  ];
}

function legitimacy(scaffold: EvaluationScaffold): string[] {
  const rows = scaffold.legitimacy.signals.map((signal) => [signal.severity, signal.observation, signal.evidence, signal.context ?? ""]);
  return [`**Assessment:** ${scaffold.legitimacy.summary}`, "", ...table(["Weight", "Observation", "Evidence", "Context"], rows)];
}

function scoreEvidence(scaffold: EvaluationScaffold): string[] {
  const card = scaffold.scorecard;
  return [
    ...table(
      ["Dimension", "Score", "Status", "Evidence", "Open question"],
      card.dimensions.map((dimension) => [dimension.label, dimension.score ?? "unknown", dimension.status, dimension.evidence.join("; "), dimension.question ?? ""]),
    ),
    "",
    `**Evidence confidence:** ${card.confidence} - ${card.confidenceReason}`,
    `**Deterministic score:** ${card.globalScore}/5 (${card.adjustments.join("; ")})`,
    ...card.verificationPriorities.map((priority) => `- ${priority}`),
  ];
}

function compensationBlock(scaffold: EvaluationScaffold, narrative: Narrative): string[] {
  const pay = scaffold.compensation;
  const research = narrative.compResearch;
  return [
    ...table(
      ["Source", "Figure"],
      [
        ["Advertised (posting)", pay.raw],
        ["Campaign floor check", pay.floorCheck],
        ["Candidate target / minimum", `${pay.candidateTarget.toLocaleString()} / ${pay.candidateMinimum.toLocaleString()} ${pay.candidateCurrency}`],
      ],
    ),
    "",
    ...narrativeBlock(research?.notes, "No compensation research recorded."),
    ...(research && research.sources.length > 0 ? ["", "Sources:", ...research.sources.map((source) => `- ${source.title ? `${source.title}: ` : ""}${source.url}`)] : []),
  ];
}

export function renderReportMarkdown(document: ReportDocument): string {
  const { scaffold, narrative } = document;
  const lines = [
    `# Evaluation ${String(document.number).padStart(3, "0")}: ${scaffold.job.company} - ${scaffold.job.title}`,
    "",
    `**Date:** ${document.date}`,
    `**URL:** ${scaffold.job.url}`,
    `**Archetype:** ${scaffold.archetype.label}`,
    `**Score:** ${document.score}/5 (deterministic ${scaffold.scorecard.globalScore}/5)`,
    `**Decision:** ${VERDICT_LABELS[document.verdict]}`,
    `**Legitimacy:** ${LEGITIMACY_LABEL[scaffold.legitimacy.tier] ?? scaffold.legitimacy.tier}`,
    `**Evidence confidence:** ${scaffold.scorecard.confidence}`,
    ...(scaffold.blacklist ? [`**Do-not-apply list:** ${scaffold.blacklist.entry.scope} "${scaffold.blacklist.entry.value}" (${scaffold.blacklist.entry.reason || "no reason recorded"})`] : []),
    "",
    narrative.summary,
    ...(narrative.scoreDeviation ? ["", `**Why the score differs from the deterministic one:** ${narrative.scoreDeviation}`] : []),
    ...(document.unverifiedFigures.length > 0
      ? ["", `> **Unverified figures:** ${document.unverifiedFigures.join(", ")} appear in the narrative but in neither the scaffold nor the profile. Verify or remove them before relying on this report.`]
      : []),
    "",
    "## A) Role summary",
    ...roleSummary(scaffold),
    "",
    "## B) Match with CV",
    ...cvMatch(scaffold),
    "",
    ...narrativeBlock(narrative.cvMatchNotes, "No CV-match notes recorded."),
    "",
    "## C) Level and strategy",
    `Posting reads as **${scaffold.level.postingLevel}** (${scaffold.level.postingSignals.join("; ")}); candidate: ${scaffold.level.candidateBasis}. Fit: **${scaffold.level.fit}**.`,
    ...scaffold.level.advice.map((advice) => `- ${advice}`),
    "",
    ...narrativeBlock(narrative.strategy, "No strategy notes recorded."),
    "",
    "## D) Compensation",
    ...compensationBlock(scaffold, narrative),
    "",
    "## E) Culture",
    ...narrativeBlock(narrative.cultureNotes, "Not evaluated."),
    "",
    "## F) Interview plan",
    ...table(["Requirement", "Importance", "Evidence", "Why it matters"], scaffold.interviewFocus.map((focus) => [focus.text, focus.importance, focus.evidenceTier, focus.why])),
    "",
    ...narrativeBlock(narrative.interviewPlan, "No interview plan recorded."),
    "",
    "## G) Posting legitimacy",
    ...legitimacy(scaffold),
    "",
    "## Score evidence",
    ...scoreEvidence(scaffold),
    "",
    "## Job description (archived, untrusted)",
    ...fenced(document.descriptionText),
    "",
    "## Machine summary",
    "```json",
    JSON.stringify({ ...scaffold.machineSummary, reportScore: document.score, reportVerdict: document.verdict, unverifiedFigures: document.unverifiedFigures }, null, 2),
    "```",
    "",
  ];
  return lines.join("\n");
}
