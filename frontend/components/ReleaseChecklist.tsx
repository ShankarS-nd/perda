"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface Cell { status: string; updated_by: string; updated_at: string }
interface Row { item: string; cells: Record<string, Cell> }
interface Checklist { platforms: string[]; statuses: string[]; rows: Row[]; reset_at: string }

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://172.16.23.15:8000";
const NAME_KEY = "perda-review-reviewer";
const POLL_MS = 5000;

const TONE: Record<string, string> = {
  Done: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  Pending: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  "N/A": "border-white/10 bg-white/[0.03] text-gray-500",
};

function ago(iso: string): string {
  const t = Date.parse(iso);
  if (!t) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export default function ReleaseChecklist() {
  const [data, setData] = useState<Checklist | null>(null);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState("");
  const [updated, setUpdated] = useState(0);
  const saving = useRef(0);

  useEffect(() => {
    try { setName(localStorage.getItem(NAME_KEY) ?? ""); } catch { /* no storage */ }
  }, []);

  const load = useCallback(async () => {
    if (saving.current > 0) return; // do not overwrite an edit that is still being saved
    try {
      const res = await fetch(`${API_BASE}/release-checklist`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
      setUpdated(Date.now());
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Backend not reachable");
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(() => { if (!document.hidden) load(); }, POLL_MS);
    const onVis = () => { if (!document.hidden) load(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", onVis); };
  }, [load]);

  const send = async (path: string, method: string, body: object, key: string) => {
    saving.current++;
    setBusy(key);
    try {
      const res = await fetch(`${API_BASE}${path}`, {
        method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail ?? `HTTP ${res.status}`);
      setData(await res.json());
      setUpdated(Date.now());
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      saving.current--;
      setBusy("");
    }
  };

  const remember = (n: string) => {
    setName(n);
    try { localStorage.setItem(NAME_KEY, n); } catch { /* not remembered */ }
  };

  const setCell = (item: string, platform: string, status: string) =>
    send("/release-checklist", "PUT", { item, platform, status, actor: name }, `${item}|${platform}`);

  const reset = () => {
    if (!window.confirm("Start a new release? Every Done cell goes back to Pending (N/A stays N/A).")) return;
    send("/release-checklist/reset", "POST", { actor: name }, "reset");
  };

  const progress = (p: string) => {
    const cells = (data?.rows ?? []).map((r) => r.cells[p]?.status);
    const applicable = cells.filter((s) => s !== "N/A");
    return { done: applicable.filter((s) => s === "Done").length, total: applicable.length };
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <input
          value={name}
          onChange={(e) => remember(e.target.value)}
          placeholder="Your name (shown on edits)"
          aria-label="Your name"
          className="w-56 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 text-sm text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-indigo-500/50"
        />
        <span className="flex items-center gap-1.5 text-xs text-gray-500">
          <span className={`h-1.5 w-1.5 rounded-full ${error ? "bg-red-400" : "bg-emerald-400"}`} />
          {error ? `Offline: ${error}` : updated ? "Live, updates every 5 s" : "Loading"}
        </span>
        <button
          onClick={reset}
          disabled={!data || busy === "reset"}
          className="ml-auto rounded-lg border border-white/10 px-3 py-1.5 text-xs text-gray-300 hover:bg-white/[0.05] disabled:opacity-40"
        >
          New release (reset)
        </button>
      </div>

      {data && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {data.platforms.map((p) => {
            const { done, total } = progress(p);
            const pct = total ? Math.round((done / total) * 100) : 0;
            return (
              <div key={p} className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
                <div className="flex items-baseline justify-between">
                  <span className="text-sm font-medium text-gray-200">{p}</span>
                  <span className="text-xs text-gray-500">{done} of {total} done</span>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
                  <div className="h-full bg-emerald-400/80 transition-[width]" style={{ width: `${pct}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-white/[0.06]">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/[0.06] text-left text-xs uppercase text-gray-500">
              <th className="px-4 py-3 font-medium">Release checklist</th>
              {data?.platforms.map((p) => <th key={p} className="px-4 py-3 font-medium">{p}</th>)}
            </tr>
          </thead>
          <tbody>
            {data?.rows.map((r) => (
              <tr key={r.item} className="border-b border-white/[0.04] last:border-0">
                <td className="px-4 py-3 text-gray-200">{r.item}</td>
                {data.platforms.map((p) => {
                  const c = r.cells[p];
                  const key = `${r.item}|${p}`;
                  return (
                    <td key={p} className="px-4 py-2.5">
                      <select
                        value={c.status}
                        disabled={busy === key}
                        onChange={(e) => setCell(r.item, p, e.target.value)}
                        aria-label={`${r.item}, ${p}`}
                        className={`rounded-md border px-2 py-1 text-xs font-medium focus:outline-none ${TONE[c.status] ?? TONE.Pending}`}
                      >
                        {data.statuses.map((s) => <option key={s} value={s} className="bg-gray-900 text-gray-200">{s}</option>)}
                      </select>
                      {c.updated_by && (
                        <div className="mt-0.5 text-[11px] text-gray-600">{c.updated_by} · {ago(c.updated_at)}</div>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
            {!data && !error && (
              <tr><td className="px-4 py-6 text-gray-500" colSpan={3}>Loading</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
