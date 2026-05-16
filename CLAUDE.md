# CLAUDE.md — omega-agent-mesh

Orientation for any Claude session working in this repo. `README.md` is the
"what"; `docs/ARCHITECTURE.md` is the "how it's built"; this file is "how to
think while editing here".

## What this project is

A GraphQL mesh for headless Claude agents. Agents hand work off through routes
declared in `handoffs/*.md`, share a `workspace/` of `.md` artifacts, and the
mesh exposes itself as a live, browsable GraphQL schema.

## Design principles

- **Frontmatter is the schema.** `handoffs/*.md` defines mutations.
  `workspace/**/*.md` defines query types. `homes/*/.claude/agents/*.md`
  defines agents. The GraphQL schema is generated/inferred from these at boot.
- **Schema is a catalog.** Who can call whom lives in `Query.handoffs` and the
  auto-generated mutations — discoverable via introspection.
- **Automatic discovery.** Add an agent = create its `.claude/agents/<name>.md`.
  Add a route = create `handoffs/<action>.md`. Restart, done.
- **Fire-and-forget.** A mutation returns a `Job` (UUID + `PENDENTE`)
  immediately. Real status is polled via `Query.job(id)` / `Query.jobs`.
- **Bounded concurrency.** A queue caps spawns at `MESH_MAX_CONCURRENCY`.
- **Minimal persistence.** Only `jobs.json`. Logs are evidence, not state.
- **`config.js` is the single source of truth** for env vars and paths. Never
  read `process.env` or build paths anywhere else — import `config`.

## Two handoff modes (opt-in per handoff)

- **No `trigger:` → manual handoff.** A client calls
  `mutation { <ns> { <action>(arg: ...) } }`. The agent is spawned, done.
- **With `trigger: <type>` → automatic pipeline.** When an artifact of `<type>`
  lands in the workspace, the watcher fires the handoff. Chaining happens with
  no client involved.

Both modes coexist in the same mesh.

## Intentionally out of scope

- **Synchronous replies** from the destination agent. Mutations are
  fire-and-forget — they return a `Job` with `status: PENDENTE` right away.
- **Bidirectional loops.** The schema is unidirectional by construction: a
  handoff points `to:` in one direction only. DAG by declaration.
- **Forced structured JSON on agent stdout.** The full `claude --output-format
  json` log is preserved. Domain structure comes out as a workspace file.
- **A flat/vertical schema** (`criarContrato(...)`). The schema stays
  horizontal — namespaced per destination agent — so the catalog stays
  browsable by actor.

## Before touching code

- **Do not spawn real agents in tests.** Each spawn burns tokens. Ask before
  testing with a real agent. To validate the mesh, boot it and use
  introspection / `ping` / `Query.agents` instead.
- **Adding workspace files while the server runs triggers the watcher.** If a
  file's `type` matches a handoff `trigger:`, an agent is spawned. To test
  inference safely, add files while the server is stopped (`ignoreInitial`
  means existing files don't fire the watcher at boot).
- **Do not change `src/schema.graphql` lightly.** It is only the skeleton —
  mutations and query types are generated. The base affects `Job`, `Agent`,
  `Handoff`, `Skill` — discuss first.
- **Do not add persistence beyond `jobs.json`** (SQLite/Redis/etc.) without
  asking whether the pain justifies it.

## Where to look first

| Question | Where |
|---|---|
| What does this project do? | `README.md` |
| How are the modules organized? | `docs/ARCHITECTURE.md` |
| Which handoff routes exist? | `handoffs/*.md` or `Query.handoffs` |
| Which agents exist? | `homes/*/.claude/agents/*.md` or `Query.agents` |
| Which skills exist? | `skills/*/SKILL.md` or `Query.skills` |
| What happened in a spawn? | `logs/<ts>_<caller>__<callee>.json` |
| What is a Job's state? | `jobs.json` or `Query.jobs` |
| The final merged schema? | introspection via Apollo Sandbox |
