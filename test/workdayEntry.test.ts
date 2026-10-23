import { beforeEach, describe, expect, it } from "vitest";

import {
  advanceWorkdayStep,
  enterWorkdayApplication,
  recoverWorkdayError,
  workdayTenant,
} from "../src/submission/workdayFlow.js";

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
  /** Text of the error banner, shown only while `errorMessage` is visible. */
  errorText = "";
  /** Runs on every wait, so a test can make a screen paint late. */
  onWait?: () => void;
  /** Visible text of a control, by automation id; controls default to no text. */
  readonly labels: Record<string, string> = {};
  /** The second tab an emailed verification link is opened in, if any. */
  linkTab?: FakeLinkTab;
  private readonly transitions: Record<string, string[] | (() => string[])>;

  constructor(initial: string[], transitions: Record<string, string[] | (() => string[])>) {
    this.visible = new Set(initial);
    this.transitions = transitions;
  }

  private id(selector: string): string {
    // The resend control and the dialog asking where to send the email are
    // each reached through several selector shapes; the fake renders each as
    // a single control.
    if (selector.includes('[role="dialog"]')) return selector.includes("input") ? "dialogEmail" : "dialogConfirm";
    if (/resend/i.test(selector)) return "resendAccountVerification";
    return selector.replace(/^\[data-automation-id="/, "").replace(/"\]$/, "");
  }

  locator(selector: string) {
    const id = this.id(selector);
    const self = this;
    const locator = {
      first: () => locator,
      nth: () => locator,
      count: async () => (self.visible.has(id) ? 1 : 0),
      isVisible: async () => self.visible.has(id),
      innerText: async () => self.labels[id] ?? "",
      allInnerTexts: async () => [self.bodyText],
      waitFor: async () => {
        if (!self.visible.has(id)) throw new Error(`not visible: ${id}`);
      },
      click: async () => {
        if (!self.visible.has(id)) throw new Error(`not visible: ${id}`);
        self.clicks.push(id);
        const transition = self.transitions[id];
        const next = typeof transition === "function" ? transition() : transition;
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
      reload: async () => undefined,
      locator: (selector: string) => this.locator(selector),
      url: () => "https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/x",
      waitForTimeout: async () => {
        this.onWait?.();
      },
      waitForLoadState: async () => undefined,
      evaluate: async (script?: unknown) =>
        typeof script === "string" && script.includes("errorMessage") && this.visible.has("errorMessage")
          ? this.errorText
          : "",
      context: () => ({
        newPage: async () => {
          if (!this.linkTab) throw new Error("this scenario opens no second tab");
          return this.linkTab.asTab();
        },
      }),
    };
  }
}

/**
 * The tab an emailed verification link opens in. Opening it is what verifies
 * the account, so a test hands it the state change to make.
 */
class FakeLinkTab {
  readonly opened: string[] = [];
  closed = false;

  constructor(
    private readonly onOpen: () => void,
    private readonly text = "Your account has been verified. You can now sign in.",
    private readonly fails = false,
  ) {}

  asTab() {
    return {
      goto: async (url: string) => {
        this.opened.push(url);
        if (this.fails) throw new Error(`page.goto: net::ERR_CONNECTION_RESET at ${url}`);
        this.onOpen();
      },
      waitForLoadState: async () => undefined,
      waitForTimeout: async () => undefined,
      locator: () => ({ allInnerTexts: async () => [this.text] }),
      close: async () => {
        this.closed = true;
      },
    };
  }
}

