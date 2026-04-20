"use client";

import { useCallback, useEffect, useRef, useState } from "react";

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

/** A single line in the live console. */
interface ConsoleLine {
  type: "stdout" | "stderr" | "info";
  text: string;
}

/** An output file produced by a script. */
interface OutputFile {
  name: string;
  path: string;
}

/** Execution state machine */
type ExecutionPhase = "idle" | "running" | "success" | "error";

/** Parsed result metrics from console output */
interface ExecutionMetrics {
  devicesFound?: number;
  devicesMissing?: number;
  totalDevices?: number;
  passRate?: number;
  shadowsDeleted?: number;
  shadowsFailed?: number;
  customMetrics?: { label: string; value: string; type?: "success" | "warning" | "error" | "neutral" }[];
}

/** A history entry for the current session */
interface SessionRun {
  id: number;
  scriptName: string;
  timestamp: Date;
  elapsed: number;
  exitCode: number;
  metrics: ExecutionMetrics;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://172.16.23.15:8000";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ScriptRunnerProps {
  scripts: ScriptInfo[];
  selectedScript: ScriptInfo | null;
  onSelectScript: (script: ScriptInfo) => void;
}

// ---------------------------------------------------------------------------
// Metric parser — extracts structured insights from console output
// ---------------------------------------------------------------------------

