import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { READ_VALIDATION_ERRORS } from "../src/submission/validationErrors.js";

async function errorsOn(browser: Browser, html: string): Promise<string[]> {
  const page = await browser.newPage();
  try {
    await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto("https://job-boards.greenhouse.io/fixture/jobs/1");
    return (await page.evaluate(READ_VALIDATION_ERRORS)) as string[];
  } finally {
    await page.close();
  }
}

// Rocket Money's posting was pasted from Word Online, which leaves its
// proofing marks in the markup. The salary sentence arrived split across spans,
// one of them classed ContextualSpellingAndGrammarErrorV2.
const WORD_PASTED_DESCRIPTION = `
  <div class="job__description">
    <p>Additional information: Salary range&nbsp;<span class="TextRun Highlight SCXW210315824 BCX0" lang="EN-US">
      <span class="NormalTextRun SCXW210315824 BCX0">of $200</span><span class="NormalTextRun ContextualSpellingAndGrammarErrorV2 SCXW210315824 BCX0">,000 - $270,000</span><span class="NormalTextRun SCXW210315824 BCX0">/year + bonus + benefits.</span>
    </span></p>
    <p><span class="NormalTextRun SpellingErrorV2Themed SCXW1 BCX0">Truebill</span> is now Rocket Money.</p>
  </div>`;

describe("validation errors in a local browser", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  it("does not report Word proofing marks in a pasted job description as form errors", async () => {
    // Read as an error, this ended the post-submit wait the instant Submit was
    // clicked, before Greenhouse drew its security-code gate, and the run
    // aborted an application whose code had already been emailed.
    const errors = await errorsOn(browser, `<main>${WORD_PASTED_DESCRIPTION}<form><input name="email" value="a@b.co"></form></main>`);
    expect(errors).toEqual([]);
  });

  it("still reports a real field error on the same page", async () => {
    const errors = await errorsOn(
      browser,
      `<main>${WORD_PASTED_DESCRIPTION}<form><input name="email"><div class="field-error">Email is required</div></form></main>`,
    );
    expect(errors).toEqual(["Email is required"]);
  });

  it("keeps an error container whose text carries a proofing mark", async () => {
    // A proofing span nested inside a real error must not make the container
    // look like a mere wrapper around a more specific error.
    const errors = await errorsOn(
      browser,
      `<form><div class="error-message">Enter a valid <span class="SpellingErrorV2">LinkedIn</span> URL</div></form>`,
    );
    expect(errors).toEqual(["Enter a valid LinkedIn URL"]);
  });
});
