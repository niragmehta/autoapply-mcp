import { describe, expect, it } from "vitest";
import { availabilityDate, datePickerParts } from "../src/submission/workdayDates.js";

// The stored start-date answer says when the candidate could start, not on
// which day - "Approximately four weeks from offer acceptance." - and a Workday
// date picker takes only a date. BlackLine, Western Governors University and
// Early Warning each stopped on one until a date was typed in by hand.
describe("availabilityDate", () => {
  // Wednesday, 11 November 2026.
  const wednesday = new Date(2026, 10, 11);

  it("adds the stated period and starts on the following Monday", () => {
    expect(availabilityDate("Approximately four weeks from offer acceptance.", wednesday)).toBe("2026-12-14");
  });

  it("takes the longer end of a range", () => {
    expect(availabilityDate("Two to four weeks after accepting an offer.", wednesday)).toBe("2026-12-14");
    expect(availabilityDate("2-3 weeks notice", wednesday)).toBe("2026-12-07");
  });

  it("counts days and months", () => {
    expect(availabilityDate("30 days", wednesday)).toBe("2026-12-14");
    expect(availabilityDate("one month", wednesday)).toBe("2026-12-14");
  });

  it("starts on the next Monday when available immediately", () => {
    expect(availabilityDate("Immediately", wednesday)).toBe("2026-11-16");
  });

  it("keeps a date that already falls on a Monday", () => {
    expect(availabilityDate("two weeks", new Date(2026, 10, 2))).toBe("2026-11-16");
  });

  it("gives nothing for text that states no period", () => {
    expect(availabilityDate("Flexible", wednesday)).toBeNull();
    expect(availabilityDate("Yes", wednesday)).toBeNull();
    expect(availabilityDate("Within a few weeks", wednesday)).toBeNull();
  });
});

describe("datePickerParts", () => {
  const wednesday = new Date(2026, 10, 11);
  const notice = "Approximately four weeks from offer acceptance.";

  it("fills an availability picker from the notice period", () => {
    expect(datePickerParts(notice, "formField-start", "What is your earliest possible start date?", wednesday)).toEqual([
      ["Month", "12"],
      ["Day", "14"],
      ["Year", "2026"],
    ]);
    expect(datePickerParts(notice, "", "When are you available to start?", wednesday)).not.toBeNull();
    expect(datePickerParts(notice, "", "What is your desired start date?", wednesday)).not.toBeNull();
  });

  it("still takes a date as written", () => {
    expect(datePickerParts("2027-01-04", "", "When are you available to start?", wednesday)).toEqual([
      ["Month", "01"],
      ["Day", "04"],
      ["Year", "2027"],
    ]);
  });

  it("never turns a notice period into an employment or education date", () => {
    expect(datePickerParts(notice, "workExperience-1--startDate", "Start date", wednesday)).toBeNull();
    expect(datePickerParts(notice, "education-1--lastYearAttended", "To", wednesday)).toBeNull();
  });

  it("refuses a notice period on a date that is not about starting", () => {
    expect(datePickerParts(notice, "", "Date of birth", wednesday)).toBeNull();
    expect(datePickerParts(notice, "", "From", wednesday)).toBeNull();
  });
});
