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

interface VersionOption { id: string; name: string; released: boolean }
interface SprintOption { id: number; name: string; state: string }

interface Query {
  fixVersion: string;
  project: string;
  sprint: string;
}

/** Which slice of the table a stat tile is showing. */
type Slice = "" | "no-tc" | "no-generated" | "not-validated" | "no-runs";

type SortKey = "key" | "status" | "assignee" | "tc" | "generated" | "validated";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://172.16.23.15:8000";
const JIRA_BASE = "https://netradyne.atlassian.net";
const STORAGE_KEY = "perda.releaseTickets.query";
// Same browser key Review Bench uses, so a name set there is picked up here.
const NAME_KEY = "perda-review-reviewer";
// How often other people's edits are pulled in. This re-reads saved statuses
// only; Jira is not queried again until "Refresh from Jira" is clicked.
const POLL_MS = 10_000;

const GENERATED_CHOICES = ["Yes", "In progress", "No", "N/A"];
const VALIDATED_CHOICES = ["Yes", "Partial", "No", "N/A"];

// Worst → best, so sorting a status column groups what still needs doing.
const RANK: Record<string, number> = { "": 0, No: 1, "In progress": 2, Partial: 2, "N/A": 3, Yes: 4 };

const DEFAULT_QUERY: Query = { fixVersion: "", project: "Device_Tracker", sprint: "" };

const blankStatus: TicketStatus = {
  generated_tcs: "", validated: "", included_in_runs: "", updated_by: "", updated_at: "",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadQuery(): Query {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...DEFAULT_QUERY, ...JSON.parse(raw) } : DEFAULT_QUERY;
  } catch {
    return DEFAULT_QUERY;
  }
}

function savedName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

const keyNumber = (key: string) => Number(key.split("-").pop()) || 0;

