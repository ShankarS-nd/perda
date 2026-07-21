"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import ScriptRunner from "@/components/ScriptRunner";
import RunHistory from "@/components/RunHistory";
import WorkflowBuilder from "@/components/WorkflowBuilder";
import WorkflowExecution from "@/components/WorkflowExecution";
import TestReportDashboard from "@/components/TestReportDashboard";
import ConfidenceDashboard from "@/components/ConfidenceDashboard";
import TCAnalysis from "@/components/TCAnalysis";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ScriptArg {
  name: string;
  type: "string" | "int" | "float" | "bool";
  description: string;
  default: string;
  required: boolean;
  positional: boolean;
}

interface ScriptInfo {
  name: string;
  description: string;
  args: ScriptArg[];
  cwd: string;
  outputs_dir: string;
}

type Page =
  | "scripts"
  | "test-report"
  | "confidence"
  | "tc-analysis"
  | "history"
  | "workflows"
  | "workflow-runs";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://172.16.23.15:8000";

// ---------------------------------------------------------------------------
// Page metadata for breadcrumbs, search, and labels
// ---------------------------------------------------------------------------

interface PageMeta {
  key: Page;
  label: string;
  shortcut?: string;
  icon: () => JSX.Element;
  section?: string;
}

const PAGE_META: PageMeta[] = [
  { key: "scripts", label: "Scripts", shortcut: "1", icon: ScriptsIcon, section: "Core" },
  { key: "test-report", label: "Test Report Summary", shortcut: "2", icon: TestReportIcon, section: "Core" },
  { key: "confidence", label: "TC Confidence", shortcut: "3", icon: ConfidenceIcon, section: "Core" },
  { key: "tc-analysis", label: "TC Analysis", shortcut: "4", icon: TCAnalysisIcon, section: "Core" },
  { key: "history", label: "History", shortcut: "5", icon: HistoryIcon, section: "Core" },
  { key: "workflows", label: "Workflow Builder", shortcut: "6", icon: WorkflowIcon, section: "Workflows" },
  { key: "workflow-runs", label: "Workflow Runs", shortcut: "7", icon: WorkflowRunsIcon, section: "Workflows" },
];

// ---------------------------------------------------------------------------
// Toast helpers
// ---------------------------------------------------------------------------

interface Toast {
  id: number;
  type: "success" | "error" | "info";
  message: string;
  exiting?: boolean;
}

let toastIdCounter = 0;

// ---------------------------------------------------------------------------
// Root page
// ---------------------------------------------------------------------------

