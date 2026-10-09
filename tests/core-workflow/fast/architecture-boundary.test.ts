import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const src = join(root, "src");

// A module is the first directory under src/. ALLOWED is the module-level
// import table the layering permits. It was derived from the import graph as
// it stood when this test was written, so a new cross-module import fails
// until it is reviewed and added here. A new top-level src directory also
// fails until it has a row.
const ALLOWED: Record<string, readonly string[]> = {
  "agent-api": ["authority", "domains", "harness", "modules", "shared"],
  authority: ["experience", "harness", "integrations", "shared"],
  chaos: ["authority", "harness", "shared"],
  composition: ["agent-api", "authority", "domains"],
  core: ["domains", "harness", "shared", "workflows"],
  domains: ["harness", "modules", "shared", "workflows"],
  experience: ["shared"],
  extensions: ["core", "domains", "harness", "modules", "shared"],
  harness: ["shared"],
  integrations: [],
  modules: ["authority", "harness", "observations", "shared"],
  observations: ["shared"],
  shared: [],
  workflows: ["shared"],
};

// Layering rules from the source-refactor assessment (section 3). An edge that
// breaks one of these must be a named EXCEPTIONS entry; it is never silently
// allowed by ALLOWED.
const RULES: ReadonlyArray<{ from: string; onlyImports?: readonly string[]; mustNotImport?: readonly string[]; why: string }> = [
  { from: "shared", onlyImports: [], why: "shared is the bottom layer and imports no other src module" },
  { from: "harness", onlyImports: ["shared"], why: "the generic kernel must not reach into integrations, authority or domains" },
  { from: "authority", mustNotImport: ["domains", "agent-api", "extensions", "modules", "core"], why: "authority is domain-neutral" },
  { from: "agent-api", mustNotImport: ["extensions", "core"], why: "agent-api does not reach the v6 extension or core runtime" },
];

// Only the entry points may import these. No src file may import them, and
// this has no exception list: composition is wired from scripts and tests.
const ENTRY_ONLY_MODULES: readonly string[] = ["composition"];

// Named, file-level exceptions to RULES. These are edges that break a rule
// today. They are recorded here, not fixed, so this test passes now and any
// new violation fails. A stale entry (edge no longer present) also fails.
const EXCEPTIONS: ReadonlyArray<{ from: string; to: string; why: string }> = [
  {
    // Harness run scope resolves the Prime workflow binding, so the generic
    // kernel depends on the integrations layer.
    from: "src/harness/run-scope.ts",
    to: "src/integrations/prime/workflow-binding.ts",
    why: "harness -> integrations (breaks the harness-imports-only-shared rule)",
  },
];

// Module-level cycles that exist today. Each entry is one strongly connected
// component of the module graph. Any other cycle fails, and so does a listed
// cycle that has gone away.
const CYCLE_EXCEPTIONS: ReadonlyArray<{ modules: readonly string[]; why: string }> = [
];

const IMPORT_SPECIFIER = /\b(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g;

interface SourceGraph {
  files: string[];
  deps: Map<string, string[]>;
  problems: string[];
}

let cached: Promise<SourceGraph> | undefined;

function posix(path: string): string {
  return relative(root, path).split(sep).join("/");
}

function moduleOf(file: string): string {
  return file.split("/")[1];
}

async function tsFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await tsFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

// Scans every relative import in src/**/*.ts: static, `import type`,
// `export ... from`, side-effect `import "..."` and dynamic `import()`.
function loadGraph(): Promise<SourceGraph> {
  cached ??= (async () => {
    const absolute = await tsFiles(src);
    const files = absolute.map(posix).sort();
    const deps = new Map<string, string[]>();
    const problems: string[] = [];
    for (const file of absolute) {
      const from = posix(file);
      const text = await readFile(file, "utf-8");
      const targets = new Set<string>();
      for (const match of text.matchAll(IMPORT_SPECIFIER)) {
        const spec = match[1];
        const base = resolve(dirname(file), spec.replace(/\.js$/, ""));
        let target: string | undefined;
        for (const candidate of [`${base}.ts`, base, join(base, "index.ts")]) {
          if (candidate.endsWith(".ts") && await isFile(candidate)) {
            target = posix(candidate);
            break;
          }
        }
        if (!target) problems.push(`${from} imports "${spec}", which does not resolve to a src .ts file`);
        else if (target.startsWith("src/")) targets.add(target);
      }
      deps.set(from, [...targets].sort());
    }
    return { files, deps, problems };
  })();
  return cached;
}

// Tarjan's strongly connected components over a directed graph.
function components(graph: Map<string, string[]>): string[][] {
  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const result: string[][] = [];
  const visit = (node: string) => {
    index.set(node, counter);
    low.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of graph.get(node) ?? []) {
      if (!index.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node)!, low.get(next)!));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node)!, index.get(next)!));
      }
    }
    if (low.get(node) === index.get(node)) {
      const component: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
      } while (member !== node);
      result.push(component.sort());
    }
  };
  for (const node of graph.keys()) if (!index.has(node)) visit(node);
  return result;
}

