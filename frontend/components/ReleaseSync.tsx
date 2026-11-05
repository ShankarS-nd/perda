"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { VerdictStrip, type Overview } from "@/components/TestReportDashboard";

// ---------------------------------------------------------------------------
// Types — mirror backend/release_sync.py
// ---------------------------------------------------------------------------

interface DeviceOption { device: string; platform: string | null; supported: boolean }

interface RcOption { rc: string; date: string; status: string; special: boolean }
interface ReleaseOption { version: string; name: string; rcs: RcOption[] }
interface ProjectOption { key: string; releases: ReleaseOption[] }

interface SummaryOverview {
  total: number; pass: number; pass_pct: number;
  known_failures: number; unknown_failures: number; not_executed: number; not_applicable: number;
}

interface Regression {
  tc_id: string; service: string; name: string; error: string; linked_issue: string | null; known: boolean;
}

interface DeviceSummary {
  schemaVersion: number;
  generatedAt: string;
  source: string;
  reportLinks: { current: string; previous: string; dashboard: string };
  builds: { previous: { label: string; ota: string }; current: { label: string; ota: string } };
  overview: { previous: SummaryOverview; current: SummaryOverview };
  comparison: {
    regressions: { known: number; unknown: number };
    persistent_failures: { known: number; unknown: number };
    fixed: number; stable: number; new: number; removed: number;
  };
  regressions: Regression[];
}

interface DeviceRow {
  id: number;
  device: string;
  rc1Url: string;
  rc2Url: string;
  state: "idle" | "loading" | "done" | "error";
  summary?: DeviceSummary;
  error?: string;
}

interface ChangelogResult {
  text: string; repo: string; commits: number; total: number; compare_url: string;
}

interface DryRun { sent: boolean; method: string; url: string; body: Record<string, unknown> }

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://172.16.23.15:8000";
const CHANGELOG_LIMIT = 20000;
const REPO_LABEL = "netradyne/nd_test_bot";
const PAGE_SIZE = 25;

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof body.detail === "string" ? body.detail : `Request failed (HTTP ${res.status})`);
  return body as T;
}

const post = <T,>(path: string, data: unknown) =>
  call<T>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The summary payload is deliberately lean; the shared verdict strip wants percentages too. */
