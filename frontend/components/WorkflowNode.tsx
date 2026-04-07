"use client";

import { memo } from "react";
import { Handle, Position, NodeProps } from "reactflow";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScriptNodeData {
  script: string;
  retry: number;
  args: Record<string, string>;
  label?: string;
  // runtime state (set during execution)
  status?: "pending" | "running" | "success" | "failed" | "skipped";
  execution_time?: number;
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

const STATUS_COLORS: Record<string, { border: string; bg: string; dot: string; text: string; glow: string }> = {
  pending:  { border: "border-white/[0.08]",  bg: "bg-[#1a1d28]",           dot: "bg-gray-400",   text: "text-gray-400",  glow: "" },
  running:  { border: "border-blue-500/40",   bg: "bg-blue-500/[0.06]",     dot: "bg-blue-400",   text: "text-blue-300",  glow: "shadow-blue-500/15 shadow-lg" },
  success:  { border: "border-green-500/30",  bg: "bg-green-500/[0.04]",    dot: "bg-green-400",  text: "text-green-300", glow: "shadow-green-500/10 shadow-md" },
  failed:   { border: "border-red-500/30",    bg: "bg-red-500/[0.04]",      dot: "bg-red-400",    text: "text-red-300",   glow: "shadow-red-500/15 shadow-lg" },
  skipped:  { border: "border-white/[0.06]",  bg: "bg-[#161922]",           dot: "bg-gray-500",   text: "text-gray-500",  glow: "" },
};

const STATUS_LABELS: Record<string, string> = {
  pending: "Ready",
  running: "Running…",
  success: "Passed",
  failed:  "Failed",
  skipped: "Skipped",
};

// ---------------------------------------------------------------------------
// Helper: truncate and preview arg values
// ---------------------------------------------------------------------------

function isLinkedArg(val: string): boolean {
  return val.startsWith("{{") && val.includes("}}");
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function ScriptNode({ data, selected }: NodeProps<ScriptNodeData>) {
  const status = data.status ?? "pending";
  const colors = STATUS_COLORS[status] ?? STATUS_COLORS.pending;
  const argEntries = Object.entries(data.args || {});
  const visibleArgs = argEntries.slice(0, 3);
  const hiddenCount = Math.max(0, argEntries.length - 3);

  return (
    <div
      className={`
        rounded-xl border-2 ${colors.border} ${colors.bg} ${colors.glow}
        min-w-[220px] max-w-[280px] backdrop-blur-sm
        transition-all duration-300 ease-out
        ${selected ? "ring-2 ring-indigo-500/40 ring-offset-1 ring-offset-[#0a0c12]" : ""}
        ${status === "running" ? "animate-pulse" : ""}
      `}
    >
      {/* Target handle (top) */}
      <Handle
        type="target"
        position={Position.Top}
        className="!w-3 !h-3 !bg-gray-500 !border-2 !border-[#1a1d28] hover:!bg-indigo-400 transition-colors"
      />

      {/* Header */}
      <div className="flex items-center gap-2 px-3.5 py-2 border-b border-white/[0.04]">
        <span className={`h-2.5 w-2.5 rounded-full ${colors.dot} shrink-0 ${
          status === "running" ? "animate-ping" : ""
        }`} />
        <span className="text-sm font-semibold text-white truncate flex-1">
          {data.script || "Select Script"}
        </span>
        {data.retry > 0 && (
          <span className="text-[10px] font-mono text-yellow-500/70 bg-yellow-500/10 rounded px-1 py-0.5">
            ↻{data.retry}
          </span>
        )}
      </div>

      {/* Args preview */}
      {visibleArgs.length > 0 && (
        <div className="px-3.5 py-2 space-y-1 border-b border-white/[0.03]">
          {visibleArgs.map(([k, v]) => (
            <div key={k} className="flex items-center gap-1.5 text-[10px] leading-tight">
              <span className="text-gray-500 font-mono shrink-0">{truncate(k, 12)}</span>
              <span className="text-gray-700">=</span>
              {isLinkedArg(v) ? (
                <span className="text-indigo-400/80 font-mono truncate" title={v}>
                  {truncate(v, 20)}
                </span>
              ) : (
                <span className="text-gray-400 truncate" title={v}>
                  {truncate(v, 20) || <span className="text-gray-600 italic">empty</span>}
                </span>
              )}
            </div>
          ))}
          {hiddenCount > 0 && (
            <span className="text-[9px] text-gray-600">+{hiddenCount} more</span>
          )}
        </div>
      )}

      {/* Footer: status + time */}
      <div className="flex items-center justify-between px-3.5 py-1.5">
        <span className={`text-[10px] font-semibold uppercase tracking-wider ${colors.text}`}>
          {STATUS_LABELS[status] ?? status}
        </span>
        {data.execution_time != null && (
          <span className="text-[10px] font-mono text-gray-500">
            {data.execution_time.toFixed(1)}s
          </span>
        )}
      </div>

      {/* Source handle (bottom) */}
      <Handle
        type="source"
        position={Position.Bottom}
        className="!w-3 !h-3 !bg-gray-500 !border-2 !border-[#1a1d28] hover:!bg-indigo-400 transition-colors"
      />
    </div>
  );
}

export default memo(ScriptNode);
