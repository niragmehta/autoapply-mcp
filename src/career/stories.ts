import { z } from "zod";
import { appendEvent } from "../db/repositories/events.js";
import { getJob } from "../db/repositories/jobs.js";
import { deleteStoryRecord, getStory, listStoryRecords, saveStoryRecord } from "../db/repositories/career/stories.js";
import type { Fact, Profile } from "../domain/profile.js";
import { extractFigures, profileFigureEvidence, type EvidenceText } from "../text/figures.js";
import { wordCount } from "../text/words.js";
import { AppError } from "../util/errors.js";
import { newId, nowIso } from "../util/hash.js";
import { parseInput, type CareerWorkspace } from "./context.js";
import { checkNumbers, type NumberCheck } from "./factCheck.js";
import { matchStories, type StoryJobMatch } from "./storyMatch.js";
import type { Story } from "./types.js";

/**
 * The story bank: 5-10 STAR + Reflection master stories, each built from
 * verified profile facts, reused across every interview. Adapted from the
 * story-bank format of career-ops (MIT).
 */

const TARGET_STORIES = { min: 5, max: 10 } as const;
/** Roughly two minutes spoken; longer answers lose the interviewer. */
const SPOKEN_WORD_LIMIT = 320;

/** Competencies behavioral rounds probe, from career-ops interview/practice.md. */
const STORY_COMPETENCIES = [
  { id: "delivery", label: "Delivering a difficult project", cues: ["deliver", "ship", "launch", "deadline", "migrat"] },
  { id: "failure", label: "A failure and what changed after it", cues: ["fail", "mistake", "incident", "outage", "postmortem"] },
  { id: "influence", label: "Influencing across teams without authority", cues: ["influenc", "align", "stakeholder", "persuad", "adopt"] },
  { id: "leadership", label: "Leading, mentoring or growing people", cues: ["lead", "mentor", "coach", "hire", "onboard"] },
  { id: "simplify", label: "Simplifying something complex", cues: ["simplif", "automat", "streamlin", "consolidat", "reduc"] },
  { id: "ownership", label: "Solving a problem outside your remit", cues: ["initiative", "volunteer", "unowned", "ownership"] },
  { id: "conflict", label: "A disagreement resolved well", cues: ["conflict", "disagree", "pushback", "trade-off", "tradeoff"] },
  { id: "technical_depth", label: "A hard technical problem", cues: ["design", "architect", "debug", "performance", "scal", "secur"] },
  { id: "customer", label: "Impact on users or customers", cues: ["customer", "user", "client", "revenue", "adoption"] },
] as const;

export const StoryInputSchema = z.object({
  id: z.string().trim().min(1).optional().describe("Existing story id to update; omit to create."),
  title: z.string().trim().min(1).max(160),
  situation: z.string().max(4000).default(""),
  task: z.string().max(4000).default(""),
  action: z.string().trim().min(1, "a story needs an Action").max(6000),
  result: z.string().max(4000).default(""),
  reflection: z.string().max(4000).default(""),
  skills: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
  factIds: z.array(z.string().trim().min(1).max(120)).max(30).default([]),
  tags: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
});
export type StoryInput = z.input<typeof StoryInputSchema>;

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function lower(value: string): string {
  return value.trim().toLowerCase();
}

type ThemeFact = { id: string; statement: string; category: string; metrics: string[]; figures: string[]; tags: string[] };
type StoryTheme = { theme: string; facts: ThemeFact[]; figureCount: number };

/** A tag shared by two or more facts names the theme; a lone fact falls back to its category. */
function primaryTheme(fact: Fact, tagCounts: ReadonlyMap<string, number>): string {
  const shared = unique(fact.tags.map(lower))
    .filter((tag) => (tagCounts.get(tag) ?? 0) > 1)
    .sort((left, right) => (tagCounts.get(right) ?? 0) - (tagCounts.get(left) ?? 0) || left.localeCompare(right));
  return shared[0] ?? lower(fact.category || "experience");
}

