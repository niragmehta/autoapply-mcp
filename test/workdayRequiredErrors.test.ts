import { describe, expect, it } from "vitest";
import { parseWorkdayRequiredErrors } from "../src/submission/workdayFlow.js";

describe("parseWorkdayRequiredErrors", () => {
  it("names a question revealed by an earlier answer, which only the error banner shows", () => {
    // Intel shows 11d only once 11c is answered, after the step was collected.
    const banner =
      "Errors Found 1. Error - 11d)* Please indicate your current immigration status (select one): The field 11d)* Please indicate your current immigration status (select one): is required and must have a value.";

    expect(parseWorkdayRequiredErrors(banner)).toEqual(["11d) Please indicate your current immigration status (select one)"]);
  });

  it("reads every field the banner lists, once each", () => {
    const banner = [
      "The field Have you resided in Cuba, Iran, North Korea, Syria or the Crimea, Donetsk, or Luhansk occupied regions of Ukraine during the last five years? is required and must have a value.",
      "The field Desired Type of Employment is required and must have a value.",
      "The field Desired Type of Employment is required and must have a value.",
    ].join("\n");

    expect(parseWorkdayRequiredErrors(banner)).toEqual([
      "Have you resided in Cuba, Iran, North Korea, Syria or the Crimea, Donetsk, or Luhansk occupied regions of Ukraine during the last five years?",
      "Desired Type of Employment",
    ]);
  });

  it("finds nothing on a page without the banner", () => {
    expect(parseWorkdayRequiredErrors("Application Questions * Indicates a required field")).toEqual([]);
  });
});
