import type { Profile } from "../domain/profile.js";
import { asksCurrentRoleEnd, resolveExperience } from "../drafting/experience.js";
import type { PersonalResolver } from "./formFields.js";

/**
 * Exposes the candidate's employment history to the browser fill.
 *
 * Boards render the history as separate company, title and start/end
 * month-and-year controls that no single stored answer can serve, so without
 * this every field in the block stays blank and a required-field abort follows.
 * The values are the resume's own facts, read from `profile.experience`. A
 * current role's end date resolves to a deliberate blank, so the fill leaves
 * it empty instead of reporting it missing or taking another block's date.
 */
export function experienceResolverFor(profile: Profile): PersonalResolver {
  return (label: string) =>
    resolveExperience(label, profile) ??
    (asksCurrentRoleEnd(label, profile)
      ? { answer: "", citation: "experience[0].end", category: "employment-history", authorized: true }
      : null);
}
