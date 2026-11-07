/**
 * Trimmed from the live Job Bank Atom feed
 * (https://www.jobbank.gc.ca/jobsearch/feed/jobSearchRSSfeed?searchstring=software+developer, Nov 2026).
 * Employer names and numbers are placeholders.
 */

export type JobBankEntry = { posting: string; number: string; location: string; employer: string; salary: string; updated?: string };

export function jobBankEntry(entry: JobBankEntry): string {
  return `
\t<entry>
\t\t<title type="html"><![CDATA[software developer]]></title>
\t\t<link rel="alternate" type="text/html" href="https://www.jobbank.gc.ca/jobsearch/jobposting/${entry.posting}"/>
\t\t<id>https://www.jobbank.gc.ca/jobsearch/jobSearchRSSfeed?id=${entry.number}</id>
\t\t<updated>${entry.updated ?? "2026-11-06T14:00:00Z"}</updated>
\t\t<summary type="html"><![CDATA[<strong>Job number:</strong> ${entry.number}<br /><strong>Location:</strong> ${entry.location}  <br /><strong>Employer:</strong> ${entry.employer}<br /><strong>Salary:</strong> ${entry.salary}]]></summary>
\t</entry>`;
}

export function jobBankFeed(entries: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en">
\t<title><![CDATA[software developer - Job Bank]]></title>
\t<id>https://www.jobbank.gc.ca/jobsearch/jobSearchRSSfeed</id>
\t<link rel="self" type="application/atom+xml" href="https://www.jobbank.gc.ca/jobsearch/jobSearchRSSfeed?searchstring=software+developer&amp;locationstring=&amp;page=1"/>
\t<updated>2026-11-06T20:02:18Z</updated>
\t<author><name>Job Bank</name></author>
\t<logo>/images/sig_eng.gif</logo>${entries.join("")}
</feed>`;
}

export const jobBankEntries = {
  annual: { posting: "50678571", number: "10319685093", location: "Toronto (ON)", employer: "Example Marketing", salary: "$55,000.00 to $65,000.00 annually" },
  negotiated: { posting: "50678526", number: "3714518", location: "Vancouver (BC)", employer: "Example Networks", salary: "$96,000.00 to $100,000.00 annually (to be negotiated)", updated: "2026-11-06T13:23:00Z" },
  hourly: { posting: "50678218", number: "117243", location: "Victoria (BC)", employer: "Example District", salary: "$55.31 hourly", updated: "2026-11-06T13:00:00Z" },
} satisfies Record<string, JobBankEntry>;
