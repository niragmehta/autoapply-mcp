import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { COLLECT_FIELDS } from "../src/submission/browser.js";
import type { FieldDescriptor } from "../src/submission/formFields.js";

// Snap's sponsorship question runs past 200 characters, and the definition that
// decides it - whether TN counts as sponsorship - comes after the question.
const SPONSORSHIP =
  "3.) Will you need Snap to sponsor you for a visa to work legally in the United States, now or in the future " +
  "(meaning you will need visa sponsorship by an employer in order to work in the United States, for example " +
  "H-1B, TN or O-1 status)?";

async function collectFrom(browser: Browser, html: string): Promise<FieldDescriptor[]> {
  const page = await browser.newPage();
  try {
    await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto("https://fixture.wd1.myworkdayjobs.com/Careers");
    return (await page.evaluate(COLLECT_FIELDS)) as FieldDescriptor[];
  } finally {
    await page.close();
  }
}

describe("Workday question labels in a local browser", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  it("keeps the whole of a long questionnaire question", async () => {
    // Cut at 200 characters the label ended mid-definition, so neither the
    // generic sponsorship answer nor the TN decision could safely claim it.
    expect(SPONSORSHIP.length).toBeGreaterThan(200);
    const fields = await collectFrom(
      browser,
      `<div data-automation-id="formField-sponsorship"><fieldset><legend><p>${SPONSORSHIP}<abbr>*</abbr></p></legend>
        <button type="button" aria-haspopup="listbox" id="q3" style="width:240px;height:32px">Select One</button>
      </fieldset></div>`,
    );

    const question = fields.find((field) => field.label.includes("sponsor"));

    expect(question?.label).toBe(SPONSORSHIP);
    expect(question?.required).toBe(true);
  });

  it("names a questionnaire text box from the question above it", async () => {
    // Pax8 asks for salary expectations in a free-text box whose only label is
    // the legend's rich text. Read through <label> alone the box arrived
    // nameless, so the approved salary answer could never claim it and the
    // Application Questions step would not advance.
    const question = "To help on alignment, can you confirm your desired salary expectations for this new role?";
    const fields = await collectFrom(
      browser,
      `<div data-automation-id="formField-242722f759241000c5a2b8dc8aca0001"><fieldset>
        <legend><div data-automation-id="richText"><p>${question}</p></div><abbr>*</abbr></legend>
        <textarea id="salary" aria-required="true" style="width:240px;height:64px"></textarea>
      </fieldset></div>`,
    );

    const box = fields.find((field) => field.type === "textarea");

    expect(box?.label).toBe(question);
    expect(box?.required).toBe(true);
  });

  it("keeps an explicit label on a Workday text input", async () => {
    const fields = await collectFrom(
      browser,
      `<div data-automation-id="formField-legalNameSection_firstName">
        <label for="first">First Name<abbr>*</abbr></label>
        <input id="first" name="legalName--firstName" type="text" aria-required="true" style="width:240px;height:32px">
      </div>`,
    );

    expect(fields[0]?.label).toBe("First Name*");
  });

  it("still bounds a label outside Workday and Lever", async () => {
    const long = `Tell us about yourself ${"and more ".repeat(60)}`.trim();
    const fields = await collectFrom(
      browser,
      `<label for="about">${long}</label><input id="about" type="text" style="width:240px;height:32px">`,
    );

    expect(fields[0]?.label.length).toBe(200);
  });
});