const ADVERT = ["adventureButton"];
const MODAL = ["adventureButton", "applyManually", "autofillWithResume"];
const CHOOSER = ["GoogleSignInButton", "SignInWithEmailButton", "backToJobPosting"];
const CREDENTIALS = ["email", "password", "signInSubmitButton", "createAccountLink"];
const FORM = ["bottom-navigation-next-button", "progressBarActiveStep"];
const REGISTRATION = ["email", "password", "verifyPassword", "createAccountSubmitButton", "signInLink"];

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

  it("names the email-verification gate a tenant raises after registering the account", async () => {
    // Observed live on Guidewire: registration succeeds, then the tenant sends
    // the browser back to Sign In with "An email has been sent to you. Please
    // verify your account." Reading that as the open form filled the sign-in
    // box as if it were My Information and blamed an unfillable Password field.
    const tenant = new FakeTenant(ADVERT, {
      adventureButton: MODAL,
      applyManually: CHOOSER,
      SignInWithEmailButton: CREDENTIALS,
      signInSubmitButton: CREDENTIALS,
      createAccountLink: REGISTRATION,
      createAccountSubmitButton: CREDENTIALS,
    });
    tenant.bodyText += " Sign In An email has been sent to you. Please verify your account.";

    const result = await enterWorkdayApplication(tenant.asPage(), "fallback@example.com", {
      allowAccountCreation: true,
    });

    expect(tenant.clicks).toContain("createAccountSubmitButton");
    expect(result.reached).toBe("sign-in");
    expect(result.createdAccount).toBe(true);
    expect(result.detail).toMatch(/verif/i);
    expect(result.detail).toContain("candidate@example.com");
  });

  it("signs in with the new account when registration returns to the provider chooser", async () => {
    // Observed live on Palo Alto Networks: registering sends the browser back to
    // the Sign In provider chooser (Apple, Google, LinkedIn, "Sign in with
    // email"), which carries no password field. That absence was read as the
    // open form, so the run filled the sign-in page and blamed the posting.
    let signInAttempts = 0;
    const tenant = new FakeTenant(ADVERT, {
      adventureButton: MODAL,
      applyManually: CHOOSER,
      SignInWithEmailButton: CREDENTIALS,
      signInSubmitButton: () => (++signInAttempts === 1 ? CREDENTIALS : FORM),
      createAccountLink: REGISTRATION,
      createAccountSubmitButton: CHOOSER,
    });

    const result = await enterWorkdayApplication(tenant.asPage(), "fallback@example.com", {
      allowAccountCreation: true,
    });

    expect(tenant.clicks).toContain("createAccountSubmitButton");
    expect(signInAttempts).toBe(2);
    expect(result.reached).toBe("form");
    expect(result.createdAccount).toBe(true);
  });

  it("does not claim the form when registration returns to the chooser and sign-in fails", async () => {
    const tenant = new FakeTenant(ADVERT, {
      adventureButton: MODAL,
      applyManually: CHOOSER,
      SignInWithEmailButton: CREDENTIALS,
      signInSubmitButton: CREDENTIALS,
      createAccountLink: REGISTRATION,
      createAccountSubmitButton: CHOOSER,
    });

    const result = await enterWorkdayApplication(tenant.asPage(), "fallback@example.com", {
      allowAccountCreation: true,
    });

    expect(result.reached).toBe("sign-in");
    expect(result.createdAccount).toBe(true);
    expect(result.detail).toMatch(/created an account/i);
  });

  it("names the verification gate when registration returns to the chooser with a notice", async () => {
    const tenant = new FakeTenant(ADVERT, {
      adventureButton: MODAL,
      applyManually: CHOOSER,
      SignInWithEmailButton: CREDENTIALS,
      signInSubmitButton: CREDENTIALS,
      createAccountLink: REGISTRATION,
      createAccountSubmitButton: CHOOSER,
    });
    tenant.bodyText += " Sign In An email has been sent to you. Please verify your account.";

    const result = await enterWorkdayApplication(tenant.asPage(), "fallback@example.com", {
      allowAccountCreation: true,
    });

    expect(result.reached).toBe("sign-in");
    expect(result.createdAccount).toBe(true);
    expect(result.detail).toMatch(/verif/i);
    expect(result.detail).toContain("candidate@example.com");
  });

  it("does not read a return to the provider chooser after sign-in as being signed in", async () => {
    const tenant = new FakeTenant(ADVERT, {
      adventureButton: MODAL,
      applyManually: CHOOSER,
      SignInWithEmailButton: CREDENTIALS,
      signInSubmitButton: CHOOSER,
    });

    const result = await enterWorkdayApplication(tenant.asPage(), "fallback@example.com", {
      allowAccountCreation: false,
    });

    expect(result.reached).toBe("sign-in");
    expect(result.createdAccount).toBe(false);
  });

  it("does not register again when sign-in is refused until the account is verified", async () => {
    // Observed live on Palo Alto Networks: a rerun after registering was refused
    // with "Verify your account before you sign in", and the flow then submitted
    // the registration form a second time instead of naming the gate.
    const tenant = new FakeTenant(ADVERT, {
      adventureButton: MODAL,
      applyManually: CHOOSER,
      SignInWithEmailButton: CREDENTIALS,
      signInSubmitButton: [...CREDENTIALS, "errorMessage"],
      createAccountLink: REGISTRATION,
      createAccountSubmitButton: FORM,
    });
    tenant.errorText = "Verify your account before you sign in or request a verification email.";

    const result = await enterWorkdayApplication(tenant.asPage(), "fallback@example.com", {
      allowAccountCreation: true,
    });

    expect(tenant.clicks).not.toContain("createAccountLink");
    expect(tenant.clicks).not.toContain("createAccountSubmitButton");
    expect(result.reached).toBe("sign-in");
    expect(result.createdAccount).toBe(false);
    expect(result.detail).toMatch(/verif/i);
    expect(result.detail).toContain("candidate@example.com");
  });

  it("waits out a blank screen after registration instead of calling it the form", async () => {
    // Observed live on Palo Alto Networks: after registering, the wizard shows
    // neither the form nor a sign-in control for several seconds, then paints
    // the provider chooser. Judging the blank interval read it as the open form.
    let registered = false;
    let waitsSinceRegistration = 0;
    const tenant = new FakeTenant(ADVERT, {
      adventureButton: MODAL,
      applyManually: CHOOSER,
      SignInWithEmailButton: CREDENTIALS,
      signInSubmitButton: () => {
        tenant.errorText = registered
          ? "Verify your account before you sign in or request a verification email."
          : "Wrong email address or password.";
        return [...CREDENTIALS, "errorMessage"];
      },
      createAccountLink: REGISTRATION,
      createAccountSubmitButton: () => {
        registered = true;
        return [];
      },
    });
    tenant.onWait = () => {
      if (!registered) return;
      waitsSinceRegistration += 1;
      if (waitsSinceRegistration === 3) tenant.visible = new Set(CHOOSER);
    };

    const result = await enterWorkdayApplication(tenant.asPage(), "fallback@example.com", {
      allowAccountCreation: true,
    });

    expect(tenant.clicks).toContain("createAccountSubmitButton");
    expect(result.reached).toBe("sign-in");
    expect(result.createdAccount).toBe(true);
    expect(result.detail).toMatch(/verif/i);
    expect(result.detail).toContain("candidate@example.com");
  });

  it("reports the form reached when registration opens the application directly", async () => {
    const tenant = new FakeTenant(ADVERT, {
      adventureButton: MODAL,
      applyManually: CHOOSER,
      SignInWithEmailButton: CREDENTIALS,
      signInSubmitButton: CREDENTIALS,
      createAccountLink: REGISTRATION,
      createAccountSubmitButton: FORM,
    });

    const result = await enterWorkdayApplication(tenant.asPage(), "fallback@example.com", {
      allowAccountCreation: true,
    });

    expect(result.reached).toBe("form");
    expect(result.createdAccount).toBe(true);
  });
});

