import { render } from "preact";
import { api } from "./api.js";
import { NoticesProvider, NoticesTray } from "./components/notifications.js";
import { SearchPalette } from "./components/palette.js";
import { MenuSheet, Rail, TopBar } from "./components/shell.js";
import { Toaster } from "./components/toaster.js";
import { html, useCallback, useEffect, useRef, useState } from "./lib/html.js";
import { useResource } from "./lib/hooks.js";
import { navigate, useLocation } from "./lib/router.js";
import { MetaContext, StatusContext } from "./lib/store.js";
import { navGroups, viewForKey, viewForPath } from "./nav.js";
import "./views/index.js";

/** The shell: the line-map rail (a top bar and menu sheet on narrow screens), the routed view, toasts and shortcuts. */

const STATUS_POLL_MS = 15_000;
const loaded = new Map();

function useView(path) {
  const view = viewForPath(path) ?? viewForPath("/404");
  const [component, setComponent] = useState(() => loaded.get(view.id) ?? null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let alive = true;
    setError(null);
    if (loaded.has(view.id)) {
      setComponent(() => loaded.get(view.id));
      return undefined;
    }
    setComponent(null);
    view
      .load()
      .then((module) => {
        loaded.set(view.id, module.default);
        if (alive) setComponent(() => module.default);
      })
      .catch((failure) => alive && setError(failure));
    return () => {
      alive = false;
    };
  }, [view.id]);
  return { view, component, error };
}

function ShortcutsDialog({ open, onClose }) {
  const dialog = useRef(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);
  return html`<dialog class="dialog" ref=${dialog} onClose=${onClose} aria-labelledby="shortcuts-title">
    <div class="dialog__body">
      <h2 id="shortcuts-title">Keyboard shortcuts</h2>
      <div class="keys-groups">
        ${navGroups().map(
          (group) => html`<section key=${group.id} aria-labelledby=${`keys-${group.id}`}>
            <h3 id=${`keys-${group.id}`} class="keys__group">${group.label}</h3>
            <dl class="keys">
              ${group.views.filter((view) => view.key).map((view) => html`<dt><kbd>g</kbd> <kbd>${view.key}</kbd></dt><dd>${view.label}</dd>`)}
            </dl>
          </section>`,
        )}
        <section aria-labelledby="keys-page">
          <h3 id="keys-page" class="keys__group">On a page</h3>
          <dl class="keys">
            <dt><kbd>Ctrl</kbd> <kbd>K</kbd></dt><dd>Search everything</dd>
            <dt><kbd>/</kbd></dt><dd>Search or filter this page (everything, where a page has no search)</dd>
            <dt><kbd>j</kbd> <kbd>k</kbd></dt><dd>Next or previous row in a table</dd>
            <dt><kbd>Enter</kbd></dt><dd>Open the focused row</dd>
            <dt><kbd>Esc</kbd></dt><dd>Close the detail panel</dd>
            <dt><kbd>?</kbd></dt><dd>Show this list</dd>
          </dl>
        </section>
      </div>
      <div><button type="button" class="btn" onClick=${onClose}>Close</button></div>
    </div>
  </dialog>`;
}

function isTyping(target) {
  return target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}

function useShortcuts(openHelp, openSearch) {
  // Survives re-renders between the two keys of a "g x" chord.
  const pendingG = useRef(0);
  useEffect(() => {
    const onKey = (event) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openSearch();
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
      if (event.key === "?") {
        event.preventDefault();
        openHelp();
        return;
      }
      if (event.key === "/") {
        const search = document.querySelector("main [data-search]");
        event.preventDefault();
        if (search instanceof HTMLElement) search.focus();
        else openSearch();
        return;
      }
      if (event.key === "g") {
        pendingG.current = Date.now();
        return;
      }
      if (pendingG.current && Date.now() - pendingG.current < 1500) {
        pendingG.current = 0;
        const view = viewForKey(event.key);
        if (view) {
          event.preventDefault();
          navigate(view.path);
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [openHelp, openSearch]);
}

function SignedOut() {
  return html`<main id="main" class="signed-out" tabindex="-1">
    <div class="panel">
      <h1>Sign in from the terminal</h1>
      <p>This dashboard only answers requests carrying its per-start token. Open the link that <code>npm run dashboard</code> printed in its terminal; it changes every time the dashboard starts.</p>
    </div>
  </main>`;
}

function App() {
  const location = useLocation();
  const [signedOut, setSignedOut] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const status = useResource(() => api.get("/api/status"), [], { interval: STATUS_POLL_MS });
  const meta = useResource(() => api.get("/api/meta"), []);
  const { view, component: View, error } = useView(location.path);
  const main = useRef(null);
  const firstRender = useRef(true);
  const openHelp = useCallback(() => setHelpOpen(true), []);
  const openSearch = useCallback(() => setSearchOpen(true), []);

  useShortcuts(openHelp, openSearch);

  useEffect(() => {
    const onSignedOut = () => setSignedOut(true);
    window.addEventListener("autoapply:signed-out", onSignedOut);
    return () => window.removeEventListener("autoapply:signed-out", onSignedOut);
  }, []);

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    setMenuOpen(false);
    main.current?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [location.path]);

  if (signedOut) return html`<${SignedOut} />`;

  return html`<${StatusContext.Provider} value=${status}>
    <${MetaContext.Provider} value=${meta}>
    <${NoticesProvider}>
      <a class="skip" href="#main">Skip to content</a>
      <div class="shell">
        <${Rail} path=${location.path} status=${status.data} onShortcuts=${openHelp} onSearch=${openSearch} />
        <div class="shell__body">
          <${TopBar} status=${status.data} onMenu=${() => setMenuOpen(true)} onSearch=${openSearch} />
          <main id="main" tabindex="-1" ref=${main}>
            ${error
              ? html`<div class="notice notice--bad" role="alert">Could not load this page: ${error.message}</div>`
              : View
                ? html`<${View} key=${view.id} query=${location.query} path=${location.path} />`
                : html`<div class="stack" aria-busy="true"><span class="skeleton" style=${{ width: "12rem", height: "1.5rem" }}></span></div>`}
          </main>
        </div>
      </div>
      <${MenuSheet} open=${menuOpen} onClose=${() => setMenuOpen(false)} path=${location.path} status=${status.data} onShortcuts=${openHelp} />
      <${NoticesTray} />
      <${SearchPalette} open=${searchOpen} onClose=${() => setSearchOpen(false)} />
      <${Toaster} />
      <${ShortcutsDialog} open=${helpOpen} onClose=${() => setHelpOpen(false)} />
    </${NoticesProvider}>
    </${MetaContext.Provider}>
  </${StatusContext.Provider}>`;
}

render(html`<${App} />`, document.getElementById("app"));
