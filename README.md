# omega-agent-mesh

A GraphQL **agent mesh** for headless Claude agents. Agents hand work off to
each other through declarative routes, share a workspace of `.md` artifacts,
and the whole mesh is browsable as a live GraphQL schema.

Three things are generated or inferred at boot — you never hand-write the schema:

- **Mutations** come from `handoffs/*.md` (declarative routes).
- **Query types** are inferred from `workspace/**/*.md` (artifact frontmatter).
- **Agents** and **skills** are discovered from the filesystem.

## Concepts

### 1. Handoff — a declared route

Each file in `handoffs/*.md` declares a route via frontmatter:

```yaml
---
type: ideia                # artifact type THIS handoff produces
to: ideia/criativo          # destination agent (<home>/<agent>)
action: gerarIdeia          # mutation name
arg: tema                   # mutation argument name
argType: String             # GraphQL type of the argument
---

# [Expected artifact template]
```

At boot the mesh generates:

- A mutation `criativo.gerarIdeia(tema: String!): Job!`
- A resolver that spawns `ideia/criativo`, injecting the template into the prompt.

**Without `trigger:`** → a **manual** mutation. A client calls it via GraphQL.

**With `trigger: <type>`** → manual mutation **+ pipeline**: the watcher fires
the handoff automatically when an artifact of `<type>` appears in the workspace.

The bundled demo wires a full pipeline:
`gerarIdeia` (manual) → `ideia` → `escreverTexto` → `texto` → `revisarTexto`
→ `revisao` → `publicar`.

### 2. Workspace — shared state

Agents read and write `.md` files with frontmatter under `workspace/`. Each file
needs an `id` and a `type`. Every other frontmatter field becomes an **inferred
GraphQL field**:

- Scalar types are detected automatically (Int / Float / String / Boolean).
- A field whose name matches a known `type` becomes a **foreign key**.
- Reverse relations are auto-generated: if `Texto` has `ideia: <id>`, then
  `Ideia.textos: [Texto!]!` appears for free.
- The walk is recursive — organize subfolders however you like.

```graphql
query { ideias { id tema textos { id palavras } } }
```

### 3. Job — the handoff record

Every mutation creates a `Job`. Lifecycle: `PENDENTE → PRONTO / ERRO`. Jobs
persist in `jobs.json` and survive restarts.

```graphql
query { job(id: "uuid") { status durationMs exitCode } }
query { jobs { id status caller callee } }
```

### 4. Catalogs over GraphQL

```graphql
query {
  agents { name description model skills }
  handoffs { type to action arg }
  skills { name description version }
}
```

### 5. Unidirectional by construction

Each handoff points `to:` a single agent. There are no reverse mutations — the
mesh is a DAG by declaration, so cycles are impossible.

### 6. Bounded concurrency

A queue caps concurrent spawns at `MESH_MAX_CONCURRENCY` (default 3). A `Job` is
created `PENDENTE` immediately; the `claude` process only starts when a slot
frees up.

## Stack

- Node.js 20.18+ (ESM)
- Apollo Server 5 (`startStandaloneServer`)
- `gray-matter` — frontmatter parsing
- `chokidar` — workspace watcher (opt-in)
- `p-queue` — concurrency limiting

## Running

```bash
npm install
npm run dev
```

Server starts on `http://localhost:4000/graphql` — Apollo Sandbox opens there.

### Prerequisites

- The `claude` CLI installed and on `PATH`.
- Each home in `MESH_HOMES` must have `.claude/agents/*.md` definitions.
- Permission to run `claude --dangerously-skip-permissions`.

## Configuration

Every setting has a default — the mesh runs with no `.env`. Copy `.env.example`
to `.env` to override. See [`.env.example`](.env.example) for the full list
(`MESH_PORT`, `MESH_MAX_CONCURRENCY`, `MESH_HOMES`, ...).

## Project layout

```
omega-agent-mesh/
  src/
    config.js       env vars + project paths (single source of truth)
    index.js        bootstrap: assemble schema, start server + watcher
    schema.js       merges base + workspace + handoffs into one schema
    schema.graphql  base SDL skeleton
    resolvers.js    static Query/Mutation resolvers
    agents.js       agent discovery + registry + loader
    skills.js       skill catalog + semver sync to homes
    jobs.js         Job lifecycle + jobs.json persistence
    spawn.js        claude CLI spawn + concurrency queue + logs
    handoffs.js     handoffs/*.md → generated mutations
    workspace.js    workspace/**/*.md → inferred query types
    watcher.js      chokidar pipeline triggers
  handoffs/         declared routes (auto-generated mutations)
  homes/            .claude/agents/*.md per namespace (demo)
  skills/           skills synced into the homes
  workspace/        (gitignored) artifacts produced by agents at runtime
  logs/             (gitignored) per-spawn raw + json logs
  jobs.json         (gitignored) Job state
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the module-by-module
breakdown and data flow.

## Adding an agent

1. Create `homes/<ns>/.claude/agents/<name>.md` with standard Claude Code
   frontmatter.
2. If the home is new, add it to `MESH_HOMES` in `.env`.
3. (Optional) Create `handoffs/<action>.md` if other agents or clients should
   be able to call it — with `trigger:` if it is part of a pipeline.
4. Restart — `Query.agents` and the SDL pick it up automatically.

## License

Source-available under the [omega-agent-mesh License](LICENSE) — see the file
for terms. Built by **Omega Coders**.