function ago(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, (now - t) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** A stable colour per person, so the same name is recognisable at a glance. */
function hue(name: string): number {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join("") || "?";

const TYPE_STYLE: Record<string, string> = {
  Bug: "bg-red-500/10 text-red-300 ring-red-500/20",
  Story: "bg-emerald-500/10 text-emerald-300 ring-emerald-500/20",
  Task: "bg-sky-500/10 text-sky-300 ring-sky-500/20",
  Epic: "bg-purple-500/10 text-purple-300 ring-purple-500/20",
};

function statusStyle(status: string): string {
  const s = status.toLowerCase();
  if (/(done|closed|resolved|released|verified)/.test(s)) return "bg-emerald-500/10 text-emerald-300 ring-emerald-500/20";
  if (/(progress|review|tested|testing)/.test(s)) return "bg-amber-500/10 text-amber-300 ring-amber-500/20";
  return "bg-white/[0.05] text-gray-300 ring-white/[0.08]";
}

/** Colour of a team-status value, shared by the dropdown pills and the rail. */
const CHOICE_STYLE: Record<string, string> = {
  Yes: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
  Partial: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
  "In progress": "bg-amber-500/15 text-amber-300 ring-amber-500/30",
  No: "bg-red-500/15 text-red-300 ring-red-500/30",
  "N/A": "bg-white/[0.05] text-gray-400 ring-white/[0.1]",
};
const EMPTY_CHOICE = "bg-transparent text-gray-600 ring-white/[0.08]";

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

function Pill({ className, children }: { className: string; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${className}`}>
      {children}
    </span>
  );
}

const Dash = () => <span className="text-gray-700">—</span>;

function Chevron({ className = "" }: { className?: string }) {
  return (
    <svg className={`h-3 w-3 ${className}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
    </svg>
  );
}

function Avatar({ name }: { name: string }) {
  const h = hue(name);
  return (
    <span
      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold"
      style={{ background: `hsl(${h} 45% 28%)`, color: `hsl(${h} 80% 82%)` }}
      aria-hidden
    >
      {initials(name)}
    </span>
  );
}

type Save = (key: string, field: StatusField, value: string) => void;
type Editing = (key: string, field: StatusField, on: boolean) => void;

/** A dropdown that looks like a status pill, coloured by its value. */
function StatusSelect({
  ticket, field, value, choices, label, onSave,
}: {
  ticket: string; field: StatusField; value: string; choices: string[]; label: string; onSave: Save;
}) {
  return (
    <span className="relative inline-flex">
      <select
        value={value}
        aria-label={`${label} for ${ticket}`}
        onChange={(e) => onSave(ticket, field, e.target.value)}
        className={`cursor-pointer appearance-none rounded-full py-1 pl-2.5 pr-6 text-[11.5px] font-medium ring-1 ring-inset outline-none transition-colors focus-visible:ring-2 focus-visible:ring-indigo-400/60 ${
          CHOICE_STYLE[value] ?? EMPTY_CHOICE
        }`}
      >
        <option value="">Set…</option>
        {choices.map((c) => <option key={c}>{c}</option>)}
      </select>
      <Chevron className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 opacity-60" />
    </span>
  );
}

function StatusText({
  ticket, field, value, placeholder, label, onSave, onEditing,
}: {
  ticket: string; field: StatusField; value: string; placeholder: string; label: string;
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
      placeholder={placeholder}
      aria-label={`${label} for ${ticket}`}
      onFocus={() => { focused.current = true; onEditing(ticket, field, true); }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") { setDraft(value); (e.target as HTMLInputElement).blur(); }
      }}
      className={`w-32 rounded-lg border bg-transparent px-2.5 py-1 text-[12px] text-gray-200 outline-none transition-colors placeholder:text-gray-700 hover:border-white/[0.12] focus:border-indigo-400/50 focus:bg-white/[0.03] ${
        draft ? "border-transparent" : "border-dashed border-white/[0.08]"
      }`}
    />
  );
}

function Tile({
  label, value, of, note, segments, active, onClick,
}: {
  label: string; value: number; of?: number; note: string;
  segments: { pct: number; color: string }[];
  active: boolean; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`ds-card group relative overflow-hidden p-4 text-left transition-all ${
        active ? "!border-indigo-400/50 ring-1 ring-indigo-400/30" : "hover:-translate-y-px"
      }`}
    >
      <p className="text-[11px] font-medium uppercase tracking-wider text-gray-500">{label}</p>
      <p className="mt-1.5 flex items-baseline gap-1.5">
        <span className="text-[26px] font-semibold leading-none tracking-tight text-gray-100">{value}</span>
        {of !== undefined && <span className="text-[13px] text-gray-600">/ {of}</span>}
      </p>
      <div className="mt-3 flex h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
        {segments.map((s, i) => (
          <div key={i} className={s.color} style={{ width: `${s.pct}%` }} />
        ))}
      </div>
      <p className={`mt-2 text-[11.5px] ${active ? "text-indigo-300" : "text-gray-500 group-hover:text-gray-400"}`}>
        {active ? "Showing these · click to clear" : note}
      </p>
    </button>
  );
}

