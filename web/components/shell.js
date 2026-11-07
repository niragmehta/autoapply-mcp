import { html, useEffect, useRef } from "../lib/html.js";
import { clock, num } from "../lib/format.js";
import { useNow } from "../lib/hooks.js";
import { navGroups, viewForPath } from "../nav.js";
import { NoticesButton } from "./notifications.js";
import { Icon } from "./ui.js";

/**
 * The frame around every page: a navy rail drawn as a line map (sections
 * are lines, pages are stops, the current page is the lit stop), and on
 * narrow screens a top bar whose Menu opens the same map as a sheet. Work
 * held for the person keeps its yellow count in both.
 */

function runningCount(status) {
  return status?.runs?.active?.filter((run) => run.status === "running").length ?? 0;
}

function Badge({ view, status }) {
  const count = view.badge?.(status) ?? null;
  if (!count) return null;
  return html`<span class=${`stop__count${view.badgeTone === "held" ? " stop__count--held" : ""}`}>
    ${num(count)}<span class="sr-only"> ${view.badgeLabel}</span>
  </span>`;
}

export function NavMap({ path, status, onNavigate }) {
  const current = viewForPath(path)?.id;
  return html`<nav class="map" aria-label="Primary">
    ${navGroups().map(
      (group) => html`<div class="map__group" key=${group.id}>
        <p class="map__label" id=${`nav-${group.id}`}>${group.label}</p>
        <ul class="line" aria-labelledby=${`nav-${group.id}`}>
          ${group.views.map(
            (view) => html`<li key=${view.id}>
              <a class="stop" href=${view.path} aria-current=${current === view.id ? "page" : undefined} onClick=${onNavigate}>
                <span class="stop__dot" aria-hidden="true"></span>
                <span class="stop__label">${view.label}</span>
                <${Badge} view=${view} status=${status} />
              </a>
            </li>`,
          )}
        </ul>
      </div>`,
    )}
  </nav>`;
}

function Brand({ status }) {
  return html`<a class="brand" href="/">
    <span class="brand__name">autoapply</span>
    ${status?.campaign?.name ? html`<span class="brand__campaign">${status.campaign.name}</span>` : null}
  </a>`;
}

function LiveRuns({ status }) {
  const running = runningCount(status);
  if (running === 0) return null;
  return html`<a class="live" href="/runs"><span class="live__dot" aria-hidden="true"></span>${num(running)} running</a>`;
}

function RailFooter({ status, onShortcuts }) {
  const now = useNow(15_000);
  return html`<div class="rail__foot">
    <${LiveRuns} status=${status} />
    <div class="rail__meta">
      <span class="rail__clock" aria-label="Local time">${clock(new Date(now).toISOString())}</span>
      <button type="button" class="rail__keys" onClick=${onShortcuts}><kbd>?</kbd> Shortcuts</button>
    </div>
  </div>`;
}

/** Search everything and the notifications bell, under the brand. */
function RailTools({ onSearch }) {
  return html`<div class="rail__tools">
    <button type="button" class="rail__search" onClick=${onSearch} aria-keyshortcuts="Control+K">
      <${Icon} name="search" /><span>Search</span><kbd>Ctrl K</kbd>
    </button>
    <${NoticesButton} className="bell rail__bell" />
  </div>`;
}

/** The persistent rail at laptop widths and up. */
export function Rail({ path, status, onShortcuts, onSearch }) {
  return html`<header class="rail">
    <${Brand} status=${status} />
    <${RailTools} onSearch=${onSearch} />
    <${NavMap} path=${path} status=${status} />
    <${RailFooter} status=${status} onShortcuts=${onShortcuts} />
  </header>`;
}

/** Narrow screens: brand, search, the bell, the held-for-you count and a Menu button that opens the map. */
export function TopBar({ status, onMenu, onSearch }) {
  const held = status?.applications?.needsHuman ?? 0;
  return html`<header class="topbar">
    <button type="button" class="topbar__menu" onClick=${onMenu} aria-haspopup="dialog">
      <${Icon} name="menu" /> Menu
    </button>
    <${Brand} status=${status} />
    <div class="topbar__end">
      <button type="button" class="topbar__icon" onClick=${onSearch} aria-label="Search everything" title="Search everything"><${Icon} name="search" /></button>
      <${NoticesButton} className="bell topbar__icon" />
      <${LiveRuns} status=${status} />
      ${held > 0 ? html`<a class="plate plate--held topbar__held" href="/needs-human">${num(held)} need you</a>` : null}
    </div>
  </header>`;
}

/** The map as a modal sheet on narrow screens: focus stays inside, Escape or a choice closes it. */
export function MenuSheet({ open, onClose, path, status, onShortcuts }) {
  const dialog = useRef(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);
  const onClick = (event) => {
    // A click on the backdrop lands on the dialog element itself.
    if (event.target === dialog.current) onClose();
  };
  return html`<dialog class="sheet" ref=${dialog} onClose=${onClose} onClick=${onClick} aria-label="Menu">
    <div class="sheet__head">
      <${Brand} status=${status} />
      <button type="button" class="sheet__close" onClick=${onClose} aria-label="Close menu"><${Icon} name="close" /></button>
    </div>
    <${NavMap} path=${path} status=${status} onNavigate=${onClose} />
    <${RailFooter} status=${status} onShortcuts=${() => { onClose(); onShortcuts(); }} />
  </dialog>`;
}