describe("verifying a Workday account through its emailed link", () => {
  const LINK = "https://acme.wd5.myworkdayjobs.com/en-US/External/activate/test-token";
  const REFUSAL = "Verify your account before you sign in or request a verification email.";

  beforeEach(() => {
    process.env.AUTOAPPLY_ATS_PASSWORD = "test-password-value";
    process.env.AUTOAPPLY_ATS_EMAIL = "candidate@example.com";
  });

  /**
   * A tenant holding an account that was registered but never verified. It
   * refuses sign-in with Workday's own banner and offers "Resend Account
   * Verification" until the emailed link has been opened.
   */
  function unverifiedTenant(resend: string[] | (() => string[]) = [...CREDENTIALS, "errorMessage"]) {
    const state = { verified: false };
    const tenant: FakeTenant = new FakeTenant(ADVERT, {
      adventureButton: MODAL,
      applyManually: CHOOSER,
      SignInWithEmailButton: CREDENTIALS,
      signInSubmitButton: () => (state.verified ? FORM : [...CREDENTIALS, "errorMessage", "resendAccountVerification"]),
      resendAccountVerification: resend,
      dialogConfirm: [...CREDENTIALS, "errorMessage"],
      createAccountLink: REGISTRATION,
      createAccountSubmitButton: FORM,
    });
    tenant.errorText = REFUSAL;
    return { tenant, state };
  }

  it("requests a fresh email for an unverified account, opens its link and signs in", async () => {
    let resentAt = 0;
    const { tenant, state } = unverifiedTenant(() => {
      resentAt = Date.now();
      tenant.errorText = "An email has been sent to you.";
      return [...CREDENTIALS, "errorMessage"];
    });
    const tab = new FakeLinkTab(() => {
      state.verified = true;
    });
    tenant.linkTab = tab;
    const requests: Date[] = [];

    const result = await enterWorkdayApplication(tenant.asPage(), "fallback@example.com", {
      allowAccountCreation: true,
      awaitVerificationLink: async (since) => {
        requests.push(since);
        return LINK;
      },
    });

    expect(tenant.clicks).toContain("resendAccountVerification");
    expect(requests).toHaveLength(1);
    // Dated before the click, so the email the click triggers is never too early.
    expect(requests[0]!.getTime()).toBeLessThanOrEqual(resentAt);
    expect(tab.opened).toEqual([LINK]);
    expect(tab.closed).toBe(true);
    expect(tenant.clicks).not.toContain("createAccountSubmitButton");
    expect(result).toMatchObject({ reached: "form", createdAccount: false });
    expect(result.detail).toMatch(/verified .*emailed link/i);
  });

  it("gives the address when the resend asks where to send the email", async () => {
    const { tenant, state } = unverifiedTenant([...CREDENTIALS, "errorMessage", "dialogEmail", "dialogConfirm"]);
    tenant.linkTab = new FakeLinkTab(() => {
      state.verified = true;
    });

    const result = await enterWorkdayApplication(tenant.asPage(), "fallback@example.com", {
      allowAccountCreation: false,
      awaitVerificationLink: async () => LINK,
    });

    expect(tenant.filled.dialogEmail).toBe("candidate@example.com");
    expect(tenant.clicks).toContain("dialogConfirm");
    expect(result.reached).toBe("form");
  });

  it("keeps today's instructions, and says so, when no email arrives in time", async () => {
    const { tenant } = unverifiedTenant();
    const tab = new FakeLinkTab(() => undefined);
    tenant.linkTab = tab;

    const result = await enterWorkdayApplication(tenant.asPage(), "fallback@example.com", {
      allowAccountCreation: true,
      awaitVerificationLink: async () => null,
    });

    expect(result).toMatchObject({ reached: "sign-in", createdAccount: false });
    expect(result.detail).toMatch(/not verified yet: open the verification email sent to candidate@example\.com/);
    expect(result.detail).toMatch(/no verification email arrived within \d+s/);
    expect(tab.opened).toEqual([]);
    expect(tenant.clicks).not.toContain("createAccountSubmitButton");
  });

  it("does not wait for an email it found no way to request", async () => {
    let waited = false;
    const tenant = new FakeTenant(ADVERT, {
      adventureButton: MODAL,
      applyManually: CHOOSER,
      SignInWithEmailButton: CREDENTIALS,
      signInSubmitButton: [...CREDENTIALS, "errorMessage"],
    });
    tenant.errorText = REFUSAL;

    const result = await enterWorkdayApplication(tenant.asPage(), "fallback@example.com", {
      allowAccountCreation: true,
      awaitVerificationLink: async () => {
        waited = true;
        return LINK;
      },
    });

    expect(waited).toBe(false);
    expect(result.reached).toBe("sign-in");
    expect(result.detail).toMatch(/not verified yet/);
    expect(result.detail).toMatch(/Resend Account Verification/);
  });

  it("follows the link emailed on registration and signs in with the new account", async () => {
    // Some tenants register the account and then return the browser to Sign In
    // with "An email has been sent to you. Please verify your account."
    let verified = false;
    let registeredAt = 0;
    const tenant: FakeTenant = new FakeTenant(ADVERT, {
      adventureButton: MODAL,
      applyManually: CHOOSER,
      SignInWithEmailButton: CREDENTIALS,
      signInSubmitButton: () => (verified ? FORM : CREDENTIALS),
      createAccountLink: REGISTRATION,
      createAccountSubmitButton: () => {
        registeredAt = Date.now();
        tenant.bodyText += " Sign In An email has been sent to you. Please verify your account.";
        return CREDENTIALS;
      },
    });
    const tab = new FakeLinkTab(() => {
      verified = true;
    });
    tenant.linkTab = tab;
    const requests: Date[] = [];

    const result = await enterWorkdayApplication(tenant.asPage(), "fallback@example.com", {
      allowAccountCreation: true,
      awaitVerificationLink: async (since) => {
        requests.push(since);
        return LINK;
      },
    });

    expect(tenant.clicks).toContain("createAccountSubmitButton");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.getTime()).toBeLessThanOrEqual(registeredAt);
    expect(tab.opened).toEqual([LINK]);
    expect(result).toMatchObject({ reached: "form", createdAccount: true });
    expect(result.detail).toMatch(/created .*verified it via the emailed link/i);
  });

  it("keeps the registration instructions when the email never arrives", async () => {
    const tenant: FakeTenant = new FakeTenant(ADVERT, {
      adventureButton: MODAL,
      applyManually: CHOOSER,
      SignInWithEmailButton: CREDENTIALS,
      signInSubmitButton: CREDENTIALS,
      createAccountLink: REGISTRATION,
      createAccountSubmitButton: () => {
        tenant.bodyText += " Sign In An email has been sent to you. Please verify your account.";
        return CREDENTIALS;
      },
    });

    const result = await enterWorkdayApplication(tenant.asPage(), "fallback@example.com", {
      allowAccountCreation: true,
      awaitVerificationLink: async () => null,
    });

    expect(result).toMatchObject({ reached: "sign-in", createdAccount: true });
    expect(result.detail).toMatch(/requires email verification first/);
    expect(result.detail).toMatch(/no verification email arrived/);
  });

  it("reports a link that would not open without echoing it", async () => {
    const { tenant } = unverifiedTenant();
    const tab = new FakeLinkTab(() => undefined, undefined, true);
    tenant.linkTab = tab;

    const result = await enterWorkdayApplication(tenant.asPage(), "fallback@example.com", {
      allowAccountCreation: false,
      awaitVerificationLink: async () => LINK,
    });

    expect(result.reached).toBe("sign-in");
    expect(result.detail).toMatch(/could not be opened/);
    expect(result.detail).not.toContain("test-token");
    expect(tab.closed).toBe(true);
  });

  it("never follows a link off Workday's own hosts, whatever supplied it", async () => {
    const { tenant } = unverifiedTenant();
    const tab = new FakeLinkTab(() => undefined);
    tenant.linkTab = tab;

    const result = await enterWorkdayApplication(tenant.asPage(), "fallback@example.com", {
      allowAccountCreation: false,
      awaitVerificationLink: async () => "https://acme.wd5.myworkdayjobs.com.evil.example/activate/x",
    });

    expect(tab.opened).toEqual([]);
    expect(result.reached).toBe("sign-in");
  });

  it("says so when the account still refuses sign-in after the link was opened", async () => {
    const { tenant } = unverifiedTenant();
    tenant.linkTab = new FakeLinkTab(() => undefined, "This verification link has expired.");

    const result = await enterWorkdayApplication(tenant.asPage(), "fallback@example.com", {
      allowAccountCreation: false,
      awaitVerificationLink: async () => LINK,
    });

    expect(result.reached).toBe("sign-in");
    expect(result.detail).toMatch(/opened the emailed verification link, but signing in afterwards did not complete/);
    expect(result.detail).toMatch(/reported a problem with the link/);
  });
});

