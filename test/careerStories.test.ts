import { beforeEach, describe, expect, it } from "vitest";
import { getStory } from "../src/db/repositories/career/stories.js";
import {
  deleteStory,
  factThemes,
  listStories,
  matchStoriesToJob,
  saveStory,
  storyBankScaffold,
  type StoryInput,
} from "../src/career/stories.js";
import { careerWorkspace, errorCode, errorMessage, seedApplication, type TestWorkspace } from "./careerFixtures.js";

const incidentStory: StoryInput = {
  title: "Containing a credential leak",
  situation: "A production credential leaked during a deploy at Acme Cloud.",
  task: "I owned the incident response as on-call lead.",
  action: "I rotated the credentials, led incident response across three teams and automated secret scanning.",
  result: "We cut time to remediate from 6 hours to 45 minutes.",
  reflection: "I would have rehearsed the runbook before we needed it.",
  skills: ["Python"],
  factIds: ["incident"],
  tags: ["failure", "Incident Response", "leadership"],
};

const guardrailStory: StoryInput = {
  title: "Guardrails for AI agents",
  situation: "Product teams were shipping AI agents with no policy enforcement.",
  task: "Design a guardrail framework every team could adopt.",
  action: "I designed and built guardrails that enforce policy with Open Policy Agent and drove adoption.",
  result: "12 product teams adopted the framework.",
  reflection: "Early adopters shaped the API more than any design review.",
  skills: ["Open Policy Agent"],
  factIds: ["guardrails"],
  tags: ["technical_depth", "influence"],
};

let workspace: TestWorkspace;

beforeEach(() => {
  workspace = careerWorkspace();
});

describe("saveStory", () => {
  it("round-trips a story through the repository", () => {
    const saved = saveStory(workspace, incidentStory);
    expect(saved.created).toBe(true);
    expect(saved.warnings).toEqual([]);
    const stored = getStory(workspace.db, saved.story.id);
    expect(stored).toEqual(saved.story);
    expect(stored?.tags).toEqual(["failure", "incident response", "leadership"]);
    expect(saved.figures.every((figure) => figure.verifiedBy === "fact:incident")).toBe(true);
  });

  it("updates in place, keeping the creation time", async () => {
    const first = saveStory(workspace, incidentStory).story;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = saveStory(workspace, { ...incidentStory, id: first.id, title: "Containing a leak, fast" });
    expect(second.created).toBe(false);
    expect(second.story.id).toBe(first.id);
    expect(second.story.createdAt).toBe(first.createdAt);
    expect(second.story.updatedAt > first.updatedAt).toBe(true);
    expect(listStories(workspace)).toHaveLength(1);
  });

  it("rejects a figure that appears nowhere in the profile and names it", () => {
    const fn = () => saveStory(workspace, { ...incidentStory, result: "We cut time to remediate by 90% within 2 weeks." });
    expect(errorCode(fn)).toBe("unverified_figures");
    expect(errorMessage(fn)).toContain("90%, 2");
    expect(listStories(workspace)).toHaveLength(0);
  });

  it("checks figures in the action as well as the result", () => {
    const fn = () => saveStory(workspace, { ...incidentStory, action: "I paged 17 engineers." });
    expect(errorCode(fn)).toBe("unverified_figures");
    expect(errorMessage(fn)).toContain("17");
  });

  it("accepts a figure found elsewhere in the profile, with a warning to cite it", () => {
    const saved = saveStory(workspace, { ...incidentStory, action: "I wired scanning into CI pipelines for 50 services." });
    expect(saved.figures.find((figure) => figure.token === "50")?.verifiedBy).toBe("experience:Globex");
    expect(saved.warnings.join(" ")).toContain("Figure 50 is verified by experience:Globex");
  });

  it("rejects unknown fact ids", () => {
    const fn = () => saveStory(workspace, { ...incidentStory, factIds: ["incident", "made-up"] });
    expect(errorCode(fn)).toBe("unknown_fact");
    expect(errorMessage(fn)).toContain("made-up");
  });

  it("warns about missing parts and unknown skills without rejecting", () => {
    const saved = saveStory(workspace, {
      title: "Bare story",
      action: "I automated compliance review.",
      skills: ["Haskell"],
    });
    const warnings = saved.warnings.join(" ");
    expect(warnings).toContain("No reflection");
    expect(warnings).toContain("No factIds");
    expect(warnings).toContain('Skill "Haskell"');
  });

  it("flags unverified figures in the situation without rejecting", () => {
    const saved = saveStory(workspace, { ...incidentStory, situation: "In 2019 a credential leaked." });
    expect(saved.warnings.join(" ")).toContain("Figure 2019");
  });

  it("refuses to update a story that does not exist", () => {
    expect(errorCode(() => saveStory(workspace, { ...incidentStory, id: "story_missing" }))).toBe("story_not_found");
  });

  it("rejects input without an action", () => {
    expect(errorCode(() => saveStory(workspace, { title: "No action", action: "  " }))).toBe("invalid_input");
  });
});

