"use client";

import { Fragment, useCallback, useEffect, useState } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BuildDevice {
  device_id: string;
  sku: string;
  os_version: string;
  package: string;
  ip: string;
  services?: string[];
  total: number;
  pass: number;
  fail: number;
  not_executed: number;
  not_applicable: number;
  pass_pct: number;
}

interface LoggedBuild {
  build_number: number;
  built_at: string;
  duration_sec: number;
  suite: string;
  product: string;
  packages: string[];
  devices: BuildDevice[];
  pass_count: number;
  fail_count: number;
  ne_count: number;
  known_count: number | null;
  unknown_count: number | null;
  pass_pct: number;
  known_pct: number | null;
  unknown_pct: number | null;
  build_url: string;
  report_url: string;
}

interface SyncResult {
  busy: boolean;
  added: number[];
  updated: number[];
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://172.16.23.15:8000";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fmtPct = (v: number | null) => (v === null ? "—" : `${v.toFixed(1)}%`);

const fmtDate = (ts: string) => {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
};

const fmtDuration = (sec: number) => {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function BuildLog() {
  const [builds, setBuilds] = useState<LoggedBuild[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/build-log`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setBuilds(data.builds);
      setError(null);
    } catch {
      setError("Failed to load the build log. Is the backend running?");
    } finally {
      setLoading(false);
    }
  }, []);

  // The backend logs new builds on its own schedule; re-read so a build that
  // finishes while this tab is open shows up without a manual refresh.
  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [load]);

  const syncNow = async () => {
    setSyncing(true);
    setNote(null);
    try {
      const res = await fetch(`${API_BASE}/build-log/sync`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.detail ?? `HTTP ${res.status}`);
      }
      const r: SyncResult = await res.json();
      const n = r.added.length;
      setNote(
        r.busy ? "A sync is already running — try again in a moment."
        : n ? `Logged ${n} new build${n > 1 ? "s" : ""}: ${r.added.map((b) => `#${b}`).join(", ")}`
        : "Already up to date."
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  };

  const toggle = (n: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n); else next.add(n);
      return next;
    });

  return (
    <div className="w-full space-y-6">
      <div className="flex items-center justify-end gap-3">
        {note && <span className="text-xs text-gray-500">{note}</span>}
        <button onClick={syncNow} disabled={syncing} className="ds-btn-secondary">
          <svg
            className={`h-4 w-4 ${syncing ? "animate-spin" : ""}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          {syncing ? "Checking Jenkins…" : "Check for new builds"}
        </button>
      </div>

      {error && (
        <div className="rounded-xl border border-red-500/15 bg-red-500/[0.06] px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      <div className="ds-card overflow-hidden">
        <div className="ds-card-header flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-gray-300">
            Successful builds{" "}
            {!loading && <span className="font-normal text-gray-500">· {builds.length} logged</span>}
          </h3>
          <p className="text-[11px] text-gray-600">
            Percentages are of applicable tests (pass + fail + not executed)
          </p>
        </div>

        <div className="overflow-x-auto">
          {loading ? (
            <p className="py-16 text-center text-sm text-gray-500">Loading build log…</p>
          ) : builds.length === 0 ? (
            <div className="ds-empty">
              <p className="text-[15px] font-medium text-gray-400 mb-1">No builds logged yet</p>
              <p className="text-sm text-gray-600 max-w-sm">
                Successful Test_Automation_Parallel builds are logged automatically.
                Use “Check for new builds” to pull them now.
              </p>
            </div>
          ) : (
            <table className="ds-table">
              <thead>
                <tr>
                  <th>Build</th>
                  <th>Package</th>
                  <th>Devices</th>
                  <th className="text-right">Pass</th>
                  <th className="text-right">Known failures</th>
                  <th className="text-right">Unknown failures</th>
                  <th className="text-right">Report</th>
                </tr>
              </thead>
              <tbody>
                {builds.map((b) => {
                  const open = expanded.has(b.build_number);
                  return (
                    <Fragment key={b.build_number}>
                      <tr
                        onClick={() => toggle(b.build_number)}
                        className="cursor-pointer align-top"
                        aria-expanded={open}
                      >
                        <td>
                          <a
                            href={b.build_url} target="_blank" rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="font-medium text-gray-200 hover:text-indigo-300"
                          >
                            #{b.build_number}
                          </a>
                          <div className="text-[11px] text-gray-500 tabular-nums">
                            {fmtDate(b.built_at)} · {fmtDuration(b.duration_sec)}
                          </div>
                          {b.suite && <div className="text-[11px] text-gray-600">{b.suite}</div>}
                        </td>
                        <td className="font-mono text-xs text-gray-300">
                          {b.packages.length === 0 ? "—" : b.packages.map((p) => <div key={p}>{p}</div>)}
                        </td>
                        <td className="text-gray-400">
                          <span className="inline-flex items-center gap-1.5">
                            <span className={`text-[10px] transition-transform ${open ? "rotate-90" : ""}`}>▶</span>
                            {b.devices.length} device{b.devices.length === 1 ? "" : "s"}
                          </span>
                        </td>
                        <td className="text-right tabular-nums">
                          <span className="font-medium text-emerald-400">{fmtPct(b.pass_pct)}</span>
                          <div className="text-[11px] text-gray-600">{b.pass_count} tests</div>
                        </td>
                        <td className="text-right tabular-nums">
                          <span className="font-medium text-amber-400">{fmtPct(b.known_pct)}</span>
                          <div className="text-[11px] text-gray-600">
                            {b.known_count === null ? "pending" : `${b.known_count} tests`}
                          </div>
                        </td>
                        <td className="text-right tabular-nums">
                          <span className="font-medium text-red-400">{fmtPct(b.unknown_pct)}</span>
                          <div className="text-[11px] text-gray-600">
                            {b.unknown_count === null ? "pending" : `${b.unknown_count} tests`}
                          </div>
                        </td>
                        <td className="text-right">
                          <a
                            href={b.report_url} target="_blank" rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="ds-badge ds-badge-info hover:opacity-80"
                          >
                            Open report ↗
                          </a>
                        </td>
                      </tr>

                      {open && (
                        <tr>
                          <td colSpan={7} className="!p-0 bg-white/[0.015]">
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="text-gray-500 text-left">
                                  <th className="px-5 py-2 font-medium">Device</th>
                                  <th className="px-3 py-2 font-medium">SKU</th>
                                  <th className="px-3 py-2 font-medium">OS</th>
                                  <th className="px-3 py-2 font-medium">Package</th>
                                  <th className="px-3 py-2 font-medium">Services</th>
                                  <th className="px-3 py-2 font-medium text-right">Pass</th>
                                  <th className="px-3 py-2 font-medium text-right">Fail</th>
                                  <th className="px-5 py-2 font-medium text-right">Pass %</th>
                                </tr>
                              </thead>
                              <tbody>
                                {b.devices.map((d) => (
                                  <tr key={d.device_id} className="border-t border-white/[0.03]">
                                    <td className="px-5 py-2 font-mono text-gray-300">{d.device_id}</td>
                                    <td className="px-3 py-2 text-gray-400">{d.sku}</td>
                                    <td className="px-3 py-2 text-gray-400">{d.os_version}</td>
                                    <td className="px-3 py-2 font-mono text-gray-400">{d.package}</td>
                                    <td className="px-3 py-2 text-gray-500">{d.services?.join(", ") || "—"}</td>
                                    <td className="px-3 py-2 text-right tabular-nums text-gray-300">{d.pass}/{d.total - d.not_applicable}</td>
                                    <td className="px-3 py-2 text-right tabular-nums text-gray-300">{d.fail}</td>
                                    <td className="px-5 py-2 text-right tabular-nums text-emerald-400">{d.pass_pct.toFixed(1)}%</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
