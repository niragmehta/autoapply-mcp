import type { Profile } from "../domain/profile.js";
import { resolvePersonal } from "../drafting/personal.js";
import type { PersonalResolver } from "./formFields.js";

/**
 * Exposes the profile's stored personal and demographic answers to the browser
 * fill, using the same label resolver drafting uses. Boards without a published
 * question schema only reveal these questions on the live page, so they cannot
 * be drafted into the packet ahead of time.
 *
 * Answers the candidate has not opted in for automatic use are reported as
 * unauthorized and left for a person to complete.
 */
export function personalResolverFor(profile: Profile): PersonalResolver {
  return (label: string) => {
    const resolved = resolvePersonal(label, profile);
    if (!resolved) return null;
    return {
      answer: resolved.answer,
      citation: resolved.citation,
      category: resolved.category,
      authorized: resolved.authorized,
    };
  };
}
