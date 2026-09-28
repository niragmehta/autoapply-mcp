import { AppError } from "../util/errors.js";

type ProcessingIndicator = {
  isVisible(): Promise<boolean>;
  waitFor(options: { state: "hidden"; timeout: number }): Promise<void>;
};

export async function waitForResumeProcessing(indicator: ProcessingIndicator, timeoutMs: number): Promise<void> {
  if (!(await indicator.isVisible())) return;
  try {
    await indicator.waitFor({ state: "hidden", timeout: timeoutMs });
  } catch (error) {
    throw new AppError("resume_processing_incomplete", "Resume analysis did not finish within the allowed time", {
      cause: String(error),
    });
  }
}