describe("workdayTenant", () => {
  it("reads the tenant from a career-site host", () => {
    expect(workdayTenant("https://acme.wd5.myworkdayjobs.com/en-US/External/job/x")).toBe("acme");
    expect(workdayTenant("https://Acme.WD1.myworkdayjobs.com/External")).toBe("acme");
  });

  it("names no tenant for anything else", () => {
    expect(workdayTenant("https://wd5.myworkdayjobs.com/External")).toBeUndefined();
    expect(workdayTenant("https://acme.example.com/jobs")).toBeUndefined();
    expect(workdayTenant("not a url")).toBeUndefined();
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

  it("never presses the footer button when it reads Submit", async () => {
    // On Review the same pageFooterNextButton is Submit. Nasdaq's Review page
    // reported no step name, the walk pressed it, and the application went out
    // past the review read-back.
    const tenant = new FakeTenant(["pageFooterNextButton"], { pageFooterNextButton: ["candidateHome"] });
    tenant.labels.pageFooterNextButton = "Submit";

    expect(await advanceWorkdayStep(tenant.asPage())).toBe(false);
    expect(tenant.clicks).toEqual([]);
  });

  it("still presses a Save and Continue footer button", async () => {
    const tenant = new FakeTenant(["pageFooterNextButton"], { pageFooterNextButton: ["formField-source"] });
    tenant.labels.pageFooterNextButton = "Save and Continue";

    expect(await advanceWorkdayStep(tenant.asPage())).toBe(true);
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



// Red Hat's tenant requires 14 characters and lists the rule on its
// create-account page; a shorter stored password could never register there.
describe("a tenant whose password minimum exceeds the stored password", () => {
  const STORED = "test-password-value";
  const LENGTHENED = STORED.repeat(2);

  beforeEach(() => {
    process.env.AUTOAPPLY_ATS_PASSWORD = STORED;
    process.env.AUTOAPPLY_ATS_EMAIL = "candidate@example.com";
  });

  it("registers with the stored password lengthened to the stated minimum", async () => {
    const tenant = new FakeTenant(ADVERT, {
      adventureButton: MODAL,
      applyManually: CHOOSER,
      SignInWithEmailButton: CREDENTIALS,
      signInSubmitButton: CREDENTIALS,
      createAccountLink: REGISTRATION,
      signInLink: CREDENTIALS,
      createAccountSubmitButton: FORM,
    });
    tenant.bodyText += " Password Requirements: An uppercase character. A minimum of 24 characters.";

    const result = await enterWorkdayApplication(tenant.asPage(), "fallback@example.com", {
      allowAccountCreation: true,
    });

    expect(result.reached).toBe("form");
    expect(result.createdAccount).toBe(true);
    expect(tenant.filled.password).toBe(LENGTHENED);
    expect(tenant.filled.verifyPassword).toBe(LENGTHENED);
  });

  it("signs back in with the lengthened password instead of registering twice", async () => {
    const tenant = new FakeTenant(ADVERT, {
      adventureButton: MODAL,
      applyManually: CHOOSER,
      SignInWithEmailButton: CREDENTIALS,
      signInSubmitButton: () => (tenant.filled.password === LENGTHENED ? FORM : CREDENTIALS),
      createAccountLink: REGISTRATION,
      signInLink: CREDENTIALS,
      createAccountSubmitButton: FORM,
    });
    tenant.bodyText += " A minimum of 24 characters.";

    const result = await enterWorkdayApplication(tenant.asPage(), "fallback@example.com", {
      allowAccountCreation: true,
    });

    expect(result.reached).toBe("form");
    expect(result.createdAccount).toBe(false);
    expect(tenant.clicks).not.toContain("createAccountSubmitButton");
  });

  it("keeps the stored password where it already meets the minimum", async () => {
    const tenant = new FakeTenant(ADVERT, {
      adventureButton: MODAL,
      applyManually: CHOOSER,
      SignInWithEmailButton: CREDENTIALS,
      signInSubmitButton: CREDENTIALS,
      createAccountLink: REGISTRATION,
      createAccountSubmitButton: FORM,
    });
    tenant.bodyText += " A minimum of 8 characters.";

    const result = await enterWorkdayApplication(tenant.asPage(), "fallback@example.com", {
      allowAccountCreation: true,
    });

    expect(result.reached).toBe("form");
    expect(tenant.filled.password).toBe(STORED);
    expect(tenant.clicks).not.toContain("signInLink");
  });
});
