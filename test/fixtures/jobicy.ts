/**
 * Trimmed from the live Jobicy API (https://jobicy.com/api/jobs?count=2&tag=engineer&geo=usa, Nov 2026).
 * Company names and text are placeholders.
 */

export function jobicyJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 159403,
    url: "https://jobicy.com/jobs/159403-software-engineer-ii-mobile",
    jobSlug: "159403-software-engineer-ii-mobile",
    jobTitle: "Software Engineer II (Mobile &#8211; Android)",
    companyName: "Zone &#038; Co",
    companyLogo: "https://jobicy.com/data/logo.png",
    jobIndustry: ["Engineering"],
    jobType: ["Full-Time"],
    jobGeo: "USA",
    jobLevel: "Midweight",
    jobExcerpt: "Build our Android app.",
    jobDescription: "<p>Build our Android app.</p>",
    pubDate: "2026-11-06T10:06:42-07:00",
    salaryMin: 116000,
    salaryMax: 174000,
    salaryCurrency: "USD",
    salaryPeriod: "yearly",
    ...overrides,
  };
}

export function jobicyPage(jobs: unknown[], nextCursor: string | null = null) {
  return {
    apiVersion: "2",
    documentationUrl: "https://jobicy.com/jobs-rss-feed",
    friendlyNotice: "Please credit Jobicy and link to the original listing.",
    jobCount: jobs.length,
    lastUpdate: "2026-11-06T17:30:00+00:00",
    nextCursor,
    hasMore: nextCursor !== null,
    appliedFilters: {},
    jobs,
    statusCode: 200,
    success: true,
  };
}
