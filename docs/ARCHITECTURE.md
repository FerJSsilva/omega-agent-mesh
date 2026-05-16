# Architecture

This document explains how `omega-agent-mesh` is organized and how a request
flows through it. For *what* the project does, see [`README.md`](../README.md).

## Layout principle

`src/` is flat — one file, one concern. There are no subfolders: with a dozen
modules, folder nesting would add navigation cost without adding clarity. The
separation of concerns is enforced by what each file is allowed to know about,
not by directory depth.

Two rules keep the modules decoupled:

1. **`config.js` is the only module that reads `process.env` or builds paths.**
   Everyone else imports `config`. Change an env var or a directory once.
2. **Dependencies flow one way.** `config` depends on nothing. Domain modules
   (`jobs`, `agents`, `skills`) depend only on `config`. `spawn` depends on the
   domain. The GraphQL layer depends on everything below it. `index.js` sits on
   top. No cycles.

## Modules

| Module | Concern | Depends on |
|---|---|---|
| `config.js` | Env vars + project paths — single source of truth | — |
| `jobs.js` | `Job` lifecycle + `jobs.json` persistence | config |
| `agents.js` | Agent discovery, registry, frontmatter loader | config |
| `skills.js` | Skill catalog + semver sync into homes | config |
| `spawn.js` | `claude` CLI spawn + concurrency queue + per-spawn logs | config, agents, jobs |
| `handoffs.js` | `handoffs/*.md` → generated mutation SDL + resolvers | config, spawn |
| `workspace.js` | `workspace/**/*.md` → inferred query SDL + resolvers | config |
| `watcher.js` | Filesystem-triggered handoff pipeline | config, spawn |
| `resolvers.js` | Static resolvers for the base schema | agents, skills, jobs |
| `schema.js` | Merges base + workspace + handoffs into one schema | config, resolvers, handoffs, workspace |
| `index.js` | Bootstrap: sync skills, build schema, start server + watcher | config, skills, agents, schema, watcher |
| `schema.graphql` | Base SDL skeleton (the stable core types) | — |

## The schema is built from three sources

The final GraphQL schema is the concatenation of three SDL fragments, with the
matching resolver maps merged:

```
schema.graphql   ──┐
(stable skeleton)   │
                    ├──►  schema.js  ──►  typeDefs + resolvers  ──►  ApolloServer
workspace.js     ──┤      (buildSchema)
(inferred types)    │
                    │
handoffs.js      ──┘
(generated mutations)
```

`schema.js` omits empty fragments — an `extend type` with no target, or a type
with no fields, would break the GraphQL parser. So an empty `workspace/` or
`handoffs/` directory is fine; those parts simply do not appear.

## Boot sequence (`index.js`)

1. **`syncSkills()`** — copy each skill from `skills/` into every home's
   `.claude/skills/`, versioned by semver.
2. **`buildSchema()`** — read the base SDL, infer workspace types, generate
   handoff mutations, merge into `typeDefs` + `resolvers`.
3. **`startStandaloneServer()`** — bring up Apollo on `MESH_PORT`.
4. **`startWatcher()`** — start the chokidar watcher *after* the server, and
   only if at least one handoff declares a `trigger:`.

## Request flow — a manual handoff

```
client ──► mutation { criativo { gerarIdeia(tema: "...") { id status } } }
              │
              ▼
       handoffs.js resolver
              │  builds the prompt (template injected)
              ▼
        spawn.js  spawnAgent()
              │  createJob() → Job PENDENTE returned to client NOW
              ▼
           PQueue ──► runSpawn() ──► claude --agent ... (child process)
                                          │
                              on close ──►│ completeJob() → PRONTO / ERRO
                                          ▼
                                   logs/<ts>_<caller>__<callee>.{raw.log,json}
```

The mutation returns the `Job` as soon as `createJob()` runs — it does **not**
wait for the spawn. The client polls `Query.job(id)` for the real outcome.

## Request flow — an automatic pipeline

```
agent writes  workspace/texto-001.md  (type: texto)
                      │
                      ▼
              watcher.js  on('add')
                      │  type=texto matches a handoff trigger
                      ▼
               spawn.js  spawnAgent()  → next agent in the chain
```

Routing is fully deterministic: the watcher matches the artifact's `type`
against handoff `trigger:` fields. The model never decides where an artifact
goes — the topology is declared in `handoffs/*.md`.

## Concurrency model

`spawn.js` owns a single `PQueue` with `concurrency = MESH_MAX_CONCURRENCY`.
`spawnAgent()` is synchronous up to `createJob()`, then enqueues the actual
spawn. The queued task's promise resolves on the child process `close` event —
so a slot frees only when the process has genuinely exited, not before.

## Persistence

Only `jobs.json`. `jobs.js` keeps an in-memory `Map` and re-serializes it on
every change. Concurrent writes (several spawns finishing together) are
serialized through a promise chain, so the file is never written by two
overlapping operations. Everything else — workspace artifacts, logs — is plain
files on disk, read fresh when queried.
