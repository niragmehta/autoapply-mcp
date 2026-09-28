import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { readListboxOptions } from "../src/submission/workdayFlow.js";

/**
 * Reading an unmatched field's choices is a diagnostic: it must leave the form
 * exactly as it found it. Adobe's wizard showed why. Opening each unmatched
 * required control to list its options clicked the first checkbox of "Have you
 * ever worked at Adobe in the following capacity:", recording "Employee" for a
 * candidate who never worked there, and ticked the Terms box nobody had
 * approved. Workday then let both steps advance on answers no one gave.
 */
const ADOBE_FORM = `
<div data-automation-id="formField-305a1163be7301dceb027192b201c28a">
  <label>Have you ever worked at Adobe in the following capacity:<abbr>*</abbr></label>
  <div role="grid">
    <div role="row"><div role="cell">
      <input type="checkbox" id="employee" data-autoapply-idx="7" style="width:20px;height:20px">
      <label for="employee">Employee</label>
    </div></div>
    <div role="row"><div role="cell">
      <input type="checkbox" id="intern" style="width:20px;height:20px">
      <label for="intern">Intern</label>
    </div></div>
  </div>
</div>
<div data-automation-id="formField-acceptTermsAndAgreements">
  <input type="checkbox" id="terms" data-autoapply-idx="9" style="width:20px;height:20px">
  <label for="terms">Check this box to confirm the statement above.<abbr>*</abbr></label>
</div>
<div data-automation-id="formField-consent">
  <label>I agree</label>
  <div role="checkbox" id="ariaBox" aria-checked="false" data-autoapply-idx="11" tabindex="0"
    style="width:20px;height:20px" onclick="this.setAttribute('aria-checked','true')"></div>
</div>
<div data-automation-id="formField-contract">
  <label>Are you currently under contract?</label>
  <div role="radiogroup" data-autoapply-idx="13" style="width:200px;height:40px">
    <label><input type="radio" name="contract" id="yes">Yes</label>
    <label><input type="radio" name="contract" id="no">No</label>
  </div>
</div>
<div data-automation-id="formField-sponsorship">
  <label>Will you require sponsorship?</label>
  <button type="button" aria-haspopup="listbox" data-autoapply-idx="3" style="width:240px;height:32px"
    onclick="document.body.insertAdjacentHTML('beforeend', '<ul role=listbox><li role=option>Yes</li><li role=option>No</li></ul>')">Select One</button>
</div>
<div data-automation-id="formField-phoneCode">
  <label>Country Phone Code<abbr>*</abbr></label>
  <input type="text" data-autoapply-idx="5" style="width:240px;height:32px"
    onclick="document.body.insertAdjacentHTML('beforeend', '<ul role=listbox><li role=option>Canada (+1)</li><li role=option>India (+91)</li></ul>')">
</div>`;

async function openForm(browser: Browser): Promise<Page> {
  const page = await browser.newPage();
  await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: ADOBE_FORM }));
  await page.goto("https://fixture.wd5.myworkdayjobs.com/external_experienced");
  return page;
}

describe("readListboxOptions leaves the form as it found it", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  it("names a checkbox grid's choices without ticking any of them", async () => {
    const page = await openForm(browser);
    try {
      const options = await readListboxOptions(page, 7, "Have you ever worked at Adobe in the following capacity:");

      expect(options).toEqual(["Employee", "Intern"]);
      expect(await page.isChecked("#employee")).toBe(false);
      expect(await page.isChecked("#intern")).toBe(false);
    } finally {
      await page.close();
    }
  });

  it("never ticks a lone terms checkbox", async () => {
    const page = await openForm(browser);
    try {
      const options = await readListboxOptions(page, 9, "Check this box to confirm the statement above.");

      expect(options).toEqual([]);
      expect(await page.isChecked("#terms")).toBe(false);
    } finally {
      await page.close();
    }
  });

  it("never toggles an ARIA checkbox", async () => {
    const page = await openForm(browser);
    try {
      await readListboxOptions(page, 11, "I agree");

      expect(await page.getAttribute("#ariaBox", "aria-checked")).toBe("false");
    } finally {
      await page.close();
    }
  });

  it("names a radio group's choices without selecting one", async () => {
    const page = await openForm(browser);
    try {
      const options = await readListboxOptions(page, 13, "Are you currently under contract?");

      expect(options).toEqual(["Yes", "No"]);
      expect(await page.isChecked("#yes")).toBe(false);
      expect(await page.isChecked("#no")).toBe(false);
    } finally {
      await page.close();
    }
  });

  it("still opens a genuine dropdown to read its options", async () => {
    const page = await openForm(browser);
    try {
      expect(await readListboxOptions(page, 3, "Will you require sponsorship?")).toEqual(["Yes", "No"]);
    } finally {
      await page.close();
    }
  });

  it("still opens a prompt's search box to read its options", async () => {
    const page = await openForm(browser);
    try {
      expect(await readListboxOptions(page, 5, "Country Phone Code")).toEqual(["Canada (+1)", "India (+91)"]);
    } finally {
      await page.close();
    }
  });
});
