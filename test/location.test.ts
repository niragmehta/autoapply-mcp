import { describe, expect, it } from "vitest";
import { allLocationClasses, analyzeLocation, refineRemoteScopeFromTitle } from "../src/ranking/location.js";
import { CompanySchema } from "../src/domain/campaign.js";
import { normalizeJob } from "../src/sources/normalize.js";

describe("a bare remote location scoped by the posting title", () => {
  const company = CompanySchema.parse({ name: "Quanata", ats: "greenhouse", board: "quanata" });
  const normalize = (title: string, locations: string[]) =>
    normalizeJob(
      { company, externalId: "1", title, locations, url: "https://example.test/1", applyUrl: "", descriptionPlain: "Build things." },
      "2026-09-28T00:00:00.000Z",
    );

  it("reads an explicit remote-US marker in the title (Quanata 2026-09-27)", () => {
    for (const title of [
      "Senior Back End Engineer [Remote-US]",
      "Staff Engineer (Remote, United States)",
      "Senior Platform Engineer - US Remote",
      "Senior Security Engineer (Remote - USA)",
      "Staff Software Engineer, Remote (U.S.)",
    ]) {
      const job = normalize(title, ["Remote"]);
      expect(job.locationClass, title).toBe("remote-us");
      expect(job.country, title).toBe("US");
    }
  });

  it("reads an explicit remote-Canada marker in the title", () => {
    const job = normalize("Senior Backend Engineer (Remote - Canada)", ["Remote"]);
    expect(job.locationClass).toBe("remote-canada");
    expect(job.country).toBe("CA");
  });

  it("keeps a posting fingerprint consistent with the refined class", () => {
    const refined = normalize("Senior Back End Engineer [Remote-US]", ["Remote"]);
    const explicit = normalize("Senior Back End Engineer [Remote-US]", ["Remote - US"]);
    expect(refined.fingerprint).toBe(explicit.fingerprint);
  });

  it("ignores a country word that is not attached to a remote marker", () => {
    for (const title of ["Senior Engineer, US Payments", "Remote-first Staff Engineer", "Senior Engineer - Remote User Research Tools"]) {
      expect(normalize(title, ["Remote"]).locationClass, title).toBe("remote-global");
    }
  });

  it("never overrides a location the posting states outright", () => {
    expect(normalize("Senior Engineer [Remote-US]", ["Toronto, ON"]).locationClass).toBe("canada");
    expect(normalize("Senior Engineer [Remote-US]", ["Berlin, Germany"]).locationClass).toBe("other");
    expect(normalize("Senior Engineer (Remote - Canada)", ["Remote - US"]).locationClass).toBe("remote-us");
  });

  it("leaves analyses that are not remote-global untouched", () => {
    const onsite = analyzeLocation(["San Francisco, CA"]);
    expect(refineRemoteScopeFromTitle(onsite, "Senior Engineer [Remote-US]")).toBe(onsite);
  });
});

