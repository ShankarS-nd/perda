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

  const consoleRef = useRef<HTMLPreElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Per-script state cache so switching scripts doesn't lose output
  interface ScriptCache {
    argValues: Record<string, string>;
    lines: ConsoleLine[];
    error: string | null;
    exitCode: number | null;
    elapsed: number;
    outputFiles: OutputFile[];
  }
  const scriptCacheRef = useRef<Record<string, ScriptCache>>({});
  const prevScriptRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  // Save previous script state & restore new script state when switching
  useEffect(() => {
    if (!selectedScript) return;

    // Save state of the script we're leaving
    const prev = prevScriptRef.current;
    if (prev) {
      scriptCacheRef.current[prev] = {
        argValues,
        lines,
        error,
        exitCode,
        elapsed,
        outputFiles,
      };
    }

    prevScriptRef.current = selectedScript.name;

    // Restore cached state if we've visited this script before
    const cached = scriptCacheRef.current[selectedScript.name];
    if (cached) {
      setArgValues(cached.argValues);
      setLines(cached.lines);
      setError(cached.error);
      setExitCode(cached.exitCode);
      setElapsed(cached.elapsed);
      setOutputFiles(cached.outputFiles);
    } else {
      // First visit — initialise with defaults
      const defaults: Record<string, string> = {};
      selectedScript.args.forEach((a) => {
        defaults[a.name] = a.default ?? "";
      });
      setArgValues(defaults);
      setLines([]);
      setError(null);
      setExitCode(null);
      setOutputFiles([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedScript]);

  const handleArgChange = (name: string, value: string) => {
    setArgValues((prev) => ({ ...prev, [name]: value }));
  };

  /** Stop a running script. */
  const handleStop = () => {
    abortRef.current?.abort();
  };

  /** Execute the selected script via SSE streaming endpoint. */
  const handleRun = async () => {
    if (!selectedScript) return;

    // Abort any previous run
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setLines([]);
    setError(null);
    setExitCode(null);
    setElapsed(0);
    setOutputFiles([]);

    // Start elapsed timer
    const start = Date.now();
    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - start) / 1000));
    }, 1000);

    // Build args
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

        // Parse SSE events from the buffer
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? ""; // keep incomplete chunk

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
              setExitCode(payload.code);
              if (payload.code !== 0) {
                setError(`Script exited with code ${payload.code}`);
              }
              // Fetch output files if this script produces them
              if (selectedScript.outputs_dir) {
                try {
                  const outRes = await fetch(`${API_BASE}/outputs/${selectedScript.name}`);
                  if (outRes.ok) {
                    const files: OutputFile[] = await outRes.json();
                    setOutputFiles(files);
                  }
                } catch {
                  /* ignore */
                }
              }
            }
          } catch {
            // Ignore malformed SSE data
          }
        }
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") {
        setLines((prev) => [
          ...prev,
          { type: "info", text: "⏹ Script execution stopped by user." },
        ]);
      } else {
        setError("Failed to run script. Check the backend connection.");
      }
    } finally {
      setLoading(false);
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
  };

  // Auto-scroll console on new lines.
  useEffect(() => {
    if (consoleRef.current) {
      consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
    }
  }, [lines]);

  const inputTypeFor = (argType: string): string => {
    switch (argType) {
      case "int":
      case "float":
        return "number";
      default:
        return "text";
    }
  };

  const prettyName = (name: string) =>
    name.replace(".py", "").replace(/_/g, " ");

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
          <div className="absolute -bottom-1 -right-1 h-6 w-6 rounded-lg bg-gradient-to-br from-indigo-500/20 to-violet-500/20 border border-indigo-500/10 flex items-center justify-center">
            <svg className="h-3 w-3 text-indigo-400/70" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.042 21.672L13.684 16.6m0 0l-2.51 2.225.569-9.47 5.227 7.917-3.286-.672zM12 2.25V4.5m5.834.166l-1.591 1.591M20.25 10.5H18M7.757 14.743l-1.59 1.59M6 10.5H3.75m4.007-4.243l-1.59-1.59" />
            </svg>
          </div>
        </div>
        <h3 className="ds-page-title text-lg mb-2">No Script Selected</h3>
        <p className="ds-page-subtitle max-w-sm">
          {scripts.length === 0
            ? "No scripts found. Add .py files to backend/scripts/."
            : "Select a script from the sidebar to get started."}
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Script Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500/15 to-violet-500/15 border border-indigo-500/10">
              <svg className="h-5 w-5 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5" />
              </svg>
            </div>
            <div>
              <h2 className="ds-page-title capitalize">
                {prettyName(selectedScript.name)}
              </h2>
              {selectedScript.description && (
                <p className="ds-page-subtitle mt-0.5">
                  {selectedScript.description}
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Status indicator */}
        <div className="flex items-center gap-2">
          {loading && (
            <span className="ds-badge ds-badge-warning">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
              Running · {elapsed}s
            </span>
          )}
          {exitCode !== null && !loading && (
            <span
              className={`ds-badge ${
                exitCode === 0 ? "ds-badge-success" : "ds-badge-error"
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  exitCode === 0 ? "bg-green-400" : "bg-red-400"
                }`}
              />
              {exitCode === 0 ? "Success" : `Exit ${exitCode}`}
            </span>
          )}
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="rounded-xl border border-red-500/15 bg-red-500/[0.06] px-4 py-3 text-sm text-red-300 flex items-center gap-3">
          <svg className="h-4 w-4 shrink-0 text-red-400/80" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
          </svg>
          {error}
        </div>
      )}

      {/* Arguments + Run */}
      <div className="ds-card overflow-hidden">
        <div className="ds-card-header flex items-center justify-between">
          <div className="flex items-center gap-2">
            <svg className="h-4 w-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 6h9.75M10.5 6a1.5 1.5 0 11-3 0m3 0a1.5 1.5 0 10-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-9.75 0h9.75" />
            </svg>
            <h3 className="text-sm font-semibold text-gray-300">
              Configuration
            </h3>
            {selectedScript.args.length > 0 && (
              <span className="text-[10px] text-gray-500 bg-white/[0.04] px-1.5 py-0.5 rounded">
                {selectedScript.args.length} {selectedScript.args.length === 1 ? "param" : "params"}
              </span>
            )}
          </div>
        </div>

        <div className="p-5">
          {selectedScript.args.length === 0 ? (
            <p className="text-sm text-gray-500 italic">This script takes no arguments.</p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              {selectedScript.args.map((arg) => (
                <div key={arg.name} className="space-y-1.5">
                  <label className="ds-label flex items-baseline gap-2">
                    {arg.name}
                    <span className="font-normal normal-case text-gray-600">
                      ({arg.type})
                    </span>
                    {arg.required && (
                      <span className="text-red-400 text-[10px]">*</span>
                    )}
                  </label>
                  {arg.description && (
                    <p className="text-[11px] text-gray-500 leading-relaxed">{arg.description}</p>
                  )}
                  {arg.type === "bool" ? (
                    <button
                      type="button"
                      onClick={() =>
                        handleArgChange(
                          arg.name,
                          argValues[arg.name] === "true" ? "false" : "true"
                        )
                      }
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 ${
                        argValues[arg.name] === "true"
                          ? "bg-indigo-600"
                          : "bg-white/[0.08]"
                      }`}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-200 ${
                          argValues[arg.name] === "true"
                            ? "translate-x-6"
                            : "translate-x-1"
                        }`}
                      />
                    </button>
                  ) : (
                    <input
                      type={inputTypeFor(arg.type)}
                      className="ds-input w-full"
                      placeholder={
                        arg.default
                          ? `Default: ${arg.default}`
                          : `Enter ${arg.name}…`
                      }
                      value={argValues[arg.name] ?? ""}
                      onChange={(e) => handleArgChange(arg.name, e.target.value)}
                    />
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Action Buttons Row */}
          <div className="flex items-center gap-3 mt-5 pt-4 border-t border-white/[0.04]">
            <button
              onClick={handleRun}
              disabled={loading || !selectedScript}
              className="ds-btn-primary"
            >
              {loading ? (
                <>
                  <Spinner />
                  Running…
                </>
              ) : (
                <>
                  <PlayIcon />
                  Run Script
                </>
              )}
            </button>

            {loading && (
              <button
                onClick={handleStop}
                className="ds-btn-danger"
              >
                <StopIcon />
                Stop
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Live Console Output */}
      <div className="ds-card overflow-hidden">
        <div className="ds-card-header flex items-center justify-between">
          <div className="flex items-center gap-2">
            <svg className="h-4 w-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0021 18V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v12a2.25 2.25 0 002.25 2.25z" />
            </svg>
            <h3 className="text-sm font-semibold text-gray-300">
              {loading
                ? "Live Console"
                : lines.length > 0
                  ? `Console Output`
                  : "Console"}
            </h3>
            {lines.length > 0 && (
              <span className="text-[10px] text-gray-500 bg-white/[0.04] px-1.5 py-0.5 rounded">
                {lines.length} lines
              </span>
            )}
            {loading && (
              <span className="flex h-2 w-2 rounded-full bg-green-500 animate-pulse" />
            )}
          </div>
          {lines.length > 0 && !loading && (
            <button
              onClick={() => setLines([])}
              className="text-[10px] text-gray-500 hover:text-gray-300 transition-colors"
            >
              Clear
            </button>
          )}
        </div>

        <pre
          ref={consoleRef}
          className="console-output h-80 overflow-y-auto bg-[#0a0c12] p-4 font-[family-name:var(--font-geist-mono)] text-sm leading-relaxed"
        >
          {lines.length === 0 && !loading ? (
            <span className="text-gray-600 italic">
              Output will stream here in real-time when you run a script.
            </span>
          ) : (
            lines.map((line, i) => (
              <div
                key={i}
                className={
                  line.type === "stderr"
                    ? "text-red-400"
                    : line.type === "info"
                      ? "text-yellow-400 italic"
                      : "text-green-400"
                }
              >
                {line.text}
              </div>
            ))
          )}
          {loading && (
            <span className="inline-block animate-pulse text-gray-500">▊</span>
          )}
        </pre>
      </div>

      {/* Output Files */}
      {outputFiles.length > 0 && (
        <div className="ds-card overflow-hidden">
          <div className="ds-card-header flex items-center gap-2">
            <svg className="h-4 w-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
            </svg>
            <h3 className="text-sm font-semibold text-gray-300">Output Files</h3>
            <span className="text-[10px] text-gray-500 bg-white/[0.04] px-1.5 py-0.5 rounded">
              {outputFiles.length} files
            </span>
          </div>
          <div className="p-4 space-y-2 max-h-60 overflow-y-auto">
            {outputFiles.map((file, i) => (
              <div
                key={i}
                className="flex items-center justify-between rounded-[10px] border border-white/[0.06] bg-white/[0.02] px-4 py-2.5 transition-colors hover:bg-white/[0.04]"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <FileIcon />
                  <span className="text-sm text-gray-300 truncate" title={file.name}>
                    {file.name}
                  </span>
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

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function PlayIcon() {
  return (
    <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 20 20">
      <path
        fillRule="evenodd"
        d="M6.3 2.841A1.5 1.5 0 004 4.12V15.88a1.5 1.5 0 002.3 1.279l9.344-5.88a1.5 1.5 0 000-2.557L6.3 2.84z"
        clipRule="evenodd"
      />
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

function FileIcon() {
  return (
    <svg
      className="h-4 w-4 text-gray-500 shrink-0"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
      />
    </svg>
  );
}

function DownloadIcon() {
  return (
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
        d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3"
      />
    </svg>
  );
}
