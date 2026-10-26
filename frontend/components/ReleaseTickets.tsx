"use client";

import { useMemo, useState } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GeneratedTC {
  tc_key: string;
  tc_id: string;
  review_status: string;
  validated: boolean;
  runs: number;
}

interface Ticket {
  key: string;
  summary: string;
  issue_type: string;
  status: string;
  resolution: string;
  assignee: string;
  labels: string[];
  tc_tickets: string[];
  generated_tcs: GeneratedTC[];
  included_in_runs: string[];
}

interface Query {
  fixVersion: string;
  project: string;
  sprint: string;
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://172.16.23.15:8000";
const JIRA_BASE = "https://netradyne.atlassian.net";
const STORAGE_KEY = "perda.releaseTickets.query";

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

const Dash = () => <span className="text-gray-600">—</span>;

const Badge = ({ className, children }: { className: string; children: React.ReactNode }) => (
  <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${className}`}>{children}</span>
);

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ReleaseTickets() {
  const [query, setQuery] = useState<Query>(() => (typeof window === "undefined" ? DEFAULT_QUERY : loadQuery()));
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [type, setType] = useState("");
  const [tcFilter, setTcFilter] = useState<"" | "missing" | "unvalidated">("");

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
      if (tcFilter === "unvalidated" && (t.generated_tcs.length === 0 || t.generated_tcs.every((g) => g.validated)))
        return false;
      if (!q) return true;
      return [t.key, t.summary, t.assignee, ...t.labels].some((v) => v.toLowerCase().includes(q));
    });
  }, [tickets, search, status, type, tcFilter]);

  const withTc = (tickets ?? []).filter((t) => t.tc_tickets.length > 0).length;
  const withGenerated = (tickets ?? []).filter((t) => t.generated_tcs.length > 0).length;

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
          Sprint id
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
              {withTc} with a TC ticket · {withGenerated} with generated TCs
            </p>
          </div>

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
              <option value="unvalidated">Generated, not validated</option>
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
                    const validated = t.generated_tcs.filter((g) => g.validated).length;
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
                          {t.generated_tcs.length === 0 ? (
                            <Dash />
                          ) : (
                            <div className="flex flex-col gap-0.5" title={t.generated_tcs.map((g) => g.tc_key).join("\n")}>
                              <span className="font-medium text-gray-200">{t.generated_tcs.length}</span>
                              <span className="text-[11px] text-gray-500">{t.generated_tcs.map((g) => g.tc_id).join(", ")}</span>
                            </div>
                          )}
                        </td>
                        <td>
                          {t.generated_tcs.length === 0 ? (
                            <Dash />
                          ) : (
                            <Badge
                              className={
                                validated === t.generated_tcs.length
                                  ? "bg-emerald-500/10 text-emerald-300"
                                  : validated > 0
                                  ? "bg-amber-500/10 text-amber-300"
                                  : "bg-white/[0.06] text-gray-400"
                              }
                            >
                              {validated}/{t.generated_tcs.length} validated
                            </Badge>
                          )}
                        </td>
                        <td>{t.included_in_runs.length === 0 ? <Dash /> : t.included_in_runs.join(", ")}</td>
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