describe("analyzeLocation", () => {
  it("classifies unambiguous Bay Area cities", () => {
    for (const value of ["San Francisco, CA", "Palo Alto", "Mountain View, California", "Sunnyvale, CA, USA"]) {
      expect(analyzeLocation([value]).locationClass, value).toBe("bay-area");
    }
  });

  it("classifies regional phrasing", () => {
    expect(analyzeLocation(["SF Bay Area"]).locationClass).toBe("bay-area");
    expect(analyzeLocation(["Silicon Valley"]).locationClass).toBe("bay-area");
  });

  it("requires California context for ambiguous US city names", () => {
    expect(analyzeLocation(["Newark, CA"]).locationClass).toBe("bay-area");
    expect(analyzeLocation(["Newark, NJ"]).locationClass).toBe("us-other");
    expect(analyzeLocation(["Oakland, CA"]).locationClass).toBe("bay-area");
  });

  it("does not confuse Canadian cities with their US namesakes", () => {
    expect(analyzeLocation(["Richmond, BC"]).locationClass).toBe("canada");
    expect(analyzeLocation(["Richmond, CA"]).locationClass).toBe("bay-area");
    expect(analyzeLocation(["Vancouver, BC, Canada"]).locationClass).toBe("canada");
    expect(analyzeLocation(["Windsor, Ontario"]).locationClass).toBe("canada");
  });

  it("classifies Canadian cities and provinces", () => {
    for (const value of ["Toronto, ON", "Montreal, Quebec", "Ottawa, Canada", "Waterloo, ON", "Burnaby, British Columbia"]) {
      expect(analyzeLocation([value]).locationClass, value).toBe("canada");
    }
    expect(analyzeLocation(["Toronto, ON"]).country).toBe("CA");
  });

  it("separates remote scopes by country", () => {
    expect(analyzeLocation(["Remote - US"]).locationClass).toBe("remote-us");
    expect(analyzeLocation(["Remote (Canada)"]).locationClass).toBe("remote-canada");
    expect(analyzeLocation(["Remote"]).locationClass).toBe("remote-global");
    expect(analyzeLocation(["Remote"]).workplaceType).toBe("remote");
  });

  it("keeps the strongest match when several offices are listed", () => {
    const result = analyzeLocation(["New York, NY", "Toronto, ON", "Austin, TX"]);
    expect(result.locationClass).toBe("canada");

    const withBay = analyzeLocation(["New York, NY", "San Francisco, CA"]);
    expect(withBay.locationClass).toBe("bay-area");
  });

  it("detects hybrid and onsite workplace hints", () => {
    expect(analyzeLocation(["San Jose, CA (Hybrid)"]).workplaceType).toBe("hybrid");
    expect(analyzeLocation(["Toronto, ON - Onsite"]).workplaceType).toBe("onsite");
  });

  it("handles empty and unknown input", () => {
    expect(analyzeLocation([]).locationClass).toBe("unknown");
    expect(analyzeLocation([""]).locationClass).toBe("unknown");
    expect(analyzeLocation(["Berlin, Germany"]).locationClass).toBe("other");
  });

  it.each(["Rio de Janeiro", "Ciudad de México", "Berlin, DE"])(
    "does not treat the ambiguous DE token in %s as Delaware", (value) => {
      expect(analyzeLocation([value]).country).not.toBe("US");
      expect(analyzeLocation([value]).locationClass).toBe("other");
    },
  );

  it("does not promote a Brazil-only multi-location role into the US queue", () => {
    expect(analyzeLocation(["São Paulo", "Campinas", "Belo Horizonte", "Rio de Janeiro"]).locationClass).toBe("other");
  });

  it("retains explicit Delaware and mixed-location US evidence", () => {
    expect(analyzeLocation(["Wilmington, Delaware"]).locationClass).toBe("us-other");
    expect(analyzeLocation(["Wilmington, DE, USA"]).locationClass).toBe("us-other");
    expect(analyzeLocation(["Rio de Janeiro", "Palo Alto"]).locationClass).toBe("bay-area");
  });

  it("keeps foreign and US options distinct in the multi-location view", () => {
    expect(allLocationClasses(["Rio de Janeiro", "Palo Alto", "Berlin, DE", ""])).toEqual(["other", "bay-area"]);
  });

  it.each([
    "India, Hyderabad, DVS, SEZ-1 \u2013 Orion B4; FL 7,8,9,11 (Hyderabad - Divyasree 3)",
    "Hyderabad, India - FL. 7",
    "India - FL 11",
  ])("does not mistake office floors in %s for Florida", (value) => {
    expect(analyzeLocation([value])).toMatchObject({ locationClass: "other", country: "unknown" });
  });

  it.each(["Gainesville, FL", "Gainesville, FL 32601", "Orlando, Florida", "United States, FL 7"])(
    "retains genuine US location evidence in %s", (value) => {
      expect(analyzeLocation([value])).toMatchObject({ locationClass: "us-other", country: "US" });
    },
  );

  it("keeps a genuine US office when another office contains a floor abbreviation", () => {
    const locations = ["Hyderabad, India - FL 7", "Gainesville, FL 32601"];
    expect(allLocationClasses(locations)).toEqual(["other", "us-other"]);
    expect(analyzeLocation(locations).locationClass).toBe("us-other");
  });

  it.each(["Rotterdam, NL", "Amsterdam, NL"])(
    "does not mistake the country shorthand in %s for a Canadian province", (value) => {
      expect(analyzeLocation([value])).toMatchObject({ locationClass: "other", country: "unknown" });
    },
  );

  it("requires Canadian context for ambiguous NL while preserving Newfoundland locations", () => {
    for (const value of ["St. John's, NL", "Newfoundland and Labrador, Canada", "Corner Brook, NL, Canada"]) {
      expect(analyzeLocation([value]).locationClass, value).toBe("canada");
    }
    expect(analyzeLocation(["Remote - Newfoundland and Labrador"]).locationClass).toBe("remote-canada");
    expect(analyzeLocation(["Remote - NL"]).country).toBe("unknown");
    expect(allLocationClasses(["Rotterdam, NL", "Toronto, ON"])).toEqual(["other", "canada"]);
  });

  it("honours explicit remote hints from the ATS", () => {
    const result = analyzeLocation(["Toronto, ON"], { isRemote: true });
    expect(result.locationClass).toBe("canada");
    expect(result.workplaceType).toBe("remote");
  });
});
