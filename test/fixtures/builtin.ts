/**
 * Trimmed from a live Built In listing page
 * (https://builtin.com/jobs/cybersecurity-it/search/security-engineer, Nov 2026):
 * the schema.org ItemList plus the rendered job-card markup the connector reads.
 * Company names and text are placeholders.
 */

export type BuiltInCard = {
  id: string;
  title: string;
  company: string;
  posted?: string;
  workplace?: string;
  location?: string;
  locations?: string[];
  salary?: string;
};

export function builtInCard(card: BuiltInCard): string {
  const slug = card.title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const tooltip = card.locations
    ? `<span class="font-barlow text-gray-04" data-bs-toggle="tooltip" aria-label="Job locations" data-bs-title="${card.locations.map((place) => `&lt;div&gt;${place}&lt;/div&gt;`).join("")}">${card.locations.length} Locations</span>`
    : "";
  return `<div id="job-card-${card.id}" data-id="job-card" class="job-bounded-responsive"><div id="main" class="row">
    <div class="left-side-tile-item-2"><a href="/company/example" target="_blank" data-id="company-title" data-builtin-track-job-id="${card.id}" class="font-barlow"><span>${card.company}</span></a></div>
    <div class="left-side-tile-item-3"><h2 class="font-barlow"><a href="/job/${slug}/${card.id}" target="_blank" data-id="job-card-title" data-alias="/job/${slug}/${card.id}" data-builtin-track-job-id="${card.id}" class="card-alias-after-overlay text-break">${card.title}</a></h2></div></div>
    <div class="col-12 col-lg-5 bounded-attribute-section">
    ${card.posted ? `<span x-show="!showSavedTag" class="fs-xs fw-bold"><i class="fa-regular fa-clock fs-xs text-gray-03"></i>${card.posted}</span>` : ""}
    ${card.workplace ? `<div class="d-flex"><div class="d-flex"><i class="fa-regular fa-house-building fs-xs text-pretty-blue"></i></div>
      <span class="font-barlow text-gray-04">${card.workplace}</span></div>` : ""}
    <div class="d-flex"><div class="d-flex"><i class="fa-regular fa-location-dot fs-xs text-pretty-blue"></i></div>
      <div>${card.location ? `<span class="font-barlow text-gray-04">${card.location}</span>` : tooltip}</div></div>
    ${card.salary ? `<div class="d-flex"><div class="d-flex"><i class="fa-regular fa-sack-dollar fs-xs text-pretty-blue"></i></div>
      <span class="font-barlow text-gray-04">${card.salary}</span></div>` : ""}
    </div></div>`;
}

export function builtInPage(cards: BuiltInCard[], host = "builtin.com", scriptType = "application/ld&#x2B;json"): string {
  const base = host === "builtin.com" ? "https://builtin.com" : `https://${host}`;
  const graph = {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "CollectionPage", name: "Best Security Engineer Jobs 2026 | Built In", url: `${base}/jobs/cybersecurity-it/search/security-engineer` },
      {
        "@type": "ItemList",
        name: "Top Security Engineer Jobs",
        numberOfItems: cards.length,
        itemListElement: cards.map((card, index) => ({
          "@type": "ListItem",
          position: index + 1,
          name: card.title,
          url: `${base}/job/${card.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}/${card.id}`,
          description: `Summary for ${card.title}.`,
        })),
      },
    ],
  };
  return `<!DOCTYPE html><html><head><title>Security Engineer Jobs</title>
<script type="${scriptType}">${JSON.stringify(graph)}</script></head>
<body><div id="jobs-list"><div id="search-results-top"><div class="d-flex gap-sm flex-column">${cards.map(builtInCard).join("\n")}</div></div></div></body></html>`;
}

export const builtInCards: Record<string, BuiltInCard> = {
  remote: { id: "12113632", title: "Senior Product Security Engineer", company: "Example Pay", posted: "27 Minutes Ago", workplace: "Remote", location: "Canada", salary: "153K-213K Annually" },
  multi: { id: "11916676", title: "Product Security Engineer II", company: "Example Cloud", posted: "Reposted 3 Days Ago", workplace: "Hybrid", locations: ["San Francisco, CA, USA", "New York, NY, USA"], salary: "60-80 Hourly" },
  bare: { id: "11534452", title: "Security Engineer &amp; Analyst", company: "Example &amp; Sons", posted: "30+ Days Ago" },
};
