import { isWorkdayHost } from "../verificationLinks.js";
import { normalizeLabel, type FieldDescriptor } from "./fieldModel.js";

/**
 * Whole-phrase patterns, not substrings. A bare "security challenge" matched
 * inside "enterprise security challenges", which is ordinary prose in almost
 * every security job advert, so a correct posting was reported as an anti-bot
 * wall. A challenge marker has to be copy that asks the reader to act.
 */
const CAPTCHA_CHALLENGE_PATTERNS = [
  /\b(?:verify|verifying|confirm|confirming)\s+(?:that\s+)?you\s+are\s+(?:a\s+)?human\b/,
  /\bare\s+you\s+a\s+robot\b/,
  /\b(?:please\s+)?complete\s+(?:the|this)\s+(?:captcha|security\s+(?:challenge|check))\b/,
  /\bchallenge\s+in\s+progress\b/,
  /\bchecking\s+(?:if\s+the\s+site\s+connection\s+is\s+secure|your\s+browser)\b/,
  /\bunusual\s+traffic\s+from\s+your\s+(?:computer|network)\b/,
];

/** Detects active anti-bot challenge copy without flagging passive widget markup. */
export function detectCaptcha(pageText: string): boolean {
  const haystack = pageText.toLowerCase();
  return CAPTCHA_CHALLENGE_PATTERNS.some((pattern) => pattern.test(haystack));
}

/**
 * Workday sometimes completes a submission on the wizard's last step and lands
 * on Candidate Home, whose "My Applications" table lists the job with the date
 * it was submitted. F5's tenant did, and the run then looked for a submit
 * button that no longer existed and reported a failure for an application the
 * tenant had accepted. The job's own title has to be listed, beside the
 * table's submission-date column.
 */
export function workdayListsSubmitted(pageText: string, jobTitle: string): boolean {
  const text = pageText.replace(/\s+/g, " ").toLowerCase();
  const title = jobTitle.replace(/\s+/g, " ").trim().toLowerCase();
  return title.length > 0 && /\bmy applications\b/.test(text) && /\bdate submitted\b/.test(text) && text.includes(title);
}

const SUBMISSION_CONFIRMATION_MARKERS = [
  "thank you for applying",
  "thanks for applying",
  "your application has been submitted",
  "your application was submitted",
  "application submitted",
  "we received your application",
  "we've received your application",
  "we have received your application",
  "your application has been received",
  "we've got your application",
  "we have your application",
];

/**
 * Employers write the same confirmation with an adverb in the middle - Ashby
 * renders "Your application was successfully submitted" - which no literal
 * marker matches. A run that really did submit is then reported as unverified,
 * and the obvious response, submitting again, sends a duplicate. These patterns
 * allow one optional adverb between the verb and its participle; the subject
 * and participle are still both required, so unrelated page copy cannot pass.
 */
const SUBMISSION_CONFIRMATION_PATTERNS = [
  // Broadcom's Workday puts the adverb before "been": "Your application has
  // successfully been submitted."
  /\byour application (?:was|has(?: \w+ly)? been|is)(?: \w+ly)? (?:submitted|received|sent|complete[d]?)\b/,
  /\bapplication (?:was|has(?: \w+ly)? been)(?: \w+ly)? (?:submitted|received)\b/,
  // "already submitted/applied" is deliberately absent: it reads the same in an
  // employer's application-limits policy as in a real confirmation, so it is
  // handled by detectAlreadyApplied, which rejects conditional phrasing.
  /\bsuccessfully (?:submitted|applied)\b/,
  // Pinterest writes "Good news: your application is in!". As a bare phrase it
  // also matched "your application is incomplete" and "is in progress", which
  // recorded unfinished applications as sent, so the sentence has to end there.
  /\byour application is in(?=\s*[!.]|\s*$)/,
];

/**
 * ATS platforms route to a dedicated confirmation URL only after a submission
 * is accepted, so the path is a stronger signal than employer copy. Pinterest
 * writes "Good news: your application is in!" and Greenhouse still landed on
 * /job_app/confirmation, which no marker list would have covered in advance.
 * Lever routes a submitted application to /thanks.
 * The check is anchored to a whole path segment so a posting that merely
 * mentions the word cannot pass.
 */
