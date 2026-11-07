/**
 * Trimmed from the live Mastercard Phenom career site
 * (careers.mastercard.com/us/en), November 2026. Field names and value shapes
 * are as served by the `/widgets` refineSearch and jobDetail calls; the
 * description and the many ML fields are cut down.
 */

export const PHENOM_BOARD = "careers.mastercard.com/us/en";

export function phenomJob(overrides: Record<string, unknown> = {}) {
  return {
    ml_skills: ["python", "sql"],
    type: "Full time",
    descriptionTeaser: "We are seeking a strategic Director, Data Science to lead the development of scalable AI and ML models.",
    state: "British Columbia",
    siteType: "external",
    reqId: "R-280077",
    city: "Vancouver",
    multi_location: ["Vancouver, Canada, V6C 3T4", "Toronto, Canada, M4W3E2"],
    applyUrl: "https://mastercard.wd1.myworkdayjobs.com/CorporateCareers/job/Vancouver-Canada/Director--Data-Science_R-280077/apply",
    externalApply: false,
    cityState: "Vancouver, British Columbia",
    country: "Canada",
    visibilityType: "External",
    jobId: "R-280077",
    locale: "en_US",
    title: "Director, Data Science",
    jobSeqNo: "MASRUSR280077EXTERNALENUS",
    postedDate: "2026-06-16T00:00:00.000+0000",
    dateCreated: "2026-06-16T20:28:55.127+0000",
    cityStateCountry: "Vancouver, British Columbia, Canada",
    location: "Vancouver, Canada, V6C 3T4",
    category: "AI & Data",
    isMultiLocation: true,
    ...overrides,
  };
}

export function phenomUsJob(overrides: Record<string, unknown> = {}) {
  return phenomJob({
    jobId: "R-294101",
    reqId: "R-294101",
    title: "Senior Software Engineer",
    city: "O'Fallon",
    state: "Missouri",
    country: "United States of America",
    multi_location: ["O'Fallon, Missouri, United States of America"],
    location: "O'Fallon, Missouri, United States of America",
    cityStateCountry: "O'Fallon, Missouri, United States of America",
    isMultiLocation: false,
    postedDate: "2026-11-03T00:00:00.000+0000",
    ...overrides,
  });
}

export function phenomSearch(jobs: unknown[], totalHits = jobs.length) {
  return { refineSearch: { status: 200, hits: jobs.length, totalHits, data: { jobs, aggregations: [] }, eid: "x" } };
}

export function phenomDetail(overrides: Record<string, unknown> = {}) {
  const job = phenomUsJob({
    description: "<p><span><b>Our Purpose</b></span></p><p>Mastercard powers economies and empowers people in 200&#43; countries.</p><p>The pay range for this position is $134,000 - $214,000 annually.</p>",
    postingEndDate: "",
    structureData: {
      "@type": "JobPosting",
      title: "Senior Software Engineer",
      employmentType: "Full time",
      datePosted: "2026-11-03T00:00:00.000+0000",
      jobLocation: { address: { addressCountry: "United States of America", addressLocality: "O'Fallon", addressRegion: "Missouri" } },
    },
    ...overrides,
  });
  return { jobDetail: { status: 200, hits: 1, totalHits: 1, data: { job, isMultiLocationEnabled: true } } };
}

export const PHENOM_NO_DETAIL = { jobDetail: { status: 200, hits: 0, totalHits: 0, data: {}, eid: { eid: "x" }, source: "ES" } };
