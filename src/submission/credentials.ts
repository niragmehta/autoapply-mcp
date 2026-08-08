import { AppError } from "../util/errors.js";

/**
 * Credentials for boards that require an account before showing a form.
 *
 * Workday makes every applicant register on each employer's tenant, so a
 * password is unavoidable there. It is read from the environment and never
 * written to profile.json, campaign.json or any artifact: config files are
 * committed, backed up and pasted into chat, and a password in one of those is
 * a password that leaks. Nothing here is logged or returned to the caller.
 */

export type AtsCredentials = { email: string; password: string };

const EMAIL_VAR = "AUTOAPPLY_ATS_EMAIL";
const PASSWORD_VAR = "AUTOAPPLY_ATS_PASSWORD";

/** True when an account-based board can be attempted at all. */
export function hasAtsCredentials(): boolean {
  return Boolean(process.env[PASSWORD_VAR]);
}

/**
 * Returns the account credentials, falling back to the profile's own email so
 * only the password has to be supplied.
 */
export function getAtsCredentials(profileEmail: string): AtsCredentials {
  const password = process.env[PASSWORD_VAR] ?? "";
  if (!password) {
    throw new AppError(
      "credentials_missing",
      `this board requires an account. Set ${PASSWORD_VAR} in the server environment (never in profile.json), and optionally ${EMAIL_VAR} to use an address other than the profile's.`,
    );
  }
  const email = process.env[EMAIL_VAR] || profileEmail;
  if (!email) {
    throw new AppError("credentials_missing", `no account email available: set ${EMAIL_VAR} or personal.email in profile.json`);
  }
  return { email, password };
}

/**
 * Removes the password from text that is about to be logged or surfaced.
 *
 * A failing page often echoes what was typed into it, and an error message is
 * the most likely place for a secret to escape into a transcript.
 */
export function redactSecrets(text: string): string {
  const password = process.env[PASSWORD_VAR];
  if (!password || password.length < 4) return text;
  return text.split(password).join("[redacted]");
}
