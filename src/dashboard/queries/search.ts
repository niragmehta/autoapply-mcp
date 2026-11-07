import type { Workspace } from "../../config/load.js";

/**
 * One search box for the whole app: postings, boards, applications, contacts,
 * stories and research notes, each result carrying a link to the thing
 * itself. Read-only SQL over what the services store; matching is a plain,
 * case-insensitive substring, with LIKE's wildcards taken literally.
 */

export type SearchItem = { id: string; title: string; sub: string; href: string };
export type SearchGroup = { kind: string; label: string; items: SearchItem[] };

type Row = Record<string, unknown>;

const text = (value: unknown) => (value === null || value === undefined ? "" : String(value));
const likeOf = (q: string) => `%${q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
const query = (href: string, params: Record<string, string>) => `${href}?${new URLSearchParams(params).toString()}`;

/** A few words of `body` around the first match, so a result shows why it matched. */
function excerpt(body: string, q: string, width = 90): string {
  const flat = body.replace(/\s+/g, " ").trim();
  const at = flat.toLowerCase().indexOf(q.toLowerCase());
  if (at < 0 || flat.length <= width) return flat.slice(0, width);
  const start = Math.max(0, at - Math.floor(width / 3));
  return `${start > 0 ? "..." : ""}${flat.slice(start, start + width).trim()}${start + width < flat.length ? "..." : ""}`;
}

function jobs(workspace: Workspace, like: string, limit: number): SearchItem[] {
  const rows = workspace.db
    .prepare(
      `SELECT j.id, j.title, j.company_name, e.tier, e.score, e.decision
       FROM jobs j
       LEFT JOIN evaluations e ON e.job_id = j.id
       WHERE NOT EXISTS (SELECT 1 FROM applications a WHERE a.job_id = j.id)
         AND (j.title LIKE ? ESCAPE '\\' OR j.company_name LIKE ? ESCAPE '\\')
       ORDER BY CASE WHEN e.decision = 'accept' THEN 0 ELSE 1 END, e.score DESC, j.last_seen_at DESC
       LIMIT ?`,
    )
    .all(like, like, limit) as Row[];
  return rows.map((row) => ({
    id: text(row.id),
    title: text(row.title),
    sub: [text(row.company_name), row.decision === "accept" && row.tier && row.tier !== "none" ? `tier ${text(row.tier)}` : row.decision ? text(row.decision) : "not evaluated"].filter(Boolean).join(" · "),
    href: query("/jobs", { job: text(row.id) }),
  }));
}

function applications(workspace: Workspace, like: string, q: string, limit: number): SearchItem[] {
  const rows = workspace.db
    .prepare(
      `SELECT a.id, a.status, j.title, j.company_name
       FROM applications a JOIN jobs j ON j.id = a.job_id
       WHERE j.title LIKE ? ESCAPE '\\' OR j.company_name LIKE ? ESCAPE '\\' OR a.id = ?
       ORDER BY a.created_at DESC
       LIMIT ?`,
    )
    .all(like, like, q, limit) as Row[];
  return rows.map((row) => ({
    id: text(row.id),
    title: `${text(row.company_name)}: ${text(row.title)}`,
    sub: text(row.status).replace(/_/g, " "),
    href: query("/applications", { app: text(row.id) }),
  }));
}

function companies(workspace: Workspace, q: string, limit: number): SearchItem[] {
  const needle = q.toLowerCase();
  return workspace.companies
    .filter((company) => company.name.toLowerCase().includes(needle) || company.board.toLowerCase().includes(needle))
    .slice(0, limit)
    .map((company) => ({
      id: `${company.ats}:${company.board}`,
      title: company.name,
      sub: `${company.ats} board${company.active ? "" : ", paused"} · tier ${company.tier}`,
      href: query("/companies", { q: company.name }),
    }));
}

function contacts(workspace: Workspace, like: string, limit: number): SearchItem[] {
  const rows = workspace.db
    .prepare(
      `SELECT id, name, company, role FROM contacts
       WHERE name LIKE ? ESCAPE '\\' OR company LIKE ? ESCAPE '\\' OR role LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\'
       ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(like, like, like, like, limit) as Row[];
  return rows.map((row) => ({
    id: text(row.id),
    title: text(row.name),
    sub: [text(row.role), text(row.company)].filter(Boolean).join(", "),
    href: query("/contacts", { contact: text(row.id) }),
  }));
}

function stories(workspace: Workspace, like: string, q: string, limit: number): SearchItem[] {
  const rows = workspace.db
    .prepare(
      `SELECT id, title, situation, action, result, tags_json FROM stories
       WHERE title LIKE ? ESCAPE '\\' OR situation LIKE ? ESCAPE '\\' OR action LIKE ? ESCAPE '\\' OR result LIKE ? ESCAPE '\\' OR tags_json LIKE ? ESCAPE '\\'
       ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(like, like, like, like, like, limit) as Row[];
  return rows.map((row) => {
    const body = [row.result, row.action, row.situation].map(text).find((part) => part.toLowerCase().includes(q.toLowerCase())) ?? text(row.result);
    return { id: text(row.id), title: text(row.title), sub: excerpt(body, q), href: query("/stories", { story: text(row.id) }) };
  });
}

function notes(workspace: Workspace, like: string, q: string, limit: number): SearchItem[] {
  const rows = workspace.db
    .prepare(
      `SELECT id, company, kind, content FROM company_notes
       WHERE company LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\'
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(like, like, limit) as Row[];
  return rows.map((row) => ({
    id: text(row.id),
    title: `${text(row.company)}: ${text(row.kind)}`,
    sub: excerpt(text(row.content), q),
    href: query("/research", { company: text(row.company), note: text(row.id) }),
  }));
}

export function searchEverything(workspace: Workspace, q: string, limit = 6): { q: string; total: number; groups: SearchGroup[] } {
  const like = likeOf(q);
  const groups: SearchGroup[] = [
    { kind: "applications", label: "Applications", items: applications(workspace, like, q, limit) },
    { kind: "jobs", label: "Jobs", items: jobs(workspace, like, limit) },
    { kind: "companies", label: "Companies", items: companies(workspace, q, limit) },
    { kind: "contacts", label: "Contacts", items: contacts(workspace, like, limit) },
    { kind: "stories", label: "Stories", items: stories(workspace, like, q, limit) },
    { kind: "notes", label: "Research notes", items: notes(workspace, like, q, limit) },
  ].filter((group) => group.items.length > 0);
  return { q, total: groups.reduce((sum, group) => sum + group.items.length, 0), groups };
}
