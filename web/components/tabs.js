import { html } from "../lib/html.js";
import { num } from "../lib/format.js";

/**
 * A horizontal tab list for pages with several views of one subject. The
 * page keeps the chosen tab in the URL and renders the panel itself with
 * role="tabpanel", id `${idPrefix}-panel` and aria-labelledby the tab.
 * Arrow keys, Home and End move between tabs.
 */
export function Tabs({ label, tabs, current, onChange, idPrefix }) {
  const move = (event) => {
    const index = tabs.findIndex((tab) => tab.id === current);
    const targets = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: tabs.length - 1 };
    if (!(event.key in targets)) return;
    event.preventDefault();
    const next = tabs[(targets[event.key] + tabs.length) % tabs.length];
    onChange(next.id);
    document.getElementById(`${idPrefix}-tab-${next.id}`)?.focus();
  };
  return html`<div class="tabs" role="tablist" aria-label=${label}>
    ${tabs.map(
      (tab) => html`<button
        type="button"
        role="tab"
        key=${tab.id}
        id=${`${idPrefix}-tab-${tab.id}`}
        aria-selected=${tab.id === current ? "true" : "false"}
        aria-controls=${`${idPrefix}-panel`}
        tabindex=${tab.id === current ? "0" : "-1"}
        onClick=${() => onChange(tab.id)}
        onKeyDown=${move}
      >
        ${tab.label}${tab.count ? html`<span class="tabs__count">${num(tab.count)}</span>` : null}
      </button>`,
    )}
  </div>`;
}

export function TabPanel({ idPrefix, current, children }) {
  return html`<div role="tabpanel" id=${`${idPrefix}-panel`} aria-labelledby=${`${idPrefix}-tab-${current}`} tabindex="0" class="tabpanel">${children}</div>`;
}
