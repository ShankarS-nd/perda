"use client";

import { useCallback, useEffect, useState } from "react";
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

interface ConfTCEntry {
  tc_id: string;
  name: string;
  pass_count: number;
  total_builds: number;
  pass_pct: number;
}

interface ConfBucket {
  label: string;
  count: number;
  by_service: Record<string, ConfTCEntry[]>;
}

interface ConfBuckets {
  high: ConfBucket;
  medium_high: ConfBucket;
  medium: ConfBucket;
  medium_low: ConfBucket;
  low: ConfBucket;
}

interface RegressionConfidence {
  builds: string[];
  num_builds: number;
  known: ConfBuckets | Record<string, never>;
  unknown: ConfBuckets | Record<string, never>;
}

interface DashboardData {
  platform: string;
  rc1: string;
  rc2: string;
  rc1_ota: string;
  rc2_ota: string;
  rc1_overview: Overview;
  overview: Overview;
  rc1_pass_by_service: Record<string, TCEntry[]>;
  rc1_known_fail_by_service: Record<string, TCEntry[]>;
  rc1_unknown_fail_by_service: Record<string, TCEntry[]>;
  rc1_ne_by_service: Record<string, TCEntry[]>;
  pass_by_service: Record<string, TCEntry[]>;
  known_fail_by_service: Record<string, TCEntry[]>;
  unknown_fail_by_service: Record<string, TCEntry[]>;
  ne_by_service: Record<string, TCEntry[]>;
  regressions: Regressions;
  persistent_failures: Regressions;
  regression_confidence: RegressionConfidence;
  graphs: {
    known: GraphPoint[];
    unknown: GraphPoint[];
  };
}

// Platforms available
const PLATFORMS = ["B2_US", "B3_IN", "B3_US", "K1_UK", "K1_US", "K2_IN", "K2_US"];

// ---------------------------------------------------------------------------
// Preset builds — pre-defined "previous build" entries by device type
// ---------------------------------------------------------------------------
interface Preset {
  label: string;   // display name
  rc1: string;     // Jenkins job number (previous build)
  platform: string;
}

const PRESETS: Preset[] = [
  { label: "5.6.13.rc.2 --> B3 US", rc1: "857",  platform: "B3_US" },
  { label: "5.6.13.rc.2 --> K1 US", rc1: "865",  platform: "K1_US" },
  { label: "5.6.13.rc.2 --> B2 US", rc1: "871",  platform: "B2_US" },
  { label: "5.6.13.rc.2 --> K2 US", rc1: "864",  platform: "K2_US" },
  { label: "5.6.13.rc.2 --> K2 IN", rc1: "870",  platform: "K2_IN" },
  { label: "5.6.13.rc.2 --> K1 UK", rc1: "873",  platform: "K1_UK" },
  { label: "5.6.13.rc.2 --> B3 IN", rc1: "872",  platform: "B3_IN" },
];

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://172.16.23.15:8000";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface CacheEntry {
  label: string;
  cached: boolean;
  size: number;
}

interface SeedLogEntry {
  build: string;
  label: string;
  status: "cached" | "downloading" | "ok" | "error";
  msg: string;
}

