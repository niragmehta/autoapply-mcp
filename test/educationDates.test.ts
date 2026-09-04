import { describe, expect, it } from "vitest";

import { resolvePersonal } from "../src/drafting/personal.js";
import { educationDateLabels } from "../src/submission/formFields.js";

const field = (selectorIndex: number, domId: string) => ({
  selectorIndex,
  name: domId,
  label: domId.startsWith("end-year") ? "End date year" : "Start date month",
  type: "text" as const,
  required: false,
  domId,
});

describe("educationDateLabels", () => {
  it("labels every date control of a school block, not just the graduation year", () => {
    // LaunchDarkly's education block: only end-year was mapped, so the start
    // pair fell through to generic matching and was answered February 2020.
    const fields = [
      { ...field(0, "school--0"), label: "School" },
      field(1, "start-month--0"),
      field(2, "start-year--0"),
      field(3, "end-month--0"),
      field(4, "end-year--0"),
    ];
    expect(Object.fromEntries(educationDateLabels(fields))).toEqual({
      1: "Education start month",
      2: "Education start year",
      3: "Education end month",
      4: "Graduation year",
    });
  });

  it("leaves an employment block's dates alone", () => {
    const fields = [
      { ...field(0, "school--0"), label: "School" },
      { ...field(1, "company--0"), label: "Company" },
      field(2, "start-month--0"),
      field(3, "end-year--0"),
    ];
    expect(educationDateLabels(fields).size).toBe(0);
  });
});

const profile = {
  personal: {},
  education: [
    {
      institution: "Simon Fraser University",
      credential: "Bachelor of Science (BSc)",
      field: "Computer Science",
      start: "2016-09",
      end: "2020-12",
    },
  ],
} as never;

describe("education date resolution", () => {
  it("reads the start month and year the degree actually began", () => {
    expect(resolvePersonal("Education start month", profile)?.answer).toBe("September");
    expect(resolvePersonal("Education start year", profile)?.answer).toBe("2016");
  });

  it("reads the month the degree ended", () => {
    expect(resolvePersonal("Education end month", profile)?.answer).toBe("December");
  });

  it("still answers the graduation year with the year alone", () => {
    expect(resolvePersonal("Graduation year", profile)?.answer).toBe("2020");
  });
});
