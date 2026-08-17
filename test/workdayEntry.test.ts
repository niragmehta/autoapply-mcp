import { beforeEach, describe, expect, it } from "vitest";

import { enterWorkdayApplication } from "../src/submission/workdayFlow.js";

/**
 * A Workday tenant reduced to the part the entry walk depends on: which
 * controls are on screen, and how clicking one changes that.
 *
 * The screens mirror a live NVIDIA tenant observed in the browser. The
 * important detail is the provider chooser between "Apply Manually" and the
 * credential form: it carries no email or password field, so a flow that infers
 * "signed in" from a missing password field misreads it.
 */
class FakeTenant {
  visible: Set<string>;
  readonly clicks: string[] = [];
  readonly filled: Record<string, string> = {};
  private readonly transitions: Record<string, string[]>;

  constructor(initial: string[], transitions: Record<string, string[]>) {
    this.visible = new Set(initial);
    this.transitions = transitions;
  }

  private id(selector: string): string {
    return selector.replace(/^\[data-automation-id="/, "").replace(/"\]$/, "");
  }

  locator(selector: string) {
    const id = this.id(selector);
    const self = this;
    const locator = {
      first: () => locator,
      count: async () => (self.visible.has(id) ? 1 : 0),
      isVisible: async () => self.visible.has(id),
      waitFor: async () => {
        if (!self.visible.has(id)) throw new Error(`not visible: ${id}`);
      },
      click: async () => {
        if (!self.visible.has(id)) throw new Error(`not visible: ${id}`);
        self.clicks.push(id);
        const next = self.transitions[id];
        if (next) self.visible = new Set(next);
      },
      fill: async (value: string) => {
        if (!self.visible.has(id)) throw new Error(`not visible: ${id}`);
        self.filled[id] = value;
      },
    };
    return locator;
  }

  asPage() {
    return {
      goto: async () => undefined,
      locator: (selector: string) => this.locator(selector),
      url: () => "https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/x",
      waitForTimeout: async () => undefined,
      waitForLoadState: async () => undefined,
      evaluate: async () => "",
    };
  }
}

const ADVERT = ["adventureButton"];
const MODAL = ["adventureButton", "applyManually", "autofillWithResume"];
const CHOOSER = ["GoogleSignInButton", "SignInWithEmailButton", "backToJobPosting"];
const CREDENTIALS = ["email", "password", "signInSubmitButton", "createAccountLink"];
const FORM = ["bottom-navigation-next-button", "progressBarActiveStep"];

describe("enterWorkdayApplication", () => {
  beforeEach(() => {
    process.env.AUTOAPPLY_ATS_PASSWORD = "test-password-value";
    process.env.AUTOAPPLY_ATS_EMAIL = "candidate@example.com";
  });

  it("opens the credential form hidden behind the sign-in provider chooser", async () => {
    const tenant = new FakeTenant(ADVERT, {
      adventureButton: MODAL,
      applyManually: CHOOSER,
      SignInWithEmailButton: CREDENTIALS,
      signInSubmitButton: FORM,
    });

    const result = await enterWorkdayApplication(tenant.asPage(), "fallback@example.com", {
      allowAccountCreation: false,
    });

    expect(tenant.clicks).toContain("SignInWithEmailButton");
    expect(tenant.filled.email).toBe("candidate@example.com");
    expect(result.reached).toBe("form");
    expect(result.createdAccount).toBe(false);
  });

  it("reports the sign-in wall instead of claiming the form was reached", async () => {
    // The chooser never opens the credential form, so no password field ever
    // appears. Absence of that field must not be read as being signed in.
    const tenant = new FakeTenant(ADVERT, {
      adventureButton: MODAL,
      applyManually: CHOOSER,
      SignInWithEmailButton: CHOOSER,
    });

    const result = await enterWorkdayApplication(tenant.asPage(), "fallback@example.com", {
      allowAccountCreation: false,
    });

    expect(result.reached).toBe("sign-in");
    expect(result.detail).toMatch(/sign-in wall/i);
  });

  it("still recognises a session that is already signed in", async () => {
    // No chooser and no credential form: the application form is genuinely open.
    const tenant = new FakeTenant(ADVERT, {
      adventureButton: MODAL,
      applyManually: FORM,
    });

    const result = await enterWorkdayApplication(tenant.asPage(), "fallback@example.com", {
      allowAccountCreation: false,
    });

    expect(result.reached).toBe("form");
    expect(result.detail).toMatch(/already signed in/i);
  });

  it("does not create an account unless account creation is permitted", async () => {
    const tenant = new FakeTenant(ADVERT, {
      adventureButton: MODAL,
      applyManually: CHOOSER,
      SignInWithEmailButton: CREDENTIALS,
      // Sign-in is refused, so the credential form stays on screen.
      signInSubmitButton: CREDENTIALS,
    });

    const result = await enterWorkdayApplication(tenant.asPage(), "fallback@example.com", {
      allowAccountCreation: false,
    });

    expect(result.reached).toBe("sign-in");
    expect(result.createdAccount).toBe(false);
    expect(tenant.clicks).not.toContain("createAccountSubmitButton");
  });
});
