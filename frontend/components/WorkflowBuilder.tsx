"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactFlow, {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  Controls,
  MiniMap,
  Connection,
  Edge,
  EdgeChange,
  Node,
  NodeChange,
  MarkerType,
  ReactFlowInstance,
  EdgeProps,
  getBezierPath,
  EdgeLabelRenderer,
} from "reactflow";
import "reactflow/dist/style.css";

import ScriptNode, { ScriptNodeData } from "./WorkflowNode";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ScriptInfo {
  name: string;
  description: string;
  args: { name: string; type: string; default: string }[];
}

interface WorkflowDef {
  id: number | null;
  name: string;
  description: string;
  definition: {
    nodes: Node<ScriptNodeData>[];
    edges: Edge[];
  };
}

type ConditionType = "success" | "failure" | "always";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const CONDITION_COLORS: Record<ConditionType, string> = {
  success: "#22c55e",
  failure: "#ef4444",
  always:  "#6366f1",
};

// ---------------------------------------------------------------------------
// Custom Edge with condition label
// ---------------------------------------------------------------------------

function ConditionEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  style = {},
  markerEnd,
}: EdgeProps) {
  const condition: ConditionType = data?.condition ?? "always";
  const color = CONDITION_COLORS[condition];

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
  });

  return (
    <>
      <path
        id={id}
        style={{ ...style, stroke: color, strokeWidth: 2 }}
        className="react-flow__edge-path"
        d={edgePath}
        markerEnd={markerEnd}
      />
      <EdgeLabelRenderer>
        <div
          style={{
            position: "absolute",
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            pointerEvents: "all",
            backgroundColor: `${color}20`,
            borderColor: `${color}60`,
            color: color,
          }}
          className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border cursor-pointer select-none"
        >
          {condition}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

const nodeTypes = { scriptNode: ScriptNode };
const edgeTypes = { conditionEdge: ConditionEdge };

export default function WorkflowBuilder() {
  // ---- Scripts available in backend ----
  const [scripts, setScripts] = useState<ScriptInfo[]>([]);

  // ---- Flow state ----
  const [nodes, setNodes] = useState<Node<ScriptNodeData>[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [rfInstance, setRfInstance] = useState<ReactFlowInstance | null>(null);

  // ---- Workflow metadata ----
  const [workflowId, setWorkflowId] = useState<number | null>(null);
  const [workflowName, setWorkflowName] = useState("New Workflow");
  const [workflowDescription, setWorkflowDescription] = useState("");

  // ---- Saved workflows list ----
  const [savedWorkflows, setSavedWorkflows] = useState<WorkflowDef[]>([]);

  // ---- Node config modal ----
  const [configNode, setConfigNode] = useState<Node<ScriptNodeData> | null>(null);
  const [configArgs, setConfigArgs] = useState<Record<string, string>>({});
  const [configRetry, setConfigRetry] = useState(0);
  const [configScript, setConfigScript] = useState("");

  // ---- Edge condition modal ----
  const [configEdge, setConfigEdge] = useState<Edge | null>(null);
  const [configCondition, setConfigCondition] = useState<ConditionType>("success");

  // ---- Execution state ----
  const [executing, setExecuting] = useState(false);
  const [executionLog, setExecutionLog] = useState<Record<string, any>>({});
  const [showStepDetail, setShowStepDetail] = useState<string | null>(null);

  // ---- Live console ----
  const [consoleLines, setConsoleLines] = useState<{ stream: "stdout" | "stderr" | "info"; text: string; nodeId?: string; script?: string }[]>([]);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const consoleRef = useRef<HTMLPreElement>(null);

  // ---- UI ----
  const [saving, setSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");
  const nodeIdCounter = useRef(1);

  // ---- Auto-scroll console ----
  useEffect(() => {
    if (consoleRef.current) {
      consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
    }
  }, [consoleLines]);

  // ---- Fetch scripts + saved workflows on mount ----
  useEffect(() => {
    fetch(`${API_BASE}/scripts`)
      .then(r => r.json())
      .then(setScripts)
      .catch(() => {});

    fetchWorkflows();
  }, []);

  const fetchWorkflows = async () => {
    try {
      const r = await fetch(`${API_BASE}/workflows`);
      const data = await r.json();
      setSavedWorkflows(data);
    } catch {}
  };

  // ---- React Flow callbacks ----
  const onNodesChange = useCallback(
    (changes: NodeChange[]) => setNodes(nds => applyNodeChanges(changes, nds)),
    [],
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => setEdges(eds => applyEdgeChanges(changes, eds)),
    [],
  );
  const onConnect = useCallback(
    (conn: Connection) => {
      const newEdge: Edge = {
        ...conn,
        id: `e-${conn.source}-${conn.target}`,
        type: "conditionEdge",
        data: { condition: "success" },
        markerEnd: { type: MarkerType.ArrowClosed },
      } as Edge;
      setEdges(eds => addEdge(newEdge, eds));
    },
    [],
  );

  // ---- Helper: build default args from script metadata ----
  const getDefaultArgs = useCallback((scriptName: string): Record<string, string> => {
    const info = scripts.find(s => s.name === scriptName);
    if (!info) return {};
    const defaults: Record<string, string> = {};
    info.args.forEach(a => { defaults[a.name] = a.default ?? ""; });
    return defaults;
  }, [scripts]);

  // ---- Add a new script node ----
  const addNode = (scriptName: string) => {
    const id = `node_${nodeIdCounter.current++}`;
    const newNode: Node<ScriptNodeData> = {
      id,
      type: "scriptNode",
      position: { x: 250 + Math.random() * 200, y: 100 + nodes.length * 120 },
      data: {
        script: scriptName,
        retry: 0,
        args: getDefaultArgs(scriptName),
      },
    };
    setNodes(nds => [...nds, newNode]);
  };

  // ---- Node double-click → open config ----
  const onNodeDoubleClick = useCallback((_: React.MouseEvent, node: Node<ScriptNodeData>) => {
    setConfigNode(node);
    setConfigScript(node.data.script);
    setConfigRetry(node.data.retry);
    setConfigArgs({ ...node.data.args });
  }, []);

  // ---- Edge click → open condition config ----
  const onEdgeClick = useCallback((_: React.MouseEvent, edge: Edge) => {
    setConfigEdge(edge);
    setConfigCondition(edge.data?.condition ?? "success");
  }, []);

  // ---- Save node config ----
  const saveNodeConfig = () => {
    if (!configNode) return;
    setNodes(nds =>
      nds.map(n =>
        n.id === configNode.id
          ? { ...n, data: { ...n.data, script: configScript, retry: configRetry, args: configArgs } }
          : n,
      ),
    );
    setConfigNode(null);
  };

  // ---- Save edge condition ----
  const saveEdgeCondition = () => {
    if (!configEdge) return;
    setEdges(eds =>
      eds.map(e =>
        e.id === configEdge.id
          ? { ...e, data: { ...e.data, condition: configCondition } }
          : e,
      ),
    );
    setConfigEdge(null);
  };

  // ---- Delete selected nodes/edges via keyboard ----
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Delete" || e.key === "Backspace") {
        setNodes(nds => nds.filter(n => !n.selected));
        setEdges(eds => eds.filter(e => !e.selected));
      }
    },
    [],
  );

  // ---- Save workflow ----
  const saveWorkflow = async (): Promise<number | null> => {
    setSaving(true);
    setStatusMsg("");
    try {
      const body = {
        id: workflowId,
        name: workflowName,
        description: workflowDescription,
        definition: {
          nodes: nodes.map(n => ({
            id: n.id,
            type: n.type,
            position: n.position,
            data: n.data,
          })),
          edges: edges.map(e => ({
            id: e.id,
            source: e.source,
            target: e.target,
            type: e.type,
            data: e.data,
          })),
        },
      };
      const res = await fetch(`${API_BASE}/workflows`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      setWorkflowId(data.id);
      setStatusMsg("Saved!");
      fetchWorkflows();
      return data.id;
    } catch {
      setStatusMsg("Save failed");
      return null;
    } finally {
      setSaving(false);
      setTimeout(() => setStatusMsg(""), 2000);
    }
  };

  // ---- Load workflow ----
  const loadWorkflow = (wf: any) => {
    const def = typeof wf.definition_json === "string"
      ? JSON.parse(wf.definition_json)
      : wf.definition_json ?? wf.definition ?? { nodes: [], edges: [] };

    setWorkflowId(wf.id);
    setWorkflowName(wf.name);
    setWorkflowDescription(wf.description ?? "");
    setNodes(
      (def.nodes || []).map((n: any) => ({
        ...n,
        type: n.type || "scriptNode",
        data: { ...n.data, status: undefined, execution_time: undefined },
      })),
    );
    setEdges(
      (def.edges || []).map((e: any) => ({
        ...e,
        type: e.type || "conditionEdge",
        markerEnd: { type: MarkerType.ArrowClosed },
      })),
    );
    // reset counter
    const maxId = (def.nodes || []).reduce((m: number, n: any) => {
      const num = parseInt(n.id.replace(/\D/g, ""), 10);
      return isNaN(num) ? m : Math.max(m, num);
    }, 0);
    nodeIdCounter.current = maxId + 1;
    setExecutionLog({});
    setShowStepDetail(null);
  };

  // ---- New workflow ----
  const newWorkflow = () => {
    setWorkflowId(null);
    setWorkflowName("New Workflow");
    setWorkflowDescription("");
    setNodes([]);
    setEdges([]);
    setExecutionLog({});
    setShowStepDetail(null);
    nodeIdCounter.current = 1;
  };

  // ---- Delete workflow ----
  const deleteCurrentWorkflow = async () => {
    if (!workflowId) return;
    await fetch(`${API_BASE}/workflows/${workflowId}`, { method: "DELETE" });
    newWorkflow();
    fetchWorkflows();
  };

  // ---- Execute workflow ----
  const executeWorkflow = async () => {
    // If no ID yet, save first and use the returned ID directly
    // (React state won't update synchronously after saveWorkflow)
    let wid = workflowId;
    if (!wid) {
      const savedId = await saveWorkflow();
      wid = savedId;
    } else {
      // Re-save latest changes before executing
      await saveWorkflow();
    }
    if (!wid) {
      setStatusMsg("Save workflow first");
      return;
    }

    setExecuting(true);
    setExecutionLog({});
    setShowStepDetail(null);
    setConsoleLines([]);
    setConsoleOpen(true);

    // Reset all node statuses to pending
    setNodes(nds => nds.map(n => ({
      ...n,
      data: { ...n.data, status: "pending", execution_time: undefined },
    })));

    try {
      const res = await fetch(`${API_BASE}/workflows/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow_id: wid }),
      });

      const reader = res.body?.getReader();
      if (!reader) return;

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";

        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith("data: ")) continue;
          try {
            const evt = JSON.parse(line.slice(6));
            handleSSE(evt);
          } catch {}
        }
      }
    } catch {
      setStatusMsg("Execution failed");
    } finally {
      setExecuting(false);
    }
  };

  const handleSSE = (evt: any) => {
    switch (evt.type) {
      case "workflow_start":
        setConsoleLines(prev => [...prev, {
          stream: "info", text: `▶ Workflow started (run #${evt.run_id})`,
        }]);
        break;

      case "step_start":
        setNodes(nds => nds.map(n =>
          n.id === evt.node_id
            ? { ...n, data: { ...n.data, status: "running" } }
            : n,
        ));
        setConsoleLines(prev => [...prev, {
          stream: "info",
          text: `\n━━━ Running: ${evt.script_name} (${evt.node_id}) ━━━`,
          nodeId: evt.node_id,
          script: evt.script_name,
        }]);
        break;

      case "step_output":
        setConsoleLines(prev => [...prev, {
          stream: evt.stream as "stdout" | "stderr",
          text: evt.text,
          nodeId: evt.node_id,
        }]);
        break;

      case "step_retry":
        setExecutionLog(prev => ({
          ...prev,
          [evt.node_id]: { ...prev[evt.node_id], retry_attempt: evt.attempt },
        }));
        setConsoleLines(prev => [...prev, {
          stream: "info",
          text: `↻ Retrying (attempt ${evt.attempt})…`,
          nodeId: evt.node_id,
        }]);
        break;

      case "step_complete":
        setNodes(nds => nds.map(n =>
          n.id === evt.node_id
            ? { ...n, data: { ...n.data, status: evt.status, execution_time: evt.execution_time } }
            : n,
        ));
        setExecutionLog(prev => ({
          ...prev,
          [evt.node_id]: {
            status: evt.status,
            execution_time: evt.execution_time,
            stdout: evt.stdout,
            stderr: evt.stderr,
            output: evt.output,
          },
        }));
        setConsoleLines(prev => [...prev, {
          stream: "info",
          text: `${evt.status === "success" ? "✅" : "❌"} ${evt.node_id} → ${evt.status} (${evt.execution_time?.toFixed(1)}s)`,
          nodeId: evt.node_id,
        }]);
        break;

      case "step_skipped":
        setNodes(nds => nds.map(n =>
          n.id === evt.node_id
            ? { ...n, data: { ...n.data, status: "skipped" } }
            : n,
        ));
        setExecutionLog(prev => ({
          ...prev,
          [evt.node_id]: { status: "skipped" },
        }));
        setConsoleLines(prev => [...prev, {
          stream: "info",
          text: `⏭ ${evt.node_id} → skipped`,
          nodeId: evt.node_id,
        }]);
        break;

      case "workflow_end":
        setStatusMsg(
          evt.status === "success" ? "Workflow completed successfully!" : "Workflow finished with failures",
        );
        setConsoleLines(prev => [...prev, {
          stream: "info",
          text: `\n${evt.status === "success" ? "✅" : "❌"} Workflow ${evt.status} (run #${evt.run_id})`,
        }]);
        setTimeout(() => setStatusMsg(""), 4000);
        break;
    }
  };

  // ---- Render ----
  return (
    <div className="flex flex-col h-full gap-3">
      {/* Top bar */}
      <div className="flex items-center gap-3 flex-wrap rounded-xl border border-gray-800 bg-gray-900/70 px-4 py-3">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <div className="h-8 w-8 rounded-lg bg-indigo-600/20 flex items-center justify-center shrink-0">
            <svg className="h-4 w-4 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
            </svg>
          </div>
          <input
            className="bg-transparent text-lg font-bold text-white focus:outline-none min-w-0 flex-1 border-b border-transparent focus:border-indigo-500/50 transition"
            value={workflowName}
            onChange={e => setWorkflowName(e.target.value)}
            placeholder="Workflow Name"
          />
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {statusMsg && (
            <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${
              statusMsg.includes("fail") || statusMsg.includes("Failed")
                ? "bg-red-900/30 text-red-400"
                : statusMsg.includes("success") || statusMsg === "Saved!"
                ? "bg-green-900/30 text-green-400"
                : "bg-indigo-900/30 text-indigo-400"
            }`}>
              {statusMsg}
            </span>
          )}
          <button
            onClick={newWorkflow}
            className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-1.5 text-xs font-medium text-gray-300 hover:bg-gray-700 transition"
            title="New workflow"
          >
            + New
          </button>
          <button
            onClick={() => saveWorkflow()}
            disabled={saving}
            className="rounded-lg bg-indigo-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 transition disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
          <button
            onClick={executeWorkflow}
            disabled={executing || nodes.length === 0}
            className="rounded-lg bg-emerald-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 transition disabled:opacity-50 flex items-center gap-1.5"
          >
            {executing ? (
              <><Spinner /> Running…</>
            ) : (
              <><PlayIcon /> Run</>
            )}
          </button>
          {workflowId && (
            <button
              onClick={deleteCurrentWorkflow}
              className="rounded-lg border border-red-800 bg-red-950/50 px-3 py-1.5 text-xs font-medium text-red-400 hover:bg-red-900/50 transition"
            >
              Delete
            </button>
          )}
        </div>
      </div>

      {/* Main layout: sidebar + canvas + results */}
      <div className="flex flex-1 gap-3 min-h-0">
        {/* Left panel — scripts + saved workflows */}
        <div className="w-52 shrink-0 flex flex-col gap-3 overflow-y-auto">
          {/* Script palette */}
          <div className="rounded-xl border border-gray-800 bg-gray-900/70 overflow-hidden">
            <div className="px-3 py-2 border-b border-gray-800 bg-gray-900/50">
              <h4 className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">
                Scripts
              </h4>
            </div>
            <div className="p-2 space-y-1">
              {scripts.map(s => (
                <button
                  key={s.name}
                  onClick={() => addNode(s.name)}
                  className="w-full text-left rounded-lg border border-gray-700/50 bg-gray-800/50 px-3 py-2 text-xs text-gray-300 hover:bg-indigo-600/10 hover:text-white hover:border-indigo-600/30 transition group"
                >
                  <span className="flex items-center gap-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-gray-600 group-hover:bg-indigo-400 transition shrink-0" />
                    {s.name}
                  </span>
                  {s.args.length > 0 && (
                    <span className="text-[10px] text-gray-600 ml-3.5">{s.args.length} args</span>
                  )}
                </button>
              ))}
              {scripts.length === 0 && (
                <p className="text-[10px] text-gray-600 italic px-2 py-1">No scripts found</p>
              )}
            </div>
          </div>

          {/* Saved workflows */}
          <div className="rounded-xl border border-gray-800 bg-gray-900/70 overflow-hidden">
            <div className="px-3 py-2 border-b border-gray-800 bg-gray-900/50">
              <h4 className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">
                Saved Workflows
              </h4>
            </div>
            <div className="p-2 space-y-1">
              {savedWorkflows.map((wf: any) => (
                <button
                  key={wf.id}
                  onClick={() => loadWorkflow(wf)}
                  className={`w-full text-left rounded-lg border px-3 py-2 text-xs transition ${
                    workflowId === wf.id
                      ? "border-indigo-600/60 bg-indigo-600/10 text-indigo-300"
                      : "border-gray-700/50 bg-gray-800/50 text-gray-300 hover:bg-gray-700/50"
                  }`}
                >
                  {wf.name}
                </button>
              ))}
              {savedWorkflows.length === 0 && (
                <p className="text-[10px] text-gray-600 italic px-2 py-1">None yet</p>
              )}
            </div>
          </div>
        </div>

        {/* Canvas + results area */}
        <div className="flex-1 flex flex-col gap-3 min-h-0">
          {/* Canvas */}
          <div
            className="flex-1 rounded-xl border border-gray-800 bg-gray-950 overflow-hidden min-h-[300px]"
            onKeyDown={onKeyDown}
            tabIndex={0}
          >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onInit={setRfInstance}
            onNodeDoubleClick={onNodeDoubleClick}
            onEdgeClick={onEdgeClick}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            defaultEdgeOptions={{
              type: "conditionEdge",
              markerEnd: { type: MarkerType.ArrowClosed },
            }}
            fitView
            proOptions={{ hideAttribution: true }}
            className="workflow-canvas"
          >
            <Background color="#4c5466" gap={24} size={1} />
            <Controls
              className="!bg-gray-800 !border-gray-700 !shadow-lg [&>button]:!bg-gray-800 [&>button]:!border-gray-700 [&>button]:!text-gray-400 [&>button:hover]:!bg-gray-700"
            />
            <MiniMap
              nodeStrokeColor="#6366f1"
              nodeColor="#3730a3"
              maskColor="rgba(0,0,0,0.4)"
              className="!bg-gray-900 !border-gray-800"
            />
          </ReactFlow>
          </div>

          {/* Bottom panel — Live Console + Execution Results */}
          {(consoleOpen || Object.keys(executionLog).length > 0) && (
            <div className="rounded-xl border border-gray-800 bg-gray-900/70 overflow-hidden shrink-0 flex flex-col" style={{ maxHeight: "280px" }}>
              {/* Tab bar */}
              <div className="flex items-center border-b border-gray-800 bg-gray-900/50 px-2 shrink-0">
                <button
                  onClick={() => setConsoleOpen(true)}
                  className={`px-3 py-1.5 text-[10px] font-semibold uppercase tracking-widest transition border-b-2 -mb-px ${
                    consoleOpen
                      ? "text-indigo-400 border-indigo-500"
                      : "text-gray-500 border-transparent hover:text-gray-400"
                  }`}
                >
                  Console {executing && <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse ml-1" />}
                  {consoleLines.length > 0 && <span className="text-gray-600 ml-1">· {consoleLines.length}</span>}
                </button>
                <button
                  onClick={() => setConsoleOpen(false)}
                  className={`px-3 py-1.5 text-[10px] font-semibold uppercase tracking-widest transition border-b-2 -mb-px ${
                    !consoleOpen
                      ? "text-indigo-400 border-indigo-500"
                      : "text-gray-500 border-transparent hover:text-gray-400"
                  }`}
                >
                  Results
                  {(() => {
                    const p = Object.values(executionLog).filter((l: any) => l.status === "success").length;
                    const f = Object.values(executionLog).filter((l: any) => l.status === "failed").length;
                    if (p + f === 0) return null;
                    return (
                      <span className="ml-1">
                        {p > 0 && <span className="text-green-400">{p}✓</span>}
                        {f > 0 && <span className="text-red-400 ml-0.5">{f}✗</span>}
                      </span>
                    );
                  })()}
                </button>
                <div className="ml-auto flex items-center gap-2 pr-1">
                  {consoleOpen && consoleLines.length > 0 && (
                    <button
                      onClick={() => setConsoleLines([])}
                      className="text-[10px] text-gray-600 hover:text-gray-400 transition"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>

              {/* Console tab */}
              {consoleOpen ? (
                <pre
                  ref={consoleRef}
                  className="flex-1 overflow-y-auto bg-gray-950 p-3 font-mono text-xs leading-relaxed"
                >
                  {consoleLines.length === 0 ? (
                    <span className="text-gray-600 italic">
                      Output will stream here in real-time when you run the workflow.
                    </span>
                  ) : (
                    consoleLines.map((line, i) => (
                      <div
                        key={i}
                        className={
                          line.stream === "stderr"
                            ? "text-red-400"
                            : line.stream === "info"
                              ? "text-yellow-400/70"
                              : "text-green-400"
                        }
                      >
                        {line.text}
                      </div>
                    ))
                  )}
                  {executing && (
                    <span className="inline-block animate-pulse text-gray-500">▊</span>
                  )}
                </pre>
              ) : (
                /* Results tab */
                <div className="flex-1 overflow-y-auto">
                  {Object.keys(executionLog).length === 0 ? (
                    <p className="text-sm text-gray-600 italic text-center py-8">No results yet.</p>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 p-3">
                      {nodes.map(n => {
                        const log = executionLog[n.id];
                        if (!log) return null;
                        return (
                          <button
                            key={n.id}
                            onClick={() => setShowStepDetail(n.id)}
                            className={`text-left rounded-lg border p-2.5 transition hover:brightness-110 ${
                              log.status === "success" ? "border-green-800/50 bg-green-950/20" :
                              log.status === "failed"  ? "border-red-800/50 bg-red-950/20" :
                              "border-gray-800 bg-gray-800/30"
                            }`}
                          >
                            <div className="flex items-center gap-2 mb-0.5">
                              <span className={`h-2 w-2 rounded-full shrink-0 ${
                                log.status === "success" ? "bg-green-400" :
                                log.status === "failed"  ? "bg-red-400" :
                                "bg-gray-500"
                              }`} />
                              <span className="text-xs font-medium text-gray-200 truncate">{n.data.script}</span>
                              {log.execution_time != null && (
                                <span className="ml-auto text-[10px] font-mono text-gray-500">{log.execution_time.toFixed(1)}s</span>
                              )}
                            </div>
                            {log.output?.status === "partial_pass" && (
                              <div className="text-[10px] text-amber-400/70 mt-1">
                                ⚠ Partial: {log.output.found_count ?? log.output.alive_count ?? "?"}/{log.output.total_count} passed
                              </div>
                            )}
                            {log.output?.missing && log.output.missing !== "" && (
                              <div className="text-[10px] text-red-400/60 mt-0.5 truncate" title={log.output.missing}>
                                Missing: {log.output.missing}
                              </div>
                            )}
                            {log.output?.not_alive && log.output.not_alive !== "" && (
                              <div className="text-[10px] text-red-400/60 mt-0.5 truncate" title={log.output.not_alive}>
                                Not alive: {log.output.not_alive}
                              </div>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ---- Node Config Modal ---- */}
      {configNode && (
        <NodeConfigModal
          scripts={scripts}
          nodes={nodes}
          edges={edges}
          currentNodeId={configNode.id}
          configScript={configScript}
          configRetry={configRetry}
          configArgs={configArgs}
          onChangeScript={(name) => {
            setConfigScript(name);
            // Auto-populate args from script metadata, preserving user-edited values
            const info = scripts.find(s => s.name === name);
            if (info) {
              const newArgs: Record<string, string> = {};
              info.args.forEach(a => {
                newArgs[a.name] = configArgs[a.name] ?? a.default ?? "";
              });
              setConfigArgs(newArgs);
            } else {
              setConfigArgs({});
            }
          }}
          onChangeRetry={setConfigRetry}
          onChangeArgs={setConfigArgs}
          onSave={saveNodeConfig}
          onClose={() => setConfigNode(null)}
        />
      )}

      {/* ---- Edge Condition Modal ---- */}
      {configEdge && (
        <Modal title="Edge Condition" onClose={() => setConfigEdge(null)}>
          <div className="space-y-3">
            <p className="text-xs text-gray-400">
              When should the target node execute?
            </p>
            {(["success", "failure", "always"] as ConditionType[]).map(c => (
              <button
                key={c}
                onClick={() => setConfigCondition(c)}
                className={`w-full text-left rounded-lg border px-4 py-3 text-sm font-medium transition ${
                  configCondition === c
                    ? c === "success" ? "border-green-600 bg-green-950/40 text-green-300"
                    : c === "failure" ? "border-red-600 bg-red-950/40 text-red-300"
                    : "border-indigo-600 bg-indigo-950/40 text-indigo-300"
                    : "border-gray-700 bg-gray-800 text-gray-400 hover:bg-gray-700"
                }`}
              >
                <span className="uppercase text-xs tracking-wider">{c}</span>
                <span className="block text-xs text-gray-500 mt-0.5">
                  {c === "success" && "Run if previous node succeeded"}
                  {c === "failure" && "Run if previous node failed"}
                  {c === "always" && "Run regardless of result"}
                </span>
              </button>
            ))}
            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setConfigEdge(null)}
                className="rounded-lg bg-gray-800 px-4 py-2 text-xs text-gray-300 hover:bg-gray-700"
              >
                Cancel
              </button>
              <button
                onClick={saveEdgeCondition}
                className="rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-500"
              >
                Apply
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* ---- Step Detail Modal ---- */}
      {showStepDetail && executionLog[showStepDetail] && (
        <Modal
          title={`Step: ${nodes.find(n => n.id === showStepDetail)?.data.script ?? showStepDetail}`}
          onClose={() => setShowStepDetail(null)}
        >
          <StepDetail log={executionLog[showStepDetail]} />
        </Modal>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step Detail Panel
// ---------------------------------------------------------------------------

function StepDetail({ log }: { log: any }) {
  const output = log.output ?? {};
  const hasDeviceResults = output.status && (output.found !== undefined || output.alive !== undefined);

  return (
    <div className="space-y-4 max-h-[60vh] overflow-y-auto">
      <div className="flex items-center gap-3">
        <StatusBadge status={log.status} />
        {log.execution_time != null && (
          <span className="text-xs font-mono text-gray-500">{log.execution_time.toFixed(3)}s</span>
        )}
        {output.status && (
          <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
            output.status === "pass" ? "bg-green-900/40 text-green-400" :
            output.status === "partial_pass" ? "bg-amber-900/40 text-amber-400" :
            "bg-red-900/40 text-red-400"
          }`}>
            {output.status === "partial_pass" ? "Partial Pass" : output.status.toUpperCase()}
          </span>
        )}
      </div>

      {/* Device status cards (for broadcast/keepalive results) */}
      {hasDeviceResults && (
        <div className="space-y-2">
          {/* Found / Alive */}
          {(output.found || output.alive) && (output.found !== "" || output.alive !== "") && (
            <div className="rounded-lg border border-green-800/40 bg-green-950/20 p-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-green-500 mb-1.5">
                {output.found !== undefined ? "Broadcasting" : "Alive"}
                {" "}({output.found_count ?? output.alive_count ?? 0})
              </p>
              <div className="flex flex-wrap gap-1.5">
                {(output.found || output.alive || "").split(",").filter(Boolean).map((d: string) => (
                  <span key={d} className="inline-flex items-center gap-1 rounded-md bg-green-900/30 border border-green-800/40 px-2 py-0.5 text-xs text-green-300 font-mono">
                    <span className="h-1.5 w-1.5 rounded-full bg-green-400" />
                    {d}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Missing / Not alive */}
          {(output.missing || output.not_alive) && (output.missing !== "" || output.not_alive !== "") && (
            <div className="rounded-lg border border-red-800/40 bg-red-950/20 p-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-red-500 mb-1.5">
                {output.missing !== undefined ? "NOT Broadcasting" : "Not Alive"}
                {" "}({output.missing_count ?? output.not_alive_count ?? 0})
              </p>
              <div className="flex flex-wrap gap-1.5">
                {(output.missing || output.not_alive || "").split(",").filter(Boolean).map((d: string) => (
                  <span key={d} className="inline-flex items-center gap-1 rounded-md bg-red-900/30 border border-red-800/40 px-2 py-0.5 text-xs text-red-300 font-mono">
                    <span className="h-1.5 w-1.5 rounded-full bg-red-400" />
                    {d}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {log.stdout && (
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-green-500">stdout</p>
          <pre className="rounded-lg bg-gray-950 p-3 text-xs text-green-400 leading-relaxed overflow-x-auto max-h-48 overflow-y-auto font-mono">
            {log.stdout}
          </pre>
        </div>
      )}

      {log.stderr && (
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-red-500">stderr</p>
          <pre className="rounded-lg bg-gray-950 p-3 text-xs text-red-400 leading-relaxed overflow-x-auto max-h-48 overflow-y-auto font-mono">
            {log.stderr}
          </pre>
        </div>
      )}

      {output && Object.keys(output).length > 0 && (
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-indigo-400">Output JSON</p>
          <pre className="rounded-lg bg-gray-950 p-3 text-xs text-indigo-300 leading-relaxed overflow-x-auto font-mono">
            {JSON.stringify(output, null, 2)}
          </pre>
        </div>
      )}

      {log.status === "skipped" && !log.stdout && !log.stderr && (
        <p className="text-sm text-gray-600 italic text-center py-4">Step was skipped.</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Compute upstream nodes (those that can feed output into this node) */
function getUpstreamNodes(
  nodeId: string,
  nodes: Node<ScriptNodeData>[],
  edges: Edge[],
): Node<ScriptNodeData>[] {
  const incoming = edges.filter(e => e.target === nodeId).map(e => e.source);
  return nodes.filter(n => incoming.includes(n.id));
}

function NodeConfigModal({
  scripts,
  nodes,
  edges,
  currentNodeId,
  configScript,
  configRetry,
  configArgs,
  onChangeScript,
  onChangeRetry,
  onChangeArgs,
  onSave,
  onClose,
}: {
  scripts: ScriptInfo[];
  nodes: Node<ScriptNodeData>[];
  edges: Edge[];
  currentNodeId: string;
  configScript: string;
  configRetry: number;
  configArgs: Record<string, string>;
  onChangeScript: (name: string) => void;
  onChangeRetry: (n: number) => void;
  onChangeArgs: (args: Record<string, string> | ((prev: Record<string, string>) => Record<string, string>)) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  const upstream = getUpstreamNodes(currentNodeId, nodes, edges);
  const currentScriptInfo = scripts.find(s => s.name === configScript);
  const [focusedArg, setFocusedArg] = useState<string | null>(null);

  // Build a list of all available upstream references
  const upstreamRefs: { scriptName: string; nodeId: string; argName: string; value: string }[] = [];
  for (const n of upstream) {
    const info = scripts.find(s => s.name === n.data.script);
    // Add the node's configured args
    for (const [k, v] of Object.entries(n.data.args || {})) {
      upstreamRefs.push({ scriptName: n.data.script, nodeId: n.id, argName: k, value: v });
    }
    // Add script-declared args not already in node config
    if (info) {
      for (const a of info.args) {
        if (!(a.name in (n.data.args || {}))) {
          upstreamRefs.push({ scriptName: n.data.script, nodeId: n.id, argName: a.name, value: a.default ?? "" });
        }
      }
    }
  }

  const insertRef = (argKey: string, ref: string) => {
    onChangeArgs((prev: Record<string, string>) => ({ ...prev, [argKey]: ref }));
  };

  return (
    <Modal title={`Configure: ${configScript || "Node"}`} onClose={onClose}>
      <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
        {/* Script selector */}
        <div>
          <label className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1 block">
            Script
          </label>
          <select
            className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 focus:border-indigo-500 focus:outline-none"
            value={configScript}
            onChange={e => onChangeScript(e.target.value)}
          >
            <option value="">— Select —</option>
            {scripts.map(s => (
              <option key={s.name} value={s.name}>{s.name}</option>
            ))}
          </select>
        </div>

        {/* Retry */}
        <div>
          <label className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1 block">
            Retry Count
          </label>
          <input
            type="number"
            min={0}
            max={10}
            className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 focus:border-indigo-500 focus:outline-none"
            value={configRetry}
            onChange={e => onChangeRetry(parseInt(e.target.value) || 0)}
          />
        </div>

        {/* Arguments */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs font-semibold uppercase tracking-wider text-gray-500">
              Arguments
            </label>
            {upstream.length > 0 && (
              <span className="text-[10px] text-indigo-400/70">
                Click 🔗 to link upstream values
              </span>
            )}
          </div>
          {Object.entries(configArgs).map(([key, val]) => {
            const argMeta = currentScriptInfo?.args.find(a => a.name === key);
            const isLinked = val.startsWith("{{") && val.endsWith("}}");
            const relevantRefs = upstreamRefs.filter(r =>
              // show all upstream refs, but boost matching name
              true
            );
            const showPicker = focusedArg === key && relevantRefs.length > 0;

            return (
              <div key={key} className="mb-3 relative">
                <div className="flex items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-[10px] text-gray-500 mb-0.5 flex items-center gap-1.5">
                      <span className="font-mono">{key}</span>
                      {argMeta && (
                        <span className="text-gray-600">
                          ({argMeta.type}{argMeta.default ? `, default: ${argMeta.default}` : ""})
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      <input
                        className={`flex-1 rounded-lg border px-3 py-1.5 text-xs focus:outline-none transition ${
                          isLinked
                            ? "border-indigo-600/60 bg-indigo-950/30 text-indigo-300 font-mono"
                            : "border-gray-700 bg-gray-800 text-gray-100 focus:border-indigo-500"
                        }`}
                        value={val}
                        onChange={e => onChangeArgs((a: Record<string, string>) => ({ ...a, [key]: e.target.value }))}
                        onFocus={() => setFocusedArg(key)}
                        onBlur={() => setTimeout(() => setFocusedArg(null), 200)}
                        placeholder={`value or {{script_name.key}}`}
                      />
                      {relevantRefs.length > 0 && (
                        <button
                          onClick={() => setFocusedArg(focusedArg === key ? null : key)}
                          className={`shrink-0 rounded-md p-1.5 text-xs transition ${
                            showPicker
                              ? "bg-indigo-600/20 text-indigo-400"
                              : "text-gray-600 hover:text-indigo-400 hover:bg-gray-800"
                          }`}
                          title="Pick from upstream"
                        >
                          🔗
                        </button>
                      )}
                      <button
                        onClick={() => onChangeArgs((a: Record<string, string>) => {
                          const copy = { ...a };
                          delete copy[key];
                          return copy;
                        })}
                        className="shrink-0 text-red-400/60 hover:text-red-300 text-xs p-1"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                </div>

                {/* Upstream reference picker dropdown */}
                {showPicker && (
                  <div className="absolute z-20 left-0 right-8 mt-1 rounded-lg border border-gray-700 bg-gray-850 bg-gray-900 shadow-xl max-h-40 overflow-y-auto">
                    <div className="px-2 py-1.5 border-b border-gray-800">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                        Pick from upstream
                      </span>
                    </div>
                    {upstream.map(n => (
                      <div key={n.id}>
                        <div className="px-2 py-1 bg-gray-800/50">
                          <span className="text-[10px] font-semibold text-indigo-400">{n.data.script}</span>
                          <span className="text-[10px] text-gray-600 ml-1">({n.id})</span>
                        </div>
                        {upstreamRefs.filter(r => r.nodeId === n.id).map(ref => (
                          <button
                            key={`${ref.nodeId}-${ref.argName}`}
                            className="w-full text-left px-3 py-1.5 text-xs hover:bg-indigo-600/10 transition flex items-center gap-2"
                            onMouseDown={(e) => {
                              e.preventDefault();
                              insertRef(key, `{{${ref.scriptName}.${ref.argName}}}`);
                              setFocusedArg(null);
                            }}
                          >
                            <code className="text-amber-400/80 font-mono text-[10px]">
                              {`{{${ref.scriptName}.${ref.argName}}}`}
                            </code>
                            {ref.value && (
                              <span className="text-gray-600 text-[10px] truncate ml-auto">
                                = {ref.value}
                              </span>
                            )}
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          <button
            onClick={() => {
              const key = prompt("Argument name:");
              if (key) onChangeArgs((a: Record<string, string>) => ({ ...a, [key]: "" }));
            }}
            className="text-xs text-indigo-400 hover:text-indigo-300"
          >
            + Add argument
          </button>
        </div>

        {/* Upstream summary hint */}
        {upstream.length > 0 && (
          <div className="rounded-lg border border-gray-800 bg-gray-800/30 p-3">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 mb-1">
              Upstream nodes
            </p>
            <div className="flex flex-wrap gap-1.5">
              {upstream.map(n => (
                <span key={n.id} className="inline-flex items-center gap-1 rounded-md border border-gray-700 bg-gray-800/60 px-2 py-0.5 text-[10px]">
                  <span className="text-indigo-400 font-mono">{n.data.script}</span>
                  <span className="text-gray-600">· {Object.keys(n.data.args || {}).length} args</span>
                </span>
              ))}
            </div>
            <p className="text-[10px] text-gray-600 mt-1.5">
              Script outputs (e.g. <code className="text-amber-400/60">{`{{script.found}}`}</code>) are also available at runtime.
            </p>
          </div>
        )}

        {/* Buttons */}
        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onClose}
            className="rounded-lg bg-gray-800 px-4 py-2 text-xs text-gray-300 hover:bg-gray-700"
          >
            Cancel
          </button>
          <button
            onClick={onSave}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-500"
          >
            Apply
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-lg rounded-2xl border border-gray-700 bg-gray-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
          <h3 className="text-lg font-bold text-white">{title}</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300">
            <CloseIcon />
          </button>
        </div>
        <div className="px-6 py-4">{children}</div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === "success" ? "bg-green-900/50 text-green-400 border-green-800" :
    status === "failed"  ? "bg-red-900/50 text-red-400 border-red-800"     :
    status === "skipped" ? "bg-gray-800/50 text-gray-500 border-gray-700"  :
    "bg-blue-900/50 text-blue-400 border-blue-800";
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${cls}`}>
      {status}
    </span>
  );
}

function PlayIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 20 20">
      <path fillRule="evenodd" d="M6.3 2.841A1.5 1.5 0 004 4.12V15.88a1.5 1.5 0 002.3 1.279l9.344-5.88a1.5 1.5 0 000-2.557L6.3 2.84z" clipRule="evenodd" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg className="h-3.5 w-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}
