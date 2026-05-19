// Watcher: mantém o índice do workspace em dia e dispara handoffs automáticos.
//
// Observa o workspace/. Tem dois trabalhos, nesta ordem:
//
//   1. SINCRONIZAR O ÍNDICE — add/change/unlink de .md viram upsert/delete no
//      índice SQLite. As queries GraphQL leem do índice, então ele precisa
//      acompanhar o disco.
//   2. DISPARAR HANDOFFS — quando um .md NOVO aparece, lê seu `type` e procura
//      um handoff com `trigger:` correspondente; se houver, spawna o agent
//      destino. Só `add` dispara: editar (change) re-indexa mas NÃO re-spawna —
//      senão um agent editando o próprio output causaria loop.
//
// É o que transforma handoffs encadeados num pipeline: ideia → texto → revisao
// → publicacao acontece sem cliente nenhum chamando mutation. Roteamento 100%
// determinístico: o modelo não decide para onde o artefato vai.
//
// Opt-in: handoffs sem `trigger:` são ignorados no passo 2 (continuam manuais).
import chokidar from 'chokidar';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import { config } from './config.js';
import { spawnAgent } from './spawn.js';
import { artifactTemplate, namingInstruction, fkInstruction } from './handoffs.js';
import { indexArtifact, removeArtifact } from './workspace.js';

const WORKSPACE = config.paths.workspace;
const HANDOFFS_DIR = config.paths.handoffs;

// Mapeia `type` de gatilho → rota do handoff. Só handoffs com `trigger:` entram.
function loadTriggers() {
  const triggers = new Map();
  if (!existsSync(HANDOFFS_DIR)) return triggers;

  for (const file of readdirSync(HANDOFFS_DIR).filter((f) => f.endsWith('.md'))) {
    const raw = readFileSync(join(HANDOFFS_DIR, file), 'utf8');
    const { data, content } = matter(raw);
    if (data.trigger && data.to && data.arg) {
      triggers.set(data.trigger, {
        to: data.to,
        arg: data.arg,
        action: data.action,
        type: data.type, // tipo do artefato que esta rota produz
        // Só a parte de artefato vai no prompt — sem o frontmatter de roteamento.
        template: artifactTemplate(data, content),
      });
    }
  }
  return triggers;
}

// Dispara o handoff para um .md recém-chegado, se o `type` dele tiver trigger.
function fireTrigger(triggers, filePath) {
  const { data } = matter(readFileSync(filePath, 'utf8'));
  if (!data.type) {
    console.log(`[watcher] ${filePath}: sem 'type' no frontmatter — ignorando`);
    return;
  }

  const route = triggers.get(data.type);
  if (!route) {
    console.log(`[watcher] type=${data.type}: sem trigger (folha ou entry point)`);
    return;
  }

  const normalizedPath = filePath.replace(/\\/g, '/');
  console.log(`[watcher] type=${data.type} → ${route.to} (${route.action})`);

  const promptLines = [
    'Você foi acionado pelo mesh.',
    `${route.arg}: ${normalizedPath}`,
    `Workspace: ${WORKSPACE}`,
    '',
    'Leia o arquivo acima e produza seu artefato no workspace.',
    'Use este template como referência de estrutura e frontmatter:',
    '',
    route.template,
  ];
  if (route.type) {
    promptLines.push('', namingInstruction(route.type));
  }
  const fk = fkInstruction(route.arg, route.template);
  if (fk) promptLines.push('', fk);

  spawnAgent(route.to, promptLines.join('\n'), { caller: 'watcher' });
}

// Inicia o watcher. Chamado depois do servidor subir. Recebe o índice (db) para
// manter sincronizado. Observa sempre — mesmo sem triggers, precisa indexar.
export function startWatcher(db) {
  const triggers = loadTriggers();

  console.log(`[watcher] observando ${WORKSPACE}`);
  if (triggers.size === 0) {
    console.log('[watcher] nenhum trigger configurado (só indexação)');
  } else {
    triggers.forEach((route, type) => console.log(`  ${type} → ${route.to}`));
  }

  const watcher = chokidar.watch(WORKSPACE, {
    ignored: (path, stats) => stats?.isFile() && !path.endsWith('.md'),
    ignoreInitial: true, // arquivos do boot já foram indexados por reindexWorkspace
    awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 200 },
  });

  // .md novo: indexa e DEPOIS dispara o handoff (se houver trigger).
  watcher.on('add', (filePath) => {
    try {
      indexArtifact(db, filePath);
      db.save();
      fireTrigger(triggers, filePath);
    } catch (err) {
      console.error(`[watcher] erro ao processar ${filePath}:`, err.message);
    }
  });

  // .md editado: só re-indexa. NÃO re-dispara — evita loop de spawn.
  watcher.on('change', (filePath) => {
    try {
      indexArtifact(db, filePath);
      db.save();
    } catch (err) {
      console.error(`[watcher] erro ao re-indexar ${filePath}:`, err.message);
    }
  });

  // .md apagado: remove do índice.
  watcher.on('unlink', (filePath) => {
    try {
      removeArtifact(db, filePath);
      db.save();
    } catch (err) {
      console.error(`[watcher] erro ao remover ${filePath}:`, err.message);
    }
  });

  return watcher;
}