export default function Home() {
  const [activePage, setActivePage] = useState<Page>("scripts");
  const [scripts, setScripts] = useState<ScriptInfo[]>([]);
  const [selectedScript, setSelectedScript] = useState<ScriptInfo | null>(null);
  const [scriptsExpanded, setScriptsExpanded] = useState(true);
  const [fetchingScripts, setFetchingScripts] = useState(true);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [cmdOpen, setCmdOpen] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [backendStatus, setBackendStatus] = useState<"connected" | "disconnected" | "checking">("checking");

  const prevPage = useRef<Page>("scripts");

  // Toast helpers
  const addToast = useCallback((type: Toast["type"], message: string) => {
    const id = ++toastIdCounter;
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts((prev) =>
        prev.map((t) => (t.id === id ? { ...t, exiting: true } : t))
      );
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 300);
    }, 3500);
  }, []);

  // Theme initialiser
  useEffect(() => {
    const saved = localStorage.getItem("perda-theme");
    if (saved === "light") setTheme("light");
  }, []);

  const toggleTheme = useCallback(() => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    localStorage.setItem("perda-theme", next);
    document.documentElement.classList.toggle("dark", next === "dark");
    document.documentElement.classList.toggle("light", next === "light");
  }, [theme]);

  // Check backend health
  useEffect(() => {
    const check = async () => {
      try {
        const res = await fetch(`${API_BASE}/scripts`, { signal: AbortSignal.timeout(3000) });
        setBackendStatus(res.ok ? "connected" : "disconnected");
      } catch {
        setBackendStatus("disconnected");
      }
    };
    check();
    const interval = setInterval(check, 30000);
    return () => clearInterval(interval);
  }, []);

  // Fetch scripts once on mount
  useEffect(() => {
    (async () => {
      setFetchingScripts(true);
      try {
        const res = await fetch(`${API_BASE}/scripts`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: ScriptInfo[] = await res.json();
        setScripts(data);
        if (data.length > 0) setSelectedScript(data[0]);
      } catch {
        // handled in ScriptRunner
      } finally {
        setFetchingScripts(false);
      }
    })();
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Cmd/Ctrl + K — command palette
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setCmdOpen((p) => !p);
        return;
      }
      // Alt + number — quick switch pages
      if (e.altKey && !e.metaKey && !e.ctrlKey) {
        const num = parseInt(e.key);
        if (num >= 1 && num <= PAGE_META.length) {
          e.preventDefault();
          const target = PAGE_META[num - 1];
          navigateTo(target.key);
        }
      }
      // Escape closes palette
      if (e.key === "Escape" && cmdOpen) {
        setCmdOpen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cmdOpen]);

  const navigateTo = useCallback(
    (page: Page) => {
      prevPage.current = activePage;
      setActivePage(page);
      setCmdOpen(false);
    },
    [activePage]
  );

  const handleScriptClick = useCallback(
    (script: ScriptInfo) => {
      setSelectedScript(script);
      setActivePage("scripts");
    },
    []
  );

  const handleScriptsNav = () => {
    setActivePage("scripts");
    setScriptsExpanded((prev) => (activePage === "scripts" ? !prev : true));
  };

  const activePageMeta = PAGE_META.find((p) => p.key === activePage);

  // Sidebar width
  const SIDEBAR_FULL = 268;
  const SIDEBAR_MINI = 60;

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-transparent">
      <div className="ambient-bg" />
      
      <div className="flex h-full w-full p-3 sm:p-5 gap-3 sm:gap-5 relative z-10">
        {/* ---------------------------------------------------------------- */}
        {/* Sidebar                                                          */}
        {/* ---------------------------------------------------------------- */}
        <motion.aside
          initial={false}
          animate={{ width: sidebarCollapsed ? SIDEBAR_MINI : SIDEBAR_FULL }}
          transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
          className={`shrink-0 sidebar-glass rounded-2xl flex flex-col overflow-hidden ${
            sidebarCollapsed ? "sidebar-mini" : ""
          }`}
        >
        {/* Brand */}
        <div className="px-4 py-4 border-b border-white/[0.06]">
          <div className="flex items-center gap-3 justify-between">
            <div className="flex items-center gap-3 min-w-0">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-gradient-to-br from-accent-cyan/20 to-accent-violet/20 border border-accent-cyan/10 shadow-[0_0_12px_rgba(6,182,212,0.15)]">
                <svg
                  className="h-4 w-4 text-accent-cyan"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5"
                  />
                </svg>
              </div>
              {!sidebarCollapsed && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="min-w-0"
                >
                  <h1 className="text-[16px] font-display font-bold tracking-tight text-white truncate">
                    Perda
                  </h1>
                  <p className="text-[10px] text-gray-500 truncate">
                    Automation Platform
                  </p>
                </motion.div>
              )}
            </div>
            <button
              onClick={() => setSidebarCollapsed((p) => !p)}
              className="text-gray-600 hover:text-gray-300 transition-colors p-1.5 rounded-lg hover:bg-white/[0.06] shrink-0"
              title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              <motion.svg
                className="h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
                animate={{ rotate: sidebarCollapsed ? 180 : 0 }}
                transition={{ duration: 0.3 }}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M18.75 19.5l-7.5-7.5 7.5-7.5m-6 15L5.25 12l7.5-7.5"
                />
              </motion.svg>
            </button>
          </div>
        </div>

        {/* Search trigger */}
        {!sidebarCollapsed && (
          <div className="px-3 pt-3 pb-1">
            <button
              onClick={() => setCmdOpen(true)}
              className="flex items-center gap-2 w-full px-3 py-2 rounded-[10px] border border-white/[0.06] bg-white/[0.02] text-gray-500 text-xs hover:bg-white/[0.04] hover:border-white/[0.1] transition-all"
            >
              <svg
                className="h-3.5 w-3.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"
                />
              </svg>
              <span className="flex-1 text-left">Search…</span>
              <span className="kbd">⌘K</span>
            </button>
          </div>
        )}

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto px-2 py-2 space-y-0.5">
          {/* Scripts Section */}
          <SidebarItem
            label="Scripts"
            icon={<ScriptsIcon />}
            active={activePage === "scripts"}
            onClick={handleScriptsNav}
            hasChevron={!sidebarCollapsed}
            expanded={activePage === "scripts" && scriptsExpanded}
            collapsed={sidebarCollapsed}
            shortcut="⌥1"
          />

          {/* Script List (collapsible) */}
          {!sidebarCollapsed && (
            <AnimatePresence>
              {activePage === "scripts" && scriptsExpanded && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
                  className="overflow-hidden"
                >
                  <div className="ml-2 pl-3 border-l border-white/[0.06] py-1 space-y-0.5">
                    {fetchingScripts ? (
                      <div className="flex items-center gap-2 px-3 py-2">
                        <SmallSpinner />
                        <span className="text-xs text-gray-500">Loading…</span>
                      </div>
                    ) : scripts.length === 0 ? (
                      <p className="px-3 py-2 text-xs text-gray-600">
                        No scripts found
                      </p>
                    ) : (
                      scripts.map((s, i) => (
                        <motion.button
                          key={s.name}
                          initial={{ opacity: 0, x: -8 }}
                          animate={{ opacity: 1, x: 0 }}
                          transition={{ delay: i * 0.03, duration: 0.2 }}
                          onClick={() => handleScriptClick(s)}
                          className={`group flex items-center gap-2.5 w-full text-left px-3 py-2 rounded-[10px] text-[13px] font-medium transition-all duration-150 ripple-container ${
                            selectedScript?.name === s.name
                              ? "bg-accent-violet/10 text-accent-violet border border-accent-violet/10 shadow-[0_0_8px_rgba(139,92,246,0.1)]"
                              : "text-gray-400 hover:bg-white/[0.04] hover:text-gray-200 border border-transparent hover-scale"
                          }`}
                        >
                          <span
                            className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-[10px] font-bold uppercase transition-colors ${
                              selectedScript?.name === s.name
                                ? "bg-accent-violet/20 text-accent-violet"
                                : "bg-white/[0.06] text-gray-500 group-hover:bg-white/[0.08] group-hover:text-gray-400"
                            }`}
                          >
                            {s.name.replace(".py", "").charAt(0)}
                          </span>
                          <div className="min-w-0 flex-1">
                            <span className="block truncate">
                              {s.name.replace(".py", "").replace(/_/g, " ")}
                            </span>
                            {s.description && (
                              <span className="block truncate text-[10px] text-gray-600 mt-0.5 leading-tight">
                                {s.description.length > 40
                                  ? s.description.slice(0, 40) + "…"
                                  : s.description}
                              </span>
                            )}
                          </div>
                          {selectedScript?.name === s.name && (
                            <span className="h-1.5 w-1.5 rounded-full bg-indigo-400 shrink-0 animate-pulse" />
                          )}
                        </motion.button>
                      ))
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          )}

          {/* Test Report Summary */}
          <SidebarItem
            label="Test Report Summary"
            icon={<TestReportIcon />}
            active={activePage === "test-report"}
            onClick={() => navigateTo("test-report")}
            collapsed={sidebarCollapsed}
            shortcut="⌥2"
          />

          {/* Test Case Confidence */}
          <SidebarItem
            label="TC Confidence"
            icon={<ConfidenceIcon />}
            active={activePage === "confidence"}
            onClick={() => navigateTo("confidence")}
            collapsed={sidebarCollapsed}
            shortcut="⌥3"
          />

          {/* TC Analysis */}
          <SidebarItem
            label="TC Analysis"
            icon={<TCAnalysisIcon />}
            active={activePage === "tc-analysis"}
            onClick={() => navigateTo("tc-analysis")}
            collapsed={sidebarCollapsed}
            shortcut="⌥4"
          />

          {/* History */}
          <SidebarItem
            label="History"
            icon={<HistoryIcon />}
            active={activePage === "history"}
            onClick={() => navigateTo("history")}
            collapsed={sidebarCollapsed}
            shortcut="⌥5"
          />

          {/* Workflows section */}
          <div className="pt-4 mt-3 border-t border-white/[0.04]">
            {!sidebarCollapsed && (
              <p className="sidebar-section-label px-3 mb-2 text-[10px] font-semibold uppercase tracking-widest text-gray-600">
                Workflows
              </p>
            )}
            <SidebarItem
              label="Builder"
              icon={<WorkflowIcon />}
              active={activePage === "workflows"}
              onClick={() => navigateTo("workflows")}
              collapsed={sidebarCollapsed}
              shortcut="⌥6"
            />
            <SidebarItem
              label="Runs"
              icon={<WorkflowRunsIcon />}
              active={activePage === "workflow-runs"}
              onClick={() => navigateTo("workflow-runs")}
              collapsed={sidebarCollapsed}
              shortcut="⌥7"
            />
          </div>

          {/* AI (disabled) */}
          <div className="pt-3 mt-2">
            <SidebarItem
              label="AI Assistant"
              icon={<AiIcon />}
              disabled
              collapsed={sidebarCollapsed}
            />
          </div>
        </nav>

        {/* Footer */}
        <div className="px-3 py-3 border-t border-white/[0.04] flex items-center justify-between">
          {!sidebarCollapsed && (
            <span className="text-[10px] text-gray-500">v0.1.0</span>
          )}
          <div className={`flex items-center gap-2 ${sidebarCollapsed ? "mx-auto" : ""}`}>
            <button
              onClick={toggleTheme}
              className="p-1.5 rounded-lg hover:bg-white/[0.06] text-gray-400 hover:text-gray-200 transition-colors"
              title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
            >
              {theme === "dark" ? (
                <svg
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z"
                  />
                </svg>
              ) : (
                <svg
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z"
                  />
                </svg>
              )}
            </button>
            <div className="tooltip-wrapper">
              <span
                className={`flex h-2 w-2 rounded-full ${
                  backendStatus === "connected"
                    ? "bg-green-500/80 shadow-[0_0_8px_rgba(34,197,94,0.5)]"
                    : backendStatus === "checking"
                      ? "bg-yellow-500/80 animate-pulse shadow-[0_0_8px_rgba(234,179,8,0.5)]"
                      : "bg-red-500/80 shadow-[0_0_8px_rgba(239,68,68,0.5)]"
                }`}
                title="Backend status"
              />
              {sidebarCollapsed && (
                <span className="tooltip-text">
                  {backendStatus === "connected"
                    ? "Backend Connected"
                    : backendStatus === "checking"
                      ? "Checking…"
                      : "Backend Offline"}
                </span>
              )}
            </div>
          </div>
        </div>
      </motion.aside>

      {/* ---------------------------------------------------------------- */}
      {/* Main Panel                                                       */}
      {/* ---------------------------------------------------------------- */}
      <main className="flex-1 flex flex-col overflow-hidden main-glass rounded-2xl relative">
        {/* Top Header Bar */}
        <header className="top-header shrink-0 px-6 lg:px-8 flex items-center justify-between h-[60px] z-10 border-b border-white/[0.04]">
          <div className="flex items-center gap-3">
            {/* Breadcrumb */}
            <nav className="flex items-center gap-1.5 text-sm">
              <span className="text-gray-500">Perda</span>
              <svg
                className="h-3 w-3 text-gray-700"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M8.25 4.5l7.5 7.5-7.5 7.5"
                />
              </svg>
              <span className="text-gray-200 font-medium">
                {activePageMeta?.label ?? "Scripts"}
              </span>
            </nav>
          </div>

          <div className="flex items-center gap-3">
            {/* Command Palette trigger */}
            <button
              onClick={() => setCmdOpen(true)}
              className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-lg border border-white/[0.06] bg-white/[0.02] text-gray-500 text-xs hover:bg-white/[0.04] hover:border-white/[0.1] transition-all"
            >
              <svg
                className="h-3.5 w-3.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"
                />
              </svg>
              Quick Nav
              <span className="kbd">⌘K</span>
            </button>

            {/* Backend status pill */}
            <div
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border ${
                backendStatus === "connected"
                  ? "bg-green-500/[0.06] border-green-500/15 text-green-400"
                  : backendStatus === "checking"
                    ? "bg-yellow-500/[0.06] border-yellow-500/15 text-yellow-400"
                    : "bg-red-500/[0.06] border-red-500/15 text-red-400"
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  backendStatus === "connected"
                    ? "bg-green-400"
                    : backendStatus === "checking"
                      ? "bg-yellow-400 animate-pulse"
                      : "bg-red-400"
                }`}
              />
              {backendStatus === "connected"
                ? "Connected"
                : backendStatus === "checking"
                  ? "Checking"
                  : "Offline"}
            </div>
          </div>
        </header>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto main-content relative z-[1]">
          <AnimatePresence mode="wait">
            <motion.div
              key={activePage}
              initial={{ opacity: 0, y: 10, filter: "blur(4px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              exit={{ opacity: 0, y: -10, filter: "blur(4px)" }}
              transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
              className={`${
                activePage === "workflows" ? "p-4" : "p-6 lg:p-8 xl:p-10"
              }`}
            >
              {activePage === "scripts" && (
                <ScriptRunner
                  scripts={scripts}
                  selectedScript={selectedScript}
                  onSelectScript={setSelectedScript}
                />
              )}
              {activePage === "test-report" && <TestReportDashboard />}
              {activePage === "confidence" && <ConfidenceDashboard />}
              {activePage === "tc-analysis" && <TCAnalysis />}
              {activePage === "history" && <RunHistory />}
              {activePage === "workflows" && <WorkflowBuilder />}
              {activePage === "workflow-runs" && <WorkflowExecution />}
            </motion.div>
          </AnimatePresence>
        </div>
      </main>
      </div>


      {/* ---------------------------------------------------------------- */}
      {/* Command Palette Overlay                                          */}
      {/* ---------------------------------------------------------------- */}
      <AnimatePresence>
        {cmdOpen && (
          <CommandPalette
            pages={PAGE_META}
            scripts={scripts}
            activePage={activePage}
            onNavigate={navigateTo}
            onSelectScript={(s: ScriptInfo) => {
              setSelectedScript(s);
              navigateTo("scripts");
            }}
            onClose={() => setCmdOpen(false)}
          />
        )}
      </AnimatePresence>

      {/* ---------------------------------------------------------------- */}
      {/* Toast Notifications                                              */}
      {/* ---------------------------------------------------------------- */}
      <div className="toast-container">
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              initial={{ opacity: 0, x: 100, scale: 0.95 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 100, scale: 0.95 }}
              transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
              className={`toast toast-${t.type}`}
            >
              {t.type === "success" && <CheckCircleIcon />}
              {t.type === "error" && <XCircleIcon />}
              {t.type === "info" && <InfoCircleIcon />}
              <span className="text-gray-200">{t.message}</span>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Command Palette                                                            */
/* -------------------------------------------------------------------------- */

function CommandPalette({
  pages,
  scripts,
  activePage,
  onNavigate,
  onSelectScript,
  onClose,
}: {
  pages: PageMeta[];
  scripts: ScriptInfo[];
  activePage: Page;
  onNavigate: (p: Page) => void;
  onSelectScript: (s: ScriptInfo) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    const items: { type: "page" | "script"; label: string; sub: string; action: () => void }[] = [];

    // Pages
    pages.forEach((p) => {
      if (!q || p.label.toLowerCase().includes(q)) {
        items.push({
          type: "page",
          label: p.label,
          sub: p.section ?? "",
          action: () => onNavigate(p.key),
        });
      }
    });

    // Scripts (only if query)
    scripts.forEach((s) => {
      const name = s.name.replace(".py", "").replace(/_/g, " ");
      if (q && name.toLowerCase().includes(q)) {
        items.push({
          type: "script",
          label: name,
          sub: s.description?.slice(0, 50) ?? "Script",
          action: () => onSelectScript(s),
        });
      }
    });

    return items;
  }, [query, pages, scripts, onNavigate, onSelectScript]);

  // Reset active index when results change
  useEffect(() => {
    setActiveIndex(0);
  }, [filtered.length]);

  // Keyboard nav
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((p) => Math.min(p + 1, filtered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((p) => Math.max(p - 1, 0));
      } else if (e.key === "Enter" && filtered[activeIndex]) {
        e.preventDefault();
        filtered[activeIndex].action();
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [filtered, activeIndex, onClose]);

  // Autofocus
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      className="cmd-palette-overlay"
      onClick={(e: React.MouseEvent<HTMLDivElement>) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: -8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: -8 }}
        transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
        className="cmd-palette"
      >
        {/* Search input */}
        <div className="relative">
          <svg
            className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-500"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"
            />
          </svg>
          <input
            ref={inputRef}
            className="cmd-palette-input"
            placeholder="Search pages, scripts…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        {/* Results */}
        <div className="max-h-[320px] overflow-y-auto py-2">
          {filtered.length === 0 ? (
            <div className="px-6 py-8 text-center text-sm text-gray-500">
              No results for &ldquo;{query}&rdquo;
            </div>
          ) : (
            filtered.map((item, i) => (
              <div
                key={`${item.type}-${item.label}`}
                data-active={i === activeIndex ? "true" : undefined}
                className="cmd-palette-item"
                onClick={() => {
                  item.action();
                  onClose();
                }}
                onMouseEnter={() => setActiveIndex(i)}
              >
                <span
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-xs ${
                    item.type === "page"
                      ? "bg-indigo-500/10 text-indigo-400"
                      : "bg-violet-500/10 text-violet-400"
                  }`}
                >
                  {item.type === "page" ? (
                    <svg
                      className="h-3.5 w-3.5"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z"
                      />
                    </svg>
                  ) : (
                    <svg
                      className="h-3.5 w-3.5"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5"
                      />
                    </svg>
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-gray-200 truncate">
                    {item.label}
                  </p>
                  {item.sub && (
                    <p className="text-[11px] text-gray-500 truncate">
                      {item.sub}
                    </p>
                  )}
                </div>
                {item.type === "page" && (
                  <span className="kbd text-[10px]">
                    ⌥{pages.findIndex((p) => p.label === item.label) + 1}
                  </span>
                )}
              </div>
            ))
          )}
        </div>

        {/* Footer hints */}
        <div className="border-t border-white/[0.06] px-4 py-2.5 flex items-center gap-4 text-[11px] text-gray-500">
          <span className="flex items-center gap-1">
            <span className="kbd">↑</span>
            <span className="kbd">↓</span>
            Navigate
          </span>
          <span className="flex items-center gap-1">
            <span className="kbd">↵</span>
            Select
          </span>
          <span className="flex items-center gap-1">
            <span className="kbd">Esc</span>
            Close
          </span>
        </div>
      </motion.div>
    </motion.div>
  );
}

/* -------------------------------------------------------------------------- */
/* Sidebar helpers                                                            */
/* -------------------------------------------------------------------------- */

interface SidebarItemProps {
  label: string;
  icon?: React.ReactNode;
  active?: boolean;
  disabled?: boolean;
  hasChevron?: boolean;
  expanded?: boolean;
  collapsed?: boolean;
  shortcut?: string;
  onClick?: () => void;
}

function SidebarItem({
  label,
  icon,
  active = false,
  disabled = false,
  hasChevron = false,
  expanded = false,
  collapsed = false,
  shortcut,
  onClick,
}: SidebarItemProps) {
  const base =
    "sidebar-item-btn flex items-center gap-3 w-full text-left px-3 py-2.5 rounded-[10px] text-sm font-medium transition-all duration-200 ripple-container";
  const activeClass =
    "bg-indigo-500/10 text-indigo-300 border border-indigo-500/10 sidebar-active-glow";
  const defaultClass =
    "text-gray-400 hover:bg-white/[0.04] hover:text-gray-200 border border-transparent";
  const disabledClass =
    "text-gray-600 cursor-not-allowed border border-transparent";

  const content = (
    <button
      className={`${base} ${active ? activeClass : disabled ? disabledClass : defaultClass}`}
      disabled={disabled}
      onClick={onClick}
    >
      <span
        className={`sidebar-icon transition-colors shrink-0 ${
          active ? "text-indigo-400" : ""
        }`}
      >
        {icon}
      </span>
      {!collapsed && (
        <>
          <span className="sidebar-label flex-1 truncate">{label}</span>
          {disabled && (
            <span className="sidebar-badge text-[9px] uppercase tracking-wider text-gray-700 bg-white/[0.04] px-1.5 py-0.5 rounded">
              soon
            </span>
          )}
          {shortcut && !active && (
            <span className="sidebar-badge kbd opacity-0 group-hover:opacity-100 transition-opacity">
              {shortcut}
            </span>
          )}
          {hasChevron && (
            <motion.svg
              className="sidebar-chevron h-3.5 w-3.5 text-gray-600"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
              animate={{ rotate: expanded ? 90 : 0 }}
              transition={{ duration: 0.2 }}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M8.25 4.5l7.5 7.5-7.5 7.5"
              />
            </motion.svg>
          )}
        </>
      )}
    </button>
  );

  // When collapsed, wrap with tooltip
  if (collapsed) {
    return (
      <div className="tooltip-wrapper group">
        {content}
        <span className="tooltip-text">{label}</span>
      </div>
    );
  }

  return <div className="group">{content}</div>;
}

/* -------------------------------------------------------------------------- */
/* Spinner                                                                    */
/* -------------------------------------------------------------------------- */

function SmallSpinner() {
  return (
    <svg className="h-3 w-3 animate-spin" fill="none" viewBox="0 0 24 24">
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}

/* -------------------------------------------------------------------------- */
/* Icons                                                                      */
/* -------------------------------------------------------------------------- */

function ScriptsIcon() {
  return (
    <svg
      className="h-4 w-4 shrink-0"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5"
      />
    </svg>
  );
}

function HistoryIcon() {
  return (
    <svg
      className="h-4 w-4 shrink-0"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z"
      />
    </svg>
  );
}

function WorkflowIcon() {
  return (
    <svg
      className="h-4 w-4 shrink-0"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5"
      />
    </svg>
  );
}

function WorkflowRunsIcon() {
  return (
    <svg
      className="h-4 w-4 shrink-0"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5"
      />
    </svg>
  );
}

function TestReportIcon() {
  return (
    <svg
      className="h-4 w-4 shrink-0"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
      />
    </svg>
  );
}

function ConfidenceIcon() {
  return (
    <svg
      className="h-4 w-4 shrink-0"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z"
      />
    </svg>
  );
}

function TCAnalysisIcon() {
  return (
    <svg
      className="h-4 w-4 shrink-0"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m5.231 13.481L15 17.25m-4.5-15H5.625c-.621 0-1.125.504-1.125 1.125v16.5c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9zm3.75 11.625a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z"
      />
    </svg>
  );
}

function AiIcon() {
  return (
    <svg
      className="h-4 w-4 shrink-0"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456zM16.894 20.567L16.5 21.75l-.394-1.183a2.25 2.25 0 00-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 001.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 001.423 1.423l1.183.394-1.183.394a2.25 2.25 0 00-1.423 1.423z"
      />
    </svg>
  );
}

/* -------------------------------------------------------------------------- */
/* Toast Icons                                                                */
/* -------------------------------------------------------------------------- */

function CheckCircleIcon() {
  return (
    <svg
      className="h-4 w-4 text-green-400 shrink-0"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
      />
    </svg>
  );
}

function XCircleIcon() {
  return (
    <svg
      className="h-4 w-4 text-red-400 shrink-0"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9.75 9.75l4.5 4.5m0-4.5l-4.5 4.5M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
      />
    </svg>
  );
}

function InfoCircleIcon() {
  return (
    <svg
      className="h-4 w-4 text-indigo-400 shrink-0"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z"
      />
    </svg>
  );
}
