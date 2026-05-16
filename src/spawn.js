// Spawn de agents Claude headless.
//
// Roda `claude --agent <name>` em processo filho, controla a concorrência com
// uma fila (PQueue) e grava um log por spawn. O ciclo de vida do Job fica em
// jobs.js; o registro de agents (qual diretório é o cwd de cada um) em agents.js.
//
// Fire-and-forget: spawnAgent() devolve o Job imediatamente (status PENDENTE).
// O Job vira PRONTO/ERRO quando o processo termina.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import PQueue from 'p-queue';
import { config } from './config.js';
import { AGENT_HOME } from './agents.js';
import { createJob, completeJob } from './jobs.js';

const queue = new PQueue({ concurrency: config.maxConcurrency });

// Sanitiza uma string para uso em nome de arquivo.
function sanitize(s) {
  return s.replace(/[/\\:]/g, '_');
}

// Timestamp sem caracteres inválidos para nome de arquivo: 2026-05-06T14-30-00-123.
function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
}

// Grava os dois arquivos de log de um spawn: stdout cru + meta estruturada.
function writeLog({ caller, callee, cwd, pid, startedAt, code, userPrompt, stdout, stderr, parsed }) {
  try {
    mkdirSync(config.paths.logs, { recursive: true });
    const base = `${timestamp()}_${sanitize(caller)}__${sanitize(callee)}`;
    writeFileSync(join(config.paths.logs, `${base}.raw.log`), stdout);
    writeFileSync(
      join(config.paths.logs, `${base}.json`),
      JSON.stringify(
        {
          caller,
          callee,
          cwd,
          pid,
          startedAt: startedAt.toISOString(),
          endedAt: new Date().toISOString(),
          durationMs: Date.now() - startedAt.getTime(),
          exitCode: code,
          userPrompt,
          stdout: parsed ?? stdout,
          stderr,
        },
        null,
        2,
      ),
    );
  } catch (e) {
    console.error('[spawn] falha ao gravar log:', e.message);
  }
}

// Faz o spawn real e resolve a Promise no evento `close`. A Promise é o que a
// fila aguarda — a vaga só libera quando o processo realmente terminou.
function runSpawn(job, agentName, userPrompt, caller, cwd) {
  return new Promise((resolve) => {
    const realName = agentName.split('/').pop();

    // Comando como string única (não array) para evitar o aviso Node DEP0190.
    // realName vem de AGENT_HOME (controlado) — seguro interpolar.
    // userPrompt vai por stdin, não pelo shell — sem risco de injection.
    // --output-format json captura metadata (custo, duração, turns) no stdout.
    const persistenceFlag = config.sessionPersistence ? '' : ' --no-session-persistence';
    const cmd = `claude --agent ${realName} --dangerously-skip-permissions${persistenceFlag} --output-format json -p`;

    const child = spawn(cmd, {
      cwd,
      shell: true,       // resolve claude.cmd via cmd.exe no Windows
      windowsHide: true, // esconde a janela do wrapper cmd.exe
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stdin.write(userPrompt);
    child.stdin.end();

    const startedAt = new Date();
    console.log(
      `[spawn] ${caller} → ${agentName} job=${job.id} pid=${child.pid} ` +
        `(fila: ${queue.size} aguardando, ${queue.pending} rodando)`,
    );

    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on('data', (c) => stdoutChunks.push(c));
    child.stderr.on('data', (c) => {
      stderrChunks.push(c);
      console.error(`[${agentName} STDERR]`, c.toString().trimEnd());
    });

    child.on('close', (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString();
      const stderr = Buffer.concat(stderrChunks).toString();

      let parsed = null;
      if (stdout) {
        try {
          parsed = JSON.parse(stdout);
        } catch {
          /* stdout não é JSON — segue com o texto cru */
        }
      }
      console.log(`[${agentName} EXIT] code=${code} pid=${child.pid}`);

      completeJob(job.id, { exitCode: code });

      if (config.logToFile) {
        writeLog({ caller, callee: agentName, cwd, pid: child.pid, startedAt, code, userPrompt, stdout, stderr, parsed });
      }

      resolve();
    });

    child.on('error', (err) => {
      console.error(`[spawn] erro ao spawnar ${agentName}:`, err.message);
      completeJob(job.id, { exitCode: -1 });
      resolve(); // libera a vaga da fila mesmo em erro
    });
  });
}

// Cria um Job e enfileira o spawn do agent. Retorna o Job na hora (PENDENTE).
export function spawnAgent(agentName, userPrompt, { caller = 'external' } = {}) {
  const cwd = AGENT_HOME[agentName];
  if (!cwd) {
    throw new Error(
      `Agent desconhecido: ${agentName}. Crie .claude/agents/<name>.md em algum home.`,
    );
  }

  // Job criado de forma síncrona, antes da fila — o cliente recebe o id
  // imediatamente no retorno da mutation. Fica PENDENTE até o processo terminar.
  const job = createJob({ id: randomUUID(), caller, callee: agentName });

  if (queue.pending >= config.maxConcurrency) {
    console.log(`[spawn] enfileirado ${caller} → ${agentName} job=${job.id}`);
  }

  // Não fazemos await: spawnAgent retorna o Job na hora; a fila roda em background.
  queue.add(() => runSpawn(job, agentName, userPrompt, caller, cwd));

  return job;
}
