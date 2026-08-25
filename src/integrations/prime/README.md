# Prime integration

`extension.ts` uses Prime's public `context` event and has one job: compile
and append the current Pi-CAD Phase Card to the message list for the next
provider call. The message is not appended to the persisted session.

Prime remains an unmodified upstream dependency. Session management,
compaction, Python/IPython state, memory, and subagents remain Prime-owned.

Run the integration through `npm run prime:plan-c -- [Prime arguments]`. The
launcher allowlists only Prime's `ipython`, this extension, and the Python-backed
`cad` skill. It never invokes the inherited/npm Pi CLI.
