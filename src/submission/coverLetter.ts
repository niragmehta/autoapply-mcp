import type { SubmissionPacket } from "./packet.js";

/**
 * The cover letter written for an application reached the packet, its hash and
 * its preview, but no step of the browser run ever read it. Greenhouse's
 * current board also keeps its text box behind an "Enter manually" button, so
 * the field pass never saw a control to put the drafted template in either.
 * Every Greenhouse application went out without a cover letter while the
 * approved packet said it carried one.
 */

type Locator = {
  first: () => Locator;
  count: () => Promise<number>;
  isVisible: () => Promise<boolean>;
  click: (options?: unknown) => Promise<void>;
  fill: (value: string, options?: unknown) => Promise<void>;
  waitFor: (options?: unknown) => Promise<void>;
  inputValue?: () => Promise<string>;
};

export type CoverLetterPage = { locator: (selector: string) => Locator };

export type CoverLetterOutcome = "entered" | "absent" | "empty" | "failed";

// Only the cover letter's own toggle. The resume carries an identical "Enter
// manually" button, and opening that one would swap the uploaded resume for
// an empty text box.
const TOGGLE = [
  '[data-testid="cover_letter-text"]',
  '[data-field="cover_letter"] [data-source="paste"]',
].join(", ");

const TEXT_BOX = [
  "textarea#cover_letter_text",
  'textarea[name="job_application[cover_letter_text]"]',
].join(", ");

const COVER_LETTER_QUESTION = /^cover\s*letter\b/i;
const REVEAL_TIMEOUT_MS = 5000;

/**
 * The letter to send: the one written for this application, otherwise the
 * drafted answer to the form's own cover-letter question, which is part of the
 * approved packet. A drafted answer still waiting on a person is never sent;
 * one a person supplied is theirs, even though the question still requires them.
 */
export function coverLetterFor(packet: Pick<SubmissionPacket, "coverLetter" | "answers">): string {
  const tailored = (packet.coverLetter ?? "").trim();
  if (tailored.length > 0) return tailored;
  const drafted = (packet.answers ?? []).find(
    (entry) =>
      (entry.questionKey === "cover_letter_text" || COVER_LETTER_QUESTION.test(entry.label.trim())) &&
      entry.category !== "attachment" &&
      (!entry.requiresHuman || entry.source === "human") &&
      entry.answer.trim().length > 0,
  );
  return drafted?.answer.trim() ?? "";
}

function sameText(held: string, sent: string): boolean {
  const normalize = (value: string): string => value.replace(/\r\n?/g, "\n").trim();
  return normalize(held) === normalize(sent);
}

async function isShowing(locator: Locator): Promise<boolean> {
  return (await locator.count()) > 0 && (await locator.isVisible().catch(() => false));
}

/**
 * Types the letter into the board's cover-letter text box, opening it first
 * when the board hides it. A cover letter is optional everywhere this applies,
 * so a failure is reported rather than thrown: the application is still worth
 * sending, just as it was before this step existed.
 */
export async function enterCoverLetter(page: CoverLetterPage, text: string): Promise<CoverLetterOutcome> {
  if (text.trim().length === 0) return "empty";
  try {
    const box = page.locator(TEXT_BOX).first();
    if (!(await isShowing(box))) {
      const toggle = page.locator(TOGGLE).first();
      if ((await toggle.count()) === 0) return "absent";
      await toggle.click({ timeout: REVEAL_TIMEOUT_MS });
      await box.waitFor({ state: "visible", timeout: REVEAL_TIMEOUT_MS }).catch(() => undefined);
      if (!(await isShowing(box))) return "failed";
    }
    await box.fill(text);
    const held = box.inputValue ? await box.inputValue() : text;
    if (sameText(held, text)) return "entered";
    // A letter cut off mid-sentence reads worse than none at all.
    await box.fill("");
    return "failed";
  } catch {
    return "failed";
  }
}
