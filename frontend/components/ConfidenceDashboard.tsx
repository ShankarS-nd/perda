"use client";

import { useCallback, useState } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TCEntry {
  tc_id: string;
  name: string;
  pass_count: number;
  total_builds: number;
  pass_pct: number;
}

interface Bucket {
  label: string;
  count: number;
  by_service: Record<string, TCEntry[]>;
}

interface ConfidenceData {
  platform: string;
  builds: string[];
  num_builds: number;
  total_tcs: number;
  buckets: {
    always_pass: Bucket;
    high: Bucket;
    medium: Bucket;
    low: Bucket;
    never_pass: Bucket;
  };
}

type BucketKey = "always_pass" | "high" | "medium" | "low" | "never_pass";

const PLATFORMS = ["B2_US", "B3_IN", "B3_US", "K1_UK", "K1_US", "K2_IN", "K2_US"];

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://172.16.23.15:8000";

// ---------------------------------------------------------------------------
// Color map (matches TestReportDashboard)
// ---------------------------------------------------------------------------
const COLOR_MAP: Record<string, { bg: string; border: string; text: string; accent: string; ring: string }> = {
  emerald: {
    bg: "bg-emerald-500/8",
    border: "border-emerald-500/20",
    text: "text-emerald-400",
    accent: "text-emerald-300",
    ring: "ring-emerald-500/30",
  },
  sky: {
    bg: "bg-sky-500/8",
    border: "border-sky-500/20",
    text: "text-sky-400",
    accent: "text-sky-300",
    ring: "ring-sky-500/30",
  },
  amber: {
    bg: "bg-amber-500/8",
    border: "border-amber-500/20",
    text: "text-amber-400",
    accent: "text-amber-300",
    ring: "ring-amber-500/30",
  },
  rose: {
    bg: "bg-rose-500/8",
    border: "border-rose-500/20",
    text: "text-rose-400",
    accent: "text-rose-300",
    ring: "ring-rose-500/30",
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
};

// Bucket config
const BUCKET_CONFIG: { key: BucketKey; color: string; subtitle: string }[] = [
  { key: "always_pass",  color: "emerald", subtitle: "Passed in every build" },
  { key: "high",         color: "sky",     subtitle: "Passed 80 – 99 % of builds" },
  { key: "medium",       color: "amber",   subtitle: "Passed 50 – 79 % of builds" },
  { key: "low",          color: "rose",    subtitle: "Passed 1 – 49 % of builds" },
  { key: "never_pass",   color: "red",     subtitle: "Failed in every build" },
];

// ---------------------------------------------------------------------------
// CSV download helper
// ---------------------------------------------------------------------------

function downloadConfidenceCsv(
  services: Record<string, TCEntry[]>,
  platform: string,
  builds: string[],
  bucketKey: string,
  numBuilds: number,
) {
  const rows: string[][] = [["Service", "TC ID", "Test Case Name", "Pass Count", `Total Builds (${numBuilds})`, "Pass %"]];
  for (const [svc, tcs] of Object.entries(services)) {
    for (const tc of tcs) {
      rows.push([
        svc,
        tc.tc_id,
        tc.name,
        String(tc.pass_count),
        String(numBuilds),
        String(tc.pass_pct),
      ]);
    }
  }
  const csvContent = rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${platform}_confidence_${bucketKey}_builds_${builds.join("_")}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ConfidenceDashboard() {
  const [platform, setPlatform] = useState("K1_US");
  const [buildsInput, setBuildsInput] = useState("");
  const [urlsInput, setUrlsInput] = useState("");
  const [useUrls, setUseUrls] = useState(false);
  const [tcIdsInput, setTcIdsInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState<ConfidenceData | null>(null);
  const [savedBuilds, setSavedBuilds] = useState<Record<string, string[]>>({});

  // Drill-down
  const [activeBox, setActiveBox] = useState<BucketKey | null>(null);
  const [expandedService, setExpandedService] = useState<string | null>(null);

  // Load saved platform builds on mount
  const loadSavedBuilds = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/platform-builds`);
      if (res.ok) {
        const d = await res.json();
        setSavedBuilds(d);
        return d as Record<string, string[]>;
      }
    } catch {}
    return null;
  }, []);

  // Auto-load saved builds for selected platform
  const applySavedBuilds = useCallback(async () => {
    const d = await loadSavedBuilds();
    if (d && d[platform]) {
      setBuildsInput(d[platform].join(", "));
    } else {
      setError(`No saved builds for ${platform}.`);
    }
  }, [platform, loadSavedBuilds]);

  const fetchData = useCallback(async () => {
    const builds = buildsInput.split(",").map((b) => b.trim()).filter(Boolean);
    const urls = urlsInput.split("\n").map((u) => u.trim()).filter(Boolean);

    if (useUrls) {
      if (urls.length < 2) {
        setError("Enter at least 2 Jenkins URLs (one per line).");
        return;
      }
    } else {
      if (builds.length < 2) {
        setError("Enter at least 2 build numbers, comma-separated.");
        return;
      }
    }
    setError("");
    setLoading(true);
    setData(null);
    setActiveBox(null);
    setExpandedService(null);

    try {
      const res = await fetch(`${API_BASE}/test-case-confidence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform,
          builds: useUrls ? [] : builds,
          build_urls: useUrls ? urls : [],
          tc_ids: tcIdsInput.split(",").map((t) => t.trim()).filter(Boolean),
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.detail || `HTTP ${res.status}`);
      setData(body as ConfidenceData);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [platform, buildsInput, urlsInput, useUrls, tcIdsInput]);

  const handleBoxClick = (key: BucketKey) => {
    if (activeBox === key) {
      setActiveBox(null);
      setExpandedService(null);
    } else {
      setActiveBox(key);
      setExpandedService(null);
    }
  };

  const toggleService = (svc: string) => {
    setExpandedService(expandedService === svc ? null : svc);
  };

  return (
    <div className="w-full">
      

      {/* Input form */}
      <div className="rounded-xl border border-white/[0.06] bg-[#161922] p-5 mb-6">
        <div className={`grid grid-cols-1 ${useUrls ? "md:grid-cols-[200px_auto]" : "md:grid-cols-[200px_1fr_auto]"} gap-4 items-end`}>
          {/* Platform */}
          <div>
            <label className="ds-label mb-1.5">
              Platform
            </label>
            <select
              value={platform}
              onChange={(e) => setPlatform(e.target.value)}
              className="w-full rounded-lg border border-white/10 bg-[#0f1117] px-3 py-2 text-sm text-gray-300 focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/20 outline-none transition"
            >
              {PLATFORMS.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>

          {/* Build Numbers (shown when not using URLs) */}
          {!useUrls && (
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="ds-label">
                  Jenkins Build Numbers (comma-separated)
                </label>
                <button
                  onClick={applySavedBuilds}
                  className="text-[10px] font-medium text-cyan-400 hover:text-cyan-300 transition-colors"
                  title="Load saved builds for this platform"
                >
                  Load Saved Builds
                </button>
              </div>
              <input
                value={buildsInput}
                onChange={(e) => setBuildsInput(e.target.value)}
                placeholder="e.g. 857, 865, 871, 873"
                className="w-full rounded-lg border border-white/10 bg-[#0f1117] px-3 py-2 text-sm text-gray-300 placeholder-gray-600 focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/20 outline-none transition"
              />
            </div>
          )}

          {/* Analyse button */}
          <button
            onClick={fetchData}
            disabled={loading}
            className="ds-btn-primary shrink-0"
          >
            {loading ? (
              <>
                <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Analysing…
              </>
            ) : (
              <>
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
                </svg>
                Analyse
              </>
            )}
          </button>
        </div>

        {/* ── Direct URL toggle ── */}
        <div className="mt-4 mb-4">
          <button
            type="button"
            onClick={() => setUseUrls(!useUrls)}
            className="flex items-center gap-2 text-xs text-gray-400 hover:text-gray-300 transition-colors"
          >
            <div className={`relative w-8 h-[18px] rounded-full transition-colors ${useUrls ? "bg-cyan-500/40" : "bg-white/10"}`}>
              <div className={`absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white transition-all ${useUrls ? "left-[16px]" : "left-[2px]"}`} />
            </div>
            <span>Use Direct Jenkins URLs</span>
            {useUrls && <span className="text-gray-600 text-[10px]">(paste full URLs — one per line)</span>}
          </button>
        </div>

        {/* ── URL input (shown when toggle is on) ── */}
        {useUrls && (
          <div className="mb-4 animate-in fade-in duration-200">
            <label className="ds-label mb-1.5">
              Jenkins Build URLs <span className="text-gray-700">(one per line — at least 2)</span>
            </label>
            <textarea
              value={urlsInput}
              onChange={(e) => setUrlsInput(e.target.value)}
              placeholder={"https://build-device.netradyne.info/view/.../job/Test_Automation_Parallel/857/\nhttps://build-device.netradyne.info/view/.../job/SomeOtherJob/123/"}
              rows={4}
              className="w-full rounded-lg border border-white/10 bg-[#0f1117] px-3 py-2 text-sm text-gray-300 placeholder-gray-600 focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/20 outline-none transition font-mono text-xs leading-relaxed resize-y"
            />
          </div>
        )}

        {/* TC IDs filter (optional) */}
        <div className="mt-4">
          <label className="ds-label mb-1.5">
            TC IDs <span className="text-gray-700">(optional — comma-separated, filters to specific TCs only)</span>
          </label>
          <input
            value={tcIdsInput}
            onChange={(e) => setTcIdsInput(e.target.value)}
            placeholder="e.g. TC-185, TC-303, TC-42"
            className="w-full rounded-lg border border-white/10 bg-[#0f1117] px-3 py-2 text-sm text-gray-300 placeholder-gray-600 focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/20 outline-none transition"
          />
        </div>

        {error && (
          <div className="mt-3 rounded-lg border border-red-500/20 bg-red-500/8 px-4 py-2.5 text-sm text-red-400">
            {error}
          </div>
        )}
      </div>

      {/* Placeholder */}
      {!data && !loading && !error && (
        <div className="ds-empty">
          <svg className="h-12 w-12 mx-auto mb-3 text-gray-700" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
          </svg>
          <p className="text-sm">Enter a platform and at least two build numbers or URLs to start.</p>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="ds-loading">
          <svg className="h-5 w-5 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span className="text-sm">Downloading & analysing builds…</span>
        </div>
      )}

      {/* Results */}
      {data && !loading && (
        <div className="space-y-6">
          {/* Summary bar */}
          <div className="flex items-center gap-3 text-xs text-gray-500">
            <span className="bg-white/[0.04] border border-white/[0.06] px-2.5 py-1 rounded-lg font-mono">
              {data.platform}
            </span>
            <span>
              {data.num_builds} builds analysed: {data.builds.join(", ")}
            </span>
            <span className="ml-auto text-gray-600">
              {data.total_tcs} total test cases
            </span>
          </div>

          {/* Metric Boxes */}
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
            {BUCKET_CONFIG.map(({ key, color, subtitle }) => {
              const bucket = data.buckets[key];
              const pct = data.total_tcs > 0 ? Math.round((bucket.count / data.total_tcs) * 100) : 0;
              return (
                <ConfidenceBox
                  key={key}
                  label={bucket.label}
                  count={bucket.count}
                  pct={pct}
                  color={color}
                  active={activeBox === key}
                  onClick={() => handleBoxClick(key)}
                  subtitle={subtitle}
                />
              );
            })}
          </div>

          {/* Drill-down */}
          {activeBox && (
            <ConfidenceDrillDown
              title={data.buckets[activeBox].label + " Confidence"}
              services={data.buckets[activeBox].by_service}
              expandedService={expandedService}
              toggleService={toggleService}
              color={BUCKET_CONFIG.find((b) => b.key === activeBox)!.color}
              numBuilds={data.num_builds}
              platform={data.platform}
              builds={data.builds}
              bucketKey={activeBox}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ConfidenceBox({
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
  pct: number;
  color: string;
  active: boolean;
  onClick: () => void;
  subtitle: string;
}) {
  const c = COLOR_MAP[color] ?? COLOR_MAP.slate;
  return (
    <button
      onClick={onClick}
      className={`relative rounded-xl border ${c.border} ${c.bg} p-5 text-left transition-all duration-200 hover:scale-[1.015] hover:shadow-lg hover:shadow-black/10 cursor-pointer group ${
        active ? `ring-2 ${c.ring} scale-[1.015]` : ""
      }`}
    >
      <p className="text-[12px] font-medium text-gray-400 mb-1.5">
        {label}
      </p>
      <div className="flex items-baseline gap-2">
        <span className={`text-3xl font-bold tracking-tight ${c.accent}`}>{count}</span>
        <span className={`text-sm font-medium ${c.text}`}>{pct}%</span>
      </div>
      <p className="text-[10px] text-gray-600 mt-1.5">{subtitle}</p>
      {/* Active indicator */}
      <div className={`absolute top-3.5 right-3.5 h-2 w-2 rounded-full transition-all duration-200 ${active ? `${c.text.replace("text-", "bg-")} opacity-100 shadow-sm` : "opacity-0"}`} />
      {/* Click hint */}
      <div className="absolute bottom-2.5 right-3.5 text-[10px] text-gray-700 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
        Click to expand
      </div>
    </button>
  );
}

function ConfidenceDrillDown({
  title,
  services,
  expandedService,
  toggleService,
  color,
  numBuilds,
  platform,
  builds,
  bucketKey,
}: {
  title: string;
  services: Record<string, TCEntry[]>;
  expandedService: string | null;
  toggleService: (svc: string) => void;
  color: string;
  numBuilds: number;
  platform: string;
  builds: string[];
  bucketKey: string;
}) {
  const c = COLOR_MAP[color] ?? COLOR_MAP.slate;
  const entries = Object.entries(services);

  if (entries.length === 0) {
    return (
      <div className={`mt-3 rounded-xl border ${c.border} ${c.bg} p-4 text-sm text-gray-500`}>
        No test cases in this bucket.
      </div>
    );
  }

  return (
    <div className={`rounded-xl border ${c.border} bg-[#1a1d28] overflow-hidden animate-slideDown shadow-lg shadow-black/10`}>
      <div className={`px-5 py-3.5 border-b ${c.border} ${c.bg} flex items-center justify-between`}>
        <div>
          <h3 className={`text-sm font-semibold ${c.text}`}>{title}</h3>
          <p className="text-[10px] text-gray-600 mt-0.5">
            {entries.length} services — Click a service to view test cases
          </p>
        </div>
        <button
          onClick={() => downloadConfidenceCsv(services, platform, builds, bucketKey, numBuilds)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.06] border border-white/10 text-[11px] font-medium text-gray-300 hover:bg-white/[0.1] hover:text-white transition-all duration-150"
          title="Download as CSV"
        >
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
          </svg>
          Download CSV
        </button>
      </div>
      <div className="divide-y divide-white/[0.03] overflow-y-auto scrollbar-thin max-h-[min(620px,calc(100vh-340px))]">
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
                      <th className="px-4 py-2 text-right font-medium w-32">Pass Rate</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.02]">
                    {tcs.map((tc, i) => {
                      const pctColor =
                        tc.pass_pct === 100 ? "text-emerald-400" :
                        tc.pass_pct >= 80 ? "text-sky-400" :
                        tc.pass_pct >= 50 ? "text-amber-400" :
                        "text-rose-400";
                      return (
                        <tr key={i} className="hover:bg-white/[0.02] transition-colors">
                          <td className={`px-4 py-2 font-mono ${c.text}`}>{tc.tc_id}</td>
                          <td className="px-4 py-2 text-gray-400 font-mono truncate max-w-[400px]" title={tc.name}>
                            {tc.name.replace(".py", "").replace(/_/g, " ")}
                          </td>
                          <td className="px-4 py-2 text-right">
                            <span className={`font-mono font-semibold ${pctColor}`}>
                              {tc.pass_count}/{numBuilds}
                            </span>
                            <span className="text-gray-600 ml-1.5">
                              ({tc.pass_pct}%)
                            </span>
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
