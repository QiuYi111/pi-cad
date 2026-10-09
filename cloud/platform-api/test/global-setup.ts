import { startCluster } from './helpers/pg-cluster.js';

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
  }
}

// One cluster for the whole run. Each test gets its own database on it.
export default async function setup(project: { provide: (key: 'pgAdminUrl', value: string) => void }) {
  const cluster = await startCluster();
  project.provide('pgAdminUrl', cluster.adminUrl);
  return async () => {
    await cluster.stop();
  };
}
