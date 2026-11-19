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

/** A Claude job behind one of the team-status columns. Runs on a workstation worker. */
type Stage = "generate" | "validate" | "include" | "regenerate" | "remove";
interface TcJob {
  id: string;
  dt: string;
  stage: Stage;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  message: string;
  actor: string;
  worker: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  params: { device_id?: string; unfixed_device_id?: string; branch?: string; target?: string };
  result: { outcome?: string; summary?: string; testcases?: string[]; branch?: string; covered_by?: string; remaining?: string[];
    reason?: string; reason_category?: string; corrections?: { testcase: string; what: string; why: string }[];
    changed_files?: string[]; reverted_files?: string[];
    state?: { fixed: boolean; unfixed: boolean }; fixed_result?: string; unfixed_result?: string };
  cancel_requested: boolean;
  log?: string;
  log_end?: number;
}
type JobMap = Record<string, Partial<Record<Stage, TcJob>>>;
interface TcRequirements {
  runs_on: string[]; na_on: string[]; needs: string[]; notes: string[]; testcases: string[];
  fixed_build: string; unfixed_build: string;
  device_checks?: { what: string; fixed: string; unfixed: string }[];
  pr_snapshot?: Record<string, string>; pr_snapshot_at?: string;
  pr_coverage?: Record<string, { used: boolean | null; why: string; by: string }>;
  pr_new_commits?: { pr: string; before: string; now: string }[];
  validation?: Record<string, { status: string; fixed_device: string; unfixed_device: string }>;
}
/** How one testcase stands: fully validated needs a pass with the fix AND the failure without it. */
const VSTATUS: Record<string, { label: string; mark: string; chip: string }> = {
  yes: { label: "Fully validated", mark: "✓", chip: "bg-emerald-500/15 text-emerald-200 ring-emerald-400/35 hover:bg-emerald-500/25" },
  partial: { label: "Partially validated", mark: "½", chip: "bg-amber-500/15 text-amber-200 ring-amber-400/35 hover:bg-amber-500/25" },
  failed: { label: "Failed with the fix", mark: "✕", chip: "bg-red-500/15 text-red-200 ring-red-400/35 hover:bg-red-500/25" },
  na: { label: "NA on the devices tried", mark: "NA", chip: "bg-white/[0.06] text-gray-300 ring-white/[0.15] hover:bg-white/[0.1]" },
  not_run: { label: "Not validated yet", mark: "–", chip: "bg-indigo-500/10 text-indigo-200 ring-indigo-400/25 hover:bg-indigo-500/20" },
};
function vTitle(file: string, v?: { status: string; fixed_device: string; unfixed_device: string }): string {
  const st = VSTATUS[v?.status ?? "not_run"] ?? VSTATUS.not_run;
  return `${tcId(file)}: ${st.label}\nWith the fix: ${v?.fixed_device ? `passed on ${v.fixed_device}` : "not shown"}\n` +
    `Without the fix: ${v?.unfixed_device ? `failed as it should on ${v.unfixed_device}` : "not shown"}\nClick to open the testcase`;
}
/** The two halves of a testcase's validation: post-fix (passes on a device WITH the fix) and
 *  pre-fix (fails as it should on a device WITHOUT it). */
function halves(v?: { fixed_device: string; unfixed_device: string; status?: string }) {
  return { post: !!v?.fixed_device, pre: !!v?.unfixed_device, failed: v?.status === "failed", na: v?.status === "na" };
}
const halfMark = (done: boolean, failed = false) => (done ? "✓" : failed ? "✕" : "–");
const halfCls = (done: boolean, failed = false) => (done ? "text-emerald-300" : failed ? "text-red-300" : "text-gray-500");
function halfCount(names: string[], val: TcRequirements["validation"]) {
  const h = names.map((f) => halves(val?.[f]));
  return { post: h.filter((x) => x.post).length, pre: h.filter((x) => x.pre).length, total: names.length };
}
/** PRs whose status changed (or that were linked) since the testcases were generated: the testcases may no longer
 *  match the fix. Compares the snapshot taken at the last Generate / Regenerate with Jira's list now. */
interface PrChange { key: string; before: string; now: string }
function prChanges(snapshot: Record<string, string> | undefined, prs: PullRequest[] | null | undefined): PrChange[] {
  if (!snapshot || !Object.keys(snapshot).length || !prs) return [];
  const out: PrChange[] = [];
  for (const p of prs) {
    const key = `${p.repo}${p.id}`, before = snapshot[key];
    if (before === undefined) out.push({ key, before: "", now: p.status });
    else if (before !== p.status) out.push({ key, before, now: p.status });
  }
  return out;
}
const prChangeText = (c: PrChange) =>
  `${c.key}: ${c.before ? (PR_LABEL[c.before] ?? c.before).toLowerCase() : "not linked"} → ${(PR_LABEL[c.now] ?? c.now).toLowerCase()}`;
/** Whether the testcases were built from this PR. `used` comes from Claude's own list (`by: claude`); for older tickets only
 *  the evidence bundle is known, which can say "its diff was read" but never "it was left out". */
function PrUsed({ cov, status }: { cov?: { used: boolean | null; why: string; by: string }; status: string }) {
  if (!cov || cov.used === null) return null;
  const tip = cov.used
    ? `The testcases were built from this PR.${cov.why ? `\n${cov.why}` : ""}`
    : `Not in the testcases.${cov.why ? `\n${cov.why}` : ""}${status === "OPEN" ? "\nStill open: regenerate after it merges." : ""}`;
  const cls = cov.used ? "bg-emerald-500/15 text-emerald-200 ring-emerald-400/35"
    : status === "DECLINED" ? "bg-white/[0.05] text-gray-400 ring-white/[0.1]" : "bg-amber-500/15 text-amber-200 ring-amber-400/35";
  return <span title={tip} className={`whitespace-nowrap rounded px-1 py-px text-[10px] ring-1 ring-inset ${cls}`}>{cov.used ? "✓ in TCs" : "✕ not in TCs"}</span>;
}
/** Everything that may have made the testcases stale: a PR whose status changed, and an open PR that got new commits. */
function prAlerts(req: TcRequirements | undefined, prs: PullRequest[] | null | undefined): { lines: string[]; short: string[] } {
  const ch = prChanges(req?.pr_snapshot, prs), cm = req?.pr_new_commits ?? [];
  return {
    lines: [...ch.map(prChangeText), ...cm.map((c) => `${c.pr}: new commits since generated (${c.before} → ${c.now})`)],
    short: [...ch.map((c) => `${c.key} ${(PR_LABEL[c.now] ?? c.now).toLowerCase()}`), ...cm.map((c) => `${c.pr} new commits`)],
  };
}
interface WorkerState { online: boolean; name: string; last_seen: string }
type Panel = { kind: "start"; stage: Stage; dt: string } | { kind: "job"; id: string };

const STAGE_LABEL: Record<Stage, string> = {
  generate: "Generate TCs", validate: "Validate in device", include: "Include in runs",
  regenerate: "Regenerate after merge", remove: "Remove from branch",
};
const runsList = (text: string) => text.split(",").map((b) => b.trim()).filter(Boolean);
const RUN = "__run";
const RUN2 = "__run2";
const isActive = (j?: TcJob) => j?.status === "queued" || j?.status === "running";
/** The bug-regression skill handles these two Jira projects only. */
const canRunClaude = (key: string) => /^(DT|OCTO)-\d+$/.test(key);

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

interface PullRequest {
  id: string;
  title: string;
  url: string;
  status: string; // OPEN | MERGED | DECLINED | …
  repo: string;
  author: string;
  target: string;
}

const PR_STYLE: Record<string, string> = {
  MERGED: "bg-violet-500/10 text-violet-300 ring-violet-500/25",
  OPEN: "bg-emerald-500/10 text-emerald-300 ring-emerald-500/25",
  DECLINED: "bg-red-500/10 text-red-300 ring-red-500/25",
  DRAFT: "bg-amber-500/10 text-amber-300 ring-amber-500/25",
};
/** undefined: still loading · null: Jira could not report PRs · []: none. */
type PrMap = Record<string, PullRequest[] | null | undefined>;

type PrFilter = "" | "has" | "none" | "any-merged" | "all-merged" | "open";
const PR_FILTERS: { value: PrFilter; label: string }[] = [
  { value: "", label: "All PRs" },
  { value: "has", label: "Has a PR" },
  { value: "any-merged", label: "At least one PR merged" },
  { value: "none", label: "No PR" },
  { value: "all-merged", label: "All PRs merged" },
  { value: "open", label: "Open / draft PR" },
];

function matchesPr(prs: PullRequest[] | null | undefined, f: PrFilter): boolean {
  if (!f) return true;
  if (!prs) return false; // not loaded or unavailable: can't claim a match
  switch (f) {
    case "has": return prs.length > 0;
    case "none": return prs.length === 0;
    case "any-merged": return prs.some((p) => p.status === "MERGED");
    case "all-merged": return prs.length > 0 && prs.every((p) => p.status === "MERGED");
    case "open": return prs.some((p) => p.status === "OPEN" || p.status === "DRAFT");
  }
}

