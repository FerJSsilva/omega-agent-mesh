// Estado dos jobs: registro em memória + persistência em jobs.json.
//
// Cada mutation de handoff cria um Job (id, caller, callee, status...). Quando
// o spawn correspondente termina, o Job é atualizado e o arquivo re-serializado.
// jobs.json sobrevive a restarts do servidor.
//
// Escritas concorrentes (vários spawns terminando juntos) são serializadas por
// uma cadeia de Promises — evita corrupção do arquivo por escritas sobrepostas.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { config } from './config.js';

const JOBS_FILE = config.paths.jobsFile;

// Carrega o estado anterior do disco, ou começa vazio.
function load() {
  if (!existsSync(JOBS_FILE)) return new Map();
  try {
    return new Map(Object.entries(JSON.parse(readFileSync(JOBS_FILE, 'utf8'))));
  } catch {
    return new Map();
  }
}

const jobs = load();

// Âncora da cadeia de escritas. Cada persist() encadeia a próxima gravação.
let writeChain = Promise.resolve();
function persist() {
  writeChain = writeChain.then(() =>
    writeFileSync(JOBS_FILE, JSON.stringify(Object.fromEntries(jobs), null, 2)),
  );
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
  persist();
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
  persist();
  return job;
}

export function getJob(id) {
  return jobs.get(id) ?? null;
}

export function listJobs() {
  return [...jobs.values()];
}
