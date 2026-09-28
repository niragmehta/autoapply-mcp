export function hostedHtml(appData: unknown, metadata?: unknown): string {
  return `<script nonce="example">
window.__appData = ${JSON.stringify(appData)};
window.mustNotExecute = true;
</script>${metadata === undefined ? "" : `<script type="application/ld+json">${JSON.stringify(metadata)}</script>`}`;
}

export function hostedBoard(overrides: Record<string, unknown> = {}) {
  return {
    organization: { hostedJobsPageSlug: "acme" },
    jobBoard: { jobPostings: [{ id: "role-1", title: "Senior Security Engineer" }] },
    ...overrides,
  };
}

export function hostedPosting(overrides: Record<string, unknown> = {}) {
  return {
    id: "role-1", title: "Senior Security Engineer", isListed: true, isConfidential: false,
    locationName: "San Francisco, CA", secondaryLocationNames: ["New York, NY"],
    workplaceType: "Remote", employmentType: "FullTime",
    descriptionHtml: "<p>Build AI security guardrails and policy systems in Python with threat modeling.</p>",
    compensationTierSummary: "$240K - $300K",
    ...overrides,
  };
}

export function hostedMetadata(overrides: Record<string, unknown> = {}) {
  return {
    "@type": "JobPosting", identifier: { value: "role-1" }, datePosted: "2026-08-18",
    baseSalary: {
      currency: "USD", value: { minValue: 240000, maxValue: 300000, unitText: "YEAR" },
    },
    ...overrides,
  };
}

export function hostedDetail(posting: unknown = hostedPosting(), metadata: unknown = hostedMetadata()) {
  return hostedHtml({ organization: { hostedJobsPageSlug: "acme" }, posting }, metadata);
}
