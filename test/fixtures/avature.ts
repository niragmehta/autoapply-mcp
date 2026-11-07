/**
 * Trimmed from the live Bloomberg Avature portal
 * (bloomberg.avature.net/careers), November 2026. Card and detail markup,
 * class names and the results legend are as served; text is shortened.
 */

export const AVATURE_BOARD = "bloomberg.avature.net/careers";

export function avatureCard(id: string, title: string, location = "New York, New York, United States of America", posted = ""): string {
  const href = `https://bloomberg.avature.net/careers/JobDetail/${title.replace(/[^A-Za-z0-9]+/g, "-")}/${id}`;
  return `<article class="article article--result" id="article--1">
                                <div class="article__header">
                                    <div class="article__header__text">
                                            <h3 class="article__header__text__title title title--04">
                                                <a class="link" href="${href}">
                                                    ${title}
                                                </a>
                                            </h3>
                                            <div class="article__header__text__subtitle">
                                                <span class="list-item-location">${location}</span>
                                                ${posted ? `<span class="list-item-posted">Posted ${posted}</span>` : ""}
                                            </div>
                                    </div>
                                </div>
                                <div class="article__footer">
                                        <a class="button button--primary" href="${href}" tabindex="0">
                                            Apply                                        </a>
                                        <a class="button button--secondary" href="https://bloomberg.avature.net/careers/SaveJob?jobId=${id}" tabindex="0">Save</a>
                                </div>
                            </article>`;
}

export function avatureSearchPage(cards: string[], total = cards.length): string {
  return `<!DOCTYPE html><html><head><meta name="avature.portal.page" content="SearchJobs"/></head><body>
<div class="list-controls__text__legend" aria-label="${total} results">1-${cards.length} of ${total} results</div>
<div class="section__content__results">${cards.join("\n")}</div></body></html>`;
}

export function avatureDetailPage(title = "Senior Software Engineer - Hadoop Infrastructure", location = "New York"): string {
  return `<!DOCTYPE html><html><head><meta name="avature.portal.page" content="JobDetail"/></head><body>
<article class="article article--details " >
    <div class="article__content">
        <div class="article__content__view">
            <div class="article__content__view__field article__content__view__field__value--font">
                <div class="article__content__view__field__value">
                    ${title}
                </div>
            </div>
        </div>
    </div>
</article>
<article class="article article--details">
    <div class="article__content"><div class="article__content__view">
        <div class="article__content__view__field">
            <div class="article__content__view__field__label">Location</div>
            <div class="article__content__view__field__value">${location}</div>
        </div>
        <div class="article__content__view__field">
            <div class="article__content__view__field__label">Ref #</div>
            <div class="article__content__view__field__value">10054847</div>
        </div>
        <div class="article__content__view__field">
            <div class="article__content__view__field__label">Description &amp; Requirements</div>
            <div class="article__content__view__field__value"><div><p>Bloomberg runs on data!</p><p>We'll offer a salary range of $160,000 - $240,000 USD annually.</p></div></div>
        </div>
    </div></div>
</article></body></html>`;
}
