"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DeviceEntry {
  device_id: string;
  start_time: string;
  end_time: string;
  time_taken: string;
  status: string;
}

interface AnalysisResult {
  build: string;
  tc_id: string;
  branch: string;
  file_name: string;
  description: string;
  service: string;
  device_id: string;
  start_time: string;
  end_time: string;
  time_taken: string;
  test_status: string;
  all_devices: DeviceEntry[];
  log_url: string;
  tc_pid: string;
  total_log_lines: number;
  filtered_log_lines: number;
  log_error: string;
  logs: string[];
  steps: Record<string, string>[];
}

interface SourceResult {
  file_name: string;
  file_path: string;
  branch: string;
  source_code: string;
  github_url: string;
}

interface DeviceLogEntry {
  service: string;
  epoch_ms: number | null;
  level: string;
  line: string;
}

interface DlConsoleLine {
  type: "stdout" | "info" | "error";
  text: string;
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://172.16.23.15:8000";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function TCAnalysis() {
  const [build, setBuild] = useState("");
  const [tcId, setTcId] = useState("");
  const [branch, setBranch] = useState("QA_6.12_20251108_BI");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState<AnalysisResult | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const logRef = useRef<HTMLPreElement>(null);

  // Source code state
  const [activeTab, setActiveTab] = useState<"log" | "source" | "device-log" | "steps">("steps");
  const [sourceData, setSourceData] = useState<SourceResult | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceError, setSourceError] = useState("");
  const [sourceSearch, setSourceSearch] = useState("");
  const sourceRef = useRef<HTMLPreElement>(null);
  const [deviceLoading, setDeviceLoading] = useState(false);

  // ── Device Logs tab state ──
  const [dlDownloading, setDlDownloading] = useState(false);
  const [dlConsoleLines, setDlConsoleLines] = useState<DlConsoleLine[]>([]);
  const [dlExitCode, setDlExitCode] = useState<number | null>(null);
  const [dlElapsed, setDlElapsed] = useState(0);
  const dlTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const dlAbortRef = useRef<AbortController | null>(null);
  const dlConsoleRef = useRef<HTMLPreElement>(null);
  const [dlServices, setDlServices] = useState<string[]>([]);
  const [dlSelectedServices, setDlSelectedServices] = useState<Set<string>>(new Set());
  const [dlLogs, setDlLogs] = useState<DeviceLogEntry[]>([]);
  const [dlLogCount, setDlLogCount] = useState(0);
  const [dlError, setDlError] = useState<string | null>(null);
  const [dlSearch, setDlSearch] = useState("");
  const [dlLevelFilter, setDlLevelFilter] = useState<Set<string>>(new Set());
  const [dlLoadingLogs, setDlLoadingLogs] = useState(false);
  const [dlAutoStatus, setDlAutoStatus] = useState<"idle" | "checking" | "downloading" | "loading" | "done" | "error">("idle");
  const [dlMatchedService, setDlMatchedService] = useState("");
  const [dlServiceExpanded, setDlServiceExpanded] = useState(false);
  const [dlVisibleCount, setDlVisibleCount] = useState(500);

  // ── AI Analysis state ──
  const [aiLoading, setAiLoading] = useState(false);
  const [aiResult, setAiResult] = useState("");
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiExpanded, setAiExpanded] = useState(true);
  const [aiModel, setAiModel] = useState("qwen2.5-coder:7b");
  const [aiModels, setAiModels] = useState<{id:string;label:string;size:string}[]>([]);
  const [aiElapsed, setAiElapsed] = useState(0);
  const [aiStatus, setAiStatus] = useState<string>(""); // "processing" | "streaming" | ""
  const [aiDeepProgress, setAiDeepProgress] = useState<{phase:string; chunk:number; total:number; label?:string; status?:string; preview?:string}|null>(null);
  const aiRef = useRef<HTMLDivElement>(null);
  const aiTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Fetch available AI models on mount
  useEffect(() => {
    fetch(`${API_BASE}/tc-analysis/ai/models`)
      .then(r => r.json())
      .then(d => {
        if (d.models) setAiModels(d.models);
        if (d.default) setAiModel(d.default);
      })
      .catch(() => {});
  }, []);

  const fetchSource = useCallback(async (branchName: string, fileName: string) => {
    if (!branchName || !fileName) return;
    setSourceLoading(true);
    setSourceError("");
    setSourceData(null);
    try {
      const res = await fetch(`${API_BASE}/tc-source`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branch: branchName, file_name: fileName }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.detail || `HTTP ${res.status}`);
      setSourceData(body as SourceResult);
    } catch (e) {
      setSourceError(e instanceof Error ? e.message : "Failed to fetch source");
    } finally {
      setSourceLoading(false);
    }
  }, []);

  const fetchAnalysis = useCallback(async () => {
    if (!build.trim() || !tcId.trim()) {
      setError("Build number and TC ID are required.");
      return;
    }
    setError("");
    setLoading(true);
    setData(null);
    setSourceData(null);
    setSourceError("");
    setActiveTab("steps");
    // Reset device-log state so auto-flow re-runs for the new TC
    setDlAutoStatus("idle");
    setDlMatchedService("");
    setDlServices([]);
    setDlSelectedServices(new Set());
    setDlLogs([]);
    setDlLogCount(0);
    setDlError(null);
    setDlLevelFilter(new Set());
    setDlConsoleLines([]);
    setDlExitCode(null);

    try {
      const res = await fetch(`${API_BASE}/tc-analysis`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          build: build.trim(),
          tc_id: tcId.trim(),
          branch: branch.trim(),
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.detail || `HTTP ${res.status}`);
      const result = body as AnalysisResult;
      setData(result);

      // Auto-fetch source code if branch is provided
      if (branch.trim() && result.file_name) {
        fetchSource(branch.trim(), result.file_name);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [build, tcId, branch, fetchSource]);

  // Fetch logs for a specific device (re-uses cached scr.js on backend)
  const fetchForDevice = useCallback(async (deviceId: string) => {
    if (!data || deviceId === data.device_id) return;
    setDeviceLoading(true);
    setActiveTab("steps");
    setSearchTerm("");
    // Reset device-log state so auto-flow re-runs for the new device
    setDlAutoStatus("idle");
    setDlMatchedService("");
    setDlLogs([]);
    setDlLogCount(0);
    try {
      const res = await fetch(`${API_BASE}/tc-analysis`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          build: data.build,
          tc_id: data.tc_id,
          branch: data.branch,
          device_id: deviceId,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.detail || `HTTP ${res.status}`);
      setData(body as AnalysisResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to switch device");
    } finally {
      setDeviceLoading(false);
    }
  }, [data]);

  // Auto-scroll log to top when data arrives
  useEffect(() => {
    if (data && logRef.current) {
      logRef.current.scrollTop = 0;
    }
  }, [data]);

  // Auto-scroll device log console to bottom
  useEffect(() => {
    if (dlConsoleRef.current) {
      dlConsoleRef.current.scrollTop = dlConsoleRef.current.scrollHeight;
    }
  }, [dlConsoleLines]);

  // When Device Logs tab becomes active (or data changes while on the tab), run auto flow
  useEffect(() => {
    if (activeTab === "device-log" && data && dlAutoStatus === "idle") {
      runAutoFlow(data);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, data]);

  const statusColor = (s: string) => {
    const u = s?.toUpperCase();
    if (u === "PASS") return "text-emerald-400";
    if (u === "FAIL") return "text-red-400";
    return "text-amber-400";
  };

  const downloadLogs = () => {
    if (!data) return;
    const content = data.logs.join("\n");
    const blob = new Blob([content], { type: "text/plain;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${data.tc_id}_${data.device_id}_build${data.build}_logs.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const downloadSource = () => {
    if (!sourceData) return;
    const blob = new Blob([sourceData.source_code], { type: "text/plain;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = sourceData.file_name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // ── Device Logs helpers ──

  /** Derive device/date/epoch from current TC result. */
  const dlDeviceId = data?.device_id ?? "";
  const dlDate = data?.start_time?.slice(0, 10) ?? "";
  // TC times are in UTC (format "YYYY-MM-DD HH:MM:SS")
  const dlStartEpochMs = data?.start_time
    ? new Date(data.start_time.replace(" ", "T") + "Z").getTime()
    : null;
  const dlEndEpochMs = data?.end_time
    ? new Date(data.end_time.replace(" ", "T") + "Z").getTime()
    : null;

  const fetchDlFiles = async (devId: string, date: string): Promise<string[]> => {
    if (!devId || !date) return [];
    try {
      const res = await fetch(
        `${API_BASE}/device-logs/files?device_id=${encodeURIComponent(devId)}&date=${encodeURIComponent(date)}`
      );
      if (!res.ok) return [];
      const d = await res.json();
      const files: string[] = d.files ?? [];
      setDlServices(files);
      return files;
    } catch {
      return [];
    }
  };

  const handleDlDownload = async (devIdOverride?: string, dateOverride?: string): Promise<number> => {
    const devId = devIdOverride ?? dlDeviceId;
    const date = dateOverride ?? dlDate;
    if (!devId || !date) return -1;
    dlAbortRef.current?.abort();
    const controller = new AbortController();
    dlAbortRef.current = controller;

    setDlDownloading(true);
    setDlConsoleLines([]);
    setDlExitCode(null);
    setDlElapsed(0);
    setDlServices([]);
    setDlLogs([]);
    setDlError(null);

    const start = Date.now();
    dlTimerRef.current = setInterval(() => {
      setDlElapsed(Math.floor((Date.now() - start) / 1000));
    }, 1000);

    let exitCode: number | null = null;
    try {
      const res = await fetch(`${API_BASE}/device-logs/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_id: devId, date }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => `HTTP ${res.status}`);
        throw new Error(`HTTP ${res.status}: ${errText.slice(0, 200)}`);
      }
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
          const dataLine = part.split("\n").find((l) => l.startsWith("data: "));
          if (!dataLine) continue;
          try {
            const ev = JSON.parse(dataLine.slice(6));
            if (ev.type === "stdout") {
              setDlConsoleLines((prev) => [...prev, { type: "stdout", text: ev.text }]);
            } else if (ev.type === "exit") {
              exitCode = ev.code as number;
              setDlExitCode(ev.code);
            }
          } catch { /* ignore */ }
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== "AbortError") {
        setDlConsoleLines((prev) => [
          ...prev,
          { type: "error", text: `Error: ${err.message}` },
        ]);
      }
    } finally {
      if (dlTimerRef.current) clearInterval(dlTimerRef.current);
      setDlDownloading(false);
      await fetchDlFiles(devId, date);
    }
    return exitCode ?? -1;
  };

  const handleDlLoadLogs = async (servicesOverride?: string[]) => {
    if (!dlDeviceId || !dlDate) return;
    setDlLoadingLogs(true);
    setDlLogs([]);
    setDlError(null);
    try {
      const res = await fetch(`${API_BASE}/device-logs/read`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          device_id: dlDeviceId,
          date: dlDate,
          start_epoch_ms: dlStartEpochMs,
          end_epoch_ms: dlEndEpochMs,
          services: servicesOverride ?? (dlSelectedServices.size > 0 ? Array.from(dlSelectedServices) : []),
        }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({ detail: `HTTP ${res.status}` }));
        throw new Error(detail.detail ?? `HTTP ${res.status}`);
      }
      const d = await res.json();
      setDlLogs(d.logs ?? []);
      setDlLogCount(d.count ?? 0);
    } catch (err: unknown) {
      setDlError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setDlLoadingLogs(false);
    }
  };

  const runAutoFlow = async (analysisData: AnalysisResult) => {
    setDlAutoStatus("checking");
    setDlLogs([]);
    setDlLogCount(0);
    setDlError(null);
    setDlLevelFilter(new Set());
    setDlMatchedService("");
    setDlConsoleLines([]);
    setDlExitCode(null);

    // Service comes directly from the analysis result (e.g. "APM").
    // Fall back to parsing tc_id only if service field is empty.
    const service = (analysisData.service?.trim() || extractServiceName(analysisData.tc_id)).toUpperCase();
    const devId = analysisData.device_id;
    const date = analysisData.start_time?.slice(0, 10) ?? "";

    if (!devId || !date) {
      setDlAutoStatus("error");
      setDlError("Device ID or date missing from TC analysis result.");
      return;
    }

    // Step 1 — check for already-downloaded files
    let files = await fetchDlFiles(devId, date);

    // Step 2 — download from S3 if nothing local
    if (files.length === 0) {
      setDlAutoStatus("downloading");
      const exitCode = await handleDlDownload(devId, date);
      if (exitCode !== 0) {
        setDlAutoStatus("error");
        setDlError(
          exitCode === -1
            ? "Download request failed — see console output above for details."
            : "Download failed — see console output above for details."
        );
        return;
      }
      files = await fetchDlFiles(devId, date);
    }

    if (files.length === 0) {
      setDlAutoStatus("error");
      setDlError(
        "Download completed but no log files were found in the output directory. " +
        "Check the console output — the S3 bucket may have no logs for this device/date."
      );
      return;
    }

    // Step 3 — Default: select ONLY the exact service match (e.g. "apm").
    // The "_c" (critical) and other variants are available via checkboxes
    // but not selected by default.
    const exactMatch = service
      ? files.filter(f => f.toUpperCase() === service)
      : [];

    // Fallback: if no exact match, try files containing the service name
    const fallbackMatch = exactMatch.length === 0 && service
      ? files.filter(f => f.toUpperCase().includes(service))
      : [];

    const defaultSelected = exactMatch.length > 0
      ? exactMatch
      : fallbackMatch.length > 0
        ? fallbackMatch
        : [];

    const displayLabel = exactMatch.length > 0
      ? service
      : fallbackMatch.length > 0
        ? `~${service}`
        : "none";
    setDlSelectedServices(new Set(defaultSelected));
    setDlMatchedService(displayLabel);

    // Step 4 — load ALL service logs; dlSelectedServices drives the display filter
    setDlAutoStatus("loading");
    await handleDlLoadLogs([]);
    setDlAutoStatus("done");
  };

  // Filter log lines by search term (memoized)
  const searchTermLower = searchTerm.toLowerCase();
  const filteredLogs = useMemo(() => {
    if (!data) return [];
    if (!searchTerm) return data.logs;
    return data.logs.filter((l) => l.toLowerCase().includes(searchTermLower));
  }, [data, searchTerm, searchTermLower]);

  // Filter source lines by search term (memoized)
  const sourceLines = useMemo(() => sourceData ? sourceData.source_code.split("\n") : [], [sourceData]);
  const sourceSearchLower = sourceSearch.toLowerCase();
  const filteredSourceLines = useMemo(() => {
    if (!sourceSearch) return sourceLines;
    return sourceLines.filter((l) => l.toLowerCase().includes(sourceSearchLower));
  }, [sourceLines, sourceSearch, sourceSearchLower]);

  // Device log filtering — memoised to avoid recomputing on every render
  const dlSearchLower = dlSearch.trim().toLowerCase();
  const dlFilteredLogs = useMemo(() => {
    setDlVisibleCount(500); // reset pagination when filters change
    return dlLogs.filter((l) => {
      if (dlSelectedServices.size > 0 && !dlSelectedServices.has(l.service)) return false;
      if (dlLevelFilter.size > 0 && !dlLevelFilter.has(l.level)) return false;
      if (dlSearchLower && !l.line.toLowerCase().includes(dlSearchLower)) return false;
      return true;
    });
  }, [dlLogs, dlSelectedServices, dlLevelFilter, dlSearchLower]);
  const dlLevelCounts = useMemo(() => dlLogs.reduce<Record<string, number>>((acc, l) => {
    acc[l.level] = (acc[l.level] ?? 0) + 1;
    return acc;
  }, {}), [dlLogs]);
  const dlServiceCounts = useMemo(() => dlLogs.reduce<Record<string, number>>((acc, l) => {
    acc[l.service] = (acc[l.service] ?? 0) + 1;
    return acc;
  }, {}), [dlLogs]);
  // Build complete service list: merge downloaded files + any services found in logs
  const allDlServices = useMemo(() => Array.from(
    new Set([...dlServices, ...Object.keys(dlServiceCounts)])
  ).sort((a, b) => a.localeCompare(b)), [dlServices, dlServiceCounts]);

  // ── AI Analysis ──
  const runAiAnalysis = useCallback(async () => {
    if (!data) return;
    setAiLoading(true);
    setAiResult("");
    setAiError(null);
    setAiExpanded(true);
    setAiElapsed(0);
    setAiStatus("processing");
    if (aiTimerRef.current) clearInterval(aiTimerRef.current);
    const t0 = Date.now();
    aiTimerRef.current = setInterval(() => setAiElapsed(Math.floor((Date.now() - t0) / 1000)), 1000);

    // ── SMART FILTERING: send only the critical window of data ──

    // 1. Steps — send all (they're small)
    const stepsText = (data.steps || []).map(s => {
      const [desc, status] = Object.entries(s)[0] ?? ["", ""];
      return `[${String(status).padEnd(5)}] ${desc}`;
    }).join("\n");

    // 2. Find the failed step(s)
    const failedSteps = (data.steps || []).filter(s => {
      const status = String(Object.values(s)[0] ?? "").trim().toUpperCase();
      return status === "FAIL" || status === "FALSE" || status === "0";
    });
    const failedStep = failedSteps.map(s => {
      const [desc, status] = Object.entries(s)[0] ?? ["", ""];
      return `[${status}] ${desc}`;
    }).join("\n") || "(no explicit failed step found)";

    // 3. Automation logs — find failure boundary and take context around it
    //    Strategy: find the LAST line containing fail/error/assert/exception/traceback,
    //    then take 50 lines BEFORE and 20 lines AFTER that point.
    //    If no such line found, take the last 100 lines.
    const autoLogsArr = data.logs;
    let failLineIdx = -1;
    const failPatterns = /\b(fail|error|exception|assert|traceback|timeout|refused|abort)\b/i;
    for (let i = autoLogsArr.length - 1; i >= 0; i--) {
      if (failPatterns.test(autoLogsArr[i])) {
        failLineIdx = i;
        break;
      }
    }
    let autoLogSlice: string[];
    if (failLineIdx >= 0) {
      const start = Math.max(0, failLineIdx - 50);
      const end = Math.min(autoLogsArr.length, failLineIdx + 20);
      autoLogSlice = autoLogsArr.slice(start, end);
      // Annotate where the failure line is
      const relIdx = failLineIdx - start;
      autoLogSlice[relIdx] = `>>> ${autoLogSlice[relIdx]}`;
    } else {
      // No obvious failure line — send last 100 lines
      autoLogSlice = autoLogsArr.slice(-100);
    }
    const autoLogs = autoLogSlice.join("\n");

    // 4. Device logs — ±30 sec window around the test's end_time
    //    end_time is when the failure happened
    let devLogSlice: DeviceLogEntry[] = [];
    const endTimeMs = data.end_time ? new Date(data.end_time.replace(" ", "T") + "Z").getTime() : null;
    if (endTimeMs && !isNaN(endTimeMs)) {
      const windowMs = 30_000; // ±30 seconds
      devLogSlice = dlFilteredLogs.filter(e =>
        e.epoch_ms != null &&
        e.epoch_ms >= endTimeMs - windowMs &&
        e.epoch_ms <= endTimeMs + windowMs
      );
      // If window is empty (timestamp mismatch), try last 60 entries
      if (devLogSlice.length === 0) {
        devLogSlice = dlFilteredLogs.slice(-60);
      }
    } else {
      // No timestamp available — take last 60 entries
      devLogSlice = dlFilteredLogs.slice(-60);
    }
    // Cap at 200 entries max
    if (devLogSlice.length > 200) devLogSlice = devLogSlice.slice(-200);
    const devLogs = devLogSlice.map(e => {
      const ts = e.epoch_ms ? new Date(e.epoch_ms).toISOString().replace("T", " ").slice(0, 19) : "—";
      return `${ts}  ${e.service}  ${e.level}  ${parseDlMessage(e.line)}`;
    }).join("\n");

    // 5. Source code — extract only the test function if possible
    let testCode = sourceData?.source_code ?? "(source code not available)";
    if (sourceData?.source_code && data.file_name) {
      // Try to extract the test function: look for "def test_..." or the TC class
      const lines = sourceData.source_code.split("\n");
      const tcName = data.tc_id.toLowerCase().replace(/-/g, "_");
      // Find function start
      let funcStart = -1;
      let funcEnd = lines.length;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].toLowerCase();
        if (line.includes("def ") && line.includes("test") && (line.includes(tcName) || funcStart === -1)) {
          if (funcStart !== -1 && line.includes(tcName)) {
            // Found exact match, override
            funcStart = i;
          } else if (funcStart === -1) {
            funcStart = i;
          }
        }
      }
      if (funcStart >= 0) {
        // Find function end: next def/class at same or lower indent, or EOF
        const baseIndent = lines[funcStart].search(/\S/);
        for (let i = funcStart + 1; i < lines.length; i++) {
          const trimmed = lines[i].trimStart();
          if (trimmed === "") continue;
          const indent = lines[i].search(/\S/);
          if (indent <= baseIndent && (trimmed.startsWith("def ") || trimmed.startsWith("class "))) {
            funcEnd = i;
            break;
          }
        }
        // Include 5 lines before for imports/decorators
        const contextStart = Math.max(0, funcStart - 5);
        testCode = `(Extracted test function, lines ${contextStart + 1}-${funcEnd})\n` +
          lines.slice(contextStart, funcEnd).join("\n");
      }
      // If extracted code is still huge (>300 lines), truncate
      const extractedLines = testCode.split("\n");
      if (extractedLines.length > 300) {
        testCode = extractedLines.slice(0, 300).join("\n") + "\n... (truncated at 300 lines)";
      }
    }

    // Log what we're sending (for debugging in browser console)
    console.log(`[AI] Sending: steps=${stepsText.split("\\n").length}, autoLogs=${autoLogSlice.length} lines, devLogs=${devLogSlice.length} entries, code=${testCode.split("\\n").length} lines`);

    try {
      const res = await fetch(`${API_BASE}/tc-analysis/ai`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          test_steps: stepsText,
          failed_step: failedStep,
          automation_logs: autoLogs,
          device_logs: devLogs,
          test_code: testCode,
          model: aiModel,
        }),
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

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
          const dataLine = part.split("\n").find(l => l.startsWith("data: "));
          if (!dataLine) continue;
          try {
            const ev = JSON.parse(dataLine.slice(6));
            if (ev.error) {
              setAiError(ev.error);
              if (aiTimerRef.current) clearInterval(aiTimerRef.current);
              setAiLoading(false);
              setAiStatus("");
              return;
            }
            if (ev.status === "processing" && !ev.token) {
              setAiStatus("processing");
              continue;
            }
            if (ev.token) {
              setAiStatus("streaming");
              setAiResult(prev => prev + ev.token);
            }
            if (ev.done) {
              if (aiTimerRef.current) clearInterval(aiTimerRef.current);
              setAiLoading(false);
              setAiStatus("");
              return;
            }
          } catch { /* ignore parse errors */ }
        }
      }
      if (aiTimerRef.current) clearInterval(aiTimerRef.current);
      setAiLoading(false);
      setAiStatus("");
    } catch (e) {
      setAiError(e instanceof Error ? e.message : "AI analysis failed");
      if (aiTimerRef.current) clearInterval(aiTimerRef.current);
      setAiLoading(false);
      setAiStatus("");
    }
  }, [data, dlFilteredLogs, sourceData, aiModel]);

  // ── Deep Analysis (Map-Reduce) ──
  const runDeepAnalysis = useCallback(async () => {
    if (!data) return;
    setAiLoading(true);
    setAiResult("");
    setAiError(null);
    setAiExpanded(true);
    setAiElapsed(0);
    setAiStatus("deep");
    setAiDeepProgress(null);
    if (aiTimerRef.current) clearInterval(aiTimerRef.current);
    const t0 = Date.now();
    aiTimerRef.current = setInterval(() => setAiElapsed(Math.floor((Date.now() - t0) / 1000)), 1000);

    // Send ALL data — no smart filtering, the backend will chunk it
    const stepsText = (data.steps || []).map(s => {
      const [desc, status] = Object.entries(s)[0] ?? ["", ""];
      return `[${String(status).padEnd(5)}] ${desc}`;
    }).join("\n");

    const failedStep = (data.steps || []).filter(s => {
      const status = String(Object.values(s)[0] ?? "").trim().toUpperCase();
      return status === "FAIL" || status === "FALSE" || status === "0";
    }).map(s => {
      const [desc, status] = Object.entries(s)[0] ?? ["", ""];
      return `[${status}] ${desc}`;
    }).join("\n") || "(no explicit failed step found)";

    // ALL automation logs
    const autoLogs = data.logs.join("\n");

    // ALL device logs (unfiltered from dlLogs, not dlFilteredLogs)
    const devLogs = dlLogs.map(e => {
      const ts = e.epoch_ms ? new Date(e.epoch_ms).toISOString().replace("T", " ").slice(0, 19) : "—";
      return `${ts}  ${e.service}  ${e.level}  ${parseDlMessage(e.line)}`;
    }).join("\n");

    // Full source code
    const testCode = sourceData?.source_code ?? "(source code not available)";

    console.log(`[Deep AI] Sending ALL data: autoLogs=${data.logs.length} lines, devLogs=${dlLogs.length} entries, code=${testCode.split("\\n").length} lines`);

    try {
      const res = await fetch(`${API_BASE}/tc-analysis/ai/deep`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          test_steps: stepsText,
          failed_step: failedStep,
          automation_logs: autoLogs,
          device_logs: devLogs,
          test_code: testCode,
          model: aiModel,
        }),
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
          const dataLine = part.split("\n").find(l => l.startsWith("data: "));
          if (!dataLine) continue;
          try {
            const ev = JSON.parse(dataLine.slice(6));
            if (ev.error) {
              setAiError(ev.error);
              if (aiTimerRef.current) clearInterval(aiTimerRef.current);
              setAiLoading(false);
              setAiStatus("");
              setAiDeepProgress(null);
              return;
            }
            // Map phase progress
            if (ev.phase === "map") {
              setAiDeepProgress({
                phase: "map",
                chunk: ev.chunk ?? 0,
                total: ev.total ?? 0,
                label: ev.label,
                status: ev.status,
                preview: ev.summary_preview,
              });
              continue;
            }
            // Reduce phase
            if (ev.phase === "reduce") {
              if (ev.status === "starting") {
                setAiDeepProgress({ phase: "reduce", chunk: 0, total: 0, status: "starting" });
                setAiStatus("streaming");
                continue;
              }
              if (ev.token) {
                setAiResult(prev => prev + ev.token);
              }
              if (ev.done) {
                if (aiTimerRef.current) clearInterval(aiTimerRef.current);
                setAiLoading(false);
                setAiStatus("");
                setAiDeepProgress(null);
                return;
              }
            }
          } catch { /* ignore */ }
        }
      }
      if (aiTimerRef.current) clearInterval(aiTimerRef.current);
      setAiLoading(false);
      setAiStatus("");
      setAiDeepProgress(null);
    } catch (e) {
      setAiError(e instanceof Error ? e.message : "Deep analysis failed");
      if (aiTimerRef.current) clearInterval(aiTimerRef.current);
      setAiLoading(false);
      setAiStatus("");
      setAiDeepProgress(null);
    }
  }, [data, dlLogs, sourceData, aiModel]);

  // ── Open current tab content in a new browser window ──
  const openTabInNewWindow = (tabName: string) => {
    if (!data) return;
    const isDark = !document.documentElement.classList.contains('light');
    let content = '';
    let title = '';

    if (tabName === 'log') {
      title = `Automation Log — ${data.tc_id} — Build #${data.build}`;
      content = filteredLogs.join('\n');
    } else if (tabName === 'source' && sourceData) {
      title = `Source — ${sourceData.file_name} — ${sourceData.branch}`;
      content = sourceData.source_code;
    } else if (tabName === 'device-log') {
      title = `Device Logs — ${data.device_id} — ${dlDate}`;
      content = dlFilteredLogs.map(e => {
        const ts = e.epoch_ms ? new Date(e.epoch_ms).toISOString().replace('T', ' ').slice(0, 19) : '—';
        return `${ts}  ${e.service.padEnd(12)}  ${e.level}  ${parseDlMessage(e.line)}`;
      }).join('\n');
    } else if (tabName === 'steps') {
      title = `Executed Steps — ${data.tc_id}`;
      content = (data.steps || []).map(s => {
        const [desc, status] = Object.entries(s)[0] ?? ['', ''];
        return `[${String(status).padEnd(5)}] ${desc}`;
      }).join('\n');
    } else if (tabName === 'ai') {
      title = `AI Analysis — ${data.tc_id} — Build #${data.build}`;
      content = aiResult;
    } else return;

    const escaped = content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const win = window.open('', '_blank');
    if (!win) return;
    win.document.write(`<!DOCTYPE html>
<html><head><title>${title}</title><style>
  body { margin:0; padding:24px 32px; font-family:'SF Mono','JetBrains Mono','Fira Code','Consolas',monospace; font-size:13px; line-height:1.7; white-space:pre-wrap; word-wrap:break-word; background:${isDark ? '#0f1117' : '#fff'}; color:${isDark ? '#d1d5db' : '#374151'}; }
  h1 { font-family:-apple-system,system-ui,sans-serif; font-size:16px; font-weight:600; margin:0 0 16px; padding-bottom:12px; border-bottom:1px solid ${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'}; color:${isDark ? '#fff' : '#111827'}; }
</style></head><body><h1>${title}</h1>${escaped}</body></html>`);
    win.document.close();
  };

  return (
    <div className="max-w-[1600px] mx-auto">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-1.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500/20 to-purple-500/20 border border-violet-500/10">
            <svg className="h-4.5 w-4.5 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m5.231 13.481L15 17.25m-4.5-15H5.625c-.621 0-1.125.504-1.125 1.125v16.5c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9zm3.75 11.625a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
            </svg>
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-white">
              TC Analysis
            </h1>
            <p className="text-xs text-gray-500">
              Fetch automation logs for a specific test case from Jenkins
            </p>
          </div>
        </div>
      </div>

      {/* Input form */}
      <div className="rounded-xl border border-white/[0.06] bg-[#161922] p-5 mb-6">
        <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr_1fr_auto] gap-4 items-end">
          {/* Build Number */}
          <div>
            <label className="block text-[11px] font-medium text-gray-500 uppercase tracking-wider mb-1.5">
              Build Number
            </label>
            <input
              value={build}
              onChange={(e) => setBuild(e.target.value)}
              placeholder="e.g. 1169"
              className="w-full rounded-lg border border-white/10 bg-[#0f1117] px-3 py-2 text-sm text-gray-300 placeholder-gray-600 focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/20 outline-none transition"
            />
          </div>

          {/* TC ID */}
          <div>
            <label className="block text-[11px] font-medium text-gray-500 uppercase tracking-wider mb-1.5">
              TC ID
            </label>
            <input
              value={tcId}
              onChange={(e) => setTcId(e.target.value)}
              placeholder="e.g. TC-185"
              className="w-full rounded-lg border border-white/10 bg-[#0f1117] px-3 py-2 text-sm text-gray-300 placeholder-gray-600 focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/20 outline-none transition"
            />
          </div>

          {/* Branch */}
          <div>
            <label className="block text-[11px] font-medium text-gray-500 uppercase tracking-wider mb-1.5">
              Branch <span className="text-gray-700">(optional)</span>
            </label>
            <input
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="e.g. release/5.6.13"
              className="w-full rounded-lg border border-white/10 bg-[#0f1117] px-3 py-2 text-sm text-gray-300 placeholder-gray-600 focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/20 outline-none transition"
            />
          </div>

          {/* Analyse button */}
          <button
            onClick={fetchAnalysis}
            disabled={loading}
            className="flex items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-violet-600 to-purple-600 px-5 py-2 text-sm font-semibold text-white shadow-lg shadow-violet-500/20 hover:shadow-violet-500/30 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
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
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
                </svg>
                Analyse
              </>
            )}
          </button>
        </div>

        {error && (
          <div className="mt-3 rounded-lg border border-red-500/20 bg-red-500/8 px-4 py-2.5 text-sm text-red-400">
            {error}
          </div>
        )}
      </div>

      {/* Placeholder */}
      {!data && !loading && !error && (
        <div className="text-center py-20 text-gray-600">
          <svg className="h-12 w-12 mx-auto mb-3 text-gray-700" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m5.231 13.481L15 17.25m-4.5-15H5.625c-.621 0-1.125.504-1.125 1.125v16.5c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9zm3.75 11.625a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
          </svg>
          <p className="text-sm">Enter a build number and TC ID to fetch automation logs.</p>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-20 gap-3 text-gray-500">
          <svg className="h-5 w-5 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span className="text-sm">Fetching report & extracting logs…</span>
        </div>
      )}

      {/* Results */}
      {data && !loading && (
        <div className="space-y-5">
          {/* ── TC Info Cards ── */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* TC Details */}
            <div className="rounded-xl border border-violet-500/20 bg-[#161922] p-5">
              <h3 className="text-xs font-semibold text-violet-400 uppercase tracking-wider mb-3">
                Test Case Info
              </h3>
              <div className="space-y-2.5 text-sm">
                <InfoRow label="TC ID" value={data.tc_id} />
                <InfoRow label="File" value={data.file_name} />
                <InfoRow label="Description" value={data.description} />
                <InfoRow label="Service" value={data.service} />
                <InfoRow label="Branch" value={data.branch || "—"} />
                <div className="flex items-center gap-2">
                  <span className="text-gray-600 w-24 shrink-0">Status</span>
                  <span className={`font-semibold ${statusColor(data.test_status)}`}>
                    {data.test_status.toUpperCase()}
                  </span>
                </div>
              </div>
            </div>

            {/* Timing */}
            <div className="rounded-xl border border-indigo-500/20 bg-[#161922] p-5">
              <h3 className="text-xs font-semibold text-indigo-400 uppercase tracking-wider mb-3">
                Execution Timing
              </h3>
              <div className="space-y-2.5 text-sm">
                <InfoRow label="Build" value={`#${data.build}`} />
                <InfoRow label="Device ID" value={data.device_id} />
                {data.tc_pid && <InfoRow label="Process ID" value={data.tc_pid} />}
                <InfoRow label="Start Time" value={data.start_time} />
                <InfoRow label="End Time" value={data.end_time} />
                <InfoRow label="Duration" value={data.time_taken} />
              </div>
            </div>

            {/* Device Summary */}
            <div className="rounded-xl border border-sky-500/20 bg-[#161922] p-5">
              <h3 className="text-xs font-semibold text-sky-400 uppercase tracking-wider mb-3">
                Device Execution Summary
              </h3>
              {data.all_devices.length === 0 ? (
                <p className="text-sm text-gray-600">No device entries found.</p>
              ) : (
                <div className="space-y-2">
                  {data.all_devices.map((d, i) => (
                    <button
                      key={i}
                      onClick={() => fetchForDevice(d.device_id)}
                      disabled={deviceLoading}
                      className={`w-full text-left rounded-lg border px-3 py-2 text-xs transition-all duration-150 ${
                        d.device_id === data.device_id
                          ? "border-sky-500/30 bg-sky-500/[0.06] ring-1 ring-sky-500/20"
                          : "border-white/[0.06] bg-white/[0.02] hover:border-sky-500/20 hover:bg-sky-500/[0.03] cursor-pointer"
                      } disabled:opacity-50`}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span className="font-mono text-gray-300">
                          {d.device_id}
                          {d.device_id === data.device_id && (
                            <span className="ml-2 text-[9px] font-sans uppercase tracking-wider text-sky-500">viewing</span>
                          )}
                        </span>
                        <span className={`font-semibold ${statusColor(d.status)}`}>
                          {d.status.toUpperCase()}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 text-gray-500">
                        <span>{d.start_time}</span>
                        <span>→</span>
                        <span>{d.end_time}</span>
                        <span className="text-gray-600 ml-auto">{d.time_taken}</span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* ── Tabbed Panel: Automation Log & Source Code ── */}
          <div className="rounded-xl border border-white/[0.08] bg-[#0d0f15] overflow-hidden relative">
            {/* Device switching overlay */}
            {deviceLoading && (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#0d0f15]/80 backdrop-blur-sm">
                <div className="flex items-center gap-3 text-gray-400">
                  <svg className="h-5 w-5 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  <span className="text-sm">Switching device logs…</span>
                </div>
              </div>
            )}
            {/* Tab bar */}
            <div className="flex items-center border-b border-white/[0.06] bg-[#12141c]">
              <button
                onClick={() => setActiveTab("steps")}
                className={`flex items-center gap-2 px-5 py-3 text-sm font-semibold transition-all duration-150 border-b-2 ${
                  activeTab === "steps"
                    ? "text-amber-400 border-amber-500"
                    : "text-gray-500 border-transparent hover:text-gray-300"
                }`}
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Executed Steps
                {data.steps?.length > 0 && (
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400">
                    {data.steps.length}
                  </span>
                )}
              </button>
              <button
                onClick={() => setActiveTab("source")}
                className={`flex items-center gap-2 px-5 py-3 text-sm font-semibold transition-all duration-150 border-b-2 ${
                  activeTab === "source"
                    ? "text-emerald-400 border-emerald-500"
                    : "text-gray-500 border-transparent hover:text-gray-300"
                }`}
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5" />
                </svg>
                Source Code
                {sourceData && (
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400">
                    {sourceLines.length} lines
                  </span>
                )}
                {sourceLoading && (
                  <svg className="h-3.5 w-3.5 animate-spin text-gray-500" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                )}
              </button>
              <button
                onClick={() => setActiveTab("log")}
                className={`flex items-center gap-2 px-5 py-3 text-sm font-semibold transition-all duration-150 border-b-2 ${
                  activeTab === "log"
                    ? "text-violet-400 border-violet-500"
                    : "text-gray-500 border-transparent hover:text-gray-300"
                }`}
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0021 18V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v12a2.25 2.25 0 002.25 2.25z" />
                </svg>
                Automation Log
                {data.filtered_log_lines > 0 && (
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-400">
                    {data.filtered_log_lines.toLocaleString()}
                  </span>
                )}
              </button>
              <button
                onClick={() => setActiveTab("device-log")}
                className={`flex items-center gap-2 px-5 py-3 text-sm font-semibold transition-all duration-150 border-b-2 ${
                  activeTab === "device-log"
                    ? "text-sky-400 border-sky-500"
                    : "text-gray-500 border-transparent hover:text-gray-300"
                }`}
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 1.5H8.25A2.25 2.25 0 006 3.75v16.5a2.25 2.25 0 002.25 2.25h7.5A2.25 2.25 0 0018 20.25V3.75a2.25 2.25 0 00-2.25-2.25H13.5m-3 0V3h3V1.5m-3 0h3m-3 15.75h3" />
                </svg>
                Device Logs
                {dlLogCount > 0 && (
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-400">
                    {dlFilteredLogs.length.toLocaleString()}
                  </span>
                )}
                {dlDownloading && (
                  <svg className="h-3.5 w-3.5 animate-spin text-gray-500" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                )}
              </button>

              {/* Open in new tab button */}
              <div className="ml-auto pr-3">
                <button
                  onClick={() => openTabInNewWindow(activeTab)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.06] border border-white/10 text-[11px] font-medium text-gray-500 hover:bg-white/[0.1] hover:text-gray-200 transition-all duration-150"
                  title="Open in new tab"
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                  </svg>
                  New Tab
                </button>
              </div>
            </div>

            {/* ── Automation Log Tab ── */}
            {activeTab === "log" && (
              <>
                {/* Log header */}
                <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.06] bg-[#12141c]">
                  <div className="flex items-center gap-3">
                    <span className="text-[10px] font-mono text-gray-600 bg-white/[0.04] px-2 py-0.5 rounded">
                      {data.filtered_log_lines.toLocaleString()} lines
                      {data.total_log_lines > 0 && (
                        <span className="text-gray-700"> / {data.total_log_lines.toLocaleString()} total</span>
                      )}
                    </span>
                    {searchTerm && (
                      <span className="text-[10px] font-mono text-amber-500 bg-amber-500/10 px-2 py-0.5 rounded">
                        {filteredLogs.length} matches
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {/* Search */}
                    <div className="relative">
                      <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
                      </svg>
                      <input
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        placeholder="Search logs…"
                        className="pl-8 pr-3 py-1.5 rounded-lg border border-white/10 bg-[#0f1117] text-xs text-gray-300 placeholder-gray-600 w-60 focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/20 outline-none transition"
                      />
                    </div>
                    {/* Download */}
                    <button
                      onClick={downloadLogs}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.06] border border-white/10 text-[11px] font-medium text-gray-300 hover:bg-white/[0.1] hover:text-white transition-all duration-150"
                      title="Download filtered logs"
                    >
                      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                      </svg>
                      Download
                    </button>
                  </div>
                </div>

                {/* Log error */}
                {data.log_error && (
                  <div className="px-5 py-2 border-b border-white/[0.06] bg-amber-500/[0.05]">
                    <span className="text-xs text-amber-400">⚠ {data.log_error}</span>
                  </div>
                )}

                {/* Log content */}
                <pre
                  ref={logRef}
                  className="overflow-auto text-[11px] leading-[1.6] font-mono text-gray-400 p-4 select-text"
                  style={{ maxHeight: "calc(100vh - 480px)", minHeight: "400px" }}
                >
                  {filteredLogs.length > 0 ? (
                    filteredLogs.map((line, i) => (
                      <LogLine key={i} line={line} lineNo={i + 1} searchTerm={searchTerm} />
                    ))
                  ) : (
                    <span className="text-gray-600">No log lines to display.</span>
                  )}
                </pre>
              </>
            )}

            {/* ── Source Code Tab ── */}
            {activeTab === "source" && (
              <>
                {/* Source header */}
                <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.06] bg-[#12141c]">
                  <div className="flex items-center gap-3">
                    {sourceData && (
                      <>
                        <span className="text-[10px] font-mono text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded">
                          {sourceData.file_path}
                        </span>
                        <span className="text-[10px] font-mono text-gray-600 bg-white/[0.04] px-2 py-0.5 rounded">
                          {sourceLines.length} lines
                        </span>
                        {sourceSearch && (
                          <span className="text-[10px] font-mono text-amber-500 bg-amber-500/10 px-2 py-0.5 rounded">
                            {filteredSourceLines.length} matches
                          </span>
                        )}
                      </>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {sourceData && (
                      <>
                        {/* Search */}
                        <div className="relative">
                          <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
                          </svg>
                          <input
                            value={sourceSearch}
                            onChange={(e) => setSourceSearch(e.target.value)}
                            placeholder="Search source…"
                            className="pl-8 pr-3 py-1.5 rounded-lg border border-white/10 bg-[#0f1117] text-xs text-gray-300 placeholder-gray-600 w-60 focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/20 outline-none transition"
                          />
                        </div>
                        {/* GitHub link */}
                        <a
                          href={sourceData.github_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.06] border border-white/10 text-[11px] font-medium text-gray-300 hover:bg-white/[0.1] hover:text-white transition-all duration-150"
                          title="Open on GitHub"
                        >
                          <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="currentColor">
                            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
                          </svg>
                          GitHub
                        </a>
                        {/* Download */}
                        <button
                          onClick={downloadSource}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.06] border border-white/10 text-[11px] font-medium text-gray-300 hover:bg-white/[0.1] hover:text-white transition-all duration-150"
                          title="Download source file"
                        >
                          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                          </svg>
                          Download
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {/* Source content */}
                {sourceLoading && (
                  <div className="flex items-center justify-center py-16 gap-3 text-gray-500">
                    <svg className="h-5 w-5 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    <span className="text-sm">Fetching source code from GitHub…</span>
                  </div>
                )}

                {sourceError && !sourceLoading && (
                  <div className="px-5 py-10 text-center">
                    <div className="inline-flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/8 px-4 py-2.5 text-sm text-red-400">
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
                      </svg>
                      {sourceError}
                    </div>
                    {data.branch && data.file_name && (
                      <button
                        onClick={() => fetchSource(data.branch, data.file_name)}
                        className="mt-3 text-xs text-violet-400 hover:text-violet-300 underline underline-offset-2"
                      >
                        Retry
                      </button>
                    )}
                  </div>
                )}

                {!sourceData && !sourceLoading && !sourceError && (
                  <div className="text-center py-16 text-gray-600">
                    <svg className="h-10 w-10 mx-auto mb-3 text-gray-700" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5" />
                    </svg>
                    <p className="text-sm">
                      {data.branch
                        ? "Source code not loaded yet."
                        : "Enter a branch name in the form above and re-analyze to fetch source code."}
                    </p>
                    {data.branch && data.file_name && (
                      <button
                        onClick={() => fetchSource(data.branch, data.file_name)}
                        className="mt-2 text-xs text-violet-400 hover:text-violet-300 underline underline-offset-2"
                      >
                        Fetch source for {data.file_name}
                      </button>
                    )}
                  </div>
                )}

                {sourceData && !sourceLoading && (
                  <pre
                    ref={sourceRef}
                    className="overflow-auto text-[11px] leading-[1.6] font-mono text-gray-400 p-4 select-text"
                    style={{ maxHeight: "calc(100vh - 480px)", minHeight: "400px" }}
                  >
                    {filteredSourceLines.length > 0 ? (
                      filteredSourceLines.map((line, i) => {
                        // Find original line number
                        const origIdx = sourceSearch
                          ? sourceLines.indexOf(line) + 1
                          : i + 1;
                        return (
                          <SourceLine
                            key={i}
                            line={line}
                            lineNo={origIdx}
                            searchTerm={sourceSearch}
                          />
                        );
                      })
                    ) : (
                      <span className="text-gray-600">No source lines to display.</span>
                    )}
                  </pre>
                )}
              </>
            )}

            {/* ── Executed Steps Tab ── */}
            {activeTab === "steps" && (
              <div className="overflow-auto" style={{ maxHeight: "calc(100vh - 420px)", minHeight: "300px" }}>
                {(!data.steps || data.steps.length === 0) ? (
                  <div className="flex flex-col items-center justify-center py-16 text-gray-600">
                    <svg className="h-10 w-10 mb-3 text-gray-700" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <p className="text-sm">No executed steps available for this TC.</p>
                  </div>
                ) : (
                  <div className="px-5 py-4 space-y-0.5">
                    {data.steps.map((step, i) => {
                      const [desc, status] = Object.entries(step)[0] ?? ["", ""];
                      const statusUp = String(status).trim().toUpperCase();
                      const isHeader = desc.includes("----") || statusUp === "" || statusUp === "NA" || statusUp === "SECTION";
                      const isPass = statusUp === "PASS" || statusUp === "TRUE" || statusUp === "1";
                      const isFail = statusUp === "FAIL" || statusUp === "FALSE" || statusUp === "0";

                      if (isHeader) {
                        return (
                          <div key={i} className="pt-3 pb-1">
                            <span className="text-[10px] font-bold uppercase tracking-widest text-amber-500/80">
                              {desc.replace(/[-]+/g, "").trim() || desc}
                            </span>
                          </div>
                        );
                      }

                      return (
                        <div
                          key={i}
                          className={`flex items-start gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                            isPass
                              ? "bg-green-500/[0.06] hover:bg-green-500/[0.09]"
                              : isFail
                              ? "bg-red-500/[0.06] hover:bg-red-500/[0.09]"
                              : "bg-white/[0.03] hover:bg-white/[0.05]"
                          }`}
                        >
                          {/* Status dot */}
                          <span className={`mt-0.5 h-2 w-2 shrink-0 rounded-full ${
                            isPass ? "bg-green-400" : isFail ? "bg-red-400" : "bg-gray-500"
                          }`} />
                          {/* Step description */}
                          <span className={`flex-1 leading-relaxed break-words ${
                            isPass ? "text-green-300/90" : isFail ? "text-red-300/90" : "text-gray-400"
                          }`}>
                            {desc}
                          </span>
                          {/* Status badge */}
                          <span className={`shrink-0 text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                            isPass
                              ? "bg-green-500/10 text-green-400 border-green-500/20"
                              : isFail
                              ? "bg-red-500/10 text-red-400 border-red-500/20"
                              : "bg-white/[0.05] text-gray-500 border-white/10"
                          }`}>
                            {status}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* ── Device Logs Tab ── */}
            {activeTab === "device-log" && (
              <>
                {/* Context bar — shows derived inputs */}
                <div className="flex flex-wrap items-center gap-4 px-5 py-3 border-b border-white/[0.06] bg-[#12141c]">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-gray-600">Device</span>
                    <span className="font-mono text-sky-300 bg-sky-500/10 px-2 py-0.5 rounded border border-sky-500/20">
                      {dlDeviceId || "—"}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-gray-600">Date</span>
                    <span className="font-mono text-sky-300 bg-sky-500/10 px-2 py-0.5 rounded border border-sky-500/20">
                      {dlDate || "—"}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-gray-600">Window</span>
                    <span className="font-mono text-gray-400">
                      {data?.start_time ?? "—"} → {data?.end_time ?? "—"}
                    </span>
                    <span className="text-[10px] text-gray-600">(UTC)</span>
                  </div>
                  {dlMatchedService && (
                    <div className="flex items-center gap-2 text-xs">
                      <span className="text-gray-600">Service</span>
                      <span className="font-mono text-emerald-300 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                        {dlMatchedService}
                      </span>
                    </div>
                  )}
                </div>

                {/* Auto-status pipeline bar */}
                <div className={`flex items-center gap-3 px-5 py-2.5 border-b border-white/[0.06] text-[11px] ${
                  dlAutoStatus === "error" ? "bg-red-500/[0.05]" : dlAutoStatus === "done" ? "bg-green-500/[0.04]" : "bg-[#0f1117]"
                }`}>
                  {dlAutoStatus !== "error" && (
                    <>
                      {(["checking","downloading","loading","done"] as const).map((step, idx) => {
                        const steps = ["checking","downloading","loading","done"] as const;
                        const currentIdx = steps.indexOf(dlAutoStatus as typeof steps[number]);
                        const isDone = currentIdx > idx || dlAutoStatus === "done";
                        const isActive = dlAutoStatus === step;
                        const labels: Record<string, string> = { checking: "Check", downloading: "Download", loading: "Load", done: "Done" };
                        return (
                          <div key={step} className="flex items-center gap-1.5">
                            {idx > 0 && <span className="text-gray-700">›</span>}
                            <span className={`font-medium transition-colors ${
                              isDone ? "text-green-400" : isActive ? "text-sky-300 animate-pulse" : "text-gray-700"
                            }`}>
                              {isDone ? "✓ " : ""}{labels[step]}
                              {step === "downloading" && isActive ? ` ${dlElapsed}s` : ""}
                            </span>
                          </div>
                        );
                      })}
                      {dlAutoStatus === "done" && (
                        <span className="ml-2 text-[10px] text-green-500/70">{dlLogCount.toLocaleString()} lines</span>
                      )}
                      {dlAutoStatus === "idle" && (
                        <span className="text-gray-600">Waiting for analysis…</span>
                      )}
                    </>
                  )}
                  {dlAutoStatus === "error" && (
                    <>
                      <span className="font-medium text-red-400">Error</span>
                      <span className="text-red-400/70 truncate max-w-[320px]">{dlError}</span>
                      <button
                        onClick={() => {
                          setDlAutoStatus("idle");
                          setDlMatchedService("");
                          setDlLogs([]);
                          setDlLogCount(0);
                          setDlError(null);
                          setDlConsoleLines([]);
                          setDlExitCode(null);
                        }}
                        className="ml-auto px-3 py-1 rounded-md bg-sky-600/30 hover:bg-sky-600/50 border border-sky-500/20 text-sky-300 transition-colors"
                      >
                        Retry
                      </button>
                    </>
                  )}
                </div>

                {/* Inline console — visible during/after S3 download */}
                {(dlConsoleLines.length > 0 || dlAutoStatus === "downloading") && (
                  <div className="border-b border-white/[0.06] bg-[#0a0c12]">
                    <div className="flex items-center justify-between px-4 py-1.5 border-b border-white/[0.04]">
                      <div className="flex items-center gap-2">
                        <svg className="h-3 w-3 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0021 18V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v12a2.25 2.25 0 002.25 2.25z" />
                        </svg>
                        <span className="text-[10px] text-gray-600 font-medium uppercase tracking-wider">Console</span>
                        {dlAutoStatus === "downloading" && (
                          <span className="flex h-1.5 w-1.5 rounded-full bg-green-500 animate-pulse" />
                        )}
                      </div>
                      {dlAutoStatus !== "downloading" && dlConsoleLines.length > 0 && (
                        <button
                          onClick={() => setDlConsoleLines([])}
                          className="text-[10px] text-gray-600 hover:text-gray-400 transition-colors"
                        >
                          Clear
                        </button>
                      )}
                    </div>
                    <pre
                      ref={dlConsoleRef}
                      className="overflow-auto text-[11px] leading-[1.6] font-mono p-3 max-h-28"
                    >
                      {dlConsoleLines.map((l, i) => (
                        <div key={i} className={
                          l.type === "error" ? "text-red-400"
                          : l.type === "info" ? "text-yellow-400 italic"
                          : "text-green-400"
                        }>
                          {l.text}
                        </div>
                      ))}
                      {dlAutoStatus === "downloading" && (
                        <span className="inline-block animate-pulse text-gray-500">▊</span>
                      )}
                    </pre>
                  </div>
                )}

                {/* ── Filter Toolbar ── */}
                {(dlLogs.length > 0 || allDlServices.length > 0) && (
                <div className="border-b border-white/[0.06] bg-[#12141c]">
                  {/* Row 1: Search + stats + actions */}
                  <div className="flex items-center gap-3 px-4 py-2.5">
                    {/* Search */}
                    <div className="relative flex-1 max-w-xs">
                      <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
                      </svg>
                      <input
                        value={dlSearch}
                        onChange={(e) => setDlSearch(e.target.value)}
                        placeholder="Search logs…"
                        className="pl-8 pr-3 py-1.5 w-full rounded-lg border border-white/10 bg-[#0f1117] text-xs text-gray-300 placeholder-gray-600 focus:border-sky-500/50 focus:ring-1 focus:ring-sky-500/20 outline-none transition"
                      />
                    </div>
                    {/* Filter summary badge */}
                    <div className="flex items-center gap-2 text-[10px] text-gray-500">
                      <span className="font-mono text-sky-400">{dlFilteredLogs.length.toLocaleString()}</span>
                      <span>/</span>
                      <span className="font-mono">{dlLogs.length.toLocaleString()}</span>
                      <span>entries</span>
                      {dlSelectedServices.size > 0 && (
                        <span className="px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-300 border border-sky-500/20">
                          {dlSelectedServices.size} svc
                        </span>
                      )}
                      {dlLevelFilter.size > 0 && (
                        <span className="px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-300 border border-amber-500/20">
                          {dlLevelFilter.size} lvl
                        </span>
                      )}
                    </div>
                    {/* Actions */}
                    <div className="ml-auto flex items-center gap-2">
                      {(dlSelectedServices.size > 0 || dlLevelFilter.size > 0 || dlSearch) && (
                        <button
                          onClick={() => { setDlSelectedServices(new Set()); setDlLevelFilter(new Set()); setDlSearch(""); }}
                          className="text-[10px] px-2 py-1 rounded-md bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 transition-colors"
                        >
                          Reset filters
                        </button>
                      )}
                      <button
                        onClick={() => { setDlLogs([]); setDlLogCount(0); setDlError(null); setDlLevelFilter(new Set()); setDlSelectedServices(new Set()); setDlSearch(""); }}
                        className="text-[10px] px-2 py-1 rounded-md bg-white/[0.04] text-gray-500 border border-white/[0.08] hover:bg-white/[0.08] transition-colors"
                      >
                        Clear logs
                      </button>
                    </div>
                  </div>

                  {/* Row 2: Level filter pills */}
                  {Object.keys(dlLevelCounts).length > 0 && (
                  <div className="flex items-center gap-1.5 px-4 py-2 border-t border-white/[0.04]">
                    <span className="text-[10px] text-gray-600 mr-1 shrink-0">Level</span>
                    {Object.entries(dlLevelCounts)
                      .sort(([, a], [, b]) => b - a)
                      .map(([level, count]) => {
                        const active = dlLevelFilter.size === 0 || dlLevelFilter.has(level);
                        return (
                          <button
                            key={level}
                            onClick={() => setDlLevelFilter((prev) => {
                              const n = new Set(prev);
                              n.has(level) ? n.delete(level) : n.add(level);
                              return n;
                            })}
                            className={`text-[10px] px-2 py-0.5 rounded-md border transition-all duration-150 font-semibold ${
                              active
                                ? dlLevelBadge(level)
                                : "bg-white/[0.02] text-gray-600 border-white/[0.06]"
                            }`}
                          >
                            {level} <span className="opacity-60 font-normal">{count.toLocaleString()}</span>
                          </button>
                        );
                      })}
                    {dlLevelFilter.size > 0 && (
                      <button onClick={() => setDlLevelFilter(new Set())} className="text-[10px] text-gray-600 hover:text-gray-400 ml-1 transition-colors">
                        ✕
                      </button>
                    )}
                  </div>
                  )}

                  {/* Row 3: Service selector — button toggle */}
                  {allDlServices.length > 0 && (
                  <div className="border-t border-white/[0.04]">
                    <div className="flex items-center gap-2 px-4 py-2">
                      {/* Services button */}
                      <button
                        onClick={() => setDlServiceExpanded(!dlServiceExpanded)}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-[11px] font-medium transition-all duration-150 ${
                          dlServiceExpanded
                            ? "bg-sky-500/15 text-sky-300 border-sky-500/30"
                            : "bg-white/[0.06] text-gray-400 border-white/[0.10] hover:bg-white/[0.10] hover:text-gray-200"
                        }`}
                      >
                        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z" />
                        </svg>
                        Services
                        <svg className={`h-3 w-3 transition-transform ${dlServiceExpanded ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                        </svg>
                      </button>
                      {/* Selection info */}
                      <span className="text-[10px] text-gray-600">
                        {dlSelectedServices.size > 0
                          ? `${dlSelectedServices.size}/${allDlServices.length} selected`
                          : `${allDlServices.length} available`
                        }
                      </span>
                      {/* Selected service pills (inline preview) */}
                      {dlSelectedServices.size > 0 && (
                        <div className="flex items-center gap-1 overflow-hidden max-w-[400px]">
                          {Array.from(dlSelectedServices).slice(0, 4).map(s => (
                            <span key={s} className="text-[9px] px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-300 border border-sky-500/20 truncate max-w-[80px]">{s}</span>
                          ))}
                          {dlSelectedServices.size > 4 && (
                            <span className="text-[9px] text-gray-600">+{dlSelectedServices.size - 4}</span>
                          )}
                        </div>
                      )}
                    </div>
                    {/* Expanded grid */}
                    {dlServiceExpanded && (
                      <div className="px-4 pb-3">
                        {/* Quick actions */}
                        <div className="flex items-center gap-2 mb-2">
                          <button
                            onClick={() => setDlSelectedServices(new Set(allDlServices))}
                            className="text-[10px] px-2 py-0.5 rounded bg-sky-500/10 text-sky-300 border border-sky-500/20 hover:bg-sky-500/20 transition-colors"
                          >
                            Select All
                          </button>
                          <button
                            onClick={() => setDlSelectedServices(new Set())}
                            className="text-[10px] px-2 py-0.5 rounded bg-white/[0.04] text-gray-400 border border-white/[0.08] hover:bg-white/[0.08] transition-colors"
                          >
                            None (show all)
                          </button>
                          {dlMatchedService && dlMatchedService !== "none" && (
                            <button
                              onClick={() => {
                                const svc = dlMatchedService.replace("~", "");
                                const matches = allDlServices.filter(f => f.toUpperCase().includes(svc.toUpperCase()));
                                setDlSelectedServices(new Set(matches));
                              }}
                              className="text-[10px] px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/20 hover:bg-emerald-500/20 transition-colors"
                            >
                              Only {dlMatchedService}
                            </button>
                          )}
                        </div>
                        {/* Grid of services */}
                        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-1">
                          {allDlServices.map(svc => {
                            const count = dlServiceCounts[svc] ?? 0;
                            const isSelected = dlSelectedServices.has(svc);
                            const hasData = count > 0;
                            return (
                              <button
                                key={svc}
                                onClick={() => setDlSelectedServices((prev) => {
                                  const n = new Set(prev);
                                  n.has(svc) ? n.delete(svc) : n.add(svc);
                                  return n;
                                })}
                                className={`text-[10px] px-2 py-1.5 rounded-md border transition-all duration-150 font-mono text-left truncate ${
                                  isSelected
                                    ? "bg-sky-500/15 text-sky-300 border-sky-500/30 ring-1 ring-sky-500/20"
                                    : hasData
                                      ? "bg-white/[0.03] text-gray-400 border-white/[0.08] hover:bg-white/[0.06] hover:text-gray-300"
                                      : "bg-white/[0.01] text-gray-600 border-white/[0.04] hover:bg-white/[0.04] hover:text-gray-500"
                                }`}
                                title={`${svc} — ${count.toLocaleString()} entries in time window`}
                              >
                                <span className="truncate">{svc}</span>
                                {hasData && (
                                  <span className={`ml-1 ${isSelected ? "text-sky-400/60" : "text-gray-700"}`}>
                                    {count.toLocaleString()}
                                  </span>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                  )}
                </div>
                )}

                {/* Log table */}
                {dlFilteredLogs.length > 0 ? (
                  <div
                    className="overflow-auto"
                    style={{ maxHeight: "calc(100vh - 520px)", minHeight: "300px" }}
                  >
                    <table className="w-full text-[11px] font-mono">
                      <thead className="sticky top-0 z-10 bg-[#0d0f15] border-b border-white/[0.06]">
                        <tr className="text-left text-[10px] text-gray-600 uppercase tracking-wider">
                          <th className="px-3 py-2 w-[160px]">Timestamp (UTC)</th>
                          <th className="px-2 py-2 w-[110px]">Service</th>
                          <th className="px-2 py-2 w-[44px]">Lvl</th>
                          <th className="px-3 py-2">Message</th>
                        </tr>
                      </thead>
                      <tbody>
                        {dlFilteredLogs.slice(0, dlVisibleCount).map((entry, i) => {
                          const ts = entry.epoch_ms
                            ? new Date(entry.epoch_ms).toISOString().replace("T", " ").slice(0, 19)
                            : "—";
                          const msg = parseDlMessage(entry.line);
                          return (
                            <tr
                              key={i}
                              className={`border-b border-white/[0.025] hover:bg-white/[0.015] ${i % 2 === 0 ? "" : "bg-white/[0.01]"}`}
                            >
                              <td className="px-3 py-1 text-gray-600 tabular-nums whitespace-nowrap align-top">{ts}</td>
                              <td className="px-2 py-1 align-top">
                                <span className="text-[10px] bg-white/[0.04] text-gray-400 px-1.5 py-0.5 rounded truncate max-w-[100px] inline-block">
                                  {entry.service}
                                </span>
                              </td>
                              <td className="px-2 py-1 align-top">
                                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${dlLevelBadge(entry.level)}`}>
                                  {entry.level}
                                </span>
                              </td>
                              <td className={`px-3 py-1 break-all align-top leading-relaxed ${dlLevelColor(entry.level)}`}>
                                {msg}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                      {dlFilteredLogs.length > dlVisibleCount && (
                        <tfoot>
                          <tr>
                            <td colSpan={4} className="text-center py-3">
                              <button
                                onClick={() => setDlVisibleCount(prev => prev + 500)}
                                className="text-[11px] px-4 py-1.5 rounded-lg bg-sky-500/10 text-sky-300 border border-sky-500/20 hover:bg-sky-500/20 transition-colors"
                              >
                                Show 500 more ({(dlFilteredLogs.length - dlVisibleCount).toLocaleString()} remaining)
                              </button>
                            </td>
                          </tr>
                        </tfoot>
                      )}
                    </table>
                  </div>
                ) : dlAutoStatus === "done" ? (
                  <div className="flex flex-col items-center justify-center py-14 text-gray-600">
                    <svg className="h-10 w-10 mb-3 text-gray-700" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
                    </svg>
                    <p className="text-sm">No entries matched the current filters.</p>
                    <p className="text-xs mt-1 opacity-60">Try clearing the level filter, changing services, or removing the search term.</p>
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center py-14 text-gray-600">
                    {(dlAutoStatus === "checking" || dlAutoStatus === "downloading" || dlAutoStatus === "loading") && (
                      <svg className="h-8 w-8 mb-3 text-sky-600 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                    )}
                    <p className="text-sm">
                      {dlAutoStatus === "idle" ? "Waiting for analysis…"
                        : dlAutoStatus === "checking" ? "Checking local cache…"
                        : dlAutoStatus === "downloading" ? "Downloading logs from S3…"
                        : dlAutoStatus === "loading" ? "Loading and filtering logs…"
                        : "Logs will appear here."}
                    </p>
                  </div>
                )}
              </>
            )}
          </div>

          {/* ── AI Analysis Section ── */}
          <div className="rounded-xl border border-purple-500/20 bg-[#161922] overflow-hidden">
            {/* AI Header + Button */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.06]">
              <div className="flex items-center gap-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-purple-500/20 to-pink-500/20 border border-purple-500/10">
                  <svg className="h-4 w-4 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456zM16.894 20.567L16.5 21.75l-.394-1.183a2.25 2.25 0 00-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 001.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 001.423 1.423l1.183.394-1.183.394a2.25 2.25 0 00-1.423 1.423z" />
                  </svg>
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-purple-300">AI Analysis</h3>
                  <p className="text-[10px] text-gray-600">Powered by Ollama</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {/* Model selector */}
                {aiModels.length > 0 && (
                  <select
                    value={aiModel}
                    onChange={e => setAiModel(e.target.value)}
                    disabled={aiLoading}
                    className="bg-white/[0.06] border border-white/10 rounded-lg px-2 py-1.5 text-[11px] font-medium text-gray-300 outline-none focus:border-purple-500/50 transition-colors disabled:opacity-50"
                  >
                    {aiModels.map(m => (
                      <option key={m.id} value={m.id} className="bg-[#1a1d28] text-gray-200">
                        {m.label}
                      </option>
                    ))}
                  </select>
                )}
                {aiResult && (
                  <button
                    onClick={() => setAiExpanded(prev => !prev)}
                    className="p-1.5 rounded-lg hover:bg-white/[0.06] text-gray-500 hover:text-gray-300 transition-colors"
                  >
                    <svg className={`h-4 w-4 transition-transform duration-200 ${aiExpanded ? "" : "-rotate-90"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                    </svg>
                  </button>
                )}
                <button
                  onClick={runAiAnalysis}
                  disabled={aiLoading}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg bg-gradient-to-r from-purple-600 to-pink-600 text-[12px] font-semibold text-white shadow-lg shadow-purple-500/20 hover:shadow-purple-500/30 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                  title="Smart-filtered analysis (fast)"
                >
                  {aiLoading && aiStatus !== "deep" ? (
                    <>
                      <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                      Analysing…
                    </>
                  ) : (
                    <>
                      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
                      </svg>
                      Fast
                    </>
                  )}
                </button>
                <button
                  onClick={runDeepAnalysis}
                  disabled={aiLoading}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg bg-gradient-to-r from-indigo-600 to-cyan-600 text-[12px] font-semibold text-white shadow-lg shadow-indigo-500/20 hover:shadow-indigo-500/30 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                  title="Map-Reduce deep analysis (analyzes all data in chunks)"
                >
                  {aiLoading && aiStatus === "deep" ? (
                    <>
                      <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                      Deep…
                    </>
                  ) : (
                    <>
                      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
                      </svg>
                      Deep
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* AI Error */}
            {aiError && (
              <div className="px-5 py-3 border-b border-white/[0.06] bg-red-500/[0.05]">
                <div className="flex items-center gap-2 text-sm text-red-400">
                  <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
                  </svg>
                  {aiError}
                </div>
              </div>
            )}

            {/* AI Loading placeholder */}
            {aiLoading && !aiResult && (
              <div className="px-5 py-6">
                {/* Deep analysis chunk progress */}
                {aiDeepProgress && aiDeepProgress.phase === "map" ? (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-gray-400 font-medium">Analyzing chunks… ({aiElapsed}s)</span>
                      <span className="text-indigo-400 font-mono text-xs">{aiDeepProgress.chunk}/{aiDeepProgress.total}</span>
                    </div>
                    {/* Progress bar */}
                    <div className="h-2 bg-white/[0.06] rounded-full overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-indigo-500 to-cyan-500 rounded-full transition-all duration-500 ease-out"
                        style={{ width: `${aiDeepProgress.total > 0 ? (aiDeepProgress.chunk / aiDeepProgress.total) * 100 : 0}%` }}
                      />
                    </div>
                    {/* Current chunk label */}
                    {aiDeepProgress.label && (
                      <div className="flex items-center gap-2 text-xs">
                        {aiDeepProgress.status === "processing" ? (
                          <svg className="h-3.5 w-3.5 animate-spin text-indigo-400" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                          </svg>
                        ) : (
                          <svg className="h-3.5 w-3.5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                          </svg>
                        )}
                        <span className="text-gray-500">{aiDeepProgress.label}</span>
                        {aiDeepProgress.preview && (
                          <span className="text-gray-700 truncate max-w-[300px]">— {aiDeepProgress.preview}</span>
                        )}
                      </div>
                    )}
                  </div>
                ) : aiDeepProgress && aiDeepProgress.phase === "reduce" && !aiResult ? (
                  <div className="flex items-center justify-center gap-3 py-4 text-gray-500">
                    <svg className="h-5 w-5 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    <span className="text-sm">Synthesizing findings into root cause analysis… ({aiElapsed}s)</span>
                  </div>
                ) : (
                  <div className="flex items-center justify-center gap-3 py-4 text-gray-500">
                    <svg className="h-5 w-5 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    <span className="text-sm">
                      {aiStatus === "processing"
                        ? `Model is loading & processing prompt… (${aiElapsed}s)`
                        : `AI is generating response… (${aiElapsed}s)`
                      }
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* AI Result */}
            {aiResult && aiExpanded && (
              <div ref={aiRef} className="px-5 py-4 overflow-auto" style={{ maxHeight: "calc(100vh - 300px)" }}>
                <div className="prose prose-invert prose-sm max-w-none">
                  <pre className="whitespace-pre-wrap break-words text-[13px] leading-relaxed font-mono text-gray-300 bg-transparent p-0 m-0">
                    {aiResult}
                    {aiLoading && <span className="inline-block animate-pulse text-purple-400">▊</span>}
                  </pre>
                </div>
                {!aiLoading && aiResult && (
                  <div className="flex items-center gap-2 mt-4 pt-3 border-t border-white/[0.06]">
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(aiResult);
                      }}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.06] border border-white/10 text-[11px] font-medium text-gray-300 hover:bg-white/[0.1] hover:text-white transition-all duration-150"
                    >
                      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
                      </svg>
                      Copy
                    </button>
                    <button
                      onClick={() => {
                        openTabInNewWindow("ai");
                      }}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.06] border border-white/10 text-[11px] font-medium text-gray-300 hover:bg-white/[0.1] hover:text-white transition-all duration-150"
                    >
                      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                      </svg>
                      Open in New Tab
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Empty state */}
            {!aiResult && !aiLoading && !aiError && (
              <div className="px-5 py-8 text-center text-gray-600">
                <p className="text-sm">Click &ldquo;Fast&rdquo; for quick smart-filtered analysis, or &ldquo;Deep&rdquo; to analyze all data in chunks (slower but thorough).</p>
                <p className="text-[11px] mt-1 text-gray-700">Uses execution steps, automation logs, device logs, and source code.</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start gap-2">
      <span className="text-gray-600 w-24 shrink-0">{label}</span>
      <span className="text-gray-300 break-all">{value || "—"}</span>
    </div>
  );
}

function extractServiceName(tcId: string): string {
  // TC_1629_APM_OVERRIDE_PARSING.py → "APM"
  // TC_185_BAGHEERA_test-name       → "BAGHEERA"
  const clean = tcId.replace(/\.py$/i, "");
  const parts = clean.split("_");
  if (parts.length >= 3 && parts[0].toUpperCase() === "TC") return parts[2].toUpperCase();
  return "";
}

function dlLevelColor(level: string): string {
  switch (level) {
    case "E": case "C": return "text-red-400";
    case "W": return "text-yellow-400";
    case "I": return "text-green-400";
    case "D": return "text-gray-400";
    case "V": return "text-sky-400";
    default: return "text-gray-300";
  }
}

function dlLevelBadge(level: string): string {
  switch (level) {
    case "E": case "C": return "bg-red-500/10 text-red-400 border border-red-500/20";
    case "W": return "bg-yellow-500/10 text-yellow-400 border border-yellow-500/20";
    case "I": return "bg-green-500/10 text-green-400 border border-green-500/20";
    case "D": return "bg-gray-500/10 text-gray-500 border border-gray-500/20";
    case "V": return "bg-sky-500/10 text-sky-400 border border-sky-500/20";
    default: return "bg-white/[0.06] text-gray-400 border border-white/[0.08]";
  }
}

function parseDlMessage(line: string): string {
  // Strip the prefix added by logs_download.py:
  // "YYYY-MM-DD HH:MM:SS: {13-digit epoch}: {counter}: {LEVEL} : {message}"
  const m = line.match(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}: \d{13}: \d+: [IEWDCV] : ([\s\S]*)$/);
  return m ? m[1] : line;
}

function LogLine({
  line,
  lineNo,
  searchTerm,
}: {
  line: string;
  lineNo: number;
  searchTerm: string;
}) {
  // Colour-code lines based on content
  const lineClass = "text-gray-400";

  // Highlight search matches
  if (searchTerm) {
    const regex = new RegExp(`(${searchTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
    const parts = line.split(regex);
    return (
      <div className={`flex hover:bg-white/[0.02] ${lineClass}`}>
        <span className="inline-block w-14 text-right pr-3 text-gray-700 select-none shrink-0 border-r border-white/[0.04] mr-3">
          {lineNo}
        </span>
        <span className="flex-1 whitespace-pre-wrap break-all">
          {parts.map((part, i) =>
            regex.test(part) ? (
              <mark key={i} className="bg-amber-500/30 text-amber-200 rounded-sm px-0.5">
                {part}
              </mark>
            ) : (
              <span key={i}>{part}</span>
            )
          )}
        </span>
      </div>
    );
  }

  return (
    <div className={`flex hover:bg-white/[0.02] ${lineClass}`}>
      <span className="inline-block w-14 text-right pr-3 text-gray-700 select-none shrink-0 border-r border-white/[0.04] mr-3">
        {lineNo}
      </span>
      <span className="flex-1 whitespace-pre-wrap break-all">{line}</span>
    </div>
  );
}

function SourceLine({
  line,
  lineNo,
  searchTerm,
}: {
  line: string;
  lineNo: number;
  searchTerm: string;
}) {
  // Python syntax colour-coding
  let lineClass = "text-gray-300";
  const trimmed = line.trimStart();
  if (trimmed.startsWith("#")) {
    lineClass = "text-gray-600 italic";
  } else if (trimmed.startsWith("def ") || trimmed.startsWith("async def ")) {
    lineClass = "text-sky-400";
  } else if (trimmed.startsWith("class ")) {
    lineClass = "text-amber-400";
  } else if (
    trimmed.startsWith("import ") ||
    trimmed.startsWith("from ")
  ) {
    lineClass = "text-violet-400/80";
  } else if (
    trimmed.startsWith("@")
  ) {
    lineClass = "text-emerald-400/80";
  } else if (
    trimmed.startsWith("return ") ||
    trimmed.startsWith("raise ") ||
    trimmed.startsWith("yield ")
  ) {
    lineClass = "text-rose-400/80";
  } else if (
    trimmed.startsWith('"""') ||
    trimmed.startsWith("'''") ||
    trimmed.startsWith('r"') ||
    trimmed.startsWith('f"')
  ) {
    lineClass = "text-emerald-300/60";
  }

  if (searchTerm) {
    const regex = new RegExp(`(${searchTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
    const parts = line.split(regex);
    return (
      <div className={`flex hover:bg-white/[0.02] ${lineClass}`}>
        <span className="inline-block w-14 text-right pr-3 text-gray-700 select-none shrink-0 border-r border-white/[0.04] mr-3">
          {lineNo}
        </span>
        <span className="flex-1 whitespace-pre break-all">
          {parts.map((part, i) =>
            regex.test(part) ? (
              <mark key={i} className="bg-amber-500/30 text-amber-200 rounded-sm px-0.5">
                {part}
              </mark>
            ) : (
              <span key={i}>{part}</span>
            )
          )}
        </span>
      </div>
    );
  }

  return (
    <div className={`flex hover:bg-white/[0.02] ${lineClass}`}>
      <span className="inline-block w-14 text-right pr-3 text-gray-700 select-none shrink-0 border-r border-white/[0.04] mr-3">
        {lineNo}
      </span>
      <span className="flex-1 whitespace-pre break-all">{line}</span>
    </div>
  );
}
