"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Review Bench — sign-off queue for generated regression testcases.
//
// Testcases are generated on a workstation and pushed to the backend, which
// owns the review state. Everything a reviewer needs is here: the ticket it
// came from, what the testcase asserts, its full source, and the discussion.
// ---------------------------------------------------------------------------

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://172.16.23.15:8000";

interface Comment {
  id: number;
  author: string;
  kind: "change" | "question" | "note";
  body: string;
  resolved: boolean;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
}

interface Testcase {
  id: number;
  tc_key: string;
  dt: string;
  dt_url: string;
  dt_summary: string;
  dt_description: string;
  component: string;
  service: string;
  priority: string;
  jira_status: string;
  fix_version: string;
  tc_id: string;
  tc_file: string;
  tc_path: string;
  tc_summary: string;
  source: string;
  flag: string | null;
  report_url: string | null;
  review_status: "pending" | "reviewed";
  reviewed_by: string | null;
  reviewed_at: string | null;
  pushed_at: string;
  comments: Comment[];
}

type Queue = "pending" | "comments" | "reviewed" | "all";

const QUEUES: { key: Queue; label: string; dot: string }[] = [
  { key: "pending", label: "Needs review", dot: "bg-amber-400" },
  { key: "comments", label: "Open comments", dot: "bg-indigo-400" },
  { key: "reviewed", label: "Reviewed", dot: "bg-emerald-400" },
  { key: "all", label: "All", dot: "bg-gray-500" },
];

const KINDS: { key: Comment["kind"]; label: string }[] = [
  { key: "change", label: "Needs change" },
  { key: "question", label: "Question" },
  { key: "note", label: "Note" },
];

// ---------------------------------------------------------------------------
// Python highlighting — docstrings, comments, strings, keywords, numbers.
// Deliberately small: these files are dict literals and log-line assertions,
// not arbitrary Python, and a full tokenizer would earn nothing here.
// ---------------------------------------------------------------------------

const PY_TOKENS =
  /("""[\s\S]*?"""|'''[\s\S]*?'''|#[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\b(?:False|True|None|and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|try|while|with|yield)\b|\b0[xX][0-9a-fA-F]+\b|\b\d+(?:\.\d+)?\b)/g;

const ESC: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};
const esc = (v: string) => String(v ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

function highlight(src: string): string {
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  PY_TOKENS.lastIndex = 0;
  while ((m = PY_TOKENS.exec(src)) !== null) {
    out += esc(src.slice(last, m.index));
    const t = m[0];
    const h3 = t.slice(0, 3);
    const ch = t.charAt(0);
    let cls: string;
    if (h3 === '"""' || h3 === "'''") cls = "text-gray-500 italic";
    else if (ch === "#") cls = "text-amber-500/80";
    else if (ch === '"' || ch === "'") cls = "text-emerald-400/90";
    else if (ch >= "0" && ch <= "9") cls = "text-rose-400/90";
    else cls = "text-indigo-300 font-semibold";
    out += `<span class="${cls}">${esc(t)}</span>`;
    last = m.index + t.length;
  }
  return out + esc(src.slice(last));
}

// ---------------------------------------------------------------------------

const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return `${d.getDate()} ${MON[d.getMonth()]} ${d.getFullYear()}`;
}
function fmtWhen(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const hh = `0${d.getHours()}`.slice(-2);
  const mm = `0${d.getMinutes()}`.slice(-2);
  return `${fmtDate(iso)}, ${hh}:${mm}`;
}
function initials(name: string): string {
  const p = (name || "?").trim().split(/[\s.]+/).filter(Boolean);
  if (!p.length) return "?";
  return (p[0][0] + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase();
}

function IconExternal() {
  return (
    <svg className="h-3 w-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round"
        d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
    </svg>
  );
}
function IconUp() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 15.75l7.5-7.5 7.5 7.5" />
    </svg>
  );
}
function IconDown() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
    </svg>
  );
}
function IconCheck() {
  return (
    <svg className="h-3.5 w-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
    </svg>
  );
}
function IconChevron({ open }: { open: boolean }) {
  return (
    <svg
      className={`h-3 w-3 shrink-0 transition-transform duration-200 ${open ? "rotate-90" : ""}`}
      fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
    </svg>
  );
}

interface Note { id: number; kind: "success" | "error" | "info"; text: string; exiting?: boolean }
let noteId = 0;

