---
name: assembly-design
description: >
  Use when a Pi-CAD route has structure=assembly — whenever the deliverable
  is more than one part. Guides the assembly_design and interface_design
  records and how to interpret assembly evidence. Policy only: this skill
  encodes process discipline, not mechanical engineering knowledge.
---

# Assembly design

An assembly is a set of parts plus the contracts between them. The parts
are easy; the contracts are where assemblies fail. Work datum-first:
choose the coordinate spine before any part geometry.

## Assembly design record (phase: assembly_design)

- Modules decompose by function, one responsibility each. If a module has
  no clear purpose statement, it is a box, not a module.
- Datums: primary (usually the largest stable face), secondary, tertiary.
  Name the physical features that realize each datum. Every later
  tolerance decision refers back to these names.
- Sequence: an install order where each part has a clear approach
  direction and something to locate against. If you cannot write it, the
  architecture is not buildable yet — iterate, do not commit.
- Envelopes with units. Interface design and part design need hard
  targets, not adjectives.

## Interface contracts (phase: interface_design)

- One contract per touching module pair. Interfaces that only seal or
  route still get contracts.
- State the DOF budget explicitly. Over-constraint (two pins + face +
  bolt pattern fighting each other) is the classic failure; say which
  degrees of freedom each interface constrains and which stay free.
- Bought-in interfaces (motor flange, bearing bore, rail width) are
  non-negotiable inputs. Look them up; never invent them.
- Fits and tolerances at locating features, assembly direction, and tool
  access must all be stated. An interface you cannot assemble with a tool
  in hand is not an interface.

## Interpreting assembly evidence

- The assembly tree is structure, not correctness. Compare it against the
  committed module list and sequence yourself.
- Interference facts are three-state (penetration / contact / clearance).
  The tool never says "bad": a press fit is penetration, a deliberate
  stop is contact. You decide which observations are defects.
- After any candidate change, all version-bound evidence is stale by
  construction — re-observe before re-accepting.

## Part design after contracts

Parts realize contracts; they do not decorate. If a feature serves no
contract, justify it or delete it. When a contract turns out to be wrong,
go back through the review loop and re-commit the record — never silently
author a violating part.
