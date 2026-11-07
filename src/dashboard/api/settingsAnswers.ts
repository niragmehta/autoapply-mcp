import { z } from "zod";
import { ApprovedAnswerSchema } from "../../domain/profile.js";
import { AppError } from "../../util/errors.js";
import { JsonReply, HttpError, parseBody, parseParams, parseQuery, type Router } from "../router.js";
import { aiPolicyProblems, isAiPolicyQuestion, LOCK_DESCRIPTIONS, LOCK_GROUPS, lockGroupsOf, lockOf, type LockGroup } from "../settings/answerPolicy.js";
import { readAnswerEntries, storedAnswer, versionOf, writeProfileAnswers, type AnswerEntry, type ApprovedAnswer } from "../settings/configFiles.js";
import { queryBool, queryText } from "./shared.js";

/**
 * The answers library (profile.answers): list, search, add, edit and delete.
 * Every write is validated against the profile schema, written atomically with
 * a dated backup and reloaded. Locked answers change only with `unlock`, and
 * the AI-policy question can only ever be set to ask you.
 */

const blank = (value: unknown) => (value === "" ? undefined : value);
const FILTERS = [...LOCK_GROUPS, "locked", "ai-policy"] as const;

const AnswersQuery = z.object({ q: queryText(120), group: z.preprocess(blank, z.enum(FILTERS).optional()) });
const AnswerInput = ApprovedAnswerSchema.strict();
const Version = z.string().regex(/^[0-9a-f]{16}$/, "the version an answer was read at");
const CreateBody = z.object({ answer: AnswerInput, unlock: z.boolean().optional() }).strict();
const UpdateBody = z.object({ version: Version, answer: AnswerInput, unlock: z.boolean().optional() }).strict();
const DeleteQuery = z.object({ version: Version, unlock: queryBool });
const KeyParams = z.object({ key: z.string().trim().min(1).max(200) });

type Mode = "ask" | "suggest" | "auto" | "skip";

function modeOf(answer: ApprovedAnswer): Mode {
  if (answer.skip) return "skip";
  if (!answer.answer.trim()) return "ask";
  return answer.allowAutoFill ? "auto" : "suggest";
}

function present(answer: ApprovedAnswer, version: string) {
  return { ...answer, version, mode: modeOf(answer), lock: lockOf(answer), aiPolicy: isAiPolicyQuestion(answer) };
}

function matches(answer: ApprovedAnswer, needle: string): boolean {
  return [answer.key, answer.label, answer.answer, answer.note ?? "", ...answer.patterns, ...answer.alternatives].some((text) => text.toLowerCase().includes(needle));
}

function inFilter(answer: ApprovedAnswer, filter: (typeof FILTERS)[number] | undefined): boolean {
  if (!filter) return true;
  if (filter === "ai-policy") return isAiPolicyQuestion(answer);
  const groups = lockGroupsOf(answer);
  return filter === "locked" ? groups.length > 0 : groups.includes(filter);
}

/** Refuses an automatic answer to the AI-policy question, and a locked answer changed without the unlock. */
function guard(next: ApprovedAnswer, previous: ApprovedAnswer | null, unlock: boolean): void {
  if (isAiPolicyQuestion(next) || (previous && isAiPolicyQuestion(previous))) {
    const problems = aiPolicyProblems(next);
    if (problems.length) {
      throw new AppError(
        "ai_policy_ask_me",
        `The AI-policy question always stays "ask me", but ${problems.join(", ")}. Employers' AI policies differ, so you answer it yourself on each application.`,
      );
    }
  }
  const groups = LOCK_GROUPS.filter((group) => lockGroupsOf(next).includes(group) || (previous ? lockGroupsOf(previous).includes(group) : false));
  if (groups.length && !unlock) throw lockedError(groups);
}

function lockedError(groups: LockGroup[]): HttpError {
  const labels = groups.map((group) => LOCK_DESCRIPTIONS[group].label);
  const consequence = groups.map((group) => LOCK_DESCRIPTIONS[group].consequence).join(" ");
  return new HttpError(409, "answer_locked", `${labels.join(" and ")} answers are locked. Unlock it to change it: ${consequence}`, { lock: { groups, labels, consequence } });
}

