/**
 * Trimmed from the live ZF Group SuccessFactors RMK career site (jobs.zf.com)
 * and BMW Group's Career Site Builder search API (jobs.bmwgroup.com),
 * November 2026. Markup structure and field names are as served; the three
 * responsive copies of each tile are kept because the parser must not count
 * them as three postings.
 */

export const SF_HOST = "jobs.zf.com";

function titleCopy(id: string, path: string, title: string): string {
  return `<div class="tiletitle">
            <span class="sr-only">Job Title</span>
            <span style="font-size:16px;" class="col-md-12 section-title title" role="heading" aria-level="2">
                <a class="jobTitle-link fontcolorff57cfa2be7aabdb" data-focus-tile=".job-id-${id}" href="${path}">
                    ${title}
                </a>
            </span>
        </div>`;
}

export function sfTile(id: string, path: string, title: string, sections = ""): string {
  return `
            <li class="job-tile job-id-${id} job-row-index-1 linkhovercolorff57cfa2be7aabdb" data-url="${path}" data-row-index="1" data-focus-tile=".job-id-${id}">
                <div class="job-tile-cell">
                    <div class="row job job-row backgroundcolor72228158">
                        <div class="col-md-12 sub-section sub-section-desktop hidden-xs hidden-sm">
                            <div class="oneline">${titleCopy(id, path, title)}</div>
                            <div class="oneline">${sections}</div>
                        </div>
                        <div class="col-md-12 sub-section sub-section-tablet hidden-xs hidden-md hidden-lg">
                            <div class="oneline">${titleCopy(id, path, title)}</div>
                        </div>
                        <span class="col-md-12 sub-section sub-section-mobile hidden-sm hidden-md hidden-lg">${titleCopy(id, path, title)}</span>
                    </div>
                </div>
            </li>`;
}

export const SF_TILE_MANKATO = sfTile(
  "1445700033", "/job/North-Mankato-Virtual-Career-Conversation-MN-56003/1445700033/", "Virtual Career Conversation",
);

export const SF_TILE_WITH_SECTIONS = sfTile(
  "1445741233", "/job/Farmington-Hills-Project-Manager-III-MI-48331/1445741233/", "Project Manager III",
  `<div class="section-field city"><span class="section-label">City</span>
     <div id="job-1445741233-desktop-section-city-value">Farmington Hills</div></div>
   <div class="section-field state"><div id="job-1445741233-desktop-section-state-value">MI</div></div>
   <div class="section-field date"><div id="job-1445741233-desktop-section-date-value">Nov 6, 2026</div></div>`,
);

export function sfTilesFragment(tiles: string[]): string {
  return `<!DOCTYPE html>\n${tiles.join("\n")}`;
}

export function sfDetailPage(options: { title?: string; country?: string; region?: string; city?: string } = {}): string {
  const { title = "Virtual Career Conversation", country = "US", region = "MN", city = "North Mankato" } = options;
  return `<!DOCTYPE html><html><head><title>${title} Job Details | ZF Group</title></head><body>
<a role="menuitem" href="https://jobs.zf.com/search/?locale=de_DE">Deutsch</a>
<div class="jobDisplayShell" itemscope="itemscope" itemtype="http://schema.org/JobPosting"><span itemprop="jobLocation" itemscope itemtype="http://schema.org/Place"><span itemprop="address" itemscope itemtype="http://schema.org/PostalAddress"><meta itemprop="addressLocality" content="${city}"><meta itemprop="addressRegion" content="${region}"><meta itemprop="postalCode" content="56003"><meta itemprop="addressCountry" content="${country}"></span></span><meta itemprop="datePosted" content="Fri Nov 06 02:01:00 UTC 2026"><meta itemprop="hiringOrganization" content="ZF Group">
  <div class="jobDisplay"><div class="content">
    <h1><span xml:lang="en-US" lang="en-US" itemprop="title" data-careersite-propertyid="title" class="rtltextaligneligible">${title}
    </span></h1>
    <span xml:lang="en-US" lang="en-US" itemprop="description" data-careersite-propertyid="description" class="rtltextaligneligible">
      <span class="jobdescription"><p>Req ID 91924 | North Mankato, MN, United States, ZF Off-Highway Solutions Minnesota Inc.</p>
      <p><span style="font-weight:bold">At ZF you are part of something greater!</span></p>
      <p>The pay range for this role is $72,000 - $90,000 per year.</p></span>
    </span>
    <span data-careersite-propertyid="customfield3">YES</span>
  </div></div>
</div></body></html>`;
}

export const SF_ERROR_PAGE = `<!DOCTYPE html><html><head><title>ZF Jobs</title></head><body>
<ul><li><a role="menuitem" href="https://jobs.zf.com/errorpage/?errortype=Exception&amp;locale=de_DE" lang="de-DE">Deutsch (Deutschland)</a></li>
<li><a role="menuitem" href="https://jobs.zf.com/errorpage/?errortype=Exception&amp;locale=en_US" lang="en-US">English (United States)</a></li></ul>
</body></html>`;

export function csbPage(rows: { id: string; title: string; start?: string; location?: string[] }[], totalJobs: number) {
  return {
    jobSearchResult: rows.map((row) => ({
      response: {
        supportedLocales: ["en_US"],
        unifiedUrlTitle: row.title.replace(/\s+/g, "-"),
        unifiedStandardStart: row.start ?? "7/3/25",
        id: row.id,
        unifiedStandardTitle: row.title,
        urlTitle: row.title.replace(/\s+/g, "-"),
        ...(row.location ? { jobLocationShort: row.location } : {}),
      },
    })),
    totalJobs,
  };
}
