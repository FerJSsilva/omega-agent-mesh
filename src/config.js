// Configuração central do mesh.
//
// Único módulo que lê `process.env` e resolve caminhos do projeto. Qualquer
// outro módulo importa `config` daqui em vez de ler env vars ou montar paths
// por conta própria — assim a fonte da verdade é uma só.
//
// Todos os valores têm default: o mesh roda sem nenhum arquivo .env.
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

// Raiz do projeto = pasta acima de src/.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Lê uma env var booleana. Como toda env var é string, "false" seria truthy —
// por isso o teste explícito. Ausente → usa o default.
function flag(name, defaultValue = true) {
  const v = process.env[name];
  return v === undefined ? defaultValue : v !== 'false';
}

export const config = {
  // Raiz do projeto e diretórios derivados dela.
  root: ROOT,
  paths: {
    schema:    join(ROOT, 'src', 'schema.graphql'),
    handoffs:  join(ROOT, 'handoffs'),
    skills:    join(ROOT, 'skills'),
    workspace: join(ROOT, 'workspace'),
    logs:      join(ROOT, 'logs'),
    jobsFile:  join(ROOT, 'jobs.json'),
    // Índice SQLite (sql.js): artefatos do workspace + estado dos jobs.
    // Descartável — regenerável dos .md, exceto a tabela jobs.
    dbFile:    join(ROOT, process.env.MESH_DB_FILE ?? 'mesh-index.db'),
  },

  // Agents rodam com sessão persistente, salvo MESH_SESSION_PERSISTENCE=false.
  sessionPersistence: flag('MESH_SESSION_PERSISTENCE'),

  // Grava .raw.log + .json por spawn em logs/, salvo MESH_LOG_TO_FILE=false.
  logToFile: flag('MESH_LOG_TO_FILE'),

  // Sincroniza skills para os homes no boot, salvo MESH_SYNC_SKILLS=false.
  syncSkills: flag('MESH_SYNC_SKILLS'),

  // Máximo de agents rodando em paralelo. Acima disso, entram na fila.
  maxConcurrency: Number(process.env.MESH_MAX_CONCURRENCY ?? 3),

  // Porta do servidor GraphQL.
  port: Number(process.env.MESH_PORT ?? 4000),

  // Diretórios onde o mesh procura `.claude/agents/*.md`.
  // Separador `;` (convenção Windows — paths podem conter `:` por causa de C:/).
  // Paths relativos resolvem a partir da raiz do projeto.
  homes: (
    process.env.MESH_HOMES ??
    './homes/ideia;./homes/texto;./homes/revisao;./homes/publicacao'
  )
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => resolve(ROOT, s)),
};
