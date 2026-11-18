"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Types — mirror backend/relay_ops.py
// ---------------------------------------------------------------------------

type Use = "required" | "optional" | "one of" | null;
interface CommandSpec {
  key: string;
  name: string;      // as typed after relayctl.py, e.g. "restart device"
  option: string;    // dropdown text
  group: string;
  switching: boolean;
  help: string;
  multiple: boolean; // several device ids allowed
  inputs: { bench_ids: Use; pi: Use; dry_run: Use; timeout: Use };
}
interface RelayConfig {
  available: boolean;
  relayctl_path: string;
  default_timeout: number;
  groups: { key: string; label: string; benches: string[] }[];
  commands: CommandSpec[];
  rules: string[];
}
interface Job {
  id: string;
  command: string;
  label: string;
  targets: string[];
  dry_run: boolean;
  force: boolean;
  switching: boolean;
  display: string;
  started: number;
  finished: number | null;
  state: "running" | "done" | "failed" | "error" | "lost";
  exit_code: number | null;
  lines: string[];
  next: number;
}
type JobSummary = Omit<Job, "lines">;

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://172.16.23.15:8000";
const POLL_MS = 1500;
const GROUP_ORDER = ["Before every run", "When something changed", "A bench is not answering", "Relay or Pi problems"];
const orderedGroups = (cmds: { group: string }[]) =>
  Array.from(new Set(cmds.map((c) => c.group))).sort((a, b) => (GROUP_ORDER.indexOf(a) + 1 || 99) - (GROUP_ORDER.indexOf(b) + 1 || 99));

// Survives tab switches, like the Scripts page cache.
let LAST_JOB_ID: string | null = null;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { const j = await res.json(); if (j?.detail) detail = String(j.detail); } catch { /* keep status */ }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