function find(entries: AnswerEntry[], key: string): AnswerEntry {
  const entry = entries.find((candidate) => candidate.answer.key === key);
  if (!entry) throw new AppError("answer_not_found", `no answer with key "${key}" in profile.json`);
  return entry;
}

function checkVersion(entry: AnswerEntry, version: string): void {
  if (entry.version !== version) {
    throw new AppError("answer_changed", `"${entry.answer.key}" changed in profile.json since you opened it (by hand or in another tab). Reload it and make your change again.`);
  }
}

function requireFreeKey(entries: AnswerEntry[], key: string): void {
  if (entries.some((entry) => entry.answer.key === key)) {
    throw new AppError("answer_exists", `an answer with key "${key}" already exists; edit that one or choose another key`);
  }
}

export function registerRoutes(router: Router): void {
  router.get("/api/settings/answers", (request) => {
    const query = parseQuery(AnswersQuery, request);
    const entries = readAnswerEntries(request.ctx.workspace().paths.profile);
    const needle = query.q?.toLowerCase();
    const rows = entries.filter((entry) => (!needle || matches(entry.answer, needle)) && inFilter(entry.answer, query.group));
    const groups = LOCK_GROUPS.map((group) => ({
      id: group,
      label: LOCK_DESCRIPTIONS[group].label,
      count: entries.filter((entry) => lockGroupsOf(entry.answer).includes(group)).length,
    }));
    return {
      total: entries.length,
      count: rows.length,
      answers: rows.map((entry) => present(entry.answer, entry.version)),
      groups,
      aiPolicyCount: entries.filter((entry) => isAiPolicyQuestion(entry.answer)).length,
    };
  });

  router.get("/api/settings/answers/:key", (request) => {
    const { key } = parseParams(KeyParams, request);
    const entry = find(readAnswerEntries(request.ctx.workspace().paths.profile), key);
    return { answer: present(entry.answer, entry.version) };
  });

  router.post("/api/settings/answers", (request) => {
    const body = parseBody(CreateBody, request);
    let stored: Record<string, unknown> = {};
    const saved = writeProfileAnswers(request.ctx.workspace().paths.profile, (entries, raw) => {
      requireFreeKey(entries, body.answer.key);
      guard(body.answer, null, body.unlock === true);
      stored = storedAnswer(body.answer);
      return [...raw, stored];
    });
    return new JsonReply(201, { answer: present(ApprovedAnswerSchema.parse(stored), versionOf(stored)), saved });
  });

  router.patch("/api/settings/answers/:key", (request) => {
    const { key } = parseParams(KeyParams, request);
    const body = parseBody(UpdateBody, request);
    let stored: Record<string, unknown> = {};
    const saved = writeProfileAnswers(request.ctx.workspace().paths.profile, (entries, raw) => {
      const entry = find(entries, key);
      checkVersion(entry, body.version);
      if (body.answer.key !== key) requireFreeKey(entries, body.answer.key);
      guard(body.answer, entry.answer, body.unlock === true);
      stored = storedAnswer(body.answer);
      return raw.map((item) => (item === entry.raw ? stored : item));
    });
    return { answer: present(ApprovedAnswerSchema.parse(stored), versionOf(stored)), saved };
  });

  router.delete("/api/settings/answers/:key", (request) => {
    const { key } = parseParams(KeyParams, request);
    const query = parseQuery(DeleteQuery, request);
    const saved = writeProfileAnswers(request.ctx.workspace().paths.profile, (entries, raw) => {
      const entry = find(entries, key);
      checkVersion(entry, query.version);
      if (isAiPolicyQuestion(entry.answer) && entries.filter((candidate) => isAiPolicyQuestion(candidate.answer)).length === 1) {
        throw new AppError("ai_policy_required", "The AI-policy question stays in your library, set to ask you, so every form that asks it stops for you.");
      }
      const groups = lockGroupsOf(entry.answer);
      if (groups.length && query.unlock !== true) throw lockedError(groups);
      return raw.filter((item) => item !== entry.raw);
    });
    return { deleted: key, saved };
  });
}
