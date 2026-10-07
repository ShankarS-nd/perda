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
  product: string;
  sku: string;
  dateFrom: string;
  dateTo: string;
  minPass: string;
  maxPass: string;
  minUnknown: string;
}

interface FilterOptions {
  suites: string[];
  products: string[];
  skus: string[];
}

const NO_FILTERS: Filters = {
  q: "", suite: "", product: "", sku: "", dateFrom: "", dateTo: "",
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
  if (f.product) p.set("product", f.product);
  if (f.sku) p.set("sku", f.sku);
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
  const [options, setOptions] = useState<FilterOptions>({ suites: [], products: [], skus: [] });
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

      <div className="ds-card">
        <div className="flex flex-wrap items-end gap-3 p-4">
          <label className="flex flex-col gap-1">
            <span className="ds-label">Search</span>
            <input
              value={filters.q}
              onChange={(e) => setFilter("q", e.target.value)}
              placeholder="Build # or package…"
              className="ds-input w-52 !py-1.5 !text-[13px]"
            />
          </label>
          <SelectFilter label="Suite" value={filters.suite} options={options.suites} onChange={(v) => setFilter("suite", v)} />
          <SelectFilter label="Product" value={filters.product} options={options.products} onChange={(v) => setFilter("product", v)} />
          <SelectFilter label="Device SKU" value={filters.sku} options={options.skus} onChange={(v) => setFilter("sku", v)} />
          <label className="flex flex-col gap-1">
            <span className="ds-label">From</span>
            <input type="date" value={filters.dateFrom} max={filters.dateTo || undefined}
              onChange={(e) => setFilter("dateFrom", e.target.value)}
              className="ds-input !py-1.5 !text-[13px]" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="ds-label">To</span>
            <input type="date" value={filters.dateTo} min={filters.dateFrom || undefined}
              onChange={(e) => setFilter("dateTo", e.target.value)}
              className="ds-input !py-1.5 !text-[13px]" />
          </label>
          <NumberFilter label="Pass % ≥" value={filters.minPass} onChange={(v) => setFilter("minPass", v)} />
          <NumberFilter label="Pass % ≤" value={filters.maxPass} onChange={(v) => setFilter("maxPass", v)} />
          <NumberFilter label="Unknown % ≥" value={filters.minUnknown} onChange={(v) => setFilter("minUnknown", v)} />
          {activeCount > 0 && (
            <button onClick={() => setFilters(NO_FILTERS)} className="ds-btn-secondary !py-1.5">
              Clear filters · {activeCount}
            </button>
          )}
        </div>
      </div>

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

function SelectFilter({
  label, value, options, onChange,
}: { label: string; value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="ds-label">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="ds-input !py-1.5 !text-[13px] min-w-[8rem]"
      >
        <option value="">Any</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  );
}

function NumberFilter({
  label, value, onChange,
}: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="ds-label">{label}</span>
      <input
        type="number" min={0} max={100} step={1} value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="0–100"
        className="ds-input w-24 !py-1.5 !text-[13px]"
      />
    </label>
  );
}
