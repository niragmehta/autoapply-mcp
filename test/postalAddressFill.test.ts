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

  it("leaves a bare City to the identity location rather than the postal address", () => {
    // A deliberate campaign decision: City and Location are answered from
    // identity, so the candidate can present a metro area and still give an
    // exact address when a form asks for one. Changing which city appears on
    // an application is his call, not the resolver's.
    expect(resolve("City*")).toBeNull();
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

  it("leaves a geocoded location control to the location answer", () => {
    expect(resolve("Location (City)")).toBeNull();
  });

  it("still fills the postal code", () => {
    expect(resolve("Postal Code")?.answer).toBe("V5H 1T2");
  });
});
