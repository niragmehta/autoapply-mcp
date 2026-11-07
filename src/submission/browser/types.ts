import type { SubmissionPolicy } from "../../domain/campaign.js";
import type { ApprovedAnswerEntry, NarrativeResolver, PersonalResolver } from "../form/answerBank.js";
import type { VerificationInboxConfig } from "../verificationInbox.js";

export type BrowserRunOptions = {
  headless?: boolean;
  submit: boolean;
  artifactsDir: string;
  policy: SubmissionPolicy;
  candidateCountry?: string;
  /**
   * Pre-approved answers used to fill questions the packet never enumerated,
   * which happens on boards that publish no question schema.
   */
  answerBank?: readonly ApprovedAnswerEntry[];
  /** Resolves stored personal and demographic answers for live field labels. */
  personalResolver?: PersonalResolver;
  /** Resolves employment-history fields from the candidate's stored positions. */
  experienceResolver?: PersonalResolver;
  narrativeResolver?: NarrativeResolver;
  timeoutMs?: number;
  /** Email for boards that require an account, defaulting to the profile's own. */
  accountEmail?: string;
  /**
   * Places the candidate would move to, used where a career site asks which of
   * a posting's locations to be considered for.
   */
  relocationTargets?: readonly string[];
  /**
   * Permits registering a new account on an employer's tenant. Off by default:
   * creating a credentialed account in the candidate's name is a larger step
   * than filling a public form and should be a deliberate choice.
   */
  allowAccountCreation?: boolean;
  /**
   * Milliseconds to leave a filled form open for a person to review and submit
   * themselves. Only used when `submit` is false.
   */
  keepOpenMs?: number;
  /**
   * The one-time code a board emails before it will accept a submission.
   * Greenhouse increasingly gates submission this way. Supplying it lets a
   * single automated run finish what would otherwise need a person to sit in
   * front of a browser.
   */
  verificationCode?: string;
  /**
   * How long to hold the browser open at a verification gate while waiting for
   * the code to appear at `codeFilePath`.
   *
   * A code cannot be carried between runs: clicking submit is what causes one
   * to be emailed, so a second run invalidates whatever the first produced.
   * Waiting inside the run is the only way an automated submission can clear
   * the gate.
   *
   * With a mailbox configured, this also bounds the wait for the link Workday
   * emails to verify a new or unverified candidate account.
   */
  codeWaitMs?: number;
  /** File polled for the code while `codeWaitMs` has not elapsed. */
  codeFilePath?: string;
  /**
   * Mailbox polled alongside `codeFilePath`, and for Workday's account
   * verification links. Defaults to whatever the environment configures, and
   * is absent unless deliberately switched on.
   */
  verificationInbox?: VerificationInboxConfig | null;
};

export type BrowserRunResult = {
  status: "prepared" | "submitted" | "aborted";
  reason: string;
  filledFields: Array<{ label: string; source: string }>;
  unmatchedRequired: string[];
  /**
   * Fields left for a person: optional questions with no approved answer, and
   * anything the campaign deliberately withholds such as arbitration receipts.
   * Only populated once a form has been analysed.
   */
  leftForHuman?: string[];
  unusedAnswers: string[];
  screenshotPath: string | null;
  finalUrl: string;
  confirmationText: string;
  captchaDetected: boolean;
};
