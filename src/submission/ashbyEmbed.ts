const ASHBY_HOST = "jobs.ashbyhq.com";
const ASHBY_NOT_FOUND = /page you requested was not found/i;
const ASHBY_JOB_PATH = /^\/([^/]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/application)?\/?$/i;

/**
 * Some employers switch off Ashby's hosted job board and embed the same
 * application form on their own careers page. The hosted URL then renders
 * "Page not found" while the posting API still lists the job, so Cursor,
 * Greptile and Turnkey read as closed although their forms were accepting
 * applications. Ashby serves the embeddable form from the same job URL with
 * embed=js, which is what those careers pages load.
 *
 * Returns the embedded form's URL when the page is such a hosted job page,
 * otherwise null.
 */
export function ashbyEmbedFallbackUrl(currentUrl: string, bodyText: string): string | null {
  let url: URL;
  try {
    url = new URL(currentUrl);
  } catch {
    return null;
  }
  if (url.hostname !== ASHBY_HOST || url.searchParams.has("embed")) return null;
  if (!ASHBY_NOT_FOUND.test(bodyText)) return null;
  const job = ASHBY_JOB_PATH.exec(url.pathname);
  if (!job) return null;
  return `https://${ASHBY_HOST}/${job[1]}/${job[2]}/application?embed=js`;
}
