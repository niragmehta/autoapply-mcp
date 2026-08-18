import { describe, expect, it } from "vitest";
import { experienceSubjects, statesUnrelatedExperience } from "../src/drafting/experienceSubject.js";

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
