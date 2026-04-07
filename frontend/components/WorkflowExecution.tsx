"use client";

import { useCallback, useEffect, useState } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WorkflowRun {
  id: number;
  workflow_id: number;
  workflow_name: string;
  status: string;
  start_time: string;
  end_time: string | null;
}

interface StepDetail {
  id: number;
  node_id: string;
  script_name: string;
  status: string;
  stdout: string;
  stderr: string;
  execution_time: number;
  retry_attempts: number;
  output_json: string;
}

interface RunDetail extends WorkflowRun {
  definition_json: string;
  steps: StepDetail[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://172.16.23.15:8000";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function WorkflowExecution() {
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedRun, setSelectedRun] = useState<RunDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [selectedStep, setSelectedStep] = useState<StepDetail | null>(null);

  const fetchRuns = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/workflows/runs`);
      setRuns(await res.json());
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { fetchRuns(); }, [fetchRuns]);

  const openRun = async (runId: number) => {
    setLoadingDetail(true);
    setSelectedStep(null);
    try {
      const res = await fetch(`${API_BASE}/workflows/runs/${runId}`);
      setSelectedRun(await res.json());
    } catch {}
    setLoadingDetail(false);
  };

  const formatTs = (ts: string | null): string => {
    if (!ts) return "—";
    try { return new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
    catch { return ts; }
  };

  const duration = (run: WorkflowRun): string => {
    if (!run.end_time) return "—";
    try {
      const ms = new Date(run.end_time).getTime() - new Date(run.start_time).getTime();
      return `${(ms / 1000).toFixed(1)}s`;
    } catch { return "—"; }
  };

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500/15 to-violet-500/15 border border-indigo-500/10">
            <svg className="h-[18px] w-[18px] text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5" />
            </svg>
          </div>
          <div>
            <h2 className="ds-page-title">Workflow Runs</h2>
            <p className="ds-page-subtitle">Execution history for all workflows</p>
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

      {/* Runs table */}
      <div className="ds-card overflow-hidden">
        <div className="ds-card-header">
          <h3 className="text-sm font-semibold text-gray-300">
            Recent Runs <span className="font-normal text-gray-500">· {runs.length}</span>
          </h3>
        </div>
        <div className="overflow-x-auto max-h-[400px] overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Spinner /> <span className="ml-3 text-sm text-gray-500">Loading…</span>
            </div>
          ) : runs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div className="relative mb-5">
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500/10 to-violet-500/10 border border-indigo-500/10">
                  <svg className="h-8 w-8 text-indigo-400/40" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5" />
                  </svg>
                </div>
              </div>
              <p className="text-[15px] font-medium text-gray-400 mb-1">No workflow runs yet</p>
              <p className="text-sm text-gray-600 max-w-xs">Execute a workflow and results will appear here</p>
            </div>
          ) : (
            <table className="ds-table">
              <thead className="sticky top-0 bg-[#12141c] border-b border-white/[0.06] z-10">
                <tr>
                  <th className="px-5 py-3 ds-section-title">Workflow</th>
                  <th className="px-5 py-3 ds-section-title">Status</th>
                  <th className="px-5 py-3 ds-section-title">Duration</th>
                  <th className="px-5 py-3 ds-section-title">Started</th>
                  <th className="px-5 py-3 ds-section-title text-right">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.03]">
                {runs.map(run => (
                  <tr key={run.id} className="hover:bg-white/[0.02] transition-colors">
                    <td className="px-5 py-3.5 font-medium text-gray-200">{run.workflow_name}</td>
                    <td className="px-5 py-3.5"><StatusBadge status={run.status} /></td>
                    <td className="px-5 py-3.5 text-xs font-mono text-gray-400">{duration(run)}</td>
                    <td className="px-5 py-3.5 text-xs text-gray-400">{formatTs(run.start_time)}</td>
                    <td className="px-5 py-3.5 text-right">
                      <button
                        onClick={() => openRun(run.id)}
                        className="ds-badge ds-badge-info cursor-pointer hover:opacity-80 transition-opacity"
                      >
                        View
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Run detail modal */}
      {selectedRun && (
        <RunDetailModal
          run={selectedRun}
          loading={loadingDetail}
          selectedStep={selectedStep}
          onSelectStep={setSelectedStep}
          onClose={() => { setSelectedRun(null); setSelectedStep(null); }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Run Detail Modal
// ---------------------------------------------------------------------------

function RunDetailModal({
  run,
  loading,
  selectedStep,
  onSelectStep,
  onClose,
}: {
  run: RunDetail;
  loading: boolean;
  selectedStep: StepDetail | null;
  onSelectStep: (s: StepDetail | null) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  return (
    <div
      className="ds-modal-overlay"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="ds-modal max-w-4xl max-h-[85vh]">
        {/* Header */}
        <div className="ds-modal-header shrink-0">
          <div>
            <h3 className="text-lg font-semibold text-white">{run.workflow_name}</h3>
            <div className="mt-1 flex items-center gap-3 text-xs text-gray-500">
              <StatusBadge status={run.status} />
              <span>Run #{run.id}</span>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 transition-colors p-1 rounded-lg hover:bg-white/[0.06]">
            <CloseIcon />
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Spinner />
          </div>
        ) : (
          <div className="flex flex-1 min-h-0">
            {/* Steps list */}
            <div className="w-64 shrink-0 border-r border-white/[0.06] overflow-y-auto">
              <div className="px-4 py-3 border-b border-white/[0.04]">
                <h4 className="ds-section-title">
                  Steps ({run.steps?.length ?? 0})
                </h4>
              </div>
              <div className="divide-y divide-white/[0.03]">
                {(run.steps ?? []).map(step => (
                  <button
                    key={step.id}
                    onClick={() => onSelectStep(step)}
                    className={`w-full text-left px-4 py-3 flex items-center gap-2 transition-colors ${
                      selectedStep?.id === step.id ? "bg-indigo-500/[0.08]" : "hover:bg-white/[0.03]"
                    }`}
                  >
                    <span className={`h-2 w-2 rounded-full shrink-0 ${
                      step.status === "success" ? "bg-green-400" :
                      step.status === "failed"  ? "bg-red-400"   :
                      step.status === "running" ? "bg-blue-400"  :
                      "bg-gray-500"
                    }`} />
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-gray-200 truncate">{step.script_name}</p>
                      <p className="text-[10px] text-gray-500">
                        {step.status} · {step.execution_time.toFixed(1)}s
                        {step.retry_attempts > 0 && ` · ${step.retry_attempts} retries`}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* Step detail */}
            <div className="flex-1 overflow-y-auto p-6">
              {selectedStep ? (
                <div className="space-y-4">
                  <div className="flex items-center gap-3">
                    <h4 className="text-sm font-bold text-white">{selectedStep.script_name}</h4>
                    <StatusBadge status={selectedStep.status} />
                    <span className="text-xs font-mono text-gray-500">{selectedStep.execution_time.toFixed(3)}s</span>
                  </div>

                  {selectedStep.retry_attempts > 0 && (
                    <p className="text-xs text-yellow-400">Retried {selectedStep.retry_attempts} time(s)</p>
                  )}

                  {selectedStep.stdout && (
                    <div>
                      <p className="mb-1 ds-label text-green-500">stdout</p>
                      <pre className="rounded-[10px] bg-[#0a0c12] p-3 text-xs text-green-400 leading-relaxed overflow-auto max-h-48 font-mono">
                        {selectedStep.stdout}
                      </pre>
                    </div>
                  )}

                  {selectedStep.stderr && (
                    <div>
                      <p className="mb-1 ds-label text-red-500">stderr</p>
                      <pre className="rounded-[10px] bg-[#0a0c12] p-3 text-xs text-red-400 leading-relaxed overflow-auto max-h-48 font-mono">
                        {selectedStep.stderr}
                      </pre>
                    </div>
                  )}

                  {selectedStep.output_json && selectedStep.output_json !== "{}" && (
                    <div>
                      <p className="mb-1 ds-label text-indigo-400">Output</p>
                      <pre className="rounded-[10px] bg-[#0a0c12] p-3 text-xs text-indigo-300 leading-relaxed overflow-auto font-mono">
                        {typeof selectedStep.output_json === "string"
                          ? JSON.stringify(JSON.parse(selectedStep.output_json), null, 2)
                          : JSON.stringify(selectedStep.output_json, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-sm text-gray-600 italic text-center py-12">
                  Select a step to view details.
                </p>
              )}
            </div>
          </div>
        )}

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
  const cls =
    status === "success" ? "ds-badge-success" :
    status === "failed"  ? "ds-badge-error"   :
    status === "running" ? "ds-badge-info"     :
    "ds-badge-neutral";
  return (
    <span className={`ds-badge ${cls}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${
        status === "success" ? "bg-green-400" :
        status === "failed"  ? "bg-red-400"   :
        status === "running" ? "bg-blue-400"  :
        "bg-gray-500"
      }`} />
      {status}
    </span>
  );
}

function RefreshIcon({ spinning = false }: { spinning?: boolean }) {
  return (
    <svg className={`h-4 w-4 ${spinning ? "animate-spin" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
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

function CloseIcon() {
  return (
    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}