const CONFIRMATION_URL_PATTERN =
  /(?:^|[/?&#])(?:confirmation|confirmed|application[_-]?(?:submitted|complete|received)|thank[_-]?you|thanks|success)(?:$|[/?&#])/i;

/** True when the ATS itself routed to a post-submission confirmation page. */
export function isConfirmationUrl(url: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return CONFIRMATION_URL_PATTERN.test(`${parsed.pathname}${parsed.search}${parsed.hash}`);
  } catch {
    return false;
  }
}

/**
 * An ATS that refuses a submission says so plainly, but it says it in a page
 * banner rather than a field error, so readValidationErrors does not see it and
 * the run fell back to "no confirmation was detected; verify this application
 * manually". Those two outcomes call for opposite responses. An unconfirmed
 * submission might have gone through, so the safe move is to check before
 * resubmitting and risk a duplicate. An explicit refusal means nothing was
 * submitted at all and the application still needs sending by hand. Ashby
 * rejects headless runs with "Your application submission was flagged as
 * possible spam", which read as the former and was in fact the latter.
 */
const SUBMISSION_REJECTED_MARKERS = [
  "couldn't submit your application",
  "could not submit your application",
  "unable to submit your application",
  "flagged as possible spam",
  "your application was not submitted",
  "we were unable to process your application",
];

/** True when the page states outright that it refused the submission. */
export function detectSubmissionRejection(pageText: string): boolean {
  const haystack = pageText.toLowerCase();
  return SUBMISSION_REJECTED_MARKERS.some((marker) => haystack.includes(marker));
}

/**
 * Boards state an existing application plainly, and that statement is positive
 * evidence: the application is on file whatever this run did. Cisco's Workday
 * tenant returns "You've already applied for this job." on a page with no form,
 * which the dead-posting check read as "the posting has been removed" - a
 * confident, wrong diagnosis of a submission that had in fact just succeeded,
 * and one that invites abandoning a live application.
 *
 * The submitted-application phrasings are kept apart from "already applied"
 * only for the reason string; both mean the same thing to a caller.
 */
const ALREADY_APPLIED_MARKERS = [
  "already applied for this job",
  "you have already applied",
  "you've already applied",
  "you already applied",
  "already submitted an application",
  "already submitted",
  "an application already exists",
];

/**
 * Wording that turns an already-applied phrase into a policy statement about
 * hypothetical candidates rather than a fact about this submission. Plaid's
 * Ashby posting carries "If you've already applied and been considered for a
 * specific role, you'll need to wait 12 months before reapplying", which is
 * printed above an empty form - reading it as proof of submission reported an
 * unsubmitted application as submitted.
 */
const CONDITIONAL_LEAD_IN = /\b(if|unless|in case|should you|whether|when|once)\b[^.!?]{0,40}$/;

/** True when the board says an application for this posting is already on file. */
export function detectAlreadyApplied(pageText: string): boolean {
  const haystack = pageText.toLowerCase();
  return ALREADY_APPLIED_MARKERS.some((marker) => {
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(marker, from);
      if (at === -1) return false;
      // Only the text since the last sentence break can qualify the phrase.
      const before = haystack.slice(Math.max(0, at - 60), at);
      if (!CONDITIONAL_LEAD_IN.test(before)) return true;
      from = at + marker.length;
    }
  });
}

/**
 * A Workday tenant may replace the platform's confirmation with its own welcome
 * copy. Mastercorp's modal over its job search reads "Thank you for your
 * interest in a career with Mastercorp! ... Our recruiting team will review your
 * application", which no marker above matches, so a submitted application was
 * reported unverified. The same sentence can sit in a posting's description,
 * which a Greenhouse page still shows after a refused submit, so it only counts
 * on Workday, whose post-submit pages carry no description.
 */
const WORKDAY_WELCOME_CONFIRMATION =
  /\b(?:our|the) (?:recruiting|hiring|talent(?: acquisition)?) team will (?:now )?review your application\b/;

function onWorkday(url: string): boolean {
  try {
    return isWorkdayHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Requires positive evidence before a run is recorded as submitted: either the
 * employer's own confirmation copy, or the ATS routing to its confirmation
 * page. Absence of both is still reported honestly as unverified.
 */
export function detectSubmissionConfirmation(pageText: string, finalUrl = ""): boolean {
  const haystack = pageText.toLowerCase();
  // A page that says it refused the submission cannot also be confirming one.
  // Ashby's rejection banner sits on the job page, whose URL can still look
  // like a confirmation route, so the refusal has to win over every signal.
  if (detectSubmissionRejection(haystack)) return false;
  if (detectAlreadyApplied(haystack)) return true;
  if (SUBMISSION_CONFIRMATION_MARKERS.some((marker) => haystack.includes(marker))) return true;
  if (SUBMISSION_CONFIRMATION_PATTERNS.some((pattern) => pattern.test(haystack))) return true;
  if (WORKDAY_WELCOME_CONFIRMATION.test(haystack.replace(/\s+/g, " ")) && onWorkday(finalUrl)) return true;
  return isConfirmationUrl(finalUrl);
}

const CORE_APPLICATION_FIELD = /\b(e-?mail|resume|resum|cv|first name|last name|full name|your name)\b/;

/**
 * A removed posting does not 404 on Greenhouse or Ashby; it quietly redirects to
 * the company's job index, which still exposes inputs such as "Search" and
 * "Department". Filling nothing there and reporting "prepared" reads as success,
 * so a run is only treated as a real application form when a core applicant
 * field is present.
 */
export function looksLikeApplicationForm(fields: readonly FieldDescriptor[]): boolean {
  return fields.some(
    (field) => field.type === "file" || CORE_APPLICATION_FIELD.test(normalizeLabel(field.label)),
  );
}