export function factThemes(facts: readonly Fact[]): StoryTheme[] {
  const tagCounts = new Map<string, number>();
  for (const fact of facts) {
    for (const tag of unique(fact.tags.map(lower))) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  }
  const groups = new Map<string, ThemeFact[]>();
  for (const fact of facts) {
    const theme = primaryTheme(fact, tagCounts);
    const entry: ThemeFact = {
      id: fact.id,
      statement: fact.statement,
      category: fact.category,
      metrics: fact.metrics,
      figures: unique(extractFigures([fact.statement, ...fact.metrics].join("\n")).map((figure) => figure.raw)),
      tags: fact.tags,
    };
    groups.set(theme, [...(groups.get(theme) ?? []), entry]);
  }
  return [...groups.entries()]
    .map(([theme, themed]) => ({ theme, facts: themed, figureCount: themed.reduce((sum, fact) => sum + fact.figures.length, 0) }))
    .sort((left, right) => right.facts.length - left.facts.length || right.figureCount - left.figureCount || left.theme.localeCompare(right.theme));
}

function mentions(text: string, cues: readonly string[]): boolean {
  const haystack = text.toLowerCase();
  return cues.some((cue) => haystack.includes(cue));
}

function storyText(story: Story): string {
  return [story.title, story.situation, story.task, story.action, story.result, story.reflection, ...story.tags].join("\n");
}

/** Raw material for building or extending the story bank. Reads only; writes nothing. */
export function storyBankScaffold(workspace: Pick<CareerWorkspace, "db" | "profile">) {
  const { profile } = workspace;
  const stories = listStoryRecords(workspace.db);
  const cited = new Set(stories.flatMap((story) => story.factIds));
  return {
    targetStoryCount: TARGET_STORIES,
    format: {
      situation: "Context in one or two sentences: where, when, what was at stake.",
      task: "What you specifically owned.",
      action: "What you did - first person, concrete, the longest part.",
      result: "The outcome, with figures taken only from the cited facts.",
      reflection: "What you learned or would do differently - the senior-candidate signal.",
    },
    themes: factThemes(profile.facts),
    competencies: STORY_COMPETENCIES.map((competency) => ({
      id: competency.id,
      label: competency.label,
      coveredBy: stories
        .filter((story) => story.tags.includes(competency.id) || mentions(storyText(story), competency.cues))
        .map((story) => story.id),
      candidateFacts: profile.facts.filter((fact) => mentions(`${fact.statement} ${fact.tags.join(" ")}`, competency.cues)).map((fact) => fact.id),
    })),
    experience: profile.experience.map((role) => ({ company: role.company, title: role.title, start: role.start, end: role.end })),
    existingStories: stories.map((story) => ({ id: story.id, title: story.title, factIds: story.factIds, tags: story.tags })),
    uncitedFacts: profile.facts.filter((fact) => !cited.has(fact.id)).map((fact) => fact.id),
    rules: [
      `Aim for ${TARGET_STORIES.min}-${TARGET_STORIES.max} master stories; each should answer several behavioral questions.`,
      "Build each story from one theme's facts and cite their ids in factIds.",
      "Every figure in result and action must already appear in the profile; save_story rejects any that do not.",
      "Ask the candidate for missing context (situation, their exact role, the reflection) instead of inventing it.",
      `Keep each story under about ${SPOKEN_WORD_LIMIT} words so it can be told in two minutes.`,
    ],
  };
}

function orderedEvidence(profile: Profile, factIds: readonly string[]): EvidenceText[] {
  const cited = new Set(factIds.map((id) => `fact:${id}`));
  const all = profileFigureEvidence(profile);
  return [...all.filter((entry) => cited.has(entry.source)), ...all.filter((entry) => !cited.has(entry.source))];
}

function knownSkill(profile: Profile, skill: string): boolean {
  const wanted = lower(skill);
  return profile.skills.some((entry) => [entry.name, ...entry.aliases].some((name) => lower(name) === wanted));
}

function storyWarnings(story: Story, profile: Profile, evidence: readonly EvidenceText[], check: NumberCheck): string[] {
  const warnings: string[] = [];
  if (!story.situation.trim()) warnings.push("No situation: add one or two sentences of context.");
  if (!story.result.trim()) warnings.push("No result: a story without an outcome reads as unfinished.");
  if (!story.reflection.trim()) warnings.push("No reflection: add what you learned or would do differently.");
  if (story.factIds.length === 0) warnings.push("No factIds: cite the profile facts this story is built on.");
  const cited = new Set(story.factIds.map((id) => `fact:${id}`));
  for (const entry of check.checked) {
    if (entry.verifiedBy && !cited.has(entry.verifiedBy) && story.factIds.length > 0) {
      warnings.push(`Figure ${entry.token} is verified by ${entry.verifiedBy}, which the story does not cite.`);
    }
  }
  const context = checkNumbers([story.situation, story.task, story.reflection].join("\n"), evidence);
  for (const token of context.unverified) {
    warnings.push(`Figure ${token} in situation/task/reflection is not in the profile; confirm it with the candidate.`);
  }
  for (const skill of story.skills.filter((entry) => !knownSkill(profile, entry))) {
    warnings.push(`Skill "${skill}" is not in profile.skills.`);
  }
  const words = wordCount([story.situation, story.task, story.action, story.result].join(" "));
  if (words > SPOKEN_WORD_LIMIT) warnings.push(`About ${words} words: longer than a two-minute answer; tighten it.`);
  return warnings;
}

