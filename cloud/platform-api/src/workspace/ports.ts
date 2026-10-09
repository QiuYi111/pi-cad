// Interfaces the workspace code depends on. Production wires the Kubernetes and gateway clients; tests inject fakes.
import type WebSocket from 'ws';
import type { EventHub } from './events.js';

export interface DeploymentStatus {
  replicas: number; // spec.replicas (0 or 1)
  readyReplicas: number; // status.readyReplicas (1 means the pod is Ready)
}

export interface K8sObject {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string; [key: string]: unknown };
  [key: string]: unknown;
}

// Only the operations the controller needs. The RBAC role (platform-api-rbac.yaml) allows
// get/list/watch/create/patch/delete, so no "update" and no scale subresource.
export interface WorkspaceK8s {
  getDeployment(name: string): Promise<DeploymentStatus | null>;
  // Creates the object. An existing Deployment is merge-patched with the new manifest. An existing PVC or Service is left alone.
  apply(obj: K8sObject): Promise<void>;
  scale(name: string, replicas: number): Promise<void>;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

// Gateway access for one workspace. Each call uses a fresh 60 s gateway token.
export interface WorkspaceGateway {
  healthz(k8sName: string): Promise<boolean>;
  shutdown(userId: string, k8sName: string): Promise<void>;
  exec(userId: string, k8sName: string, args: string[]): Promise<ExecResult>;
  connect(userId: string, k8sName: string): Promise<WebSocket>; // open socket to the gateway, for the bridge proxy
}

// File operations on the workspace volume, done through the gateway while the workspace runs.
export interface WorkspaceFs {
  mkdirProjects(userId: string, k8sName: string, projectIds: string[]): Promise<void>;
  trashProject(userId: string, k8sName: string, projectId: string, stamp: string): Promise<void>;
}

export interface WorkspaceDeps {
  k8s: WorkspaceK8s;
  gateway: WorkspaceGateway;
  fs: WorkspaceFs;
  events: EventHub;
  template: string; // contents of cloud/deploy/k3s/workspace-template.yaml
}
