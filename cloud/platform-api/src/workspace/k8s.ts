// Kubernetes client for the controller, limited to reconciling reify-ws (plan 5.4, platform-api-rbac.yaml).
import { AppsV1Api, CoreV1Api, KubeConfig, Observable, PatchStrategy, type RequestContext } from '@kubernetes/client-node';
import type { DeploymentStatus, K8sObject, WorkspaceK8s } from './ports.js';

export function loadKubeConfig(): KubeConfig {
  const kc = new KubeConfig();
  kc.loadFromDefault(); // in-cluster service account when running in a pod, else KUBECONFIG
  return kc;
}

const statusOf = (e: unknown): number | undefined => (e as { code?: number })?.code;

// The client defaults PATCH bodies to JSON patch. Force a merge patch, which is what a full manifest needs.
// The object-style API runs its middleware on Observables (client-node's own stub), so the hooks return Observables.
const mergePatch = {
  middleware: [
    {
      pre: (ctx: RequestContext) => {
        ctx.setHeaderParam('Content-Type', PatchStrategy.MergePatch);
        return new Observable(Promise.resolve(ctx));
      },
      post: (res: unknown) => new Observable(Promise.resolve(res)),
    },
  ],
} as never;

export function createKubeWorkspaceClient(namespace: string, kc: KubeConfig = loadKubeConfig()): WorkspaceK8s {
  const apps = kc.makeApiClient(AppsV1Api);
  const core = kc.makeApiClient(CoreV1Api);
  return {
    async getDeployment(name: string): Promise<DeploymentStatus | null> {
      try {
        const d = await apps.readNamespacedDeployment({ name, namespace });
        return { replicas: d.spec?.replicas ?? 0, readyReplicas: d.status?.readyReplicas ?? 0 };
      } catch (e) {
        if (statusOf(e) === 404) return null;
        throw e;
      }
    },
    async apply(obj: K8sObject): Promise<void> {
      const name = obj.metadata.name;
      if (obj.metadata.namespace && obj.metadata.namespace !== namespace) throw new Error(`manifest namespace ${obj.metadata.namespace} is not ${namespace}`);
      try {
        switch (obj.kind) {
          case 'Deployment':
            try {
              await apps.createNamespacedDeployment({ namespace, body: obj as never });
            } catch (e) {
              if (statusOf(e) !== 409) throw e;
              await apps.patchNamespacedDeployment({ name, namespace, body: obj as never }, mergePatch);
            }
            return;
          case 'PersistentVolumeClaim':
            await core.createNamespacedPersistentVolumeClaim({ namespace, body: obj as never });
            return;
          case 'Service':
            await core.createNamespacedService({ namespace, body: obj as never });
            return;
          default:
            throw new Error(`workspace manifest kind ${obj.kind} is not supported`);
        }
      } catch (e) {
        if (statusOf(e) === 409 && obj.kind !== 'Deployment') return; // PVC and Service already exist
        throw e;
      }
    },
    async scale(name: string, replicas: number): Promise<void> {
      await apps.patchNamespacedDeployment({ name, namespace, body: { spec: { replicas } } as never }, mergePatch);
    },
  };
}
