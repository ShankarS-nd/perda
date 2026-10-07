"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";

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

interface Filters {
  q: string;
  suite: string;
  model: string;
  region: string;
  dateFrom: string;
  dateTo: string;
  minPass: string;
  maxPass: string;
  minUnknown: string;
}

interface FilterOptions {
  suites: string[];
}

interface Choice {
  value: string;
  label: string;
}

/** Product categories are "<MODEL>_<REGION>", e.g. BAGHEERA3_NA. */
const MODELS: Choice[] = [
  { value: "BAGHEERA3", label: "D-450 · Bagheera3" },
  { value: "BAGHEERA2", label: "D-430 · Bagheera2" },
  { value: "KRAIT2", label: "D-215 · Krait2" },
  { value: "KRAIT", label: "D-210 · Krait1" },
];

// Jenkins calls the US region "NA".
const REGIONS: Choice[] = [
  { value: "NA", label: "US" },
  { value: "UK", label: "UK" },
  { value: "IN", label: "IN" },
];

const labelFor = (choices: Choice[], value: string) =>
  choices.find((c) => c.value === value)?.label ?? value;

/** "BAGHEERA3_NA" → "D-450 · US" for the build row. */
function describeProduct(product: string): string {
  const i = product.lastIndexOf("_");
  if (i < 0) return product;
  const model = MODELS.find((m) => m.value === product.slice(0, i));
  const region = labelFor(REGIONS, product.slice(i + 1));
  return `${model ? model.label.split(" · ")[0] : product.slice(0, i)} · ${region}`;
}

const NO_FILTERS: Filters = {
  q: "", suite: "", model: "", region: "", dateFrom: "", dateTo: "",
  minPass: "", maxPass: "", minUnknown: "",
};

const PAGE_SIZE = 50;

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

/** Query string for the active filters. date_to is exclusive server-side, so
    the chosen end day is pushed forward one day to include it. */
