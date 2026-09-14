# Motion, fits, and service

## Occurrence identity

Give authored parts meaningful labels. Use the assembly preset's occurrence refs for inspection because they are bound to one STEP hash. Duplicate labels are valid, but the bare duplicate name is ambiguous; use the numbered alias returned by the preset.

## Joint record

For every moving interface record:

- parent and child occurrence;
- joint type and axis or plane;
- intended free motion and limits;
- normal operating position;
- retention and preload;
- clearance or fit source;
- wear surfaces and lubrication assumption;
- assembly and removal direction.

Build123d joints can encode source intent. Still probe the exported assembly because exchange formats and flattening may lose relation metadata.

## Fit ownership

Assign each functional clearance or interference to one interface contract. Include coating, finishing, thermal growth, printer or machine behavior, and measurement method where relevant. Do not apply one generic clearance to every interface.

Use a standard fit or supplier recommendation when one governs. If no standard is specified, label any provisional value as an assumption requiring validation.

## Tolerance stack

Trace the shortest dimension chain between the two functional surfaces. Identify which dimensions share datums and which are independent. Evaluate worst case when loss of function is unacceptable; use a statistical stack only when its production assumptions are justified.

Avoid redundant precision location. A common pattern is one primary plane, one round pin, and one relieved or diamond pin; fasteners then clamp rather than fight the locators.

## Assembly sequence

For each part verify:

1. approach path is clear;
2. temporary alignment is possible;
3. tool and hand access exists;
4. fastener or retaining feature can be installed;
5. later parts do not block required operations;
6. service removal does not require destroying unrelated parts unless explicitly intended.

## Probe plan

Use `preset="assembly"` for occurrence identity and world frames. Use `preset="interference"` for pair facts, then interpret each contact against the interface contract. Use visual focus/hide/explode for crowded assemblies. Use `preset="measure"` with current `surf-*` refs for critical clearances and alignment.
