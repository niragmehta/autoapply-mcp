import { describe, expect, it } from "vitest";
import { coverLetterFor, enterCoverLetter } from "../src/submission/coverLetter.js";
import type { DraftAnswer } from "../src/domain/job.js";

function answer(overrides: Partial<DraftAnswer>): DraftAnswer {
  return {
    questionKey: "q",
    label: "Question",
    answer: "",
    source: "profile",
    citation: "",
    requiresHuman: false,
    required: false,
    category: "general",
    guidance: "",
    ...overrides,
  } as DraftAnswer;
}

type FakeState = {
  textareaVisible: boolean;
  textareaExists: boolean;
  toggleExists: boolean;
  revealOnClick: boolean;
  maxLength?: number;
  clickThrows?: boolean;
  // Browsers hand a textarea's value back with every line break as "\n".
  normalizesLineBreaks?: boolean;
  value: string;
  clicked: string[];
  fills: string[];
};

function fakePage(state: FakeState) {
  const textarea = {
    first: () => textarea,
    count: async () => (state.textareaExists ? 1 : 0),
    isVisible: async () => state.textareaExists && state.textareaVisible,
    waitFor: async () => {
      if (!(state.textareaExists && state.textareaVisible)) throw new Error("timeout");
    },
    click: async () => undefined,
    fill: async (value: string) => {
      state.fills.push(value);
      const stored = state.normalizesLineBreaks ? value.replace(/\r\n/g, "\n") : value;
      state.value = state.maxLength === undefined ? stored : stored.slice(0, state.maxLength);
    },
    inputValue: async () => state.value,
  };
  const toggle = (selector: string) => {
    const locator = {
      first: () => locator,
      count: async () => (state.toggleExists ? 1 : 0),
      isVisible: async () => state.toggleExists,
      waitFor: async () => undefined,
      fill: async () => undefined,
      click: async () => {
        if (state.clickThrows) throw new Error("detached");
        state.clicked.push(selector);
        if (state.revealOnClick) {
          state.textareaExists = true;
          state.textareaVisible = true;
        }
      },
    };
    return locator;
  };
  return {
    locator: (selector: string) => (selector.includes("textarea") ? textarea : toggle(selector)),
  };
}

function greenhouseState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    textareaVisible: false,
    textareaExists: false,
    toggleExists: true,
    revealOnClick: true,
    value: "",
    clicked: [],
    fills: [],
    ...overrides,
  };
}

describe("coverLetterFor", () => {
  it("sends the letter written for this application ahead of the drafted template", () => {
    const letter = coverLetterFor({
      coverLetter: "  Dear team, tailored.  ",
      answers: [answer({ questionKey: "cover_letter_text", label: "Cover Letter", answer: "Generic template." })],
    });
    expect(letter).toBe("Dear team, tailored.");
  });

  it("falls back to the drafted answer to the form's own cover-letter question", () => {
    const letter = coverLetterFor({
      coverLetter: "",
      answers: [
        answer({ questionKey: "cover_letter", label: "Cover Letter", answer: "", category: "attachment" }),
        answer({ questionKey: "cover_letter_text", label: "Cover Letter", answer: "Approved template." }),
      ],
    });
    expect(letter).toBe("Approved template.");
  });

  it("never sends a drafted letter that still needs a person", () => {
    const letter = coverLetterFor({
      coverLetter: "",
      answers: [answer({ questionKey: "cover_letter_text", label: "Cover Letter", answer: "Unreviewed.", requiresHuman: true })],
    });
    expect(letter).toBe("");
  });

  it("sends a letter a person supplied for the cover-letter question", () => {
    // set_application_content keeps requiresHuman and marks the answer as the
    // person's own, so that is what says the letter has been reviewed.
    const letter = coverLetterFor({
      coverLetter: "",
      answers: [
        answer({
          questionKey: "cover_letter_text",
          label: "Cover Letter",
          answer: "Written by me.",
          requiresHuman: true,
          source: "human",
        }),
      ],
    });
    expect(letter).toBe("Written by me.");
  });

  it("does not mistake an unrelated question for the cover letter", () => {
    const letter = coverLetterFor({
      coverLetter: "",
      answers: [answer({ questionKey: "question_1", label: "Why do you want to work here?", answer: "Because." })],
    });
    expect(letter).toBe("");
  });
});

describe("enterCoverLetter", () => {
  it("opens Greenhouse's hidden text box and types the letter into it", async () => {
    const state = greenhouseState();
    const outcome = await enterCoverLetter(fakePage(state), "Dear team,\n\nThank you.");
    expect(outcome).toBe("entered");
    expect(state.value).toBe("Dear team,\n\nThank you.");
    expect(state.clicked).toHaveLength(1);
    expect(state.clicked[0]).toContain("cover_letter-text");
    // The resume has its own "Enter manually" toggle; opening it would replace
    // the uploaded resume with an empty text box.
    expect(state.clicked[0]).not.toContain("resume");
  });

  it("types straight into a text box that is already showing", async () => {
    const state = greenhouseState({ textareaExists: true, textareaVisible: true });
    const outcome = await enterCoverLetter(fakePage(state), "Letter.");
    expect(outcome).toBe("entered");
    expect(state.clicked).toHaveLength(0);
    expect(state.value).toBe("Letter.");
  });

  it("leaves a board without a cover-letter text box untouched", async () => {
    const state = greenhouseState({ toggleExists: false });
    const outcome = await enterCoverLetter(fakePage(state), "Letter.");
    expect(outcome).toBe("absent");
    expect(state.fills).toHaveLength(0);
  });

  it("does nothing when there is no letter to send", async () => {
    const state = greenhouseState();
    const outcome = await enterCoverLetter(fakePage(state), "   ");
    expect(outcome).toBe("empty");
    expect(state.clicked).toHaveLength(0);
    expect(state.fills).toHaveLength(0);
  });

  it("clears a letter the box cut short rather than send half of it", async () => {
    const state = greenhouseState({ maxLength: 10 });
    const outcome = await enterCoverLetter(fakePage(state), "A letter much longer than ten characters.");
    expect(outcome).toBe("failed");
    expect(state.value).toBe("");
  });

  it("reports a toggle that will not open the box instead of throwing", async () => {
    const state = greenhouseState({ revealOnClick: false });
    const outcome = await enterCoverLetter(fakePage(state), "Letter.");
    expect(outcome).toBe("failed");
    expect(state.fills).toHaveLength(0);
  });

  it("reports a click that fails instead of aborting the application", async () => {
    const state = greenhouseState({ clickThrows: true });
    const outcome = await enterCoverLetter(fakePage(state), "Letter.");
    expect(outcome).toBe("failed");
  });

  it("treats line-ending differences in the read-back as the same letter", async () => {
    const state = greenhouseState({ normalizesLineBreaks: true });
    const outcome = await enterCoverLetter(fakePage(state), "Dear team,\r\n\r\nThanks.");
    expect(state.value).toBe("Dear team,\n\nThanks.");
    expect(outcome).toBe("entered");
  });
});
