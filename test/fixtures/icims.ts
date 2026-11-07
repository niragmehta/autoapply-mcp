/**
 * Trimmed from the live General Dynamics Mission Systems iCIMS portal
 * (careers-gdms.icims.com), November 2026. Markup structure, class names and
 * attribute order are as served; text is shortened.
 */

export const ICIMS_HOST = "careers-gdms.icims.com";

function card(id: string, slug: string, title: string, location: string, posted: string, extra = ""): string {
  return `
<li class="iCIMS_JobCardItem">
<div class="row">
<div class="col-xs-6 header right">
<span class="sr-only field-label">Posted Date</span>
<span title="${posted}">
3 hours ago<span class="sr-only">(${posted})</span></span>
</div>
<div class="col-xs-12 title">
<a href="https://${ICIMS_HOST}/jobs/${id}/${slug}/job?in_iframe=1" class="iCIMS_Anchor" title="${id} - ${title}">
<span class="sr-only field-label">Title</span>
<h3 >
${title}</h3>
</a>
</div>
<div class="col-xs-12 description">
Bachelor&rsquo;s degree or equivalent combination of education and relevant work is required.&nbsp;
CLEARANCE REQUIREMENTS:&nbsp;Department of Defense Secret security clearance obtainable...</div>
<div class="col-xs-12 additionalFields">
<dl class="iCIMS_JobHeaderGroup">
<div class="iCIMS_JobHeaderTag">
<dt class="iCIMS_JobHeaderField">ID</dt>
<dd class="iCIMS_JobHeaderData"><span >
2026-${id}</span>
</dd>
</div>
<div class="iCIMS_JobHeaderTag">
<dt class="iCIMS_JobHeaderField"><span class="glyphicons glyphicons-map-marker" aria-hidden="true"></span>
<span class="sr-only field-label">Job Location</span>
</dt>
<dd class="iCIMS_JobHeaderData"><span >
${location}</span>
</dd>
</div>
${extra}
</dl>
</div>
</div>
</li>`;
}

const SALARY = `<div class="iCIMS_JobHeaderTag">
<dt class="iCIMS_JobHeaderField">Combined Salary Range</dt>
<dd class="iCIMS_JobHeaderData"><span >
USD $91,193.00 - USD $98,674.00 /Yr.</span>
</dd>
</div>`;

function pager(current: number, total: number): string {
  const links = Array.from({ length: total }, (_unused, index) => `<a href="https://${ICIMS_HOST}/jobs/search?pr=${index}&amp;in_iframe=1" class="${index === current ? "selected" : ""}">
<span class="sr-only">Page</span> ${index + 1} <span class="sr-only"> of ${total}${index === current ? " , Current Page" : ""} </span>
</a>`).join("\n");
  return `<div class="iCIMS_Paging text-center">\n<div class="iCIMS_PagingBatch ">${links}</div></div>`;
}

export function icimsSearchPage(cards: string[], current = 0, total: number | null = 1): string {
  return `<!DOCTYPE html><html><head><title>Search Results | Careers</title></head><body>
<div class="container-fluid iCIMS_JobsTable">${total === null ? "" : pager(current, total)}
<ul class="container-fluid iCIMS_JobsTable">${cards.join("\n")}</ul>
${total === null ? "" : pager(current, total)}</div></body></html>`;
}

export const ICIMS_CARD_PLANNER = card(
  "79192", "advanced-manufacturing-planning-specialist", "Advanced Manufacturing Planning Specialist",
  "US-MN-Bloomington", "11/6/2026 3:32 PM", SALARY,
);
export const ICIMS_CARD_TESTER = card(
  "78650", "systems-and-software-tester", "Systems and Software Tester for Crypto and Cross Domain Solutions",
  "US-AZ-Scottsdale", "11/5/2026 5:35 PM",
);

export function icimsCard(id: string, title = `Engineer ${id}`): string {
  return card(id, `engineer-${id}`, title, "US-VA-Fairfax", "11/1/2026 9:00 AM");
}

export function icimsDetailPage(overrides: Record<string, unknown> = {}): string {
  const posting = {
    hiringOrganization: { "@type": "Organization", name: "General Dynamics Mission Systems, Inc" },
    validThrough: "2099-11-06T04:00:00.000Z",
    jobLocation: [{
      address: {
        addressCountry: "US", "@type": "PostalAddress", postalCode: "55438",
        addressLocality: "Bloomington", addressRegion: "MN", postOfficeBoxNumber: "UNAVAILABLE",
      },
      "@type": "Place",
    }],
    employmentType: "FULL_TIME",
    "@type": "JobPosting",
    description: "<h2>Basic Qualifications </h2>\n<p>Bachelor’s degree or equivalent plus a minimum of 5 years of relevant experience.</p>",
    datePosted: "2026-11-06T05:00:00.000Z",
    title: "Advanced Manufacturing Planning Specialist",
    "@context": "http://schema.org",
    url: `https://${ICIMS_HOST}/jobs/79192/advanced-manufacturing-planning-specialist/job`,
    ...overrides,
  };
  return `<!DOCTYPE html><html><head><title>Advanced Manufacturing Planning Specialist in Bloomington, Minnesota</title>
<script type="application/ld+json">${JSON.stringify(posting)}</script></head>
<body><div class="iCIMS_JobContent">...</div></body></html>`;
}

export const ICIMS_MISSING_PAGE = `<!DOCTYPE html><html><body>
<div class="iCIMS_Message">Error: The requested job could not be found.</div>
<div>Error: The job that you were looking for either does not exist or is no longer open.</div>
<div>Here are our current career opportunities.</div></body></html>`;
