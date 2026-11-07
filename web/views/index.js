import { registerView } from "../nav.js";

/**
 * Every page, grouped as the rail shows them. To add one: write
 * views/<name>.js with a default component, add its API module on the
 * server, and register it here with a group, an order and a free "g" key.
 */

const afterApply = (status) => status?.afterApply ?? null;

/* ---------- Pipeline: from a posting to a reply ---------- */

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

registerView({
  id: "inbox",
  path: "/inbox",
  label: "Inbox",
  group: "pipeline",
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
  group: "pipeline",
  order: 70,
  key: "f",
  badge: (status) => afterApply(status)?.followUpsDue ?? null,
  badgeLabel: "due",
  load: () => import("./followups.js"),
});

/* ---------- Network: people, companies and where roles come from ---------- */

registerView({ id: "contacts", path: "/contacts", label: "Contacts", group: "network", order: 80, key: "p", load: () => import("./contacts.js") });

registerView({ id: "research", path: "/research", label: "Company research", group: "network", order: 82, key: "t", load: () => import("./research.js") });

registerView({ id: "companies", path: "/companies", label: "Companies", group: "network", order: 84, key: "c", load: () => import("./companies.js") });

registerView({
  id: "leads",
  path: "/leads",
  label: "Leads",
  group: "network",
  order: 86,
  key: "l",
  badge: (status) => afterApply(status)?.pendingProposals ?? null,
  badgeLabel: "proposals to review",
  load: () => import("./leads.js"),
});

/* ---------- Interviews and offers ---------- */

registerView({
  id: "interviews",
  path: "/interviews",
  label: "Interviews",
  group: "career",
  order: 90,
  key: "v",
  badge: (status) => afterApply(status)?.interviewsThisWeek ?? null,
  badgeLabel: "this week",
  load: () => import("./interviews.js"),
});

registerView({ id: "prep", path: "/prep", label: "Prep sheet", order: 91, nav: false, load: () => import("./prep.js") });

registerView({ id: "stories", path: "/stories", label: "Story bank", group: "career", order: 92, key: "b", load: () => import("./stories.js") });

registerView({
  id: "offers",
  path: "/offers",
  label: "Offers",
  group: "career",
  order: 94,
  key: "m",
  badge: (status) => afterApply(status)?.activeOffers ?? null,
  badgeLabel: "in play",
  load: () => import("./offers.js"),
});

/* ---------- Insights ---------- */

registerView({ id: "analytics", path: "/analytics", label: "Analytics", group: "insights", order: 100, key: "s", load: () => import("./analytics.js") });

registerView({ id: "reports", path: "/reports", label: "Reports", group: "insights", order: 110, key: "e", load: () => import("./reports.js") });

/* ---------- Settings: what drives the rest ---------- */

registerView({ id: "settings", path: "/settings", label: "Settings", group: "settings", order: 120, key: ",", load: () => import("./settings.js") });

registerView({ id: "runs", path: "/runs", label: "Runs", group: "settings", order: 130, key: "r", load: () => import("./runs.js") });

registerView({ id: "health", path: "/health", label: "Health", group: "settings", order: 140, key: "h", load: () => import("./health.js") });

registerView({
  id: "not-found",
  path: "/404",
  label: "Not found",
  order: 999,
  nav: false,
  load: () => import("./not-found.js"),
});
