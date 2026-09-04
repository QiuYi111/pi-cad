# Mechanism sanity

## Begin with states

List the meaningful states before drawing links: manufactured, assembled, stored, deployed, loaded, adjusted, released, and serviced as applicable. For each state, state what moves, what stays fixed, and what prevents unintended motion.

## Degree-of-freedom accounting

Every moving body starts with six rigid-body degrees of freedom. Name the joint or contact that removes each unwanted freedom. Do not treat proximity in a CAD image as a constraint.

A deployed support needs a physical load path and a restoring or resisting action. A hinge supplies rotation, not a stable angle by itself. Look for a stop, detent, ratchet, friction joint, over-center linkage, brace, latch, spring, or gravity-stable geometry.

## Motion envelope

Check the swept volume, not only the endpoints. Include fingers, cables, fasteners, tool access, and the carried object. Examine both intended motion and credible over-travel.

## Stops and retention

Separate these functions:

- locating the normal operating position;
- carrying load at the stop;
- retaining a pin or part axially;
- preventing accidental release;
- surviving misuse or impact.

A thin cosmetic wall should not silently become the hard stop. Show contact area and load path. Avoid line or point contact when wear or high stress matters.

## Stability

Project the combined center of mass onto the support region in each loaded state. Check tip direction, sliding, base compliance, and the effect of user interaction. A visually upright model can still have no stable equilibrium.

## Verification prompts

- Can the mechanism assemble without impossible interpenetration?
- Can it reach every claimed state without collision?
- What reacts the main force and moment?
- What sets and holds the operating angle?
- What limits reverse motion or over-travel?
- What wears, loosens, or creeps over repeated cycles?
- Which dimension or interface would fail first at tolerance extremes?