function parseMetrics(lines: ConsoleLine[], scriptName: string): ExecutionMetrics {
  const metrics: ExecutionMetrics = { customMetrics: [] };
  const allText = lines.map((l) => l.text).join("\n");

  // Broadcast check parsing
  if (scriptName.includes("broadcast")) {
    const foundMatch = allText.match(/Found\s+(\d+)\s+of\s+(\d+)/i);
    if (foundMatch) {
      metrics.devicesFound = parseInt(foundMatch[1]);
      metrics.totalDevices = parseInt(foundMatch[2]);
      metrics.devicesMissing = metrics.totalDevices - metrics.devicesFound;
      metrics.passRate = Math.round((metrics.devicesFound / metrics.totalDevices) * 100);
    }
    const devicesFoundMatch = allText.match(/(\d+)\s+device\(s\)\s+found/i);
    if (devicesFoundMatch) {
      metrics.devicesFound = parseInt(devicesFoundMatch[1]);
    }
  }

  // Shadow deletion parsing
  if (scriptName.includes("shadow") || scriptName.includes("delete")) {
    const classicMatch = allText.match(/Classic shadows deleted:\s*(\d+)\/(\d+)/i);
    if (classicMatch) {
      metrics.shadowsDeleted = parseInt(classicMatch[1]);
      metrics.totalDevices = parseInt(classicMatch[2]);
    }
    const namedMatch = allText.match(/Named shadows deleted:\s*(\d+)\/(\d+)/i);
    if (namedMatch) {
      const namedDel = parseInt(namedMatch[1]);
      metrics.shadowsDeleted = (metrics.shadowsDeleted || 0) + namedDel;
    }
    const totalMatch = allText.match(/Total devices processed:\s*(\d+)/i);
    if (totalMatch) {
      metrics.totalDevices = parseInt(totalMatch[1]);
    }
  }

  // RC Comparison parsing
  if (scriptName.includes("rc_comparison") || scriptName.includes("comparison")) {
    const regressMatch = allText.match(/(\d+)\s+regression/i);
    if (regressMatch) {
      metrics.customMetrics!.push({
        label: "Regressions",
        value: regressMatch[1],
        type: parseInt(regressMatch[1]) > 0 ? "error" : "success",
      });
    }
    const fixedMatch = allText.match(/(\d+)\s+fixed/i);
    if (fixedMatch) {
      metrics.customMetrics!.push({
        label: "Fixed",
        value: fixedMatch[1],
        type: "success",
      });
    }
  }

  // Generic PASS/FAIL parsing
  const passMatch = allText.match(/\b(PASS)\b/gi);
  const failMatch = allText.match(/\b(FAIL)\b/gi);
  if (passMatch && !metrics.passRate) {
    const total = (passMatch?.length || 0) + (failMatch?.length || 0);
    if (total > 0) {
      metrics.passRate = Math.round(((passMatch?.length || 0) / total) * 100);
    }
  }

  // Summary line detection
  const summaryLines = lines.filter(
    (l) => l.text.includes("SUMMARY") || l.text.includes("Result:") || l.text.includes("\u2705") || l.text.includes("\u274c")
  );
  summaryLines.slice(0, 3).forEach((line) => {
    if (line.text.trim() && !line.text.includes("\u2550") && !line.text.includes("SUMMARY")) {
      metrics.customMetrics!.push({
        label: "Result",
        value: line.text.replace(/[\u2705\u274c\u26a0\ufe0f\ud83d\udcca]/g, "").trim().slice(0, 60),
        type: line.text.includes("\u2705") ? "success" : line.text.includes("\u274c") ? "error" : "neutral",
      });
    }
  });

  return metrics;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ScriptRunner({
  scripts,
  selectedScript,
  onSelectScript,
}: ScriptRunnerProps) {
  const [argValues, setArgValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState<number>(0);
  const [outputFiles, setOutputFiles] = useState<OutputFile[]>([]);
  const [phase, setPhase] = useState<ExecutionPhase>("idle");
  const [showLogs, setShowLogs] = useState(false);
  const [sessionRuns, setSessionRuns] = useState<SessionRun[]>([]);
  const [chipInput, setChipInput] = useState<Record<string, string>>({});
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});

  const consoleRef = useRef<HTMLPreElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const runCountRef = useRef(0);

  // Per-script state cache
  interface ScriptCache {
    argValues: Record<string, string>;
    lines: ConsoleLine[];
    error: string | null;
    exitCode: number | null;
    elapsed: number;
    outputFiles: OutputFile[];
    phase: ExecutionPhase;
  }
  const scriptCacheRef = useRef<Record<string, ScriptCache>>({});
  const prevScriptRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  // Save/restore script state when switching
  useEffect(() => {
    if (!selectedScript) return;

    const prev = prevScriptRef.current;
    if (prev) {
      scriptCacheRef.current[prev] = {
        argValues,
        lines,
        error,
        exitCode,
        elapsed,
        outputFiles,
        phase,
      };
    }

    prevScriptRef.current = selectedScript.name;

    const cached = scriptCacheRef.current[selectedScript.name];
    if (cached) {
      setArgValues(cached.argValues);
      setLines(cached.lines);
      setError(cached.error);
      setExitCode(cached.exitCode);
      setElapsed(cached.elapsed);
      setOutputFiles(cached.outputFiles);
      setPhase(cached.phase);
    } else {
      const defaults: Record<string, string> = {};
      selectedScript.args.forEach((a) => {
        defaults[a.name] = a.default ?? "";
      });
      setArgValues(defaults);
      setLines([]);
      setError(null);
      setExitCode(null);
      setOutputFiles([]);
      setPhase("idle");
    }
    setShowLogs(false);
    setValidationErrors({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedScript]);

  const handleArgChange = (name: string, value: string) => {
    setArgValues((prev) => ({ ...prev, [name]: value }));
    if (validationErrors[name]) {
      setValidationErrors((prev) => {
        const next = { ...prev };
        delete next[name];
        return next;
      });
    }
  };

  /** Validate required fields */
  const validateArgs = (): boolean => {
    if (!selectedScript) return false;
    const errors: Record<string, string> = {};
    selectedScript.args.forEach((arg) => {
      if (arg.required && !argValues[arg.name]?.trim()) {
        errors[arg.name] = "This field is required";
      }
    });
    setValidationErrors(errors);
    return Object.keys(errors).length === 0;
  };

  /** Handle chip input for comma-separated lists */
  const isChipField = (arg: ScriptArg) =>
    arg.type === "string" &&
    (arg.name.includes("device") ||
      arg.name.includes("list") ||
      arg.name.includes("ids") ||
      arg.description.toLowerCase().includes("comma"));

  const getChips = (name: string): string[] => {
    const val = argValues[name] || "";
    return val
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  };

  const addChip = (name: string, value: string) => {
    const trimmed = value.trim().replace(/,/g, "");
    if (!trimmed) return;
    const current = getChips(name);
    if (!current.includes(trimmed)) {
      const updated = [...current, trimmed].join(",");
      handleArgChange(name, updated);
    }
    setChipInput((prev) => ({ ...prev, [name]: "" }));
  };

  const removeChip = (name: string, index: number) => {
    const current = getChips(name);
    current.splice(index, 1);
    handleArgChange(name, current.join(","));
  };

  /** Stop a running script. */
  const handleStop = () => {
    abortRef.current?.abort();
  };

  /** Execute the selected script via SSE streaming endpoint. */
  const handleRun = async () => {
    if (!selectedScript) return;
    if (!validateArgs()) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setPhase("running");
    setLines([]);
    setError(null);
    setExitCode(null);
    setElapsed(0);
    setOutputFiles([]);
    setShowLogs(false);

    const start = Date.now();
    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - start) / 1000));
    }, 1000);

    const convertedArgs: Record<string, string | number | boolean> = {};
    selectedScript.args.forEach((a) => {
      const raw = argValues[a.name] ?? "";
      if (a.type === "int") convertedArgs[a.name] = raw === "" ? 0 : Number(raw);
      else if (a.type === "float") convertedArgs[a.name] = raw === "" ? 0 : Number(raw);
      else if (a.type === "bool") convertedArgs[a.name] = raw === "true";
      else convertedArgs[a.name] = raw;
    });

    try {
      const res = await fetch(`${API_BASE}/run-script-stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script: selectedScript.name, args: convertedArgs }),
        signal: controller.signal,
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";

        for (const part of parts) {
          const dataLine = part.trim();
          if (!dataLine.startsWith("data: ")) continue;

          try {
            const payload = JSON.parse(dataLine.slice(6));

            if (payload.type === "stdout") {
              setLines((prev) => [...prev, { type: "stdout", text: payload.text }]);
            } else if (payload.type === "stderr") {
              setLines((prev) => [...prev, { type: "stderr", text: payload.text }]);
            } else if (payload.type === "exit") {
              const code = payload.code;
              setExitCode(code);
              setPhase(code === 0 ? "success" : "error");
              if (code !== 0) {
                setError(`Script exited with code ${code}`);
              }
              if (selectedScript.outputs_dir) {
                try {
                  const outRes = await fetch(`${API_BASE}/outputs/${selectedScript.name}`);
                  if (outRes.ok) {
                    const files: OutputFile[] = await outRes.json();
                    setOutputFiles(files);
                  }
                } catch { /* ignore */ }
              }
            }
          } catch { /* Ignore malformed SSE data */ }
        }
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") {
        setLines((prev) => [...prev, { type: "info", text: "\u23f9 Script execution stopped by user." }]);
        setPhase("error");
      } else {
        setError("Failed to run script. Check the backend connection.");
        setPhase("error");
      }
    } finally {
      setLoading(false);
      const finalElapsed = Math.floor((Date.now() - start) / 1000);
      setElapsed(finalElapsed);
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
  };

  // Save to session history when execution completes
  useEffect(() => {
    if (phase === "success" || phase === "error") {
      if (selectedScript && exitCode !== null) {
        const metrics = parseMetrics(lines, selectedScript.name);
        setSessionRuns((prev) => [
          {
            id: ++runCountRef.current,
            scriptName: selectedScript.name,
            timestamp: new Date(),
            elapsed,
            exitCode: exitCode!,
            metrics,
          },
          ...prev.slice(0, 9),
        ]);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // Auto-scroll console
  useEffect(() => {
    if (consoleRef.current) {
      consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
    }
  }, [lines]);

  const prettyName = (name: string) => name.replace(".py", "").replace(/_/g, " ");

  const formatElapsed = (sec: number) => {
    if (sec < 60) return `${sec}s`;
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}m ${s}s`;
  };

  // Session stats
  const sessionStats = {
    totalRuns: sessionRuns.length,
    successRate: sessionRuns.length > 0
      ? Math.round((sessionRuns.filter((r) => r.exitCode === 0).length / sessionRuns.length) * 100)
      : 0,
    avgTime: sessionRuns.length > 0
      ? Math.round(sessionRuns.reduce((a, r) => a + r.elapsed, 0) / sessionRuns.length)
      : 0,
  };

  const currentMetrics = selectedScript ? parseMetrics(lines, selectedScript.name) : {};

  // ----- render -----
  if (!selectedScript) {
    return (
      <div className="flex flex-col items-center justify-center h-full min-h-[60vh] text-center">
        <div className="relative mb-6">
          <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500/10 to-violet-500/10 border border-indigo-500/10">
            <svg className="h-9 w-9 text-indigo-400/50" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5" />
            </svg>
          </div>
        </div>
        <h3 className="ds-page-title text-lg mb-2">Select a Script</h3>
        <p className="ds-page-subtitle max-w-sm">
          {scripts.length === 0
            ? "No scripts found. Add .py files to backend/scripts/."
            : "Choose a script from the sidebar to configure and run."}
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto space-y-5 pb-8">
      {/* Session Analytics Bar */}
      {sessionRuns.length > 0 && (
        <div className="grid grid-cols-3 gap-4 animate-fadeIn">
          <StatCard label="Total Runs" value={sessionStats.totalRuns.toString()} icon={<RunsIcon />} />
          <StatCard
            label="Success Rate"
            value={`${sessionStats.successRate}%`}
            icon={<RateIcon />}
            accent={sessionStats.successRate >= 80 ? "green" : sessionStats.successRate >= 50 ? "amber" : "red"}
          />
          <StatCard label="Avg. Duration" value={formatElapsed(sessionStats.avgTime)} icon={<ClockIcon />} />
        </div>
      )}

      {/* Script Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500/15 to-violet-500/15 border border-indigo-500/10">
            <svg className="h-5 w-5 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5" />
            </svg>
          </div>
          <div>
            <h2 className="ds-page-title capitalize">{prettyName(selectedScript.name)}</h2>
            {selectedScript.description && (
              <p className="ds-page-subtitle mt-0.5 max-w-lg line-clamp-2">
                {selectedScript.description.slice(0, 120)}
              </p>
            )}
          </div>
        </div>
        <PhaseIndicator phase={phase} elapsed={elapsed} exitCode={exitCode} loading={loading} />
      </div>

      {/* Execution Progress Bar */}
      {loading && (
        <div className="w-full animate-fadeIn">
          <div className="progress-bar">
            <div className="progress-bar-fill animate-progress" style={{ width: "100%" }} />
          </div>
        </div>
      )}

      {/* Result Summary Panel (after execution) */}
      {phase !== "idle" && phase !== "running" && (
        <ResultSummary
          phase={phase}
          elapsed={elapsed}
          metrics={currentMetrics}
          error={error}
          outputFiles={outputFiles}
          scriptName={selectedScript.name}
        />
      )}

      {/* Configuration Panel */}
      <div className="ds-card overflow-hidden">
        <div className="ds-card-header flex items-center justify-between">
          <div className="flex items-center gap-2">
            <svg className="h-4 w-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            <h3 className="text-sm font-semibold text-gray-300">Configuration</h3>
            {selectedScript.args.length > 0 && (
              <span className="text-[10px] text-gray-500 bg-white/[0.04] px-1.5 py-0.5 rounded">
                {selectedScript.args.length} {selectedScript.args.length === 1 ? "param" : "params"}
              </span>
            )}
          </div>
          {phase !== "idle" && (
            <button
              onClick={() => { setPhase("idle"); setLines([]); setExitCode(null); setError(null); setOutputFiles([]); }}
              className="text-xs text-gray-500 hover:text-gray-300 transition-colors flex items-center gap-1"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
              </svg>
              Reset
            </button>
          )}
        </div>

        <div className="p-5">
          {selectedScript.args.length === 0 ? (
            <p className="text-sm text-gray-500 italic">This script requires no configuration.</p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              {selectedScript.args.map((arg) => (
                <div key={arg.name} className={`space-y-1.5 ${isChipField(arg) ? "md:col-span-2" : ""}`}>
                  <label className="ds-label flex items-baseline gap-2">
                    <span className="text-gray-400">{arg.name.replace(/_/g, " ")}</span>
                    <span className="font-normal normal-case text-gray-600 text-[10px]">
                      {arg.type}
                    </span>
                    {arg.required && (
                      <span className="text-red-400 text-[10px]">required</span>
                    )}
                  </label>
                  {arg.description && (
                    <p className="text-[11px] text-gray-500 leading-relaxed">{arg.description}</p>
                  )}

                  {/* Bool toggle */}
                  {arg.type === "bool" ? (
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() =>
                          handleArgChange(arg.name, argValues[arg.name] === "true" ? "false" : "true")
                        }
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 ${
                          argValues[arg.name] === "true" ? "bg-indigo-600" : "bg-white/[0.08]"
                        }`}
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-200 ${
                            argValues[arg.name] === "true" ? "translate-x-6" : "translate-x-1"
                          }`}
                        />
                      </button>
                      <span className="text-xs text-gray-400">
                        {argValues[arg.name] === "true" ? "Enabled" : "Disabled"}
                      </span>
                    </div>
                  ) : isChipField(arg) ? (
                    /* Chip-based multi-input */
                    <div className="space-y-2">
                      <div className={`ds-input w-full min-h-[44px] flex flex-wrap items-center gap-1.5 cursor-text ${
                        validationErrors[arg.name] ? "!border-red-500/50" : ""
                      }`}>
                        {getChips(arg.name).map((chip, i) => (
                          <span
                            key={i}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-indigo-500/15 text-indigo-300 text-xs font-medium border border-indigo-500/20"
                          >
                            {chip}
                            <button
                              onClick={() => removeChip(arg.name, i)}
                              className="hover:text-red-400 transition-colors ml-0.5"
                            >
                              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                              </svg>
                            </button>
                          </span>
                        ))}
                        <input
                          type="text"
                          className="flex-1 min-w-[120px] bg-transparent border-none outline-none text-sm text-gray-200 placeholder:text-gray-600"
                          placeholder={getChips(arg.name).length === 0 ? (arg.default || "Type and press Enter or comma\u2026") : "Add more\u2026"}
                          value={chipInput[arg.name] || ""}
                          onChange={(e) => {
                            const val = e.target.value;
                            if (val.includes(",")) {
                              val.split(",").forEach((v) => addChip(arg.name, v));
                            } else {
                              setChipInput((prev) => ({ ...prev, [arg.name]: val }));
                            }
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === "Tab") {
                              e.preventDefault();
                              addChip(arg.name, chipInput[arg.name] || "");
                            }
                            if (e.key === "Backspace" && !chipInput[arg.name]) {
                              const chips = getChips(arg.name);
                              if (chips.length > 0) removeChip(arg.name, chips.length - 1);
                            }
                          }}
                        />
                      </div>
                      <p className="text-[10px] text-gray-600">
                        Tip: Paste comma-separated values or type preset group names (e.g. ALL, B2_US, K1_UK)
                      </p>
                    </div>
                  ) : (
                    /* Standard input */
                    <div>
                      <input
                        type={arg.type === "int" || arg.type === "float" ? "number" : "text"}
                        className={`ds-input w-full ${validationErrors[arg.name] ? "!border-red-500/50" : ""}`}
                        placeholder={arg.default ? `Default: ${arg.default}` : `Enter ${arg.name.replace(/_/g, " ")}\u2026`}
                        value={argValues[arg.name] ?? ""}
                        onChange={(e) => handleArgChange(arg.name, e.target.value)}
                      />
                      {validationErrors[arg.name] && (
                        <p className="text-[11px] text-red-400 mt-1 flex items-center gap-1">
                          <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
                          </svg>
                          {validationErrors[arg.name]}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex items-center gap-3 mt-5 pt-4 border-t border-white/[0.04]">
            <button
              onClick={handleRun}
              disabled={loading || !selectedScript}
              className="ds-btn-primary"
            >
              {loading ? (
                <>
                  <Spinner />
                  <span>Executing\u2026</span>
                </>
              ) : (
                <>
                  <PlayIcon />
                  <span>Execute</span>
                </>
              )}
            </button>

            {loading && (
              <button onClick={handleStop} className="ds-btn-danger">
                <StopIcon />
                Stop
              </button>
            )}

            <div className="flex-1" />

            {loading && (
              <span className="text-sm text-gray-500 font-mono tabular-nums">
                \u23f1 {formatElapsed(elapsed)}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Live Execution Indicator */}
      {phase === "running" && (
        <div className="ds-card overflow-hidden border-indigo-500/20 animate-fadeIn">
          <div className="p-5 flex items-center gap-4">
            <div className="relative">
              <div className="h-12 w-12 rounded-full border-2 border-indigo-500/30 flex items-center justify-center">
                <div className="h-8 w-8 rounded-full border-2 border-t-indigo-500 border-r-transparent border-b-transparent border-l-transparent animate-spin" />
              </div>
              <div className="absolute inset-0 rounded-full animate-ping opacity-20 bg-indigo-500" />
            </div>
            <div className="flex-1">
              <p className="text-sm font-medium text-gray-200">Executing {prettyName(selectedScript.name)}\u2026</p>
              <p className="text-xs text-gray-500 mt-0.5">
                {lines.length} output lines \u2022 {formatElapsed(elapsed)} elapsed
              </p>
            </div>
            <button
              onClick={() => setShowLogs(!showLogs)}
              className="ds-btn-secondary text-xs !py-1.5 !px-3"
            >
              {showLogs ? "Hide" : "Show"} Live Logs
            </button>
          </div>

          {showLogs && (
            <pre
              ref={consoleRef}
              className="console-output max-h-48 overflow-y-auto bg-[#0a0c12] px-5 pb-4 font-[family-name:var(--font-geist-mono)] text-xs leading-relaxed border-t border-white/[0.04]"
            >
              {lines.slice(-50).map((line, i) => (
                <div
                  key={i}
                  className={
                    line.type === "stderr" ? "text-red-400" : line.type === "info" ? "text-yellow-400" : "text-gray-400"
                  }
                >
                  {line.text}
                </div>
              ))}
              <span className="inline-block animate-pulse text-gray-600">\u258a</span>
            </pre>
          )}
        </div>
      )}

      {/* Collapsible Full Logs (post-execution) */}
      {phase !== "idle" && phase !== "running" && lines.length > 0 && (
        <div className="ds-card overflow-hidden">
          <button
            onClick={() => setShowLogs(!showLogs)}
            className="w-full ds-card-header flex items-center justify-between hover:bg-white/[0.02] transition-colors cursor-pointer"
          >
            <div className="flex items-center gap-2">
              <svg className="h-4 w-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0021 18V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v12a2.25 2.25 0 002.25 2.25z" />
              </svg>
              <h3 className="text-sm font-semibold text-gray-300">Execution Logs</h3>
              <span className="text-[10px] text-gray-500 bg-white/[0.04] px-1.5 py-0.5 rounded">
                {lines.length} lines
              </span>
            </div>
            <svg
              className={`h-4 w-4 text-gray-500 transition-transform duration-200 ${showLogs ? "rotate-180" : ""}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
            </svg>
          </button>

          {showLogs && (
            <pre
              ref={consoleRef}
              className="console-output h-64 overflow-y-auto bg-[#0a0c12] p-4 font-[family-name:var(--font-geist-mono)] text-xs leading-relaxed"
            >
              {lines.map((line, i) => (
                <div
                  key={i}
                  className={
                    line.type === "stderr" ? "text-red-400" : line.type === "info" ? "text-yellow-400 italic" : "text-green-400/80"
                  }
                >
                  {line.text}
                </div>
              ))}
            </pre>
          )}
        </div>
      )}

      {/* Recent Runs (Session History) */}
      {sessionRuns.length > 0 && (
        <div className="ds-card overflow-hidden">
          <div className="ds-card-header flex items-center gap-2">
            <svg className="h-4 w-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <h3 className="text-sm font-semibold text-gray-300">Session History</h3>
            <span className="text-[10px] text-gray-500 bg-white/[0.04] px-1.5 py-0.5 rounded">
              {sessionRuns.length} runs
            </span>
          </div>
          <div className="divide-y divide-white/[0.03]">
            {sessionRuns.slice(0, 5).map((run) => (
              <div key={run.id} className="px-5 py-3 flex items-center gap-3 hover:bg-white/[0.02] transition-colors">
                <span
                  className={`flex h-7 w-7 items-center justify-center rounded-lg text-xs font-bold ${
                    run.exitCode === 0
                      ? "bg-green-500/10 text-green-400"
                      : "bg-red-500/10 text-red-400"
                  }`}
                >
                  {run.exitCode === 0 ? "\u2713" : "\u2717"}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-300 capitalize truncate">
                    {prettyName(run.scriptName)}
                  </p>
                  <p className="text-[11px] text-gray-500">
                    {run.timestamp.toLocaleTimeString()} \u2022 {formatElapsed(run.elapsed)}
                  </p>
                </div>
                <span className={`ds-badge ${run.exitCode === 0 ? "ds-badge-success" : "ds-badge-error"}`}>
                  {run.exitCode === 0 ? "Success" : `Exit ${run.exitCode}`}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// Sub-components
// ===========================================================================

/** Phase badge in the header */
function PhaseIndicator({
  phase,
  elapsed,
  exitCode,
  loading,
}: {
  phase: ExecutionPhase;
  elapsed: number;
  exitCode: number | null;
  loading: boolean;
}) {
  if (phase === "idle") return null;

  const formatElapsed = (sec: number) => (sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`);

  if (phase === "running") {
    return (
      <span className="ds-badge ds-badge-warning">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
        Running \u00b7 {formatElapsed(elapsed)}
      </span>
    );
  }
  if (phase === "success") {
    return (
      <span className="ds-badge ds-badge-success">
        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
        </svg>
        Completed \u00b7 {formatElapsed(elapsed)}
      </span>
    );
  }
  return (
    <span className="ds-badge ds-badge-error">
      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
      </svg>
      Failed \u00b7 Exit {exitCode}
    </span>
  );
}

/** Result summary panel shown after execution */
function ResultSummary({
  phase,
  elapsed,
  metrics,
  error,
  outputFiles,
  scriptName,
}: {
  phase: ExecutionPhase;
  elapsed: number;
  metrics: ExecutionMetrics;
  error: string | null;
  outputFiles: OutputFile[];
  scriptName: string;
}) {
  const isSuccess = phase === "success";
  const formatElapsed = (sec: number) => (sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`);

  return (
    <div
      className={`ds-card overflow-hidden animate-fadeIn ${
        isSuccess ? "border-green-500/20" : "border-red-500/20"
      }`}
    >
      {/* Status Banner */}
      <div
        className={`px-5 py-4 flex items-center gap-3 ${
          isSuccess ? "bg-green-500/[0.05]" : "bg-red-500/[0.05]"
        }`}
      >
        <div
          className={`h-10 w-10 rounded-full flex items-center justify-center ${
            isSuccess ? "bg-green-500/15" : "bg-red-500/15"
          }`}
        >
          {isSuccess ? (
            <svg className="h-5 w-5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          ) : (
            <svg className="h-5 w-5 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 9.75l4.5 4.5m0-4.5l-4.5 4.5M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          )}
        </div>
        <div className="flex-1">
          <p className={`text-sm font-semibold ${isSuccess ? "text-green-300" : "text-red-300"}`}>
            {isSuccess ? "Execution Successful" : "Execution Failed"}
          </p>
          <p className="text-xs text-gray-500 mt-0.5">
            Completed in {formatElapsed(elapsed)}
            {error && !isSuccess && ` \u2014 ${error}`}
          </p>
        </div>
      </div>

      {/* Metrics Grid */}
      {(metrics.totalDevices || metrics.shadowsDeleted !== undefined || metrics.passRate !== undefined || (metrics.customMetrics && metrics.customMetrics.length > 0)) && (
        <div className="px-5 py-4 border-t border-white/[0.04]">
          <p className="text-[11px] text-gray-500 uppercase tracking-wider font-semibold mb-3">Key Insights</p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {metrics.totalDevices !== undefined && (
              <MetricTile label="Total Devices" value={metrics.totalDevices.toString()} />
            )}
            {metrics.devicesFound !== undefined && (
              <MetricTile label="Found" value={metrics.devicesFound.toString()} type="success" />
            )}
            {metrics.devicesMissing !== undefined && metrics.devicesMissing > 0 && (
              <MetricTile label="Missing" value={metrics.devicesMissing.toString()} type="error" />
            )}
            {metrics.shadowsDeleted !== undefined && (
              <MetricTile label="Shadows Deleted" value={metrics.shadowsDeleted.toString()} type="success" />
            )}
            {metrics.shadowsFailed !== undefined && metrics.shadowsFailed > 0 && (
              <MetricTile label="Shadows Failed" value={metrics.shadowsFailed.toString()} type="error" />
            )}
            {metrics.passRate !== undefined && (
              <MetricTile
                label="Pass Rate"
                value={`${metrics.passRate}%`}
                type={metrics.passRate >= 80 ? "success" : metrics.passRate >= 50 ? "warning" : "error"}
              />
            )}
            {metrics.customMetrics?.map((m, i) => (
              <MetricTile key={i} label={m.label} value={m.value} type={m.type} />
            ))}
          </div>
        </div>
      )}

      {/* Output Files */}
      {outputFiles.length > 0 && (
        <div className="px-5 py-4 border-t border-white/[0.04]">
          <p className="text-[11px] text-gray-500 uppercase tracking-wider font-semibold mb-3">Generated Files</p>
          <div className="space-y-2">
            {outputFiles.map((file, i) => (
              <div
                key={i}
                className="flex items-center justify-between rounded-[10px] border border-white/[0.06] bg-white/[0.02] px-4 py-2.5 hover:bg-white/[0.04] transition-colors"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <FileIcon />
                  <span className="text-sm text-gray-300 truncate">{file.name}</span>
                </div>
                <a
                  href={`${API_BASE}/download?path=${encodeURIComponent(file.path)}`}
                  className="shrink-0 ds-badge ds-badge-info cursor-pointer hover:opacity-80 transition-opacity"
                  download
                >
                  <DownloadIcon />
                  Download
                </a>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** A single metric tile */
function MetricTile({
  label,
  value,
  type = "neutral",
}: {
  label: string;
  value: string;
  type?: "success" | "warning" | "error" | "neutral";
}) {
  const colorMap = {
    success: "text-green-400 bg-green-500/10 border-green-500/15",
    warning: "text-amber-400 bg-amber-500/10 border-amber-500/15",
    error: "text-red-400 bg-red-500/10 border-red-500/15",
    neutral: "text-gray-300 bg-white/[0.03] border-white/[0.06]",
  };

  return (
    <div className={`rounded-xl border p-3 ${colorMap[type]}`}>
      <p className="text-lg font-bold tabular-nums">{value}</p>
      <p className="text-[11px] opacity-70 mt-0.5">{label}</p>
    </div>
  );
}

/** Analytics stat card */
function StatCard({
  label,
  value,
  icon,
  accent = "indigo",
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  accent?: "indigo" | "green" | "amber" | "red";
}) {
  const accentMap = {
    indigo: "from-indigo-500/10 to-violet-500/10 border-indigo-500/10",
    green: "from-green-500/10 to-emerald-500/10 border-green-500/10",
    amber: "from-amber-500/10 to-orange-500/10 border-amber-500/10",
    red: "from-red-500/10 to-rose-500/10 border-red-500/10",
  };

  return (
    <div className={`ds-card px-4 py-3 flex items-center gap-3 bg-gradient-to-br ${accentMap[accent]}`}>
      <div className="h-9 w-9 rounded-lg bg-white/[0.05] flex items-center justify-center shrink-0">
        {icon}
      </div>
      <div>
        <p className="text-lg font-bold text-white tabular-nums">{value}</p>
        <p className="text-[11px] text-gray-500">{label}</p>
      </div>
    </div>
  );
}

// ===========================================================================
// Icons
// ===========================================================================

function PlayIcon() {
  return (
    <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 20 20">
      <path fillRule="evenodd" d="M6.3 2.841A1.5 1.5 0 004 4.12V15.88a1.5 1.5 0 002.3 1.279l9.344-5.88a1.5 1.5 0 000-2.557L6.3 2.84z" clipRule="evenodd" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 20 20">
      <rect x="4" y="4" width="12" height="12" rx="2" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg className="h-4 w-4 text-gray-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
    </svg>
  );
}

function RunsIcon() {
  return (
    <svg className="h-4 w-4 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
    </svg>
  );
}

function RateIcon() {
  return (
    <svg className="h-4 w-4 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg className="h-4 w-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );
}