export default function ReviewBench() {
  const [items, setItems] = useState<Testcase[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [queue, setQueue] = useState<Queue>("pending");
  const [dtFilter, setDtFilter] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [reviewer, setReviewer] = useState("");
  const [askName, setAskName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [kinds, setKinds] = useState<Record<string, Comment["kind"]>>({});
  const [confirmDel, setConfirmDel] = useState<number | null>(null);
  const [showResolved, setShowResolved] = useState<Record<string, boolean>>({});
  const [foldSrc, setFoldSrc] = useState<Record<string, boolean>>({});
  const [openWhy, setOpenWhy] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState<Note[]>([]);

  const pendingAction = useRef<(() => void) | null>(null);
  const detailRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  // ---- toasts: top-centre, short-lived, no dismiss chrome to hunt for ----
  const note = useCallback((kind: Note["kind"], text: string, ms = 1700) => {
    const id = ++noteId;
    setNotes((p) => [...p, { id, kind, text }]);
    setTimeout(() => {
      setNotes((p) => p.map((n) => (n.id === id ? { ...n, exiting: true } : n)));
      setTimeout(() => setNotes((p) => p.filter((n) => n.id !== id)), 280);
    }, ms);
  }, []);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("perda-review-reviewer");
      if (saved) setReviewer(saved);
    } catch {}
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/review/testcases`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setItems(await res.json());
      setError(null);
    } catch (e) {
      setError(
        "Could not reach the backend. The review bench needs the perda API on port 8000."
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // ---- derived ----
  const openOf = (t: Testcase) => t.comments.filter((c) => !c.resolved).length;

  const counts = useMemo(() => {
    const c = { pending: 0, reviewed: 0, comments: 0, all: items.length, open: 0 };
    items.forEach((t) => {
      if (t.review_status === "reviewed") c.reviewed++; else c.pending++;
      const n = openOf(t);
      if (n) { c.comments++; c.open += n; }
    });
    return c;
  }, [items]);

  const tickets = useMemo(() => {
    const map = new Map<string, { dt: string; url: string; n: number; pending: number }>();
    items.forEach((t) => {
      const e = map.get(t.dt) ?? { dt: t.dt, url: t.dt_url, n: 0, pending: 0 };
      e.n++;
      if (t.review_status === "pending") e.pending++;
      map.set(t.dt, e);
    });
    return Array.from(map.values());
  }, [items]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((t) => {
      const inQueue =
        queue === "all" ? true
        : queue === "pending" ? t.review_status === "pending"
        : queue === "reviewed" ? t.review_status === "reviewed"
        : openOf(t) > 0;
      if (!inQueue) return false;
      if (dtFilter && t.dt !== dtFilter) return false;
      if (!q) return true;
      const hay = [
        t.dt, t.tc_id, t.tc_file, t.dt_summary, t.tc_summary, t.component,
        t.fix_version, t.priority, t.flag ?? "", t.source,
        t.comments.map((c) => `${c.author} ${c.body}`).join(" "),
      ].join(" ").toLowerCase();
      return q.split(/\s+/).every((w) => hay.includes(w));
    });
  }, [items, queue, dtFilter, query]);

  useEffect(() => {
    if (!visible.length) { setSel(null); return; }
    if (!sel || !visible.some((t) => t.tc_key === sel)) setSel(visible[0].tc_key);
  }, [visible, sel]);

  const current = useMemo(
    () => items.find((t) => t.tc_key === sel) ?? null,
    [items, sel]
  );

  const idx = visible.findIndex((t) => t.tc_key === sel);

  const move = useCallback((delta: number) => {
    if (!visible.length) return;
    const i = visible.findIndex((t) => t.tc_key === sel);
    const n = Math.max(0, Math.min(visible.length - 1, (i < 0 ? 0 : i) + delta));
    setSel(visible[n].tc_key);
    detailRef.current?.scrollTo({ top: 0 });
  }, [visible, sel]);

  // ---- name gate: everything written here is attributed ----
  const needName = (after: () => void) => {
    if (reviewer) return false;
    pendingAction.current = after;
    setNameDraft("");
    setAskName(true);
    return true;
  };
  const saveName = () => {
    const v = nameDraft.trim();
    if (!v) return;
    setReviewer(v);
    try { localStorage.setItem("perda-review-reviewer", v); } catch {}
    setAskName(false);
    const fn = pendingAction.current;
    pendingAction.current = null;
    if (fn) setTimeout(fn, 0);
  };

  // ---- mutations: optimistic, rolled back if the API refuses ----
  async function mutate(apply: () => void, rollback: () => void, req: () => Promise<Response>, ok?: string) {
    if (busy) return;
    setBusy(true);
    apply();
    try {
      const res = await req();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (ok) note("success", ok);
      await load();
    } catch {
      rollback();
      note("error", "That did not save, so nothing changed.", 2600);
    } finally {
      setBusy(false);
    }
  }

  const setStatus = (t: Testcase, status: "reviewed" | "pending") => {
    if (status === "reviewed" && needName(() => setStatus(t, "reviewed"))) return;
    const prev = { s: t.review_status, by: t.reviewed_by, at: t.reviewed_at };
    mutate(
      () => setItems((p) => p.map((x) => x.tc_key === t.tc_key ? {
        ...x, review_status: status,
        reviewed_by: status === "reviewed" ? reviewer : null,
        reviewed_at: status === "reviewed" ? new Date().toISOString() : null,
      } : x)),
      () => setItems((p) => p.map((x) => x.tc_key === t.tc_key ? {
        ...x, review_status: prev.s, reviewed_by: prev.by, reviewed_at: prev.at,
      } : x)),
      () => fetch(`${API_BASE}/review/testcases/${encodeURIComponent(t.tc_key)}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, reviewer }),
      }),
      status === "reviewed" ? `${t.tc_id} marked reviewed` : `${t.tc_id} back in the queue`
    );
  };

  const postComment = (t: Testcase) => {
    const body = (drafts[t.tc_key] ?? "").trim();
    if (!body) { composerRef.current?.focus(); note("error", "Write something first."); return; }
    if (needName(() => postComment(t))) return;
    const kind = kinds[t.tc_key] ?? "change";
    const keep = drafts[t.tc_key];
    mutate(
      () => setDrafts((p) => ({ ...p, [t.tc_key]: "" })),
      () => setDrafts((p) => ({ ...p, [t.tc_key]: keep })),
      () => fetch(`${API_BASE}/review/testcases/${encodeURIComponent(t.tc_key)}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ author: reviewer, kind, body }),
      }),
      "Comment posted"
    );
  };

  const resolveComment = (c: Comment, resolved: boolean) => {
    if (resolved && needName(() => resolveComment(c, true))) return;
    mutate(() => {}, () => {},
      () => fetch(`${API_BASE}/review/comments/${c.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolved, actor: reviewer }),
      }),
      resolved ? "Comment resolved" : "Comment reopened"
    );
  };

  const removeComment = (c: Comment) => {
    setConfirmDel(null);
    mutate(() => {}, () => {},
      () => fetch(`${API_BASE}/review/comments/${c.id}`, { method: "DELETE" }),
      "Comment deleted"
    );
  };

  // ---- keyboard: this is a queue, it should be drivable without the mouse ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      const typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA");
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && el?.tagName === "TEXTAREA") {
        if (current) { e.preventDefault(); postComment(current); }
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); move(1); }
      else if (e.key === "k" || e.key === "ArrowUp") { e.preventDefault(); move(-1); }
      else if (e.key === "r" && current) {
        e.preventDefault();
        setStatus(current, current.review_status === "reviewed" ? "pending" : "reviewed");
      } else if (e.key === "c" && current) {
        e.preventDefault();
        composerRef.current?.scrollIntoView({ block: "center" });
        composerRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, move]); // eslint-disable-line react-hooks/exhaustive-deps

  // -------------------------------------------------------------------------

  if (loading) {
    return (
      <div className="ds-loading flex items-center justify-center py-24 text-sm text-gray-500">
        Loading the review bench…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5" style={{ height: "calc(100vh - 8.5rem)" }}>
      {/* toolbar ---------------------------------------------------------- */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1 rounded-xl border border-white/[0.07] bg-white/[0.02] p-1">
          {QUEUES.map((q) => (
            <button
              key={q.key}
              onClick={() => { setQueue(q.key); }}
              className={`flex items-center gap-2 rounded-lg px-3.5 py-2 text-[14px] transition-colors ${
                queue === q.key
                  ? "bg-indigo-500/15 text-indigo-300 font-semibold"
                  : "text-gray-400 hover:text-gray-200"
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${q.dot}`} />
              {q.label}
              <span className="font-mono text-[11px] tabular-nums opacity-70">
                {counts[q.key === "comments" ? "comments" : q.key]}
              </span>
            </button>
          ))}
        </div>

        <input
          className="ds-input flex-1 min-w-[220px]"
          placeholder="Search testcases, tickets, code, comments"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        <button
          className="ds-btn-secondary"
          onClick={() => { setNameDraft(reviewer); setAskName(true); }}
          title="Everything you sign off or comment on is attributed to this name"
        >
          <span className={`h-1.5 w-1.5 rounded-full ${reviewer ? "bg-emerald-400" : "bg-gray-600"}`} />
          {reviewer || "Set your name"}
        </button>
      </div>

      {/* ticket chips + progress ------------------------------------------ */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => setDtFilter(null)}
          className={`rounded-lg border px-2.5 py-1 font-mono text-[11px] transition-colors ${
            !dtFilter
              ? "border-indigo-500/40 bg-indigo-500/10 text-indigo-300"
              : "border-white/[0.07] text-gray-500 hover:text-gray-300"
          }`}
        >
          All tickets
        </button>
        {tickets.map((t) => (
          <span key={t.dt} className="inline-flex items-center">
            <button
              onClick={() => setDtFilter(dtFilter === t.dt ? null : t.dt)}
              className={`rounded-l-lg border border-r-0 px-2.5 py-1 font-mono text-[11px] transition-colors ${
                dtFilter === t.dt
                  ? "border-indigo-500/40 bg-indigo-500/10 text-indigo-300"
                  : "border-white/[0.07] text-gray-500 hover:text-gray-300"
              }`}
            >
              {t.dt}
              <span className="ml-2 opacity-70">{t.pending}/{t.n}</span>
            </button>
            <a
              href={t.url}
              target="_blank"
              rel="noopener noreferrer"
              title={`Open ${t.dt} in Jira`}
              className={`rounded-r-lg border px-2 py-1 text-[11px] transition-colors ${
                dtFilter === t.dt
                  ? "border-indigo-500/40 bg-indigo-500/10 text-indigo-300"
                  : "border-white/[0.07] text-gray-600 hover:text-indigo-300"
              }`}
            >
              <IconExternal />
            </a>
          </span>
        ))}
        <span className="ml-auto flex items-center gap-3">
          <span className="h-1.5 w-28 overflow-hidden rounded-full bg-white/[0.07]">
            <span
              className="block h-full rounded-full bg-emerald-500 transition-all duration-500"
              style={{ width: `${counts.all ? (counts.reviewed / counts.all) * 100 : 0}%` }}
            />
          </span>
          <span className="font-mono text-[11px] tabular-nums text-gray-500">
            {counts.reviewed} of {counts.all} reviewed
          </span>
        </span>
      </div>

      {error && (
        <div className="ds-card border-amber-500/25 px-4 py-3 text-[13px] text-amber-300">
          {error}
        </div>
      )}

      {/* two panes -------------------------------------------------------- */}
      <div className="grid min-h-0 flex-1 gap-5 lg:grid-cols-[352px_minmax(0,1fr)]">
        {/* queue */}
        <div className="ds-card flex min-h-0 flex-col overflow-hidden">
          <div className="ds-card-header flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
              {QUEUES.find((q) => q.key === queue)?.label}
              {dtFilter ? ` · ${dtFilter}` : ""}
            </span>
            <span className="font-mono text-[11px] tabular-nums text-gray-600">{visible.length}</span>
          </div>
          <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
            {visible.length === 0 ? (
              <div className="px-6 py-16 text-center text-[14.5px] leading-relaxed text-gray-600">
                {query
                  ? `Nothing matches “${query}” here.`
                  : queue === "pending"
                  ? "Every testcase in view has been reviewed."
                  : queue === "comments"
                  ? "Nothing is waiting on a change or an answer."
                  : queue === "reviewed"
                  ? "Nothing has been signed off yet."
                  : "No testcases have been pushed yet."}
              </div>
            ) : (
              visible.map((t, i) => {
                const first = i === 0 || visible[i - 1].dt !== t.dt;
                const nOpen = openOf(t);
                const active = t.tc_key === sel;
                return (
                  <div key={t.tc_key}>
                    {first && (
                      <div className="sticky top-0 z-10 flex items-center gap-2 border-y border-white/[0.055] bg-[#171a24]/95 px-5 py-2.5 backdrop-blur">
                        <span className="font-mono text-[12px] font-semibold text-gray-400">{t.dt}</span>
                        <span className="h-px flex-1 bg-white/[0.06]" />
                        <span className="font-mono text-[10px] tabular-nums text-gray-600">
                          {visible.filter((x) => x.dt === t.dt).length}
                        </span>
                      </div>
                    )}
                    <button
                      onClick={() => { setSel(t.tc_key); detailRef.current?.scrollTo({ top: 0 }); }}
                      className={`relative block w-full border-b border-white/[0.05] px-5 py-4 text-left transition-colors ${
                        active ? "bg-indigo-500/10" : "hover:bg-white/[0.025]"
                      }`}
                    >
                      {active && <span className="absolute inset-y-0 left-0 w-0.5 bg-indigo-400" />}
                      <span className="mb-1.5 flex items-center gap-2.5">
                        <span
                          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                            t.review_status === "reviewed" ? "bg-emerald-400" : "bg-amber-400"
                          }`}
                        />
                        <span className={`font-mono text-[14px] font-semibold ${active ? "text-indigo-300" : "text-gray-200"}`}>
                          {t.tc_id}
                        </span>
                        <span className="h-px flex-1" />
                        {nOpen > 0 && (
                          <span className="rounded bg-indigo-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-indigo-300">
                            {nOpen}
                          </span>
                        )}
                        {t.flag && (
                          <span className="rounded bg-rose-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-rose-300">
                            !
                          </span>
                        )}
                      </span>
                      <span className="line-clamp-2 block text-[13.5px] leading-relaxed text-gray-500">
                        {t.tc_summary}
                      </span>
                    </button>
                  </div>
                );
              })
            )}
          </div>
          <div className="flex flex-wrap gap-3 border-t border-white/[0.055] px-4 py-2 font-mono text-[10px] text-gray-600">
            <span><b className="text-gray-400">J</b>/<b className="text-gray-400">K</b> move</span>
            <span><b className="text-gray-400">R</b> review</span>
            <span><b className="text-gray-400">C</b> comment</span>
          </div>
        </div>

        {/* detail */}
        {current ? (
          <div className="flex min-h-0 flex-col gap-5">
            {/* sticky action bar */}
            <div className="ds-card flex flex-wrap items-center gap-4 px-6 py-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2.5">
                  <span className="font-mono text-[18px] font-semibold text-gray-100">{current.tc_id}</span>
                  <span className={`ds-badge ${current.review_status === "reviewed" ? "ds-badge-success" : "ds-badge-warning"}`}>
                    {current.review_status === "reviewed" ? "Reviewed" : "Needs review"}
                  </span>
                  {openOf(current) > 0 && (
                    <span className="ds-badge ds-badge-info">{openOf(current)} open</span>
                  )}
                  {current.flag && (
                    <span className="ds-badge ds-badge-error">{current.flag.split(" — ")[0]}</span>
                  )}
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-2.5 text-[12.5px] text-gray-600">
                  <a
                    href={current.dt_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 font-mono font-semibold text-indigo-400 hover:underline"
                  >
                    {current.dt}
                    <IconExternal />
                  </a>
                  <span>·</span><span>{current.component}</span>
                  <span>·</span><span>{current.fix_version}</span>
                  <span>·</span><span className="tabular-nums">{idx + 1} of {visible.length}</span>
                </div>
              </div>
              <div className="ml-auto flex items-center gap-2">
                <div className="flex overflow-hidden rounded-lg border border-white/[0.08]">
                  <button
                    onClick={() => move(-1)}
                    disabled={idx <= 0}
                    className="px-2.5 py-1.5 text-gray-500 transition-colors hover:text-indigo-300 disabled:opacity-30"
                    aria-label="Previous testcase"
                  ><IconUp /></button>
                  <button
                    onClick={() => move(1)}
                    disabled={idx >= visible.length - 1}
                    className="border-l border-white/[0.08] px-2.5 py-1.5 text-gray-500 transition-colors hover:text-indigo-300 disabled:opacity-30"
                    aria-label="Next testcase"
                  ><IconDown /></button>
                </div>
                <button
                  className="ds-btn-secondary"
                  onClick={() => { composerRef.current?.scrollIntoView({ block: "center" }); composerRef.current?.focus(); }}
                >
                  Comment
                </button>
                {current.review_status === "reviewed" ? (
                  <button className="ds-btn-secondary" onClick={() => setStatus(current, "pending")}>
                    Undo review
                  </button>
                ) : (
                  <button className="ds-btn-primary" onClick={() => setStatus(current, "reviewed")}>
                    Mark reviewed
                  </button>
                )}
              </div>
            </div>

            {/* scrolling detail body */}
            <div ref={detailRef} className="main-content flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto pr-2">
              {/* ticket */}
              <section className="ds-card">
                <div className="ds-card-header flex items-center justify-between">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Ticket</span>
                  <a
                    href={current.dt_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-[12px] font-semibold text-indigo-400 hover:underline"
                  >
                    {current.dt}
                    <IconExternal />
                  </a>
                </div>
                <div className="p-7">
                  <h2 className="mb-4 max-w-[62ch] text-[19px] font-semibold leading-snug text-gray-100">
                    {current.dt_summary}
                  </h2>
                  <div className="mb-5 flex flex-wrap gap-2">
                    {[
                      ["Component", current.component],
                      ["Fix version", current.fix_version],
                      ["Priority", current.priority],
                      ["Jira", current.jira_status],
                      ["Service", current.service],
                    ].filter(([, v]) => v).map(([k, v]) => (
                      <span key={k} className="rounded-md border border-white/[0.07] bg-white/[0.02] px-3 py-1.5 font-mono text-[11.5px] text-gray-400">
                        <span className="mr-2 uppercase tracking-wider text-gray-600">{k}</span>{v}
                      </span>
                    ))}
                  </div>
                  <button
                    onClick={() => setOpenWhy((p) => ({ ...p, [current.dt]: !p[current.dt] }))}
                    className="flex items-center gap-2.5 text-[13px] text-gray-500 transition-colors hover:text-indigo-300"
                    aria-expanded={!!openWhy[current.dt]}
                  >
                    <IconChevron open={!!openWhy[current.dt]} />
                    {openWhy[current.dt] ? "Hide why this ticket exists" : "Why this ticket exists"}
                  </button>
                  {openWhy[current.dt] && (
                    <p className="mt-4 max-w-[68ch] border-t border-white/[0.06] pt-4 text-[15px] leading-[1.75] text-gray-400">
                      {current.dt_description}
                    </p>
                  )}
                </div>
              </section>

              {/* what it does */}
              <section className="ds-card">
                <div className="ds-card-header">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                    What this testcase does
                  </span>
                </div>
                <div className="p-7">
                  <p className="max-w-[72ch] text-[15.5px] leading-[1.7] text-gray-300">{current.tc_summary}</p>
                  <div className="mt-4 grid gap-px overflow-hidden rounded-xl border border-white/[0.07] bg-white/[0.07] sm:grid-cols-2">
                    <Meta label="Testcase file" value={current.tc_file} title={current.tc_path}
                          onCopy={() => { navigator.clipboard?.writeText(current.tc_path); note("info", "Path copied"); }} />
                    <Meta label="Test report" value={current.report_url ?? "not linked yet"}
                          muted={!current.report_url}
                          href={current.report_url && /^https?:\/\//.test(current.report_url) ? current.report_url : undefined} />
                    <Meta label="Pushed" value={fmtDate(current.pushed_at)} />
                    {current.flag && (
                      <div className="bg-[#1a1d28] p-3.5 sm:col-span-2">
                        <div className="mb-1.5 font-mono text-[9px] uppercase tracking-widest text-gray-600">Flag</div>
                        <div className="text-[12px] leading-relaxed text-rose-300">{current.flag}</div>
                      </div>
                    )}
                  </div>
                </div>
              </section>

              {/* source */}
              <section className="ds-card overflow-hidden">
                <div className="ds-card-header flex items-center justify-between">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                    Testcase source
                  </span>
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-[10px] uppercase tracking-wider text-gray-600">
                      {current.source ? `${current.source.split("\n").length} lines` : "not pushed"}
                    </span>
                    {current.source && (
                      <>
                        <button
                          className="rounded border border-white/[0.08] px-2 py-1 font-mono text-[9px] uppercase tracking-wider text-gray-500 transition-colors hover:border-indigo-500/40 hover:text-indigo-300"
                          onClick={() => { navigator.clipboard?.writeText(current.source); note("info", "File copied"); }}
                        >
                          Copy file
                        </button>
                        <button
                          className="font-mono text-[9px] uppercase tracking-wider text-gray-500 transition-colors hover:text-indigo-300"
                          onClick={() => setFoldSrc((p) => ({ ...p, [current.tc_key]: !p[current.tc_key] }))}
                        >
                          {foldSrc[current.tc_key] ? "Expand" : "Collapse"}
                        </button>
                      </>
                    )}
                  </div>
                </div>
                {!foldSrc[current.tc_key] && (
                  current.source ? (
                    <div className="scrollbar-thin max-h-[60vh] overflow-auto bg-[#0d0f16]">
                      <div className="flex min-w-min items-start font-mono text-[13px] leading-[1.75]">
                        <div className="sticky left-0 z-10 shrink-0 select-none whitespace-pre border-r border-white/[0.06] bg-[#0b0d13] px-4 py-5 text-right text-gray-700 tabular-nums">
                          {current.source.split("\n").map((_, i) => i + 1).join("\n")}
                        </div>
                        <div
                          className="whitespace-pre px-6 py-5 text-gray-300"
                          dangerouslySetInnerHTML={{ __html: highlight(current.source) }}
                        />
                      </div>
                    </div>
                  ) : (
                    <div className="p-6 text-[13px] text-gray-600">
                      The file was not included in this push, so there is nothing to show yet.
                    </div>
                  )
                )}
              </section>

              {/* discussion */}
              <section className="ds-card">
                <div className="ds-card-header flex items-center gap-3">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Discussion</span>
                  <span className="font-mono text-[10px] uppercase tracking-wider text-gray-600">
                    {current.comments.length
                      ? `${current.comments.length} comment${current.comments.length === 1 ? "" : "s"}`
                      : "none yet"}
                  </span>
                  <span className="h-px flex-1 bg-white/[0.05]" />
                  {current.comments.some((c) => c.resolved) && (
                    <button
                      className="font-mono text-[9.5px] uppercase tracking-wider text-gray-500 hover:text-indigo-300"
                      onClick={() => setShowResolved((p) => ({ ...p, [current.tc_key]: !p[current.tc_key] }))}
                    >
                      {showResolved[current.tc_key] ? "Hide" : "Show"}{" "}
                      {current.comments.filter((c) => c.resolved).length} resolved
                    </button>
                  )}
                </div>
                <div className="p-7">
                  {current.comments.length === 0 && (
                    <p className="mb-6 max-w-[60ch] text-[15px] leading-[1.7] text-gray-500">
                      No comments yet. If something needs changing before this testcase ships, or
                      you have a question about how it works, write it below — everyone reviewing
                      will see it.
                    </p>
                  )}

                  {current.comments
                    .filter((c) => !c.resolved || showResolved[current.tc_key])
                    .map((c) => (
                      <div
                        key={c.id}
                        className={`border-b border-white/[0.05] py-5 first:pt-0 last:border-0 ${c.resolved ? "opacity-60" : ""}`}
                      >
                        <div className="mb-2 flex flex-wrap items-center gap-2.5">
                          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-indigo-500/15 text-[11px] font-semibold text-indigo-300">
                            {initials(c.author)}
                          </span>
                          <span className="text-[14.5px] font-semibold text-gray-200">{c.author || "Someone"}</span>
                          <span className={`ds-badge ${
                            c.kind === "change" ? "ds-badge-error"
                            : c.kind === "question" ? "ds-badge-info"
                            : "ds-badge-neutral"}`}>
                            {KINDS.find((k) => k.key === c.kind)?.label ?? "Note"}
                          </span>
                          <span className="font-mono text-[10.5px] tabular-nums text-gray-600">
                            {fmtWhen(c.created_at)}
                          </span>
                        </div>
                        <div className="max-w-[68ch] whitespace-pre-wrap pl-[38px] text-[15.5px] leading-[1.75] text-gray-300">
                          {c.body}
                        </div>
                        <div className="mt-2.5 flex flex-wrap items-center gap-4 pl-[34px]">
                          <button
                            className="text-[12.5px] text-gray-500 transition-colors hover:text-indigo-300"
                            onClick={() => resolveComment(c, !c.resolved)}
                          >
                            {c.resolved ? "Reopen" : "Mark resolved"}
                          </button>
                          {reviewer && c.author === reviewer && (
                            <button
                              className="text-[12.5px] text-gray-500 transition-colors hover:text-rose-400"
                              onClick={() => (confirmDel === c.id ? removeComment(c) : setConfirmDel(c.id))}
                            >
                              {confirmDel === c.id ? "Really delete?" : "Delete"}
                            </button>
                          )}
                          {c.resolved && (
                            <span className="flex items-center gap-1.5 font-mono text-[11.5px] text-emerald-400">
                              <IconCheck />
                              resolved by {c.resolved_by ?? "someone"}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}

                  {/* composer — always on screen, never behind a tab or a button */}
                  <div className="mt-7 max-w-[72ch]">
                    <textarea
                      ref={composerRef}
                      className="ds-input min-h-[116px] w-full resize-y text-[15px] leading-[1.7]"
                      placeholder="What needs changing, or what do you want to ask about this testcase?"
                      value={drafts[current.tc_key] ?? ""}
                      onChange={(e) => setDrafts((p) => ({ ...p, [current.tc_key]: e.target.value }))}
                    />
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                      <div className="flex gap-1.5">
                        {KINDS.map((k) => {
                          const on = (kinds[current.tc_key] ?? "change") === k.key;
                          return (
                            <button
                              key={k.key}
                              onClick={() => setKinds((p) => ({ ...p, [current.tc_key]: k.key }))}
                              className={`rounded-md border px-2.5 py-1.5 font-mono text-[9.5px] uppercase tracking-wider transition-colors ${
                                on
                                  ? "border-indigo-500/50 bg-indigo-500/10 font-semibold text-indigo-300"
                                  : "border-white/[0.08] text-gray-500 hover:text-gray-300"
                              }`}
                            >
                              {k.label}
                            </button>
                          );
                        })}
                      </div>
                      <div className="flex items-center gap-2.5">
                        <span className="hidden font-mono text-[11px] text-gray-600 sm:inline">
                          Ctrl+Enter to post
                        </span>
                        <button
                          className="ds-btn-secondary"
                          onClick={() => setDrafts((p) => ({ ...p, [current.tc_key]: "" }))}
                        >
                          Clear
                        </button>
                        <button className="ds-btn-primary" onClick={() => postComment(current)}>
                          Post comment
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </section>
            </div>
          </div>
        ) : (
          <div className="ds-empty">
            <div className="ds-empty-title">Nothing to review</div>
            <div className="ds-empty-hint">
              Generated testcases appear here once they are pushed to the bench.
            </div>
          </div>
        )}
      </div>

      {/* name dialog ------------------------------------------------------ */}
      {askName && (
        <div className="ds-modal-overlay" onClick={() => setAskName(false)}>
          <div className="ds-modal max-w-[420px] p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-2 text-[16px] font-semibold text-gray-100">Who is reviewing?</h3>
            <p className="mb-4 text-[13px] leading-relaxed text-gray-400">
              Your name is attached to everything you mark reviewed or comment on, so the
              rest of the team can see who signed off.
            </p>
            <input
              autoFocus
              className="ds-input w-full"
              placeholder="e.g. S. Girishankar"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && saveName()}
            />
            <div className="mt-4 flex justify-end gap-2">
              <button className="ds-btn-secondary" onClick={() => setAskName(false)}>Cancel</button>
              <button className="ds-btn-primary" onClick={saveName}>Save</button>
            </div>
          </div>
        </div>
      )}

      {/* toasts — top centre, gone in under two seconds ------------------- */}
      <div className="pointer-events-none fixed left-1/2 top-4 z-[200] flex -translate-x-1/2 flex-col items-center gap-2">
        {notes.map((n) => (
          <div
            key={n.id}
            className={`toast ${n.kind === "success" ? "toast-success" : n.kind === "error" ? "toast-error" : "toast-info"} ${n.exiting ? "toast-exit" : ""}`}
            style={{ animation: n.exiting ? undefined : "fadeIn var(--dur-fast) var(--ease)" }}
          >
            {n.text}
          </div>
        ))}
      </div>
    </div>
  );
}

function Meta({
  label, value, title, href, muted, onCopy,
}: {
  label: string; value: string; title?: string; href?: string; muted?: boolean; onCopy?: () => void;
}) {
  return (
    <div className="bg-[#1a1d28] p-3.5">
      <div className="mb-1.5 font-mono text-[9px] uppercase tracking-widest text-gray-600">{label}</div>
      <div className="flex items-center gap-2.5 font-mono text-[11.5px]">
        {href ? (
          <a href={href} target="_blank" rel="noopener noreferrer" className="truncate text-indigo-400 hover:underline">
            {value}
          </a>
        ) : (
          <span className={`truncate ${muted ? "italic text-gray-600" : "text-gray-400"}`} title={title}>
            {value}
          </span>
        )}
        {onCopy && (
          <button
            onClick={onCopy}
            className="shrink-0 rounded border border-white/[0.08] px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-gray-500 transition-colors hover:border-indigo-500/40 hover:text-indigo-300"
          >
            Copy
          </button>
        )}
      </div>
    </div>
  );
}
