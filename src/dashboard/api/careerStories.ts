import { z } from "zod";
import { deleteStory, listStories, matchStoriesToJob, saveStory, storyBankScaffold, StoryInputSchema } from "../../career/stories.js";
import type { Story } from "../../career/types.js";
import { getStory } from "../../db/repositories/career/stories.js";
import { AppError } from "../../util/errors.js";
import { JsonReply, parseBody, parseParams, parseQuery, type Router } from "../router.js";
import { IdParams, queryInt, queryText } from "./shared.js";

/**
 * The story bank: STAR + Reflection stories built from verified facts.
 * Saving goes through saveStory, which refuses any figure the profile does
 * not hold and reports softer problems field by field.
 */

const StoriesQuery = z.object({
  q: queryText(120),
  tag: queryText(100),
  skill: queryText(100),
  competency: queryText(60),
  factId: queryText(120),
  limit: queryInt(1, 1000, 500),
});

const StoryBody = StoryInputSchema.omit({ id: true }).strict();

const MatchQuery = z.object({ perRequirement: queryInt(1, 5, 3) });

function searchText(story: Story): string {
  return [story.title, story.situation, story.task, story.action, story.result, story.reflection, ...story.tags, ...story.skills]
    .join("\n")
    .toLowerCase();
}

function tagCounts(stories: readonly Story[]) {
  const counts = new Map<string, number>();
  for (const tag of stories.flatMap((story) => story.tags)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

export function registerRoutes(router: Router): void {
  router.get("/api/stories", (request) => {
    const query = parseQuery(StoriesQuery, request);
    const workspace = request.ctx.workspace();
    const all = listStories(workspace, { limit: 1000 });
    const covered = query.competency
      ? new Set(storyBankScaffold(workspace).competencies.find((entry) => entry.id === query.competency)?.coveredBy ?? [])
      : null;
    const needle = query.q?.toLowerCase();
    const stories = listStories(workspace, { tag: query.tag, skill: query.skill, factId: query.factId, limit: query.limit })
      .filter((story) => (covered ? covered.has(story.id) : true))
      .filter((story) => (needle ? searchText(story).includes(needle) : true));
    return { count: stories.length, total: all.length, stories, tags: tagCounts(all) };
  });

  router.get("/api/stories/scaffold", ({ ctx }) => storyBankScaffold(ctx.workspace()));

  router.get("/api/stories/:id", (request) => {
    const { id } = parseParams(IdParams, request);
    const story = getStory(request.ctx.workspace().db, id);
    if (!story) throw new AppError("story_not_found", `no story ${id}`);
    return { story };
  });

  router.post("/api/stories", (request) => {
    const body = parseBody(StoryBody, request);
    return new JsonReply(201, saveStory(request.ctx.workspace(), body));
  });

  /** The whole story, as saveStory takes it; it is saved again under the same id. */
  router.patch("/api/stories/:id", (request) => {
    const { id } = parseParams(IdParams, request);
    const body = parseBody(StoryBody, request);
    return saveStory(request.ctx.workspace(), { ...body, id });
  });

  router.delete("/api/stories/:id", (request) => {
    const { id } = parseParams(IdParams, request);
    return deleteStory(request.ctx.workspace(), id);
  });

  router.get("/api/jobs/:id/story-match", (request) => {
    const { id } = parseParams(IdParams, request);
    const query = parseQuery(MatchQuery, request);
    return matchStoriesToJob(request.ctx.workspace(), id, query.perRequirement);
  });
}
