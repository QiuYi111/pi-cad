// The Kubernetes client against a fake API server. Checks the requests the RBAC role allows (no PUT, no scale subresource),
// and that a full-manifest update is sent as a merge patch.
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { KubeConfig } from '@kubernetes/client-node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config.js';
import { createKubeWorkspaceClient } from '../src/workspace/k8s.js';
import { renderWorkspaceManifests, TEMPLATE_PLACEHOLDERS } from '../src/workspace/template.js';
import { TEMPLATE } from './helpers/env.js';

type Seen = { method: string; path: string; contentType: string | undefined; body: string };

const VARS = {
  WS_K8S_NAME: 'ws-a',
  WORKSPACE_ID: '11111111-1111-4111-8111-111111111111',
  WORKSPACE_IMAGE: 'img:1',
  PROJECT_IDS: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  REPLICAS: '1',
  SECCOMP_TYPE: 'RuntimeDefault',
  SECCOMP_LOCALHOST_PROFILE: '',
  HOST_USERS: 'true',
  HTTPS_PROXY_FOR_WORKSPACES: 'http://10.0.0.5:7890',
  PLATFORM_INTERNAL_URL: 'http://platform-api.reify-system.svc.cluster.local:8081',
  ACTIVITY_URL: 'http://platform-api.reify-system.svc.cluster.local:8081/internal/workspaces/1/activity',
  ACTIVITY_TOKEN: 'tok',
};

let server: Server;
let base: string;
let seen: Seen[];

function route(req: IncomingMessage, body: string): { status: number; json: unknown } {
  const path = req.url ?? '';
  if (req.method === 'GET' && path.endsWith('/deployments/missing')) return { status: 404, json: status(404, 'NotFound') };
  if (req.method === 'GET' && path.endsWith('/deployments/ws-a')) return { status: 200, json: { metadata: { name: 'ws-a' }, spec: { replicas: 1 }, status: { readyReplicas: 1 } } };
  if (req.method === 'POST' && path.endsWith('/deployments')) return { status: 409, json: status(409, 'AlreadyExists') };
  if (req.method === 'POST' && path.endsWith('/persistentvolumeclaims')) return { status: 409, json: status(409, 'AlreadyExists') };
  if (req.method === 'PATCH') return { status: 200, json: JSON.parse(body) };
  return { status: 500, json: status(500, `unexpected ${req.method} ${path}`) };
}
const status = (code: number, reason: string) => ({ kind: 'Status', apiVersion: 'v1', status: 'Failure', code, reason, message: reason });

beforeEach(async () => {
  seen = [];
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', path: req.url ?? '', contentType: req.headers['content-type'], body });
      const r = route(req, body);
      res.writeHead(r.status, { 'content-type': 'application/json' }).end(JSON.stringify(r.json));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function client() {
  const kc = new KubeConfig();
  kc.loadFromOptions({
    clusters: [{ name: 'c', server: base, skipTLSVerify: true }],
    users: [{ name: 'u', token: 'test' }],
    contexts: [{ name: 'x', cluster: 'c', user: 'u' }],
    currentContext: 'x',
  });
  return createKubeWorkspaceClient('reify-ws', kc);
}

describe('workspace Kubernetes client', () => {
  it('reads a Deployment and reports a missing one as null', async () => {
    const k8s = client();
    expect(await k8s.getDeployment('ws-a')).toEqual({ replicas: 1, readyReplicas: 1 });
    expect(await k8s.getDeployment('missing')).toBeNull();
  });

  it('applies a rendered Deployment as create, then as a merge patch when it already exists', async () => {
    const [, deployment] = renderWorkspaceManifests(TEMPLATE, VARS);
    await client().apply(deployment as never);

    const [create, patch] = seen;
    expect(create).toMatchObject({ method: 'POST', path: '/apis/apps/v1/namespaces/reify-ws/deployments' });
    expect(patch).toMatchObject({ method: 'PATCH', path: '/apis/apps/v1/namespaces/reify-ws/deployments/ws-a', contentType: 'application/merge-patch+json' });
    const sent = JSON.parse(patch.body) as { spec: { replicas: number; template: { spec: { containers: Array<{ env: Array<{ name: string; value?: string }> }> } } } };
    expect(sent.spec.replicas).toBe(1);
    expect(sent.spec.template.spec.containers[0].env.find((e) => e.name === 'REIFY_ACTIVITY_TOKEN')?.value).toBe('tok');
  });

  it('scales with a merge patch on the Deployment (no update verb, no scale subresource)', async () => {
    await client().scale('ws-a', 0);
    expect(seen).toEqual([
      expect.objectContaining({
        method: 'PATCH',
        path: '/apis/apps/v1/namespaces/reify-ws/deployments/ws-a',
        contentType: 'application/merge-patch+json',
        body: JSON.stringify({ spec: { replicas: 0 } }),
      }),
    ]);
  });

  it('never issues PUT, so the rights in platform-api-rbac.yaml are enough', async () => {
    const k8s = client();
    await k8s.getDeployment('ws-a');
    await k8s.scale('ws-a', 1);
    await k8s.apply({ apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: 'ws-a-data', namespace: 'reify-ws' } });
    expect(seen.map((s) => s.method)).not.toContain('PUT');
    expect(seen.find((s) => s.path.endsWith('/persistentvolumeclaims'))?.method).toBe('POST');
  });
});

describe('workspace template', () => {
  it('uses only the placeholders the controller fills, and renders the three objects', () => {
    // Every placeholder in the file must be one the controller fills. The reverse does not hold: a value such as
    // SECCOMP_LOCALHOST_PROFILE is consumed in code (template.ts sets localhostProfile), so it is not in the file.
    const names = [...new Set([...TEMPLATE.matchAll(/\$\{([A-Z0-9_]+)\}/g)].map((m) => m[1]))].sort();
    const filled = new Set<string>(TEMPLATE_PLACEHOLDERS);
    expect(names.filter((n) => !filled.has(n))).toEqual([]);
  });

  it('the default template path points at the shipped file', () => {
    expect(existsSync(DEFAULT_CONFIG.workspaceTemplatePath)).toBe(true);
    expect(readFileSync(DEFAULT_CONFIG.workspaceTemplatePath, 'utf8')).toBe(TEMPLATE);
  });

  it('fails on a placeholder the controller does not know', () => {
    expect(() => renderWorkspaceManifests(TEMPLATE.replace('${REPLICAS}', '${NOT_A_THING}'), VARS)).toThrow('NOT_A_THING');
  });

  it('renders PVC, Deployment and Service, with a null-free env for an empty PROJECT_IDS', () => {
    const docs = renderWorkspaceManifests(TEMPLATE, { ...VARS, PROJECT_IDS: '' });
    expect(docs.map((d) => d.kind)).toEqual(['PersistentVolumeClaim', 'Deployment', 'Service']);
    const dep = docs[1] as unknown as { spec: { replicas: number; template: { spec: { hostUsers: boolean; containers: Array<{ env: Array<{ name: string; value: string }> }> } } } };
    expect(dep.spec.replicas).toBe(1);
    expect(dep.spec.template.spec.hostUsers).toBe(true);
    expect(dep.spec.template.spec.containers[0].env.find((e) => e.name === 'REIFY_PROJECT_IDS')?.value).toBe('');
  });
});
