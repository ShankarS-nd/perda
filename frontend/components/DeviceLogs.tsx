"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://172.16.23.15:8000";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ConsoleLine {
  type: "stdout" | "info" | "error";
  text: string;
}

interface LogEntry {
  service: string;
  epoch_ms: number | null;
  level: string;
  line: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function levelColor(level: string): string {
  switch (level) {
    case "E":
    case "C":
      return "text-red-400";
    case "W":
      return "text-yellow-400";
    case "I":
      return "text-green-400";
    case "D":
      return "text-gray-400";
    case "V":
      return "text-sky-400";
    default:
      return "text-gray-300";
  }
}

function levelBadgeClass(level: string): string {
  switch (level) {
    case "E":
    case "C":
      return "bg-red-500/10 text-red-400 border border-red-500/20";
    case "W":
      return "bg-yellow-500/10 text-yellow-400 border border-yellow-500/20";
    case "I":
      return "bg-green-500/10 text-green-400 border border-green-500/20";
    case "D":
      return "bg-gray-500/10 text-gray-500 border border-gray-500/20";
    case "V":
      return "bg-sky-500/10 text-sky-400 border border-sky-500/20";
    default:
      return "bg-white/[0.06] text-gray-400 border border-white/[0.08]";
  }
}

function levelLabel(l: string) {
  const map: Record<string, string> = {
    E: "Error", C: "Critical", W: "Warning", I: "Info", D: "Debug", V: "Verbose",
  };
  return map[l] ?? l;
}

function todayString(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function DeviceLogs() {
  // ---- Download form state ----
  const [deviceId, setDeviceId] = useState("");
  const [logDate, setLogDate] = useState(todayString());

  // ---- Download progress state ----
  const [downloading, setDownloading] = useState(false);
  const [downloadLines, setDownloadLines] = useState<ConsoleLine[]>([]);
  const [downloadExitCode, setDownloadExitCode] = useState<number | null>(null);
  const [downloadElapsed, setDownloadElapsed] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const consoleRef = useRef<HTMLPreElement>(null);

  // ---- Available service files ----
  const [availableServices, setAvailableServices] = useState<string[]>([]);
  const [selectedServices, setSelectedServices] = useState<Set<string>>(new Set());

  // ---- Log viewer state ----
  const [startDatetime, setStartDatetime] = useState("");
  const [endDatetime, setEndDatetime] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [levelFilter, setLevelFilter] = useState<Set<string>>(new Set());
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logError, setLogError] = useState<string | null>(null);
  const [logCount, setLogCount] = useState<number>(0);
  const logViewRef = useRef<HTMLDivElement>(null);

  // ---- Cleanup on unmount ----
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  // ---- Auto-scroll console ----
  useEffect(() => {
    if (consoleRef.current) {
      consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
    }
  }, [downloadLines]);

  // ---- Auto-scroll log viewer ----
  useEffect(() => {
    if (logViewRef.current && logs.length > 0) {
      logViewRef.current.scrollTop = 0;
    }
  }, [logs]);

  // ---- Fetch available files when device / date is filled ----
  const fetchAvailableFiles = useCallback(async (devId: string, date: string) => {
    if (!devId.trim() || !date) return;
    try {
      const res = await fetch(
        `${API_BASE}/device-logs/files?device_id=${encodeURIComponent(devId.trim())}&date=${encodeURIComponent(date)}`
      );
      if (!res.ok) return;
      const data = await res.json();
      const files: string[] = data.files ?? [];
      setAvailableServices(files);
      setSelectedServices(new Set(files));
    } catch {
      // silently ignore
    }
  }, []);

  // ---- Download handler ----
  const handleDownload = async () => {
    if (!deviceId.trim() || !logDate) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setDownloading(true);
    setDownloadLines([]);
    setDownloadExitCode(null);
    setDownloadElapsed(0);
    setAvailableServices([]);
    setLogs([]);
    setLogError(null);

    const start = Date.now();
    timerRef.current = setInterval(() => {
      setDownloadElapsed(Math.floor((Date.now() - start) / 1000));
    }, 1000);

    try {
      const res = await fetch(`${API_BASE}/device-logs/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_id: deviceId.trim(), date: logDate }),
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
          const dataLine = part.split("\n").find((l) => l.startsWith("data: "));
          if (!dataLine) continue;
          try {
            const event = JSON.parse(dataLine.slice(6));
            if (event.type === "stdout") {
              setDownloadLines((prev) => [...prev, { type: "stdout", text: event.text }]);
            } else if (event.type === "exit") {
              setDownloadExitCode(event.code);
            }
          } catch {
            // ignore parse errors
          }
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== "AbortError") {
        setDownloadLines((prev) => [
          ...prev,
          { type: "error", text: `Connection error: ${err.message}` },
        ]);
      }
    } finally {
      if (timerRef.current) clearInterval(timerRef.current);
      setDownloading(false);
      // After download finishes, fetch available files
      await fetchAvailableFiles(deviceId.trim(), logDate);
    }
  };

  const handleStopDownload = () => {
    abortRef.current?.abort();
  };

  // ---- Load logs handler ----
  const handleLoadLogs = async () => {
    if (!deviceId.trim() || !logDate) return;

    setLoadingLogs(true);
    setLogs([]);
    setLogError(null);

    const startMs = startDatetime
      ? new Date(startDatetime).getTime()
      : null;
    const endMs = endDatetime
      ? new Date(endDatetime).getTime()
      : null;

    try {
      const res = await fetch(`${API_BASE}/device-logs/read`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          device_id: deviceId.trim(),
          date: logDate,
          start_epoch_ms: startMs,
          end_epoch_ms: endMs,
          services: selectedServices.size > 0 ? Array.from(selectedServices) : [],
          search: searchQuery,
        }),
      });

      if (!res.ok) {
        const detail = await res.json().catch(() => ({ detail: `HTTP ${res.status}` }));
        throw new Error(detail.detail ?? `HTTP ${res.status}`);
      }

      const data = await res.json();
      setLogs(data.logs ?? []);
      setLogCount(data.count ?? 0);
    } catch (err: unknown) {
      setLogError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoadingLogs(false);
    }
  };

  // ---- Service filter toggle ----
  const toggleService = (svc: string) => {
    setSelectedServices((prev) => {
      const next = new Set(prev);
      if (next.has(svc)) next.delete(svc);
      else next.add(svc);
      return next;
    });
  };

  const toggleLevel = (l: string) => {
    setLevelFilter((prev) => {
      const next = new Set(prev);
      if (next.has(l)) next.delete(l);
      else next.add(l);
      return next;
    });
  };

  const filteredLogs = levelFilter.size > 0
    ? logs.filter((l) => levelFilter.has(l.level))
    : logs;

  const levelCounts = logs.reduce<Record<string, number>>((acc, l) => {
    acc[l.level] = (acc[l.level] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="space-y-6 animate-fadeIn">
      {/* Page Header */}
      <div>
        <h2 className="text-xl font-semibold text-white tracking-tight">Device Logs</h2>
        <p className="text-sm text-gray-500 mt-0.5">
          Download and explore device logs from S3 storage, filtered by time range and service.
        </p>
      </div>

      {/* ── Download Card ── */}
      <div className="ds-card">
        <div className="ds-card-header flex items-center gap-2">
          <DeviceIcon />
          <h3 className="text-sm font-semibold text-gray-300">Download Logs</h3>
          {downloadExitCode === 0 && (
            <span className="ml-auto text-[10px] bg-green-500/10 text-green-400 border border-green-500/20 px-2 py-0.5 rounded-full">
              Download complete
            </span>
          )}
          {downloadExitCode !== null && downloadExitCode !== 0 && (
            <span className="ml-auto text-[10px] bg-red-500/10 text-red-400 border border-red-500/20 px-2 py-0.5 rounded-full">
              Exited with code {downloadExitCode}
            </span>
          )}
        </div>

        <div className="ds-card-body space-y-4">
          {/* Device ID + Date row */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="ds-label">
                Device ID
                <span className="text-red-400 ml-0.5">*</span>
              </label>
              <input
                type="text"
                className="ds-input w-full"
                placeholder="e.g. 103062502313"
                value={deviceId}
                onChange={(e) => setDeviceId(e.target.value)}
                disabled={downloading}
              />
            </div>
            <div className="space-y-1.5">
              <label className="ds-label">Date</label>
              <input
                type="date"
                className="ds-input w-full"
                value={logDate}
                onChange={(e) => setLogDate(e.target.value)}
                disabled={downloading}
              />
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-3 pt-1">
            <button
              onClick={handleDownload}
              disabled={downloading || !deviceId.trim() || !logDate}
              className="ds-btn-primary"
            >
              {downloading ? (
                <>
                  <Spinner />
                  Downloading…
                </>
              ) : (
                <>
                  <DownloadIcon />
                  Download Logs
                </>
              )}
            </button>

            {downloading && (
              <button onClick={handleStopDownload} className="ds-btn-danger">
                <StopIcon />
                Stop
              </button>
            )}

            {downloading && (
              <span className="text-xs text-gray-500 tabular-nums">
                {downloadElapsed}s
              </span>
            )}

            {/* Check existing files without re-downloading */}
            {!downloading && deviceId.trim() && logDate && (
              <button
                onClick={() => fetchAvailableFiles(deviceId.trim(), logDate)}
                className="ds-btn-secondary"
              >
                <RefreshIcon />
                Check Existing
              </button>
            )}
          </div>

          {/* Download console */}
          {(downloadLines.length > 0 || downloading) && (
            <div className="mt-2">
              <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-2">
                  <TerminalIcon />
                  <span className="text-xs font-medium text-gray-400">Console</span>
                  {downloadLines.length > 0 && (
                    <span className="text-[10px] text-gray-600 bg-white/[0.04] px-1.5 py-0.5 rounded">
                      {downloadLines.length} lines
                    </span>
                  )}
                  {downloading && (
                    <span className="flex h-2 w-2 rounded-full bg-green-500 animate-pulse" />
                  )}
                </div>
                {!downloading && downloadLines.length > 0 && (
                  <button
                    onClick={() => setDownloadLines([])}
                    className="text-[10px] text-gray-600 hover:text-gray-400 transition-colors"
                  >
                    Clear
                  </button>
                )}
              </div>
              <pre
                ref={consoleRef}
                className="console-output h-48 overflow-y-auto bg-[#0a0c12] rounded-xl border border-white/[0.06] p-3 font-[family-name:var(--font-geist-mono)] text-xs leading-relaxed"
              >
                {downloadLines.length === 0 && downloading ? (
                  <span className="text-gray-600 italic">Starting…</span>
                ) : (
                  downloadLines.map((l, i) => (
                    <div
                      key={i}
                      className={
                        l.type === "error"
                          ? "text-red-400"
                          : l.type === "info"
                          ? "text-yellow-400 italic"
                          : "text-green-400"
                      }
                    >
                      {l.text}
                    </div>
                  ))
                )}
                {downloading && (
                  <span className="inline-block animate-pulse text-gray-500">▊</span>
                )}
              </pre>
            </div>
          )}
        </div>
      </div>

      {/* ── Log Viewer Card ── */}
      <div className="ds-card">
        <div className="ds-card-header flex items-center gap-2">
          <LogsIcon />
          <h3 className="text-sm font-semibold text-gray-300">Log Viewer</h3>
          {logCount > 0 && (
            <span className="text-[10px] bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 px-2 py-0.5 rounded-full">
              {filteredLogs.length.toLocaleString()} / {logCount.toLocaleString()} lines
            </span>
          )}
        </div>

        <div className="ds-card-body space-y-4">
          {/* Time range */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="ds-label">Start Time (UTC)</label>
              <input
                type="datetime-local"
                className="ds-input w-full"
                value={startDatetime}
                onChange={(e) => setStartDatetime(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <label className="ds-label">End Time (UTC)</label>
              <input
                type="datetime-local"
                className="ds-input w-full"
                value={endDatetime}
                onChange={(e) => setEndDatetime(e.target.value)}
              />
            </div>
          </div>

          {/* Search */}
          <div className="space-y-1.5">
            <label className="ds-label">Search</label>
            <div className="relative">
              <SearchIcon />
              <input
                type="text"
                className="ds-input w-full pl-8"
                placeholder="Filter log lines by text…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleLoadLogs()}
              />
            </div>
          </div>

          {/* Service filter */}
          {availableServices.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="ds-label">Services</label>
                <div className="flex gap-2">
                  <button
                    onClick={() => setSelectedServices(new Set(availableServices))}
                    className="text-[10px] text-indigo-400 hover:text-indigo-300 transition-colors"
                  >
                    All
                  </button>
                  <span className="text-gray-700">·</span>
                  <button
                    onClick={() => setSelectedServices(new Set())}
                    className="text-[10px] text-gray-500 hover:text-gray-300 transition-colors"
                  >
                    None
                  </button>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {availableServices.map((svc) => (
                  <button
                    key={svc}
                    onClick={() => toggleService(svc)}
                    className={`text-[11px] px-2.5 py-1 rounded-[8px] border transition-all duration-150 font-medium ${
                      selectedServices.has(svc)
                        ? "bg-indigo-500/10 text-indigo-300 border-indigo-500/20"
                        : "bg-white/[0.03] text-gray-600 border-white/[0.06] hover:text-gray-400"
                    }`}
                  >
                    {svc}
                  </button>
                ))}
              </div>
            </div>
          )}

          {availableServices.length === 0 && !downloading && (
            <p className="text-xs text-gray-600 italic">
              No log files found. Enter a device ID and date above, then click{" "}
              <strong className="text-gray-500">Download Logs</strong> or{" "}
              <strong className="text-gray-500">Check Existing</strong>.
            </p>
          )}

          {/* Load button */}
          <div className="flex items-center gap-3 pt-1 border-t border-white/[0.04]">
            <button
              onClick={handleLoadLogs}
              disabled={loadingLogs || !deviceId.trim() || !logDate}
              className="ds-btn-primary"
            >
              {loadingLogs ? (
                <>
                  <Spinner />
                  Loading…
                </>
              ) : (
                <>
                  <PlayIcon />
                  Load Logs
                </>
              )}
            </button>
            {logs.length > 0 && (
              <button
                onClick={() => { setLogs([]); setLogCount(0); setLogError(null); }}
                className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
              >
                Clear
              </button>
            )}
          </div>

          {/* Error */}
          {logError && (
            <div className="rounded-[10px] border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-400">
              {logError}
            </div>
          )}

          {/* Level filter (shown after loading) */}
          {logs.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="ds-label">Filter by Level</label>
                {levelFilter.size > 0 && (
                  <button
                    onClick={() => setLevelFilter(new Set())}
                    className="text-[10px] text-gray-500 hover:text-gray-300 transition-colors"
                  >
                    Clear filter
                  </button>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(levelCounts)
                  .sort(([, a], [, b]) => b - a)
                  .map(([level, count]) => (
                    <button
                      key={level}
                      onClick={() => toggleLevel(level)}
                      className={`flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-[8px] border transition-all duration-150 font-medium ${
                        levelFilter.has(level)
                          ? levelBadgeClass(level)
                          : levelFilter.size === 0
                          ? levelBadgeClass(level)
                          : "bg-white/[0.02] text-gray-700 border-white/[0.04] opacity-50"
                      }`}
                    >
                      <span>{levelLabel(level)}</span>
                      <span className="opacity-70">{count.toLocaleString()}</span>
                    </button>
                  ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Log Lines Panel ── */}
      {filteredLogs.length > 0 && (
        <div className="ds-card overflow-hidden">
          <div className="ds-card-header flex items-center justify-between">
            <div className="flex items-center gap-2">
              <LogsIcon />
              <span className="text-sm font-semibold text-gray-300">Log Lines</span>
              <span className="text-[10px] text-gray-500 bg-white/[0.04] px-1.5 py-0.5 rounded">
                {filteredLogs.length.toLocaleString()} lines
              </span>
            </div>
            <div className="flex items-center gap-3 text-[10px] text-gray-600">
              <span>Timestamps in UTC</span>
            </div>
          </div>

          <div
            ref={logViewRef}
            className="console-output h-[520px] overflow-y-auto bg-[#0a0c12]"
          >
            <table className="w-full text-xs font-[family-name:var(--font-geist-mono)]">
              <thead className="sticky top-0 z-10 bg-[#0d0f18] border-b border-white/[0.06]">
                <tr className="text-left text-[10px] text-gray-600 uppercase tracking-wider">
                  <th className="px-3 py-2 w-[160px]">Timestamp</th>
                  <th className="px-2 py-2 w-[110px]">Service</th>
                  <th className="px-2 py-2 w-[56px]">Level</th>
                  <th className="px-3 py-2">Message</th>
                </tr>
              </thead>
              <tbody>
                {filteredLogs.map((entry, i) => {
                  const ts = entry.epoch_ms
                    ? new Date(entry.epoch_ms).toISOString().replace("T", " ").slice(0, 19)
                    : "—";
                  // Strip the reconstructed prefix from the line to get just the message
                  const message = parseLogMessage(entry.line);
                  return (
                    <tr
                      key={i}
                      className={`border-b border-white/[0.03] transition-colors hover:bg-white/[0.02] ${
                        i % 2 === 0 ? "bg-transparent" : "bg-white/[0.01]"
                      }`}
                    >
                      <td className="px-3 py-1.5 text-gray-500 tabular-nums whitespace-nowrap align-top">
                        {ts}
                      </td>
                      <td className="px-2 py-1.5 align-top">
                        <span className="text-[10px] bg-white/[0.05] text-gray-400 px-1.5 py-0.5 rounded-md truncate max-w-[100px] inline-block">
                          {entry.service}
                        </span>
                      </td>
                      <td className="px-2 py-1.5 align-top">
                        <span
                          className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${levelBadgeClass(entry.level)}`}
                        >
                          {entry.level}
                        </span>
                      </td>
                      <td
                        className={`px-3 py-1.5 break-all align-top leading-relaxed ${levelColor(entry.level)}`}
                      >
                        {message}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Empty state after loading */}
      {!loadingLogs && logs.length === 0 && !logError && logCount === 0 && (
        <div className="ds-card">
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="h-12 w-12 rounded-2xl bg-white/[0.04] border border-white/[0.06] flex items-center justify-center mb-4">
              <LogsIcon size={20} />
            </div>
            <p className="text-sm font-medium text-gray-400">No logs loaded yet</p>
            <p className="text-xs text-gray-600 mt-1 max-w-64">
              Enter a device ID and date, download the logs (or check existing), then click{" "}
              <strong className="text-gray-500">Load Logs</strong>.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Log message parser — strips the timestamp prefix added by logs_download.py
// Format: "YYYY-MM-DD HH:MM:SS: {epoch_ms}: {counter}: {level} : {message}"
// ---------------------------------------------------------------------------

function parseLogMessage(line: string): string {
  // Try to strip reconstructed prefix: "YYYY-MM-DD HH:MM:SS: 13digits: counter: "
  const prefixMatch = line.match(
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}: \d{13}: \d+: [IEWDCV] : ([\s\S]*)$/
  );
  if (prefixMatch) return prefixMatch[1];
  return line;
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

function DeviceIcon() {
  return (
    <svg className="h-4 w-4 text-gray-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 1.5H8.25A2.25 2.25 0 006 3.75v16.5a2.25 2.25 0 002.25 2.25h7.5A2.25 2.25 0 0018 20.25V3.75a2.25 2.25 0 00-2.25-2.25H13.5m-3 0V3h3V1.5m-3 0h3m-3 15.75h3" />
    </svg>
  );
}

function LogsIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      className="shrink-0 text-gray-500"
      style={{ height: size, width: size }}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
    </svg>
  );
}

function TerminalIcon() {
  return (
    <svg className="h-3.5 w-3.5 text-gray-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0021 18V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v12a2.25 2.25 0 002.25 2.25z" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-600 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
    </svg>
  );
}

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

function DownloadIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
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