test("src imports follow the module layering table and rules", async () => {
  const graph = await loadGraph();
  const problems = [...graph.problems];
  const seen = new Set(graph.files.map(moduleOf));
  for (const module of seen) {
    if (!(module in ALLOWED)) problems.push(`src/${module} is not in ALLOWED; add its row with the imports it may use`);
  }
  for (const [from, targets] of graph.deps) {
    const fromModule = moduleOf(from);
    for (const to of targets) {
      const toModule = moduleOf(to);
      if (fromModule === toModule) continue;
      const edge = `${fromModule} -> ${toModule}`;
      const excepted = EXCEPTIONS.some((entry) => entry.from === from && entry.to === to);
      if (ENTRY_ONLY_MODULES.includes(toModule)) {
        problems.push(`${from} imports ${to}: src/${toModule} may only be imported by entry scripts`);
        continue;
      }
      const rule = RULES.find((entry) => entry.from === fromModule && (
        (entry.onlyImports !== undefined && !entry.onlyImports.includes(toModule))
        || entry.mustNotImport?.includes(toModule)
      ));
      if (rule && !excepted) {
        problems.push(`${from} imports ${to}: ${edge} breaks the layering rule "${rule.why}"; remove the import or add a named EXCEPTIONS entry`);
        continue;
      }
      if (!rule && !excepted && !(ALLOWED[fromModule] ?? []).includes(toModule)) {
        problems.push(`${from} imports ${to}: module edge ${edge} is not in ALLOWED`);
      }
    }
  }
  for (const entry of EXCEPTIONS) {
    if (!(graph.deps.get(entry.from) ?? []).includes(entry.to)) {
      problems.push(`stale EXCEPTIONS entry: ${entry.from} no longer imports ${entry.to}; remove it`);
    }
  }
  assert.deepEqual(problems, []);
});

test("the only module-level cycles are the listed exceptions", async () => {
  const graph = await loadGraph();
  const moduleGraph = new Map<string, string[]>();
  for (const [from, targets] of graph.deps) {
    const fromModule = moduleOf(from);
    const edges = moduleGraph.get(fromModule) ?? [];
    for (const to of targets) {
      const toModule = moduleOf(to);
      if (toModule !== fromModule && !edges.includes(toModule)) edges.push(toModule);
    }
    moduleGraph.set(fromModule, edges);
  }
  const actual = components(moduleGraph).filter((component) => component.length > 1).map((component) => component.join(" <-> ")).sort();
  const expected = CYCLE_EXCEPTIONS.map((entry) => [...entry.modules].sort().join(" <-> ")).sort();
  assert.deepEqual(actual, expected, "module-level cycles differ from CYCLE_EXCEPTIONS: a new cycle must be removed or listed with a reason");
});

test("no file-level import cycle", async () => {
  const graph = await loadGraph();
  const cycles = components(new Map(graph.deps)).filter((component) => component.length > 1);
  assert.deepEqual(cycles, [], "file-level import cycle found");
});
