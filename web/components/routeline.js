import { html } from "../lib/html.js";
import { num } from "../lib/format.js";
import { Plate } from "./ui.js";

/**
 * The pipeline as a transit line: each station counts what reached it, and
 * notes under a station say what is held there. A station with work waiting
 * on the person gets a signal-yellow stop.
 *
 * stations: [{ id, label, count, href?, held?, notes: [{ text, tone?, href? } | string] }]
 */
export function RouteLine({ stations, label = "Campaign pipeline" }) {
  return html`<ol class="route" style=${{ "--stops": stations.length }} aria-label=${label}>
    ${stations.map(
      (station) => html`<li class=${`route__stop${station.held ? " route__stop--held" : ""}`} key=${station.id}>
        ${station.href
          ? html`<a class="route__count" href=${station.href} aria-label=${`${station.label}: ${num(station.count)}`}>${num(station.count)}</a>`
          : html`<span class="route__count">${num(station.count)}</span>`}
        <span class="route__dot" aria-hidden="true"></span>
        <span class="route__label">${station.label}</span>
        ${station.notes?.length
          ? html`<span class="route__notes">
              ${station.notes.map((note) =>
                typeof note === "string"
                  ? html`<span>${note}</span>`
                  : html`<${Plate} text=${note.text} tone=${note.tone ?? "muted"} href=${note.href} />`,
              )}
            </span>`
          : null}
      </li>`,
    )}
  </ol>`;
}
