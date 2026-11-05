"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

// ---------------------------------------------------------------------------
// Types — mirror backend/release_sync.py
// ---------------------------------------------------------------------------

interface DeviceOption { device: string; platform: string | null; supported: boolean }

interface Overview {
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
  overview: { previous: Overview; current: Overview };
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

interface Ref { repo: string; base: string; head: string }

interface RepoResult { repo: string; base: string; head: string; total: number; commits: unknown[]; error: string }

interface DryRun { sent: boolean; method: string; url: string; body: Record<string, unknown> }

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://172.16.23.15:8000";
const CHANGELOG_LIMIT = 20000;

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof body.detail === "string" ? body.detail : `Request failed (HTTP ${res.status})`);
  return body as T;
}

const post = <T,>(path: string, data: unknown) =>
  call<T>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

let rowId = 0;
const newRow = (device = ""): DeviceRow => ({ id: ++rowId, device, rc1Url: "", rc2Url: "", state: "idle" });

export default function ReleaseSync() {
  const [edition, setEdition] = useState("x.6.17");
  const [rc, setRc] = useState("x.6.17.rc.2");
  const [project, setProject] = useState("DT");

  const [devices, setDevices] = useState<DeviceOption[]>([]);
  const [rows, setRows] = useState<DeviceRow[]>([newRow("D450_US")]);

  const [refs, setRefs] = useState<Ref[]>([]);
  const [refsDevice, setRefsDevice] = useState("D450_US");
  const [refsNote, setRefsNote] = useState("");
  const [loadingRefs, setLoadingRefs] = useState(false);
  const [changelog, setChangelog] = useState("");
  const [repoResults, setRepoResults] = useState<RepoResult[]>([]);
  const [loadingLog, setLoadingLog] = useState(false);
  const [logError, setLogError] = useState("");

  const [dryRun, setDryRun] = useState<DryRun | null>(null);
  const [dryError, setDryError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    call<{ devices: DeviceOption[] }>("/release-sync/devices").then((d) => setDevices(d.devices)).catch(() => {});
  }, []);

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
      patchRow(row.id, { state: "error", summary: undefined, error: e instanceof Error ? e.message : String(e) });
    }
  }, [patchRow]);

  const readyRows = rows.filter((r) => r.device && r.rc1Url.trim() && r.rc2Url.trim());
  const doneRows = rows.filter((r) => r.state === "done" && r.summary);

  const loadRefs = async () => {
    setLoadingRefs(true); setRefsNote(""); setLogError("");
    try {
      const q = new URLSearchParams({ edition, rc, device: refsDevice, project });
      const out = await call<{ previous_rc: string | null; refs: Ref[] }>(`/release-sync/refs?${q}`);
      setRefs(out.refs);
      const missing = out.refs.filter((r) => !r.base || !r.head).length;
      setRefsNote(
        (out.previous_rc ? `Base = tags of ${out.previous_rc}. ` : "This is the first RC, so there is no previous RC: enter the base refs. ") +
        (missing ? `${missing} repo(s) have no tag in the release notes yet. Fill them in.` : ""),
      );
    } catch (e) {
      setLogError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingRefs(false);
    }
  };

  const fetchLog = async () => {
    setLoadingLog(true); setLogError("");
    try {
      const out = await post<{ text: string; repos: RepoResult[] }>("/release-sync/changelog", { refs });
      setChangelog(out.text);
      setRepoResults(out.repos);
      setDryRun(null);
    } catch (e) {
      setLogError(e instanceof Error ? e.message : String(e));
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
      setDryError(e instanceof Error ? e.message : String(e));
    }
  };

  const json = useMemo(() => (dryRun ? JSON.stringify(dryRun.body, null, 2) : ""), [dryRun]);
  const copy = async () => {
    try { await navigator.clipboard.writeText(JSON.stringify(dryRun, null, 2)); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
  };

  const usedDevices = new Set(rows.map((r) => r.device));
  const logOver = changelog.length > CHANGELOG_LIMIT;

  return (
    <div className="space-y-5">
      {/* 1 · Release */}
      <Section n={1} title="Release" hint="Where the results will be posted in the release notes">
        <div className="flex flex-wrap gap-3">
          <Field label="Release"><input className="ds-input !text-[13px] w-40" value={edition} onChange={(e) => { setEdition(e.target.value); setDryRun(null); }} /></Field>
          <Field label="RC"><input className="ds-input !text-[13px] w-48" value={rc} onChange={(e) => { setRc(e.target.value); setDryRun(null); }} /></Field>
          <Field label="Project"><input className="ds-input !text-[13px] w-24" value={project} onChange={(e) => { setProject(e.target.value); setDryRun(null); }} /></Field>
        </div>
      </Section>

      {/* 2 · Test reports */}
      <Section n={2} title="Test automation reports" hint="One row per device: the previous and current Jenkins report links">
        <div className="space-y-3">
          {rows.map((row) => (
            <div key={row.id} className="rounded-xl border border-white/[0.06] p-3">
              <div className="flex flex-wrap items-end gap-3">
                <Field label="Device">
                  <select
                    className="ds-input !text-[13px] w-40"
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
              {row.state === "error" && <p className="mt-2 text-[12px] text-red-400">{row.error}</p>}
              {row.state === "done" && row.summary && <SummaryCard s={row.summary} />}
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
      <Section n={3} title="Change log" hint="Commits between the previous and current tags of each repo, from GitHub. One log for the whole RC.">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Take tags from device">
            <select className="ds-input !text-[13px] w-40" value={refsDevice} onChange={(e) => setRefsDevice(e.target.value)}>
              {devices.map((d) => <option key={d.device} value={d.device}>{d.device}</option>)}
              {devices.length === 0 && <option value={refsDevice}>{refsDevice}</option>}
            </select>
          </Field>
          <button className="ds-btn-secondary" onClick={loadRefs} disabled={loadingRefs}>{loadingRefs ? "Loading…" : "Load tags from release notes"}</button>
        </div>
        {refsNote && <p className="mt-2 text-[12px] text-gray-400">{refsNote}</p>}

        {refs.length > 0 && (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-gray-500">
                  <th className="py-1 pr-3 font-medium">Repo</th><th className="py-1 pr-3 font-medium">Base (previous)</th>
                  <th className="py-1 pr-3 font-medium">Head (current)</th><th className="py-1 font-medium">Result</th>
                </tr>
              </thead>
              <tbody>
                {refs.map((r, i) => {
                  const res = repoResults.find((x) => x.repo === r.repo);
                  return (
                    <tr key={r.repo + i}>
                      <td className="py-1 pr-3 text-gray-300">{r.repo}</td>
                      {(["base", "head"] as const).map((k) => (
                        <td key={k} className="py-1 pr-3">
                          <input className="ds-input !py-1 !text-[12.5px] w-56" value={r[k]} placeholder="tag or branch"
                            onChange={(e) => setRefs((rs) => rs.map((x, j) => (j === i ? { ...x, [k]: e.target.value } : x)))} />
                        </td>
                      ))}
                      <td className="py-1 text-[12px]">
                        {res ? (res.error ? <span className="text-red-400">{res.error}</span> : <span className="text-gray-400">{res.commits.length} commits{res.total > res.commits.length ? ` (${res.total - res.commits.length} merges skipped)` : ""}</span>) : <span className="text-gray-600">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <button className="ds-btn-primary mt-3" onClick={fetchLog} disabled={loadingLog}>{loadingLog ? "Fetching commits…" : "Fetch commits"}</button>
          </div>
        )}
        {logError && <p className="mt-2 text-[12px] text-red-400">{logError}</p>}

        {(changelog || repoResults.length > 0) && (
          <div className="mt-3">
            <textarea
              className="ds-input w-full min-h-[200px] font-mono !text-[12px]"
              value={changelog}
              onChange={(e) => { setChangelog(e.target.value); setDryRun(null); }}
              placeholder="Fetched commits appear here. You can edit before posting."
            />
            <p className={`mt-1 text-[11.5px] ${logOver ? "text-red-400" : "text-gray-500"}`}>
              {changelog.length.toLocaleString()} / {CHANGELOG_LIMIT.toLocaleString()} characters{logOver ? " — too long for the release notes; trim it" : ""}
            </p>
          </div>
        )}
      </Section>

      {/* 4 · Review & post */}
      <Section n={4} title="Review and post" hint="Shows exactly what will be sent. Nothing is sent yet.">
        <div className="flex flex-wrap items-center gap-3">
          <button className="ds-btn-secondary" onClick={buildDryRun} disabled={doneRows.length === 0 && !changelog.trim()}>Preview request</button>
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
            <div className="flex items-center justify-between">
              <p className="text-[12px] text-gray-400"><span className="font-mono text-indigo-300">{dryRun.method}</span> <span className="font-mono">{dryRun.url}</span></p>
              <button className="ds-btn-secondary" onClick={copy}>{copied ? "Copied" : "Copy request"}</button>
            </div>
            <pre className="mt-2 max-h-[420px] overflow-auto rounded-xl border border-white/[0.06] bg-black/30 p-3 text-[11.5px] leading-relaxed text-gray-300">{json}</pre>
          </div>
        )}
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function Section({ n, title, hint, children }: { n: number; title: string; hint: string; children: React.ReactNode }) {
  return (
    <section className="ds-card p-4">
      <div className="mb-3 flex items-baseline gap-2">
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

function SummaryCard({ s }: { s: DeviceSummary }) {
  const p = s.overview.previous, c = s.overview.current;
  const delta = Math.round((c.pass_pct - p.pass_pct) * 10) / 10;
  return (
    <div className="mt-3 space-y-2 text-[12.5px]">
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-gray-300">
        <span>Pass <b>{p.pass_pct}%</b> → <b>{c.pass_pct}%</b>{" "}
          <span className={delta < 0 ? "text-red-400" : "text-emerald-400"}>({delta >= 0 ? "+" : ""}{delta})</span>
          <span className="text-gray-500"> · {c.pass}/{c.total}</span></span>
        <span>Known fails <b>{c.known_failures}</b></span>
        <span>Unknown fails <b>{c.unknown_failures}</b></span>
        <span>Not executed <b>{c.not_executed}</b></span>
        <span className="text-gray-500">Fixed {s.comparison.fixed} · Persistent {s.comparison.persistent_failures.known + s.comparison.persistent_failures.unknown} · New {s.comparison.new} · Removed {s.comparison.removed}</span>
      </div>
      <details className="rounded-lg bg-white/[0.02] px-3 py-2">
        <summary className="cursor-pointer text-gray-300">
          Regressions: <b>{s.regressions.length}</b>
          <span className="text-gray-500"> ({s.comparison.regressions.known} known, {s.comparison.regressions.unknown} unknown)</span>
        </summary>
        {s.regressions.length === 0 ? <p className="mt-2 text-gray-500">None.</p> : (
          <ul className="mt-2 max-h-72 space-y-1.5 overflow-auto">
            {s.regressions.map((r) => (
              <li key={r.service + r.tc_id} className="text-[12px]">
                <span className="font-mono text-indigo-300">{r.tc_id}</span>{" "}
                <span className="text-gray-500">{r.service}</span>{" "}
                <span className={r.known ? "text-amber-300" : "text-red-400"}>{r.known ? `known${r.linked_issue ? ` · ${r.linked_issue}` : ""}` : "unknown"}</span>
                {r.error && <div className="truncate text-gray-500" title={r.error}>{r.error}</div>}
              </li>
            ))}
          </ul>
        )}
      </details>
    </div>
  );
}
