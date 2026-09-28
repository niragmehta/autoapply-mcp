import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import type { DraftAnswer } from "../src/domain/job.js";
import { COLLECT_FIELDS, repairReportedFields } from "../src/submission/browser.js";
import { buildFillPlan, type FieldDescriptor } from "../src/submission/formFields.js";
import { resolvePersonal } from "../src/drafting/personal.js";
import { makeProfile } from "./factories.js";

const answer = (label: string, value: string, extra: Partial<DraftAnswer> = {}): DraftAnswer => ({
  questionKey: label, label, answer: value, source: "profile", citation: "verified history",
  requiresHuman: false, required: true, category: "employment-history", guidance: "", ...extra,
});
const field = (domId: string, label = "From", value = ""): FieldDescriptor => ({
  selectorIndex: 0, domId, label, type: "date", name: "", required: true, value,
});

describe("Workday history date matching", () => {
  it("resolves the scoped education end year from the qualification, not employment", () => {
    const profile = makeProfile({ education: [{
      institution: "Test University", credential: "BSc", field: "Computer Science",
      location: "Canada", start: "2016-09", end: "2020-12",
    }] });
    expect(resolvePersonal("Education end year", profile)?.answer).toBe("2020");
  });
  it("separates a job's month/year from an education year with the same visible label", () => {
    const fields = [field("workExperience-4--startDate"), field("education-5--firstYearAttended")];
    const plan = buildFillPlan(fields, [
      answer("Employment start date", "2021-02"), answer("Education start year", "2016"),
    ]);
    expect(plan.toFill.map(({ field, answer }) => [field.domId, answer?.answer])).toEqual([
      ["workExperience-4--startDate", "2021-02"], ["education-5--firstYearAttended", "2016"],
    ]);
  });

  it.each(["MM/YYYY", "MM / YYYY", "MM YYYY", "MM-YYYY", "YYYY"])("reports the placeholder %s as missing, not an answer", (value) => {
    expect(buildFillPlan([field("workExperience-4--startDate", "From", value)], []).unmatchedRequired).toHaveLength(1);
  });

  it("preserves an explicitly reviewed not-applicable end date without inventing a day", () => {
    const plan = buildFillPlan([field("workExperience-4--endDate", "To", "MM/YYYY")], [
      answer("Employment end date", "", { notApplicable: true, citation: "experience[0].end=present" }),
    ]);
    expect(plan.unmatchedRequired).toEqual([]);
    expect(plan.toFill).toEqual([]);
  });

  it.each([
    ["workExperience-4--startDate", "Employment start date", "2021-13"],
    ["workExperience-4--startDate", "Employment start date", "2021-02-01"],
    ["education-5--firstYearAttended", "Education start year", "2021-02"],
    ["dateSignedOn", "Date signed on", "2021-02"],
    ["dateSignedOn", "Date signed on", "02/30/2021"],
    ["education-5--firstYearAttended", "Education start year", "0000"],
  ])("rejects incompatible or invalid precision for %s: %s = %s", (domId, label, value) => {
    expect(buildFillPlan([field(domId, label)], [answer(label, value)]).toFill).toEqual([]);
  });
});

describe("Workday history dates in a local browser", () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
  afterAll(async () => { await browser?.close(); });

  it.each([
    ["workExperience-4--startDate", "Employment start date", "2021-02", ["Month", "Year"], ["02", "2021"]],
    ["workExperience-8--startDate", "Employment start date", "02/2021", ["Month", "Year"], ["02", "2021"]],
    ["education-5--firstYearAttended", "Education start year", "2016", ["Year"], ["2016"]],
    ["education-5--lastYearAttended", "Education end year", "2020", ["Year"], ["2020"]],
    ["dateSignedOn", "Date signed on", "2026-09-19", ["Month", "Day", "Year"], ["09", "19", "2026"]],
  ])("fills only rendered sections for %s", async (id, label, value, sections, expected) => {
    const page = await browser.newPage();
    try {
      const html = `<div data-automation-id="formField-date"><label>${label}<abbr>*</abbr></label>
        <div id="${id}" data-automation-id="dateInputWrapper" role="group" style="width:240px;height:32px">
        ${sections.map((section) => `<div data-automation-id="dateSection${section}-display">${section}</div>
          <input id="${id}-dateSection${section}-input" data-automation-id="dateSection${section}-input"
          role="spinbutton" style="position:absolute;opacity:0;width:1px;height:1px">`).join("")}</div></div>`;
      await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: html }));
      await page.goto("https://fixture.wd5.myworkdayjobs.com/Careers");
      const fields: FieldDescriptor[] = await page.evaluate(COLLECT_FIELDS);
      const plan = buildFillPlan(fields, [answer(label, value)]);
      expect(plan.toFill).toHaveLength(1);

      const repaired = await repairReportedFields(page, plan.toFill, [label]);

      expect(repaired).toEqual([label]);
      const values = await page.locator('input[role="spinbutton"]').evaluateAll((inputs) =>
        inputs.map((input) => (input as HTMLInputElement).value));
      expect(values).toEqual(expected);
    } finally {
      await page.close();
    }
  });
});
