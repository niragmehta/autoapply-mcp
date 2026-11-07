/**
 * The view registry.
 *
 * Each page is one module under views/ whose default export is its component,
 * registered in views/index.js with a path, a nav label, a group and an
 * order. The rail, the mobile menu, routing and the "g" shortcuts all read
 * this registry, so a new page is one module and one registerView call.
 */

/**
 * Rail sections, in order: the day's work from a posting to a reply, the
 * people and companies around it, interviews and offers, what the numbers
 * say, and the settings that drive it all. A view names its section with
 * `group`.
 */
export const NAV_GROUPS = [
  { id: "pipeline", label: "Pipeline" },
  { id: "network", label: "Network" },
  { id: "career", label: "Interviews and offers" },
  { id: "insights", label: "Insights" },
  { id: "settings", label: "Settings" },
];

const views = [];

/**
 * @param {{
 *   id: string,
 *   path: string,
 *   label: string,
 *   group?: string,
 *   order: number,
 *   load: () => Promise<{ default: Function }>,
 *   key?: string,
 *   badge?: (status: object | undefined) => number | null,
 *   badgeTone?: "held" | "count",
 *   badgeLabel?: string,
 *   nav?: boolean,
 * }} view
 */
export function registerView(view) {
  if (views.some((existing) => existing.id === view.id || existing.path === view.path)) {
    throw new Error(`view ${view.id} (${view.path}) is already registered`);
  }
  if (view.key && views.some((existing) => existing.key === view.key)) {
    throw new Error(`shortcut g ${view.key} is already taken`);
  }
  views.push({ nav: true, badgeTone: "count", badgeLabel: "waiting", ...view });
  views.sort((a, b) => a.order - b.order);
}

export function allViews() {
  return views;
}

export function navViews() {
  return views.filter((view) => view.nav);
}

/** Navigable views grouped by rail section, empty sections left out. */
export function navGroups() {
  return NAV_GROUPS.map((group) => ({ ...group, views: navViews().filter((view) => (view.group ?? "settings") === group.id) })).filter(
    (group) => group.views.length > 0,
  );
}

export function viewForPath(path) {
  const normalized = path.length > 1 ? path.replace(/\/+$/, "") : path;
  return views.find((view) => view.path === normalized) ?? null;
}

export function viewForKey(key) {
  return views.find((view) => view.key === key) ?? null;
}
