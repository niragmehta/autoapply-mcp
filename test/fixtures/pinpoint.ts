import { jobPostingLd } from "./smbHttp.js";

/**
 * Trimmed from live Pinpoint /postings.json and posting pages (Nov 2026).
 * Names, ids and text are placeholders.
 */

export const PINPOINT_UUID = "3ab1fb8a-6f79-4e03-87c3-9dbfba1b1f07";

export function pinpointPosting(overrides: Record<string, unknown> = {}) {
  return {
    id: "290785",
    benefits: "<ul><li>Health coverage</li></ul>",
    benefits_header: "Benefits",
    compensation: "$110,000 - $180,000 / year",
    compensation_minimum: 110000,
    compensation_maximum: 180000,
    compensation_currency: "USD",
    compensation_frequency: "year",
    compensation_visible: true,
    deadline_at: null,
    description: "<div>As a Senior Test Engineer you will own test operations.</div>",
    employment_type: "full_time",
    employment_type_text: "Full Time",
    key_responsibilities: "<ul><li>Design test systems</li></ul>",
    key_responsibilities_header: "Responsibilities",
    skills_knowledge_expertise: "<ul><li>5+ years of hardware testing</li></ul>",
    skills_knowledge_expertise_header: "Minimum Qualifications",
    title: "Senior Test Engineer",
    url: `https://acme.pinpointhq.com/en/postings/${PINPOINT_UUID}`,
    path: `/en/postings/${PINPOINT_UUID}`,
    workplace_type: "onsite",
    workplace_type_text: "Onsite",
    job: { id: "306744", requisition_id: "REQ-0350", department: { id: "62809", name: "Test" } },
    location: { id: "6679", city: "Redondo Beach", name: "Redondo Beach ", postal_code: "90278", province: "California" },
    ...overrides,
  };
}

export function pinpointPage(overrides: Record<string, unknown> = {}): string {
  return jobPostingLd({
    datePosted: "2025-01-23T17:54:48+00:00",
    title: "Senior Test Engineer",
    identifier: { "@type": "PropertyValue", name: "Pinpoint Job Posting ID", value: PINPOINT_UUID },
    jobLocation: { "@type": "Place", address: { "@type": "PostalAddress", addressCountry: "US", addressLocality: "Redondo Beach", addressRegion: "California" } },
    applicantLocationRequirements: { "@type": "Country", name: "United States" },
    ...overrides,
  });
}

export const PINPOINT_DEMO_DESCRIPTION =
  "<div>Welcome!<iframe src=\"https://www.youtube.com/embed/https://www.youtube.com/embed/pFxm6fszrpw\"></iframe></div>";
