/**
 * Trimmed from a live We Work Remotely category feed
 * (https://weworkremotely.com/categories/remote-devops-sysadmin-jobs.rss, Nov 2026).
 * Company names and text are placeholders.
 */

export type WwrItem = {
  title: string;
  region?: string;
  country?: string;
  skills?: string;
  category?: string;
  pubDate?: string;
  expiresAt?: string;
  link?: string;
};

export function wwrItem(item: WwrItem): string {
  const link = item.link ?? "https://weworkremotely.com/remote-jobs/example-co-site-reliability-engineer";
  return `
    <item>
      <title>${item.title}</title>
      <region>${item.region ?? "Anywhere in the World"}</region>
      <country>${item.country ?? ""}</country>
      <state></state>
      <skills>${item.skills ?? ""}</skills>
      <category>${item.category ?? "DevOps and Sysadmin"}</category>
      <type>Full-Time</type>
      <description>

&lt;p&gt;
  &lt;strong&gt;Headquarters:&lt;/strong&gt; United States, Remote
&lt;/p&gt;
&lt;p&gt;Run our platform.&amp;nbsp;&lt;/p&gt;
      </description>
      <pubDate>${item.pubDate ?? "Mon, 02 Nov 2026 07:31:12 +0000"}</pubDate>
      <expires_at>${item.expiresAt ?? "Wed, 02 Dec 2099 07:31:12 +0000"}</expires_at>
      <guid>${link}</guid>
      <link>${link}</link>
    </item>`;
}

export function wwrFeed(items: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:media="http://search.yahoo.com/mrss">
  <channel>
    <title>We Work Remotely: DevOps and Sysadmin Jobs</title>
    <link>https://weworkremotely.com/categories/remote-devops-sysadmin-jobs.rss</link>
    <description>We Work Remotely: DevOps and Sysadmin Jobs</description>
    <language>en-US</language>
    <ttl>60</ttl>${items.join("")}
  </channel>
</rss>`;
}
