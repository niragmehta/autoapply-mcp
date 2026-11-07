import { html, useRef } from "../lib/html.js";
import { num } from "../lib/format.js";
import { Button, Icon } from "./ui.js";

/**
 * The timetable: a ruled table with sortable headers, keyboard row navigation
 * (j/k or arrows, Enter to open) and real loading and empty states.
 *
 * columns: [{ key, label, sort?, numeric?, render(row) }]
 */
export function DataTable({ caption, columns, rows, rowKey, sort, dir, onSort, onOpen, selectedKey, loading, empty }) {
  const body = useRef(null);

  const focusRow = (from, step) => {
    const all = [...(body.current?.querySelectorAll("tr.is-row") ?? [])];
    const index = all.indexOf(from);
    const next = all[Math.max(0, Math.min(all.length - 1, index + step))];
    next?.focus();
  };

  const onKeyDown = (event, row) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpen?.(row, event.currentTarget);
    } else if (event.key === "ArrowDown" || event.key === "j") {
      event.preventDefault();
      focusRow(event.currentTarget, 1);
    } else if (event.key === "ArrowUp" || event.key === "k") {
      event.preventDefault();
      focusRow(event.currentTarget, -1);
    }
  };

  const header = (column) => {
    if (!column.sort || !onSort) return column.label;
    const active = sort === column.sort;
    const nextDir = active && dir === "desc" ? "asc" : "desc";
    return html`<button type="button" class="sort" data-active=${active ? "true" : "false"} onClick=${() => onSort(column.sort, active ? nextDir : column.defaultDir ?? "desc")}>
      ${column.label}${active ? html`<${Icon} name=${dir === "asc" ? "arrowUp" : "arrowDown"} />` : null}
    </button>`;
  };

  const ariaSort = (column) => {
    if (!column.sort || sort !== column.sort) return undefined;
    return dir === "asc" ? "ascending" : "descending";
  };

  let content;
  if (loading && (!rows || rows.length === 0)) {
    content = Array.from(
      { length: 6 },
      (_, index) => html`<tr key=${`skeleton-${index}`} aria-hidden="true">
        ${columns.map((column) => html`<td><span class="skeleton" style=${{ width: column.numeric ? "2.5rem" : "70%" }}></span></td>`)}
      </tr>`,
    );
  } else if (!rows || rows.length === 0) {
    content = html`<tr><td colspan=${columns.length}>${empty}</td></tr>`;
  } else {
    content = rows.map((row) => {
      const key = rowKey(row);
      return html`<tr
        key=${key}
        class=${onOpen ? "is-row" : undefined}
        tabindex=${onOpen ? "0" : undefined}
        aria-selected=${selectedKey === key ? "true" : undefined}
        onClick=${onOpen ? (event) => {
          if (event.target instanceof Element && event.target.closest("a, button, input, select, label")) return;
          onOpen(row, event.currentTarget);
        } : undefined}
        onKeyDown=${onOpen ? (event) => onKeyDown(event, row) : undefined}
      >
        ${columns.map((column) => html`<td class=${column.numeric ? "num" : undefined}>${column.render(row)}</td>`)}
      </tr>`;
    });
  }

  return html`<div class="table-wrap">
    <table class="table" aria-busy=${loading ? "true" : "false"}>
      <caption class="sr-only">${caption}</caption>
      <thead>
        <tr>
          ${columns.map((column) => html`<th scope="col" class=${column.numeric ? "num" : undefined} aria-sort=${ariaSort(column)}>${header(column)}</th>`)}
        </tr>
      </thead>
      <tbody ref=${body}>${content}</tbody>
    </table>
  </div>`;
}

export function Pager({ page, pageSize, total, onPage }) {
  if (!total) return null;
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(total, page * pageSize);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return html`<nav class="pager" aria-label="Pages">
    <span>${num(first)}-${num(last)} of ${num(total)}</span>
    <span class="row">
      <${Button} small disabled=${page <= 1} onClick=${() => onPage(page - 1)}>Previous</${Button}>
      <span>Page ${num(page)} of ${num(pages)}</span>
      <${Button} small disabled=${page >= pages} onClick=${() => onPage(page + 1)}>Next</${Button}>
    </span>
  </nav>`;
}
