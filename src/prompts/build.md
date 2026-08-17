# Pi-CAD build

Current state: BUILD.

- Write or edit the build123d source in models/ (normally models/<part>.py).
- The source must expose a build123d Shape as `result`, or call cadctl gen_step(result, output).
- Keep STEP as the primary artifact. Do not hand-edit the exported STEP to fix intent; fix the Python source.
- When the source is ready, call cad_commit_candidate with the source path and a short label.
- The harness then builds STEP, renders views, gathers geometry facts, and returns that evidence to you. Do not run the old scripts/step -> snapshot -> inspect chain by hand.
