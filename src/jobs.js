// Estado dos jobs: registro em memória + persistência no índice SQLite.
//
// Cada mutation de handoff cria um Job (id, caller, callee, status...). Quando
// o spawn correspondente termina, o Job é atualizado. O estado sobrevive a
// restarts do servidor — agora na tabela `jobs` do índice, não mais em jobs.json.
//
// A tabela é atrás de um cache em memória (Map): getJob/listJobs precisam ser
// SÍNCRONOS (resolvers.js faz listJobs().sort(...)). O Map é o caminho de
// leitura; o SQLite é a durabilidade. createJob/completeJob escrevem nos dois.
//
// Não há mais cadeia de Promises: cada escrita é Map → db.run → db.save(), tudo
// síncrono no event loop — dois spawns terminando "juntos" rodam seus
// completeJob em sequência, sem intercalar. Sem corrupção, sem cadeia.
import { readFileSync, existsSync } from 'node:fs';
import { config } from './config.js';

// Cache em memória. Hidratado uma vez em setJobsDb a partir do banco.
const jobs = new Map();

// O índice SQLite. jobs.js não pode `await db.init()` no import (spawn.js o
// importa de forma síncrona) — então o index.js injeta o db pronto via setJobsDb.
let db = null;

// Liga o módulo ao índice. Chamado no boot, depois de db.init() e antes do
// servidor subir — então nenhuma mutation roda antes disto. Hidrata o cache e
// migra um jobs.json legado, se houver.
export function setJobsDb(database) {
  db = database;
  migrateLegacyJobsFile();
  for (const job of db.getAllJobs()) jobs.set(job.id, job);
}

// Migração única: se a tabela jobs está vazia e existe um jobs.json antigo,
// importa o histórico. jobs.json é deixado no disco como rede de segurança.
function migrateLegacyJobsFile() {
  if (db.countJobs() > 0) return;
  if (!existsSync(config.paths.jobsFile)) return;
  try {
    const legacy = JSON.parse(readFileSync(config.paths.jobsFile, 'utf8'));
    const entries = Object.values(legacy);
    for (const job of entries) db.insertJob(job);
    if (entries.length > 0) {
      db.save();
      console.log(`[jobs] migrados ${entries.length} job(s) de jobs.json`);
    }
  } catch {
    /* jobs.json corrompido — ignora, começa limpo */
  }
}

// Cria um Job no estado PENDENTE. Chamado de forma síncrona pela mutation,
// antes do spawn entrar na fila — o cliente recebe o id imediatamente.
export function createJob({ id, caller, callee }) {
  const job = {
    id,
    status: 'PENDENTE',
    caller,
    callee,
    startedAt: new Date().toISOString(),
    endedAt: null,
    durationMs: null,
    exitCode: null,
  };
  jobs.set(id, job);
  db.insertJob(job);
  db.save();
  return job;
}

// Fecha um Job quando o processo do agent termina. PRONTO se exit 0, senão ERRO.
export function completeJob(id, { exitCode }) {
  const job = jobs.get(id);
  if (!job) return null;
  const endedAt = new Date();
  job.endedAt = endedAt.toISOString();
  job.durationMs = endedAt.getTime() - new Date(job.startedAt).getTime();
  job.exitCode = exitCode;
  job.status = exitCode === 0 ? 'PRONTO' : 'ERRO';
  jobs.set(id, job);
  db.updateJob(job);
  db.save();
  return job;
}

export function getJob(id) {
  return jobs.get(id) ?? null;
}

export function listJobs() {
  return [...jobs.values()];
}
