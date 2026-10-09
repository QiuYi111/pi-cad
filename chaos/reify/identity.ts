/**
 * Unified identity for the real Reify chaos slice.
 *
 * Every component the runner can drive or observe is named with one scheme so
 * a failure artifact can join them: `project / conversation / run / runtime /
 * kernel / provider`. The graph is built only from real state (run store,
 * conversation bindings, `/proc`, real runtime pids), so an edge is a claim
 * with evidence, never a guess.
 */

export type IdentityKind = "project" | "conversation" | "run" | "runtime" | "kernel" | "provider";

export type IdentityEdgeKind =
  | "conversation->run"
  | "run->project"
  | "run->runtime"
  | "runtime->project"
  | "kernel->runtime"
  | "kernel->authority"
  | "provider->project";

export interface IdentityNode {
  /** `<kind>:<key>`, e.g. `run:v7-...`, `runtime:1234`. */
  id: string;
  kind: IdentityKind;
  label: string;
  state: Record<string, unknown>;
}

export interface IdentityEdge {
  from: string;
  to: string;
  kind: IdentityEdgeKind;
  /** Why this edge is believed: the real source it was read from. */
  evidence: string;
}

export interface IdentityGraph {
  project: string;
  nodes: IdentityNode[];
  edges: IdentityEdge[];
}

export interface IdentityInput {
  project: { id: string; root: string; canonical: string };
  conversations: { id: string; runId: string | null; runStatus: string | null }[];
  runs: { id: string; phase: string; status: string }[];
  /** Real runtime processes the runner started or observed. */
  runtimes: { kind: "authority" | "prime"; pid: number; startedAt: number; runIds: string[] }[];
  kernels: { pid: number; ppid: number; ownerPid: number | null; orphan: boolean }[];
  providerRequests: { id: string; provider: string; model: string; label: string; ok: boolean }[];
}

/** Build the conversation → run → runtime/kernel ownership graph from real state. */
export function buildIdentityGraph(input: IdentityInput): IdentityGraph {
  const projectId = `project:${input.project.id}`;
  const nodes: IdentityNode[] = [
    {
      id: projectId,
      kind: "project",
      label: input.project.id,
      state: { root: input.project.root, canonical: input.project.canonical },
    },
  ];
  const edges: IdentityEdge[] = [];
  const runNodeId = (runId: string) => `run:${runId}`;
  const runtimeNodeId = (pid: number) => `runtime:${pid}`;

  for (const run of input.runs) {
    nodes.push({ id: runNodeId(run.id), kind: "run", label: run.id, state: { phase: run.phase, status: run.status } });
    edges.push({ from: runNodeId(run.id), to: projectId, kind: "run->project", evidence: "canonical v7 run store" });
  }
  for (const conversation of input.conversations) {
    nodes.push({
      id: `conversation:${conversation.id}`,
      kind: "conversation",
      label: conversation.id,
      state: { runId: conversation.runId, runStatus: conversation.runStatus },
    });
    if (conversation.runId) {
      edges.push({
        from: `conversation:${conversation.id}`,
        to: runNodeId(conversation.runId),
        kind: "conversation->run",
        evidence: "v7-project conversation binding",
      });
    }
  }
  for (const runtime of input.runtimes) {
    const pid = runtime.pid;
    nodes.push({
      id: runtimeNodeId(pid),
      kind: "runtime",
      label: `${runtime.kind}#${pid}`,
      state: { kind: runtime.kind, pid, startedAt: runtime.startedAt },
    });
    edges.push({
      from: runtimeNodeId(pid),
      to: projectId,
      kind: "runtime->project",
      evidence: `${runtime.kind} runtime process serves the project authority`,
    });
    for (const runId of runtime.runIds) {
      edges.push({
        from: runNodeId(runId),
        to: runtimeNodeId(pid),
        kind: "run->runtime",
        evidence: "run was created/advanced through this runtime pid",
      });
    }
  }
  const runtimePids = new Set(input.runtimes.map((runtime) => runtime.pid));
  for (const kernel of input.kernels) {
    nodes.push({
      id: `kernel:${kernel.pid}`,
      kind: "kernel",
      label: `cadctl.worker#${kernel.pid}`,
      state: { pid: kernel.pid, ppid: kernel.ppid, ownerPid: kernel.ownerPid, orphan: kernel.orphan },
    });
    if (runtimePids.has(kernel.ppid)) {
      edges.push({
        from: `kernel:${kernel.pid}`,
        to: runtimeNodeId(kernel.ppid),
        kind: "kernel->runtime",
        evidence: "/proc ppid points at the runtime pid",
      });
    } else {
      edges.push({
        from: `kernel:${kernel.pid}`,
        to: projectId,
        kind: "kernel->authority",
        evidence: "/proc ppid points at an authority process observed by the session",
      });
    }
  }
  for (const request of input.providerRequests) {
    nodes.push({
      id: `provider:${request.id}`,
      kind: "provider",
      label: request.label,
      state: { provider: request.provider, model: request.model, ok: request.ok },
    });
    edges.push({
      from: `provider:${request.id}`,
      to: projectId,
      kind: "provider->project",
      evidence: "provider boundary request made for this project",
    });
  }
  return { project: input.project.id, nodes, edges };
}

/** Flat, artifact-friendly view of the graph (no vendor objects, only ids). */
export function identitySummary(graph: IdentityGraph): {
  project: string;
  runtimes: { id: string; pid: number; kind: string }[];
  runs: { id: string; conversation: string | null; runtimePid: number | null }[];
  kernels: { pid: number; runtimePid: number | null; orphan: boolean }[];
} {
  const runtimeByPid = new Map<number, string>();
  for (const node of graph.nodes) {
    if (node.kind === "runtime") runtimeByPid.set(Number(node.state.pid), node.id);
  }
  const runToRuntime = new Map<string, number>();
  const runToConversation = new Map<string, string>();
  for (const edge of graph.edges) {
    if (edge.kind === "run->runtime") runToRuntime.set(edge.from.slice("run:".length), Number(edge.to.slice("runtime:".length)));
    if (edge.kind === "conversation->run") runToConversation.set(edge.to.slice("run:".length), edge.from.slice("conversation:".length));
  }
  const kernelToRuntime = new Map<number, number | null>();
  for (const edge of graph.edges) {
    if (edge.kind === "kernel->runtime") kernelToRuntime.set(Number(edge.from.slice("kernel:".length)), Number(edge.to.slice("runtime:".length)));
    else if (edge.kind === "kernel->authority") kernelToRuntime.set(Number(edge.from.slice("kernel:".length)), null);
  }
  return {
    project: graph.project,
    runtimes: graph.nodes
      .filter((node) => node.kind === "runtime")
      .map((node) => ({ id: node.id, pid: Number(node.state.pid), kind: String(node.state.kind) })),
    runs: graph.nodes
      .filter((node) => node.kind === "run")
      .map((node) => ({
        id: node.id,
        conversation: runToConversation.get(node.id.slice("run:".length)) ?? null,
        runtimePid: runToRuntime.get(node.id.slice("run:".length)) ?? null,
      })),
    kernels: graph.nodes
      .filter((node) => node.kind === "kernel")
      .map((node) => ({
        pid: Number(node.state.pid),
        runtimePid: kernelToRuntime.get(Number(node.state.pid)) ?? null,
        orphan: Boolean(node.state.orphan),
      })),
  };
}
