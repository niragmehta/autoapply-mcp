import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { resolvePersonal } from "../src/drafting/personal.js";
import { ProfileSchema } from "../src/domain/profile.js";

/**
 * A Workday address block asks for street, city, province and postal code as
 * four separate controls. Every one of them has to agree with the others.
 */
const example = JSON.parse(readFileSync(new URL("../examples/profile.example.json", import.meta.url), "utf8"));
const profile = ProfileSchema.parse({
  ...example,
  personal: {
    ...(example.personal ?? {}),
    address: {
      street: "301-5140 Sanders St",
      city: "Burnaby",
      region: "British Columbia",
      postalCode: "V5H 1T2",
      country: "Canada",
    },
    addressAutoFill: true,
  },
});

function resolve(label: string) {
  return resolvePersonal(label, profile);
}

describe("filling a postal address block", () => {
  it("puts the street on the first address line", () => {
    const answer = resolve("Address Line 1");
    expect(answer?.answer).toBe("301-5140 Sanders St");
  });

  it("leaves the second address line blank instead of repeating the street", () => {
    const answer = resolve("Address Line 2");
    expect(answer?.answer ?? "").toBe("");
  });

  it("leaves an apartment or suite box blank rather than inventing a unit", () => {
    for (const label of ["Apt", "Suite", "Unit"]) {
      expect(resolve(label)?.answer ?? "").toBe("");
    }
  });

  it("fills the city the stored address belongs to", () => {
    // His decision, 2026-08-16: where a form asks for the street and postal
    // code, the city must match them.
    const answer = resolve("City*");
    expect(answer?.answer).toBe("Burnaby");
    expect(answer?.citation).toBe("personal.address.city");
  });

  it("fills the province beside it", () => {
    const answer = resolve("Province or Territory*");
    expect(answer?.answer).toBe("British Columbia");
  });

  it("treats a bare State box as the address region", () => {
    expect(resolve("State")?.answer).toBe("British Columbia");
  });

  it("never answers a work-authorization question with a province", () => {
    const authorization = resolve("Are you legally authorized to work in the United States?");
    expect(authorization?.citation).not.toBe("personal.address.region");
    const sponsorship = resolve("Will you now or in the future require sponsorship in the United States?");
    expect(sponsorship?.citation).not.toBe("personal.address.region");
  });

  it("fills a geocoded location control from the identity location", () => {
    // It used to be left to a drafted location answer, but most Greenhouse
    // boards omit this core field from their published question schema, so no
    // such answer exists and the control aborted the submission instead.
    expect(resolve("Location (City)")?.citation).toBe("identity.location");
  });

  it("still fills the postal code", () => {
    expect(resolve("Postal Code")?.answer).toBe("V5H 1T2");
  });
});
