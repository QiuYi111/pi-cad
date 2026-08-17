# Pi-CAD intake

Current state: INTAKE.

Understand the user's requested action and available artifacts.
You may inspect files or existing CAD if that is needed to choose a route.
Do not modify engineering artifacts in this state.

For the V0 walking skeleton, choose the Quick workflow by calling cad_route with:

- workflow: "quick"
- reason: one sentence explaining why the task is fully specified direct geometry.

Quick is only correct when geometry and outputs are explicit, no system architecture or concept choice is required, no unfamiliar legacy design intent must be recovered, and no unresolved fit-critical interface controls the result.
