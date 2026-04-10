"use client";

import { useCallback, useEffect, useState } from "react";
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

type Page = "scripts" | "test-report" | "confidence" | "tc-analysis" | "history" | "workflows" | "workflow-runs";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://172.16.23.15:8000";

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
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');

  // Theme initialiser
  useEffect(() => {
    const saved = localStorage.getItem('perda-theme');
    if (saved === 'light') setTheme('light');
  }, []);

  const toggleTheme = useCallback(() => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    localStorage.setItem('perda-theme', next);
    document.documentElement.classList.toggle('dark', next === 'dark');
    document.documentElement.classList.toggle('light', next === 'light');
  }, [theme]);

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

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Floating sidebar toggle when collapsed */}
      {sidebarCollapsed && (
        <button
          onClick={() => setSidebarCollapsed(false)}
          className="fixed top-4 left-4 z-50 flex h-10 w-10 items-center justify-center rounded-xl bg-[#1a1d28] border border-white/[0.08] text-gray-400 hover:text-white hover:bg-[#22262f] transition-all shadow-lg"
          title="Open sidebar"
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
          </svg>
        </button>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* Sidebar                                                          */}
      {/* ---------------------------------------------------------------- */}
      <aside
        className="shrink-0 border-r border-white/[0.06] bg-[#0c0e14] sidebar-glass flex flex-col transition-all duration-300 overflow-hidden"
        style={{ width: sidebarCollapsed ? 0 : 268 }}
      >
        {/* Brand */}
        <div className="px-5 py-5 border-b border-white/[0.06]">
          <div className="flex items-center gap-3 justify-between">
            <div className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-gradient-to-br from-indigo-500/20 to-violet-500/20 border border-indigo-500/10">
              <svg className="h-4 w-4 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5" />
              </svg>
            </div>
            <div>
              <h1 className="text-sm font-semibold tracking-tight text-white">
                Developer Toolkit
              </h1>
              <p className="text-[10px] text-gray-500">Perda Automation Platform</p>
            </div>
          </div>
          <button
            onClick={() => setSidebarCollapsed(true)}
            className="text-gray-600 hover:text-gray-300 transition-colors p-1.5 rounded-lg hover:bg-white/[0.06] shrink-0"
            title="Collapse sidebar"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M18.75 19.5l-7.5-7.5 7.5-7.5m-6 15L5.25 12l7.5-7.5" />
            </svg>
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-0.5">
          {/* Scripts Section */}
          <SidebarItem
            label="Scripts"
            icon={<ScriptsIcon />}
            active={activePage === "scripts"}
            onClick={handleScriptsNav}
            hasChevron
            expanded={activePage === "scripts" && scriptsExpanded}
          />

          {/* Script List (collapsible) */}
          <div
            className={`overflow-hidden transition-all duration-300 ease-in-out ${
              activePage === "scripts" && scriptsExpanded
                ? "max-h-[500px] opacity-100"
                : "max-h-0 opacity-0"
            }`}
          >
            <div className="ml-2 pl-3 border-l border-white/[0.06] py-1 space-y-0.5">
              {fetchingScripts ? (
                <div className="flex items-center gap-2 px-3 py-2">
                  <SmallSpinner />
                  <span className="text-xs text-gray-500">Loading…</span>
                </div>
              ) : scripts.length === 0 ? (
                <p className="px-3 py-2 text-xs text-gray-600">No scripts found</p>
              ) : (
                scripts.map((s) => (
                  <button
                    key={s.name}
                    onClick={() => handleScriptClick(s)}
                    className={`group flex items-center gap-2.5 w-full text-left px-3 py-2 rounded-[10px] text-xs font-medium transition-all duration-150 ${
                      selectedScript?.name === s.name
                        ? "bg-indigo-500/10 text-indigo-300 border border-indigo-500/10"
                        : "text-gray-400 hover:bg-white/[0.04] hover:text-gray-200 border border-transparent"
                    }`}
                  >
                    <span
                      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-[10px] font-bold uppercase transition-colors ${
                        selectedScript?.name === s.name
                          ? "bg-indigo-500/20 text-indigo-400"
                          : "bg-white/[0.06] text-gray-500 group-hover:bg-white/[0.08] group-hover:text-gray-400"
                      }`}
                    >
                      {s.name.replace(".py", "").charAt(0)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <span className="block truncate">{s.name.replace(".py", "").replace(/_/g, " ")}</span>
                      {s.description && (
                        <span className="block truncate text-[10px] text-gray-600 mt-0.5 leading-tight">
                          {s.description.length > 40 ? s.description.slice(0, 40) + "…" : s.description}
                        </span>
                      )}
                    </div>
                    {selectedScript?.name === s.name && (
                      <span className="h-1.5 w-1.5 rounded-full bg-indigo-400 shrink-0 animate-pulse" />
                    )}
                  </button>
                ))
              )}
            </div>
          </div>

          {/* Test Report Summary — below scripts */}
          <SidebarItem
            label="Test Report Summary"
            icon={<TestReportIcon />}
            active={activePage === "test-report"}
            onClick={() => setActivePage("test-report")}
          />

          {/* Test Case Confidence */}
          <SidebarItem
            label="TC Confidence"
            icon={<ConfidenceIcon />}
            active={activePage === "confidence"}
            onClick={() => setActivePage("confidence")}
          />

          {/* TC Analysis */}
          <SidebarItem
            label="TC Analysis"
            icon={<TCAnalysisIcon />}
            active={activePage === "tc-analysis"}
            onClick={() => setActivePage("tc-analysis")}
          />

          {/* History */}
          <SidebarItem
            label="History"
            icon={<HistoryIcon />}
            active={activePage === "history"}
            onClick={() => setActivePage("history")}
          />

          {/* Workflows section */}
          <div className="pt-4 mt-3 border-t border-white/[0.04]">
            <p className="px-3 mb-2 text-[10px] font-semibold uppercase tracking-widest text-gray-600">
              Workflows
            </p>
            <SidebarItem
              label="Builder"
              icon={<WorkflowIcon />}
              active={activePage === "workflows"}
              onClick={() => setActivePage("workflows")}
            />
            <SidebarItem
              label="Runs"
              icon={<WorkflowRunsIcon />}
              active={activePage === "workflow-runs"}
              onClick={() => setActivePage("workflow-runs")}
            />
          </div>

          {/* AI (disabled) */}
          <div className="pt-3 mt-2">
            <SidebarItem label="AI Assistant" icon={<AiIcon />} disabled />
          </div>
        </nav>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-white/[0.04] flex items-center justify-between">
          <span className="text-[10px] text-gray-600">v0.1.0</span>
          <div className="flex items-center gap-2">
            <button
              onClick={toggleTheme}
              className="p-1.5 rounded-lg hover:bg-white/[0.06] text-gray-500 hover:text-gray-300 transition-colors"
              title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
            >
              {theme === 'dark' ? (
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z" />
                </svg>
              ) : (
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z" />
                </svg>
              )}
            </button>
            <span className="flex h-2 w-2 rounded-full bg-green-500/80" title="Backend connected" />
          </div>
        </div>
      </aside>

      {/* ---------------------------------------------------------------- */}
      {/* Main Panel                                                       */}
      {/* ---------------------------------------------------------------- */}
      <main className="flex-1 overflow-y-auto bg-[#0f1117]">
        <div
          className={`${
            activePage === "workflows"
              ? "p-4"
              : "p-6 lg:p-8 xl:p-10"
          }`}
        >
          <div className={activePage === "scripts" ? "page-enter" : "hidden"}>
            <ScriptRunner
              scripts={scripts}
              selectedScript={selectedScript}
              onSelectScript={setSelectedScript}
            />
          </div>
          <div className={activePage === "test-report" ? "page-enter" : "hidden"}>
            <TestReportDashboard />
          </div>
          <div className={activePage === "confidence" ? "page-enter" : "hidden"}>
            <ConfidenceDashboard />
          </div>
          <div className={activePage === "tc-analysis" ? "page-enter" : "hidden"}>
            <TCAnalysis />
          </div>
          <div className={activePage === "history" ? "page-enter" : "hidden"}>
            <RunHistory />
          </div>
          <div className={activePage === "workflows" ? "page-enter" : "hidden"}>
            <WorkflowBuilder />
          </div>
          <div className={activePage === "workflow-runs" ? "page-enter" : "hidden"}>
            <WorkflowExecution />
          </div>
        </div>
      </main>
    </div>
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
  onClick?: () => void;
}

function SidebarItem({
  label,
  icon,
  active = false,
  disabled = false,
  hasChevron = false,
  expanded = false,
  onClick,
}: SidebarItemProps) {
  const base =
    "flex items-center gap-3 w-full text-left px-3 py-2.5 rounded-[10px] text-sm font-medium transition-all duration-150";
  const activeClass =
    "bg-indigo-500/10 text-indigo-300 border border-indigo-500/10 sidebar-active-glow";
  const defaultClass =
    "text-gray-400 hover:bg-white/[0.04] hover:text-gray-200 border border-transparent hover-scale";
  const disabledClass = "text-gray-600 cursor-not-allowed border border-transparent";

  return (
    <button
      className={`${base} ${active ? activeClass : disabled ? disabledClass : defaultClass}`}
      disabled={disabled}
      onClick={onClick}
    >
      <span className={`transition-colors ${active ? "text-indigo-400" : ""}`}>
        {icon}
      </span>
      <span className="flex-1">{label}</span>
      {disabled && (
        <span className="text-[9px] uppercase tracking-wider text-gray-700 bg-white/[0.04] px-1.5 py-0.5 rounded">
          soon
        </span>
      )}
      {hasChevron && (
        <svg
          className={`h-3.5 w-3.5 text-gray-600 transition-transform duration-200 ${
            expanded ? "rotate-90" : ""
          }`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
        </svg>
      )}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* Spinner                                                                    */
/* -------------------------------------------------------------------------- */

function SmallSpinner() {
  return (
    <svg className="h-3 w-3 animate-spin" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

/* -------------------------------------------------------------------------- */
/* Icons                                                                      */
/* -------------------------------------------------------------------------- */

function ScriptsIcon() {
  return (
    <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5" />
    </svg>
  );
}

function HistoryIcon() {
  return (
    <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );
}

function WorkflowIcon() {
  return (
    <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
    </svg>
  );
}

function WorkflowRunsIcon() {
  return (
    <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5" />
    </svg>
  );
}

function TestReportIcon() {
  return (
    <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
    </svg>
  );
}

function ConfidenceIcon() {
  return (
    <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
    </svg>
  );
}

function TCAnalysisIcon() {
  return (
    <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m5.231 13.481L15 17.25m-4.5-15H5.625c-.621 0-1.125.504-1.125 1.125v16.5c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9zm3.75 11.625a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
    </svg>
  );
}

function AiIcon() {
  return (
    <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456zM16.894 20.567L16.5 21.75l-.394-1.183a2.25 2.25 0 00-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 001.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 001.423 1.423l1.183.394-1.183.394a2.25 2.25 0 00-1.423 1.423z" />
    </svg>
  );
}
