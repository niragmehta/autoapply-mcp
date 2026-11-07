import { describe, expect, it } from "vitest";
import { checkNumbers } from "../src/career/factCheck.js";
import { extractFigures, figureForms, profileFigureEvidence, withoutDatesAndTimes } from "../src/text/figures.js";
import { requirementLines } from "../src/text/jobDescription.js";
import { contentTerms, stem } from "../src/text/words.js";
import { CAREER_JD, careerProfile } from "./careerFixtures.js";

describe("extractFigures", () => {
  it("reads percentages, multipliers, grouped and scaled figures", () => {
    const tokens = extractFigures("Cut latency 40% across 1,200 services, saving $1.2M (3x faster) for 300+ users");
    expect(tokens.map((token) => token.raw)).toEqual(["40%", "1,200", "$1.2M", "3x", "300+"]);
    expect(tokens.map(figureForms)).toEqual([["40%"], ["1200"], ["1.2", "1200000"], ["3"], ["300"]]);
  });

  it("ignores identifiers that merely contain digits", () => {
    expect(extractFigures("Ran EC2, P99 dashboards, K8s, IPv6, 2FA and OAuth2 rollouts")).toEqual([]);
  });

  it("reads spelled-out scales", () => {
    const [saved] = extractFigures("saved $1.2 million");
    expect(saved && figureForms(saved)).toContain("1200000");
  });

  it("keeps percentages apart from plain counts, including ranges and the word percent", () => {
    expect(extractFigures("cut 40% of toil").map(figureForms)).toEqual([["40%"]]);
    expect(extractFigures("a 40 percent cut").map(figureForms)).toEqual([["40%"]]);
    expect(extractFigures("between 40-50% and 20 to 30 percent").map(figureForms)).toEqual([["40%"], ["50%"], ["20%"], ["30%"]]);
    expect(extractFigures("led 40 engineers").map(figureForms)).toEqual([["40"]]);
  });
});

describe("checkNumbers", () => {
  const evidence = profileFigureEvidence(careerProfile());

  it("names the evidence that verifies each figure", () => {
    const check = checkNumbers("Adopted by 12 product teams; 300+ repositories", evidence);
    expect(check.unverified).toEqual([]);
    expect(check.checked.map((entry) => entry.verifiedBy)).toEqual(["fact:guardrails", "fact:compliance"]);
  });

  it("lists figures found nowhere in the profile", () => {
    const check = checkNumbers("Grew revenue 75% and led 9 teams", evidence);
    expect(check.unverified).toEqual(["75%", "9"]);
  });

  it("does not let a percentage evidence a count with the same digits", () => {
    expect(checkNumbers("cut review time by 40 percent", evidence).unverified).toEqual([]);
    expect(checkNumbers("led 40 engineers", evidence).unverified).toEqual(["40"]);
  });

  it("matches the same value written at another scale", () => {
    expect(checkNumbers("saved $1,200,000", evidence).unverified).toEqual([]);
    expect(checkNumbers("saved 1.2 million dollars", evidence).unverified).toEqual([]);
  });

  it("keeps only the year of an ISO date, so a month is no evidence", () => {
    const check = checkNumbers("Joined in 2021 and doubled throughput 2x", evidence);
    expect(check.checked.find((entry) => entry.token === "2021")?.verifiedBy).toBe("experience:Acme Cloud");
    expect(check.unverified).toEqual(["2x"]);
  });

  it("excludes compensation and contact details from evidence", () => {
    expect(checkNumbers("delivered 300000 in savings", evidence).unverified).toEqual(["300000"]);
    expect(checkNumbers("call 555-0100", evidence).unverified.length).toBeGreaterThan(0);
  });
});

describe("withoutDatesAndTimes", () => {
  it("removes calendar dates and clock times", () => {
    const stripped = withoutDatesAndTimes("Thanks for Nov 12th, 2026 at 3:30 pm, see you 2026-11-19T17:00:00Z or 11/20 at 15:00.");
    expect(extractFigures(stripped)).toEqual([]);
  });

  it("keeps a bare year, which is a claim", () => {
    expect(extractFigures(withoutDatesAndTimes("since March 2019")).map((token) => token.raw)).toEqual(["2019"]);
  });
});

describe("terms", () => {
  it("stems common inflections and drops stop words", () => {
    expect(stem("guardrails")).toBe("guardrail");
    expect(stem("building")).toBe("build");
    expect(stem("processes")).toBe("process");
    expect(contentTerms("Experience with the guardrails and AI policies")).toEqual(["guardrail", "ai", "policy"]);
  });

  it("finds requirement lines and skips benefits and EEO text", () => {
    const lines = requirementLines(CAREER_JD).map((line) => line.text);
    expect(lines).toContain("Lead incident response for production security events");
    expect(lines).toContain("Hands-on experience with Rust and Haskell compilers");
    expect(lines.some((line) => /401\(k\)|equal opportunity/i.test(line))).toBe(false);
  });
});