type SaveStoryResult = { story: Story; created: boolean; figures: NumberCheck["checked"]; warnings: string[] };

/**
 * Creates or updates a story after checking that its cited facts exist and
 * that every figure in its result and action appears in the profile.
 */
export function saveStory(workspace: Pick<CareerWorkspace, "db" | "profile">, input: StoryInput): SaveStoryResult {
  const parsed = parseInput(StoryInputSchema, input, "story");
  const { db, profile } = workspace;
  const factIds = unique(parsed.factIds);
  const unknownFacts = factIds.filter((id) => !profile.facts.some((fact) => fact.id === id));
  if (unknownFacts.length > 0) {
    throw new AppError("unknown_fact", `story cites fact ids that are not in profile.facts: ${unknownFacts.join(", ")}`, {
      unknownFacts,
    });
  }
  const evidence = orderedEvidence(profile, factIds);
  const check = checkNumbers(`${parsed.result}\n${parsed.action}`, evidence);
  if (check.unverified.length > 0) {
    throw new AppError(
      "unverified_figures",
      `result/action contain figures found in neither the cited facts nor anywhere else in the profile: ${check.unverified.join(", ")}. Use only figures from profile facts, or add the fact to profile.json first.`,
      { offending: check.unverified },
    );
  }
  const existing = parsed.id ? getStory(db, parsed.id) : null;
  if (parsed.id && !existing) throw new AppError("story_not_found", `no story ${parsed.id}; omit id to create a new story`);

  const now = nowIso();
  const story: Story = {
    id: existing?.id ?? newId("story"),
    title: parsed.title,
    situation: parsed.situation.trim(),
    task: parsed.task.trim(),
    action: parsed.action.trim(),
    result: parsed.result.trim(),
    reflection: parsed.reflection.trim(),
    skills: unique(parsed.skills),
    factIds,
    tags: unique(parsed.tags.map(lower)),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  saveStoryRecord(db, story);
  appendEvent(db, existing ? "story.updated" : "story.created", story.id, { facts: factIds.length });
  return { story, created: !existing, figures: check.checked, warnings: storyWarnings(story, profile, evidence, check) };
}

type StoryListFilter = { tag?: string; skill?: string; factId?: string; limit?: number };

export function listStories(workspace: Pick<CareerWorkspace, "db">, filter: StoryListFilter = {}): Story[] {
  const tag = filter.tag ? lower(filter.tag) : null;
  const skill = filter.skill ? lower(filter.skill) : null;
  return listStoryRecords(workspace.db, filter.limit)
    .filter((story) => (tag ? story.tags.includes(tag) : true))
    .filter((story) => (skill ? story.skills.some((entry) => lower(entry) === skill) : true))
    .filter((story) => (filter.factId ? story.factIds.includes(filter.factId) : true));
}

export function deleteStory(workspace: Pick<CareerWorkspace, "db">, id: string): { deleted: string } {
  if (!deleteStoryRecord(workspace.db, id)) throw new AppError("story_not_found", `no story ${id}`);
  appendEvent(workspace.db, "story.deleted", id);
  return { deleted: id };
}

/** Best stories for each requirement-like line of a stored job posting. */
export function matchStoriesToJob(
  workspace: Pick<CareerWorkspace, "db" | "profile">,
  jobId: string,
  perRequirement = 3,
): StoryJobMatch {
  const job = getJob(workspace.db, jobId);
  if (!job) throw new AppError("job_not_found", `no job stored with id ${jobId}`);
  return matchStories(job, listStoryRecords(workspace.db, 1000), workspace.profile, perRequirement);
}
