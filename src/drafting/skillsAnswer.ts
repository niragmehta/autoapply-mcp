import type { Profile } from "../domain/profile.js";

/** Marks an answer that lists the profile's skills, so a picker searches them one at a time. */
export const SKILLS_CITATION = "skills[].name";

const SHOWN_LEVELS = new Set(["expert", "strong"]);
const MAX_SKILLS = 10;

/**
 * The candidate's skills for a "Skills" question, strongest first.
 *
 * Thomson Reuters' Workday tenant makes "Type to Add Skills" required on My
 * Experience, and no stored answer named one, so the step never advanced and
 * every application there failed. The answer comes from the profile's own
 * skills list - expert and strong entries, in the order written - so nothing
 * is claimed that the profile does not already state.
 */
export function profileSkillsAnswer(profile: Profile): string {
  const strong = profile.skills.filter((skill) => SHOWN_LEVELS.has(skill.level));
  return (strong.length > 0 ? strong : profile.skills)
    .slice(0, MAX_SKILLS)
    .map((skill) => skill.name)
    .join(", ");
}

/**
 * A skills answer split into the separate searches a picker needs. Workday's
 * skills prompt searches one term at a time, and the whole list matches
 * nothing; a free-text field still takes the list as written.
 */
export function skillSearches(citation: string | undefined, value: string): string[] {
  if (citation !== SKILLS_CITATION) return [];
  return value
    .split(/\s*,\s*/)
    .map((skill) => skill.trim())
    .filter((skill) => skill.length > 0);
}