describe("listStories and deleteStory", () => {
  it("filters by tag and skill, and deletes", () => {
    const incident = saveStory(workspace, incidentStory).story;
    saveStory(workspace, guardrailStory);
    expect(listStories(workspace, { tag: "Failure" }).map((story) => story.id)).toEqual([incident.id]);
    expect(listStories(workspace, { skill: "open policy agent" })).toHaveLength(1);
    expect(listStories(workspace, { factId: "incident" })).toHaveLength(1);
    expect(deleteStory(workspace, incident.id)).toEqual({ deleted: incident.id });
    expect(listStories(workspace)).toHaveLength(1);
    expect(errorCode(() => deleteStory(workspace, incident.id))).toBe("story_not_found");
  });
});

describe("storyBankScaffold", () => {
  it("groups facts by shared tag and lists their figures", () => {
    const themes = factThemes(workspace.profile.facts);
    const policy = themes.find((theme) => theme.theme === "policy");
    expect(policy?.facts.map((fact) => fact.id)).toEqual(["guardrails", "compliance"]);
    expect(themes.find((theme) => theme.theme === "leadership")?.facts.map((fact) => fact.id)).toEqual(["incident", "mentoring"]);
    expect(themes.find((theme) => theme.theme === "experience")?.facts.map((fact) => fact.id)).toEqual(["cost"]);
    expect(policy?.facts[1]?.figures).toEqual(["300+", "40%"]);
  });

  it("reports competency coverage and uncited facts", () => {
    saveStory(workspace, incidentStory);
    const scaffold = storyBankScaffold(workspace);
    expect(scaffold.targetStoryCount).toEqual({ min: 5, max: 10 });
    expect(scaffold.uncitedFacts).toEqual(["guardrails", "compliance", "mentoring", "cost"]);
    const failure = scaffold.competencies.find((competency) => competency.id === "failure");
    expect(failure?.coveredBy).toHaveLength(1);
    const leadership = scaffold.competencies.find((competency) => competency.id === "leadership");
    expect(leadership?.candidateFacts).toContain("mentoring");
    expect(scaffold.existingStories[0]?.factIds).toEqual(["incident"]);
  });
});

describe("matchStoriesToJob", () => {
  it("maps requirement lines to the best stories and lists uncovered ones", () => {
    const { job } = seedApplication(workspace.db);
    const incident = saveStory(workspace, incidentStory).story;
    const guardrails = saveStory(workspace, guardrailStory).story;
    const match = matchStoriesToJob(workspace, job.id);

    const byLine = new Map(match.requirements.map((row) => [row.requirement, row.stories]));
    expect(byLine.get("Lead incident response for production security events")?.[0]?.storyId).toBe(incident.id);
    expect(byLine.get("Design and build guardrails that enforce policy for AI agents")?.[0]?.storyId).toBe(guardrails.id);
    expect(match.uncovered).toContain("Hands-on experience with Rust and Haskell compilers");
    expect(match.topStories.map((entry) => entry.storyId)).toEqual(expect.arrayContaining([incident.id, guardrails.id]));
    expect(match.note).toContain("untrusted");
  });

  it("fails clearly for an unknown job", () => {
    expect(errorCode(() => matchStoriesToJob(workspace, "job_missing"))).toBe("job_not_found");
  });
});
