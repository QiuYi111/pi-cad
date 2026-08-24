# Mechanical Pack Recipe templates

These are trusted, copy-to-project authoring templates for the v7 Recipe
Kernel. Copy the selected directory under the same `recipes/<kind>/...`
path in a project, replace its example `spec.json` and declared inputs, then
pass that project-relative directory to the corresponding `cad_*` action.

The manifest—not the tool call—owns executable files, runtime, resources,
typed inputs, named actions, observer, and exports. Project tools may select a
declared action and bind a current obligation, but cannot inject commands.
