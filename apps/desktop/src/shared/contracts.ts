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
  remotePublish: { enabled: boolean; allowedRemotes: string[] };
  onboardingComplete: boolean;
}

export interface DependencyCheck {
  id: "host" | "wsl" | "node" | "python" | "uv" | "sandbox" | "bwrap" | "prime" | "picad" | "paraview";
  label: string;
  status: "ready" | "missing" | "installing" | "failed";
  detail: string;
  installable: boolean;
}

export interface RuntimeStatus {
  state: "idle" | "checking" | "installing" | "action-required" | "starting" | "ready" | "streaming" | "error";
  checks: DependencyCheck[];
  message?: string;
  progress?: number;
  elapsedSeconds?: number;
  action?: "restart-windows" | "initialize-ubuntu" | "retry";
  sessionId?: string;
}
export interface InstallationInfo { version: string; platform: "windows" | "linux" | "macos"; arch: string; channel: "nsis" | "portable" | "deb" | "appimage" | "dmg" | "development"; packaged: boolean; userDataPath: string; projectPath: string; updateMode: "manual"; updateInstructions: string; signature: "runtime-verified" | "release-signature-required" }

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
  adopted?: boolean;
  editable?: boolean;
}
export interface WorkflowAdoptionPolicy { schema: 1; globalSafetyPolicyVersion: string; adopted: Record<string, { version: string; adoptedBy: string; adoptedAt: string }>; history: Array<{ id: string; from?: string; to: string; adoptedBy: string; adoptedAt: string }> }

export type ActivityKind = "workflow" | "commit" | "build" | "probe" | "simulation" | "review" | "image" | "tool";
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
  evaluation?: { quality: number; difficulty: number; feedback?: string | null };
}

export interface RatingStatus { rated: number; triggered: boolean; pendingTokens: number; thresholdTokens: number; message: string }

export interface DistillationStatus {
  state: "idle" | "running" | "candidate" | "complete" | "failed";
  processed: number;
  total: number;
  outputPath?: string;
  message?: string;
  candidateRoot?: string;
  changedFiles?: string[];
  sourceFailureSeqs?: number[];
  validationStatus?: "pending" | "not-needed" | "passed" | "failed";
  jobPath?: string;
}

export interface MeshPart {
  id?: string;
  partId?: string;
  solidId?: string;
  name: string;
  positions: number[];
  indices: number[];
  color: string;
}

export interface MeshDocument {
  source: string;
  sha256?: string;
  parts: MeshPart[];
  bounds: { min: [number, number, number]; max: [number, number, number] };
}
export interface QuickGeometryCheck {
  source: string;
  sha256: string;
  units: "mm";
  bbox: { x: number; y: number; z: number };
  solidCount: number;
}
export interface QuickSectionCheck {
  source: string;
  sha256: string;
  axis: "x" | "y" | "z";
  position: number;
  totalArea: number;
  faceCount: number;
  units: "mm";
}

export interface ViewerArtifact {
  id: string;
  path: string;
  sha256: string;
  role: string;
}

export interface ViewerCommit {
  id: string;
  name: string;
  parent: string | null;
  phase: string;
  createdAt: string;
  artifacts: ViewerArtifact[];
  sourceRevision?: string;
  workflowHash?: string;
  acceptanceSummary?: { requirements: Array<{ id: string; category: "geometry" | "engineering" | "machine"; status: "verified" | "unverified" | "not-applicable"; method: string; evidence?: { path: string; sha256: string } }>; assumptions: string[] };
}
export interface HumanApproval { id: string; projectId: string; commitId: string; workflowHash: string; sourceRevision: string; artifactSetHash: string; scope: string; rationale: string; decision: "approved"; approver: { type: "local-os-user"; id: string }; decidedAt: string; revokedAt?: string; revocationReason?: string; valid: boolean }
export interface ReleaseResult { releaseId: string; path: string; manifestPath: string; reused: boolean; files: Array<{ path: string; sha256: string; role: string }> }
export interface RemotePublishResult { releaseId: string; remote: string; remoteUrl: string; tag: string; sourceRevision: string; state: "published"; reused: boolean; packageUploaded: false }
export interface SourceRebuildResult {
  commitId: string;
  sourceRevision: string;
  source: string;
  output: string;
  expectedSha256: string;
  actualSha256: string;
  byteMatch: boolean;
  geometryMatch: boolean | null;
  geometryDetail: string;
  environment: { python: string; git: string; platform: string };
  parameters: Record<string, ModelParameterValue>;
}

export interface SimulationOutput {
  name: string;
  type: "image" | "scalar" | "timeseries" | "table" | "field" | "artifact";
  value?: number;
  unit?: string;
  path?: string;
  sha256?: string;
}

export interface ViewerSimulationRun {
  id: string;
  recipeId: string;
  status: string;
  observationId?: string | null;
  createdAt?: string | null;
  completedAt?: string | null;
  outputs: SimulationOutput[];
}