function Th({
  label, sort, col, onSort, className = "",
}: {
  label: string; sort: { col: SortKey; dir: 1 | -1 } | null; col?: SortKey; onSort?: (c: SortKey) => void; className?: string;
}) {
  const on = !!col && sort?.col === col;
  return (
    <th
      scope="col"
      aria-sort={on ? (sort!.dir === 1 ? "ascending" : "descending") : undefined}
      className={`whitespace-nowrap !px-3 !py-2.5 ${className}`}
    >
      {col && onSort ? (
        <button
          onClick={() => onSort(col)}
          className={`inline-flex items-center gap-1 transition-colors hover:text-gray-200 ${on ? "text-gray-200" : ""}`}
        >
          {label}
          <span className={`text-[10px] ${on ? "text-indigo-300" : "text-transparent"}`}>{on && sort!.dir === -1 ? "▼" : "▲"}</span>
        </button>
      ) : (
        label
      )}
    </th>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ReleaseTickets({ initialQuery }: { initialQuery?: Partial<Query> }) {
  const [query, setQuery] = useState<Query>(() =>
    typeof window === "undefined" ? DEFAULT_QUERY : { ...loadQuery(), ...initialQuery }
  );
  const [options, setOptions] = useState<{ versions: VersionOption[]; sprints: SprintOption[] } | null>(null);
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [teamStatus, setTeamStatus] = useState<Record<string, TicketStatus>>({});
  const [jql, setJql] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [type, setType] = useState("");
  const [slice, setSlice] = useState<Slice>("");
  const [sort, setSort] = useState<{ col: SortKey; dir: 1 | -1 } | null>(null);

  // Live-sync bookkeeping.
  const [now, setNow] = useState(() => Date.now());
  const [lastSync, setLastSync] = useState<number | null>(null);
  const [syncOk, setSyncOk] = useState(true);
  const [flash, setFlash] = useState<Set<string>>(new Set());
  // Cells currently being typed in; a refresh must not overwrite these.
  const editing = useRef(new Set<string>());
  const teamRef = useRef(teamStatus);
  teamRef.current = teamStatus;

  const field = (key: string, f: StatusField) => teamStatus[key]?.[f] ?? "";

  // ---- loading ------------------------------------------------------------

  const load = useCallback(async (q: Query) => {
    if (!q.fixVersion.trim()) {
      setError("Choose a fix version first");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(q));
    } catch {
      /* remembering the last query is a convenience only */
    }
    try {
      const params = new URLSearchParams({
        fix_version: q.fixVersion.trim(),
        project: q.project.trim(),
        sprint: q.sprint.trim(),
      });
      const res = await fetch(`${API_BASE}/release-tickets?${params}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.detail ?? `Request failed (HTTP ${res.status})`);
      setTickets(body.tickets);
      setTeamStatus(body.status ?? {});
      setJql(body.jql ?? "");
      setLastSync(Date.now());
      setSyncOk(true);
      setStatus(""); setType(""); setSearch(""); setSlice("");
    } catch (e) {
      setTickets(null);
      setError(e instanceof Error ? e.message : "Could not load tickets");
    } finally {
      setLoading(false);
    }
  }, []);

  // What the two dropdowns offer, straight from Jira.
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/release-tickets/options`);
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.detail ?? `Could not load fix versions (HTTP ${res.status})`);
        setOptions(body);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not load fix versions and sprints");
      }
    })();
  }, []);

  // Choosing from a dropdown loads that release straight away.
  const choose = (patch: Partial<Query>) => {
    const next = { ...query, ...patch };
    setQuery(next);
    if (next.fixVersion) load(next);
  };

  // Reopening the page picks up where the last visit left off.
  useEffect(() => {
    if (query.fixVersion.trim()) load(query);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- live refresh -------------------------------------------------------

  useEffect(() => {
    if (!tickets) return;
    const refresh = async () => {
      if (document.hidden) return;
      try {
        const res = await fetch(`${API_BASE}/ticket-status`);
        if (!res.ok) throw new Error();
        const fresh: Record<string, TicketStatus> = await res.json();
        const prev = teamRef.current;
        const me = savedName();

        // Rows a teammate changed since the last look, for the highlight.
        const changed = Object.keys(fresh).filter(
          (k) => prev[k]?.updated_at !== fresh[k].updated_at && (!me || fresh[k].updated_by !== me)
        );

        // Keep whatever is being typed right now.
        const next = { ...fresh };
        editing.current.forEach((id) => {
          const [key, f] = id.split(":") as [string, StatusField];
          if (prev[key]) next[key] = { ...(next[key] ?? prev[key]), [f]: prev[key][f] };
        });

        setTeamStatus(next);
        setLastSync(Date.now());
        setSyncOk(true);
        if (changed.length) {
          setFlash(new Set(changed));
          setTimeout(() => setFlash(new Set()), 2600);
        }
      } catch {
        setSyncOk(false); // a missed refresh is harmless; the next one catches up
      }
    };
    const timer = setInterval(refresh, POLL_MS);
    const clock = setInterval(() => setNow(Date.now()), 5000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      clearInterval(clock);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [tickets]);

  const markEditing: Editing = useCallback((key, f, on) => {
    const id = `${key}:${f}`;
    if (on) editing.current.add(id);
    else editing.current.delete(id);
  }, []);

  // ---- saving -------------------------------------------------------------

  const save: Save = async (key, f, value) => {
    let name = savedName();
    if (!name) {
      name = (window.prompt("Your name — shown next to your edits:") ?? "").trim();
      if (name) {
        try { localStorage.setItem(NAME_KEY, name); } catch { /* not remembered */ }
      }
    }
    const before = teamStatus[key];
    setError(null);
    setTeamStatus((s) => ({
      ...s,
      [key]: { ...blankStatus, ...s[key], [f]: value, updated_by: name, updated_at: new Date().toISOString() },
    }));
    try {
      const res = await fetch(`${API_BASE}/ticket-status/${encodeURIComponent(key)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ field: f, value, actor: name }),
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

  // ---- derived ------------------------------------------------------------

  const jiraStatuses = useMemo(() => Array.from(new Set((tickets ?? []).map((t) => t.status))).sort(), [tickets]);
  const types = useMemo(() => Array.from(new Set((tickets ?? []).map((t) => t.issue_type))).sort(), [tickets]);

  const stats = useMemo(() => {
    const all = tickets ?? [];
    const count = (f: StatusField, v: string) => all.filter((t) => teamStatus[t.key]?.[f] === v).length;
    return {
      total: all.length,
      withTc: all.filter((t) => t.tc_tickets.length > 0).length,
      generated: count("generated_tcs", "Yes"),
      generatedWip: count("generated_tcs", "In progress"),
      validated: count("validated", "Yes"),
      validatedPartial: count("validated", "Partial"),
      validatedNo: count("validated", "No"),
      inRuns: all.filter((t) => (teamStatus[t.key]?.included_in_runs ?? "") !== "").length,
    };
  }, [tickets, teamStatus]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = (tickets ?? []).filter((t) => {
      if (status && t.status !== status) return false;
      if (type && t.issue_type !== type) return false;
      const s = teamStatus[t.key];
      if (slice === "no-tc" && t.tc_tickets.length > 0) return false;
      if (slice === "no-generated" && s?.generated_tcs === "Yes") return false;
      if (slice === "not-validated" && s?.validated === "Yes") return false;
      if (slice === "no-runs" && (s?.included_in_runs ?? "") !== "") return false;
      if (!q) return true;
      return [t.key, t.summary, t.assignee, ...t.labels].some((v) => v.toLowerCase().includes(q));
    });
    if (!sort) return rows;
    const val = (t: Ticket): number | string => {
      switch (sort.col) {
        case "key": return keyNumber(t.key);
        case "status": return t.status;
        case "assignee": return t.assignee.toLowerCase();
        case "tc": return t.tc_tickets.length;
        case "generated": return RANK[teamStatus[t.key]?.generated_tcs ?? ""] ?? 0;
        case "validated": return RANK[teamStatus[t.key]?.validated ?? ""] ?? 0;
      }
    };
    return [...rows].sort((a, b) => {
      const x = val(a), y = val(b);
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
    });
  }, [tickets, teamStatus, search, status, type, slice, sort]);

  const toggleSort = (col: SortKey) =>
    setSort((s) => (s?.col !== col ? { col, dir: 1 } : s.dir === 1 ? { col, dir: -1 } : null));

  const toggleSlice = (s: Slice) => setSlice((cur) => (cur === s ? "" : s));
  const filtered = !!(search || status || type || slice);
  const clearFilters = () => { setSearch(""); setStatus(""); setType(""); setSlice(""); };

  // Sprints are named after their release ("x.6.19_Sprint1" for "x.6.19.rc.1"),
  // so the ones for the chosen fix version go first.
  const sprintPrefix = /^(x\.\d+\.\d+)/.exec(query.fixVersion)?.[1] ?? null;
  const sprintsFor = (options?.sprints ?? []).filter((sp) => sprintPrefix && sp.name.startsWith(`${sprintPrefix}_`));
  const sprintsOther = (options?.sprints ?? []).filter((sp) => !sprintsFor.includes(sp));
  const sprintLabel = (sp: SprintOption) => (sp.state === "active" ? `${sp.name} · active` : sp.name);
  const releaseBuilds = (options?.versions ?? []).filter((v) => /^x\.\d+\.\d+\.rc\./.test(v.name));
  const otherVersions = (options?.versions ?? []).filter((v) => !releaseBuilds.includes(v));

  const pct = (n: number) => (stats.total ? (n / stats.total) * 100 : 0);

  // ---- render -------------------------------------------------------------

  return (
    <div className="space-y-5">
      {/* Release picker */}
      <form
        onSubmit={(e) => { e.preventDefault(); load(query); }}
        className="ds-card flex flex-wrap items-end gap-x-3 gap-y-3 p-4"
      >
        <label className="flex min-w-[220px] flex-1 flex-col gap-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wider text-gray-500">Fix version</span>
          <select
            value={query.fixVersion}
            onChange={(e) => choose({ fixVersion: e.target.value, sprint: "" })}
            disabled={!options}
            className="ds-input !text-[13px]"
          >
            <option value="">{options ? "Choose a fix version…" : "Loading from Jira…"}</option>
            <optgroup label="Release builds">
              {releaseBuilds.map((v) => <option key={v.id} value={v.name}>{v.name}{v.released ? " · released" : ""}</option>)}
            </optgroup>
            {otherVersions.length > 0 && (
              <optgroup label="Other versions">
                {otherVersions.map((v) => <option key={v.id} value={v.name}>{v.name}</option>)}
              </optgroup>
            )}
            {/* A remembered version that Jira no longer lists still needs to show. */}
            {options && query.fixVersion && !options.versions.some((v) => v.name === query.fixVersion) && (
              <option value={query.fixVersion}>{query.fixVersion}</option>
            )}
          </select>
        </label>
        <label className="flex min-w-[220px] flex-1 flex-col gap-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wider text-gray-500">Sprint</span>
          <select
            value={query.sprint}
            onChange={(e) => choose({ sprint: e.target.value })}
            disabled={!options || !query.fixVersion}
            title="Leave on All sprints for every ticket in the fix version, including ones in no sprint"
            className="ds-input !text-[13px]"
          >
            <option value="">All sprints</option>
            {sprintsFor.length > 0 && (
              <optgroup label={`${sprintPrefix} sprints`}>
                {sprintsFor.map((sp) => <option key={sp.id} value={String(sp.id)}>{sprintLabel(sp)}</option>)}
              </optgroup>
            )}
            <optgroup label={sprintsFor.length > 0 ? "Other sprints" : "Sprints"}>
              {sprintsOther.map((sp) => <option key={sp.id} value={String(sp.id)}>{sprintLabel(sp)}</option>)}
            </optgroup>
          </select>
        </label>
        <button type="submit" disabled={loading || !query.fixVersion} className="ds-btn-primary">
          <svg className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          {loading ? "Fetching…" : "Refresh from Jira"}
        </button>
      </form>

      {error && (
        <div role="alert" className="flex items-start justify-between gap-3 rounded-xl border border-red-500/15 bg-red-500/[0.06] px-4 py-3 text-sm text-red-300">
          <span>{error}</span>
          <button onClick={() => setError(null)} aria-label="Dismiss" className="text-red-300/60 hover:text-red-200">✕</button>
        </div>
      )}

      {/* Loading skeleton */}
      {loading && !tickets && (
        <div className="space-y-5" aria-busy>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            {Array.from({ length: 5 }).map((_, i) => <div key={i} className="ds-card h-[116px] animate-pulse" />)}
          </div>
          <div className="ds-card divide-y divide-white/[0.04]">
            {Array.from({ length: 7 }).map((_, i) => <div key={i} className="h-12 animate-pulse" />)}
          </div>
        </div>
      )}

      {tickets && (
        <>
          {/* Coverage at a glance — each tile also filters the table */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Tile
              label="Tickets" value={stats.total}
              note={shown.length === stats.total ? "In this release" : `${shown.length} shown · click to show all`}
              segments={[{ pct: 100, color: "bg-indigo-400/60" }]}
              active={false} onClick={clearFilters}
            />
            <Tile
              label="TC ticket linked" value={stats.withTc} of={stats.total}
              note={`${stats.total - stats.withTc} missing · click to list`}
              segments={[{ pct: pct(stats.withTc), color: "bg-emerald-400/80" }]}
              active={slice === "no-tc"} onClick={() => toggleSlice("no-tc")}
            />
            <Tile
              label="Generated TCs" value={stats.generated} of={stats.total}
              note={`${stats.total - stats.generated} still to generate`}
              segments={[
                { pct: pct(stats.generated), color: "bg-emerald-400/80" },
                { pct: pct(stats.generatedWip), color: "bg-amber-400/80" },
              ]}
              active={slice === "no-generated"} onClick={() => toggleSlice("no-generated")}
            />
            <Tile
              label="Validated in device" value={stats.validated} of={stats.total}
              note={`${stats.total - stats.validated} not validated · click to list`}
              segments={[
                { pct: pct(stats.validated), color: "bg-emerald-400/80" },
                { pct: pct(stats.validatedPartial), color: "bg-amber-400/80" },
                { pct: pct(stats.validatedNo), color: "bg-red-400/70" },
              ]}
              active={slice === "not-validated"} onClick={() => toggleSlice("not-validated")}
            />
            <Tile
              label="Included in runs" value={stats.inRuns} of={stats.total}
              note={`${stats.total - stats.inRuns} not in a run yet`}
              segments={[{ pct: pct(stats.inRuns), color: "bg-sky-400/80" }]}
              active={slice === "no-runs"} onClick={() => toggleSlice("no-runs")}
            />
          </div>

          <div className="ds-card overflow-hidden">
            {/* Title row */}
            <div className="ds-card-header flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <div className="flex items-center gap-3">
                <h3 className="text-sm font-semibold text-gray-200">All tickets</h3>
                <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[11px] font-medium tabular-nums text-gray-400">
                  {filtered ? `${shown.length} of ${stats.total}` : stats.total}
                </span>
              </div>
              <div
                className="flex items-center gap-2 text-[11.5px] text-gray-500"
                title="Team status refreshes every 10 seconds. Jira is only queried when you click Refresh from Jira."
              >
                <span className="relative flex h-2 w-2">
                  {syncOk && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400/60" />}
                  <span className={`relative inline-flex h-2 w-2 rounded-full ${syncOk ? "bg-emerald-400" : "bg-amber-400"}`} />
                </span>
                {syncOk ? "Live" : "Reconnecting…"}
                {lastSync && <span className="text-gray-600">· synced {ago(new Date(lastSync).toISOString(), now)}</span>}
              </div>
            </div>

            {/* Filters */}
            <div className="flex flex-wrap items-center gap-2.5 border-b border-white/[0.05] px-4 py-3">
              <div className="relative min-w-[240px] flex-1">
                <svg className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
                </svg>
                <input
                  value={search} onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search key, summary, assignee, label…" aria-label="Search tickets"
                  className="ds-input w-full !rounded-full !py-2 !pl-10 !text-[13px]"
                />
              </div>
              <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Type" className="ds-input !rounded-full !py-2 !text-[13px]">
                <option value="">All types</option>
                {types.map((t) => <option key={t}>{t}</option>)}
              </select>
              <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status" className="ds-input !rounded-full !py-2 !text-[13px]">
                <option value="">All statuses</option>
                {jiraStatuses.map((s) => <option key={s}>{s}</option>)}
              </select>
              {filtered && (
                <button onClick={clearFilters} className="rounded-full px-3 py-1.5 text-[12px] font-medium text-indigo-300 transition-colors hover:bg-indigo-500/10">
                  Clear filters
                </button>
              )}
            </div>

            {/* Table */}
            <div className="max-h-[68vh] overflow-auto">
              {shown.length === 0 ? (
                <div className="ds-empty !border-0">
                  <p className="text-[15px] font-medium text-gray-400">No tickets match</p>
                  <button onClick={clearFilters} className="ds-btn-secondary mt-1">Clear filters</button>
                </div>
              ) : (
                <table className="ds-table min-w-[1200px]">
                  <thead>
                    <tr className="!border-b-0">
                      <th colSpan={8} className="!px-3 !pb-0 !pt-2.5 !text-[10.5px] !font-semibold uppercase tracking-wider text-gray-600">
                        From Jira
                      </th>
                      <th colSpan={4} className="!px-3 !pb-0 !pt-2.5 !text-[10.5px] !font-semibold uppercase tracking-wider text-indigo-300/80 bg-indigo-500/[0.06]">
                        <span className="inline-flex items-center gap-1.5">
                          <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z" />
                          </svg>
                          Team status · editable, shared live
                        </span>
                      </th>
                    </tr>
                    <tr>
                      <Th label="Key" col="key" sort={sort} onSort={toggleSort} className="!pl-4" />
                      <Th label="Summary" sort={sort} />
                      <Th label="Type" sort={sort} />
                      <Th label="Status" col="status" sort={sort} onSort={toggleSort} />
                      <Th label="Resolution" sort={sort} />
                      <Th label="Assignee" col="assignee" sort={sort} onSort={toggleSort} />
                      <Th label="Labels" sort={sort} />
                      <Th label="TC ticket" col="tc" sort={sort} onSort={toggleSort} />
                      <Th label="Generated TCs" col="generated" sort={sort} onSort={toggleSort} className="bg-indigo-500/[0.06]" />
                      <Th label="Validated in device" col="validated" sort={sort} onSort={toggleSort} className="bg-indigo-500/[0.06]" />
                      <Th label="Included in runs" sort={sort} className="bg-indigo-500/[0.06]" />
                      <Th label="Last edit" sort={sort} className="bg-indigo-500/[0.06]" />
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((t) => {
                      const st = teamStatus[t.key];
                      const v = st?.validated ?? "";
                      // A thin bar down the left edge: green once validated, amber part-way, red if no TC ticket.
                      const rail =
                        v === "Yes" ? "bg-emerald-400/70"
                        : v === "Partial" || st?.generated_tcs === "In progress" ? "bg-amber-400/70"
                        : t.tc_tickets.length === 0 ? "bg-red-400/50"
                        : "bg-transparent";
                      return (
                        <tr key={t.key} className={`align-middle ${flash.has(t.key) ? "rt-flash" : ""}`}>
                          <td className="relative whitespace-nowrap !px-3 !pl-4">
                            <span className={`absolute inset-y-1.5 left-0 w-[3px] rounded-r ${rail}`} aria-hidden />
                            <a href={`${JIRA_BASE}/browse/${t.key}`} target="_blank" rel="noreferrer" className="font-medium text-indigo-300 hover:text-indigo-200 hover:underline">
                              {t.key}
                            </a>
                          </td>
                          <td className="!px-3">
                            <p className="line-clamp-2 min-w-[220px] max-w-[340px] text-[13px] leading-snug text-gray-200" title={t.summary}>
                              {t.summary}
                            </p>
                          </td>
                          <td className="!px-3"><Pill className={TYPE_STYLE[t.issue_type] ?? "bg-white/[0.05] text-gray-300 ring-white/[0.08]"}>{t.issue_type}</Pill></td>
                          <td className="!px-3"><Pill className={statusStyle(t.status)}>{t.status}</Pill></td>
                          <td className="!px-3 text-[12.5px] text-gray-400">{t.resolution || <Dash />}</td>
                          <td className="whitespace-nowrap !px-3 text-[12.5px]">
                            {t.assignee ? (
                              <span className="inline-flex items-center gap-2 text-gray-300"><Avatar name={t.assignee} />{t.assignee}</span>
                            ) : (
                              <span className="text-gray-600">Unassigned</span>
                            )}
                          </td>
                          <td className="!px-3">
                            {t.labels.length === 0 ? <Dash /> : (
                              <div className="flex max-w-[180px] flex-wrap gap-1">
                                {t.labels.map((l) => (
                                  <span key={l} className="rounded bg-white/[0.05] px-1.5 py-0.5 text-[10.5px] text-gray-400">{l}</span>
                                ))}
                              </div>
                            )}
                          </td>
                          <td className="!px-3">
                            {t.tc_tickets.length === 0 ? (
                              <Pill className="bg-red-500/10 text-red-300 ring-red-500/25">Missing</Pill>
                            ) : (
                              <div className="flex flex-col gap-0.5 text-[12.5px]">
                                {t.tc_tickets.map((k) => (
                                  <a key={k} href={`${JIRA_BASE}/browse/${k}`} target="_blank" rel="noreferrer" className="text-indigo-300 hover:text-indigo-200 hover:underline">{k}</a>
                                ))}
                              </div>
                            )}
                          </td>
                          <td className="!px-3 bg-indigo-500/[0.03]">
                            <StatusSelect ticket={t.key} field="generated_tcs" label="Generated TCs" choices={GENERATED_CHOICES} value={field(t.key, "generated_tcs")} onSave={save} />
                          </td>
                          <td className="!px-3 bg-indigo-500/[0.03]">
                            <StatusSelect ticket={t.key} field="validated" label="Validated in device" choices={VALIDATED_CHOICES} value={field(t.key, "validated")} onSave={save} />
                          </td>
                          <td className="!px-3 bg-indigo-500/[0.03]">
                            <StatusText ticket={t.key} field="included_in_runs" label="Included in runs" placeholder="Add runs…" value={field(t.key, "included_in_runs")} onSave={save} onEditing={markEditing} />
                          </td>
                          <td className="whitespace-nowrap !px-3 bg-indigo-500/[0.03] text-[11.5px] text-gray-500">
                            {st?.updated_by || st?.updated_at ? (
                              <span className="inline-flex items-center gap-1.5" title={st.updated_at ? new Date(st.updated_at).toLocaleString() : ""}>
                                {st.updated_by && <Avatar name={st.updated_by} />}
                                <span className="flex flex-col leading-tight">
                                  {st.updated_by && <span className="text-gray-400">{st.updated_by}</span>}
                                  <span className="text-[10.5px] text-gray-600">{ago(st.updated_at, now)}</span>
                                </span>
                              </span>
                            ) : (
                              <Dash />
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            {/* Footer: the query behind the table, for comparing with Jira */}
            {jql && (
              <details className="border-t border-white/[0.05] px-4 py-2.5 text-[11.5px] text-gray-600">
                <summary className="cursor-pointer select-none transition-colors hover:text-gray-400">Show the Jira query behind this list</summary>
                <p className="mt-2 select-all rounded-lg bg-black/20 px-3 py-2 font-mono text-gray-400">{jql}</p>
              </details>
            )}
          </div>
        </>
      )}

      {!tickets && !error && !loading && (
        <div className="ds-card ds-empty">
          <p className="mb-1 text-[15px] font-medium text-gray-400">No release loaded</p>
          <p className="max-w-sm text-sm text-gray-600">
            Choose a fix version, and optionally a sprint, to list its tickets from Jira.
          </p>
        </div>
      )}
    </div>
  );
}
