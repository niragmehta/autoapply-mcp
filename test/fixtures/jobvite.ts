/**
 * Trimmed from the live Tyler Technologies Jobvite board
 * (jobs.jobvite.com/tylertech) and its company XML feed
 * (app.jobvite.com/CompanyJobs/Xml.aspx), November 2026. Markup, tag names and
 * value formats are as served; descriptions are shortened.
 */

export const JOBVITE_SLUG = "tylertech";
export const JOBVITE_COMPANY_ID = "q6NaVfwI";

function row(id: string, title: string, location: string): string {
  const place = /^\d+ Locations$/.test(location)
    ? `<div class="jv-meta">\n            ${location}\n        </div>`
    : `\n            ${location.replace(", ", ",\n            ")}\n        `;
  return `
                <tr>
            <td class="jv-job-list-name">
                <a href="/tylertech/job/${id}">${title}</a>
            </td>
            <td class="jv-job-list-location">
${place}
            </td>
        </tr>`;
}

export function jobviteListPage(rows: [string, string, string][], companyId: string | null = JOBVITE_COMPANY_ID): string {
  return `<!DOCTYPE html><html><head><title>Careers | Tyler Technologies</title></head><body>
<h3 class="h2">Administration</h3>
<table class="jv-job-list"><thead><tr><th scope="col" class="jv-cws-sr-only">Job listing</th><th scope="col" class="jv-cws-sr-only">Job location</th></tr></thead>
<tbody>${rows.map(([id, title, location]) => row(id, title, location)).join("")}
</tbody></table>
<script>
  var jvConfig = {
            numberFormat: "##,###,###,###,###.####",
            ${companyId ? `companyEId: '${companyId}',` : ""}
            baseUrl: '/tylertech',
  };
</script></body></html>`;
}

export const JOBVITE_ROWS: [string, string, string][] = [
  ["odUyAfwZ", "Professional Service Manager", "Vancouver, BC"],
  ["odCGAfwP", "Receptionist", "2 Locations"],
];

function feedJob(id: string, title: string, location: string, extra = ""): string {
  return `<job><id>${id}</id><externalJobPostingId>${id}-CNLcXfwr</externalJobPostingId><title>${title}</title><requisitionid>2026-9427</requisitionid><category>Professional Services</category><jobtype>Full-Time</jobtype><location>${location}</location><date>8/26/2026</date><detail-url><![CDATA[http://app.jobvite.com/CompanyJobs/Job.aspx?c=q6NaVfwI&j=${id}]]></detail-url><apply-url><![CDATA[http://app.jobvite.com/CompanyJobs/Careers.aspx?c=q6NaVfwI&j=${id}&k=Apply]]></apply-url><description>&lt;p&gt;The Professional Services Manager leads the Implementation &amp;amp; Data Conversion teams.&lt;/p&gt;</description><briefdescription></briefdescription>${extra}<workflow>General</workflow></job>`;
}

const SALARY = "<salarycurrency><![CDATA[Canadian Dollar (CAD $)]]></salarycurrency><salaryfrequency>Annually</salaryfrequency><salarymin>110000.00</salarymin><salarymax>140000.00</salarymax>";

export const JOBVITE_FEED = `<?xml version="1.0" encoding="utf-8"?><result>${[
  feedJob("odUyAfwZ", "Professional Service Manager", "Vancouver, BC, Canada", SALARY),
  feedJob("odCGAfwP", "Receptionist", "Plano, TX, United States"),
  feedJob("odCGAfwP", "Receptionist", "Ahmedabad, Gujarat, India"),
  feedJob("bad id!", "Broken", "Nowhere"),
].join("")}</result>`;

export function jobviteDetailPage(title = "Receptionist", place = "Plano,\n            Texas", notes = ""): string {
  return `<!DOCTYPE html><html><body><div class="jv-wrapper">
            <h2 class="jv-header">
                ${title}

    </h2>
                <p class="jv-job-detail-meta">
                Administration<span class='jv-inline-separator'></span>
            ${place}
            ${notes}
        </p>
        <hr />
        <div class="jv-job-detail-description" ng-non-bindable>
            <h3>Description</h3>
            <p ng-non-bindable>
                <p><span style="color: rgb(51,51,51);">The Receptionist is the first point of contact for clients.</span></p>
            </p>
        </div>
</div></body></html>`;
}

export const JOBVITE_MISSING_PAGE = `<!DOCTYPE html><html><body>
    <div class="jv-page-error">
        <i class="jv-icon-warning"></i>
        <p class="jv-page-error-header">
            The job listing no longer exists.
        </p>
    </div>
    <article class="jv-page-body" role="main"><h2>Open Positions</h2></article></body></html>`;
