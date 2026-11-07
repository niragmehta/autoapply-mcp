import { api } from "../api.js";
import { ago, when } from "../lib/format.js";
import { createContext, html, useCallback, useContext, useEffect, useMemo, useRef, useState } from "../lib/html.js";
import { useResource } from "../lib/hooks.js";
import { toast } from "../lib/store.js";
import { Icon } from "./ui.js";

/**
 * The notifications tray: interviews within 48 hours, offer deadlines within
 * a week, follow-ups due and runs that finished or failed. A live stream says
 * when any run ends (with a toast); what you have opened the tray on counts
 * as seen, remembered in this browser only.
 */

const SEEN_KEY = "autoapply.notices.seen";
const POLL_MS = 60_000;
const TRAY_ID = "notices-tray";

const KIND_TEXT = { interview: "Interview", offer: "Offer", "follow-up": "Follow-up", run: "Run" };

/** Runs say how long ago; interviews say when; date-only deadlines are already in the title. */
function timeOf(item) {
  if (!item.at || /^\d{4}-\d{2}-\d{2}$/.test(item.at)) return "";
  return item.kind === "run" ? ago(item.at) : when(item.at);
}

function readSeen() {
  try {
    const list = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]");
    return new Set(Array.isArray(list) ? list : []);
  } catch {
    return new Set();
  }
}

function writeSeen(ids) {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify([...ids].slice(-300)));
  } catch {
    // Private windows may refuse storage; the tray still works, it just forgets.
  }
}

const NoticesContext = createContext({ items: [], unseen: 0, error: null, loading: true, markSeen: () => {}, reload: () => {} });

export function useNotices() {
  return useContext(NoticesContext);
}

export function NoticesProvider({ children }) {
  const notices = useResource(() => api.get("/api/notifications"), [], { interval: POLL_MS });
  const [seen, setSeen] = useState(readSeen);
  const reload = notices.reload;

  useEffect(() => {
    if (typeof EventSource === "undefined") return undefined;
    const source = new EventSource("/api/notifications/stream");
    source.addEventListener("run", (event) => {
      try {
        const run = JSON.parse(event.data);
        const failed = run.status === "failed" || run.status === "interrupted";
        toast(run.notice?.title ?? `Run ${run.status}`, { tone: failed ? "bad" : "ok", href: run.href, linkText: "Open run" });
      } catch {
        // A malformed frame only costs the toast; the tray reloads below.
      }
      void reload({ quiet: true });
    });
    return () => source.close();
  }, [reload]);

  const items = notices.data?.items ?? [];
  const markSeen = useCallback(() => {
    setSeen((previous) => {
      const next = new Set([...previous, ...items.map((item) => item.id)]);
      writeSeen(next);
      return next;
    });
  }, [items]);
  const value = useMemo(
    () => ({ items, unseen: items.filter((item) => !seen.has(item.id)).length, seen, error: notices.error, loading: notices.loading, markSeen, reload }),
    [items, seen, notices.error, notices.loading, markSeen, reload],
  );
  return html`<${NoticesContext.Provider} value=${value}>${children}</${NoticesContext.Provider}>`;
}

/** The bell. It opens the one tray, wherever it sits (the rail, or the top bar on narrow screens). */
export function NoticesButton({ className = "bell" }) {
  const { unseen, items } = useNotices();
  const text = unseen ? `Notifications, ${unseen} new` : items.length ? `Notifications, ${items.length}` : "Notifications";
  return html`<button type="button" class=${className} popovertarget=${TRAY_ID} aria-label=${text} title=${text}>
    <${Icon} name="bell" />
    ${unseen ? html`<span class="bell__count" aria-hidden="true">${unseen > 9 ? "9+" : unseen}</span>` : null}
  </button>`;
}

function Item({ item, fresh, onOpen }) {
  return html`<li class=${`notice-item notice-item--${item.tone}${fresh ? " notice-item--fresh" : ""}`}>
    <a href=${item.href} onClick=${onOpen}>
      <span class="notice-item__kind">${KIND_TEXT[item.kind] ?? item.kind}${fresh ? html`<span class="sr-only">, new</span>` : null}</span>
      <span class="notice-item__title">${item.title}</span>
      <span class="notice-item__detail">${item.detail}${timeOf(item) ? html` <span class="notice-item__when">${timeOf(item)}</span>` : null}</span>
    </a>
  </li>`;
}

export function NoticesTray() {
  const { items, seen, error, loading, markSeen, reload } = useNotices();
  const tray = useRef(null);
  const [openSeen, setOpenSeen] = useState(null);
  useEffect(() => {
    const element = tray.current;
    if (!element) return undefined;
    const onToggle = (event) => {
      if (event.newState === "open") {
        // Keep what was new visible as new while the tray is open, then count it as seen.
        setOpenSeen(new Set(seen));
        void reload({ quiet: true });
        markSeen();
      }
    };
    element.addEventListener("toggle", onToggle);
    return () => element.removeEventListener("toggle", onToggle);
  }, [seen, markSeen, reload]);
  const close = () => tray.current?.hidePopover?.();
  const upcoming = items.filter((item) => item.kind !== "run");
  const runs = items.filter((item) => item.kind === "run");
  const fresh = (item) => openSeen !== null && !openSeen.has(item.id);
  return html`<div id=${TRAY_ID} class="tray" popover="auto" ref=${tray} role="dialog" aria-labelledby="tray-title">
    <div class="tray__head">
      <h2 id="tray-title">Notifications</h2>
      <button type="button" class="icon-btn" aria-label="Close notifications" onClick=${close}><${Icon} name="close" /></button>
    </div>
    ${error ? html`<p class="tray__empty">Could not load notifications: ${error.message}</p>` : null}
    ${!error && loading && !items.length ? html`<p class="tray__empty">Loading...</p>` : null}
    ${!error && !loading && !items.length ? html`<p class="tray__empty">Nothing coming up: no interviews in the next two days, no offer deadlines this week, no follow-ups due and no runs ended today.</p>` : null}
    ${upcoming.length
      ? html`<section aria-labelledby="tray-soon"><h3 class="tray__group" id="tray-soon">Coming up</h3><ul class="tray__list">${upcoming.map((item) => html`<${Item} key=${item.id} item=${item} fresh=${fresh(item)} onOpen=${close} />`)}</ul></section>`
      : null}
    ${runs.length
      ? html`<section aria-labelledby="tray-runs"><h3 class="tray__group" id="tray-runs">Runs today</h3><ul class="tray__list">${runs.map((item) => html`<${Item} key=${item.id} item=${item} fresh=${fresh(item)} onOpen=${close} />`)}</ul></section>`
      : null}
  </div>`;
}
