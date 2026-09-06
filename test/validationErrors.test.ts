import { describe, expect, it } from "vitest";
import { READ_VALIDATION_ERRORS } from "../src/submission/validationErrors.js";

function read({ live = [], alerts = [], plain = [], error = [] }: { live?: string[]; alerts?: string[]; plain?: string[]; error?: string[] }) {
  const element = (textContent: string, alert = false) => ({
    textContent,
    children: [],
    querySelector: () => null,
    getBoundingClientRect: () => ({ width: 200, height: 20 }),
    getAttribute: (key: string) => key === "role" && alert ? "alert" : key === "aria-live" ? "polite" : null,
  });
  const document = {
    querySelectorAll: (selector: string) => {
      if (selector.includes('[role="alert"]')) return [...live.map((text) => element(text)), ...alerts.map((text) => element(text, true))];
      if (selector.startsWith('[class*="error"')) return error.map((text) => element(text));
      if (selector === "li, p, span, div") return [...live, ...alerts, ...plain, ...error].map((text) => element(text));
      return [];
    },
  };
  return new Function("document", "window", `return ${READ_VALIDATION_ERRORS}`)(
    document, { getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
  );
}

describe("validation announcements", () => {
  it("does not treat a completed upload announcement as an error", () => {
    expect(read({ live: ["resume.pdf successfully uploaded"] })).toEqual([]);
    expect(read({ alerts: ["resume.pdf successfully uploaded"] })).toEqual([]);
  });

  it("ignores non-error live status updates", () => {
    expect(read({ live: ["Loading", "3 options available", "Application saved"] })).toEqual([]);
    expect(read({ alerts: ["Your application was successfully submitted."] })).toEqual([]);
  });

  it("keeps actual errors announced in a live region", () => {
    expect(read({ live: ["End date must be after start date.", "Please enter your email address."] })).toEqual([
      "End date must be after start date.", "Please enter your email address.",
    ]);
  });

  it("does not let upload success hide a real error", () => {
    expect(read({ live: ["Resume successfully uploaded. Email is required."] })).toEqual([
      "Resume successfully uploaded. Email is required.",
    ]);
  });

  it("does not mistake static question instructions for validation", () => {
    expect(read({ plain: [
      "Please select Yes if you are currently authorized to work but will require sponsorship later.",
      "Please enter your preferred name.",
    ] })).toEqual([]);
  });

  it("keeps a specific CAPTCHA resubmission error without an error class", () => {
    expect(read({ plain: ["Please complete the reCAPTCHA and resubmit your application."] })).toEqual([
      "Please complete the reCAPTCHA and resubmit your application.",
    ]);
  });

  it("continues trusting explicit error markup", () => {
    expect(read({ error: ["This value cannot be accepted."] })).toEqual(["This value cannot be accepted."]);
  });

  it("preserves unfamiliar wording in an explicit alert", () => {
    expect(read({ alerts: ["Entered dates overlap."] })).toEqual(["Entered dates overlap."]);
  });

  it("ignores conditional question guidance in a polite live region", () => {
    expect(read({ live: ["Please select Yes if you will require sponsorship later."] })).toEqual([]);
  });
});
