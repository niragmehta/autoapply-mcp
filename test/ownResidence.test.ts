import { describe, expect, it } from "vitest";
import { resolvePersonal } from "../src/drafting/personal.js";
import { ProfileSchema } from "../src/domain/profile.js";
import { makeProfile } from "./factories.js";

/**
 * The answer bank stores one blanket "No - based in Vancouver, Canada" for
 * residence questions. That is true of everywhere except the one place he
 * lives, so a board naming Canada was told he is not in it.
 */
describe("residence questions naming the candidate's own location", () => {
  const base = makeProfile();
  const profile = ProfileSchema.parse({
    ...base,
    identity: {
      ...base.identity,
      location: { city: "Vancouver", region: "British Columbia", country: "Canada" },
    },
  });

  const answer = (label: string) => resolvePersonal(label, profile)?.answer ?? null;

  it("answers yes when the question names where he lives", () => {
    expect(answer("Are you located in or willing to relocate to Canada?")).toBe("Yes");
    expect(answer("Do you currently live in British Columbia?")).toBe("Yes");
    expect(answer("Are you based in Vancouver?")).toBe("Yes");
  });

  it("says nothing about anywhere else, so the stored answer still applies", () => {
    // These must keep falling through to the bank's "No - based in Vancouver".
    expect(answer("Are you located in the United States?")).toBeNull();
    expect(answer("Are you currently based in Buenos Aires, Argentina?")).toBeNull();
  });

  it("will not answer a question phrased as the inverse", () => {
    // Naming Canada to mean the opposite. Answering "Yes" here would be a lie.
    expect(answer("Are you located outside of Canada?")).toBeNull();
    expect(answer("Do you reside anywhere other than Canada?")).toBeNull();
  });

  it("leaves work authorization alone even though it names the country", () => {
    // Legal status, not residence; the bank has a deliberate answer for it.
    expect(answer("Are you legally authorized to work in Canada?")).toBeNull();
    expect(answer("Will you require visa sponsorship to work in Canada?")).toBeNull();
    // Phrased as residence *and* legal status. "Yes" would answer the
    // sponsorship half the wrong way round, so it stays with a person.
    expect(answer("Are you based in Canada and do you require visa sponsorship?")).toBeNull();
  });
});
