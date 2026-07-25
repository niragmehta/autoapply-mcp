import { describe, expect, it } from "vitest";
import { analyzeLocation } from "../src/ranking/location.js";

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

  it("honours explicit remote hints from the ATS", () => {
    const result = analyzeLocation(["Toronto, ON"], { isRemote: true });
    expect(result.locationClass).toBe("canada");
    expect(result.workplaceType).toBe("remote");
  });
});