// Filters live in the address bar so a link or a refresh reopens the same view.
const URL_KEYS = { search: "rt_q", status: "rt_status", type: "rt_type", slice: "rt_tile", pr: "rt_pr", version: "rt_v", sprint: "rt_s" } as const;
function urlParam(name: string): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get(name) ?? "";
}
const SLICES: Slice[] = ["has-tc", "generated", "validated", "in-runs"];
const PR_VALUES = PR_FILTERS.map((f) => f.value);

const PR_LABEL: Record<string, string> = { MERGED: "Merged", OPEN: "Open", DECLINED: "Closed", DRAFT: "Draft" };

interface VersionOption { id: string; name: string; released: boolean }
interface SprintOption { id: number; name: string; state: string }

interface Query {
  fixVersion: string;
  project: string;
  sprint: string;
}

/** Which slice of the table a stat tile is showing. */
type Slice = "" | "has-tc" | "generated" | "validated" | "in-runs";

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
  ticket, field, value, choices, label, onSave, run, run2,
}: {
  ticket: string; field: StatusField; value: string; choices: string[]; label: string; onSave: Save;
  /** Adds a "run with Claude" entry. `blocked` says why it cannot start yet. */
  run?: { label: string; blocked?: string; onRun: () => void };
  /** A second action in the same dropdown (regenerate after merge). */
  run2?: { label: string; blocked?: string; onRun: () => void };
}) {
  return (
    <span className="relative inline-flex">
      <select
        value={value}
        aria-label={`${label} for ${ticket}`}
        onChange={(e) =>
          e.target.value === RUN ? run?.onRun()
          : e.target.value === RUN2 ? run2?.onRun()
          : onSave(ticket, field, e.target.value)}
        className={`cursor-pointer appearance-none rounded-full py-1 pl-2.5 pr-6 text-[11.5px] font-medium ring-1 ring-inset outline-none transition-colors focus-visible:ring-2 focus-visible:ring-indigo-400/60 ${
          CHOICE_STYLE[value] ?? EMPTY_CHOICE
        }`}
      >
        <option value="">Set…</option>
        {choices.map((c) => <option key={c}>{c}</option>)}
        {run && (
          <option value={RUN} disabled={!!run.blocked}>
            {run.blocked ? `▶ ${run.label} (${run.blocked})` : `▶ ${run.label}`}
          </option>
        )}
        {run2 && (
          <option value={RUN2} disabled={!!run2.blocked}>
            {run2.blocked ? `↻ ${run2.label} (${run2.blocked})` : `↻ ${run2.label}`}
          </option>
        )}
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

/** Shown in a cell in place of the dropdown while its Claude job is queued or running. */
/** "45 s", "3 min 7 s", "1 h 5 min". */
function fmtDuration(totalSec: number): string {
  const t = Math.max(0, Math.round(totalSec));
  if (t < 60) return `${t} s`;
  const m = Math.floor(t / 60), sec = t % 60;
  if (m < 60) return sec ? `${m} min ${sec} s` : `${m} min`;
  const h = Math.floor(m / 60), mm = m % 60;
  return mm ? `${h} h ${mm} min` : `${h} h`;
}

/** Re-renders every second while `on`, so a running job's clock moves. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [on]);
  return now;
}

/** How long a job has run, or took: queued jobs show the wait, running ones the live time, finished ones the total. */
function jobTime(job: TcJob, now: number): { text: string; waited: string } {
  const created = Date.parse(job.created_at), started = job.started_at ? Date.parse(job.started_at) : NaN;
  const finished = job.finished_at ? Date.parse(job.finished_at) : NaN;
  const waited = !Number.isNaN(started) && started - created >= 10_000 ? fmtDuration((started - created) / 1000) : "";
  if (job.status === "queued") return { text: `waiting ${fmtDuration((now - created) / 1000)}`, waited: "" };
  const from = Number.isNaN(started) ? created : started;
  if (job.status === "running") return { text: fmtDuration((now - from) / 1000), waited };
  if (Number.isNaN(finished)) return { text: "", waited };
  return { text: fmtDuration((finished - from) / 1000), waited };
}

function JobChip({ job, onOpen }: { job: TcJob; onOpen: () => void }) {
  const now = useNow(true);
  const time = jobTime(job, now).text;
  return (
    <button
      onClick={onOpen}
      title="Open the Claude job log"
      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-indigo-500/15 px-2.5 py-1 text-[11.5px] font-medium text-indigo-200 ring-1 ring-inset ring-indigo-400/30 transition-colors hover:bg-indigo-500/25"
    >
      <span className={`h-2 w-2 rounded-full bg-indigo-300 ${job.status === "running" ? "animate-pulse" : "opacity-50"}`} />
      {job.status === "queued" ? "Queued" : job.cancel_requested ? "Stopping…" : "Claude running…"}
      {time && <span className="font-normal tabular-nums text-indigo-200/70">{job.status === "queued" ? "" : time}</span>}
    </button>
  );
}

/** A small mark next to a cell for its last finished Claude job. Opens the result and log. */
/** "N open" beside a validated value: what the last validation left unverified, and whether somebody accepted it. */
function OpenMark({ job, value, by, onOpen }: { job?: TcJob; value: string; by?: string; onOpen: () => void }) {
  const n = job?.status === "done" && ["Yes", "Partial"].includes(value) ? job.result.remaining?.length ?? 0 : 0;
  if (!n) return null;
  return (
    <button
      onClick={onOpen}
      title={by ? `${n} open item(s) from the last validation, accepted by ${by}. Click to read them.`
                : `${n} item(s) the last validation did not verify. Click to read them. Including the testcases needs them accepted.`}
      className={`ml-1 whitespace-nowrap rounded-full px-1.5 py-0.5 text-[10.5px] ring-1 ring-inset transition-colors ${
        by ? "text-gray-300 ring-white/[0.15] hover:bg-white/[0.06]" : "text-amber-200 ring-amber-500/40 hover:bg-amber-500/15"}`}
    >
      {n} open{by ? " · accepted" : ""}
    </button>
  );
}

function JobMark({ job, onOpen }: { job?: TcJob; onOpen: () => void }) {
  if (!job || isActive(job)) return null;
  const ok = job.status === "done";
  // Finished, but with nothing written: already covered, not testable, PRs not merged, still correct.
  const quiet = ok && ["covered", "not_testable", "not_merged", "unchanged", "inconclusive"].includes(job.result.outcome ?? "");
  return (
    <button
      onClick={onOpen}
      title={`Last Claude job ${ok ? "finished" : job.status}${jobTime(job, 0).text ? ` after ${jobTime(job, 0).text}` : ""}${job.message ? `: ${job.message}` : ""}`}
      aria-label={`Last Claude job for ${job.dt}: ${job.status}`}
      className={`ml-1 inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] ring-1 ring-inset transition-colors ${
        quiet ? "text-gray-300 ring-white/[0.15] hover:bg-white/[0.06]"
        : ok ? "text-emerald-300 ring-emerald-500/30 hover:bg-emerald-500/15" : "text-red-300 ring-red-500/30 hover:bg-red-500/15"
      }`}
    >
      {quiet ? "i" : ok ? "✓" : "!"}
    </button>
  );
}

const PROTECTED = ["main", "master"];   // the testcases are never pushed straight into these
type Mode = "fixed" | "unfixed" | "both";
const FIXED_KEY = "perda.tc.fixedDevice";
const UNFIXED_KEY = "perda.tc.unfixedDevice";
const savedDevice = (key: string) => { try { return localStorage.getItem(key) ?? ""; } catch { return ""; } };
const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: "fixed", label: "Device with the fix", hint: "Shows the testcase passes. Gives Partial until the other half is shown." },
  { id: "unfixed", label: "Device without the fix", hint: "Shows the testcase fails where the bug is present. Completes an earlier fixed-device pass to Yes." },
  { id: "both", label: "Both", hint: "Both devices in one run." },
];

const tcId = (file: string) => file.match(/^(TC_[A-Za-z0-9]+?)(?:_|\.py)/)?.[1] ?? file.replace(/\.py$/, "");

