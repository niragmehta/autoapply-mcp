import { describe, expect, it } from "vitest";
import {
  extractDates,
  extractFigures,
  figureForms,
  isoMonthKey,
  profileFigureEvidence,
  sameValue,
  withoutDatesAndTimes,
  withoutTimestamps,
  yearsOnly,
} from "../src/text/figures.js";
import { makeProfile } from "./factories.js";

const plain = (text: string) => extractFigures(text).map(({ raw, value, kind }) => ({ raw, value, kind }));

describe("extractFigures", () => {
  it("reads counts, percentages, money, N+ and magnitudes as values", () => {
    expect(plain("from 2k to 40k, 60% faster, $1.5M saved, 10,000+ hosts, 50 million rows, 20 ms, 3x")).toEqual([
      { raw: "2k", value: 2000, kind: "plain" },
      { raw: "40k", value: 40000, kind: "plain" },
      { raw: "60%", value: 60, kind: "percent" },
      { raw: "$1.5M", value: 1500000, kind: "money" },
      { raw: "10,000+", value: 10000, kind: "plain" },
      { raw: "50 million", value: 50000000, kind: "plain" },
      // A unit counts as part of the figure only when written against it.
      { raw: "20", value: 20, kind: "plain" },
      { raw: "3x", value: 3, kind: "plain" },
    ]);
  });

  it("keeps the currency, the mantissa and the position of each figure", () => {
    expect(extractFigures("saving $1.2M (3x faster)")).toEqual([
      { raw: "$1.2M", index: 7, value: 1200000, mantissa: 1.2, scaled: true, kind: "money" },
      { raw: "3x", index: 14, value: 3, mantissa: 3, scaled: false, kind: "plain" },
    ]);
    expect(plain("USD 400 and \u20ac5 and 2.5bn and 7mm")).toEqual([
      { raw: "USD 400", value: 400, kind: "money" },
      { raw: "\u20ac5", value: 5, kind: "money" },
      { raw: "2.5bn", value: 2500000000, kind: "plain" },
      { raw: "7mm", value: 7000000, kind: "plain" },
    ]);
  });

  it("ignores digits inside names and identifiers", () => {
    expect(extractFigures("Ran EC2, P99 dashboards, K8s, IPv6, 2FA and OAuth2 rollouts with S3 and 1Password")).toEqual([]);
  });

  it("reads percent words, ranges of percentages and ordinals", () => {
    expect(extractFigures("a 40 percent cut, 12 per cent, 9 pct").map((figure) => figure.kind)).toEqual(["percent", "percent", "percent"]);
    expect(extractFigures("between 40-50% and 20 to 30 percent").map(figureForms)).toEqual([["40%"], ["50%"], ["20%"], ["30%"]]);
    expect(extractFigures("ranked 1st of 40").map((figure) => [figure.raw, figure.value])).toEqual([
      ["1st", 1],
      ["40", 40],
    ]);
  });
});

describe("figureForms and sameValue", () => {
  it("compares a percentage only as a percentage and a scaled figure by both spellings", () => {
    const [percent, scaled, count] = extractFigures("40%, 1.2M and 1,200");
    expect(percent && figureForms(percent)).toEqual(["40%"]);
    expect(scaled && figureForms(scaled)).toEqual(["1.2", "1200000"]);
    expect(count && figureForms(count)).toEqual(["1200"]);
    expect(extractFigures("0.30000000000000004").map(figureForms)).toEqual([["0.3"]]);
  });

  it("treats floating-point noise as equal", () => {
    expect(sameValue(0.1 + 0.2, 0.3)).toBe(true);
    expect(sameValue(400000, 40000)).toBe(false);
  });
});

describe("dates", () => {
  it("keeps only the year of an ISO date", () => {
    expect(yearsOnly("from 2021-02 to 2023-11-05")).toBe("from 2021 to 2023");
  });

  it("removes calendar dates and clock times", () => {
    const stripped = withoutDatesAndTimes("Thanks for Nov 12th, 2026 at 3:30 pm, see you 2026-11-19T17:00:00Z or 11/20 at 15:00, or 4 May.");
    expect(extractFigures(stripped)).toEqual([]);
    expect(extractFigures(withoutDatesAndTimes("since March 2019")).map((figure) => figure.raw)).toEqual(["2019"]);
  });

  it("removes only machine timestamps, leaving ratings and prose dates", () => {
    const stripped = withoutTimestamps('{"generatedAt":"2026-11-07T03:17:22.000Z","postedAt":"2026-10-28","at":"09:45"} rated 4.2/5 on Nov 12');
    expect(extractFigures(stripped).map((figure) => figure.raw)).toEqual(["4.2", "5", "12"]);
  });

  it("keys month-year and season-year dates", () => {
    expect(extractDates("since March 2021, in Summer 2019, Autumn 2018 and Sept. 5, 2020").map((date) => date.key)).toEqual([
      "mar 2021",
      "summer 2019",
      "fall 2018",
      "sep 2020",
    ]);
    expect(isoMonthKey("2021-02")).toBe("feb 2021");
    expect(isoMonthKey("2021-13")).toBeNull();
    expect(isoMonthKey("present")).toBeNull();
  });
});

describe("profileFigureEvidence", () => {
  it("labels facts, roles, education, skills and the headline, and leaves out pay and contact details", () => {
    const evidence = profileFigureEvidence(
      makeProfile({ education: [{ institution: "Example University", credential: "BSc", field: "Computer Science", start: "2014-09", end: "2018-05" }] }),
    );
    expect(evidence.map((entry) => entry.source)).toEqual([
      "fact:guardrails",
      "fact:compliance",
      "experience:Acme",
      "education:Example University",
      "skills",
      "headline",
    ]);
    const text = evidence.map((entry) => entry.text).join("\n");
    expect(text).toContain("300+ repositories");
    expect(text).toContain("2021");
    expect(text).not.toContain("2021-02");
    expect(text).not.toContain("300000");
    expect(text).not.toContain("555-0100");
  });
});
