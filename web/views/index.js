import { registerView } from "../nav.js";

/**
 * Every page, grouped as the rail shows them. To add one: write
 * views/<name>.js with a default component, add its API module on the
 * server, and register it here with a group, an order and a free "g" key.
 */

const afterApply = (status) => status?.afterApply ?? null;

/* ---------- Pipeline ---------- */

registerView({ id: "overview", path: "/", label: "Overview", group: "pipeline", order: 10, key: "o", load: () => import("./overview.js") });

registerView({ id: "jobs", path: "/jobs", label: "Jobs", group: "pipeline", order: 20, key: "j", load: () => import("./jobs.js") });

registerView({
  id: "applications",
  path: "/applications",
  label: "Applications",
  group: "pipeline",
  order: 30,
  key: "a",
  load: () => import("./applications.js"),
});

registerView({
  id: "needs-human",
  path: "/needs-human",
  label: "Needs human",
  group: "pipeline",
  order: 40,
  key: "n",
  badge: (status) => status?.applications?.needsHuman ?? null,
  badgeTone: "held",
  badgeLabel: "held for you",
  load: () => import("./needs-human.js"),
});

registerView({
  id: "documents",
  path: "/documents",
  label: "Documents",
  group: "pipeline",
  order: 50,
  key: "d",
  load: () => import("./documents.js"),
});

/* ---------- After applying ---------- */

registerView({
  id: "inbox",
  path: "/inbox",
  label: "Inbox",
  group: "after",
  order: 60,
  key: "i",
  badge: (status) => afterApply(status)?.repliesToReview ?? null,
  badgeLabel: "replies to review",
  load: () => import("./inbox.js"),
});

registerView({
  id: "follow-ups",
  path: "/follow-ups",
  label: "Follow-ups",
  group: "after",
  order: 70,
  key: "f",
  badge: (status) => afterApply(status)?.followUpsDue ?? null,
  badgeLabel: "due",
  load: () => import("./followups.js"),
});

registerView({
  id: "interviews",
  path: "/interviews",
  label: "Interviews and offers",
  group: "after",
  order: 80,
  key: "v",
  badge: (status) => afterApply(status)?.interviewsThisWeek ?? null,
  badgeLabel: "this week",
  load: () => import("./interviews.js"),
});

/* ---------- Insights ---------- */

registerView({ id: "analytics", path: "/analytics", label: "Analytics", group: "insights", order: 90, key: "s", load: () => import("./analytics.js") });

registerView({ id: "reports", path: "/reports", label: "Reports", group: "insights", order: 100, key: "e", load: () => import("./reports.js") });

/* ---------- Sources ---------- */

registerView({ id: "companies", path: "/companies", label: "Companies", group: "sources", order: 110, key: "c", load: () => import("./companies.js") });

registerView({
  id: "leads",
  path: "/leads",
  label: "Leads",
  group: "sources",
  order: 120,
  key: "l",
  badge: (status) => afterApply(status)?.pendingProposals ?? null,
  badgeLabel: "proposals to review",
  load: () => import("./leads.js"),
});

/* ---------- System ---------- */

registerView({ id: "runs", path: "/runs", label: "Runs", group: "system", order: 130, key: "r", load: () => import("./runs.js") });

registerView({ id: "health", path: "/health", label: "Health", group: "system", order: 140, key: "h", load: () => import("./health.js") });

registerView({
  id: "not-found",
  path: "/404",
  label: "Not found",
  order: 999,
  nav: false,
  load: () => import("./not-found.js"),
});
