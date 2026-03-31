"use client";

import { useCallback, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TCEntry {
  tc_id: string;
  name: string;
  error?: string;
  linked?: string;
}

interface Overview {
  total: number;
  pass: number;
  fail: number;
  not_executed: number;
  not_applicable: number;
  known_failures: number;
  unknown_failures: number;
  pass_pct: number;
  known_pct: number;
  unknown_pct: number;
  ne_pct: number;
}

interface Regressions {
  known_count: number;
  unknown_count: number;
  known_by_service: Record<string, TCEntry[]>;
  unknown_by_service: Record<string, TCEntry[]>;
}

interface GraphPoint {
  service: string;
  count: number;
}

interface DashboardData {
  platform: string;
  rc1: string;
  rc2: string;
  overview: Overview;
  pass_by_service: Record<string, TCEntry[]>;
  known_fail_by_service: Record<string, TCEntry[]>;
  unknown_fail_by_service: Record<string, TCEntry[]>;
  ne_by_service: Record<string, TCEntry[]>;
  regressions: Regressions;
  graphs: {
    known: GraphPoint[];
    unknown: GraphPoint[];
  };
}

// Platforms available
const PLATFORMS = ["B2_US", "B3_IN", "B3_US", "K1_UK", "K1_US", "K2_IN", "K2_US"];

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function TestReportDashboard() {
  // ── Input state ──
  const [rc1, setRc1] = useState("");
  const [rc2, setRc2] = useState("");
  const [platform, setPlatform] = useState("K1_US");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState<DashboardData | null>(null);

  // ── Drill-down state ──
  const [activeBox, setActiveBox] = useState<string | null>(null); // "pass" | "known" | "unknown" | "ne" | "reg_known" | "reg_unknown"
  const [expandedService, setExpandedService] = useState<string | null>(null);

  const fetchReport = useCallback(async () => {
    if (!rc1.trim() || !rc2.trim()) {
      setError("Both build numbers are required.");
      return;
    }
    setLoading(true);
    setError("");
    setData(null);
    setActiveBox(null);
    setExpandedService(null);
    try {
      const res = await fetch(`${API_BASE}/test-report-summary`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rc1: rc1.trim(), rc2: rc2.trim(), platform }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || `HTTP ${res.status}`);
      }
      const result: DashboardData = await res.json();
      setData(result);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [rc1, rc2, platform]);

  // Map box id → service data
  const getServiceData = (box: string): Record<string, TCEntry[]> => {
    if (!data) return {};
    switch (box) {
      case "pass": return data.pass_by_service;
      case "known": return data.known_fail_by_service;
      case "unknown": return data.unknown_fail_by_service;
      case "ne": return data.ne_by_service;
      case "reg_known": return data.regressions.known_by_service;
      case "reg_unknown": return data.regressions.unknown_by_service;
      default: return {};
    }
  };

  const handleBoxClick = (box: string) => {
    if (activeBox === box) {
      setActiveBox(null);
      setExpandedService(null);
    } else {
      setActiveBox(box);
      setExpandedService(null);
    }
  };

  const toggleService = (svc: string) => {
    setExpandedService(expandedService === svc ? null : svc);
  };

  // ── Render ──
  return (
    <div className="max-w-[1400px] mx-auto">
      {/* Title */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white tracking-tight">
          Test Report Summary
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          Compare two Jenkins builds and view categorized test results
        </p>
      </div>

      {/* ══════════════════════════════════════════════════════════ */}
      {/* Input Section                                             */}
      {/* ══════════════════════════════════════════════════════════ */}
      <div className="rounded-xl border border-gray-800/60 bg-gray-800 p-5 mb-6 shadow-md shadow-black/8">
        <h2 className="text-sm font-semibold text-gray-300 mb-4 flex items-center gap-2">
          <svg className="h-4 w-4 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 6h9.75M10.5 6a1.5 1.5 0 11-3 0m3 0a1.5 1.5 0 10-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-9.75 0h9.75" />
          </svg>
          Build Configuration
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1.5">Previous Build #</label>
            <input
              type="text"
              value={rc1}
              onChange={(e) => setRc1(e.target.value)}
              placeholder="e.g. 1018"
              className="w-full rounded-lg border border-gray-700/60 bg-gray-900 px-3 py-2.5 text-sm text-gray-200 placeholder-gray-600 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/30 outline-none transition"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1.5">Current Build #</label>
            <input
              type="text"
              value={rc2}
              onChange={(e) => setRc2(e.target.value)}
              placeholder="e.g. 1039"
              className="w-full rounded-lg border border-gray-700/60 bg-gray-900 px-3 py-2.5 text-sm text-gray-200 placeholder-gray-600 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/30 outline-none transition"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1.5">Device Type</label>
            <select
              value={platform}
              onChange={(e) => setPlatform(e.target.value)}
              className="w-full rounded-lg border border-gray-700/60 bg-gray-900 px-3 py-2.5 text-sm text-gray-200 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/30 outline-none transition appearance-none cursor-pointer"
            >
              {PLATFORMS.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>
          <button
            onClick={fetchReport}
            disabled={loading}
            className="h-[42px] rounded-lg bg-indigo-600 px-6 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
          >
            {loading ? (
              <>
                <Spinner />
                Fetching…
              </>
            ) : (
              <>
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 4.5h14.25M3 9h9.75M3 13.5h5.25m5.25 0H21m-5.25 0L12 9.75m3.75 3.75L12 17.25" />
                </svg>
                Generate Report
              </>
            )}
          </button>
        </div>
        {error && (
          <div className="mt-3 rounded-lg bg-red-500/10 border border-red-500/20 px-4 py-2.5 text-sm text-red-400">
            {error}
          </div>
        )}
      </div>

      {/* Loading state */}
      {loading && (
        <div className="flex flex-col items-center justify-center py-20 gap-4">
          <div className="h-10 w-10 rounded-full border-2 border-indigo-500/30 border-t-indigo-500 animate-spin" />
          <p className="text-sm text-gray-500">Downloading & analyzing reports from Jenkins…</p>
          <p className="text-xs text-gray-600">This may take 30–60 seconds for large builds</p>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════ */}
      {/* Dashboard (only when data is loaded)                      */}
      {/* ══════════════════════════════════════════════════════════ */}
      {data && !loading && (
        <div className="space-y-6 animate-fadeIn">
          {/* Header badge */}
          <div className="flex items-center gap-3 text-sm text-gray-400">
            <span className="px-2.5 py-1 rounded-md bg-indigo-600/15 text-indigo-300 text-xs font-mono">
              Build #{data.rc2}
            </span>
            <span>vs</span>
            <span className="px-2.5 py-1 rounded-md bg-gray-800 text-gray-400 text-xs font-mono">
              Build #{data.rc1}
            </span>
            <span className="text-gray-600">|</span>
            <span className="text-gray-500">{data.platform}</span>
            <span className="text-gray-600">|</span>
            <span className="text-gray-500">{data.overview.total} total test cases</span>
          </div>

          {/* ── SECTION 1: Overall Summary Boxes ── */}
          <div>
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
              Current Build Overview
            </h2>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <MetricBox
                label="Pass"
                count={data.overview.pass}
                pct={data.overview.pass_pct}
                color="emerald"
                active={activeBox === "pass"}
                onClick={() => handleBoxClick("pass")}
              />
              <MetricBox
                label="Known Failures"
                count={data.overview.known_failures}
                pct={data.overview.known_pct}
                color="amber"
                active={activeBox === "known"}
                onClick={() => handleBoxClick("known")}
              />
              <MetricBox
                label="Unknown Failures"
                count={data.overview.unknown_failures}
                pct={data.overview.unknown_pct}
                color="red"
                active={activeBox === "unknown"}
                onClick={() => handleBoxClick("unknown")}
              />
              <MetricBox
                label="Not Executed"
                count={data.overview.not_executed}
                pct={data.overview.ne_pct}
                color="slate"
                active={activeBox === "ne"}
                onClick={() => handleBoxClick("ne")}
              />
            </div>

            {/* Drill-down for overview boxes */}
            {activeBox && ["pass", "known", "unknown", "ne"].includes(activeBox) && (
              <ServiceDrillDown
                title={
                  activeBox === "pass" ? "Passed Test Cases" :
                  activeBox === "known" ? "Known Failures" :
                  activeBox === "unknown" ? "Unknown Failures" : "Not Executed"
                }
                services={getServiceData(activeBox)}
                expandedService={expandedService}
                toggleService={toggleService}
                color={
                  activeBox === "pass" ? "emerald" :
                  activeBox === "known" ? "amber" :
                  activeBox === "unknown" ? "red" : "slate"
                }
              />
            )}
          </div>

          {/* ── SECTION 2: Regression Boxes ── */}
          <div>
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
              Regressions (Pass → Fail)
            </h2>
            <div className="grid grid-cols-2 gap-4">
              <MetricBox
                label="Known Regressions"
                count={data.regressions.known_count}
                color="orange"
                active={activeBox === "reg_known"}
                onClick={() => handleBoxClick("reg_known")}
                subtitle="Linked Jira issues"
              />
              <MetricBox
                label="Unknown Regressions"
                count={data.regressions.unknown_count}
                color="rose"
                active={activeBox === "reg_unknown"}
                onClick={() => handleBoxClick("reg_unknown")}
                subtitle="No linked issues"
              />
            </div>

            {/* Drill-down for regression boxes */}
            {activeBox && ["reg_known", "reg_unknown"].includes(activeBox) && (
              <ServiceDrillDown
                title={activeBox === "reg_known" ? "Known Regressions" : "Unknown Regressions"}
                services={getServiceData(activeBox)}
                expandedService={expandedService}
                toggleService={toggleService}
                color={activeBox === "reg_known" ? "orange" : "rose"}
              />
            )}
          </div>

          {/* ── SECTION 3: Graphs ── */}
          <div>
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
              Failure Distribution by Service
            </h2>
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              <GraphCard
                title="Known Failures per Service"
                data={data.graphs.known}
                color="#f59e0b"
                gradientId="knownGrad"
              />
              <GraphCard
                title="Unknown Failures per Service"
                data={data.graphs.unknown}
                color="#ef4444"
                gradientId="unknownGrad"
              />
            </div>
          </div>
        </div>
      )}

      {/* Empty state */}
      {!data && !loading && !error && (
        <div className="flex flex-col items-center justify-center py-20 text-gray-600">
          <svg className="h-16 w-16 mb-4 text-gray-700" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          <p className="text-sm">Enter build numbers and click <span className="text-indigo-400">Generate Report</span> to view the dashboard</p>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// Sub-components
// ═══════════════════════════════════════════════════════════════════

// --- Metric Box ---

const COLOR_MAP: Record<string, { bg: string; border: string; text: string; accent: string; ring: string }> = {
  emerald: {
    bg: "bg-emerald-500/8",
    border: "border-emerald-500/20",
    text: "text-emerald-400",
    accent: "text-emerald-300",
    ring: "ring-emerald-500/30",
  },
  amber: {
    bg: "bg-amber-500/8",
    border: "border-amber-500/20",
    text: "text-amber-400",
    accent: "text-amber-300",
    ring: "ring-amber-500/30",
  },
  red: {
    bg: "bg-red-500/8",
    border: "border-red-500/20",
    text: "text-red-400",
    accent: "text-red-300",
    ring: "ring-red-500/30",
  },
  slate: {
    bg: "bg-slate-500/8",
    border: "border-slate-500/20",
    text: "text-slate-400",
    accent: "text-slate-300",
    ring: "ring-slate-500/30",
  },
  orange: {
    bg: "bg-orange-500/8",
    border: "border-orange-500/20",
    text: "text-orange-400",
    accent: "text-orange-300",
    ring: "ring-orange-500/30",
  },
  rose: {
    bg: "bg-rose-500/8",
    border: "border-rose-500/20",
    text: "text-rose-400",
    accent: "text-rose-300",
    ring: "ring-rose-500/30",
  },
};

function MetricBox({
  label,
  count,
  pct,
  color,
  active,
  onClick,
  subtitle,
}: {
  label: string;
  count: number;
  pct?: number;
  color: string;
  active: boolean;
  onClick: () => void;
  subtitle?: string;
}) {
  const c = COLOR_MAP[color] ?? COLOR_MAP.slate;
  return (
    <button
      onClick={onClick}
      className={`relative rounded-xl border ${c.border} ${c.bg} p-5 text-left transition-all duration-200 hover:scale-[1.02] cursor-pointer group ${
        active ? `ring-2 ${c.ring} scale-[1.02]` : ""
      }`}
    >
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">
        {label}
      </p>
      <div className="flex items-baseline gap-2">
        <span className={`text-3xl font-bold ${c.accent}`}>{count}</span>
        {pct !== undefined && (
          <span className={`text-sm font-medium ${c.text}`}>{pct}%</span>
        )}
      </div>
      {subtitle && (
        <p className="text-[10px] text-gray-600 mt-1">{subtitle}</p>
      )}
      {/* Active indicator */}
      <div className={`absolute top-3 right-3 h-2 w-2 rounded-full transition-opacity ${active ? `${c.text.replace("text-", "bg-")} opacity-100` : "opacity-0"}`} />
      {/* Click hint */}
      <div className="absolute bottom-2 right-3 text-[10px] text-gray-700 opacity-0 group-hover:opacity-100 transition-opacity">
        Click to expand
      </div>
    </button>
  );
}

// --- Service Drill-down ---

function ServiceDrillDown({
  title,
  services,
  expandedService,
  toggleService,
  color,
}: {
  title: string;
  services: Record<string, TCEntry[]>;
  expandedService: string | null;
  toggleService: (svc: string) => void;
  color: string;
}) {
  const c = COLOR_MAP[color] ?? COLOR_MAP.slate;
  const entries = Object.entries(services);

  if (entries.length === 0) {
    return (
      <div className={`mt-3 rounded-xl border ${c.border} ${c.bg} p-4 text-sm text-gray-500`}>
        No test cases in this category.
      </div>
    );
  }

  return (
    <div className={`mt-3 rounded-xl border ${c.border} bg-gray-800 overflow-hidden animate-slideDown shadow-md shadow-black/8`}>
      <div className={`px-4 py-3 border-b ${c.border} ${c.bg}`}>
        <h3 className={`text-sm font-semibold ${c.text}`}>{title}</h3>
        <p className="text-[10px] text-gray-600 mt-0.5">
          {entries.length} services — Click a service to view test cases
        </p>
      </div>
      <div className="divide-y divide-gray-800/40 max-h-[400px] overflow-y-auto scrollbar-thin">
        {entries.map(([svc, tcs]) => (
          <div key={svc}>
            <button
              onClick={() => toggleService(svc)}
              className="w-full flex items-center justify-between px-4 py-2.5 text-left hover:bg-gray-800/30 transition-colors"
            >
              <div className="flex items-center gap-3">
                <span className={`flex h-6 w-6 items-center justify-center rounded-md text-[10px] font-bold ${c.bg} ${c.text}`}>
                  {svc.charAt(0)}
                </span>
                <span className="text-sm text-gray-300 font-medium">{svc}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className={`text-xs font-mono ${c.text} bg-gray-800/60 px-2 py-0.5 rounded-md`}>
                  {tcs.length} TCs
                </span>
                <svg
                  className={`h-3.5 w-3.5 text-gray-600 transition-transform duration-200 ${
                    expandedService === svc ? "rotate-90" : ""
                  }`}
                  fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                </svg>
              </div>
            </button>
            {/* Expanded TC list */}
            <div
              className={`overflow-hidden transition-all duration-300 ease-in-out ${
                expandedService === svc ? "max-h-[2000px] opacity-100" : "max-h-0 opacity-0"
              }`}
            >
              <div className="bg-gray-950 border-t border-gray-800/30">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-gray-800/40 text-gray-600">
                      <th className="px-4 py-2 text-left font-medium w-20">TC ID</th>
                      <th className="px-4 py-2 text-left font-medium">Test Case Name</th>
                      <th className="px-4 py-2 text-left font-medium w-60">Details</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800/20">
                    {tcs.map((tc, i) => (
                      <tr key={i} className="hover:bg-gray-800/20 transition-colors">
                        <td className={`px-4 py-2 font-mono ${c.text}`}>{tc.tc_id}</td>
                        <td className="px-4 py-2 text-gray-400 font-mono truncate max-w-[300px]" title={tc.name}>
                          {tc.name.replace(".py", "").replace(/_/g, " ")}
                        </td>
                        <td className="px-4 py-2">
                          {tc.linked && (
                            <span className="text-amber-500/80 text-[10px] block truncate" title={tc.linked}>
                              🔗 {tc.linked}
                            </span>
                          )}
                          {tc.error && (
                            <span className="text-red-400/70 text-[10px] block truncate" title={tc.error}>
                              ⚠ {tc.error.length > 80 ? tc.error.slice(0, 80) + "…" : tc.error}
                            </span>
                          )}
                          {!tc.linked && !tc.error && (
                            <span className="text-gray-700">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// --- Graph Card ---

function GraphCard({
  title,
  data,
  color,
  gradientId,
}: {
  title: string;
  data: GraphPoint[];
  color: string;
  gradientId: string;
}) {
  // Filter out zero-count services for cleaner graphs
  const filtered = data.filter((d) => d.count > 0);
  const maxCount = Math.max(...filtered.map((d) => d.count), 1);

  return (
    <div className="rounded-xl border border-gray-800/60 bg-gray-800 p-5 shadow-md shadow-black/8">
      <h3 className="text-sm font-semibold text-gray-300 mb-4">{title}</h3>
      {filtered.length === 0 ? (
        <div className="flex items-center justify-center h-[260px] text-sm text-gray-600">
          No failures to display
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={filtered} margin={{ top: 5, right: 20, left: 0, bottom: 60 }}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.3} />
                <stop offset="100%" stopColor={color} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#3e4656" />
            <XAxis
              dataKey="service"
              tick={{ fill: "#6b7280", fontSize: 10 }}
              angle={-45}
              textAnchor="end"
              interval={0}
              height={60}
            />
            <YAxis
              tick={{ fill: "#6b7280", fontSize: 11 }}
              allowDecimals={false}
              domain={[0, Math.ceil(maxCount * 1.1)]}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "#343b4a",
                border: "1px solid #4c5466",
                borderRadius: "8px",
                fontSize: "12px",
                color: "#e5e7eb",
              }}
              labelStyle={{ color: "#949cad", fontWeight: 600 }}
            />
            <Legend wrapperStyle={{ fontSize: "11px", color: "#949cad" }} />
            <Line
              type="monotone"
              dataKey="count"
              stroke={color}
              strokeWidth={2.5}
              dot={{ r: 4, fill: color, strokeWidth: 0 }}
              activeDot={{ r: 6, fill: color }}
              name="Failure Count"
              fill={`url(#${gradientId})`}
            />
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

// --- Spinner ---

function Spinner() {
  return (
    <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}