function toOverview(o: SummaryOverview): Overview {
  const pct = (n: number) => (o.total ? Math.round((n / o.total) * 1000) / 10 : 0);
  return {
    total: o.total, pass: o.pass, fail: o.known_failures + o.unknown_failures,
    not_executed: o.not_executed, not_applicable: o.not_applicable,
    known_failures: o.known_failures, unknown_failures: o.unknown_failures,
    pass_pct: o.pass_pct, known_pct: pct(o.known_failures), unknown_pct: pct(o.unknown_failures), ne_pct: pct(o.not_executed),
  };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

let rowId = 0;
const newRow = (device = ""): DeviceRow => ({ id: ++rowId, device, rc1Url: "", rc2Url: "", state: "idle" });

export default function ReleaseSync() {
  // 1 · release — chosen from the release-notes app's own lists
  const [projects, setProjects] = useState<ProjectOption[] | null>(null);
  const [releasesError, setReleasesError] = useState("");
  const [project, setProject] = useState("");
  const [edition, setEdition] = useState("");
  const [rc, setRc] = useState("");

  // 2 · reports
  const [devices, setDevices] = useState<DeviceOption[]>([]);
  const [rows, setRows] = useState<DeviceRow[]>([newRow()]);

  // 3 · change log (nd_test_bot only)
  const [branches, setBranches] = useState<string[]>([]);
  const [branchNote, setBranchNote] = useState("");
  const [base, setBase] = useState("");
  const [head, setHead] = useState("");
  const [changelog, setChangelog] = useState("");
  const [logInfo, setLogInfo] = useState<ChangelogResult | null>(null);
  const [loadingLog, setLoadingLog] = useState(false);
  const [logError, setLogError] = useState("");

  // 4 · review
  const [dryRun, setDryRun] = useState<DryRun | null>(null);
  const [dryError, setDryError] = useState("");
  const [copied, setCopied] = useState(false);

  const loadReleases = useCallback(() => {
    setReleasesError("");
    call<{ projects: ProjectOption[] }>("/release-sync/releases")
      .then((d) => {
        setProjects(d.projects);
        const p = d.projects.find((x) => x.key === "DT") ?? d.projects[0];
        const r = p?.releases[0];
        setProject(p?.key ?? ""); setEdition(r?.version ?? ""); setRc(r?.rcs[0]?.rc ?? "");
      })
      .catch((e) => setReleasesError(msg(e)));
  }, []);

  useEffect(() => {
    loadReleases();
    call<{ devices: DeviceOption[] }>("/release-sync/devices").then((d) => setDevices(d.devices)).catch(() => {});
    call<{ branches: string[] }>("/release-sync/branches")
      .then((d) => setBranches(d.branches))
      .catch((e) => setBranchNote(`Couldn't load the branch list (${msg(e)}). You can still type branch names.`));
  }, [loadReleases]);

  const releases = useMemo(() => projects?.find((p) => p.key === project)?.releases ?? [], [projects, project]);
  const rcs = useMemo(() => releases.find((r) => r.version === edition)?.rcs ?? [], [releases, edition]);

  const pickProject = (key: string) => {
    const r = projects?.find((p) => p.key === key)?.releases[0];
    setProject(key); setEdition(r?.version ?? ""); setRc(r?.rcs[0]?.rc ?? ""); setDryRun(null);
  };
  const pickEdition = (version: string) => {
    setEdition(version); setRc(releases.find((r) => r.version === version)?.rcs[0]?.rc ?? ""); setDryRun(null);
  };

  const patchRow = useCallback((id: number, patch: Partial<DeviceRow>) => {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    setDryRun(null); // anything shown is stale once an input or result changes
  }, []);

  const compare = useCallback(async (row: DeviceRow) => {
    patchRow(row.id, { state: "loading", error: undefined });
    try {
      const out = await post<{ summary: DeviceSummary }>("/release-sync/summary", {
        device: row.device,
        rc1_url: row.rc1Url,
        rc2_url: row.rc2Url,
        dashboard_url: typeof window !== "undefined" ? window.location.origin : "",
      });
      patchRow(row.id, { state: "done", summary: out.summary });
    } catch (e) {
      patchRow(row.id, { state: "error", summary: undefined, error: msg(e) });
    }
  }, [patchRow]);

  const readyRows = rows.filter((r) => r.device && r.rc1Url.trim() && r.rc2Url.trim());
  const doneRows = rows.filter((r) => r.state === "done" && r.summary);

  const fetchLog = async () => {
    setLoadingLog(true); setLogError("");
    try {
      const out = await post<ChangelogResult>("/release-sync/changelog", { base, head });
      setChangelog(out.text); setLogInfo(out); setDryRun(null);
    } catch (e) {
      setLogError(msg(e));
    } finally {
      setLoadingLog(false);
    }
  };

  const buildDryRun = async () => {
    setDryError("");
    try {
      const summaries = Object.fromEntries(doneRows.map((r) => [r.device, r.summary]));
      setDryRun(await post<DryRun>("/release-sync/dry-run", { edition, rc, project, summaries, changelog }));
    } catch (e) {
      setDryRun(null);
      setDryError(msg(e));
    }
  };

  const json = useMemo(() => (dryRun ? JSON.stringify(dryRun.body, null, 2) : ""), [dryRun]);
  const copy = async () => {
    try { await navigator.clipboard.writeText(JSON.stringify(dryRun, null, 2)); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
  };

  const usedDevices = new Set(rows.map((r) => r.device));
  const logOver = changelog.length > CHANGELOG_LIMIT;
  const regular = rcs.filter((r) => !r.special);
  const special = rcs.filter((r) => r.special);

  return (
    <div className="space-y-5">
      {/* 1 · Release */}
      <Section n={1} title="Release" hint="Choices come from the release notes, so the post lands on a release that exists there">
        {releasesError ? (
          <p className="text-[12.5px] text-red-400">
            Couldn&apos;t load releases: {releasesError}{" "}
            <button className="underline" onClick={loadReleases}>Retry</button>
          </p>
        ) : (
          <div className="flex flex-wrap gap-3">
            <Field label="Project">
              <select className="ds-input !text-[13px] w-32" value={project} disabled={!projects} onChange={(e) => pickProject(e.target.value)}>
                {!projects && <option>Loading…</option>}
                {projects?.map((p) => <option key={p.key} value={p.key}>{p.key}</option>)}
              </select>
            </Field>
            <Field label="Release">
              <select className="ds-input !text-[13px] w-48" value={edition} disabled={!projects} onChange={(e) => pickEdition(e.target.value)}>
                {releases.map((r) => <option key={r.version} value={r.version}>{r.version}</option>)}
              </select>
            </Field>
            <Field label="RC">
              <select className="ds-input !text-[13px] w-72" value={rc} disabled={!projects} onChange={(e) => { setRc(e.target.value); setDryRun(null); }}>
                {regular.length > 0 && (
                  <optgroup label="Release candidates">
                    {regular.map((r) => <option key={r.rc} value={r.rc}>{r.rc}</option>)}
                  </optgroup>
                )}
                {special.length > 0 && (
                  <optgroup label="Special packages">
                    {special.map((r) => <option key={r.rc} value={r.rc}>{r.rc}</option>)}
                  </optgroup>
                )}
              </select>
            </Field>
          </div>
        )}
      </Section>

      {/* 2 · Test reports */}
      <Section n={2} title="Test automation reports" hint="One block per device: paste the previous and current Jenkins report links, then compare">
        <div className="space-y-4">
          {rows.map((row) => (
            <div key={row.id} className="space-y-4">
              <div className="flex flex-wrap items-end gap-3">
                <Field label="Device">
                  <select
                    className="ds-input !text-[13px] w-44"
                    value={row.device}
                    onChange={(e) => patchRow(row.id, { device: e.target.value, state: "idle", summary: undefined })}
                  >
                    <option value="">Choose…</option>
                    {devices.map((d) => (
                      <option key={d.device} value={d.device} disabled={!d.supported || (usedDevices.has(d.device) && d.device !== row.device)}>
                        {d.device}{d.platform ? ` (${d.platform})` : " (no platform yet)"}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Previous report (Jenkins URL)" grow>
                  <input className="ds-input !text-[13px]" placeholder="https://build-device…/job/…/1189/Test_5freport/" value={row.rc1Url}
                    onChange={(e) => patchRow(row.id, { rc1Url: e.target.value, state: "idle", summary: undefined })} />
                </Field>
                <Field label="Current report (Jenkins URL)" grow>
                  <input className="ds-input !text-[13px]" placeholder="https://build-device…/job/…/1204/Test_5freport/" value={row.rc2Url}
                    onChange={(e) => patchRow(row.id, { rc2Url: e.target.value, state: "idle", summary: undefined })} />
                </Field>
                <button className="ds-btn-primary" disabled={!row.device || !row.rc1Url.trim() || !row.rc2Url.trim() || row.state === "loading"} onClick={() => compare(row)}>
                  {row.state === "loading" ? "Comparing…" : "Compare"}
                </button>
                {rows.length > 1 && (
                  <button className="ds-btn-secondary" onClick={() => { setRows((rs) => rs.filter((r) => r.id !== row.id)); setDryRun(null); }}>Remove</button>
                )}
              </div>
              {row.state === "loading" && <p className="text-[12.5px] text-gray-500">Downloading both reports from Jenkins and comparing. The first run of a build can take a minute.</p>}
              {row.state === "error" && <p className="rounded-lg border border-red-500/20 bg-red-500/[0.06] px-3 py-2 text-[12.5px] text-red-300">{row.error}</p>}
              {row.state === "done" && row.summary && <DeviceReport device={row.device} platform={devices.find((d) => d.device === row.device)?.platform ?? ""} s={row.summary} />}
              {rows.length > 1 && <hr className="border-white/[0.06]" />}
            </div>
          ))}
          <div className="flex gap-2">
            <button className="ds-btn-secondary" onClick={() => setRows((rs) => [...rs, newRow()])}>+ Add device</button>
            {readyRows.length > 1 && (
              <button className="ds-btn-secondary" disabled={rows.some((r) => r.state === "loading")} onClick={() => readyRows.forEach(compare)}>Compare all</button>
            )}
          </div>
        </div>
      </Section>

      {/* 3 · Change log */}
      <Section n={3} title="Change log" hint={`Commits between two branches of ${REPO_LABEL}. One log for the whole RC.`}>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Base branch (previous release)">
            <input className="ds-input !text-[13px] w-72" list="rs-branches" value={base} placeholder="e.g. the previous release branch"
              onChange={(e) => setBase(e.target.value)} />
          </Field>
          <Field label="Head branch (this release)">
            <input className="ds-input !text-[13px] w-72" list="rs-branches" value={head} placeholder="e.g. this release branch"
              onChange={(e) => setHead(e.target.value)} />
          </Field>
          <datalist id="rs-branches">{branches.map((b) => <option key={b} value={b} />)}</datalist>
          <button className="ds-btn-primary" onClick={fetchLog} disabled={loadingLog || !base.trim() || !head.trim()}>
            {loadingLog ? "Fetching commits…" : "Fetch commits"}
          </button>
        </div>
        {branchNote && <p className="mt-2 text-[12px] text-amber-300/80">{branchNote}</p>}
        {branches.length > 0 && <p className="mt-2 text-[12px] text-gray-600">{branches.length} branches available. Start typing to filter.</p>}
        {logError && <p className="mt-2 rounded-lg border border-red-500/20 bg-red-500/[0.06] px-3 py-2 text-[12.5px] text-red-300">{logError}</p>}

        {(changelog || logInfo) && (
          <div className="mt-3">
            {logInfo && (
              <p className="mb-2 text-[12px] text-gray-400">
                <b className="text-gray-200">{logInfo.commits}</b> commits
                {logInfo.total > logInfo.commits && <span className="text-gray-600"> ({logInfo.total - logInfo.commits} merge commits skipped)</span>}
                {" · "}
                <a className="text-indigo-300 hover:underline" href={logInfo.compare_url} target="_blank" rel="noreferrer">View on GitHub ↗</a>
              </p>
            )}
            <textarea
              className="ds-input w-full min-h-[220px] font-mono !text-[12px]"
              value={changelog}
              onChange={(e) => { setChangelog(e.target.value); setDryRun(null); }}
              placeholder="Fetched commits appear here. You can edit before posting."
            />
            <p className={`mt-1 text-[11.5px] ${logOver ? "text-red-400" : "text-gray-500"}`}>
              {changelog.length.toLocaleString()} / {CHANGELOG_LIMIT.toLocaleString()} characters{logOver ? ". Too long for the release notes; trim it" : ""}
            </p>
          </div>
        )}
      </Section>

      {/* 4 · Review & post */}
      <Section n={4} title="Review and post" hint={`Shows exactly what will be sent to ${rc || "the release"}. Nothing is sent yet.`}>
        <div className="flex flex-wrap items-center gap-3">
          <button className="ds-btn-secondary" onClick={buildDryRun} disabled={!rc || (doneRows.length === 0 && !changelog.trim())}>Preview request</button>
          <button className="ds-btn-primary" disabled title="Posting is switched off until authentication with the release-notes app is agreed">
            Push to Release Notes
          </button>
          <span className="text-[12px] text-gray-500">
            {doneRows.length} device summar{doneRows.length === 1 ? "y" : "ies"}{changelog.trim() ? " + change log" : ""} ready
          </span>
        </div>
        {dryError && <p className="mt-2 text-[12px] text-red-400">{dryError}</p>}
        {dryRun && (
          <div className="mt-3">
            <div className="flex items-center justify-between gap-3">
              <p className="break-all text-[12px] text-gray-400"><span className="font-mono text-indigo-300">{dryRun.method}</span> <span className="font-mono">{dryRun.url}</span></p>
              <button className="ds-btn-secondary shrink-0" onClick={copy}>{copied ? "Copied" : "Copy request"}</button>
            </div>
            <pre className="mt-2 max-h-[420px] overflow-auto rounded-xl border border-white/[0.06] bg-black/30 p-3 text-[11.5px] leading-relaxed text-gray-300">{json}</pre>
          </div>
        )}
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Report for one device — same visual language as the Test Report Summary tab
// ---------------------------------------------------------------------------

function DeviceReport({ device, platform, s }: { device: string; platform: string; s: DeviceSummary }) {
  const c = s.comparison;
  const regressed = c.regressions.known + c.regressions.unknown;
  const persistent = c.persistent_failures.known + c.persistent_failures.unknown;
  const { previous: pb, current: cb } = s.builds;

  return (
    <div className="space-y-4 rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <h3 className="text-[15px] font-semibold tracking-[-0.01em] text-gray-100">{device}</h3>
          {platform && <span className="text-xs text-gray-600">{platform}</span>}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-gray-500">
          <span>Previous <b className="text-gray-300">#{pb.label}</b>{pb.ota && <span className="text-gray-600"> ({pb.ota})</span>}</span>
          <span>Current <b className="text-gray-300">#{cb.label}</b>{cb.ota && <span className="text-gray-600"> ({cb.ota})</span>}</span>
          <a className="text-indigo-300 hover:underline" href={s.reportLinks.previous} target="_blank" rel="noreferrer">Previous report ↗</a>
          <a className="text-indigo-300 hover:underline" href={s.reportLinks.current} target="_blank" rel="noreferrer">Current report ↗</a>
        </div>
      </div>

      <VerdictStrip
        prev={toOverview(s.overview.previous)} curr={toOverview(s.overview.current)}
        rc1={pb.label} rc2={cb.label} regressions={regressed} fixed={c.fixed}
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Tile label="Regressions" value={regressed} tone={regressed ? "bad" : "good"} note={`${c.regressions.known} known · ${c.regressions.unknown} unknown`} />
        <Tile label="Persistent failures" value={persistent} tone={persistent ? "warn" : "good"} note={`${c.persistent_failures.known} known · ${c.persistent_failures.unknown} unknown`} />
        <Tile label="Fixed" value={c.fixed} tone="good" note="failed before, pass now" />
        <Tile label="Stable" value={c.stable} tone="flat" note="passed in both" />
        <Tile label="New" value={c.new} tone="flat" note="only in current" />
        <Tile label="Removed" value={c.removed} tone="flat" note="only in previous" />
      </div>

      <RegressionTable rows={s.regressions} />
    </div>
  );
}

const TONE: Record<string, string> = {
  good: "text-emerald-400", bad: "text-red-400", warn: "text-amber-300", flat: "text-gray-200",
};

function Tile({ label, value, note, tone }: { label: string; value: number; note: string; tone: keyof typeof TONE }) {
  return (
    <div className="ds-card px-4 py-3">
      <span className="ds-label !mb-0">{label}</span>
      <p className={`mt-1.5 text-[26px] font-semibold leading-none tracking-tight tabular-nums ${TONE[tone]}`}>{value}</p>
      <p className="mt-1.5 text-[11px] text-gray-600">{note}</p>
    </div>
  );
}

type Filter = "all" | "known" | "unknown";

function RegressionTable({ rows }: { rows: Regression[] }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [shown, setShown] = useState(PAGE_SIZE);
  const known = rows.filter((r) => r.known).length;
  const visible = rows.filter((r) => filter === "all" || (filter === "known") === r.known);
  const chips: [Filter, string, number][] = [["all", "All", rows.length], ["known", "Known", known], ["unknown", "Unknown", rows.length - known]];

  return (
    <div className="ds-card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.05] px-5 py-3">
        <div>
          <h4 className="text-[14px] font-semibold text-gray-200">Regressions</h4>
          <p className="text-[11.5px] text-gray-600">Passed in the previous build, failed in the current one. These are what goes to the release notes.</p>
        </div>
        <div className="flex gap-1.5">
          {chips.map(([key, label, n]) => (
            <button
              key={key}
              onClick={() => { setFilter(key); setShown(PAGE_SIZE); }}
              className={`rounded-full px-3 py-1 text-[12px] font-medium ring-1 ring-inset transition-colors ${
                filter === key ? "bg-indigo-500/20 text-indigo-200 ring-indigo-400/40" : "text-gray-400 ring-white/[0.08] hover:text-gray-200"
              }`}
            >
              {label} <span className="tabular-nums opacity-70">{n}</span>
            </button>
          ))}
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="px-5 py-6 text-center text-[13px] text-emerald-400">No regressions between these builds.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] table-fixed border-collapse text-[12.5px]">
            <colgroup>
              <col className="w-[96px]" /><col className="w-[190px]" /><col className="w-[96px]" /><col className="w-[190px]" /><col />
            </colgroup>
            <thead>
              <tr className="border-b border-white/[0.05] text-left text-[11px] uppercase tracking-wider text-gray-500">
                <th className="px-5 py-2.5 font-medium">Test case</th>
                <th className="px-3 py-2.5 font-medium">Service</th>
                <th className="px-3 py-2.5 font-medium">Status</th>
                <th className="px-3 py-2.5 font-medium">Linked issue</th>
                <th className="px-5 py-2.5 font-medium">Error</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.04]">
              {visible.slice(0, shown).map((r) => (
                <tr key={r.service + r.tc_id} className="align-top hover:bg-white/[0.02]">
                  <td className="whitespace-nowrap px-5 py-2.5 font-mono text-indigo-300">{r.tc_id}</td>
                  <td className="px-3 py-2.5 text-gray-400 break-words">{r.service}</td>
                  <td className="px-3 py-2.5">
                    <span className={`ds-badge ${r.known ? "ds-badge-warning" : "ds-badge-error"}`}>{r.known ? "Known" : "Unknown"}</span>
                  </td>
                  <td className="break-words px-3 py-2.5 text-gray-300">{r.linked_issue ?? <span className="text-gray-700">—</span>}</td>
                  <td className="px-5 py-2.5 text-gray-500">
                    <div className="line-clamp-2 break-words" title={r.error}>{r.error || <span className="text-gray-700">—</span>}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {visible.length > shown && (
            <div className="border-t border-white/[0.05] px-5 py-3 text-center">
              <button className="ds-btn-secondary" onClick={() => setShown((n) => n + PAGE_SIZE)}>
                Show {Math.min(PAGE_SIZE, visible.length - shown)} more <span className="opacity-60">({visible.length - shown} left)</span>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function Section({ n, title, hint, children }: { n: number; title: string; hint: string; children: React.ReactNode }) {
  return (
    <section className="ds-card p-5">
      <div className="mb-4 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-indigo-500/20 text-[11px] font-semibold text-indigo-300">{n}</span>
        <h2 className="text-[14px] font-semibold text-gray-100">{title}</h2>
        <span className="text-[12px] text-gray-500">{hint}</span>
      </div>
      {children}
    </section>
  );
}

function Field({ label, grow, children }: { label: string; grow?: boolean; children: React.ReactNode }) {
  return (
    <label className={`flex flex-col gap-1.5 ${grow ? "min-w-[240px] flex-1" : ""}`}>
      <span className="text-[11px] font-medium uppercase tracking-wider text-gray-500">{label}</span>
      {children}
    </label>
  );
}
