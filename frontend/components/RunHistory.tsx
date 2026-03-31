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

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

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
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-white">
            Run History
          </h2>
          <p className="mt-1 text-sm text-gray-400">
            View past script executions and their logs.
          </p>
        </div>
        <button
          onClick={fetchRuns}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-lg border border-gray-700 bg-gray-800 px-4 py-2 text-sm font-medium text-gray-300 transition hover:bg-gray-700 hover:text-white disabled:opacity-50"
        >
          <RefreshIcon spinning={loading} />
          Refresh
        </button>
      </div>

      {/* Error banner */}
      {error && (
        <div className="rounded-lg border border-red-800 bg-red-950/60 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {/* Table card */}
      <div className="overflow-hidden rounded-xl border border-gray-800 bg-gray-900/70 shadow-sm">
        <div className="border-b border-gray-800 bg-gray-900 px-5 py-3 flex items-center justify-between">
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
            <div className="flex flex-col items-center justify-center py-16 text-gray-500">
              <EmptyIcon />
              <p className="mt-3 text-sm">No executions recorded yet.</p>
              <p className="text-xs text-gray-600">Run a script and it will appear here.</p>
            </div>
          ) : (
            <table className="w-full text-sm text-left">
              <thead className="sticky top-0 bg-gray-900 border-b border-gray-800 z-10">
                <tr>
                  <th className="px-5 py-3 font-semibold text-gray-400 text-xs uppercase tracking-wider">
                    Script
                  </th>
                  <th className="px-5 py-3 font-semibold text-gray-400 text-xs uppercase tracking-wider">
                    Status
                  </th>
                  <th className="px-5 py-3 font-semibold text-gray-400 text-xs uppercase tracking-wider">
                    Execution Time
                  </th>
                  <th className="px-5 py-3 font-semibold text-gray-400 text-xs uppercase tracking-wider">
                    Timestamp
                  </th>
                  <th className="px-5 py-3 font-semibold text-gray-400 text-xs uppercase tracking-wider text-right">
                    Logs
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/60">
                {runs.map((run) => (
                  <tr
                    key={run.id}
                    className="transition hover:bg-gray-800/40"
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
                        className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600/20 px-3 py-1.5 text-xs font-medium text-indigo-400 hover:bg-indigo-600/30 transition"
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-3xl max-h-[85vh] flex flex-col rounded-2xl border border-gray-700 bg-gray-900 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4 shrink-0">
          <div>
            <h3 className="text-lg font-bold text-white">{run.script_name}</h3>
            <div className="mt-1 flex items-center gap-3 text-xs text-gray-500">
              <StatusBadge status={run.status} />
              <span className="font-mono">{run.execution_time.toFixed(3)}s</span>
              <span>{new Date(run.timestamp).toLocaleString()}</span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-gray-500 transition hover:bg-gray-800 hover:text-gray-300"
          >
            <CloseIcon />
          </button>
        </div>

        {/* Arguments */}
        {run.arguments && run.arguments !== "{}" && (
          <div className="border-b border-gray-800 px-6 py-3 shrink-0">
            <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1">
              Arguments
            </p>
            <pre className="text-xs text-gray-400 font-mono bg-gray-800/50 rounded-lg px-3 py-2 overflow-x-auto">
              {JSON.stringify(JSON.parse(run.arguments), null, 2)}
            </pre>
          </div>
        )}

        {/* Log panels */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {hasStdout && (
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-green-500">
                stdout
              </p>
              <pre className="rounded-lg bg-gray-950 p-4 text-sm text-green-400 leading-relaxed overflow-x-auto max-h-64 overflow-y-auto font-mono">
                {run.stdout}
              </pre>
            </div>
          )}

          {hasStderr && (
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-red-500">
                stderr
              </p>
              <pre className="rounded-lg bg-gray-950 p-4 text-sm text-red-400 leading-relaxed overflow-x-auto max-h-64 overflow-y-auto font-mono">
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
        <div className="border-t border-gray-800 px-6 py-3 shrink-0 flex justify-end">
          <button
            onClick={onClose}
            className="rounded-lg bg-gray-800 px-4 py-2 text-sm font-medium text-gray-300 transition hover:bg-gray-700"
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
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ${
        isSuccess
          ? "bg-green-900/50 text-green-400 border border-green-800"
          : "bg-red-900/50 text-red-400 border border-red-800"
      }`}
    >
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
    <svg className="h-12 w-12 text-gray-700" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
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
