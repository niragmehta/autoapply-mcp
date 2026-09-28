import { describe, expect, it, vi } from "vitest";
import type { FillPlan } from "../src/submission/formFields.js";
import type { WorkdayPromptResult } from "../src/submission/workdayFlow.js";

const prompt = vi.hoisted(() => ({ result: { filled: false, detail: "" } as WorkdayPromptResult }));

vi.mock("../src/submission/workdayFlow.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/submission/workdayFlow.js")>()),
  isWorkdayPrompt: async () => true,
  fillWorkdayPrompt: async () => prompt.result,
}));

const { StrayValueError, repairReportedFields } = await import("../src/submission/browser.js");

type RepairPage = Parameters<typeof repairReportedFields>[0];

function workdayPage(): RepairPage {
  const wrapper = { count: async () => 1 };
  const control = { first: () => control, count: async () => 1, locator: () => wrapper };
  return {
    url: () => "https://adobe.wd5.myworkdayjobs.com/en-US/external_experienced/job/San-Jose/Senior-Engineer_R1/apply",
    locator: () => control,
    evaluate: async () => undefined,
    keyboard: { type: async () => undefined, press: async () => undefined },
    waitForTimeout: async () => undefined,
  } as unknown as RepairPage;
}

const LABEL = "How Did You Hear About Us?";

function sourceQuestion(): FillPlan["toFill"][number] {
  return {
    field: { label: LABEL, type: "text", selectorIndex: 0, required: true, name: "source", role: "combobox" },
    answer: { label: LABEL, answer: "LinkedIn", questionKey: "how-did-you-hear", source: "profile", required: true },
    confidence: 1,
  } as unknown as FillPlan["toFill"][number];
}

describe("a Workday prompt left holding a value nobody approved", () => {
  it("stops a repair rather than letting the form be sent again", async () => {
    prompt.result = { filled: false, detail: 'the field now reads ["Findem"]', strayValue: true };

    await expect(repairReportedFields(workdayPage(), [sourceQuestion()], [`${LABEL} is required`])).rejects.toBeInstanceOf(
      StrayValueError,
    );
  });

  it("still only logs a repair that left the field blank", async () => {
    prompt.result = { filled: false, detail: "no Workday option matched" };

    await expect(repairReportedFields(workdayPage(), [sourceQuestion()], [`${LABEL} is required`])).resolves.toEqual([]);
  });
});
