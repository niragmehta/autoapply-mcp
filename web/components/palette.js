import { api } from "../api.js";
import { html, useEffect, useMemo, useRef, useState } from "../lib/html.js";
import { useDebounced } from "../lib/hooks.js";
import { navigate } from "../lib/router.js";
import { navViews } from "../nav.js";
import { Icon } from "./ui.js";

/**
 * Search everything (Ctrl+K, or / on a page without its own search): pages
 * first, then jobs, applications, companies, contacts, stories and research
 * notes as you type. A combobox over a listbox: arrows move, Enter opens,
 * Escape closes. Every result is a link, so it also opens in a new tab.
 */

const MIN_CHARS = 2;

function pageResults(text) {
  const needle = text.trim().toLowerCase();
  const pages = navViews().filter((view) => !needle || view.label.toLowerCase().includes(needle));
  return pages.length ? [{ kind: "pages", label: needle ? "Pages" : "Go to", items: pages.map((view) => ({ id: view.id, title: view.label, sub: view.key ? `g ${view.key}` : "", href: view.path })) }] : [];
}

function Results({ groups, active, listId, onPick, onHover }) {
  let index = -1;
  return html`<div class="palette__results" id=${listId} role="listbox" aria-label="Results">
    ${groups.map(
      (group) => html`<div key=${group.kind} role="group" aria-labelledby=${`${listId}-${group.kind}`}>
        <p class="palette__group" id=${`${listId}-${group.kind}`} role="presentation">${group.label}</p>
        ${group.items.map((item) => {
          index += 1;
          const position = index;
          return html`<a
            key=${`${group.kind}:${item.id}`}
            id=${`${listId}-option-${position}`}
            class="palette__item"
            role="option"
            aria-selected=${position === active ? "true" : "false"}
            href=${item.href}
            tabindex="-1"
            onMouseMove=${() => onHover(position)}
            onClick=${(event) => {
              if (event.ctrlKey || event.metaKey || event.shiftKey) return;
              event.preventDefault();
              onPick(item);
            }}
          >
            <span class="palette__title">${item.title}</span>
            ${item.sub ? html`<span class="palette__sub">${item.sub}</span>` : null}
          </a>`;
        })}
      </div>`,
    )}
  </div>`;
}

export function SearchPalette({ open, onClose }) {
  const dialog = useRef(null);
  const input = useRef(null);
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);
  const [found, setFound] = useState({ q: "", groups: [], error: null, loading: false });
  const settled = useDebounced(text.trim(), 160);
  const listId = "palette-list";

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      setText("");
      setActive(0);
      element.showModal();
      requestAnimationFrame(() => input.current?.focus());
    }
    if (!open && element.open) element.close();
  }, [open]);

  useEffect(() => {
    if (settled.length < MIN_CHARS) {
      setFound({ q: settled, groups: [], error: null, loading: false });
      return undefined;
    }
    let alive = true;
    setFound((previous) => ({ ...previous, loading: true }));
    api
      .get("/api/search", { q: settled })
      .then((result) => alive && setFound({ q: settled, groups: result.groups, error: null, loading: false }))
      .catch((error) => alive && setFound({ q: settled, groups: [], error, loading: false }));
    return () => {
      alive = false;
    };
  }, [settled]);

  const groups = useMemo(() => [...pageResults(text), ...(found.q === settled ? found.groups : [])], [text, found, settled]);
  const items = groups.flatMap((group) => group.items);
  useEffect(() => setActive(0), [settled]);

  const pick = (item) => {
    onClose();
    navigate(item.href);
  };
  const onKeyDown = (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!items.length) return;
      const next = (active + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      setActive(next);
      document.getElementById(`${listId}-option-${next}`)?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter" && items[active]) {
      event.preventDefault();
      pick(items[active]);
    }
  };
  const onBackdrop = (event) => {
    if (event.target === dialog.current) onClose();
  };
  const searching = settled.length >= MIN_CHARS;
  return html`<dialog class="palette" ref=${dialog} onClose=${onClose} onClick=${onBackdrop} aria-label="Search everything">
    <div class="palette__box">
      <div class="palette__field">
        <${Icon} name="search" />
        <input
          ref=${input}
          class="palette__input"
          type="search"
          role="combobox"
          aria-expanded=${items.length ? "true" : "false"}
          aria-controls=${listId}
          aria-autocomplete="list"
          aria-activedescendant=${items.length ? `${listId}-option-${active}` : undefined}
          aria-label="Search jobs, applications, companies, contacts, stories and notes"
          placeholder="Search jobs, applications, companies, contacts, stories, notes"
          value=${text}
          onInput=${(event) => setText(event.currentTarget.value)}
          onKeyDown=${onKeyDown}
        />
        <kbd class="palette__esc">Esc</kbd>
      </div>
      <${Results} groups=${groups} active=${active} listId=${listId} onPick=${pick} onHover=${setActive} />
      <p class="palette__status" role="status" aria-live="polite">
        ${found.error
          ? `Search failed: ${found.error.message}`
          : !searching
            ? text.trim()
              ? "Keep typing to search records too."
              : "Type at least two letters to search records, or pick a page."
            : found.loading && found.q !== settled
              ? "Searching..."
              : `${found.groups.reduce((sum, group) => sum + group.items.length, 0)} record${found.groups.reduce((sum, group) => sum + group.items.length, 0) === 1 ? "" : "s"} for "${settled}".`}
      </p>
    </div>
  </dialog>`;
}
