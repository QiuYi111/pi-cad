// Renders cloud/deploy/k3s/workspace-template.yaml (plan 8.2) for one workspace.
// Only ${NAME} placeholders are replaced. An unknown placeholder is an error, so a missed value cannot ship.
import { loadAllYaml } from '@kubernetes/client-node';
import type { K8sObject } from './ports.js';

export const TEMPLATE_PLACEHOLDERS = [
  'WS_K8S_NAME',
  'WORKSPACE_ID',
  'WORKSPACE_IMAGE',
  'PROJECT_IDS',
  'REPLICAS',
  'SECCOMP_TYPE',
  'HOST_USERS',
  'HTTPS_PROXY_FOR_WORKSPACES',
  'PLATFORM_INTERNAL_URL',
  'ACTIVITY_URL',
  'ACTIVITY_TOKEN',
] as const;

export type TemplateVars = Record<(typeof TEMPLATE_PLACEHOLDERS)[number], string>;

export function renderWorkspaceManifests(template: string, vars: TemplateVars): K8sObject[] {
  const text = template.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(vars, key)) throw new Error(`workspace template: unknown placeholder ${key}`);
    return vars[key as keyof TemplateVars];
  });
  const docs = loadAllYaml(text).filter((doc) => doc && typeof doc === 'object') as K8sObject[];
  for (const doc of docs) {
    if (doc.kind !== 'Deployment') continue;
    // An empty placeholder (for example PROJECT_IDS with no projects) parses as null. Env values must be strings.
    const containers = (doc.spec as { template: { spec: { containers: Array<{ env?: Array<{ value?: unknown }> }> } } }).template.spec
      .containers;
    for (const c of containers) for (const e of c.env ?? []) if ('value' in e) e.value = String(e.value ?? '');
  }
  return docs;
}