export default function TestReportDashboard() {
  // ── Input state ──
  const [rc1, setRc1] = useState("");
  const [rc2, setRc2] = useState("");
  const [rc1Url, setRc1Url] = useState("");
  const [rc2Url, setRc2Url] = useState("");
  const [useUrls, setUseUrls] = useState(false);
  const [platform, setPlatform] = useState("K1_US");
  const [selectedPreset, setSelectedPreset] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState<DashboardData | null>(null);

  // ── Cache state ──
  const [cacheStatus, setCacheStatus] = useState<Record<string, CacheEntry>>({});
  const [seeding, setSeeding] = useState(false);
  const [seedLog, setSeedLog] = useState<SeedLogEntry[]>([]);
  const [showSyncPanel, setShowSyncPanel] = useState(false);

  // ── Drill-down state ──
  const [activeBox, setActiveBox] = useState<string | null>(null);
  const [expandedService, setExpandedService] = useState<string | null>(null);
  const [clickedConfBucket, setClickedConfBucket] = useState<string | null>(null);

  // Fetch cache status on mount
  useEffect(() => {
    fetch(`${API_BASE}/preset-cache-status`)
      .then((r) => (r.ok ? r.json() : {}))
      .then((d: Record<string, CacheEntry>) => setCacheStatus(d))
      .catch(() => {});
  }, []);

  const refreshCacheStatus = async () => {
    try {
      const r = await fetch(`${API_BASE}/preset-cache-status`);
      if (r.ok) setCacheStatus(await r.json());
    } catch {}
  };

  const syncPresets = async () => {
    setSeeding(true);
    setSeedLog([]);
    setShowSyncPanel(true);
    try {
      const res = await fetch(`${API_BASE}/seed-preset-cache`, { method: "POST" });
      if (!res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = JSON.parse(line.slice(6)) as Record<string, string>;
          if (payload.status === "done") break;
          const entry: SeedLogEntry = {
            build: payload.build,
            label: payload.label,
            status: payload.status as SeedLogEntry["status"],
            msg: payload.msg,
          };
          setSeedLog((prev) => {
            const idx = prev.findIndex((e) => e.build === entry.build);
            if (idx >= 0) {
              const next = [...prev];
              next[idx] = entry;
              return next;
            }
            return [...prev, entry];
          });
        }
      }
    } finally {
      setSeeding(false);
      await refreshCacheStatus();
    }
  };

  const handlePresetChange = (presetLabel: string) => {
    setSelectedPreset(presetLabel);
    const preset = PRESETS.find((p) => p.label === presetLabel);
    if (preset) {
      setRc1(preset.rc1);
      setPlatform(preset.platform);
    }
  };

  const fetchReport = useCallback(async (forceRefresh = false) => {
    const hasRc1 = rc1.trim() || rc1Url.trim();
    const hasRc2 = rc2.trim() || rc2Url.trim();
    if (!hasRc1 || !hasRc2) {
      setError("Both builds are required. Provide build numbers or direct URLs.");
      return;
    }
    setLoading(true);
    setError("");
    if (!forceRefresh) {
      setData(null);
    }
    setActiveBox(null);
    setExpandedService(null);
    try {
      const payload: Record<string, unknown> = {
        rc1: rc1.trim(),
        rc2: rc2.trim(),
        rc1_url: rc1Url.trim(),
        rc2_url: rc2Url.trim(),
        platform,
        force_refresh: forceRefresh,
      };
      const res = await fetch(`${API_BASE}/test-report-summary`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
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
  }, [rc1, rc2, rc1Url, rc2Url, platform]);

  // Map box id → service data
  const getServiceData = (box: string): Record<string, TCEntry[]> => {
    if (!data) return {};
    switch (box) {
      case "pass": return data.pass_by_service;
      case "known": return data.known_fail_by_service;
      case "unknown": return data.unknown_fail_by_service;
      case "ne": return data.ne_by_service;
      case "rc1_pass": return data.rc1_pass_by_service ?? {};
      case "rc1_known": return data.rc1_known_fail_by_service ?? {};
      case "rc1_unknown": return data.rc1_unknown_fail_by_service ?? {};
      case "rc1_ne": return data.rc1_ne_by_service ?? {};
      case "reg_known": return data.regressions.known_by_service;
      case "reg_unknown": return data.regressions.unknown_by_service;
      case "persist_known": return data.persistent_failures?.known_by_service ?? {};
      case "persist_unknown": return data.persistent_failures?.unknown_by_service ?? {};
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
    setClickedConfBucket(null);
  };

  const handleConfBadgeClick = (box: string, bucketKey: string) => {
    if (activeBox !== box) {
      setActiveBox(box);
      setExpandedService(null);
    }
    setClickedConfBucket(bucketKey);
  };

  // Count timeout failures in a service map
  const countTimeouts = (serviceMap: Record<string, TCEntry[]>): number => {
    let n = 0;
    for (const tcs of Object.values(serviceMap)) {
      for (const tc of tcs) {
        if (tc.error && /timeout/i.test(tc.error)) n++;
      }
    }
    return n;
  };

  const toggleService = (svc: string) => {
    setExpandedService(expandedService === svc ? null : svc);
  };

  // ── Render ──
  return (
    <div className="max-w-[1400px] mx-auto">
      {/* ── Header ── */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-1.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500/20 to-violet-500/20 border border-indigo-500/10">
            <svg className="h-[18px] w-[18px] text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          </div>
          <div>
            <h1 className="text-[22px] font-semibold text-white tracking-tight leading-tight">
              Test Report Summary
            </h1>
            <p className="text-[13px] text-gray-500 leading-tight">
              Compare Jenkins builds and view categorized test results
            </p>
          </div>
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════ */}
      {/* Input Card                                                */}
      {/* ══════════════════════════════════════════════════════════ */}
      <div className="form-card rounded-xl border border-white/[0.06] bg-[#1a1d28] p-6 mb-8 transition-shadow duration-300">
        <div className="flex items-center justify-between mb-6">
          <h2 className="ds-section-title flex items-center gap-2 text-gray-300">
            <svg className="h-3.5 w-3.5 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 6h9.75M10.5 6a1.5 1.5 0 11-3 0m3 0a1.5 1.5 0 10-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-9.75 0h9.75" />
            </svg>
            Build Configuration
          </h2>
          {/* Sync button */}
          <div className="flex items-center gap-3">
            {Object.keys(cacheStatus).length > 0 && (() => {
              const cached = PRESETS.filter((p) => cacheStatus[p.rc1]?.cached).length;
              const total = PRESETS.length;
              return (
                <span className={`text-[10px] px-2.5 py-1 rounded-full font-medium ${
                  cached === total
                    ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/10"
                    : "bg-amber-500/10 text-amber-400 border border-amber-500/10"
                }`}>
                  {cached}/{total} cached
                </span>
              );
            })()}
            <button
              onClick={syncPresets}
              disabled={seeding}
              className="flex items-center gap-1.5 text-xs text-indigo-400 hover:text-indigo-300 disabled:opacity-50 transition-colors px-2.5 py-1.5 rounded-lg hover:bg-indigo-500/10"
            >
              {seeding ? (
                <svg className="h-3 w-3 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              ) : (
                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
                </svg>
              )}
              {seeding ? "Syncing…" : "Sync Reports"}
            </button>
          </div>
        </div>

        {/* ── 2-column grid: Row 1 ── */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-5 gap-y-5 mb-5">
          {/* Device Type */}
          <div className="space-y-2">
            <label className="block text-[11px] font-medium text-gray-500 uppercase tracking-wider">Device Type</label>
            <select
              value={platform}
              onChange={(e) => setPlatform(e.target.value)}
              className="ds-input w-full cursor-pointer appearance-none"
            >
              <option value="" disabled>Select device type</option>
              {PLATFORMS.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>

          {/* Quick Select */}
          <div className="space-y-2">
            <label className="block text-[11px] font-medium text-gray-500 uppercase tracking-wider">Quick Select</label>
            <select
              value={selectedPreset}
              onChange={(e) => handlePresetChange(e.target.value)}
              className="ds-input w-full cursor-pointer appearance-none"
            >
              <option value="">Select preset</option>
              {PRESETS.map((p) => {
                const isCached = cacheStatus[p.rc1]?.cached;
                const prefix = Object.keys(cacheStatus).length === 0 ? "" : isCached ? "✓ " : "↧ ";
                return (
                  <option key={p.label} value={p.label}>
                    {prefix}{p.label}
                  </option>
                );
              })}
            </select>
          </div>

          {/* Previous Build # */}
          <div className="space-y-2">
            <label className="block text-[11px] font-medium text-gray-500 uppercase tracking-wider">
              Previous Build #{useUrls && <span className="text-gray-600 normal-case"> (optional with URL)</span>}
            </label>
            <input
              type="text"
              value={rc1}
              onChange={(e) => setRc1(e.target.value)}
              placeholder="Enter previous build"
              className="ds-input w-full"
            />
          </div>

          {/* Current Build # */}
          <div className="space-y-2">
            <label className="block text-[11px] font-medium text-gray-500 uppercase tracking-wider">
              Current Build #{useUrls && <span className="text-gray-600 normal-case"> (optional with URL)</span>}
            </label>
            <input
              type="text"
              value={rc2}
              onChange={(e) => setRc2(e.target.value)}
              placeholder="Enter current build"
              className="ds-input w-full"
            />
          </div>
        </div>

        {/* ── Direct URL toggle ── */}
        <div className="mt-5 mb-5">
          <button
            type="button"
            onClick={() => setUseUrls(!useUrls)}
            className="flex items-center gap-2 text-xs text-gray-400 hover:text-gray-300 transition-colors"
          >
            <div className={`relative w-8 h-[18px] rounded-full transition-colors ${useUrls ? "bg-indigo-500/40" : "bg-white/10"}`}>
              <div className={`absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white transition-all ${useUrls ? "left-[16px]" : "left-[2px]"}`} />
            </div>
            <span>Use Direct Jenkins URLs</span>
            {useUrls && <span className="text-gray-600 text-[10px]">(URLs override build numbers)</span>}
          </button>
        </div>

        {/* ── URL inputs (collapsible) ── */}
        {useUrls && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-5 gap-y-5 mb-5 animate-in fade-in duration-200">
            {/* Previous Build URL */}
            <div className="space-y-2">
              <label className="block text-[11px] font-medium text-gray-500 uppercase tracking-wider">Previous Build URL</label>
              <input
                type="text"
                value={rc1Url}
                onChange={(e) => setRc1Url(e.target.value)}
                placeholder="https://build-device.netradyne.info/view/.../job/SomeJob/123"
                className="ds-input w-full text-xs"
              />
            </div>

            {/* Current Build URL */}
            <div className="space-y-2">
              <label className="block text-[11px] font-medium text-gray-500 uppercase tracking-wider">Current Build URL</label>
              <input
                type="text"
                value={rc2Url}
                onChange={(e) => setRc2Url(e.target.value)}
                placeholder="https://build-device.netradyne.info/view/.../job/SomeJob/456"
                className="ds-input w-full text-xs"
              />
            </div>
          </div>
        )}

        {/* ── Generate button row ── */}
        <div className="flex justify-end gap-3 pt-1">
          {data && !loading && (
            <button
              onClick={() => fetchReport(true)}
              className="h-[42px] px-4 rounded-lg border border-yellow-500/30 bg-yellow-500/10 text-yellow-400 text-sm font-medium hover:bg-yellow-500/20 transition-colors flex items-center gap-2"
              title="Re-download report data from Jenkins (bypasses cache)"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182" />
              </svg>
              Re-fetch from Jenkins
            </button>
          )}
          <button
            onClick={() => fetchReport()}
            disabled={loading}
            className="ds-btn-primary h-[42px] w-full md:w-auto"
          >
            {loading ? (
              <>
                <Spinner />
                Generating…
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

        {/* Error message */}
        {error && (
          <div className="mt-4 rounded-[10px] bg-red-500/[0.06] border border-red-500/15 px-4 py-3 text-sm text-red-400 flex items-center gap-2.5">
            <svg className="h-4 w-4 shrink-0 text-red-400/80" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
            </svg>
            {error}
          </div>
        )}

        {/* Sync progress panel */}
        {showSyncPanel && (
          <div className="mt-4 rounded-[10px] bg-[#12141c] border border-white/[0.06] p-4">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Preset Report Cache</span>
              {!seeding && (
                <button
                  onClick={() => setShowSyncPanel(false)}
                  className="text-gray-600 hover:text-gray-400 transition-colors p-1 rounded-md hover:bg-gray-800/50"
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>
            {seedLog.length === 0 && seeding && (
              <div className="flex items-center gap-2 text-xs text-gray-500">
                <svg className="h-3 w-3 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                <span>Connecting to Jenkins…</span>
              </div>
            )}
            <div className="space-y-2">
              {seedLog.map((entry) => (
                <div key={entry.build} className="flex items-start gap-2.5 text-xs">
                  {entry.status === "ok" || entry.status === "cached" ? (
                    <span className="text-emerald-400 mt-0.5 shrink-0">✓</span>
                  ) : entry.status === "error" ? (
                    <span className="text-red-400 mt-0.5 shrink-0">✗</span>
                  ) : (
                    <svg className="h-3 w-3 animate-spin mt-0.5 shrink-0 text-indigo-400" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                  )}
                  <span className={`w-48 shrink-0 ${
                    entry.status === "cached" ? "text-gray-500" : "text-gray-300"
                  }`}>{entry.label}</span>
                  <span className={`truncate ${
                    entry.status === "error" ? "text-red-400" :
                    entry.status === "cached" ? "text-gray-600" : "text-gray-500"
                  }`}>{entry.msg}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Loading state ── */}
      {loading && (
        <div className="flex flex-col items-center justify-center py-24 gap-5">
          <div className="relative">
            <div className="h-12 w-12 rounded-full border-2 border-indigo-500/20 border-t-indigo-500 animate-spin" />
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="h-5 w-5 rounded-full border-2 border-violet-500/20 border-b-violet-500 animate-spin" style={{ animationDirection: "reverse" }} />
            </div>
          </div>
          <div className="text-center">
            <p className="text-sm text-gray-400 font-medium">
              {selectedPreset && cacheStatus[rc1]?.cached
                ? "Loading cached previous build, downloading current build from Jenkins…"
                : "Downloading & analyzing reports from Jenkins…"}
            </p>
            <p className="text-xs text-gray-600 mt-1.5">This may take 30–60 seconds for large builds</p>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════ */}
      {/* Dashboard (only when data is loaded)                      */}
      {/* ══════════════════════════════════════════════════════════ */}
      {data && !loading && (
        <div className="space-y-8 animate-fadeIn">
          {/* Header badge */}
          <div className="flex items-center gap-3 flex-wrap text-sm text-gray-400">
            <span className="px-3 py-1.5 rounded-lg bg-gradient-to-r from-indigo-600/15 to-violet-600/15 text-indigo-300 text-xs font-mono border border-indigo-500/10">
              Build #{data.rc2}{data.rc2_ota && <span className="ml-1.5 text-indigo-400/70">({data.rc2_ota})</span>}
            </span>
            <span className="text-gray-600">vs</span>
            <span className="px-3 py-1.5 rounded-lg bg-[#1e2230] text-gray-400 text-xs font-mono border border-gray-700/30">
              Build #{data.rc1}{data.rc1_ota && <span className="ml-1.5 text-gray-500">({data.rc1_ota})</span>}
            </span>
            <div className="h-4 w-px bg-gray-700/50 mx-1" />
            <span className="text-gray-500 text-xs">{data.platform}</span>
            <div className="h-4 w-px bg-gray-700/50 mx-1" />
            <span className="text-gray-500 text-xs">{data.overview.total} total test cases</span>
          </div>

          {/* ── SECTION 0: Previous Build Overview (compact) ── */}
          <div>
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
              Previous Build Overview
              <span className="ml-2 text-xs font-normal text-gray-600">Build #{data.rc1}{data.rc1_ota ? ` (${data.rc1_ota})` : ""}</span>
            </h2>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <MetricBox
                label="Pass"
                count={data.rc1_overview.pass}
                pct={data.rc1_overview.pass_pct}
                color="emerald"
                active={activeBox === "rc1_pass"}
                onClick={() => handleBoxClick("rc1_pass")}
              />
              <MetricBox
                label="Known Failures"
                count={data.rc1_overview.known_failures}
                pct={data.rc1_overview.known_pct}
                color="amber"
                active={activeBox === "rc1_known"}
                onClick={() => handleBoxClick("rc1_known")}
              />
              <MetricBox
                label="Unknown Failures"
                count={data.rc1_overview.unknown_failures}
                pct={data.rc1_overview.unknown_pct}
                color="red"
                active={activeBox === "rc1_unknown"}
                onClick={() => handleBoxClick("rc1_unknown")}
              />
              <MetricBox
                label="Not Executed"
                count={data.rc1_overview.not_executed}
                pct={data.rc1_overview.ne_pct}
                color="slate"
                active={activeBox === "rc1_ne"}
                onClick={() => handleBoxClick("rc1_ne")}
              />
            </div>

            {/* Drill-down for previous build overview boxes */}
            {activeBox && ["rc1_pass", "rc1_known", "rc1_unknown", "rc1_ne"].includes(activeBox) && (
              <ServiceDrillDown
                title={
                  activeBox === "rc1_pass" ? "Passed Test Cases" :
                  activeBox === "rc1_known" ? "Known Failures" :
                  activeBox === "rc1_unknown" ? "Unknown Failures" : "Not Executed"
                }
                services={getServiceData(activeBox)}
                expandedService={expandedService}
                toggleService={toggleService}
                color={
                  activeBox === "rc1_pass" ? "emerald" :
                  activeBox === "rc1_known" ? "amber" :
                  activeBox === "rc1_unknown" ? "red" : "slate"
                }
              />
            )}
          </div>

          {/* ── SECTION 1: Overall Summary Boxes ── */}
          <div>
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
              Current Build Overview
              <span className="ml-2 text-xs font-normal text-gray-600">Build #{data.rc2}{data.rc2_ota ? ` (${data.rc2_ota})` : ""}</span>
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
                pct={data.overview.total > 0 ? Math.round((data.regressions.known_count / data.overview.total) * 100) : 0}
                color="orange"
                active={activeBox === "reg_known"}
                onClick={() => handleBoxClick("reg_known")}
                subtitle="Linked Jira issues"
                timeoutCount={countTimeouts(data.regressions.known_by_service)}
                confidenceSummary={getConfidenceSummary(data.regression_confidence?.known)}
                onConfBadgeClick={(key) => handleConfBadgeClick("reg_known", key)}
              />
              <MetricBox
                label="Unknown Regressions"
                count={data.regressions.unknown_count}
                pct={data.overview.total > 0 ? Math.round((data.regressions.unknown_count / data.overview.total) * 100) : 0}
                color="rose"
                active={activeBox === "reg_unknown"}
                onClick={() => handleBoxClick("reg_unknown")}
                subtitle="No linked issues"
                timeoutCount={countTimeouts(data.regressions.unknown_by_service)}
                confidenceSummary={getConfidenceSummary(data.regression_confidence?.unknown)}
                onConfBadgeClick={(key) => handleConfBadgeClick("reg_unknown", key)}
              />
            </div>

            {/* Drill-down for regression boxes — split by timeout / non-timeout */}
            {activeBox && ["reg_known", "reg_unknown"].includes(activeBox) && (
              <RegressionDrillDown
                title={activeBox === "reg_known" ? "Known Regressions" : "Unknown Regressions"}
                services={getServiceData(activeBox)}
                expandedService={expandedService}
                toggleService={toggleService}
                color={activeBox === "reg_known" ? "orange" : "rose"}
                platform={data.platform}
                rc1={data.rc1}
                rc2={data.rc2}
                category={activeBox === "reg_known" ? "known" : "unknown"}
                confidence={
                  activeBox === "reg_known"
                    ? data.regression_confidence?.known
                    : data.regression_confidence?.unknown
                }
                confidenceBuilds={data.regression_confidence?.builds ?? []}
                initialConfBucket={clickedConfBucket}
                onConfBucketChange={() => setClickedConfBucket(null)}
              />
            )}
          </div>

          {/* ── SECTION 2B: Persistent Failures (Fail → Fail) ── */}
          {data.persistent_failures && (data.persistent_failures.known_count > 0 || data.persistent_failures.unknown_count > 0) && (
            <div>
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
                Persistent Failures (Fail → Fail)
              </h2>
              <div className="grid grid-cols-2 gap-4">
                <MetricBox
                  label="Known Persistent"
                  count={data.persistent_failures.known_count}
                  pct={data.overview.total > 0 ? Math.round((data.persistent_failures.known_count / data.overview.total) * 100) : 0}
                  color="amber"
                  active={activeBox === "persist_known"}
                  onClick={() => handleBoxClick("persist_known")}
                  subtitle="Linked Jira issues"
                  timeoutCount={countTimeouts(data.persistent_failures.known_by_service)}
                />
                <MetricBox
                  label="Unknown Persistent"
                  count={data.persistent_failures.unknown_count}
                  pct={data.overview.total > 0 ? Math.round((data.persistent_failures.unknown_count / data.overview.total) * 100) : 0}
                  color="red"
                  active={activeBox === "persist_unknown"}
                  onClick={() => handleBoxClick("persist_unknown")}
                  subtitle="No linked issues"
                  timeoutCount={countTimeouts(data.persistent_failures.unknown_by_service)}
                />
              </div>

              {/* Drill-down for persistent failure boxes */}
              {activeBox && ["persist_known", "persist_unknown"].includes(activeBox) && (
                <RegressionDrillDown
                  title={activeBox === "persist_known" ? "Known Persistent Failures" : "Unknown Persistent Failures"}
                  services={getServiceData(activeBox)}
                  expandedService={expandedService}
                  toggleService={toggleService}
                  color={activeBox === "persist_known" ? "amber" : "rose"}
                  platform={data.platform}
                  rc1={data.rc1}
                  rc2={data.rc2}
                  category={activeBox === "persist_known" ? "persist_known" : "persist_unknown"}
                />
              )}
            </div>
          )}

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

      {/* ── Empty state ── */}
      {!data && !loading && !error && (
        <div className="flex flex-col items-center justify-center py-28 text-center">
          <div className="relative mb-6">
            <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500/10 to-violet-500/10 border border-indigo-500/10">
              <svg className="h-9 w-9 text-indigo-400/60" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <div className="absolute -bottom-1 -right-1 h-6 w-6 rounded-lg bg-gradient-to-br from-indigo-500/20 to-violet-500/20 border border-indigo-500/10 flex items-center justify-center">
              <svg className="h-3 w-3 text-indigo-400/70" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
            </div>
          </div>
          <p className="text-[15px] font-medium text-gray-400 mb-1.5">No report generated yet</p>
          <p className="text-sm text-gray-600 max-w-xs leading-relaxed">
            Enter build details and click <span className="text-indigo-400/80 font-medium">Generate Report</span> to view comparison results
          </p>
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

interface ConfidenceSummary {
  high: number;
  medium_high: number;
  medium: number;
  medium_low: number;
  low: number;
}

function getConfidenceSummary(conf: ConfBuckets | Record<string, never> | undefined): ConfidenceSummary | null {
  if (!conf || !("high" in conf)) return null;
  const c = conf as ConfBuckets;
  const total = c.high.count + c.medium_high.count + c.medium.count + c.medium_low.count + c.low.count;
  if (total === 0) return null;
  return {
    high: c.high.count,
    medium_high: c.medium_high.count,
    medium: c.medium.count,
    medium_low: c.medium_low.count,
    low: c.low.count,
  };
}

function MetricBox({
  label,
  count,
  pct,
  color,
  active,
  onClick,
  subtitle,
  timeoutCount,
  confidenceSummary,
  onConfBadgeClick,
}: {
  label: string;
  count: number;
  pct?: number;
  color: string;
  active: boolean;
  onClick: () => void;
  subtitle?: string;
  timeoutCount?: number;
  confidenceSummary?: ConfidenceSummary | null;
  onConfBadgeClick?: (bucketKey: string) => void;
}) {
  const c = COLOR_MAP[color] ?? COLOR_MAP.slate;
  const hasBadges = confidenceSummary || (timeoutCount !== undefined && timeoutCount > 0);

  // Collect all badges into an array for clean rendering
  const badges: { key: string; label: string; value: number; bgClass: string; borderClass: string; textClass: string; valClass: string; clickKey?: string }[] = [];
  if (confidenceSummary) {
    if (confidenceSummary.high > 0) badges.push({ key: "high", label: "High", value: confidenceSummary.high, bgClass: "bg-emerald-500/15", borderClass: "border-emerald-500/30", textClass: "text-emerald-400", valClass: "text-emerald-300", clickKey: "high" });
    if (confidenceSummary.medium_high > 0) badges.push({ key: "mh", label: "Med High", value: confidenceSummary.medium_high, bgClass: "bg-sky-500/15", borderClass: "border-sky-500/30", textClass: "text-sky-400", valClass: "text-sky-300", clickKey: "medium_high" });
    if (confidenceSummary.medium > 0) badges.push({ key: "med", label: "Med", value: confidenceSummary.medium, bgClass: "bg-amber-500/15", borderClass: "border-amber-500/30", textClass: "text-amber-400", valClass: "text-amber-300", clickKey: "medium" });
    if (confidenceSummary.medium_low > 0) badges.push({ key: "ml", label: "Med Low", value: confidenceSummary.medium_low, bgClass: "bg-orange-500/15", borderClass: "border-orange-500/30", textClass: "text-orange-400", valClass: "text-orange-300", clickKey: "medium_low" });
    if (confidenceSummary.low > 0) badges.push({ key: "low", label: "Low", value: confidenceSummary.low, bgClass: "bg-red-500/15", borderClass: "border-red-500/30", textClass: "text-red-400", valClass: "text-red-300", clickKey: "low" });
  }
  if (timeoutCount !== undefined && timeoutCount > 0) {
    badges.push({ key: "to", label: "Timeout", value: timeoutCount, bgClass: "bg-yellow-500/15", borderClass: "border-yellow-500/30", textClass: "text-yellow-400", valClass: "text-yellow-300" });
  }

  return (
    <button
      onClick={onClick}
      className={`relative rounded-xl border ${c.border} ${c.bg} text-left transition-all duration-200 hover:scale-[1.015] hover:shadow-lg hover:shadow-black/10 cursor-pointer group ${
        active ? `ring-2 ${c.ring} scale-[1.015]` : ""
      }`}
    >
      <div className={`flex ${hasBadges ? "items-stretch" : ""}`}>
        {/* Left side — main metric */}
        <div className="flex-1 p-5 min-w-0">
          <p className="text-[11px] font-medium text-gray-500 uppercase tracking-wider mb-1.5">
            {label}
          </p>
          <div className="flex items-baseline gap-2">
            <span className={`text-3xl font-bold tracking-tight ${c.accent}`}>{count}</span>
            {pct !== undefined && (
              <span className={`text-sm font-medium ${c.text}`}>{pct}%</span>
            )}
          </div>
          {subtitle && (
            <p className="text-[10px] text-gray-600 mt-1.5">{subtitle}</p>
          )}
        </div>

        {/* Right side — badges column */}
        {hasBadges && (
          <div className="flex flex-col justify-center gap-[3px] py-2 pr-3 pl-2 border-l border-white/[0.04]">
            {badges.map((b) => (
              <span
                key={b.key}
                onClick={b.clickKey ? (e) => { e.stopPropagation(); onConfBadgeClick?.(b.clickKey!); } : undefined}
                className={`flex items-center justify-between gap-2 ${b.bgClass} border ${b.borderClass} rounded px-2 py-[2px] ${b.clickKey ? "cursor-pointer hover:brightness-125" : ""} transition-all`}
                title={b.clickKey ? `${b.label} — Click to expand` : b.label}
              >
                <span className={`text-[9px] font-medium ${b.textClass} whitespace-nowrap`}>{b.label}</span>
                <span className={`text-[10px] font-bold ${b.valClass} tabular-nums min-w-[14px] text-right`}>{b.value}</span>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Active indicator */}
      <div className={`absolute bottom-2.5 left-3.5 h-2 w-2 rounded-full transition-all duration-200 ${active ? `${c.text.replace("text-", "bg-")} opacity-100 shadow-sm` : "opacity-0"}`} />
      {/* Click hint */}
      <div className="absolute bottom-2.5 right-3.5 text-[10px] text-gray-700 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
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
    <div className={`mt-4 rounded-xl border ${c.border} bg-[#1a1d28] overflow-hidden animate-slideDown shadow-lg shadow-black/10`}>
      <div className={`px-5 py-3.5 border-b ${c.border} ${c.bg}`}>
        <h3 className={`text-sm font-semibold ${c.text}`}>{title}</h3>
        <p className="text-[10px] text-gray-600 mt-0.5">
          {entries.length} services — Click a service to view test cases
        </p>
      </div>
      <div className="divide-y divide-white/[0.03] max-h-[400px] overflow-y-auto scrollbar-thin">
        {entries.map(([svc, tcs]) => (
          <div key={svc}>
            <button
              onClick={() => toggleService(svc)}
              className="w-full flex items-center justify-between px-4 py-2.5 text-left hover:bg-white/[0.03] transition-colors"
            >
              <div className="flex items-center gap-3">
                <span className={`flex h-6 w-6 items-center justify-center rounded-md text-[10px] font-bold ${c.bg} ${c.text}`}>
                  {svc.charAt(0)}
                </span>
                <span className="text-sm text-gray-300 font-medium">{svc}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className={`text-xs font-mono ${c.text} bg-white/[0.04] px-2 py-0.5 rounded-md`}>
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
              <div className="bg-[#0a0c12] border-t border-white/[0.03]">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-white/[0.04] text-gray-600">
                      <th className="px-4 py-2 text-left font-medium w-20">TC ID</th>
                      <th className="px-4 py-2 text-left font-medium">Test Case Name</th>
                      <th className="px-4 py-2 text-left font-medium w-60">Details</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.02]">
                    {tcs.map((tc, i) => {
                      const isTimeout = tc.error ? /timeout/i.test(tc.error) : false;
                      return (
                      <tr key={i} className={`hover:bg-white/[0.02] transition-colors ${isTimeout ? 'bg-yellow-500/[0.04]' : ''}`}>
                        <td className={`px-4 py-2 font-mono ${c.text}`}>
                          <div className="flex items-center gap-1.5">
                            {tc.tc_id}
                            {isTimeout && (
                              <span className="inline-flex items-center bg-yellow-500/20 border border-yellow-500/30 text-yellow-400 text-[9px] font-semibold px-1.5 py-0.5 rounded" title="Timeout failure">
                                ⏱ TIMEOUT
                              </span>
                            )}
                          </div>
                        </td>
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
                            <span className={`text-[10px] block truncate ${isTimeout ? 'text-yellow-400/80' : 'text-red-400/70'}`} title={tc.error}>
                              {isTimeout ? '⏱' : '⚠'} {tc.error.length > 80 ? tc.error.slice(0, 80) + "…" : tc.error}
                            </span>
                          )}
                          {!tc.linked && !tc.error && (
                            <span className="text-gray-700">—</span>
                          )}
                        </td>
                      </tr>
                      );
                    })}
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

// --- Regression Drill-down (timeout / non-timeout split + download) ---

function splitByTimeout(services: Record<string, TCEntry[]>): {
  timeoutServices: Record<string, TCEntry[]>;
  nonTimeoutServices: Record<string, TCEntry[]>;
} {
  const timeoutServices: Record<string, TCEntry[]> = {};
  const nonTimeoutServices: Record<string, TCEntry[]> = {};
  for (const [svc, tcs] of Object.entries(services)) {
    const to = tcs.filter((tc) => tc.error && /timeout/i.test(tc.error));
    const nonTo = tcs.filter((tc) => !(tc.error && /timeout/i.test(tc.error)));
    if (to.length > 0) timeoutServices[svc] = to;
    if (nonTo.length > 0) nonTimeoutServices[svc] = nonTo;
  }
  return { timeoutServices, nonTimeoutServices };
}

function downloadServiceDataAsExcel(
  services: Record<string, TCEntry[]>,
  platform: string,
  rc1: string,
  rc2: string,
  category: string,
) {
  const rows: string[][] = [["Service", "TC ID", "Test Case Name", "Error", "Linked Issue"]];
  for (const [svc, tcs] of Object.entries(services)) {
    for (const tc of tcs) {
      rows.push([
        svc,
        tc.tc_id,
        tc.name,
        tc.error ?? "",
        tc.linked ?? "",
      ]);
    }
  }
  const csvContent = rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${platform}_${rc1}_vs_${rc2}_${category}_regressions.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function RegressionDrillDown({
  title,
  services,
  expandedService,
  toggleService,
  color,
  platform,
  rc1,
  rc2,
  category,
  confidence,
  confidenceBuilds,
  initialConfBucket,
  onConfBucketChange,
}: {
  title: string;
  services: Record<string, TCEntry[]>;
  expandedService: string | null;
  toggleService: (svc: string) => void;
  color: string;
  platform: string;
  rc1: string;
  rc2: string;
  category: string;
  confidence?: ConfBuckets | Record<string, never>;
  confidenceBuilds?: string[];
  initialConfBucket?: string | null;
  onConfBucketChange?: () => void;
}) {
  const c = COLOR_MAP[color] ?? COLOR_MAP.slate;
  const { timeoutServices, nonTimeoutServices } = splitByTimeout(services);
  const timeoutEntries = Object.entries(timeoutServices);
  const nonTimeoutEntries = Object.entries(nonTimeoutServices);
  const totalTimeout = timeoutEntries.reduce((s, [, tcs]) => s + tcs.length, 0);
  const totalNonTimeout = nonTimeoutEntries.reduce((s, [, tcs]) => s + tcs.length, 0);

  // Confidence bucket config
  const CONF_BUCKETS: { key: string; label: string; color: string; textClass: string; bgClass: string; borderClass: string }[] = [
    { key: "high", label: "High", color: "emerald", textClass: "text-emerald-400", bgClass: "bg-emerald-500/10", borderClass: "border-emerald-500/20" },
    { key: "medium_high", label: "Med High", color: "sky", textClass: "text-sky-400", bgClass: "bg-sky-500/10", borderClass: "border-sky-500/20" },
    { key: "medium", label: "Med", color: "amber", textClass: "text-amber-400", bgClass: "bg-amber-500/10", borderClass: "border-amber-500/20" },
    { key: "medium_low", label: "Med Low", color: "orange", textClass: "text-orange-400", bgClass: "bg-orange-500/10", borderClass: "border-orange-500/20" },
    { key: "low", label: "Low", color: "red", textClass: "text-red-400", bgClass: "bg-red-500/10", borderClass: "border-red-500/20" },
  ];

  const hasConfidence = confidence && "high" in confidence;
  const [expandedConfBucket, setExpandedConfBucket] = useState<string | null>(null);
  const [expandedConfSvc, setExpandedConfSvc] = useState<string | null>(null);

  // Auto-expand confidence bucket when triggered from MetricBox badge click
  useEffect(() => {
    if (initialConfBucket) {
      setExpandedConfBucket(initialConfBucket);
      setExpandedConfSvc(null);
      onConfBucketChange?.();
    }
  }, [initialConfBucket]);

  if (timeoutEntries.length === 0 && nonTimeoutEntries.length === 0) {
    return (
      <div className={`mt-3 rounded-xl border ${c.border} ${c.bg} p-4 text-sm text-gray-500`}>
        No test cases in this category.
      </div>
    );
  }

  return (
    <div className="mt-4 space-y-4 animate-slideDown">
      {/* ── Confidence section ── */}
      {hasConfidence && (
        <div className="rounded-xl border border-cyan-500/20 bg-[#1a1d28] overflow-hidden shadow-lg shadow-black/10">
          <div className="px-5 py-3.5 border-b border-cyan-500/20 bg-cyan-500/[0.06]">
            <h3 className="text-sm font-semibold text-cyan-400 flex items-center gap-2">
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
              </svg>
              TC Confidence (across {confidenceBuilds?.length ?? 0} builds)
            </h3>
            <p className="text-[10px] text-gray-600 mt-0.5">
              Pass-rate of these regression TCs across builds: {confidenceBuilds?.join(", ")}
            </p>
          </div>

          {/* Confidence bucket pills */}
          <div className="px-5 py-3 flex flex-wrap gap-2">
            {CONF_BUCKETS.map((b) => {
              const bucket = (confidence as unknown as ConfBuckets)[b.key as keyof ConfBuckets];
              if (!bucket || bucket.count === 0) return null;
              const isActive = expandedConfBucket === b.key;
              return (
                <button
                  key={b.key}
                  onClick={() => {
                    setExpandedConfBucket(isActive ? null : b.key);
                    setExpandedConfSvc(null);
                  }}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-medium transition-all duration-150 ${
                    isActive
                      ? `${b.borderClass} ${b.bgClass} ${b.textClass} ring-1 ring-${b.color}-500/30`
                      : "border-white/[0.08] bg-white/[0.03] text-gray-400 hover:bg-white/[0.06]"
                  }`}
                >
                  <span className={`text-sm font-bold ${isActive ? b.textClass : "text-gray-300"}`}>
                    {bucket.count}
                  </span>
                  <span>{b.label}</span>
                </button>
              );
            })}
          </div>

          {/* Expanded bucket: service list */}
          {expandedConfBucket && (() => {
            const bucket = (confidence as unknown as ConfBuckets)[expandedConfBucket as keyof ConfBuckets];
            if (!bucket || Object.keys(bucket.by_service).length === 0) return null;
            const svcEntries = Object.entries(bucket.by_service).sort(([a], [b]) => a.localeCompare(b));
            const bConf = CONF_BUCKETS.find((b) => b.key === expandedConfBucket)!;
            return (
              <div className={`border-t ${bConf.borderClass} divide-y divide-white/[0.03] max-h-[350px] overflow-y-auto`}>
                {svcEntries.map(([svc, tcs]) => (
                  <div key={svc}>
                    <button
                      onClick={() => setExpandedConfSvc(expandedConfSvc === svc ? null : svc)}
                      className="w-full flex items-center justify-between px-4 py-2.5 text-left hover:bg-white/[0.03] transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <span className={`flex h-6 w-6 items-center justify-center rounded-md text-[10px] font-bold ${bConf.bgClass} ${bConf.textClass}`}>
                          {svc.charAt(0)}
                        </span>
                        <span className="text-sm text-gray-300 font-medium">{svc}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className={`text-xs font-mono ${bConf.textClass} bg-white/[0.04] px-2 py-0.5 rounded-md`}>
                          {tcs.length} TCs
                        </span>
                        <svg className={`h-3.5 w-3.5 text-gray-600 transition-transform duration-200 ${expandedConfSvc === svc ? "rotate-90" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                        </svg>
                      </div>
                    </button>
                    <div className={`overflow-hidden transition-all duration-300 ease-in-out ${expandedConfSvc === svc ? "max-h-[2000px] opacity-100" : "max-h-0 opacity-0"}`}>
                      <div className="bg-[#0a0c12] border-t border-white/[0.03]">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="border-b border-white/[0.04] text-gray-600">
                              <th className="px-4 py-2 text-left font-medium w-20">TC ID</th>
                              <th className="px-4 py-2 text-left font-medium">Test Case Name</th>
                              <th className="px-4 py-2 text-right font-medium w-24">Pass Rate</th>
                              <th className="px-4 py-2 text-right font-medium w-28">Builds</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-white/[0.02]">
                            {tcs.map((tc, i) => (
                              <tr key={i} className="hover:bg-white/[0.02] transition-colors">
                                <td className={`px-4 py-2 font-mono ${bConf.textClass}`}>{tc.tc_id}</td>
                                <td className="px-4 py-2 text-gray-400 font-mono truncate max-w-[300px]" title={tc.name}>
                                  {tc.name.replace(".py", "").replace(/_/g, " ")}
                                </td>
                                <td className={`px-4 py-2 text-right font-semibold ${bConf.textClass}`}>
                                  {tc.pass_pct}%
                                </td>
                                <td className="px-4 py-2 text-right text-gray-500 font-mono">
                                  {tc.pass_count}/{tc.total_builds}
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
            );
          })()}
        </div>
      )}

      {/* ── Timeout section ── */}
      {timeoutEntries.length > 0 && (
        <div className={`rounded-xl border border-yellow-500/20 bg-[#1a1d28] overflow-hidden shadow-lg shadow-black/10`}>
          <div className="px-5 py-3.5 border-b border-yellow-500/20 bg-yellow-500/[0.06] flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-yellow-400 flex items-center gap-2">
                <span>⏱</span> Timeout Failures
              </h3>
              <p className="text-[10px] text-gray-600 mt-0.5">
                {timeoutEntries.length} services — {totalTimeout} TCs failed due to timeout
              </p>
            </div>
          </div>
          <ServiceList entries={timeoutEntries} expandedService={expandedService} toggleService={toggleService} color={color} isTimeout />
        </div>
      )}

      {/* ── Non-timeout section ── */}
      {nonTimeoutEntries.length > 0 && (
        <div className={`rounded-xl border ${c.border} bg-[#1a1d28] overflow-hidden shadow-lg shadow-black/10`}>
          <div className={`px-5 py-3.5 border-b ${c.border} ${c.bg} flex items-center justify-between`}>
            <div>
              <h3 className={`text-sm font-semibold ${c.text}`}>{title} (excl. Timeouts)</h3>
              <p className="text-[10px] text-gray-600 mt-0.5">
                {nonTimeoutEntries.length} services — {totalNonTimeout} TCs — Click a service to view test cases
              </p>
            </div>
            <button
              onClick={() => downloadServiceDataAsExcel(nonTimeoutServices, platform, rc1, rc2, category)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.06] border border-white/10 text-[11px] font-medium text-gray-300 hover:bg-white/[0.1] hover:text-white transition-all duration-150"
              title="Download non-timeout regressions as CSV"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
              </svg>
              Download CSV
            </button>
          </div>
          <ServiceList entries={nonTimeoutEntries} expandedService={expandedService} toggleService={toggleService} color={color} />
        </div>
      )}
    </div>
  );
}

// --- Shared service list used by RegressionDrillDown ---

function ServiceList({
  entries,
  expandedService,
  toggleService,
  color,
  isTimeout,
}: {
  entries: [string, TCEntry[]][];
  expandedService: string | null;
  toggleService: (svc: string) => void;
  color: string;
  isTimeout?: boolean;
}) {
  const c = COLOR_MAP[color] ?? COLOR_MAP.slate;
  const borderC = isTimeout ? "border-yellow-500/20" : c.border;
  const bgC = isTimeout ? "bg-yellow-500/[0.06]" : c.bg;
  const textC = isTimeout ? "text-yellow-400" : c.text;

  return (
    <div className="divide-y divide-white/[0.03] max-h-[400px] overflow-y-auto scrollbar-thin">
      {entries.map(([svc, tcs]) => (
        <div key={svc}>
          <button
            onClick={() => toggleService(svc)}
            className="w-full flex items-center justify-between px-4 py-2.5 text-left hover:bg-white/[0.03] transition-colors"
          >
            <div className="flex items-center gap-3">
              <span className={`flex h-6 w-6 items-center justify-center rounded-md text-[10px] font-bold ${bgC} ${textC}`}>
                {svc.charAt(0)}
              </span>
              <span className="text-sm text-gray-300 font-medium">{svc}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className={`text-xs font-mono ${textC} bg-white/[0.04] px-2 py-0.5 rounded-md`}>
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
            <div className="bg-[#0a0c12] border-t border-white/[0.03]">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-white/[0.04] text-gray-600">
                    <th className="px-4 py-2 text-left font-medium w-20">TC ID</th>
                    <th className="px-4 py-2 text-left font-medium">Test Case Name</th>
                    <th className="px-4 py-2 text-left font-medium w-60">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.02]">
                  {tcs.map((tc, i) => {
                    const isTo = tc.error ? /timeout/i.test(tc.error) : false;
                    return (
                      <tr key={i} className={`hover:bg-white/[0.02] transition-colors ${isTo ? 'bg-yellow-500/[0.04]' : ''}`}>
                        <td className={`px-4 py-2 font-mono ${isTo ? 'text-yellow-400' : textC}`}>
                          <div className="flex items-center gap-1.5">
                            {tc.tc_id}
                            {isTo && (
                              <span className="inline-flex items-center bg-yellow-500/20 border border-yellow-500/30 text-yellow-400 text-[9px] font-semibold px-1.5 py-0.5 rounded" title="Timeout failure">
                                ⏱ TIMEOUT
                              </span>
                            )}
                          </div>
                        </td>
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
                            <span className={`text-[10px] block truncate ${isTo ? 'text-yellow-400/80' : 'text-red-400/70'}`} title={tc.error}>
                              {isTo ? '⏱' : '⚠'} {tc.error.length > 80 ? tc.error.slice(0, 80) + "…" : tc.error}
                            </span>
                          )}
                          {!tc.linked && !tc.error && (
                            <span className="text-gray-700">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ))}
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
    <div className="rounded-xl border border-white/[0.06] bg-[#1a1d28] p-6 shadow-lg shadow-black/10 transition-shadow duration-300 hover:shadow-xl hover:shadow-black/15">
      <h3 className="text-sm font-semibold text-gray-300 mb-5">{title}</h3>
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