function fmtDuration(start: number, end: number | null): string {
  const s = Math.max(0, Math.round((end ?? Date.now() / 1000) - start));
  return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function RelayControl() {
  const [cfg, setCfg] = useState<RelayConfig | null>(null);
  const [cfgError, setCfgError] = useState("");
  const [cmdKey, setCmdKey] = useState("check");
  const [benchText, setBenchText] = useState("");
  const [piText, setPiText] = useState("");
  const [timeoutSec, setTimeoutSec] = useState("1800");
  const [confirming, setConfirming] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const [recent, setRecent] = useState<JobSummary[]>([]);
  const [audit, setAudit] = useState<string[] | null>(null);
  const [copied, setCopied] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [docsOpen, setDocsOpen] = useState(false);

  const termRef = useRef<HTMLPreElement>(null);
  const followRef = useRef(true);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const jobIdRef = useRef<string | null>(null);

  const cmd = useMemo(() => cfg?.commands.find((c) => c.key === cmdKey), [cfg, cmdKey]);
  const split = (t: string) => Array.from(new Set(t.split(/[\s,;[\]"']+/).filter(Boolean)));
  const benches = useMemo(() => split(benchText), [benchText]);
  const pis = useMemo(() => split(piText), [piText]);
  const benchUsed = cmd?.inputs.bench_ids ?? null;
  const piUsed = cmd?.inputs.pi ?? null;
  const targets = [...(benchUsed ? benches : []), ...(piUsed ? pis : [])];

  // What is still missing or wrong for the chosen command.
  const problem = useMemo(() => {
    if (!cmd) return "";
    if (benchUsed === "required" && benches.length === 0) return "Enter a device id.";
    if (piUsed === "required" && pis.length === 0) return "Enter a Pi name.";
    if (benchUsed === "one of" && benches.length + pis.length !== 1) return "Enter one Pi name or one device id, not both.";
    if (benchUsed === "required" && !cmd.multiple && benches.length > 1) return "Only one device id is allowed for this command.";
    if (piUsed && pis.length > 1) return "Only one Pi name is allowed.";
    return "";
  }, [cmd, benchUsed, piUsed, benches, pis]);

  // ---- polling ------------------------------------------------------------

  const stopPolling = () => { if (pollRef.current) { clearTimeout(pollRef.current); pollRef.current = null; } };

  const poll = useCallback((id: string, after: number) => {
    stopPolling();
    api<Job>(`/relay/jobs/${id}?after=${after}`)
      .then((v) => {
        if (jobIdRef.current !== id) return;
        setJob((prev) => ({ ...v, lines: prev && prev.id === id && after > 0 ? [...prev.lines, ...v.lines] : v.lines }));
        if (v.state === "running") pollRef.current = setTimeout(() => poll(id, v.next), POLL_MS);
        else api<JobSummary[]>("/relay/jobs").then(setRecent).catch(() => {});
      })
      .catch((e: Error) => {
        if (jobIdRef.current !== id) return;
        // Keep trying: a long restart must not be lost because one poll failed.
        setStartError(`Lost contact with the backend (${e.message}). Retrying…`);
        pollRef.current = setTimeout(() => poll(id, after), POLL_MS * 3);
      });
  }, []);

  const attach = useCallback((id: string) => {
    jobIdRef.current = id;
    LAST_JOB_ID = id;
    followRef.current = true;
    setJob(null);
    setStartError("");
    poll(id, 0);
  }, [poll]);

  useEffect(() => {
    api<RelayConfig>("/relay/config").then(setCfg).catch((e: Error) => setCfgError(e.message));
    api<JobSummary[]>("/relay/jobs")
      .then((list) => {
        setRecent(list);
        const resume = list.find((j) => j.state === "running") ?? list.find((j) => j.id === LAST_JOB_ID);
        if (resume) attach(resume.id);
      })
      .catch(() => {});
    return () => { jobIdRef.current = null; stopPolling(); };
  }, [attach]);

  useEffect(() => {
    const el = termRef.current;
    if (el && followRef.current) el.scrollTop = el.scrollHeight;
  }, [job?.lines.length]);

  // ---- actions ------------------------------------------------------------

  const run = async (dry: boolean) => {
    if (!cmd) return;
    setStarting(true); setStartError(""); setConfirming(false);
    try {
      const v = await api<Job>("/relay/jobs", {
        method: "POST",
        body: JSON.stringify({
          command: cmd.key, targets, dry_run: dry,
          confirmed: cmd.switching && !dry, force: false,
          timeout: cmd.inputs.timeout ? Math.max(60, Number(timeoutSec) || cfg!.default_timeout) : undefined,
          actor: "dashboard",
        }),
      });
      jobIdRef.current = v.id; LAST_JOB_ID = v.id; followRef.current = true;
      setJob(v);
      if (v.state === "running") poll(v.id, v.next);
      else api<JobSummary[]>("/relay/jobs").then(setRecent).catch(() => {});
      api<JobSummary[]>("/relay/jobs").then(setRecent).catch(() => {});
    } catch (e) {
      setStartError((e as Error).message);
    } finally {
      setStarting(false);
    }
  };

  const loadAudit = () => api<{ lines: string[] }>("/relay/audit?lines=40").then((d) => setAudit(d.lines)).catch((e: Error) => setAudit([`Could not read the audit log: ${e.message}`]));

  const copyOutput = () => {
    if (!job) return;
    navigator.clipboard.writeText(job.lines.join("\n")).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {});
  };

  const running = job?.state === "running";
  const allChannelsWarning = cmd && (cmd.key === "restart-relay" || cmd.key === "restart-pi");
  const canRun = !!cmd && !problem && !starting && cfg?.available;

  // ---- render -------------------------------------------------------------

  if (cfgError) {
    return <p className="rounded-lg border border-red-500/20 bg-red-500/[0.06] px-3 py-2 text-[12.5px] text-red-300">Could not reach the backend: {cfgError}</p>;
  }
  if (!cfg) return <p className="text-[13px] text-gray-500">Loading…</p>;

  const showBoth = benchUsed === "one of";
  const hint = benchText || piText ? problem : "";

  return (
    <div className="space-y-4">
      {!cfg.available && (
        <div className="rounded-lg border border-amber-500/25 bg-amber-500/[0.07] px-4 py-3 text-[12.5px] text-amber-200">
          relayctl.py was not found at <code className="font-mono">{cfg.relayctl_path}</code>. It only runs on the backend next to it (the DTA server).
        </div>
      )}

      {/* One row: command, the inputs it needs, run */}
      <div className="ds-card px-4 py-3.5">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="mb-1 block text-[11.5px] text-gray-500" htmlFor="relay-command">Command</label>
            <select
              id="relay-command" className="ds-input !text-[13px] w-48"
              value={cmdKey}
              onChange={(e) => { setCmdKey(e.target.value); setConfirming(false); setStartError(""); }}
            >
              {orderedGroups(cfg.commands).map((g) => (
                <optgroup key={g} label={g}>
                  {cfg.commands.filter((c) => c.group === g).map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}
                </optgroup>
              ))}
            </select>
          </div>

          {benchUsed && (
            <div className="min-w-[260px] flex-1">
              <label className="mb-1 block text-[11.5px] text-gray-500" htmlFor="relay-bench">{cmd?.multiple ? "Device IDs" : "Device ID"}{benchUsed === "optional" && " (optional)"}</label>
              <input
                id="relay-bench" className="ds-input !text-[13px] w-full font-mono" value={benchText} onChange={(e) => setBenchText(e.target.value)}
                placeholder={cmd?.multiple ? "ids separated by space or comma" : "device id"}
              />
            </div>
          )}
          {benchUsed && cmd?.multiple && (
            <div>
              <label className="mb-1 block text-[11.5px] text-gray-500" htmlFor="relay-preset">Preset</label>
              <select id="relay-preset" className="ds-input !text-[13px] w-24" value="" onChange={(e) => { const g = cfg.groups.find((x) => x.key === e.target.value); if (g) setBenchText(g.benches.join(" ")); }}>
                <option value="">Fill…</option>
                {cfg.groups.map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
              </select>
            </div>
          )}
          {piUsed && (
            <div>
              <label className="mb-1 block text-[11.5px] text-gray-500" htmlFor="relay-pi">{showBoth ? "or Pi" : "Pi"}{piUsed === "optional" && " (optional)"}</label>
              <input id="relay-pi" className="ds-input !text-[13px] w-32 font-mono" value={piText} onChange={(e) => setPiText(e.target.value)} placeholder="pirk1" />
            </div>
          )}
          {cmd?.inputs.timeout && (
            <div>
              <label className="mb-1 block text-[11.5px] text-gray-500" htmlFor="relay-timeout">Wait limit (s)</label>
              <input id="relay-timeout" type="number" min={60} className="ds-input !text-[13px] w-24 font-mono" value={timeoutSec} onChange={(e) => setTimeoutSec(e.target.value)} />
            </div>
          )}

          {!confirming && (
            <div className="flex gap-2">
              {cmd?.switching && <button className="ds-btn-secondary" disabled={!canRun} onClick={() => run(true)}>Dry run</button>}
              <button
                className="ds-btn-primary" disabled={!canRun || running}
                onClick={() => (cmd?.switching ? setConfirming(true) : run(false))}
              >
                {starting ? "Starting…" : cmd?.switching ? "Run…" : "Run"}
              </button>
            </div>
          )}
          <button className="ml-auto text-[12px] text-gray-500 hover:text-gray-300" onClick={() => setRulesOpen((o) => !o)} aria-expanded={rulesOpen}>Rules</button>
        </div>

        {hint && <p className="mt-2 text-[12px] text-amber-300/90">{hint}</p>}

        {confirming && (
          <div role="alertdialog" aria-label="Confirm" className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/25 bg-amber-500/[0.07] px-3 py-2.5">
            <p className="text-[12.5px] text-amber-100">
              Switch real hardware: <span className="font-mono">{cmd?.name} {targets.join(" ")}</span>
              {allChannelsWarning && <span className="text-amber-200/80"> (turns every channel on that Pi ON)</span>}
              {cmd?.key === "restart-device" && <span className="text-amber-200/80"> (takes about 35 min)</span>}
            </p>
            <div className="flex gap-2">
              <button className="ds-btn-danger" onClick={() => run(false)} disabled={starting}>{starting ? "Starting…" : "Confirm"}</button>
              <button className="ds-btn-secondary" onClick={() => setConfirming(false)}>Cancel</button>
            </div>
          </div>
        )}
        {startError && <p className="mt-2 rounded-lg border border-red-500/20 bg-red-500/[0.06] px-3 py-2 text-[12.5px] text-red-300">{startError}</p>}
        {rulesOpen && (
          <ul className="mt-3 list-disc space-y-1 pl-5 text-[12px] text-gray-500">
            {cfg.rules.map((r) => <li key={r}>{r}</li>)}
          </ul>
        )}
      </div>

      {/* Output */}
      <div className="ds-card overflow-hidden">
        <div className="flex items-center justify-between gap-2 border-b border-white/[0.05] px-4 py-2">
          <p className="truncate font-mono text-[12px] text-gray-400">
            {job ? job.display : "Output"}
            {job?.dry_run && <span className="ml-2 font-sans text-sky-300">dry run</span>}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            {job && (
              <span
                className={`rounded-full px-2.5 py-0.5 text-[11.5px] font-medium ring-1 ring-inset ${
                  job.state === "running" ? "bg-sky-500/10 text-sky-300 ring-sky-400/30"
                  : job.state === "done" ? "bg-emerald-500/10 text-emerald-300 ring-emerald-400/30"
                  : "bg-red-500/10 text-red-300 ring-red-400/30"
                }`}
              >
                {job.state === "running" ? `running ${fmtDuration(job.started, null)}`
                  : job.state === "done" ? `done in ${fmtDuration(job.started, job.finished)}`
                  : job.state === "lost" ? "ended, result not recorded"
                  : job.exit_code === 1 && (job.command === "check" || job.command === "boards") ? "finished: BAD found"
                  : `failed (exit ${job.exit_code})`}
              </span>
            )}
            {job && <button className="ds-btn-secondary !px-2.5 !py-1 !text-[11.5px]" onClick={copyOutput}>{copied ? "Copied" : "Copy"}</button>}
          </div>
        </div>
        <pre
          ref={termRef}
          onScroll={(e) => { const el = e.currentTarget; followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}
          className="h-[48vh] min-h-[240px] overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-[12.5px] leading-[1.45]"
          style={{ background: "var(--term-bg, #0d0e12)", color: "var(--term-fg, #d7d9e0)" }}
          aria-live="off"
        >
          {job ? (job.lines.length ? job.lines.join("\n") : (running ? "Waiting for output…" : "(no output)")) : ""}
        </pre>
      </div>

      {/* History */}
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <span className="text-gray-600">Recent</span>
        {recent.slice(0, 6).map((j) => (
          <button
            key={j.id} onClick={() => attach(j.id)}
            className={`rounded-full px-2.5 py-0.5 ring-1 ring-inset hover:text-gray-200 ${job?.id === j.id ? "ring-indigo-400/40 text-indigo-200" : "ring-white/[0.08] text-gray-400"}`}
          >
            <span className={j.state === "running" ? "text-sky-300" : j.state === "done" ? "text-emerald-300" : "text-red-300"}>●</span>{" "}
            {j.label}{j.dry_run ? " (dry)" : ""}
          </button>
        ))}
        <button className="ml-auto text-gray-500 hover:text-gray-300" aria-expanded={audit !== null} onClick={() => (audit === null ? loadAudit() : setAudit(null))}>{audit === null ? "Audit log" : "Hide audit log"}</button>
      </div>
      {audit && (
        <pre className="max-h-[200px] overflow-auto whitespace-pre-wrap rounded-lg bg-black/30 px-3 py-2 font-mono text-[11.5px] text-gray-400">
          {audit.length ? audit.join("\n") : "relayctl.log is empty or not found."}
        </pre>
      )}

      {/* Docs */}
      <div className="pt-1">
        <button
          className="ds-btn-secondary" aria-expanded={docsOpen} aria-controls="relay-docs"
          onClick={() => { setDocsOpen((o) => !o); if (!docsOpen) setTimeout(() => document.getElementById("relay-docs")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50); }}
        >
          {docsOpen ? "Hide docs" : "Docs"}
        </button>
      </div>
      {docsOpen && <RelayDocs commands={cfg.commands} rules={cfg.rules} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Docs — what each command does, how to use it, when
// ---------------------------------------------------------------------------

const DOC_TEXT: Record<string, { what: string; inputs: string; when: string }> = {
  check: {
    what: "Tests three things per bench: DEVICE (answers ping and SSH), RELAY and PI (answers ping, relay port 8081 open, no ping spikes). Then it switches every healthy bench's relay ON and reports RELAY: ON.",
    inputs: "Device IDs (several allowed). Use the D215 / D450 preset to fill the lists.",
    when: "Before every test run. Read the verdicts: anything BAD needs a look.",
  },
  boards: {
    what: "Lists the real relay boards on each Pi and flags any bench that is set up with a board id that does not exist.",
    inputs: "None. Optionally one Pi name to look at just that Pi.",
    when: "Before a run, or when relay commands behave strangely. A wrong board id is dangerous: it can switch a channel on every board of that Pi, so relayctl refuses to switch such a bench.",
  },
  discover: {
    what: "Listens to the benches' broadcasts for about 20 seconds and re-learns which bench is on which Pi, board and channel.",
    inputs: "None.",
    when: "After adding a device, moving a USB port or adding a Pi. Also when check says a bench is NOT in topology (run it while that bench is up).",
  },
  status: {
    what: "A detailed table per bench: pings, ARP, ports 22 and 8081, board and channel.",
    inputs: "Device IDs, or leave empty for all benches.",
    when: "To find out why a bench shows BAD in check.",
  },
  "pi-benches": {
    what: "Lists the benches wired to one Pi.",
    inputs: "A Pi name, for example pirk1.",
    when: "To see which benches a Pi problem affects, or before restarting a Pi.",
  },
  "pi-check": {
    what: "Logs in to the Pi and reports uptime, the USB relay boards it sees and its network.",
    inputs: "A Pi name.",
    when: "Several benches on the same Pi fail, for example with No route to host or relay errors.",
  },
  wake: {
    what: "Switches the bench's ignition relay ON, then waits until the bench answers ping.",
    inputs: "One device ID. Optional wait limit. Do the Dry run first.",
    when: "A bench is silent but its relay and Pi look fine.",
  },
  "restart-device": {
    what: "First checks that the bench answers ping, then ignition OFF, waits until the device is really down, then ON again. Takes about 35 minutes: ping stops after about a minute, but the device only really powers off after its shutdown delay, so ignition stays OFF for 30 minutes in total before ON (switching ON earlier does not reboot it). It works the same whether the bench answers ping or not: OFF, wait, ON.",
    inputs: "One device ID. Wait limit is raised to at least 55 min automatically. Do the Dry run first.",
    when: "A bench is down, hung or misbehaving and a plain wake did not help. It is the same as turning ignition OFF by hand, waiting 30 minutes and turning it ON. It keeps running if you close the page; open Recent to see it again.",
  },
  "restart-relay": {
    what: "Restarts the relay service on the Pi. It is back in about 3 seconds. Every channel on that Pi's boards is switched ON.",
    inputs: "One Pi name or one device ID. Do the Dry run first.",
    when: "The Pi answers but relay commands fail. Do not use it while a run is using benches on that Pi.",
  },
  "restart-pi": {
    what: "Reboots the Pi. It is back in 1-2 minutes. Every channel on its boards is switched ON.",
    inputs: "One Pi name. Optional wait limit. Do the Dry run first.",
    when: "Restart relay did not fix it. If the Pi does not come back within 240 seconds, only its wall adapter can help.",
  },
  recover: {
    what: "Walks the whole ladder: wake, then relay restart, then Pi reboot, checking after each step and stopping when the bench answers.",
    inputs: "One device ID. Optional wait limit. Do the Dry run first.",
    when: "A bench is down and you do not know which layer is at fault.",
  },
};

function RelayDocs({ commands, rules }: { commands: CommandSpec[]; rules: string[] }) {
  const groups = orderedGroups(commands);
  const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <section className="space-y-2">
      <h4 className="text-[13px] font-semibold text-gray-200">{title}</h4>
      {children}
    </section>
  );
  const Bullets = ({ items }: { items: string[] }) => (
    <ul className="list-disc space-y-1 pl-5 text-[12.5px] leading-relaxed text-gray-400">{items.map((i) => <li key={i}>{i}</li>)}</ul>
  );
  return (
    <div id="relay-docs" className="ds-card space-y-6 px-5 py-5 scroll-mt-4">
      <div>
        <h3 className="text-[15px] font-semibold text-gray-100">Relay Control guide</h3>
        <p className="mt-1 text-[12.5px] leading-relaxed text-gray-400">
          Each bench is wired like this: DTA server, then LAN, then a Raspberry Pi, then USB to a relay board, then the ignition line to the bench.
          This page checks and recovers every step of that chain. It runs the relayctl tool on the DTA server.
        </p>
      </div>

      <Section title="Quick start">
        <Bullets items={[
          "Before a run: choose check, press Fill D215 (or D450) in Preset, press Run. Every bench should show DEVICE: OK, RELAY: ON, PI: OK.",
          "If something shows BAD: use status for details, then follow the ladder below.",
          "Anything that switches hardware has a Dry run button. Press it first: it shows what would happen and switches nothing. Then press Run… and confirm.",
          "Long jobs (restart device takes about 35 minutes) keep running if you close the page. Open Relay Control again and pick the job under Recent.",
          "Every switching action is written to relayctl.log. Audit log shows its last lines.",
        ]} />
      </Section>

      <Section title="Commands">
        <div className="space-y-4">
          {groups.map((g) => (
            <div key={g}>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-gray-500">{g}</p>
              <div className="grid gap-3 lg:grid-cols-2">
                {commands.filter((c) => c.group === g).map((c) => {
                  const d = DOC_TEXT[c.key];
                  return (
                    <div key={c.key} className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-4 py-3">
                      <div className="mb-1.5 flex items-center gap-2">
                        <span className="font-mono text-[13px] font-semibold text-gray-100">{c.name}</span>
                        {c.switching && <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10.5px] font-medium text-amber-300 ring-1 ring-inset ring-amber-400/30">switches hardware</span>}
                      </div>
                      <dl className="space-y-1.5 text-[12.5px] leading-relaxed">
                        <div><dt className="inline font-medium text-gray-300">What: </dt><dd className="inline text-gray-400">{d?.what ?? c.help}</dd></div>
                        <div><dt className="inline font-medium text-gray-300">Input: </dt><dd className="inline text-gray-400">{d?.inputs ?? "See the form."}</dd></div>
                        <div><dt className="inline font-medium text-gray-300">When: </dt><dd className="inline text-gray-400">{d?.when ?? ""}</dd></div>
                      </dl>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Reading the check result">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[12.5px]">
            <thead className="text-[11px] uppercase tracking-wide text-gray-500">
              <tr><th className="py-1.5 pr-4 font-medium">Column</th><th className="py-1.5 pr-4 font-medium">Good</th><th className="py-1.5 font-medium">Problem</th></tr>
            </thead>
            <tbody className="align-top text-gray-400">
              <tr className="border-t border-white/[0.05]"><td className="py-2 pr-4 font-medium text-gray-300">DEVICE</td><td className="py-2 pr-4">OK: the bench answers ping and its SSH port is open (it is on).</td><td className="py-2">BAD (no ping) or BAD (ssh closed). Note: after ignition OFF the device stays up for 15-20 minutes before it powers down.</td></tr>
              <tr className="border-t border-white/[0.05]"><td className="py-2 pr-4 font-medium text-gray-300">RELAY</td><td className="py-2 pr-4">ON: the relay was switched ON and the relay service confirmed it. The relay service cannot report the state of a channel, so check always switches it ON.</td><td className="py-2">BAD (…) with the reason, for example a board id that is not a real board, or the relay program not listening. ? (ON sent, not confirmed) means the command went out but there was no confirmation. ? (…) means it could not tell, for example no login for that Pi.</td></tr>
              <tr className="border-t border-white/[0.05]"><td className="py-2 pr-4 font-medium text-gray-300">PI(name)</td><td className="py-2 pr-4">OK: the Pi answers ping, its relay port 8081 is open and ping is stable.</td><td className="py-2">BAD (no ping), BAD (relay port closed) or BAD (unstable: ping spikes).</td></tr>
            </tbody>
          </table>
        </div>
        <p className="text-[12.5px] text-gray-400">The last line counts the benches with at least one BAD layer. Check is refused on a bench while a restart device or recover is running on it, because it would switch the relay ON in the middle of the restart.</p>
      </Section>

      <Section title="Which command for which problem">
        <Bullets items={[
          "One bench silent: check, then status, then wake, then restart device.",
          "Several benches on one Pi fail (No route to host, relay errors): check one of them to see which layer is BAD, then pi-check, then restart relay, then restart pi.",
          "Not sure which layer: recover walks wake, relay restart and Pi reboot for you and stops when the bench answers.",
          "New device, moved port or new Pi: discover, then check.",
          "A bench is set up with a board id that does not exist: run boards. relayctl refuses to switch such a bench until it is fixed.",
        ]} />
      </Section>

      <Section title="Rules to remember">
        <Bullets items={rules} />
      </Section>
    </div>
  );
}
