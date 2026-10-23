import { describe, expect, it } from "vitest";
import { countsYearsAsLookback, experienceSubjects, statesUnrelatedExperience } from "../src/drafting/experienceSubject.js";

const generalEntry = ["Years of professional experience", "how many years", "years of experience do you have"];

describe("experienceSubjects", () => {
  it("reads the general question as naming nothing", () => {
    expect(experienceSubjects("How many years of experience do you have?")).toEqual([]);
    expect(experienceSubjects("Years of professional experience")).toEqual([]);
    expect(experienceSubjects("How many years of hands-on software engineering experience do you have?")).toEqual([]);
  });

  it("reads the subject a question names", () => {
    // Teleport asks both of these, and the general entry matched both.
    expect(experienceSubjects("How many years of the Go (Golang ) experience do you have?")).toContain("go");
    expect(
      experienceSubjects("How many years of progressive, hands-on Data Engineering experience do you have?"),
    ).toContain("data");
    expect(experienceSubjects("How many years of experience with Kubernetes do you have?")).toContain("kubernetes");
  });
});

describe("statesUnrelatedExperience", () => {
  it("keeps a general answer away from a question about one technology", () => {
    expect(statesUnrelatedExperience("How many years of the Go (Golang ) experience do you have?", generalEntry)).toBe(
      true,
    );
    expect(
      statesUnrelatedExperience(
        "How many years of progressive, hands-on Data Engineering experience do you have?",
        generalEntry,
      ),
    ).toBe(true);
  });

  it("still answers the general question", () => {
    expect(statesUnrelatedExperience("How many years of experience do you have?", generalEntry)).toBe(false);
    expect(
      statesUnrelatedExperience("How many years of relevant professional experience do you have?", generalEntry),
    ).toBe(false);
  });

  it("lets an entry written for the subject answer it", () => {
    const goEntry = ["Years of Go experience", "years of the go", "golang experience"];
    expect(statesUnrelatedExperience("How many years of the Go (Golang ) experience do you have?", goEntry)).toBe(
      false,
    );
  });

  it("ignores questions that are not counting years", () => {
    expect(statesUnrelatedExperience("Do you have experience with Kubernetes?", generalEntry)).toBe(false);
  });
});

describe("countsYearsAsLookback", () => {
  const thresholdEntry = ["Do you have N+ years of experience", "6+ years", "7+ years", "minimum of 7 years"];
  // Amazon's export-control question. "7+ years" normalizes to "7 years", which
  // "in the past 7 years" contains, so the experience threshold answered "No"
  // to a question about where the candidate has lived.
  const lived =
    "In the past 7 years, have you lived or were physically located outside of the US for 12 consecutive months or more? Please only include locations where you would have been located for a minimum of 12 consecutive months.";

  it("keeps a years-of-experience answer away from a lookback window", () => {
    expect(countsYearsAsLookback(lived, thresholdEntry)).toBe(true);
    expect(countsYearsAsLookback("Have you worked for a government entity within the last 5 years?", thresholdEntry)).toBe(
      true,
    );
  });

  it("still answers an experience threshold", () => {
    expect(countsYearsAsLookback("Do you have 7+ years of experience in software engineering?", thresholdEntry)).toBe(false);
    expect(countsYearsAsLookback("Do you have at least 7 years of backend development?", thresholdEntry)).toBe(false);
  });

  it("still answers experience gained within a window", () => {
    expect(
      countsYearsAsLookback("Do you have 3+ years of experience gained in the past 7 years?", thresholdEntry),
    ).toBe(false);
  });

  it("does not hold back an entry that is not about experience", () => {
    expect(countsYearsAsLookback(lived, ["Lived outside the US", "outside of the us for 12 consecutive months"])).toBe(
      false,
    );
  });
});
