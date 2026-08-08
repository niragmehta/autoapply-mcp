import type { Profile } from "../domain/profile.js";
import { resolveExperience } from "../drafting/experience.js";
import type { PersonalResolver } from "./formFields.js";

/**
 * Exposes the candidate's employment history to the browser fill.
 *
 * Boards render the history as separate company, title and start/end
 * month-and-year controls that no single stored answer can serve, so without
 * this every field in the block stays blank and a required-field abort follows.
 * The values are the resume's own facts, read from `profile.experience`.
 */
export function experienceResolverFor(profile: Profile): PersonalResolver {
  return (label: string) => resolveExperience(label, profile);
}
