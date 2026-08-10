import { describe, expect, it } from "vitest";
import { extractLeads } from "../src/sources/hackernews.js";

/**
 * Hacker News stores comment bodies as HTML with slashes inside hrefs escaped.
 * A URL pattern run over the raw text silently finds nothing, which looks
 * exactly like a thread with no board links, so the encoded form is what these
 * fixtures use.
 */
function comment(text: string) {
  return { text, author: "poster" };
}

const ENCODED_GREENHOUSE =
  'Baton | San Francisco, CA (Hybrid) | Full-Time<p>Apply: <a href="https:&#x2F;&#x2F;boards.greenhouse.io&#x2F;baton" rel="nofollow">https:&#x2F;&#x2F;boards.greenhouse.io&#x2F;baton</a>';

describe("hacker news lead extraction", () => {
  it("reads a board link through HN's escaped slashes", () => {
    const leads = extractLeads({ children: [comment(ENCODED_GREENHOUSE)] });
    expect(leads).toHaveLength(1);
    expect(leads[0].ats).toBe("greenhouse");
    expect(leads[0].board).toBe("baton");
  });

  it("takes the company name from the post's leading field", () => {
    const leads = extractLeads({ children: [comment(ENCODED_GREENHOUSE)] });
    expect(leads[0].companyName).toBe("Baton");
  });

  it("falls back to the board slug when the post opens with prose", () => {
    const leads = extractLeads({
      children: [
        comment(
          'I am a recruiter for Turquoise and we are hiring a Senior Engineer | Remote<p><a href="https:&#x2F;&#x2F;jobs.ashbyhq.com&#x2F;turquoise-health">apply</a>',
        ),
      ],
    });
    expect(leads[0].companyName).toBe("Turquoise Health");
  });

  it("falls back to the board slug when the post opens with a location", () => {
    const leads = extractLeads({
      children: [comment('NYC | ONSITE<p><a href="https:&#x2F;&#x2F;jobs.ashbyhq.com&#x2F;norm-ai">apply</a>')],
    });
    expect(leads[0].companyName).toBe("Norm Ai");
  });

  it("recognises each supported ATS", () => {
    const leads = extractLeads({
      children: [
        comment('Acme | <a href="https:&#x2F;&#x2F;jobs.lever.co&#x2F;acme">lever</a>'),
        comment('Globex | <a href="https:&#x2F;&#x2F;jobs.ashbyhq.com&#x2F;globex">ashby</a>'),
        comment('Initech | <a href="https:&#x2F;&#x2F;boards.greenhouse.io&#x2F;embed&#x2F;job_board?for=initech">gh</a>'),
      ],
    });
    expect(leads.map((lead) => `${lead.ats}:${lead.board}`).sort()).toEqual([
      "ashby:globex",
      "greenhouse:initech",
      "lever:acme",
    ]);
  });

  it("returns one lead per board however often it is linked", () => {
    const repeated = `Acme | Roles
      <a href="https:&#x2F;&#x2F;jobs.lever.co&#x2F;acme&#x2F;role-one">one</a>
      <a href="https:&#x2F;&#x2F;jobs.lever.co&#x2F;acme&#x2F;role-two">two</a>`;
    expect(extractLeads({ children: [comment(repeated)] })).toHaveLength(1);
  });

  it("finds boards advertised in replies, not just top-level posts", () => {
    const leads = extractLeads({
      children: [
        {
          text: "Some meta discussion with no link",
          children: [comment('Acme | <a href="https:&#x2F;&#x2F;jobs.lever.co&#x2F;acme">apply</a>')],
        },
      ],
    });
    expect(leads.map((lead) => lead.board)).toEqual(["acme"]);
  });

  it("ignores URL path segments that are not board names", () => {
    // Without this guard "embed" reads as the board for every Greenhouse embed
    // link, which would flood the config with a board that does not exist.
    const leads = extractLeads({
      children: [comment('X | <a href="https:&#x2F;&#x2F;boards.greenhouse.io&#x2F;embed&#x2F;job_board?for=realco">x</a>')],
    });
    expect(leads.map((lead) => lead.board)).toEqual(["realco"]);
  });

  it("ignores a post with no board link at all", () => {
    expect(extractLeads({ children: [comment("We are hiring, email us at jobs@example.com")] })).toEqual([]);
  });

  it("survives a thread with no comments", () => {
    expect(extractLeads({})).toEqual([]);
  });

  it("strips a trailing period from a slug written in prose", () => {
    const leads = extractLeads({
      children: [comment("Acme | apply at https:&#x2F;&#x2F;jobs.lever.co&#x2F;acme.")],
    });
    expect(leads[0].board).toBe("acme");
  });
});
