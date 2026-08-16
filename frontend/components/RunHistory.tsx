"use client";

import { useCallback, useEffect, useState } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ScriptRun {
  id: number;
  script_name: string;
  arguments: string;
  stdout: string;
  stderr: string;
  status: string;
  execution_time: number;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://172.16.23.15:8000";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function RunHistory() {
  const [runs, setRuns] = useState<ScriptRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<ScriptRun | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "success" | "failed">("all");

  const fetchRuns = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/runs`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: ScriptRun[] = await res.json();
      setRuns(data);
    } catch {
      setError("Failed to fetch run history. Is the backend running?");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRuns();
  }, [fetchRuns]);

  const formatTime = (seconds: number): string => {
    if (seconds < 1) return `${(seconds * 1000).toFixed(0)}ms`;
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    const mins = Math.floor(seconds / 60);
    const secs = (seconds % 60).toFixed(0);
    return `${mins}m ${secs}s`;
  };

  const formatTimestamp = (ts: string): string => {
    try {
      const d = new Date(ts);
      return d.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch {
      return ts;
    }
  };

  /* Relative age reads faster than an absolute clock time when you are
     scanning for "what just ran" — the exact stamp stays on hover. */
  const formatRelative = (ts: string): string => {
    const then = new Date(ts).getTime();
    if (Number.isNaN(then)) return ts;
    const secs = Math.round((Date.now() - then) / 1000);
    if (secs < 0) return "just now";
    if (secs < 60) return `${secs}s ago`;
    const mins = Math.round(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.round(hrs / 24);
    if (days < 30) return `${days}d ago`;
    return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };

  const isFailed = (status: string) => status.toLowerCase() !== "success";

  const visibleRuns = runs.filter((run) => {
    if (statusFilter === "success" && isFailed(run.status)) return false;
    if (statusFilter === "failed" && !isFailed(run.status)) return false;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (
      run.script_name.toLowerCase().includes(q) ||
      (run.arguments ?? "").toLowerCase().includes(q)
    );
  });

  const failedCount = runs.filter((r) => isFailed(r.status)).length;

  return (
    <div className="w-full space-y-6">
      {/* Identity lives in the top bar; only the action remains. */}
      <div className="flex items-center justify-end">
        <button onClick={fetchRuns} disabled={loading} className="ds-btn-secondary">
          <RefreshIcon spinning={loading} />
          Refresh
        </button>
      </div>

      {/* Error banner */}
      {error && (
        <div className="rounded-xl border border-red-500/15 bg-red-500/[0.06] px-4 py-3 text-sm text-red-300 flex items-center gap-3">
          <svg className="h-4 w-4 shrink-0 text-red-400/80" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
          </svg>
          {error}
        </div>
      )}

      {/* Table card */}
      <div className="ds-card overflow-hidden">
        <div className="ds-card-header flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-gray-300">
            Executions{" "}
            {!loading && (
              <span className="font-normal text-gray-500">
                · {visibleRuns.length === runs.length
                  ? `${runs.length} runs`
                  : `${visibleRuns.length} of ${runs.length}`}
              </span>
            )}
          </h3>

          {!loading && runs.length > 0 && (
            <div className="flex items-center gap-2">
              {/* Status segments — failed is the state people hunt for, so
                  it carries its own count and is reachable in one click. */}
              <div className="flex items-center rounded-lg border border-white/[0.07] bg-white/[0.02] p-0.5">
                {([
                  ["all", `All`],
                  ["success", `Passed`],
                  ["failed", failedCount ? `Failed · ${failedCount}` : `Failed`],
                ] as const).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setStatusFilter(key)}
                    aria-pressed={statusFilter === key}
                    className={`px-2.5 py-1 rounded-[6px] text-[12px] font-medium transition-colors duration-150 ${
                      statusFilter === key
                        ? "bg-white/[0.07] text-gray-100"
                        : "text-gray-500 hover:text-gray-300"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div className="relative">
                <svg
                  className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-600"
                  fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
                </svg>
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Filter scripts…"
                  aria-label="Filter runs by script name or arguments"
                  className="ds-input w-52 !py-1.5 !pl-8 !pr-7 !text-[13px]"
                />
                {query && (
                  <button
                    onClick={() => setQuery("")}
                    aria-label="Clear filter"
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-600 hover:text-gray-300 transition-colors duration-150"
                  >
                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="overflow-x-auto overflow-y-auto max-h-[min(640px,calc(100vh-300px))]">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Spinner />
              <span className="ml-3 text-sm text-gray-500">Loading history…</span>
            </div>
          ) : runs.length === 0 ? (
            <div className="ds-empty">
              <div className="relative mb-5">
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-white/[0.04] border border-white/[0.07]">
                  <EmptyIcon />
                </div>
              </div>
              <p className="text-[15px] font-medium text-gray-400 mb-1">No executions recorded yet</p>
              <p className="text-sm text-gray-600 max-w-xs">Run a script and it will appear here</p>
            </div>
          ) : (
            <table className="ds-table">
              <thead className="sticky top-0 bg-[#12141c] border-b border-white/[0.06] z-10">
                <tr>
                  <th className="px-5 py-3 ds-section-title">
                    Script
                  </th>
                  <th className="px-5 py-3 ds-section-title">
                    Status
                  </th>
                  <th className="px-5 py-3 ds-section-title">
                    Execution Time
                  </th>
                  <th className="px-5 py-3 ds-section-title">
                    Timestamp
                  </th>
                  <th className="px-5 py-3 ds-section-title text-right">
                    Logs
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.03]">
                {visibleRuns.map((run) => (
                  /* The whole row opens the logs — a 5px-tall badge was the
                     only hit target before. The badge stays as the visible
                     affordance but the click area is now the full row. */
                  <tr
                    key={run.id}
                    onClick={() => setSelectedRun(run)}
                    tabIndex={0}
                    role="button"
                    aria-label={`View logs for ${run.script_name}`}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelectedRun(run);
                      }
                    }}
                    className="group cursor-pointer transition-colors duration-150 hover:bg-white/[0.03] focus-visible:bg-white/[0.04]"
                  >
                    <td className="px-5 py-2.5">
                      <span className="font-medium text-gray-200">
                        {run.script_name}
                      </span>
                    </td>
                    <td className="px-5 py-2.5">
                      <StatusBadge status={run.status} />
                    </td>
                    <td className="px-5 py-2.5 font-mono text-gray-400 text-xs tabular-nums">
                      {formatTime(run.execution_time)}
                    </td>
                    <td
                      className="px-5 py-2.5 text-gray-400 text-xs tabular-nums"
                      title={formatTimestamp(run.timestamp)}
                    >
                      {formatRelative(run.timestamp)}
                    </td>
                    <td className="px-5 py-2.5 text-right">
                      <span className="ds-badge ds-badge-info opacity-70 transition-opacity duration-150 group-hover:opacity-100">
                        <LogsIcon />
                        View Logs
                      </span>
                    </td>
                  </tr>
                ))}
                {visibleRuns.length === 0 && (
                  <tr>
                    <td colSpan={5}>
                      <div className="ds-empty !border-0 !bg-transparent">
                        <p className="ds-empty-title">No runs match this filter</p>
                        <p className="ds-empty-hint">
                          {query
                            ? <>Nothing matches “{query}”.</>
                            : "Try a different status."}
                        </p>
                        <button
                          onClick={() => { setQuery(""); setStatusFilter("all"); }}
                          className="ds-btn-secondary mt-1"
                        >
                          Clear filters
                        </button>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Log Modal */}
      {selectedRun && (
        <LogModal run={selectedRun} onClose={() => setSelectedRun(null)} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Log Modal
// ---------------------------------------------------------------------------

function LogModal({ run, onClose }: { run: ScriptRun; onClose: () => void }) {
  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const hasStdout = run.stdout && run.stdout.trim().length > 0;
  const hasStderr = run.stderr && run.stderr.trim().length > 0;

  return (
    <div
      className="ds-modal-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="ds-modal max-w-3xl max-h-[85vh]">
        {/* Header */}
        <div className="ds-modal-header shrink-0">
          <div>
            <h3 className="text-lg font-semibold text-white">{run.script_name}</h3>
            <div className="mt-1 flex items-center gap-3 text-xs text-gray-500">
              <StatusBadge status={run.status} />
              <span className="font-mono">{run.execution_time.toFixed(3)}s</span>
              <span>{new Date(run.timestamp).toLocaleString()}</span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-gray-500 transition-colors hover:bg-white/[0.06] hover:text-gray-300"
          >
            <CloseIcon />
          </button>
        </div>

        {/* Arguments */}
        {run.arguments && run.arguments !== "{}" && (
          <div className="border-b border-white/[0.06] px-6 py-3 shrink-0">
            <p className="ds-label mb-1">Arguments</p>
            <pre className="text-xs text-gray-400 font-mono bg-[#0a0c12] rounded-[10px] px-3 py-2 overflow-x-auto">
              {JSON.stringify(JSON.parse(run.arguments), null, 2)}
            </pre>
          </div>
        )}

        {/* Log panels */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {hasStdout && (
            <div>
              <p className="mb-2 ds-label text-green-500">
                stdout
              </p>
              <pre className="rounded-[10px] bg-[#0a0c12] p-4 text-sm text-green-400 leading-relaxed overflow-x-auto max-h-64 overflow-y-auto font-mono">
                {run.stdout}
              </pre>
            </div>
          )}

          {hasStderr && (
            <div>
              <p className="mb-2 ds-label text-red-500">
                stderr
              </p>
              <pre className="rounded-[10px] bg-[#0a0c12] p-4 text-sm text-red-400 leading-relaxed overflow-x-auto max-h-64 overflow-y-auto font-mono">
                {run.stderr}
              </pre>
            </div>
          )}

          {!hasStdout && !hasStderr && (
            <p className="py-8 text-center text-sm text-gray-600 italic">
              No output was captured for this execution.
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-white/[0.06] px-6 py-3 shrink-0 flex justify-end">
          <button
            onClick={onClose}
            className="ds-btn-secondary"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: string }) {
  const isSuccess = status === "success";
  return (
    <span className={`ds-badge ${isSuccess ? "ds-badge-success" : "ds-badge-error"}`}>
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          isSuccess ? "bg-green-400" : "bg-red-400"
        }`}
      />
      {isSuccess ? "Success" : "Failed"}
    </span>
  );
}

function RefreshIcon({ spinning = false }: { spinning?: boolean }) {
  return (
    <svg
      className={`h-4 w-4 ${spinning ? "animate-spin" : ""}`}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
      />
    </svg>
  );
}

function LogsIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
    </svg>
  );
}

function EmptyIcon() {
  return (
    <svg className="h-8 w-8 text-indigo-400/40" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg className="h-5 w-5 animate-spin text-gray-500" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}
