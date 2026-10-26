"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** What the team has entered for a ticket. Shared by everyone on the page. */
interface TicketStatus {
  generated_tcs: string;
  validated: string;
  included_in_runs: string;
  updated_by: string;
  updated_at: string;
}

type StatusField = "generated_tcs" | "validated" | "included_in_runs";

interface Ticket {
  key: string;
  summary: string;
  issue_type: string;
  status: string;
  resolution: string;
  assignee: string;
  labels: string[];
  tc_tickets: string[];
}

interface Query {
  fixVersion: string;
  project: string;
  sprint: string;
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://172.16.23.15:8000";
const JIRA_BASE = "https://netradyne.atlassian.net";
const STORAGE_KEY = "perda.releaseTickets.query";
// Same browser key Review Bench uses, so a name set there is picked up here.
const NAME_KEY = "perda-review-reviewer";
// How often other people's edits are pulled in. This re-reads saved statuses
// only; Jira is not queried again until "Fetch tickets" is clicked.
const POLL_MS = 10_000;

const GENERATED_CHOICES = ["Yes", "In progress", "No", "N/A"];
const VALIDATED_CHOICES = ["Yes", "Partial", "No", "N/A"];

const DEFAULT_QUERY: Query = { fixVersion: "", project: "Device_Tracker", sprint: "" };

function loadQuery(): Query {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...DEFAULT_QUERY, ...JSON.parse(raw) } : DEFAULT_QUERY;
  } catch {
    return DEFAULT_QUERY;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TYPE_STYLE: Record<string, string> = {
  Bug: "bg-red-500/10 text-red-300",
  Story: "bg-emerald-500/10 text-emerald-300",
  Task: "bg-sky-500/10 text-sky-300",
  Epic: "bg-purple-500/10 text-purple-300",
};

function statusStyle(status: string): string {
  const s = status.toLowerCase();
  if (/(done|closed|resolved|released|verified)/.test(s)) return "bg-emerald-500/10 text-emerald-300";
  if (/(progress|review|tested|testing)/.test(s)) return "bg-amber-500/10 text-amber-300";
  return "bg-white/[0.06] text-gray-300";
}

const CHOICE_STYLE: Record<string, string> = {
  Yes: "text-emerald-300",
  Partial: "text-amber-300",
  "In progress": "text-amber-300",
  No: "text-red-300",
};

function whoWhen(st: TicketStatus | undefined): string {
  if (!st?.updated_by && !st?.updated_at) return "";
  const when = st.updated_at ? new Date(st.updated_at).toLocaleString() : "";
  return `Last edited${st.updated_by ? ` by ${st.updated_by}` : ""}${when ? ` · ${when}` : ""}`;
}

const blankStatus: TicketStatus = {
  generated_tcs: "", validated: "", included_in_runs: "", updated_by: "", updated_at: "",
};

const pick = (st: TicketStatus, field: StatusField): Partial<TicketStatus> => ({ [field]: st[field] });

const Dash = () => <span className="text-gray-600">—</span>;

const Badge = ({ className, children }: { className: string; children: React.ReactNode }) => (
  <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${className}`}>{children}</span>
);

// ---------------------------------------------------------------------------
// Editable cells
// ---------------------------------------------------------------------------

type Save = (key: string, field: StatusField, value: string) => void;
type Editing = (key: string, field: StatusField, on: boolean) => void;

function StatusSelect({
  ticket, field, value, choices, title, onSave,
}: {
  ticket: string; field: StatusField; value: string; choices: string[]; title: string; onSave: Save;
}) {
  return (
    <select
      value={value}
      title={title}
      aria-label={`${field.replace("_", " ")} for ${ticket}`}
      onChange={(e) => onSave(ticket, field, e.target.value)}
      className={`rounded-md border border-white/[0.07] bg-white/[0.02] px-2 py-1 text-[12px] outline-none focus:border-indigo-400/50 ${
        CHOICE_STYLE[value] ?? "text-gray-500"
      }`}
    >
      <option value="">—</option>
      {choices.map((c) => <option key={c}>{c}</option>)}
    </select>
  );
}

function StatusText({
  ticket, field, value, title, placeholder, onSave, onEditing,
}: {
  ticket: string; field: StatusField; value: string; title: string; placeholder: string;
  onSave: Save; onEditing: Editing;
}) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);

  // Take a teammate's edit unless this cell is the one being typed in.
  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);

  const commit = () => {
    focused.current = false;
    onEditing(ticket, field, false);
    if (draft.trim() !== value) onSave(ticket, field, draft.trim());
  };

  return (
    <input
      value={draft}
      title={title}
      placeholder={placeholder}
      aria-label={`${field.replace(/_/g, " ")} for ${ticket}`}
      onFocus={() => { focused.current = true; onEditing(ticket, field, true); }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") { setDraft(value); (e.target as HTMLInputElement).blur(); }
      }}
      className="w-36 rounded-md border border-white/[0.07] bg-white/[0.02] px-2 py-1 text-[12px] text-gray-200 outline-none placeholder:text-gray-600 focus:border-indigo-400/50"
    />
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ReleaseTickets() {
  const [query, setQuery] = useState<Query>(() => (typeof window === "undefined" ? DEFAULT_QUERY : loadQuery()));
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [teamStatus, setTeamStatus] = useState<Record<string, TicketStatus>>({});
  const [jql, setJql] = useState("");
  // Cells currently being typed in; a refresh must not overwrite these.
  const editing = useRef(new Set<string>());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [type, setType] = useState("");
  const [tcFilter, setTcFilter] = useState<"" | "missing" | "unvalidated">("");

  const statusOf = (key: string, field: StatusField) => teamStatus[key]?.[field] ?? "";

  // Pull in other people's edits while the page is open.
  useEffect(() => {
    if (!tickets) return;
    const refresh = async () => {
      if (document.hidden) return;
      try {
        const res = await fetch(`${API_BASE}/ticket-status`);
        if (!res.ok) return;
        const fresh: Record<string, TicketStatus> = await res.json();
        setTeamStatus((prev) => {
          const next = { ...fresh };
          editing.current.forEach((id) => {
            const [key] = id.split(":");
            if (prev[key]) next[key] = { ...(next[key] ?? prev[key]), ...pick(prev[key], id.split(":")[1] as StatusField) };
          });
          return next;
        });
      } catch {
        /* a missed refresh is harmless; the next one catches up */
      }
    };
    const timer = setInterval(refresh, POLL_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [tickets]);

  const markEditing: Editing = useCallback((key, field, on) => {
    const id = `${key}:${field}`;
    if (on) editing.current.add(id);
    else editing.current.delete(id);
  }, []);

  const save: Save = async (key, field, value) => {
    let name = "";
    try { name = localStorage.getItem(NAME_KEY) ?? ""; } catch { /* no storage */ }
    if (!name) {
      name = (window.prompt("Your name — shown next to your edits:") ?? "").trim();
      if (name) {
        try { localStorage.setItem(NAME_KEY, name); } catch { /* not remembered */ }
      }
    }
    const before = teamStatus[key];
    setError(null);
    setTeamStatus((s) => ({ ...s, [key]: { ...blankStatus, ...s[key], [field]: value, updated_by: name } }));
    try {
      const res = await fetch(`${API_BASE}/ticket-status/${encodeURIComponent(key)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ field, value, actor: name }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.detail ?? `Save failed (HTTP ${res.status})`);
      setTeamStatus((s) => ({ ...s, [key]: body }));
    } catch (e) {
      // Put the cell back so the screen never shows something that wasn't saved.
      setTeamStatus((s) => {
        const next = { ...s };
        if (before) next[key] = before;
        else delete next[key];
        return next;
      });
      setError(`${key}: ${e instanceof Error ? e.message : "could not save"}`);
    }
  };

  const load = async () => {
    if (!query.fixVersion.trim()) {
      setError("Enter a fix version, e.g. x.6.19.rc.1");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(query));
    } catch {
      /* remembering the last query is a convenience only */
    }
    try {
      const params = new URLSearchParams({
        fix_version: query.fixVersion.trim(),
        project: query.project.trim(),
        sprint: query.sprint.trim(),
      });
      const res = await fetch(`${API_BASE}/release-tickets?${params}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.detail ?? `Request failed (HTTP ${res.status})`);
      setTickets(body.tickets);
      setTeamStatus(body.status ?? {});
      setJql(body.jql ?? "");
      setStatus("");
      setType("");
      setSearch("");
      setTcFilter("");
    } catch (e) {
      setTickets(null);
      setError(e instanceof Error ? e.message : "Could not load tickets");
    } finally {
      setLoading(false);
    }
  };

  const statuses = useMemo(() => Array.from(new Set((tickets ?? []).map((t) => t.status))).sort(), [tickets]);
  const types = useMemo(() => Array.from(new Set((tickets ?? []).map((t) => t.issue_type))).sort(), [tickets]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (tickets ?? []).filter((t) => {
      if (status && t.status !== status) return false;
      if (type && t.issue_type !== type) return false;
      if (tcFilter === "missing" && t.tc_tickets.length > 0) return false;
      if (tcFilter === "unvalidated" && ["Yes", "N/A"].includes(teamStatus[t.key]?.validated ?? "")) return false;
      if (!q) return true;
      return [t.key, t.summary, t.assignee, ...t.labels].some((v) => v.toLowerCase().includes(q));
    });
  }, [tickets, teamStatus, search, status, type, tcFilter]);

  const withTc = (tickets ?? []).filter((t) => t.tc_tickets.length > 0).length;
  const validatedCount = (tickets ?? []).filter((t) => statusOf(t.key, "validated") === "Yes").length;

  const setField = (k: keyof Query) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setQuery((q) => ({ ...q, [k]: e.target.value }));

  return (
    <div className="space-y-5">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          load();
        }}
        className="ds-card flex flex-wrap items-end gap-3 p-4"
      >
        <label className="flex min-w-[200px] flex-1 flex-col gap-1 text-[11px] font-medium uppercase tracking-wider text-gray-600">
          Fix version
          <input
            value={query.fixVersion}
            onChange={setField("fixVersion")}
            placeholder="x.6.19.rc.1"
            className="ds-input !text-[13px] normal-case tracking-normal"
          />
        </label>
        <label className="flex min-w-[160px] flex-col gap-1 text-[11px] font-medium uppercase tracking-wider text-gray-600">
          Project
          <input
            value={query.project}
            onChange={setField("project")}
            placeholder="all projects"
            className="ds-input !text-[13px] normal-case tracking-normal"
          />
        </label>
        <label className="flex w-[140px] flex-col gap-1 text-[11px] font-medium uppercase tracking-wider text-gray-600">
          Sprint id <span className="normal-case tracking-normal text-gray-600">(blank = whole fix version)</span>
          <input
            value={query.sprint}
            onChange={setField("sprint")}
            placeholder="11301"
            inputMode="numeric"
            className="ds-input !text-[13px] normal-case tracking-normal"
          />
        </label>
        <button type="submit" disabled={loading} className="ds-btn-secondary">
          {loading ? "Fetching from Jira…" : "Fetch tickets"}
        </button>
      </form>

      {error && (
        <div className="rounded-xl border border-red-500/15 bg-red-500/[0.06] px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {tickets && (
        <div className="ds-card overflow-hidden">
          <div className="ds-card-header flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-gray-300">
              All tickets{" "}
              <span className="font-normal text-gray-500">
                · {shown.length === tickets.length ? `${tickets.length} total` : `${shown.length} of ${tickets.length}`}
              </span>
            </h3>
            <p className="text-[11px] text-gray-600">
              {withTc} with a TC ticket · {validatedCount} validated in device
            </p>
          </div>

          {jql && (
            <p className="border-b border-white/[0.05] px-4 py-2 text-[11px] text-gray-600">
              JQL: <span className="select-all font-mono text-gray-500">{jql}</span>
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2.5 border-b border-white/[0.05] px-4 py-3">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search key, summary, assignee, label…"
              aria-label="Search tickets"
              className="ds-input min-w-[240px] flex-1 !text-[13px]"
            />
            <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Type" className="ds-input !text-[13px]">
              <option value="">All types</option>
              {types.map((t) => <option key={t}>{t}</option>)}
            </select>
            <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status" className="ds-input !text-[13px]">
              <option value="">All statuses</option>
              {statuses.map((s) => <option key={s}>{s}</option>)}
            </select>
            <select
              value={tcFilter}
              onChange={(e) => setTcFilter(e.target.value as typeof tcFilter)}
              aria-label="Test coverage"
              className="ds-input !text-[13px]"
            >
              <option value="">Any TC coverage</option>
              <option value="missing">No TC ticket</option>
              <option value="unvalidated">Not validated in device</option>
            </select>
          </div>

          <div className="overflow-x-auto">
            {shown.length === 0 ? (
              <p className="py-12 text-center text-sm text-gray-500">No tickets found matching the filters</p>
            ) : (
              <table className="ds-table">
                <thead>
                  <tr>
                    <th>Key</th>
                    <th>Summary</th>
                    <th>Type</th>
                    <th>Status</th>
                    <th>Resolution</th>
                    <th>Assignee</th>
                    <th>Labels</th>
                    <th>TC ticket</th>
                    <th>Generated TCs</th>
                    <th>Validated in device</th>
                    <th>Included in runs</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((t) => {
                    const edited = whoWhen(teamStatus[t.key]);
                    return (
                      <tr key={t.key} className="align-top">
                        <td className="whitespace-nowrap">
                          <a
                            href={`${JIRA_BASE}/browse/${t.key}`} target="_blank" rel="noreferrer"
                            className="font-medium text-indigo-300 hover:text-indigo-200"
                          >
                            {t.key}
                          </a>
                        </td>
                        <td className="max-w-md truncate" title={t.summary}>{t.summary}</td>
                        <td><Badge className={TYPE_STYLE[t.issue_type] ?? "bg-white/[0.06] text-gray-300"}>{t.issue_type}</Badge></td>
                        <td><Badge className={statusStyle(t.status)}>{t.status}</Badge></td>
                        <td>{t.resolution ? <Badge className="bg-white/[0.06] text-gray-300">{t.resolution}</Badge> : <Dash />}</td>
                        <td className="whitespace-nowrap">{t.assignee || <span className="text-gray-500">Unassigned</span>}</td>
                        <td>
                          {t.labels.length === 0 ? (
                            <Dash />
                          ) : (
                            <div className="flex flex-wrap gap-1">
                              {t.labels.map((l) => (
                                <span key={l} className="rounded bg-indigo-500/10 px-1.5 py-0.5 text-[11px] text-indigo-300">{l}</span>
                              ))}
                            </div>
                          )}
                        </td>
                        <td>
                          {t.tc_tickets.length === 0 ? (
                            <Badge className="bg-red-500/10 text-red-300">Missing</Badge>
                          ) : (
                            <div className="flex flex-col gap-0.5">
                              {t.tc_tickets.map((k) => (
                                <a
                                  key={k} href={`${JIRA_BASE}/browse/${k}`} target="_blank" rel="noreferrer"
                                  className="text-indigo-300 hover:text-indigo-200"
                                >
                                  {k}
                                </a>
                              ))}
                            </div>
                          )}
                        </td>
                        <td>
                          <StatusSelect
                            ticket={t.key} field="generated_tcs" choices={GENERATED_CHOICES} title={edited}
                            value={statusOf(t.key, "generated_tcs")} onSave={save}
                          />
                        </td>
                        <td>
                          <StatusSelect
                            ticket={t.key} field="validated" choices={VALIDATED_CHOICES} title={edited}
                            value={statusOf(t.key, "validated")} onSave={save}
                          />
                        </td>
                        <td>
                          <StatusText
                            ticket={t.key} field="included_in_runs" title={edited} placeholder="e.g. #4821"
                            value={statusOf(t.key, "included_in_runs")} onSave={save} onEditing={markEditing}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {!tickets && !error && !loading && (
        <div className="ds-card ds-empty">
          <p className="mb-1 text-[15px] font-medium text-gray-400">No release loaded</p>
          <p className="max-w-sm text-sm text-gray-600">
            Enter a fix version (and optionally a sprint id) to pull its tickets from Jira.
          </p>
        </div>
      )}
    </div>
  );
}
