export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelChoice {
  provider: string;
  id: string;
  name: string;
  reasoning?: boolean;
}

export interface AppSettings {
  distro: string;
  projectPath: string;
  piCadRepo: string;
  primeAgentRepo: string;
  provider: string;
  model: string;
  thinking: ThinkingLevel;
  permission: "workspace" | "read-only";
  reviewer: { mode: "inherit" | "fixed"; provider?: string; model?: string; thinking?: ThinkingLevel };
}

export interface DependencyCheck {
  id: "wsl" | "node" | "python" | "uv" | "bwrap" | "prime" | "picad";
  label: string;
  status: "ready" | "missing" | "installing" | "failed";
  detail: string;
  installable: boolean;
}

export interface RuntimeStatus {
  state: "idle" | "checking" | "installing" | "starting" | "ready" | "streaming" | "error";
  checks: DependencyCheck[];
  message?: string;
  sessionId?: string;
}

export interface AuthStatus {
  provider: "openai-codex";
  state: "checking" | "signed-out" | "waiting" | "signed-in" | "error";
  message?: string;
  expiresAt?: number;
  input?: { kind: "text"; placeholder?: string } | { kind: "select"; options: Array<{ id: string; label: string }> };
}

export interface WorkflowCurrent {
  workflowId?: string;
  runId?: string;
  phase?: string;
  status?: string;
  updatedAt?: string;
  workflowHash?: string;
  workflowVersion?: string;
  phaseHistory: string[];
  phases: WorkflowPhase[];
  authoritative: false;
}

export interface WorkflowPhase {
  id: string;
  title: string;
  purpose: string;
  status: "complete" | "active" | "pending" | "blocked" | "skipped";
  transitions: Array<{ event: string; target: string }>;
  capabilities: string[];
  obligations: string[];
}

export interface WorkflowDocument {
  id: string;
  version: string;
  description: string;
  sourcePath?: string;
  phases: WorkflowPhase[];
  raw?: string;
}

export type ActivityKind = "workflow" | "commit" | "build" | "probe" | "simulation" | "review" | "image";
export type ActivityState = "queued" | "running" | "success" | "failed" | "denied";

export interface MediaAttachment {
  id: string;
  mimeType: string;
  role: string;
  dataUrl?: string;
  path?: string;
  label?: string;
}

export interface CadActivity {
  id: string;
  kind: ActivityKind;
  state: ActivityState;
  title: string;
  summary?: string;
  stage?: string;
  progress?: number;
  startedAt: number;
  finishedAt?: number;
  metrics?: Array<{ label: string; value: string }>;
  media?: MediaAttachment[];
  artifactPath?: string;
  details?: unknown;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  createdAt: number;
  activity?: CadActivity;
  stream?: {
    state: "waiting" | "thinking" | "responding" | "complete" | "aborted" | "error";
    startedAt: number;
    firstTokenAt?: number;
    finishedAt?: number;
  };
}

export interface TraceSummary {
  id: string;
  path: string;
  title: string;
  updatedAt: number;
  model?: string;
  turns: number;
  toolCalls: number;
  tokens?: number;
  outcome?: string;
}

export interface DistillationStatus {
  state: "idle" | "running" | "complete" | "failed";
  processed: number;
  total: number;
  outputPath?: string;
  message?: string;
}

export interface MeshPart {
  name: string;
  positions: number[];
  indices: number[];
  color: string;
}

export interface MeshDocument {
  source: string;
  parts: MeshPart[];
  bounds: { min: [number, number, number]; max: [number, number, number] };
}

export type ExtensionUiRequest =
  | { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[] }
  | { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string }
  | { type: "extension_ui_request"; id: string; method: "input" | "editor"; title: string; placeholder?: string; prefill?: string }
  | { type: "extension_ui_request"; id: string; method: "notify" | "setStatus" | "setTitle" | "setWidget" | "set_editor_text"; [key: string]: unknown };

export interface DesktopApi {
  settings: {
    get(): Promise<AppSettings>;
    update(patch: Partial<AppSettings>): Promise<AppSettings>;
    chooseProject(): Promise<string | null>;
    createProject(name: string): Promise<string | null>;
  };
  runtime: {
    check(): Promise<RuntimeStatus>;
    install(): Promise<RuntimeStatus>;
    start(): Promise<RuntimeStatus>;
    stop(): Promise<void>;
    prompt(message: string, images?: Array<{ data: string; mimeType: string }>): Promise<void>;
    abort(): Promise<void>;
    getModels(): Promise<ModelChoice[]>;
    setModel(provider: string, model: string): Promise<void>;
    setThinking(level: ThinkingLevel): Promise<void>;
    chooseImages(): Promise<Array<{ name: string; data: string; mimeType: string }>>;
    respondToUi(requestId: string, response: Record<string, unknown>): Promise<void>;
    onEvent(listener: (event: unknown) => void): () => void;
    onStatus(listener: (status: RuntimeStatus) => void): () => void;
    onUiRequest(listener: (request: ExtensionUiRequest) => void): () => void;
  };
  auth: {
    status(): Promise<AuthStatus>;
    login(): Promise<AuthStatus>;
    submitManualCode(value: string): Promise<void>;
    onStatus(listener: (status: AuthStatus) => void): () => void;
  };
  workflow: {
    list(): Promise<WorkflowDocument[]>;
    current(): Promise<WorkflowCurrent>;
    save(document: WorkflowDocument): Promise<WorkflowDocument>;
  };
  viewer: {
    loadStep(path: string): Promise<MeshDocument>;
    chooseStep(): Promise<string | null>;
  };
  traces: {
    list(): Promise<TraceSummary[]>;
    read(path: string): Promise<unknown[]>;
    distill(paths: string[], evaluation: { quality: number; difficulty: number }): Promise<DistillationStatus>;
    onDistillation(listener: (status: DistillationStatus) => void): () => void;
  };
  shell: { reveal(path: string): Promise<void> };
}

export const IPC = {
  settingsGet: "settings:get",
  settingsUpdate: "settings:update",
  settingsChooseProject: "settings:choose-project",
  settingsCreateProject: "settings:create-project",
  runtimeCheck: "runtime:check",
  runtimeInstall: "runtime:install",
  runtimeStart: "runtime:start",
  runtimeStop: "runtime:stop",
  runtimePrompt: "runtime:prompt",
  runtimeAbort: "runtime:abort",
  runtimeModels: "runtime:models",
  runtimeSetModel: "runtime:set-model",
  runtimeSetThinking: "runtime:set-thinking",
  runtimeChooseImages: "runtime:choose-images",
  runtimeUiResponse: "runtime:ui-response",
  runtimeEvent: "runtime:event",
  runtimeStatus: "runtime:status",
  runtimeUiRequest: "runtime:ui-request",
  authStatusGet: "auth:status-get",
  authLogin: "auth:login",
  authManualCode: "auth:manual-code",
  authStatus: "auth:status",
  workflowList: "workflow:list",
  workflowCurrent: "workflow:current",
  workflowSave: "workflow:save",
  viewerLoadStep: "viewer:load-step",
  viewerChooseStep: "viewer:choose-step",
  tracesList: "traces:list",
  tracesRead: "traces:read",
  tracesDistill: "traces:distill",
  tracesDistillStatus: "traces:distill-status",
  shellReveal: "shell:reveal",
} as const;
