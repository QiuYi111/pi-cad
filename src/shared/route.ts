/**
 * Pi-CAD route ontology (0.8).
 *
 * A route is the complete, hierarchical description of a CAD task:
 *
 *     objective × lineage × structure × maturity
 *
 * It replaces the 0.7 workflow enum. There is no "quick" route: a fast
 * process can only be *derived* by the compiler (greenfield/part compiles
 * to requirements → part_design → build → review), never selected by the
 * Agent as a shortcut past obligations.
 *
 * The harness treats routes as opaque keys plus one structural rule it
 * understands: obligation sets must be monotone under reroute. Everything
 * else (what "assembly" means physically) stays with the Agent.
 */

export type RouteObjective = "analyze" | "convert" | "design";
export type RouteLineage = "greenfield" | "legacy" | "hybrid";
export type RouteStructure = "part" | "assembly";

/**
 * Maturity is the reality floor demanded of the design. "concept" and
 * "review" are phases, not maturities: a prototype is still REAL,
 * BUILDABLE, and FUNCTIONAL — it is just not yet engineering-release
 * quality. Maturity overlays obligations; it never removes them.
 */
export type CadMaturity = "prototype" | "engineering" | "manufacturing" | "release";

export const MATURITIES: readonly CadMaturity[] = [
  "prototype",
  "engineering",
  "manufacturing",
  "release",
] as const;

const MATURITY_RANK: Record<CadMaturity, number> = {
  prototype: 0,
  engineering: 1,
  manufacturing: 2,
  release: 3,
};

export interface AnalyzeRoute {
  objective: "analyze";
}

export interface ConvertRoute {
  objective: "convert";
}

export interface DesignRoute {
  objective: "design";
  lineage: RouteLineage;
  structure: RouteStructure;
  maturity: CadMaturity;
}

export type Route = AnalyzeRoute | ConvertRoute | DesignRoute;

/**
 * Structural validation, fail closed: analyze/convert must carry nothing
 * but the objective; design must carry exactly the four-key tuple.
 */
export function isRoute(value: unknown): value is Route {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  const keys = Object.keys(r).sort().join(",");
  if (r.objective === "analyze" || r.objective === "convert") {
    return keys === "objective";
  }
  if (r.objective !== "design") return false;
  if (keys !== "lineage,maturity,objective,structure") return false;
  return (
    (["greenfield", "legacy", "hybrid"] as string[]).includes(String(r.lineage)) &&
    (["part", "assembly"] as string[]).includes(String(r.structure)) &&
    (MATURITIES as string[]).includes(String(r.maturity))
  );
}

/** Stable, human-readable identity used in summaries and error messages. */
export function routeKey(route: Route): string {
  if (route.objective !== "design") return route.objective;
  return `design/${route.lineage}/${route.structure}/${route.maturity}`;
}

export function routeLabel(route: Route | null | undefined): string {
  return route ? routeKey(route) : "unset";
}

/** Release workstreams (whitepaper 6.1): maturity=release overlays all nine. */
export const RELEASE_WORKSTREAMS = [
  "design_definition",
  "manufacturing_definition",
  "bom",
  "assembly_service",
  "inspection_acceptance",
  "engineering_analysis",
  "risk_quality",
  "configuration",
  "presentation",
] as const;

/**
 * Obligation keys are opaque strings. Monotonicity under reroute is plain
 * subset comparison on these sets — the harness never interprets them.
 *
 * Prefixes used by the engine itself:
 *   record:<type>   — a phase record that must exist on the run state
 *   evidence:<kind> — current-version evidence of that kind
 *   workstream:<n>  — a release workstream with non-open status
 *   presentation:*  — release presentation deliverables (enforced in M4)
 */
export type ObligationKey = string;

/**
 * Obligations of a route, composed from the structure fragment and the
 * maturity overlay. Cumulative by construction:
 *   prototype ⊆ engineering ⊆ manufacturing ⊆ release
 * and part ⊆ assembly for every maturity.
 */
export function obligationsOf(route: Route): Set<ObligationKey> {
  const keys = new Set<ObligationKey>();
  if (route.objective !== "design") return keys;

  if (route.structure === "assembly") {
    keys.add("evidence:assembly");
    keys.add("evidence:interference");
    keys.add("record:assembly_design");
    if (MATURITY_RANK[route.maturity] >= MATURITY_RANK.engineering) {
      keys.add("record:interface_contracts");
    }
  }
  if (MATURITY_RANK[route.maturity] >= MATURITY_RANK.manufacturing) {
    keys.add("evidence:drawing");
  }
  if (route.maturity === "release") {
    for (const name of RELEASE_WORKSTREAMS) keys.add(`workstream:${name}`);
    keys.add("presentation:exploded");
    keys.add("presentation:assembly_animation");
    keys.add("presentation:turntable");
  }
  return keys;
}

/** Record obligations (record:*) of a route. */
export function recordObligations(route: Route): string[] {
  return [...obligationsOf(route)].filter((key) => key.startsWith("record:"));
}
