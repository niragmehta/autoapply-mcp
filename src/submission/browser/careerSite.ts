import { existsSync } from "node:fs";
import { resolvePaths } from "../../config/paths.js";
import { augmentAnswersForBrowser } from "../form/browserAnswers.js";
import { fallbackAnswersForFields } from "../form/fallbackAnswers.js";
import type { FieldDescriptor } from "../form/fieldModel.js";
import { pickOptionIndex } from "../form/optionMatching.js";
import { optionSearchCandidates } from "../form/optionSearch.js";
import { buildFillPlan } from "../formFields.js";
import type { SubmissionPacket } from "../packet.js";
import { careerBrowserChannel, careerProfileDir, runCareerSiteApplication } from "../careerSites.js";
import type { CareerSite, SitePage } from "../sites/types.js";
import { aborted, capture, readBodyText } from "./capture.js";
import { guardedFillFormPage } from "./fillPage.js";
import type { PersistentContext, PersistentLauncher } from "./playwright.js";
import type { BrowserRunOptions, BrowserRunResult } from "./types.js";

/**
 * Runs an application on an employer's own career site in the candidate's
 * signed-in browser profile. Always headed: these sites re-challenge sessions
 * they see in a headless browser, and a person may need to see what happened.
 */
export async function runCareerSite(
  chromium: PersistentLauncher,
  site: CareerSite,
  packet: SubmissionPacket,
  options: BrowserRunOptions,
): Promise<BrowserRunResult> {
  const profileDir = careerProfileDir(resolvePaths().home);
  if (!existsSync(profileDir)) {
    return aborted(
      `no signed-in browser profile at ${profileDir}; open Chrome with --user-data-dir pointing there, sign in to the ${site} career site by hand, close it, and run again`,
      packet.applyUrl,
    );
  }
  let context: PersistentContext;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      channel: careerBrowserChannel(),
      headless: false,
      viewport: { width: 1280, height: 1000 },
      acceptDownloads: false,
    });
  } catch (error) {
    return aborted(
      `could not open the signed-in browser profile (close any Chrome window using ${profileDir}): ${String(error instanceof Error ? error.message : error).split("\n")[0]}`,
      packet.applyUrl,
    );
  }
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    return await runCareerSiteApplication({
      site,
      page: page as unknown as SitePage,
      packet,
      submit: options.submit,
      relocationTargets: options.relocationTargets ?? [],
      hooks: {
        fillStep: async () => {
          const step = await guardedFillFormPage(page, packet, options, true);
          if ("status" in step) return step;
          const problems = [
            ...step.plan.unmatchedRequired.map((field) => field.label),
            ...step.failedRequired,
          ].filter((label, index, labels) => label.trim().length > 0 && labels.indexOf(label) === index);
          return { filled: step.filled, problems };
        },
        capture: (stage) => capture(page, options.artifactsDir, packet.applicationId, stage),
        readText: () => readBodyText(page),
        resolveChoice: (label, offered) => resolveChoiceFor(packet, options, label, offered),
      },
    });
  } finally {
    await context.close().catch(() => undefined);
  }
}

/** The offered option that answers one choice question, matched exactly as the generic filler would. */
function resolveChoiceFor(
  packet: SubmissionPacket,
  options: BrowserRunOptions,
  label: string,
  offered: readonly string[],
): string | null {
  // A real control index: the TN-sponsorship rule only applies to a control on the page.
  const field: FieldDescriptor = { selectorIndex: 0, label, type: "select", name: "", required: true, options: [...offered] };
  const packetAnswers = augmentAnswersForBrowser(packet.answers, options.candidateCountry);
  const plan = buildFillPlan(
    [field],
    [
      ...packetAnswers,
      ...fallbackAnswersForFields(
        [field],
        packetAnswers,
        options.answerBank ?? [],
        options.personalResolver,
        options.narrativeResolver,
        options.experienceResolver,
      ),
    ],
  );
  const match = plan.toFill[0];
  if (!match?.answer || !match.answer.answer.trim()) return null;
  const index = pickOptionIndex(offered, optionSearchCandidates(field, match.answer, packet.company));
  return index >= 0 ? (offered[index] ?? null) : null;
}