function filterParams(f: Filters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.q.trim()) p.set("q", f.q.trim());
  if (f.suite) p.set("suite", f.suite);
  if (f.model) p.set("model", f.model);
  if (f.region) p.set("region", f.region);
  if (f.dateFrom) p.set("date_from", f.dateFrom);
  if (f.dateTo) {
    const d = new Date(`${f.dateTo}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    p.set("date_to", d.toISOString().slice(0, 10));
  }
  if (f.minPass !== "") p.set("min_pass", f.minPass);
  if (f.maxPass !== "") p.set("max_pass", f.maxPass);
  if (f.minUnknown !== "") p.set("min_unknown", f.minUnknown);
  return p;
}

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
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [options, setOptions] = useState<FilterOptions>({ suites: [] });
  const [total, setTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);

  const activeCount = useMemo(
    () => Object.values(filters).filter((v) => v !== "").length,
    [filters]
  );

  // Latest filters for the interval timer, which would otherwise keep the
  // filters it was created with.
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const loadedRef = useRef(0);
  loadedRef.current = builds.length;

  const fetchPage = useCallback(async (f: Filters, offset: number, limit: number) => {
    const p = filterParams(f);
    p.set("limit", String(limit));
    p.set("offset", String(offset));
    const res = await fetch(`${API_BASE}/build-log?${p}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as { builds: LoggedBuild[]; total: number };
  }, []);

  /** Re-read everything currently shown (at least one page) under the given filters. */
  const load = useCallback(async (f: Filters, keep = 0) => {
    try {
      const data = await fetchPage(f, 0, Math.max(PAGE_SIZE, keep));
      setBuilds(data.builds);
      setTotal(data.total);
      setError(null);
    } catch {
      setError("Failed to load the build log. Is the backend running?");
    } finally {
      setLoading(false);
    }
  }, [fetchPage]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const data = await fetchPage(filters, builds.length, PAGE_SIZE);
      setBuilds((prev) => [...prev, ...data.builds]);
      setTotal(data.total);
    } catch {
      setError("Failed to load more builds.");
    } finally {
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/build-log/filter-options`);
        if (res.ok) setOptions(await res.json());
      } catch { /* dropdowns just stay empty */ }
    })();
  }, [builds.length === 0]); // eslint-disable-line react-hooks/exhaustive-deps

  // Refetch when a filter changes (debounced so typing in a box isn't a request
  // per keystroke).
  useEffect(() => {
    const t = setTimeout(() => load(filters), 250);
    return () => clearTimeout(t);
  }, [filters, load]);

  // The backend logs new builds on its own schedule; re-read so a build that
  // finishes while this tab is open shows up without a manual refresh.
  useEffect(() => {
    const t = setInterval(() => load(filtersRef.current, loadedRef.current), 60000);
    return () => clearInterval(t);
  }, [load]);

  const setFilter = <K extends keyof Filters>(key: K, value: Filters[K]) =>
    setFilters((prev) => ({ ...prev, [key]: value }));

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
      await load(filters, builds.length);
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

      <FilterBar
        filters={filters}
        options={options}
        onChange={setFilter}
        onReset={() => setFilters(NO_FILTERS)}
        onPatch={(patch) => setFilters((prev) => ({ ...prev, ...patch }))}
      />

      <div className="ds-card overflow-hidden">
        <div className="ds-card-header flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-gray-300">
            Successful builds{" "}
            {!loading && (
              <span className="font-normal text-gray-500">
                · {activeCount > 0 ? `${total} match` : `${total} logged`}
              </span>
            )}
          </h3>
          <p className="text-[11px] text-gray-600">
            Percentages are of applicable tests (pass + fail + not executed)
          </p>
        </div>

        <div className="overflow-x-auto">
          {loading ? (
            <p className="py-16 text-center text-sm text-gray-500">Loading build log…</p>
          ) : builds.length === 0 && activeCount > 0 ? (
            <div className="ds-empty">
              <p className="text-[15px] font-medium text-gray-400 mb-1">No builds match these filters</p>
              <button onClick={() => setFilters(NO_FILTERS)} className="ds-btn-secondary mt-2">
                Clear filters
              </button>
            </div>
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
                          <div className="text-[11px] text-gray-600">
                            {[b.product && describeProduct(b.product), b.suite].filter(Boolean).join(" · ")}
                          </div>
                        </td>
                        <td className="font-mono text-xs text-gray-300">
                          {b.packages.length === 0 ? "—" : b.packages.map((p) => <div key={p}>{p}</div>)}
                        </td>
                        <td className="whitespace-nowrap text-gray-400">
                          <span className="inline-flex items-center gap-1.5">
                            <svg
                              className={`h-3 w-3 transition-transform ${open ? "rotate-90" : ""}`}
                              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}
                            >
                              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                            </svg>
                            {b.devices.length} device{b.devices.length === 1 ? "" : "s"}
                          </span>
                        </td>
                        <td className="whitespace-nowrap text-right tabular-nums">
                          <span className="font-medium text-emerald-400">{fmtPct(b.pass_pct)}</span>
                          <div className="text-[11px] text-gray-600">{b.pass_count} tests</div>
                        </td>
                        <td className="whitespace-nowrap text-right tabular-nums">
                          <span className="font-medium text-amber-400">{fmtPct(b.known_pct)}</span>
                          <div className="text-[11px] text-gray-600">
                            {b.known_count === null ? "pending" : `${b.known_count} tests`}
                          </div>
                        </td>
                        <td className="whitespace-nowrap text-right tabular-nums">
                          <span className="font-medium text-red-400">{fmtPct(b.unknown_pct)}</span>
                          <div className="text-[11px] text-gray-600">
                            {b.unknown_count === null ? "pending" : `${b.unknown_count} tests`}
                          </div>
                        </td>
                        <td className="whitespace-nowrap text-right">
                          <a
                            href={b.report_url} target="_blank" rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="ds-badge ds-badge-info whitespace-nowrap hover:opacity-80"
                          >
                            Open report
                            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H18v4.5M18 6l-8 8M10.5 7.5H7a1 1 0 00-1 1V17a1 1 0 001 1h8.5a1 1 0 001-1v-3.5" />
                            </svg>
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
        {!loading && builds.length < total && (
          <div className="flex items-center justify-center gap-3 border-t border-white/[0.04] py-3">
            <span className="text-xs text-gray-500">Showing {builds.length} of {total}</span>
            <button onClick={loadMore} disabled={loadingMore} className="ds-btn-secondary">
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filter bar
// ---------------------------------------------------------------------------

const isoDay = (d: Date) => {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return z.toISOString().slice(0, 10);
};
const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return isoDay(d);
};

const DATE_PRESETS: { label: string; days: number | null }[] = [
  { label: "All time", days: null },
  { label: "Today", days: 0 },
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
];

/** One-click health slices — each is just a preset for the numeric filters. */
const HEALTH_PRESETS: { label: string; patch: Partial<Filters>; tone: string }[] = [
  { label: "Healthy · pass ≥ 90%", patch: { minPass: "90" }, tone: "emerald" },
  { label: "Weak · pass < 85%", patch: { maxPass: "84.99" }, tone: "amber" },
  { label: "Many unknowns · ≥ 10%", patch: { minUnknown: "10" }, tone: "red" },
];

const TONES: Record<string, string> = {
  emerald: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  amber: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  red: "border-red-500/30 bg-red-500/10 text-red-300",
};

function FilterBar({
  filters, options, onChange, onPatch, onReset,
}: {
  filters: Filters;
  options: FilterOptions;
  onChange: <K extends keyof Filters>(key: K, value: Filters[K]) => void;
  onPatch: (patch: Partial<Filters>) => void;
  onReset: () => void;
}) {
  const [showCustom, setShowCustom] = useState(false);

  const presetDays = DATE_PRESETS.find(
    (p) => p.days !== null && !filters.dateTo && filters.dateFrom === daysAgo(p.days)
  )?.days;
  const allTime = !filters.dateFrom && !filters.dateTo;
  const customDates = !allTime && presetDays === undefined;
  const customOpen = showCustom || customDates;

  const patchActive = (patch: Partial<Filters>) =>
    (Object.keys(patch) as (keyof Filters)[]).every((k) => filters[k] === patch[k]);

  // Everything that is set, as removable chips.
  const chips: { key: string; label: string; clear: Partial<Filters> }[] = [];
  if (filters.q.trim()) chips.push({ key: "q", label: `“${filters.q.trim()}”`, clear: { q: "" } });
  if (filters.suite) chips.push({ key: "suite", label: `Suite: ${filters.suite}`, clear: { suite: "" } });
  if (filters.model) chips.push({ key: "model", label: `Device: ${labelFor(MODELS, filters.model)}`, clear: { model: "" } });
  if (filters.region) chips.push({ key: "region", label: `Region: ${labelFor(REGIONS, filters.region)}`, clear: { region: "" } });
  if (filters.dateFrom || filters.dateTo) {
    const label = presetDays !== undefined && presetDays !== null
      ? (presetDays === 0 ? "Today" : `Last ${presetDays} days`)
      : `${filters.dateFrom || "…"} → ${filters.dateTo || "now"}`;
    chips.push({ key: "date", label, clear: { dateFrom: "", dateTo: "" } });
  }
  if (filters.minPass !== "") chips.push({ key: "minPass", label: `Pass ≥ ${filters.minPass}%`, clear: { minPass: "" } });
  if (filters.maxPass !== "") chips.push({ key: "maxPass", label: filters.maxPass === "84.99" ? "Pass < 85%" : `Pass ≤ ${filters.maxPass}%`, clear: { maxPass: "" } });
  if (filters.minUnknown !== "") chips.push({ key: "minUnknown", label: `Unknown ≥ ${filters.minUnknown}%`, clear: { minUnknown: "" } });

  return (
    <div className="ds-card p-4 space-y-3.5">
      {/* Row 1 — search + dropdown pills */}
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="relative min-w-[240px] flex-1">
          <svg
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-600"
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
          </svg>
          <input
            value={filters.q}
            onChange={(e) => onChange("q", e.target.value)}
            placeholder="Search build number or package…"
            aria-label="Search builds by number or package"
            className="ds-input w-full !rounded-full !py-2 !pl-10 !pr-9 !text-[13px]"
          />
          {filters.q && (
            <button
              onClick={() => onChange("q", "")}
              aria-label="Clear search"
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-600 transition-colors hover:text-gray-300"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        <PillSelect label="Device" value={filters.model} options={MODELS} onChange={(v) => onChange("model", v)} />
        <PillSelect label="Region" value={filters.region} options={REGIONS} onChange={(v) => onChange("region", v)} />
        <PillSelect
          label="Suite" value={filters.suite}
          options={options.suites.map((x) => ({ value: x, label: x }))}
          onChange={(v) => onChange("suite", v)}
        />
      </div>

      {/* Row 2 — date range + health slices */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2.5">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-medium uppercase tracking-wider text-gray-600">When</span>
          <div className="flex items-center rounded-full border border-white/[0.07] bg-white/[0.02] p-0.5">
            {DATE_PRESETS.map((p) => {
              const on = p.days === null ? allTime && !customOpen : presetDays === p.days;
              return (
                <button
                  key={p.label}
                  aria-pressed={on}
                  onClick={() => {
                    setShowCustom(false);
                    onPatch({ dateFrom: p.days === null ? "" : daysAgo(p.days), dateTo: "" });
                  }}
                  className={`rounded-full px-3 py-1 text-[12px] font-medium transition-colors duration-150 ${
                    on ? "bg-indigo-500/20 text-indigo-200" : "text-gray-500 hover:text-gray-300"
                  }`}
                >
                  {p.label}
                </button>
              );
            })}
            <button
              aria-pressed={customOpen}
              onClick={() => setShowCustom((v) => !v)}
              className={`rounded-full px-3 py-1 text-[12px] font-medium transition-colors duration-150 ${
                customOpen ? "bg-indigo-500/20 text-indigo-200" : "text-gray-500 hover:text-gray-300"
              }`}
            >
              Custom
            </button>
          </div>
          {customOpen && (
            <div className="flex items-center gap-1.5">
              <input
                type="date" value={filters.dateFrom} max={filters.dateTo || undefined}
                aria-label="From date"
                onChange={(e) => onChange("dateFrom", e.target.value)}
                className="ds-input !rounded-full !py-1 !text-[12px]"
              />
              <span className="text-gray-600">→</span>
              <input
                type="date" value={filters.dateTo} min={filters.dateFrom || undefined}
                aria-label="To date"
                onChange={(e) => onChange("dateTo", e.target.value)}
                className="ds-input !rounded-full !py-1 !text-[12px]"
              />
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-medium uppercase tracking-wider text-gray-600">Health</span>
          {HEALTH_PRESETS.map((h) => {
            const on = patchActive(h.patch);
            return (
              <button
                key={h.label}
                aria-pressed={on}
                onClick={() =>
                  onPatch(on
                    ? Object.fromEntries(Object.keys(h.patch).map((k) => [k, ""]))
                    : h.patch)
                }
                className={`rounded-full border px-3 py-1 text-[12px] font-medium transition-colors duration-150 ${
                  on
                    ? TONES[h.tone]
                    : "border-white/[0.07] text-gray-500 hover:border-white/[0.14] hover:text-gray-300"
                }`}
              >
                {h.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Row 3 — what is applied, each removable */}
      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-t border-white/[0.05] pt-3">
          <span className="text-[11px] font-medium uppercase tracking-wider text-gray-600">Applied</span>
          {chips.map((c) => (
            <span
              key={c.key}
              className="inline-flex items-center gap-1 rounded-full border border-indigo-500/25 bg-indigo-500/10 py-0.5 pl-2.5 pr-1 text-[12px] text-indigo-200"
            >
              {c.label}
              <button
                onClick={() => onPatch(c.clear)}
                aria-label={`Remove filter ${c.label}`}
                className="rounded-full p-0.5 text-indigo-300/70 transition-colors hover:bg-white/10 hover:text-white"
              >
                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </span>
          ))}
          <button
            onClick={onReset}
            className="ml-1 text-[12px] text-gray-500 underline-offset-2 transition-colors hover:text-gray-200 hover:underline"
          >
            Clear all
          </button>
        </div>
      )}
    </div>
  );
}

/** A pill that opens the native dropdown: the <select> sits invisibly on top, so
    keyboard, mobile pickers and screen readers all keep working. */
function PillSelect({
  label, value, options, onChange,
}: { label: string; value: string; options: Choice[]; onChange: (v: string) => void }) {
  const on = value !== "";
  return (
    <label
      className={`relative inline-flex cursor-pointer items-center gap-1.5 rounded-full border py-1.5 pl-3.5 pr-2.5 text-[13px] transition-colors duration-150 focus-within:ring-2 focus-within:ring-indigo-500/40 ${
        on
          ? "border-indigo-500/30 bg-indigo-500/10 text-indigo-200"
          : "border-white/[0.08] bg-white/[0.02] text-gray-400 hover:border-white/[0.16] hover:text-gray-200"
      }`}
    >
      <span className={on ? "text-indigo-300/70" : "text-gray-600"}>{label}</span>
      <span className="font-medium">{on ? labelFor(options, value) : "Any"}</span>
      <svg className="h-3.5 w-3.5 opacity-60" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
      </svg>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        className="ds-pill-select absolute inset-0 h-full w-full cursor-pointer opacity-0"
      >
        <option value="">Any</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}
