import { compileWorkflow, releaseCompletionGuard } from "./compiler.ts";
import type { CompiledProcess } from "./compiler.ts";
import { routeKey, type Route } from "../shared/route.ts";

export { compileWorkflow, releaseCompletionGuard };
export type { CompiledProcess };

/**
 * Compiled process cache keyed by routeKey. Processes are pure functions of
 * the route, so memoizing is safe and keeps hot paths (every guard call)
 * allocation-free.
 */
const cache = new Map<string, CompiledProcess>();

export function compiledSpec(route: Route): CompiledProcess {
  const cacheKey = routeKey(route);
  let compiled = cache.get(cacheKey);
  if (!compiled) {
    compiled = compileWorkflow(route);
    cache.set(cacheKey, compiled);
  }
  return compiled;
}

export type { WorkflowSpec } from "./types.ts";
