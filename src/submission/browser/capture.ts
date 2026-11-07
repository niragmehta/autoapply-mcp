import { join } from "node:path";
import type { SubmissionPacket } from "../packet.js";
import type { AnyPage } from "./playwright.js";
import type { BrowserRunOptions, BrowserRunResult } from "./types.js";

export function aborted(reason: string, finalUrl: string): BrowserRunResult {  return {
    status: "aborted",
    reason,
    filledFields: [],
    unmatchedRequired: [],
    unusedAnswers: [],
    screenshotPath: null,
    finalUrl,
    confirmationText: "",
    captchaDetected: false,
  };
}

export async function readBodyText(page: AnyPage): Promise<string> {
  return page.locator("body").first().innerText().catch(() => "");
}

export async function captureCaptchaAbort(
  page: AnyPage,
  packet: SubmissionPacket,
  options: BrowserRunOptions,
  filledFields: BrowserRunResult["filledFields"] = [],
): Promise<BrowserRunResult> {
  const screenshotPath = await capture(page, options.artifactsDir, packet.applicationId, "captcha");
  return { ...aborted("interactive CAPTCHA detected; a human must complete this application", page.url()),
    filledFields, screenshotPath, captchaDetected: true };
}

export async function capture(page: AnyPage, dir: string, applicationId: string, stage: string): Promise<string> {
  const path = join(dir, `${applicationId}-${stage}-${Date.now()}.png`);
  await page.screenshot({ path, fullPage: true }).catch(() => undefined);
  return path;
}