export interface ViewerCatalog {
  projectId: string;
  projectHead: { updatedAt: string; artifacts: ViewerArtifact[] };
  currentRun: null | { id: string; phase: string; status: string; updatedAt: string; artifacts: ViewerArtifact[] };
  commits: ViewerCommit[];
  simulationRuns: ViewerSimulationRun[];
  parameterManifests: StoredModelParameterManifest[];
}

export type ModelParameterValue = number | string | boolean;
export type ModelParameterType = "number" | "integer" | "boolean" | "enum";
export interface ModelParameterOption { value: string; label?: string }
export interface ModelParameterDefinition {
  id: string;
  type: ModelParameterType;
  default: ModelParameterValue;
  value: ModelParameterValue;
  min?: number;
  max?: number;
  step?: number;
  options?: ModelParameterOption[];
  unit?: string;
  label?: string;
  description?: string;
  group?: string;
}
export interface ModelParameterManifestV1 {
  schema: 1;
  modelId: string;
  source: { path: string; sha256: string; entrypoint: "build" };
  output: { path: string; sha256: string };
  parameters: ModelParameterDefinition[];
}
export interface StoredModelParameterManifest {
  path: string;
  sha256: string;
  manifest: ModelParameterManifestV1;
}

export type ViewerSource =
  | { kind: "cad"; id: string; label: string; path: string; role: string; sha256?: string; scope: "current" | "head" | "commit" | "manual"; commitId?: string }
  | { kind: "simulation"; id: string; label: string; path: string; outputType: SimulationOutput["type"]; runId: string; unit?: string; sha256?: string; createdAt?: string | null }
  | { kind: "blender"; id: string; label: string; path: string; role: string; sha256?: string; scope: "current" | "head" | "commit" };

export interface ParaViewSession {
  state: "unavailable" | "starting" | "ready" | "error";
  url?: string;
  sourcePath?: string;
  message?: string;
}
export interface SimulationMetadata {
  format: string;
  source: string;
  pointCount: number;
  cellCount: number;
  bounds: Record<"x" | "y" | "z", [number, number]>;
  fields: Array<{ name: string; association: "point" | "cell"; components: number; min: number | null; max: number | null; unit?: string | null }>;
  modelSource?: string | null;
}
export interface SimulationComponentStatus {
  state: "ready" | "missing" | "installing" | "failed";
  component: "torch-fem-0.9";
  detail: string;
  estimatedSize: string;
}
export interface BlenderScene { source: string; sha256?: string; scene: string; cameras: string[]; activeCamera: string | null; objectCount: number; frame: number; frameStart: number; frameEnd: number }
export interface BlenderRender { path: string; camera: string; dataUrl: string }

export type ExtensionUiRequest =
  | { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[] }
  | { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string }
  | { type: "extension_ui_request"; id: string; method: "input" | "editor"; title: string; placeholder?: string; prefill?: string }
  | { type: "extension_ui_request"; id: string; method: "notify" | "setStatus" | "setTitle" | "setWidget" | "set_editor_text"; [key: string]: unknown };

