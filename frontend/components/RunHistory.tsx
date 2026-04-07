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

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* Heading */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500/15 to-violet-500/15 border border-indigo-500/10">
            <svg className="h-[18px] w-[18px] text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div>
            <h2 className="ds-page-title">
              Run History
            </h2>
            <p className="ds-page-subtitle">
              View past script executions and their logs
            </p>
          </div>
        </div>
        <button
          onClick={fetchRuns}
          disabled={loading}
          className="ds-btn-secondary"
        >
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
        <div className="ds-card-header flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-300">
            Executions{" "}
            {!loading && (
              <span className="font-normal text-gray-500">· {runs.length} runs</span>
            )}
          </h3>
        </div>

        <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Spinner />
              <span className="ml-3 text-sm text-gray-500">Loading history…</span>
            </div>
          ) : runs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div className="relative mb-5">
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500/10 to-violet-500/10 border border-indigo-500/10">
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
                {runs.map((run) => (
                  <tr
                    key={run.id}
                    className="transition-colors hover:bg-white/[0.02]"
                  >
                    <td className="px-5 py-3.5">
                      <span className="font-medium text-gray-200">
                        {run.script_name}
                      </span>
                    </td>
                    <td className="px-5 py-3.5">
                      <StatusBadge status={run.status} />
                    </td>
                    <td className="px-5 py-3.5 font-mono text-gray-400 text-xs">
                      {formatTime(run.execution_time)}
                    </td>
                    <td className="px-5 py-3.5 text-gray-400 text-xs">
                      {formatTimestamp(run.timestamp)}
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      <button
                        onClick={() => setSelectedRun(run)}
                        className="ds-badge ds-badge-info cursor-pointer hover:opacity-80 transition-opacity"
                      >
                        <LogsIcon />
                        View Logs
                      </button>
                    </td>
                  </tr>
                ))}
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
