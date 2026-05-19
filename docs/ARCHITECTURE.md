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
| `db.js` | SQLite index (`sql.js`): workspace artifacts + job state | — |
| `jobs.js` | `Job` lifecycle, backed by the `jobs` table | config, db |
| `agents.js` | Agent discovery, registry, frontmatter loader | config |
| `skills.js` | Skill catalog + semver sync into homes | config |
| `spawn.js` | `claude` CLI spawn + concurrency queue + per-spawn logs | config, agents, jobs |
| `handoffs.js` | `handoffs/*.md` → generated mutation SDL + resolvers | config, spawn |
| `workspace.js` | `.md` → SQLite index → inferred query SDL + resolvers | config, db |
| `watcher.js` | Index sync + filesystem-triggered handoff pipeline | config, spawn, workspace |
| `resolvers.js` | Static resolvers for the base schema | agents, skills, jobs |
| `schema.js` | Merges base + workspace + handoffs into one schema | config, resolvers, handoffs, workspace |
| `index.js` | Bootstrap: open index, reindex, build schema, start server + watcher | config, skills, agents, db, jobs, workspace, schema, watcher |
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

## The index layer (`db.js`)

The workspace `.md` files and job state both live in one SQLite file
(`mesh-index.db`, via the `sql.js` package — pure JS/WASM, in-process). The
markdown files are the source of truth; the index is a **disposable mirror** —
delete the `.db` and a boot rebuilds it from the `.md` files. The one exception
is the `jobs` table: job history is not derivable from any markdown.

Workspace artifacts use a generic **EAV** layout — an `artifacts` row plus one
`frontmatter` row per field — because the GraphQL types are *inferred* from
arbitrary frontmatter and cannot map to fixed columns. Each frontmatter value is
stored `JSON.stringify`'d so its type round-trips faithfully (the number `42`
stays distinct from the string `"42"`), which the schema inference depends on.

## Boot sequence (`index.js`)

1. **`syncSkills()`** — copy each skill from `skills/` into every home's
   `.claude/skills/`, versioned by semver.
2. **`new Database(...).init()`** — open the SQLite index (`sql.js` is async).
3. **`reindexWorkspace(db)`** — scan `workspace/**/*.md` into the index,
   reparsing only files whose checksum changed, dropping vanished ones.
4. **`setJobsDb(db)`** — bind `jobs.js` to the index, hydrate its in-memory
   cache, and migrate a legacy `jobs.json` once if the `jobs` table is empty.
5. **`buildSchema(db)`** — read the base SDL, infer workspace types *from the
   index*, generate handoff mutations, merge into `typeDefs` + `resolvers`.
6. **`startStandaloneServer()`** — bring up Apollo on `MESH_PORT`.
7. **`startWatcher(db)`** — start the chokidar watcher *after* the server. It
   keeps the index in sync and fires handoff triggers.

Step 3 runs before step 5 because schema inference reads the index. Step 4 runs
before step 6 because the first mutation needs a working `jobs` table.

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
                      │  1. indexArtifact() → upsert into the SQLite index
                      │  2. type=texto matches a handoff trigger
                      ▼
               spawn.js  spawnAgent()  → next agent in the chain
```

The watcher does two things per event, index-first: it keeps the SQLite index
in sync (`add`/`change`/`unlink` → upsert/delete) and it fires triggers. Only
`add` fires a trigger — a `change` re-indexes but does **not** re-spawn, so an
agent editing its own output cannot loop. Routing is fully deterministic: the
watcher matches the artifact's `type` against handoff `trigger:` fields. The
model never decides where an artifact goes — the topology is declared in
`handoffs/*.md`.

## Concurrency model

`spawn.js` owns a single `PQueue` with `concurrency = MESH_MAX_CONCURRENCY`.
`spawnAgent()` is synchronous up to `createJob()`, then enqueues the actual
spawn. The queued task's promise resolves on the child process `close` event —
so a slot frees only when the process has genuinely exited, not before.

## Persistence

One SQLite file, `mesh-index.db` (see *The index layer* above). It holds the
workspace index and the `jobs` table. `jobs.js` keeps an in-memory `Map` as the
synchronous read path and writes through to the `jobs` table on every change;
`db.save()` exports the in-memory `sql.js` database to the file after each job
write and after each reindex. Writes are plain synchronous calls on the event
loop, so two spawns finishing together cannot interleave — no promise chain is
needed. The markdown files and the per-spawn logs remain plain files on disk;
the markdown is the source of truth and the index mirrors it.