/** Opens one generated testcase file, as the workstation worker last sent it. */
function TcViewer({ dt, name, onClose }: { dt: string; name: string; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let stop = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/tc-files/${encodeURIComponent(dt)}/${encodeURIComponent(name)}`);
        const body = await res.json().catch(() => ({}));
        if (stop) return;
        if (!res.ok) setErr(body.detail || `Could not load the testcase (${res.status}).`);
        else setText(body.content ?? "");
      } catch { if (!stop) setErr("Could not reach the backend."); }
    })();
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", esc);
    return () => { stop = true; window.removeEventListener("keydown", esc); };
  }, [dt, name, onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label={`Testcase ${tcId(name)} of ${dt}`} className="ds-card flex max-h-[88vh] w-full max-w-4xl flex-col overflow-hidden">
        <div className="ds-card-header flex items-center justify-between gap-3">
          <h3 className="min-w-0 text-sm font-semibold text-gray-100">
            {tcId(name)} <span className="font-normal text-gray-500">· {dt}</span>
            <span className="mt-0.5 block break-all font-mono text-[11px] font-normal text-gray-500">{name}</span>
          </h3>
          <div className="flex shrink-0 items-center gap-2">
            {text !== null && (
              <button onClick={() => { navigator.clipboard?.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
                className="rounded-lg px-2.5 py-1 text-[12px] text-gray-300 ring-1 ring-inset ring-white/[0.12] hover:bg-white/[0.06]">{copied ? "Copied" : "Copy"}</button>
            )}
            <button onClick={onClose} aria-label="Close" className="rounded-lg px-2.5 py-1 text-[13px] text-gray-400 hover:bg-white/[0.06]">✕</button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {err ? <p className="text-[12.5px] text-amber-300">{err}</p>
            : text === null ? <p className="text-[12.5px] text-gray-500">Loading…</p>
            : <pre className="whitespace-pre font-mono text-[11.5px] leading-relaxed text-gray-300">{text}</pre>}
        </div>
      </div>
    </div>
  );
}

const INPUT = "w-full rounded-lg border border-white/[0.1] bg-black/20 px-3 py-2 text-[13px] text-gray-100 outline-none placeholder:text-gray-600 focus:border-indigo-400/60";

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[12px] font-medium text-gray-300">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11.5px] text-gray-500">{hint}</span>}
    </label>
  );
}

/** The form that starts a stage, or the live view of a job. */
function JobPanel({
  panel, lastGenerate, lastValidate, acceptedBy, req, includedIn, prs, worker, onClose, onStarted,
}: {
  panel: Panel; lastGenerate?: TcJob; lastValidate?: TcJob; acceptedBy?: string; req?: TcRequirements; includedIn?: string[]; prs?: PullRequest[] | null; worker: WorkerState | null;
  onClose: () => void; onStarted: (job: TcJob) => void;
}) {
  const [job, setJob] = useState<TcJob | null>(null);
  const [log, setLog] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lastState = lastValidate?.status === "done" ? lastValidate.result.state : undefined;
  const [form, setForm] = useState(() => ({
    // Device IDs are remembered in this browser (never the passwords). The mode starts on the half still missing.
    mode: (lastState?.fixed && !lastState.unfixed ? "unfixed" : !lastState?.fixed && lastState?.unfixed ? "fixed" : "both") as Mode,
    device_id: savedDevice(FIXED_KEY), device_password: "", unfixed_device_id: savedDevice(UNFIXED_KEY), unfixed_device_password: "",
    branch: panel.kind === "start" && panel.stage === "remove" ? (includedIn?.[0] ?? "") : "", target: "existing" as "existing" | "new",
    confirm_push: false, confirm_remove: false, name_mode: "generated" as "generated" | "custom", new_branch: "", reviewed: false, accept_gaps: false, skip_device_checks: false,
  }));
  const logBox = useRef<HTMLPreElement>(null);
  const jobId = panel.kind === "job" ? panel.id : null;

  // Follow the job: new log text is fetched from where the last fetch ended.
  useEffect(() => {
    if (!jobId) return;
    let end = 0;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const res = await fetch(`${API_BASE}/tc-jobs/${jobId}?after=${end}`);
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.detail ?? `HTTP ${res.status}`);
        if (stop) return;
        end = body.log_end ?? end;
        if (body.log) setLog((l) => l + body.log);
        setJob(body);
        setError(null);
        if (!isActive(body)) return;
      } catch (e) {
        if (!stop) setError(e instanceof Error ? e.message : "Could not load the job");
      }
      if (!stop) timer = setTimeout(tick, 2500);
    };
    tick();
    return () => { stop = true; clearTimeout(timer); };
  }, [jobId]);

  useEffect(() => {
    const el = logBox.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const start = async () => {
    if (panel.kind !== "start") return;
    let name = savedName();
    if (!name) {
      name = (window.prompt("Your name — shown next to your edits:") ?? "").trim();
      if (name) { try { localStorage.setItem(NAME_KEY, name); } catch { /* not remembered */ } }
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/tc-jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dt: panel.dt, stage: panel.stage, actor: name, ...form,
          // Only the devices of the chosen mode, with their own passwords.
          ...(panel.stage === "validate" ? {
            device_id: form.mode === "unfixed" ? "" : form.device_id.trim(),
            device_password: form.mode === "unfixed" ? "" : form.device_password,
            unfixed_device_id: form.mode === "fixed" ? "" : form.unfixed_device_id.trim(),
            unfixed_device_password: form.mode === "fixed" ? "" : form.unfixed_device_password,
          } : {}),
          ...(panel.stage === "include" ? {
            new_branch: form.target === "new" && form.name_mode === "custom" ? form.new_branch.trim() : "",
          } : {}),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof body.detail === "string" ? body.detail : `Could not start (HTTP ${res.status})`);
      if (panel.stage === "validate") {
        try {
          if (form.mode !== "unfixed") localStorage.setItem(FIXED_KEY, form.device_id.trim());
          if (form.mode !== "fixed") localStorage.setItem(UNFIXED_KEY, form.unfixed_device_id.trim());
        } catch { /* not remembered */ }
      }
      onStarted(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start the job");
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!job) return;
    try {
      const res = await fetch(`${API_BASE}/tc-jobs/${job.id}/cancel`, { method: "POST" });
      if (res.ok) setJob({ ...(await res.json()), log: undefined });
    } catch { /* the next poll shows the real state */ }
  };

  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const stage = panel.kind === "start" ? panel.stage : job?.stage;
  const dt = panel.kind === "start" ? panel.dt : job?.dt;
  const openGaps = lastValidate?.status === "done" && !acceptedBy ? lastValidate.result.remaining ?? [] : [];
  const ready =
    panel.kind === "start" &&
    (panel.stage === "generate" || panel.stage === "regenerate" ||
      (panel.stage === "validate" && form.reviewed &&
        (form.mode === "unfixed" || (form.device_id.trim() && form.device_password)) &&
        (form.mode === "fixed" || (form.unfixed_device_id.trim() && form.unfixed_device_password))) ||
      (panel.stage === "remove" && form.branch.trim() && form.confirm_remove) ||
      (panel.stage === "include" && form.branch.trim() && (!openGaps.length || form.accept_gaps) &&
        (form.target === "new" ? (form.name_mode === "generated" || !!form.new_branch.trim()) : (form.confirm_push && !PROTECTED.includes(form.branch.trim().replace(/^origin\//, "").toLowerCase())))));
  const now = useNow(isActive(job ?? undefined));
  const clock = job ? jobTime(job, now) : { text: "", waited: "" };
  const STATUS_STYLE: Record<string, string> = {
    queued: "bg-white/[0.06] text-gray-300 ring-white/[0.1]",
    running: "bg-indigo-500/15 text-indigo-200 ring-indigo-400/30",
    done: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
    failed: "bg-red-500/15 text-red-300 ring-red-500/30",
    cancelled: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label={stage ? `${STAGE_LABEL[stage]} for ${dt}` : "Claude job"}
        className={`ds-card flex max-h-[88vh] w-full flex-col overflow-hidden ${panel.kind === "job" ? "max-w-3xl" : "max-w-md"}`}>
        <div className="ds-card-header flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-gray-100">
            {stage ? STAGE_LABEL[stage] : "Claude job"} <span className="font-normal text-gray-500">· {dt}</span>
          </h3>
          <div className="flex items-center gap-2">
            {job && <Pill className={STATUS_STYLE[job.status]}>{job.status === "running" && job.cancel_requested ? "stopping" : job.status}</Pill>}
            {job && clock.text && <span className="whitespace-nowrap text-[12px] tabular-nums text-gray-400" title="Time from when the worker started the job until it finished">{job.status === "queued" ? clock.text : job.status === "running" ? `running ${clock.text}` : `took ${clock.text}`}</span>}
            <button onClick={onClose} aria-label="Close" className="rounded-md px-2 py-1 text-gray-500 hover:bg-white/[0.06] hover:text-gray-200">✕</button>
          </div>
        </div>

        {panel.kind === "start" && (
          <div className="space-y-4 overflow-y-auto p-4">
            {worker && !worker.online && (
              <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-[12px] text-amber-200 ring-1 ring-inset ring-amber-500/25">
                No worker is running. The job will wait in the queue until tc_worker.py is started on the workstation.
              </p>
            )}
            {panel.stage === "generate" && (
              <p className="text-[13px] leading-relaxed text-gray-400">
                Claude runs the bug-regression skill for {panel.dt}: it reads the ticket and its pull requests, writes the
                testcases and checks them. Nothing is deployed or run on a device.
              </p>
            )}
            {panel.stage === "regenerate" && (
              <p className="text-[13px] leading-relaxed text-gray-400">
                Claude re-checks the existing testcases for {panel.dt} against the fix as it is now, and changes only what the
                merged code makes wrong or incomplete. If something changes, <span className="text-gray-200">Validated in device
                is cleared</span>, because the earlier device run was of the old testcases. If the PRs are still open, or the
                testcases are still right, nothing changes. If the job does not finish, the testcase files are put back.
                {prs && prs.length > 0 && (
                  <span className="mt-2 block text-[12px] text-gray-500">
                    Pull requests: {prs.map((p) => `${p.repo}${p.id} ${(PR_LABEL[p.status] ?? p.status).toLowerCase()}`).join(" · ")}
                  </span>
                )}
              </p>
            )}
            {panel.stage === "validate" && (
              <>
                {!!prs?.some((p) => p.status === "OPEN" || p.status === "DRAFT") && (
                  <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-[12px] text-amber-200 ring-1 ring-inset ring-amber-500/25">
                    A fix pull request is still open. The device needs a build that contains it, or the testcases will fail
                    for the wrong reason. They may also change when it merges.
                  </p>
                )}
                {!!lastGenerate?.result.testcases?.length && (
                  <div className="rounded-lg bg-black/20 px-3 py-2 text-[12px] text-gray-400">
                    <p className="mb-1 text-gray-500">Generated testcases</p>
                    {lastGenerate.result.testcases.map((f) => <p key={f} className="break-all font-mono text-[11.5px] text-gray-300">{f}</p>)}
                  </div>
                )}
                {(() => {
                  const al = prAlerts(req, prs);
                  return al.lines.length ? (
                    <div className="rounded-lg bg-amber-500/10 px-3 py-2 text-[12px] text-amber-100 ring-1 ring-inset ring-amber-500/25">
                      <p className="font-medium">Pull requests changed since these testcases were generated</p>
                      <ul className="mt-0.5 list-disc space-y-0.5 pl-4">{al.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
                      <p className="mt-1 text-amber-200/80">The testcases may not match the fix as it is now. Run Regenerate after merge first.</p>
                    </div>
                  ) : null;
                })()}
                <div className="rounded-lg bg-sky-500/10 px-3 py-2 text-[12px] text-sky-100 ring-1 ring-inset ring-sky-500/25">
                  <p className="mb-1 font-medium">What you need to validate</p>
                  <ul className="list-disc space-y-1 pl-4 leading-snug">
                    <li>
                      <b>Platform:</b>{" "}
                      {req?.runs_on.length
                        ? <>runs on <span className="font-mono">{req.runs_on.join(", ")}</span></>
                        : "not recorded for these testcases. Check the notes below or the ticket."}
                      {!!req?.na_on.length && <>; reports NA on <span className="font-mono">{req.na_on.join(", ")}</span></>}
                    </li>
                    <li>
                      <b>Device with the fix:</b>{" "}
                      {req?.runs_on.length ? <>a <span className="font-mono">{req.runs_on.join(" / ")}</span> device</> : "a device of the right platform"},{" "}
                      {req?.fixed_build || "on a build that contains the fix"}.
                    </li>
                    <li>
                      <b>Device without the fix (optional):</b>{" "}
                      {req?.runs_on.length ? <>the same platform ({req.runs_on.join(" / ")})</> : "the same platform"},{" "}
                      {req?.unfixed_build || "on a build from before the fix"}. With it the result can be Yes; without it, Partial.
                    </li>
                    {req?.needs.map((n, i) => <li key={`n${i}`}><b>Also:</b> {n}</li>)}
                    <li>
                      <b>Checked on each device before the run:</b>{" "}
                      {req?.device_checks?.length ? (
                        <>
                          <span className="text-sky-200/80">a read-only login looks for the fix (must be there on the device with the fix, absent on the one without) so a wrong device is stopped in seconds.</span>
                          <ul className="mt-0.5 list-[circle] space-y-0.5 pl-4">
                            {req.device_checks.map((c, i) => <li key={i}>{c.what} <span className="text-sky-200/60">(with fix: {c.fixed}, without: {c.unfixed})</span></li>)}
                          </ul>
                          <label className="mt-1 flex cursor-pointer items-start gap-2 text-sky-100">
                            <input type="checkbox" className="mt-0.5" checked={form.skip_device_checks} onChange={(e) => set({ skip_device_checks: e.target.checked })} />
                            <span>Run even if a device fails these checks</span>
                          </label>
                        </>
                      ) : <span className="text-sky-200/80">no automatic checks recorded for this ticket yet (they are written when the testcases are generated or regenerated).</span>}
                    </li>
                    {!!req?.testcases.length && (
                      <li>
                        <b>Testcases:</b>{" "}
                        {req.testcases.map((f, i) => {
                          const st = VSTATUS[req.validation?.[f]?.status ?? "not_run"] ?? VSTATUS.not_run;
                          return <span key={f} className="mr-2 whitespace-nowrap" title={vTitle(f, req.validation?.[f])}><span className="font-mono">{tcId(f)}</span> {st.mark} <span className="text-sky-200/70">{st.label.toLowerCase()}</span>{i < req.testcases.length - 1 ? "," : ""}</span>;
                        })}
                      </li>
                    )}
                  </ul>
                  {!!req?.notes.length && (
                    <details className="mt-1.5 text-sky-200/80">
                      <summary className="cursor-pointer select-none">Notes from the analysis</summary>
                      <ul className="mt-1 list-disc space-y-1 pl-4 leading-snug">{req.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
                    </details>
                  )}
                  {!req && <p className="mt-1.5 text-sky-200/70">The worker has not reported requirements for this ticket yet (it does so every few minutes).</p>}
                </div>
                {lastValidate?.status === "done" && !!lastValidate.result.remaining?.length && (
                  <div className="rounded-lg bg-amber-500/10 px-3 py-2 text-[12px] text-amber-100 ring-1 ring-inset ring-amber-500/25">
                    <p className="mb-1 font-medium">Left to validate from the last run</p>
                    <ul className="list-disc space-y-1 pl-4 leading-snug">{lastValidate.result.remaining.map((r, i) => <li key={i}>{r}</li>)}</ul>
                  </div>
                )}
                <fieldset>
                  <legend className="mb-1.5 text-[12px] font-medium text-gray-300">Run on</legend>
                  <div className="grid grid-cols-3 gap-1.5">
                    {MODES.map((m) => (
                      <label key={m.id} title={m.hint}
                        className={`cursor-pointer rounded-lg px-2 py-1.5 text-center text-[12px] leading-tight ring-1 ring-inset transition-colors ${
                          form.mode === m.id ? "bg-indigo-500/20 text-indigo-100 ring-indigo-400/50" : "text-gray-400 ring-white/[0.1] hover:bg-white/[0.05]"}`}>
                        <input type="radio" name="validate-mode" className="sr-only" checked={form.mode === m.id} onChange={() => set({ mode: m.id })} />
                        {m.label}
                      </label>
                    ))}
                  </div>
                  <p className="mt-1.5 text-[11.5px] text-gray-500">{MODES.find((m) => m.id === form.mode)?.hint}</p>
                </fieldset>
                {form.mode !== "unfixed" && (
                  <>
                    <Field label="Device ID (has the fix)" hint="Remembered in this browser, so you only retype it when it changes.">
                      <input autoFocus className={INPUT} value={form.device_id} onChange={(e) => set({ device_id: e.target.value })} placeholder="e.g. 6603083402" />
                    </Field>
                    <Field label="Password of the device with the fix" hint="Used for this run only. Not saved in the database, the log or this browser.">
                      <input type="password" autoComplete="off" className={INPUT} value={form.device_password} onChange={(e) => set({ device_password: e.target.value })} />
                    </Field>
                  </>
                )}
                {form.mode !== "fixed" && (
                  <>
                    <Field label="Device ID (without the fix)" hint="A device whose build predates the fix. If it already has the fix the testcase passes there and proves nothing.">
                      <input autoFocus={form.mode === "unfixed"} className={INPUT} value={form.unfixed_device_id} onChange={(e) => set({ unfixed_device_id: e.target.value })} />
                    </Field>
                    <Field label="Password of the device without the fix" hint="Used for this run only. Not saved.">
                      <input type="password" autoComplete="off" className={INPUT} value={form.unfixed_device_password} onChange={(e) => set({ unfixed_device_password: e.target.value })} />
                    </Field>
                  </>
                )}
                <label className="flex items-start gap-2 text-[12.5px] text-gray-300">
                  <input type="checkbox" className="mt-0.5" checked={form.reviewed} onChange={(e) => set({ reviewed: e.target.checked })} />
                  I have reviewed the generated testcases. Claude will create their Jira TC subtasks and run them on the device.
                </label>
              </>
            )}
            {panel.stage === "include" && (() => {
                  const al = prAlerts(req, prs);
                  return al.lines.length ? (
                    <div className="rounded-lg bg-amber-500/10 px-3 py-2 text-[12px] text-amber-100 ring-1 ring-inset ring-amber-500/25">
                      <p className="font-medium">Pull requests changed since these testcases were generated</p>
                      <ul className="mt-0.5 list-disc space-y-0.5 pl-4">{al.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
                      <p className="mt-1 text-amber-200/80">The testcases may not match the fix as it is now. Run Regenerate after merge first.</p>
                    </div>
                  ) : null;
                })()}
            {panel.stage === "include" && !!req?.testcases.length && req.validation && (() => {
              const names = req.testcases, c = halfCount(names, req.validation);
              const lacks = (k: "post" | "pre") => names.filter((f) => !halves(req.validation![f])[k]).map(tcId);
              const postMissing = lacks("post"), preMissing = lacks("pre");
              return (
                <div className={`rounded-lg px-3 py-2 text-[12px] ring-1 ring-inset ${postMissing.length ? "bg-red-500/10 text-red-100 ring-red-500/25" : "bg-emerald-500/10 text-emerald-100 ring-emerald-500/25"}`}>
                  <p className="font-medium">Post-fix validation: {c.post}/{c.total} testcases{postMissing.length ? "" : " (all done)"}</p>
                  {!!postMissing.length && <p className="mt-0.5">Not validated on a device with the fix: <span className="font-mono">{postMissing.join(", ")}</span>. They would be included without that evidence.</p>}
                  <p className="mt-1 font-medium">Pre-fix validation: {c.pre}/{c.total}{preMissing.length ? "" : " (all done)"}</p>
                  {!!preMissing.length && <p className="mt-0.5">Not yet shown to fail without the fix: <span className="font-mono">{preMissing.join(", ")}</span>.</p>}
                </div>
              );
            })()}
            {panel.stage === "include" && !!lastValidate?.result.remaining?.length && (
              <div className="rounded-lg bg-amber-500/10 px-3 py-2 text-[12px] text-amber-100 ring-1 ring-inset ring-amber-500/25">
                <p className="mb-1 font-medium">The last validation left {lastValidate.result.remaining.length} item(s) open</p>
                <ul className="list-disc space-y-1 pl-4 leading-snug">{lastValidate.result.remaining.map((r, i) => <li key={i}>{r}</li>)}</ul>
                {acceptedBy ? (
                  <p className="mt-2 text-amber-200/80">Accepted by {acceptedBy}.</p>
                ) : (
                  <label className="mt-2 flex items-start gap-2 text-[12.5px] text-amber-50">
                    <input type="checkbox" className="mt-0.5" checked={form.accept_gaps} onChange={(e) => set({ accept_gaps: e.target.checked })} />
                    I accept these open items. My name is recorded as accepting them.
                  </label>
                )}
              </div>
            )}
            {panel.stage === "remove" && (
              <>
                <p className="text-[13px] leading-relaxed text-gray-400">
                  Takes the testcases of {panel.dt} back out of a branch they were included in. One new commit deletes their files and their{" "}
                  <code>main_db.xlsx</code> rows and is pushed to that branch, plain and never forced, so nothing that was already there is lost
                  and the commit can be reverted. No model is involved. Validated in device stays as it is.
                </p>
                <Field label="Remove from" hint="The branches listed in Included in runs for this ticket.">
                  {includedIn && includedIn.length > 1 ? (
                    <select className={INPUT} value={form.branch} onChange={(e) => set({ branch: e.target.value })}>
                      {includedIn.map((b) => <option key={b} value={b}>{b}</option>)}
                    </select>
                  ) : <input className={INPUT} value={form.branch} readOnly />}
                </Field>
                <label className="flex items-start gap-2 text-[12.5px] text-gray-300">
                  <input type="checkbox" className="mt-0.5" checked={form.confirm_remove} onChange={(e) => set({ confirm_remove: e.target.checked })} />
                  Remove {panel.dt}'s testcases from {form.branch || "the branch"}. I know this pushes a commit there.
                </label>
              </>
            )}
            {panel.stage === "include" && (
              <>
                <Field label="Branch" hint="An existing branch of nd_test_bot, as it is named on the remote.">
                  <input autoFocus className={INPUT} value={form.branch} onChange={(e) => set({ branch: e.target.value })} placeholder="e.g. 6.16_qa_regression_fixes"
                    onKeyDown={(e) => { if (e.key === "Enter" && ready && !busy) start(); }} />
                </Field>
                <fieldset>
                  <legend className="mb-1.5 text-[12px] font-medium text-gray-300">Put the testcases</legend>
                  <div className="grid grid-cols-2 gap-1.5">
                    {([["existing", "Into this branch"], ["new", "In a new branch from it"]] as const).map(([id, label]) => (
                      <label key={id} className={`cursor-pointer rounded-lg px-2 py-1.5 text-center text-[12px] leading-tight ring-1 ring-inset transition-colors ${
                        form.target === id ? "bg-indigo-500/20 text-indigo-100 ring-indigo-400/50" : "text-gray-400 ring-white/[0.1] hover:bg-white/[0.05]"}`}>
                        <input type="radio" name="include-target" className="sr-only" checked={form.target === id} onChange={() => set({ target: id })} />
                        {label}
                      </label>
                    ))}
                  </div>
                </fieldset>
                {form.target === "existing" ? (
                  <div className="rounded-lg bg-amber-500/10 px-3 py-2 text-[12px] text-amber-100 ring-1 ring-inset ring-amber-500/25">
                    <p className="leading-snug">
                      Claude adds one commit with the validated testcase files and their <code>main_db.xlsx</code> rows to{" "}
                      <b>{form.branch.trim() || "the branch"}</b> and pushes it there. The push is plain, never forced, so anything
                      already on the branch stays. It cannot be taken back from here.
                    </p>
                    {PROTECTED.includes(form.branch.trim().replace(/^origin\//, "").toLowerCase()) && (
                      <p className="mt-1.5 font-medium text-red-300">{form.branch.trim()} is protected: choose a new branch from it instead.</p>
                    )}
                    <label className="mt-2 flex items-start gap-2 text-[12.5px] text-amber-50">
                      <input type="checkbox" className="mt-0.5" checked={form.confirm_push} onChange={(e) => set({ confirm_push: e.target.checked })} />
                      Push directly into {form.branch.trim() || "this branch"}. I know it is not undone here.
                    </label>
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    <p className="text-[11.5px] text-gray-500">Claude creates a new branch from this one, adds the testcases and pushes the new branch. This branch itself is not changed.</p>
                    <fieldset>
                      <legend className="mb-1 text-[12px] font-medium text-gray-300">Name of the new branch</legend>
                      <div className="grid grid-cols-2 gap-1.5">
                        {([["generated", "Generated name"], ["custom", "My own name"]] as const).map(([id, label]) => (
                          <label key={id} className={`cursor-pointer rounded-lg px-2 py-1.5 text-center text-[12px] leading-tight ring-1 ring-inset transition-colors ${
                            form.name_mode === id ? "bg-indigo-500/20 text-indigo-100 ring-indigo-400/50" : "text-gray-400 ring-white/[0.1] hover:bg-white/[0.05]"}`}>
                            <input type="radio" name="include-name" className="sr-only" checked={form.name_mode === id} onChange={() => set({ name_mode: id })} />
                            {label}
                          </label>
                        ))}
                      </div>
                    </fieldset>
                    {form.name_mode === "generated" ? (
                      <p className="text-[11.5px] text-gray-400">
                        Called <code className="font-mono">bugreg/{panel.dt}-on-{(form.branch.trim() || "branch").replace(/^origin\//, "").replace(/\//g, "-")}</code>{" "}
                        (with -2, -3 … added if that name is already taken).
                      </p>
                    ) : (
                      <Field label="Branch name" hint="Used exactly as typed. If a branch with this name already exists the job stops and pushes nothing.">
                        <input className={INPUT} value={form.new_branch} onChange={(e) => set({ new_branch: e.target.value })} placeholder="e.g. 6.17_dt5431_regression" />
                      </Field>
                    )}
                  </div>
                )}
              </>
            )}
            {error && <p className="text-[12.5px] text-red-300">{error}</p>}
            <div className="flex justify-end gap-2">
              <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-[13px] text-gray-400 hover:bg-white/[0.06]">Cancel</button>
              <button onClick={start} disabled={!ready || busy}
                className="rounded-lg bg-indigo-500 px-3.5 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-40">
                {busy ? "Starting…" : "Start"}
              </button>
            </div>
          </div>
        )}

        {panel.kind === "job" && (
          <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
            {job?.result.branch && job.status === "done" && (
              <div className="flex items-center gap-2 rounded-lg bg-emerald-500/10 px-3 py-2 text-[12.5px] text-emerald-200 ring-1 ring-inset ring-emerald-500/25">
                {job.stage === "remove" ? "Removed from" : job.params.target === "existing" ? "Pushed into" : "New branch"}: <code className="select-all break-all font-mono text-emerald-100">{job.result.branch}</code>
                <button onClick={() => navigator.clipboard?.writeText(job.result.branch ?? "")} className="ml-auto rounded px-2 py-0.5 text-[11.5px] hover:bg-emerald-500/20">Copy</button>
              </div>
            )}
            {job?.message && (
              <p className={`text-[12.5px] leading-relaxed ${job.status === "failed" ? "text-red-300" : "text-gray-300"}`}>{job.message}</p>
            )}
            {!!job?.result.testcases?.length && (
              <p className="break-all font-mono text-[11.5px] text-gray-400">{job.result.testcases.join("  ·  ")}</p>
            )}
            {job?.stage === "validate" && job.status === "done" && !!job.result.reason && (
              <div className="rounded-lg bg-red-500/10 px-3 py-2 text-[12.5px] text-red-100 ring-1 ring-inset ring-red-500/25">
                <p className="mb-1 font-medium">
                  Why{job.result.reason_category ? ` · ${{ testcase: "the testcase was wrong", device: "the device or build", environment: "the test environment", product: "the fix itself" }[job.result.reason_category] ?? job.result.reason_category}` : ""}
                </p>
                <p className="leading-snug">{job.result.reason}</p>
              </div>
            )}
            {job?.stage === "validate" && job.status === "done" && !!job.result.corrections?.length && (
              <div className="rounded-lg bg-sky-500/10 px-3 py-2 text-[12.5px] text-sky-100 ring-1 ring-inset ring-sky-500/25">
                <p className="mb-1 font-medium">
                  {job.result.reverted_files?.length ? "Claude tried these corrections; they did not pass and are undone" : "Claude corrected the testcase"}
                </p>
                <ul className="list-disc space-y-1 pl-4 leading-snug">
                  {job.result.corrections.map((c, i) => (
                    <li key={i}><span className="break-all font-mono text-[11.5px]">{c.testcase}</span>: {c.what}{c.why && <span className="text-sky-200/80"> Because {c.why}</span>}</li>
                  ))}
                </ul>
              </div>
            )}
            {job?.stage === "validate" && job.status === "done" && job.result.remaining && (
              job.result.remaining.length > 0 ? (
                <div className="rounded-lg bg-amber-500/10 px-3 py-2 text-[12.5px] text-amber-100 ring-1 ring-inset ring-amber-500/25">
                  <p className="mb-1 font-medium">Still to validate</p>
                  <ul className="list-disc space-y-1 pl-4 leading-snug">
                    {job.result.remaining.map((r, i) => <li key={i}>{r}</li>)}
                  </ul>
                </div>
              ) : (
                <p className="rounded-lg bg-emerald-500/10 px-3 py-2 text-[12.5px] text-emerald-200 ring-1 ring-inset ring-emerald-500/25">Nothing left to validate.</p>
              )
            )}
            {job?.status === "queued" && (
              <p className="text-[12.5px] text-gray-500">Waiting for the workstation worker to pick this up{worker && !worker.online ? " (no worker is running)" : ""}.</p>
            )}
            {error && <p className="text-[12.5px] text-amber-300">{error}</p>}
            <pre ref={logBox} className="min-h-[220px] flex-1 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-black/40 p-3 font-mono text-[11.5px] leading-relaxed text-gray-300">
              {log || (job ? "No output yet." : "Loading…")}
            </pre>
            <div className="flex items-center justify-between text-[11.5px] text-gray-500">
              <span>
                {job?.actor && `Started by ${job.actor}`}{job?.worker && ` · ${job.worker}`}
                {job?.started_at && ` · ${new Date(job.started_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`}
                {job?.finished_at && ` to ${new Date(job.finished_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`}
                {clock.waited && ` · waited ${clock.waited} in the queue`}
              </span>
              {isActive(job ?? undefined) && !job?.cancel_requested && (
                <button onClick={cancel} className="rounded-lg px-3 py-1.5 text-[12.5px] text-red-300 ring-1 ring-inset ring-red-500/30 hover:bg-red-500/10">Stop job</button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
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
    typeof window === "undefined"
      ? DEFAULT_QUERY
      : {
          ...loadQuery(),
          ...(urlParam(URL_KEYS.version) && { fixVersion: urlParam(URL_KEYS.version) }),
          ...(urlParam(URL_KEYS.version) && { sprint: urlParam(URL_KEYS.sprint) }),
          ...initialQuery,
        }
  );
  const [options, setOptions] = useState<{ versions: VersionOption[]; sprints: SprintOption[] } | null>(null);
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [teamStatus, setTeamStatus] = useState<Record<string, TicketStatus>>({});
  const [jql, setJql] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [prMap, setPrMap] = useState<PrMap>({});
  // Filters start from the address bar. A reload re-applies them once, after the tickets arrive.
  const urlFilters = useRef({
    search: urlParam(URL_KEYS.search), status: urlParam(URL_KEYS.status), type: urlParam(URL_KEYS.type),
    slice: urlParam(URL_KEYS.slice), pr: urlParam(URL_KEYS.pr),
  });
  const keepUrlFilters = useRef(true);
  const [search, setSearch] = useState(urlFilters.current.search);
  const [status, setStatus] = useState(urlFilters.current.status);
  const [type, setType] = useState(urlFilters.current.type);
  const [slice, setSlice] = useState<Slice>(SLICES.includes(urlFilters.current.slice as Slice) ? (urlFilters.current.slice as Slice) : "");
  const [prFilter, setPrFilter] = useState<PrFilter>(PR_VALUES.includes(urlFilters.current.pr as PrFilter) ? (urlFilters.current.pr as PrFilter) : "");
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

  // Claude jobs behind the three status columns.
  const [jobs, setJobs] = useState<JobMap>({});
  const [jobsOn, setJobsOn] = useState(false);
  const [worker, setWorker] = useState<WorkerState | null>(null);
  const [reqs, setReqs] = useState<Record<string, TcRequirements>>({});
  const [accepted, setAccepted] = useState<Record<string, string>>({});
  const [panel, setPanel] = useState<Panel | null>(null);
  const [viewTc, setViewTc] = useState<{ dt: string; name: string } | null>(null);
  const hadActive = useRef(false);

  // ---- loading ------------------------------------------------------------

  // Pull requests arrive after the table: one Jira call per ticket is slow, and nobody should wait on it.
  const prRun = useRef(0);
  const loadPrs = useCallback(async (keys: string[], retry = false) => {
    // A retry of one ticket must not cancel (or reset) a release-wide load in progress.
    const run = retry ? prRun.current : ++prRun.current;
    if (!retry) setPrMap((m) => Object.fromEntries(keys.map((k) => [k, m[k]]))); // keep known values while re-fetching
    else setPrMap((m) => ({ ...m, ...Object.fromEntries(keys.map((k) => [k, undefined])) }));
    for (let i = 0; i < keys.length; i += 25) {
      const chunk = keys.slice(i, i + 25);
      let got: Record<string, PullRequest[] | null>;
      try {
        const res = await fetch(`${API_BASE}/release-tickets/prs?keys=${encodeURIComponent(chunk.join(","))}`);
        if (!res.ok) throw new Error();
        got = await res.json();
      } catch {
        got = Object.fromEntries(chunk.map((k) => [k, null]));
      }
      if (run !== prRun.current) return; // another release was loaded meanwhile
      setPrMap((m) => ({ ...m, ...got }));
    }
  }, []);

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
      // First load of the page keeps the filters from the link; picking another release resets them.
      if (keepUrlFilters.current) keepUrlFilters.current = false;
      else { setStatus(""); setType(""); setSearch(""); setSlice(""); setPrFilter(""); }
      loadPrs(body.tickets.map((t: Ticket) => t.key));
    } catch (e) {
      setTickets(null);
      setError(e instanceof Error ? e.message : "Could not load tickets");
    } finally {
      setLoading(false);
    }
  }, [loadPrs]);

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

  // Jobs are polled faster than statuses while one is running, so a finished job shows up quickly.
  const refreshStatuses = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/ticket-status`);
      if (res.ok) setTeamStatus(await res.json());
    } catch { /* the regular poll catches up */ }
  }, []);

  const refreshJobs = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/tc-jobs`);
      if (!res.ok) return;
      const body: { enabled: boolean; worker: WorkerState; jobs: TcJob[]; requirements?: Record<string, TcRequirements>; accepted_gaps?: Record<string, string> } = await res.json();
      const map: JobMap = {};
      for (const j of body.jobs) (map[j.dt] ??= {})[j.stage] = j;
      const active = body.jobs.some((j) => isActive(j));
      // A job just ended: its result is already in the status table, so show it now.
      if (hadActive.current && !active) refreshStatuses();
      hadActive.current = active;
      setJobs(map);
      setJobsOn(body.enabled);
      setWorker(body.worker);
      setReqs(body.requirements ?? {});
      setAccepted(body.accepted_gaps ?? {});
    } catch { /* an older backend without Claude jobs: the columns stay manual */ }
  }, [refreshStatuses]);

  const anyActive = useMemo(() => Object.values(jobs).some((m) => Object.values(m).some((j) => isActive(j))), [jobs]);
  useEffect(() => {
    if (!tickets) return;
    refreshJobs();
    const timer = setInterval(() => { if (!document.hidden) refreshJobs(); }, anyActive ? 4000 : POLL_MS);
    return () => clearInterval(timer);
  }, [tickets, anyActive, refreshJobs]);

  /** Why a stage cannot start for a ticket yet, or "" when it can. */
  const blocked = (key: string, stage: Stage): string => {
    const busy = Object.values(jobs[key] ?? {}).find((j) => isActive(j));
    if (busy) return `${STAGE_LABEL[busy.stage]} is running`;
    if (stage === "remove") return runsList(field(key, "included_in_runs")).length ? "" : "not included in any branch";
    if (stage !== "generate" && field(key, "generated_tcs") !== "Yes") return "generate TCs first";
    if (stage === "include" && !["Yes", "Partial"].includes(field(key, "validated"))) return "validate in device first";
    return "";
  };
  /** The job shown in the Generated TCs cell: a running one first, else the latest of generate / regenerate. */
  const genJob = (key: string): TcJob | undefined => {
    const g = jobs[key]?.generate, r = jobs[key]?.regenerate;
    if (isActive(g)) return g;
    if (isActive(r)) return r;
    if (!g || !r) return g ?? r;
    return r.created_at > g.created_at ? r : g;
  };
  /** The latest finished job that listed testcase files, for the validate form. */
  const testcaseJob = (key: string): TcJob | undefined =>
    [jobs[key]?.validate, jobs[key]?.regenerate, jobs[key]?.generate]
      .filter((j): j is TcJob => !!j && j.status === "done" && !!j.result.testcases?.length)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  const runAction = (key: string, stage: Stage, label: string) =>
    jobsOn && canRunClaude(key)
      ? { label, blocked: blocked(key, stage) || undefined, onRun: () => setPanel({ kind: "start", stage, dt: key }) }
      : undefined;

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
      if (slice === "has-tc" && t.tc_tickets.length === 0) return false;
      if (slice === "generated" && s?.generated_tcs !== "Yes") return false;
      if (slice === "validated" && s?.validated !== "Yes") return false;
      if (slice === "in-runs" && (s?.included_in_runs ?? "") === "") return false;
      if (!matchesPr(prMap[t.key], prFilter)) return false;
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
  }, [tickets, teamStatus, prMap, prFilter, search, status, type, slice, sort]);

  const toggleSort = (col: SortKey) =>
    setSort((s) => (s?.col !== col ? { col, dir: 1 } : s.dir === 1 ? { col, dir: -1 } : null));

  const toggleSlice = (s: Slice) => setSlice((cur) => (cur === s ? "" : s));
  const filtered = !!(search || status || type || slice || prFilter);
  const clearFilters = () => { setSearch(""); setStatus(""); setType(""); setSlice(""); setPrFilter(""); };

  // Sprints are named after their release ("x.6.19_Sprint1" for "x.6.19.rc.1"),
  // so the ones for the chosen fix version go first.
  const sprintPrefix = /^(x\.\d+\.\d+)/.exec(query.fixVersion)?.[1] ?? null;
  const sprintsFor = (options?.sprints ?? []).filter((sp) => sprintPrefix && sp.name.startsWith(`${sprintPrefix}_`));
  const sprintsOther = (options?.sprints ?? []).filter((sp) => !sprintsFor.includes(sp));
  const sprintLabel = (sp: SprintOption) => (sp.state === "active" ? `${sp.name} · active` : sp.name);
  const releaseBuilds = (options?.versions ?? []).filter((v) => /^x\.\d+\.\d+\.rc\./.test(v.name));
  const otherVersions = (options?.versions ?? []).filter((v) => !releaseBuilds.includes(v));

  const pct = (n: number) => (stats.total ? (n / stats.total) * 100 : 0);

  // Mirror the view into the address bar (replace, not push, so Back still leaves the page).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const u = new URL(window.location.href);
    const set = (k: string, v: string) => (v ? u.searchParams.set(k, v) : u.searchParams.delete(k));
    set(URL_KEYS.search, search); set(URL_KEYS.status, status); set(URL_KEYS.type, type);
    set(URL_KEYS.slice, slice); set(URL_KEYS.pr, prFilter);
    set(URL_KEYS.version, query.fixVersion); set(URL_KEYS.sprint, query.sprint);
    if (u.href !== window.location.href) window.history.replaceState(null, "", u);
  }, [search, status, type, slice, prFilter, query.fixVersion, query.sprint]);

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
              note={`${stats.total - stats.withTc} missing · click to list those with a TC`}
              segments={[{ pct: pct(stats.withTc), color: "bg-emerald-400/80" }]}
              active={slice === "has-tc"} onClick={() => toggleSlice("has-tc")}
            />
            <Tile
              label="Generated TCs" value={stats.generated} of={stats.total}
              note={`${stats.total - stats.generated} still to generate · click to list generated`}
              segments={[
                { pct: pct(stats.generated), color: "bg-emerald-400/80" },
                { pct: pct(stats.generatedWip), color: "bg-amber-400/80" },
              ]}
              active={slice === "generated"} onClick={() => toggleSlice("generated")}
            />
            <Tile
              label="Validated in device" value={stats.validated} of={stats.total}
              note={`${stats.total - stats.validated} not validated · click to list validated`}
              segments={[
                { pct: pct(stats.validated), color: "bg-emerald-400/80" },
                { pct: pct(stats.validatedPartial), color: "bg-amber-400/80" },
                { pct: pct(stats.validatedNo), color: "bg-red-400/70" },
              ]}
              active={slice === "validated"} onClick={() => toggleSlice("validated")}
            />
            <Tile
              label="Included in runs" value={stats.inRuns} of={stats.total}
              note={`${stats.total - stats.inRuns} not in a run yet · click to list those in runs`}
              segments={[{ pct: pct(stats.inRuns), color: "bg-sky-400/80" }]}
              active={slice === "in-runs"} onClick={() => toggleSlice("in-runs")}
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
                {jobsOn && worker && (
                  <span
                    className={worker.online ? "text-emerald-300/80" : "text-amber-300/80"}
                    title={worker.online ? `Claude jobs run on ${worker.name}` : "Claude jobs wait in the queue until tools/tc_worker.py is running on the workstation"}
                  >
                    · Claude worker {worker.online ? "online" : "offline"}
                  </span>
                )}
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
              <select value={prFilter} onChange={(e) => setPrFilter(e.target.value as PrFilter)} aria-label="Pull requests" className="ds-input !rounded-full !py-2 !text-[13px]">
                {PR_FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
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
                      <th colSpan={9} className="!px-3 !pb-0 !pt-2.5 !text-[10.5px] !font-semibold uppercase tracking-wider text-gray-600">
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
                      <Th label="Pull requests" sort={sort} />
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
                          <td className="!px-3">
                            {prMap[t.key] === undefined ? (
                              <span className="inline-block h-3 w-16 animate-pulse rounded bg-white/[0.06]" aria-label="Loading pull requests" />
                            ) : prMap[t.key] === null ? (
                              <button onClick={() => loadPrs([t.key], true)} title="Jira did not return PR data — click to retry" className="text-[11.5px] text-amber-300/80 hover:underline">Unavailable · retry</button>
                            ) : prMap[t.key]!.length === 0 ? <Dash /> : (
                              <div className="flex min-w-[170px] flex-col gap-1">
                                {prMap[t.key]!.map((pr) => (
                                  <div key={pr.url || pr.id} className="flex items-center gap-1.5 text-[12px]">
                                    <Pill className={PR_STYLE[pr.status] ?? "bg-white/[0.05] text-gray-300 ring-white/[0.08]"}>
                                      {PR_LABEL[pr.status] ?? (pr.status || "Unknown")}
                                    </Pill>
                                    <a href={pr.url} target="_blank" rel="noreferrer" title={`${pr.title}${pr.target ? ` → ${pr.target}` : ""}${pr.author ? ` · ${pr.author}` : ""}`} className="whitespace-nowrap text-indigo-300 hover:text-indigo-200 hover:underline">
                                      {pr.repo ? `${pr.repo}${pr.id}` : pr.id}
                                    </a>
                                    {field(t.key, "generated_tcs") === "Yes" && <PrUsed cov={reqs[t.key]?.pr_coverage?.[`${pr.repo}${pr.id}`]} status={pr.status} />}
                                  </div>
                                ))}
                              </div>
                            )}
                          </td>
                          <td className="!px-3 bg-indigo-500/[0.03]">
                            {isActive(genJob(t.key)) ? (
                              <JobChip job={genJob(t.key)!} onOpen={() => setPanel({ kind: "job", id: genJob(t.key)!.id })} />
                            ) : (
                              <div className="flex flex-col items-start gap-1">
                                <span className="inline-flex items-center">
                                  <StatusSelect ticket={t.key} field="generated_tcs" label="Generated TCs" choices={GENERATED_CHOICES} value={field(t.key, "generated_tcs")} onSave={save}
                                    run={runAction(t.key, "generate", "Generate with Claude")}
                                    run2={field(t.key, "generated_tcs") === "Yes" ? runAction(t.key, "regenerate", "Regenerate after merge") : undefined} />
                                  <JobMark job={genJob(t.key)} onOpen={() => setPanel({ kind: "job", id: genJob(t.key)!.id })} />
                                </span>
                                {field(t.key, "generated_tcs") === "Yes" && !!reqs[t.key]?.testcases.length && (
                                  <span className="flex flex-col items-start gap-1" aria-label={`Generated testcases of ${t.key}`}>
                                    {reqs[t.key].testcases.map((f) => {
                                      const v = reqs[t.key].validation?.[f];
                                      const st = VSTATUS[v?.status ?? "not_run"] ?? VSTATUS.not_run;
                                      const h = halves(v);
                                      return (
                                        <button key={f} onClick={() => setViewTc({ dt: t.key, name: f })} title={vTitle(f, v)}
                                          className={`inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 font-mono text-[11px] ring-1 ring-inset transition-colors ${st.chip}`}>
                                          {tcId(f)}
                                          <span className="font-sans text-[10px]" aria-label={st.label}>
                                            <span className={halfCls(h.post, h.failed)}>post-fix {halfMark(h.post, h.failed)}</span>
                                            <span className="mx-1 opacity-40">·</span>
                                            <span className={halfCls(h.pre)}>pre-fix {halfMark(h.pre)}</span>
                                            {h.na && !h.post && !h.pre && <span className="ml-1 opacity-70">NA</span>}
                                          </span>
                                        </button>
                                      );
                                    })}
                                  </span>
                                )}
                                {field(t.key, "generated_tcs") === "Yes" && (() => {
                                  const al = prAlerts(reqs[t.key], prMap[t.key]);
                                  const regen = runAction(t.key, "regenerate", "Regenerate after merge");
                                  if (!al.lines.length) return null;
                                  return (
                                    <button onClick={regen?.onRun} disabled={!regen || !!regen.blocked}
                                      title={`Changed since these testcases were generated:\n${al.lines.join("\n")}\nClick to regenerate after merge.`}
                                      className="max-w-[190px] rounded-md bg-amber-500/15 px-1.5 py-0.5 text-left text-[11px] leading-tight text-amber-200 ring-1 ring-inset ring-amber-400/35 transition-colors hover:bg-amber-500/25 disabled:cursor-not-allowed disabled:opacity-60">
                                      ⟳ {al.short.length} change{al.short.length > 1 ? "s" : ""} since generated: {al.short.join(", ")} · regenerate
                                    </button>
                                  );
                                })()}
                              </div>
                            )}
                          </td>
                          <td className="!px-3 bg-indigo-500/[0.03]">
                            {isActive(jobs[t.key]?.validate) ? (
                              <JobChip job={jobs[t.key]!.validate!} onOpen={() => setPanel({ kind: "job", id: jobs[t.key]!.validate!.id })} />
                            ) : (
                              <span className="inline-flex items-center">
                                <StatusSelect ticket={t.key} field="validated" label="Validated in device" choices={VALIDATED_CHOICES} value={field(t.key, "validated")} onSave={save}
                                  run={runAction(t.key, "validate",
                                    ["No", "Partial"].includes(field(t.key, "validated"))
                                      ? "Validate again: Claude corrects the testcase or explains" : "Validate on device…")} />
                                {(() => {
                                  const r = reqs[t.key], names = r?.testcases ?? [];
                                  if (!names.length || !r?.validation) return null;
                                  const c = halfCount(names, r.validation);
                                  return (
                                    <span className="ml-1 whitespace-nowrap text-[11px] text-gray-500"
                                      title={names.map((f) => { const h = halves(r.validation![f]); return `${tcId(f)}: post-fix ${h.post ? "done" : "pending"}, pre-fix ${h.pre ? "done" : "pending"}`; }).join("\n")}>
                                      post-fix <b className={c.post === c.total ? "text-emerald-300" : "text-amber-300"}>{c.post}/{c.total}</b>
                                      {" · "}pre-fix <b className={c.pre === c.total ? "text-emerald-300" : "text-gray-400"}>{c.pre}/{c.total}</b>
                                    </span>
                                  );
                                })()}
                                <OpenMark job={jobs[t.key]?.validate} value={field(t.key, "validated")}
                                  by={jobs[t.key]?.validate ? accepted[jobs[t.key]!.validate!.id] : undefined}
                                  onOpen={() => setPanel({ kind: "job", id: jobs[t.key]!.validate!.id })} />
                                <JobMark job={jobs[t.key]?.validate} onOpen={() => setPanel({ kind: "job", id: jobs[t.key]!.validate!.id })} />
                              </span>
                            )}
                          </td>
                          <td className="!px-3 bg-indigo-500/[0.03]">
                            {isActive(jobs[t.key]?.include) || isActive(jobs[t.key]?.remove) ? (
                              <JobChip job={(isActive(jobs[t.key]?.include) ? jobs[t.key]!.include : jobs[t.key]!.remove)!}
                                onOpen={() => setPanel({ kind: "job", id: (isActive(jobs[t.key]?.include) ? jobs[t.key]!.include : jobs[t.key]!.remove)!.id })} />
                            ) : (
                              <span className="inline-flex items-center">
                                <StatusText ticket={t.key} field="included_in_runs" label="Included in runs" placeholder="Add runs…" value={field(t.key, "included_in_runs")} onSave={save} onEditing={markEditing} />
                                {(() => {
                                  const run = runAction(t.key, "include", "Include with Claude…");
                                  return run && (
                                    <button
                                      onClick={run.onRun} disabled={!!run.blocked}
                                      title={run.blocked ? `Include with Claude: ${run.blocked}` : "Include with Claude: push the validated testcases to a new branch"}
                                      aria-label={`Include ${t.key} in runs with Claude`}
                                      className="ml-1 inline-flex h-6 w-6 items-center justify-center rounded-full text-[10px] text-indigo-300 ring-1 ring-inset ring-indigo-400/30 transition-colors hover:bg-indigo-500/15 disabled:cursor-not-allowed disabled:text-gray-600 disabled:ring-white/[0.08] disabled:hover:bg-transparent"
                                    >
                                      ▶
                                    </button>
                                  );
                                })()}
                                {(() => {
                                  const rm = jobsOn && canRunClaude(t.key) && runsList(field(t.key, "included_in_runs")).length > 0;
                                  return rm && (
                                    <button
                                      onClick={() => setPanel({ kind: "start", stage: "remove", dt: t.key })}
                                      title="Remove the testcases from a branch they were included in"
                                      aria-label={`Remove ${t.key} testcases from a branch`}
                                      className="ml-1 inline-flex h-6 w-6 items-center justify-center rounded-full text-[11px] text-gray-400 ring-1 ring-inset ring-white/[0.12] transition-colors hover:bg-red-500/15 hover:text-red-300 hover:ring-red-500/30"
                                    >
                                      ✕
                                    </button>
                                  );
                                })()}
                                {(() => {
                                  const inc = jobs[t.key]?.include, rem = jobs[t.key]?.remove;
                                  const last = inc && rem ? (rem.created_at > inc.created_at ? rem : inc) : inc ?? rem;
                                  return <JobMark job={last} onOpen={() => last && setPanel({ kind: "job", id: last.id })} />;
                                })()}
                              </span>
                            )}
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

      {viewTc && <TcViewer dt={viewTc.dt} name={viewTc.name} onClose={() => setViewTc(null)} />}

      {panel && (
        <JobPanel
          key={panel.kind === "job" ? panel.id : `${panel.stage}:${panel.dt}`}
          panel={panel}
          lastGenerate={panel.kind === "start" ? testcaseJob(panel.dt) : undefined}
          lastValidate={panel.kind === "start" ? jobs[panel.dt]?.validate : undefined}
          req={panel.kind === "start" ? reqs[panel.dt] : undefined}
          acceptedBy={panel.kind === "start" && jobs[panel.dt]?.validate ? accepted[jobs[panel.dt]!.validate!.id] : undefined}
          includedIn={panel.kind === "start" ? runsList(field(panel.dt, "included_in_runs")) : undefined}
          prs={panel.kind === "start" ? prMap[panel.dt] : undefined}
          worker={worker}
          onClose={() => setPanel(null)}
          onStarted={(job) => { setPanel({ kind: "job", id: job.id }); refreshJobs(); refreshStatuses(); }}
        />
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
