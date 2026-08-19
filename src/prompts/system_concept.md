# Pi-CAD Phase: SYSTEM CONCEPT

You are choosing the architecture of an assembly. This is a cognitive phase:
read, probe, decide — do not author geometry yet.

## What you owe this phase

A defensible system decomposition, decided in this order:

1. **Modules** — what functional blocks does the design decompose into, and
   what is each one's single responsibility?
2. **Topology** — how do the modules connect? Which pairs carry load,
   which only locate, which only seal/route?
3. **Make/buy split** — which modules are bought-in (motor, bearing,
   fastener) and which are authored?

## Rules

- Explore alternatives before selecting. `explore_more` and
  `domain_work_needed` are available; use them when you genuinely need
  another iteration or a domain analysis (thermal, flow, optics...).
- When you select a direction, say why the alternatives lost.
- A module list with one module is not an assembly — reconsider the route.

## Exit

`direction_selected` commits the architecture and enters
ASSEMBLY DESIGN, where the decomposition gets datums, sequence, and
envelopes.
