// In-memory stand-ins for the cluster, the gateway and the workspace filesystem.
import type { DeploymentStatus, ExecResult, K8sObject, WorkspaceFs, WorkspaceGateway, WorkspaceK8s } from '../../src/workspace/ports.js';

export class FakeK8s implements WorkspaceK8s {
  readonly deployments = new Map<string, { replicas: number; readyReplicas: number; manifest: K8sObject }>();
  readonly objects = new Map<string, K8sObject>(); // PVC and Service, by kind/name
  readonly applied: string[] = [];
  readonly scales: Array<{ name: string; replicas: number }> = [];

  async getDeployment(name: string): Promise<DeploymentStatus | null> {
    const d = this.deployments.get(name);
    return d ? { replicas: d.replicas, readyReplicas: d.readyReplicas } : null;
  }

  async apply(obj: K8sObject): Promise<void> {
    this.applied.push(`${obj.kind}/${obj.metadata.name}`);
    if (obj.kind === 'Deployment') {
      const replicas = (obj.spec as { replicas: number }).replicas;
      const old = this.deployments.get(obj.metadata.name);
      // A pod that is not Ready yet. Tests call setReady() to change that.
      this.deployments.set(obj.metadata.name, { replicas, readyReplicas: old?.readyReplicas ?? 0, manifest: obj });
      return;
    }
    const key = `${obj.kind}/${obj.metadata.name}`;
    if (!this.objects.has(key)) this.objects.set(key, obj);
  }

  async scale(name: string, replicas: number): Promise<void> {
    this.scales.push({ name, replicas });
    const d = this.deployments.get(name);
    if (!d) throw new Error(`no deployment ${name}`);
    d.replicas = replicas;
    if (replicas === 0) d.readyReplicas = 0;
  }

  setReady(name: string, ready: boolean): void {
    const d = this.deployments.get(name);
    if (d) d.readyReplicas = ready ? 1 : 0;
  }

  env(name: string): Record<string, string> {
    const c = (this.deployments.get(name)!.manifest.spec as { template: { spec: { containers: Array<{ env: Array<{ name: string; value?: string }> }> } } })
      .template.spec.containers[0];
    return Object.fromEntries(c.env.filter((e) => e.value !== undefined).map((e) => [e.name, e.value!]));
  }
}

export class FakeGateway implements WorkspaceGateway {
  readonly healthy = new Set<string>();
  readonly shutdowns: string[] = [];
  readonly execs: Array<{ userId: string; name: string; args: string[] }> = [];
  execResult: ExecResult = { stdout: '', stderr: '', code: 0 };

  async healthz(name: string): Promise<boolean> {
    return this.healthy.has(name);
  }

  async shutdown(_userId: string, name: string): Promise<void> {
    this.shutdowns.push(name);
  }

  async exec(userId: string, name: string, args: string[]): Promise<ExecResult> {
    this.execs.push({ userId, name, args });
    return this.execResult;
  }

  async connect(): Promise<never> {
    throw new Error('FakeGateway.connect is not used; the bridge tests use the real gateway client');
  }
}

export class FakeFs implements WorkspaceFs {
  readonly mkdirs: Array<{ name: string; ids: string[] }> = [];
  readonly trashes: Array<{ name: string; id: string; stamp: string }> = [];
  fail = false;

  async mkdirProjects(_userId: string, name: string, ids: string[]): Promise<void> {
    if (this.fail) throw new Error('fake fs failure');
    this.mkdirs.push({ name, ids });
  }

  async trashProject(_userId: string, name: string, id: string, stamp: string): Promise<void> {
    if (this.fail) throw new Error('fake fs failure');
    this.trashes.push({ name, id, stamp });
  }
}
