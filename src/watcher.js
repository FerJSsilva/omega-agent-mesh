// Watcher: dispara handoffs automaticamente quando artefatos aparecem.
//
// Observa o workspace/. Quando um novo .md aparece, lê seu `type` e procura um
// handoff com `trigger:` correspondente — se houver, spawna o agent destino.
//
// É o que transforma handoffs encadeados num pipeline: ideia → texto → revisao
// → publicacao acontece sem cliente nenhum chamando mutation. Roteamento 100%
// determinístico: o modelo não decide para onde o artefato vai.
//
// Opt-in: handoffs sem `trigger:` são ignorados aqui (continuam manuais).
import chokidar from 'chokidar';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import { config } from './config.js';
import { spawnAgent } from './spawn.js';

const WORKSPACE = config.paths.workspace;
const HANDOFFS_DIR = config.paths.handoffs;

// Mapeia `type` de gatilho → rota do handoff. Só handoffs com `trigger:` entram.
function loadTriggers() {
  const triggers = new Map();
  if (!existsSync(HANDOFFS_DIR)) return triggers;

  for (const file of readdirSync(HANDOFFS_DIR).filter((f) => f.endsWith('.md'))) {
    const raw = readFileSync(join(HANDOFFS_DIR, file), 'utf8');
    const { data } = matter(raw);
    if (data.trigger && data.to && data.arg) {
      triggers.set(data.trigger, { to: data.to, arg: data.arg, action: data.action, template: raw });
    }
  }
  return triggers;
}

// Inicia o watcher. Chamado depois do servidor subir. Sem triggers → no-op.
export function startWatcher() {
  const triggers = loadTriggers();

  console.log(`[watcher] observando ${WORKSPACE}`);
  if (triggers.size === 0) {
    console.log('[watcher] nenhum trigger configurado');
    return null;
  }
  triggers.forEach((route, type) => console.log(`  ${type} → ${route.to}`));

  const watcher = chokidar.watch(WORKSPACE, {
    ignored: (path, stats) => stats?.isFile() && !path.endsWith('.md'),
    ignoreInitial: true, // não dispara para arquivos que já existiam no boot
    awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 200 },
  });

  watcher.on('add', (filePath) => {
    try {
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

      spawnAgent(
        route.to,
        [
          'Você foi acionado pelo mesh.',
          `${route.arg}: ${normalizedPath}`,
          `Workspace: ${WORKSPACE}`,
          '',
          'Leia o arquivo acima e produza seu artefato no workspace.',
          'Use este template como referência de estrutura e frontmatter:',
          '',
          route.template,
        ].join('\n'),
        { caller: 'watcher' },
      );
    } catch (err) {
      console.error(`[watcher] erro ao processar ${filePath}:`, err.message);
    }
  });

  return watcher;
}
