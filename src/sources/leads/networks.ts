/**
 * VC portfolio job boards whose platform has been confirmed. A network is
 * named by its board host (or URL); only these hosts are contacted, so an
 * arbitrary `site` can never point a request at another server.
 */

export type GetroNetwork = { host: string; name: string; collectionId: string };

/** Getro boards with the collection id their board page publishes. */
export const GETRO_NETWORKS: readonly GetroNetwork[] = [
  { host: "jobs.generalcatalyst.com", name: "General Catalyst", collectionId: "222" },
  { host: "jobs.accel.com", name: "Accel", collectionId: "8672" },
  { host: "jobs.insightpartners.com", name: "Insight Partners", collectionId: "246" },
  { host: "techjobfinder.investottawa.ca", name: "Invest Ottawa", collectionId: "1546" },
  { host: "hv.getro.com", name: "HV Capital", collectionId: "234" },
  { host: "talent.cherry.vc", name: "Cherry Ventures", collectionId: "44081" },
  { host: "careers.atomico.com", name: "Atomico", collectionId: "36986" },
  { host: "jobs.pointnine.com", name: "Point Nine", collectionId: "1680" },
  { host: "jobs.earlybird.com", name: "Earlybird", collectionId: "617" },
  { host: "careers.speedinvest.com", name: "Speedinvest", collectionId: "947" },
];

/** Consider boards; the board id and session are read from the board page itself. */
export const CONSIDER_NETWORKS: readonly { host: string; name: string }[] = [
  { host: "jobs.sequoiacap.com", name: "Sequoia Capital" },
  { host: "jobs.lsvp.com", name: "Lightspeed Venture Partners" },
  { host: "jobs.kleinerperkins.com", name: "Kleiner Perkins" },
  { host: "jobs.bvp.com", name: "Bessemer Venture Partners" },
  { host: "jobs.felicis.com", name: "Felicis" },
  { host: "jobs.founderful.com", name: "Founderful" },
];

/** The lower-cased host of a bare host or URL, or "" when it is neither. */
export function siteHost(site: string): string {
  const value = site.trim().toLowerCase();
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    return url.protocol === "https:" && !url.username && !url.password && !url.port ? url.hostname : "";
  } catch {
    return "";
  }
}