export interface DesktopApi {
  system: { installationInfo(): Promise<InstallationInfo> };
  settings: {
    get(): Promise<AppSettings>;
    update(patch: Partial<AppSettings>): Promise<AppSettings>;
    chooseProject(): Promise<string | null>;
    createProject(name: string): Promise<string | null>;
  };
  runtime: {
    check(): Promise<RuntimeStatus>;
    installWsl(): Promise<RuntimeStatus>;
    install(): Promise<RuntimeStatus>;
    checkSimulationComponent(): Promise<SimulationComponentStatus>;
    installSimulationComponent(): Promise<SimulationComponentStatus>;
    start(): Promise<RuntimeStatus>;
    restore(): Promise<{ status: RuntimeStatus; messages: unknown[] }>;
    stop(): Promise<void>;
    prompt(message: string, images?: Array<{ data: string; mimeType: string }>): Promise<void>;
    steer(message: string, images?: Array<{ data: string; mimeType: string }>): Promise<void>;
    newSession(): Promise<unknown[]>;
    switchSession(path: string): Promise<unknown[]>;
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
    cancel(): Promise<AuthStatus>;
    signOut(): Promise<AuthStatus>;
    onStatus(listener: (status: AuthStatus) => void): () => void;
  };
  workflow: {
    list(): Promise<WorkflowDocument[]>;
    current(): Promise<WorkflowCurrent>;
    save(document: WorkflowDocument): Promise<WorkflowDocument>;
    delete(document: WorkflowDocument): Promise<void>;
    adoptionPolicy(): Promise<WorkflowAdoptionPolicy>;
    adopt(id: string, version: string): Promise<WorkflowAdoptionPolicy>;
  };
  viewer: {
    loadStep(path: string): Promise<MeshDocument>;
    chooseStep(): Promise<string | null>;
    exportStep(path: string): Promise<string | null>;
    catalog(): Promise<ViewerCatalog>;
    previewParameters(manifestPath: string, values: Record<string, ModelParameterValue>): Promise<MeshDocument>;
    applyParameters(manifestPath: string, values: Record<string, ModelParameterValue>): Promise<void>;
    inspectGeometry(path: string): Promise<QuickGeometryCheck>;
    inspectSection(path: string, axis: "x" | "y" | "z"): Promise<QuickSectionCheck>;
    openParaView(path: string): Promise<ParaViewSession>;
    inspectSimulation(path: string): Promise<SimulationMetadata>;
    stopParaView(): Promise<void>;
    openParaViewDesktop(path: string): Promise<void>;
    inspectBlender(path: string): Promise<BlenderScene>;
    installBlender(): Promise<void>;
    renderBlender(path: string, camera?: string): Promise<BlenderRender>;
    openBlenderDesktop(path: string): Promise<void>;
    stopBlender(): Promise<void>;
    rebuildCommit(commitId: string, manifestPath: string): Promise<SourceRebuildResult>;
    readEvidence(path: string): Promise<unknown>;
  };
  traces: {
    list(): Promise<TraceSummary[]>;
    read(path: string): Promise<unknown[]>;
    rate(paths: string[], evaluation: { quality: number; difficulty: number; feedback?: string }): Promise<RatingStatus>;
    distill(paths: string[], evaluation: { quality: number; difficulty: number }): Promise<DistillationStatus>;
    onDistillation(listener: (status: DistillationStatus) => void): () => void;
    validateCandidate(jobPath: string): Promise<unknown>;
    adoptCandidate(jobPath: string): Promise<unknown>;
  };
  approvals: { list(): Promise<HumanApproval[]>; approve(commitId: string, scope: string, rationale: string): Promise<HumanApproval>; revoke(id: string, reason: string): Promise<HumanApproval>; release(commitId: string, approvalId: string): Promise<ReleaseResult | null>; publishRemote(release: ReleaseResult, remote: string, tag: string): Promise<RemotePublishResult> };
  shell: { reveal(path: string): Promise<void> };
}

export const IPC = {
  systemInstallationInfo: "system:installation-info",
  settingsGet: "settings:get",
  settingsUpdate: "settings:update",
  settingsChooseProject: "settings:choose-project",
  settingsCreateProject: "settings:create-project",
  runtimeCheck: "runtime:check",
  runtimeInstallWsl: "runtime:install-wsl",
  runtimeInstall: "runtime:install",
  runtimeCheckSimulation: "runtime:check-simulation",
  runtimeInstallSimulation: "runtime:install-simulation",
  runtimeStart: "runtime:start",
  runtimeRestore: "runtime:restore",
  runtimeStop: "runtime:stop",
  runtimePrompt: "runtime:prompt",
  runtimeSteer: "runtime:steer",
  runtimeNewSession: "runtime:new-session",
  runtimeSwitchSession: "runtime:switch-session",
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
  authCancel: "auth:cancel",
  authSignOut: "auth:sign-out",
  authStatus: "auth:status",
  workflowList: "workflow:list",
  workflowCurrent: "workflow:current",
  workflowSave: "workflow:save",
  workflowDelete: "workflow:delete",
  workflowAdoptionPolicy: "workflow:adoption-policy",
  workflowAdopt: "workflow:adopt",
  viewerLoadStep: "viewer:load-step",
  viewerChooseStep: "viewer:choose-step",
  viewerExportStep: "viewer:export-step",
  viewerCatalog: "viewer:catalog",
  viewerPreviewParameters: "viewer:preview-parameters",
  viewerApplyParameters: "viewer:apply-parameters",
  viewerInspectGeometry: "viewer:inspect-geometry",
  viewerInspectSection: "viewer:inspect-section",
  viewerOpenParaView: "viewer:open-paraview",
  viewerInspectSimulation: "viewer:inspect-simulation",
  viewerStopParaView: "viewer:stop-paraview",
  viewerOpenParaViewDesktop: "viewer:open-paraview-desktop",
  viewerInspectBlender: "viewer:inspect-blender",
  viewerInstallBlender: "viewer:install-blender",
  viewerRenderBlender: "viewer:render-blender",
  viewerOpenBlenderDesktop: "viewer:open-blender-desktop",
  viewerStopBlender: "viewer:stop-blender",
  viewerRebuildCommit: "viewer:rebuild-commit",
  viewerReadEvidence: "viewer:read-evidence",
  tracesList: "traces:list",
  tracesRead: "traces:read",
  tracesRate: "traces:rate",
  tracesDistill: "traces:distill",
  tracesDistillStatus: "traces:distill-status",
  tracesValidateCandidate: "traces:validate-candidate",
  tracesAdoptCandidate: "traces:adopt-candidate",
  approvalsList: "approvals:list",
  approvalsApprove: "approvals:approve",
  approvalsRevoke: "approvals:revoke",
  approvalsRelease: "approvals:release",
  approvalsPublishRemote: "approvals:publish-remote",
  shellReveal: "shell:reveal",
} as const;
