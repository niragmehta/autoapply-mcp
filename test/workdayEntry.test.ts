import { beforeEach, describe, expect, it } from "vitest";

import { advanceWorkdayStep, enterWorkdayApplication, recoverWorkdayError } from "../src/submission/workdayFlow.js";

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
  /**
   * Body text the tenant renders. Defaults to a live advert so the existing
   * cases keep modelling a posting that painted; a closed posting overrides it.
   */
  bodyText =
    "Senior Software Engineer. San Jose, California. Apply. We are hiring engineers to build and operate large scale services, and this advert is long enough to be told apart from the bare careers shell that a tenant paints before its content arrives.";
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
      allInnerTexts: async () => [self.bodyText],
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

  it("refuses to call a closed posting a reached form", async () => {
    // Observed live: a Salesforce posting that had closed rendered "the page you
    // are looking for doesn't exist" with only a Sign In link. There is no
    // password field and no provider chooser, so both absence checks pass - yet
    // no application form exists. Entry previously reported "form reached" here.
    const tenant = new FakeTenant(ADVERT, {
      adventureButton: ADVERT,
    });

    const result = await enterWorkdayApplication(tenant.asPage(), "fallback@example.com", {
      allowAccountCreation: false,
    });

    expect(result.reached).toBe("blocked");
    expect(result.detail).toMatch(/posting is probably closed|never opened/i);
    expect(result.createdAccount).toBe(false);
  });

  it("names a pulled requisition instead of hedging about the wizard", async () => {
    // Observed live on Cisco: the tenant paints its careers shell, then renders
    // "The page you are looking for doesn't exist." in an error banner. Reporting
    // that as "the wizard never opened" invites a pointless retry.
    const tenant = new FakeTenant(["errorMessage"], {});
    tenant.bodyText =
      "Skip to main content Careers English Sign In Search for Jobs The page you are looking for doesn't exist. Search for Jobs Follow Us Privacy Policy";

    const result = await enterWorkdayApplication(tenant.asPage(), "fallback@example.com", {
      allowAccountCreation: false,
    });

    expect(result.reached).toBe("blocked");
    expect(result.detail).toMatch(/no longer exists/i);
    expect(result.createdAccount).toBe(false);
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

describe("advanceWorkdayStep", () => {
  it("advances a tenant whose control is pageFooterNextButton", async () => {
    // The live NVIDIA wizard labels this "Save and Continue" and carries no
    // bottom-navigation-next-button, so only this id can move the page on.
    const tenant = new FakeTenant(["pageFooterNextButton"], { pageFooterNextButton: ["formField-source"] });

    expect(await advanceWorkdayStep(tenant.asPage())).toBe(true);
    expect(tenant.clicks).toEqual(["pageFooterNextButton"]);
  });

  it("advances a tenant using the older bottom navigation control", async () => {
    const tenant = new FakeTenant(["bottom-navigation-next-button"], {
      "bottom-navigation-next-button": ["formField-source"],
    });

    expect(await advanceWorkdayStep(tenant.asPage())).toBe(true);
  });

  it("reports no advance when the final page offers neither control", async () => {
    const tenant = new FakeTenant(["submitButton"], {});

    expect(await advanceWorkdayStep(tenant.asPage())).toBe(false);
  });
});

describe("recoverWorkdayError", () => {
  // Workday drops a wizard step and shows "Something went wrong. Please refresh
  // the page and then try again." The stepper stays, every control vanishes, and
  // the run reported the posting as dead instead of doing what the page asked.
  function pageShowing(sequence: readonly string[]) {
    let index = 0;
    let reloads = 0;
    const page = {
      goto: async () => undefined,
      url: () => "https://nvidia.wd5.myworkdayjobs.com/x",
      waitForTimeout: async () => undefined,
      waitForLoadState: async () => undefined,
      evaluate: async () => sequence[index]!,
      keyboard: { press: async () => undefined },
      reload: async () => {
        reloads += 1;
        if (index < sequence.length - 1) index += 1;
        return undefined;
      },
      locator: () => ({
        first: () => page.locator(),
        nth: () => page.locator(),
        count: async () => 1,
        click: async () => undefined,
        fill: async () => undefined,
        isVisible: async () => true,
        waitFor: async () => undefined,
        locator: () => page.locator(),
        allInnerTexts: async () => [sequence[index]!],
        innerText: async () => sequence[index]!,
      }),
    } as never;
    return { page, reloads: () => reloads };
  }

  it("refreshes until the step comes back", async () => {
    const { page, reloads } = pageShowing(["Something went wrong", "My Information"]);
    expect(await recoverWorkdayError(page)).toBe(true);
    expect(reloads()).toBe(1);
  });

  it("does not refresh a healthy step", async () => {
    const { page, reloads } = pageShowing(["My Information"]);
    expect(await recoverWorkdayError(page)).toBe(true);
    expect(reloads()).toBe(0);
  });

  it("reports failure when refreshing does not help", async () => {
    const { page, reloads } = pageShowing(["Something went wrong"]);
    expect(await recoverWorkdayError(page)).toBe(false);
    expect(reloads()).toBe(2);
  });
});


