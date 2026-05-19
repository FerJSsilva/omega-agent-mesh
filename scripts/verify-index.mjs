// Verificação do refactor do índice SQLite — NÃO spawna agents.
//
// Roda: node scripts/verify-index.mjs
//
// 1. Cria artefatos de teste no workspace (escalares, Int/Float, lista, FK,
//    relação reversa, campo opcional).
// 2. Reindexa para o banco e monta o schema — imprime o SDL inferido.
// 3. Exercita as queries do workspace via os resolvers (lista, single, FK,
//    relação reversa) e confere os resultados.
// 4. Exercita o ciclo de vida de Job (createJob → completeJob) sem spawnar.
// 5. Limpa os artefatos de teste.
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../src/config.js';
import { Database } from '../src/db.js';
import { reindexWorkspace, loadWorkspace } from '../src/workspace.js';
import { setJobsDb, createJob, completeJob, getJob, listJobs } from '../src/jobs.js';

const WS = config.paths.workspace;
const TEST_DB = join(config.root, 'verify-index.db');

function md(name, frontmatter, body) {
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? JSON.stringify(v) : v}`)
    .join('\n');
  writeFileSync(join(WS, name), `---\n${fm}\n---\n\n${body}\n`);
}

function assert(cond, msg) {
  if (!cond) {
    console.error(`  ✗ FALHOU: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${msg}`);
  }
}

// ── 1. Artefatos de teste ────────────────────────────────────────────────────
if (!existsSync(WS)) mkdirSync(WS, { recursive: true });
const created = ['ideia-teste-a.md', 'ideia-teste-b.md', 'texto-teste-x.md'];

md('ideia-teste-a.md',
  { id: 'ideia-teste-a', type: 'ideia', tema: 'Verificação', peso: 3,
    score: 1.5, ativo: true, tags: ['a', 'b'] },
  '# Ideia A');
md('ideia-teste-b.md',
  { id: 'ideia-teste-b', type: 'ideia', tema: 'Segunda', peso: 7,
    score: 2.0, ativo: false, tags: ['c'] },
  '# Ideia B');
// texto tem FK `ideia` → relação reversa Ideia.textos
md('texto-teste-x.md',
  { id: 'texto-teste-x', type: 'texto', ideia: 'ideia-teste-a', palavras: 120 },
  '# Texto X');

// ── 2. Reindex + schema ──────────────────────────────────────────────────────
const db = await new Database(TEST_DB).init();
const reindex = reindexWorkspace(db);
console.log(`\n[reindex] ${reindex.added} indexado(s), ${reindex.skipped} cache, ${reindex.removed} removido(s)\n`);

const ws = loadWorkspace(db);
console.log('── SDL inferido do workspace ──────────────────────────');
console.log(ws.sdl);
console.log('───────────────────────────────────────────────────────\n');

// ── 3. Queries do workspace ──────────────────────────────────────────────────
console.log('[queries do workspace]');
const ideias = ws.resolvers.Query.ideias();
assert(ideias.length === 2, 'ideias() devolve 2 artefatos');

const ideiaA = ws.resolvers.Query.ideia(null, { id: 'ideia-teste-a' });
assert(ideiaA?.tema === 'Verificação', 'ideia(id) devolve o artefato certo');
assert(ideiaA?.peso === 3 && typeof ideiaA.peso === 'number', 'Int round-trip: peso é 3 (number)');
assert(ideiaA?.score === 1.5, 'Float round-trip: score é 1.5');
assert(ideiaA?.ativo === true && typeof ideiaA.ativo === 'boolean', 'Boolean round-trip: ativo é true');
assert(Array.isArray(ideiaA?.tags) && ideiaA.tags.length === 2, 'Lista round-trip: tags tem 2 itens');
assert(ideiaA?.body.includes('Ideia A'), 'body preservado');

const textoX = ws.resolvers.Query.texto(null, { id: 'texto-teste-x' });
const fkResolver = ws.resolvers.Texto?.ideia;
assert(typeof fkResolver === 'function', 'resolver de FK Texto.ideia existe');
const linkedIdeia = fkResolver(textoX);
assert(linkedIdeia?.id === 'ideia-teste-a', 'FK Texto.ideia segue para ideia-teste-a');

const reverseResolver = ws.resolvers.Ideia?.textos;
assert(typeof reverseResolver === 'function', 'resolver reverso Ideia.textos existe');
const textosDeA = reverseResolver(ideiaA);
assert(textosDeA.length === 1 && textosDeA[0].id === 'texto-teste-x',
  'relação reversa Ideia.textos lista texto-teste-x');

// ── 4. Ciclo de vida de Job (sem spawn) ──────────────────────────────────────
console.log('\n[ciclo de vida de Job]');
setJobsDb(db);
const job = createJob({ id: 'verify-job-1', caller: 'verify', callee: 'teste/agente' });
assert(job.status === 'PENDENTE', 'createJob → status PENDENTE');
const done = completeJob('verify-job-1', { exitCode: 0 });
assert(done.status === 'PRONTO', 'completeJob(exit 0) → status PRONTO');
assert(typeof done.durationMs === 'number', 'completeJob preenche durationMs');
assert(getJob('verify-job-1')?.status === 'PRONTO', 'getJob devolve o estado atualizado');
assert(listJobs().some((j) => j.id === 'verify-job-1'), 'listJobs inclui o job');

// Restart: reabre o banco, confirma que o job sobreviveu.
db.close();
const db2 = await new Database(TEST_DB).init();
setJobsDb(db2);
assert(getJob('verify-job-1')?.status === 'PRONTO', 'job sobrevive a restart (lido do .db)');
db2.close();

// ── 5. Limpeza ───────────────────────────────────────────────────────────────
for (const f of created) rmSync(join(WS, f), { force: true });
rmSync(TEST_DB, { force: true });
console.log('\n[limpeza] artefatos de teste e verify-index.db removidos.');
console.log(process.exitCode ? '\n✗ VERIFICAÇÃO FALHOU\n' : '\n✓ VERIFICAÇÃO OK\n');
