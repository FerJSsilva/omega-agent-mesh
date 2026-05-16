// Handoffs: rotas declarativas que viram mutations GraphQL.
//
// Cada arquivo em handoffs/*.md declara uma rota no frontmatter:
//
//   ---
//   type: ideia            # tipo de artefato que ESTE handoff produz
//   to: ideia/criativo     # agent destino (<home>/<agent>)
//   action: gerarIdeia     # nome da mutation
//   arg: tema              # nome do argumento
//   argType: String        # tipo GraphQL do argumento
//   trigger: <type>        # (opcional) dispara via watcher; sem isto, é manual
//   ---
//   ...template do artefato esperado...
//
// No boot, cada handoff gera uma mutation `<namespace>.<action>(<arg>): Job!`,
// cujo resolver spawna o agent destino injetando o template no prompt.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import { config } from './config.js';
import { spawnAgent } from './spawn.js';

const HANDOFFS_DIR = config.paths.handoffs;
const WORKSPACE = config.paths.workspace.replace(/\\/g, '/');

// 'ideia' → 'Ideia', 'sub-tema' → 'SubTema'.
function capitalize(s) {
  return s.replace(/(^|-)(\w)/g, (_, _sep, c) => c.toUpperCase());
}

// Lê handoffs/*.md e devolve as rotas válidas (com to/action/arg).
function loadHandoffs() {
  if (!existsSync(HANDOFFS_DIR)) return [];

  const handoffs = [];
  for (const file of readdirSync(HANDOFFS_DIR).filter((f) => f.endsWith('.md'))) {
    const raw = readFileSync(join(HANDOFFS_DIR, file), 'utf8');
    const { data } = matter(raw);

    if (!data.to || !data.action || !data.arg) {
      console.warn(`[handoffs] ${file}: falta to/action/arg — pulando`);
      continue;
    }

    handoffs.push({
      file,
      type: data.type,
      trigger: data.trigger || null,
      to: data.to,
      namespace: data.to.split('/').pop(), // agent destino agrupa as ações
      action: data.action,
      arg: data.arg,
      argType: data.argType || 'String',
      template: raw, // template completo (frontmatter + corpo) vai no prompt
    });
  }
  return handoffs;
}

// Gera o SDL: um type `<Namespace>Actions` por agent destino + `extend Mutation`.
function generateSDL(handoffs) {
  const byNamespace = groupByNamespace(handoffs);
  const lines = [];

  for (const [ns, actions] of byNamespace) {
    lines.push(`type ${capitalize(ns)}Actions {`);
    for (const a of actions) {
      lines.push(`  "Spawna ${a.to}"`);
      lines.push(`  ${a.action}(${a.arg}: ${a.argType}!): Job!`);
    }
    lines.push('}', '');
  }

  lines.push('extend type Mutation {');
  for (const ns of byNamespace.keys()) {
    lines.push(`  ${ns}: ${capitalize(ns)}Actions!`);
  }
  lines.push('}');

  return lines.join('\n');
}

// Constrói o resolver map: Mutation.<ns> → objeto de ações, e cada ação spawna.
function buildResolvers(handoffs) {
  const byNamespace = groupByNamespace(handoffs);
  const resolvers = { Mutation: {} };

  for (const [ns, actions] of byNamespace) {
    // Mutation.<ns> só devolve um objeto vazio — as ações resolvem no type filho.
    resolvers.Mutation[ns] = () => ({});

    const typeName = `${capitalize(ns)}Actions`;
    resolvers[typeName] = {};

    for (const a of actions) {
      // Template do output deste agent = o handoff cujo `type` ele produz.
      const outputTemplate = handoffs.find((h) => h.type === a.type);

      resolvers[typeName][a.action] = (_parent, args) => {
        const argValue = args[a.arg];
        console.log(`[handoff] ${a.action}: ${a.arg}="${argValue}" → ${a.to}`);

        const promptParts = [
          'Você foi acionado pelo mesh.',
          `${a.arg}: ${argValue}`,
          `Workspace: ${WORKSPACE}`,
        ];
        if (outputTemplate) {
          promptParts.push(
            '',
            'Produza seu artefato no workspace usando este template:',
            '',
            outputTemplate.template,
          );
        }

        return spawnAgent(a.to, promptParts.join('\n'), { caller: 'mesh' });
      };
    }
  }

  return resolvers;
}

// Agrupa handoffs por namespace (agent destino).
function groupByNamespace(handoffs) {
  const map = new Map();
  for (const h of handoffs) {
    if (!map.has(h.namespace)) map.set(h.namespace, []);
    map.get(h.namespace).push(h);
  }
  return map;
}

// Carrega tudo: as rotas, o SDL gerado e o resolver map.
export function loadHandoffsModule() {
  const handoffs = loadHandoffs();
  return {
    handoffs,
    sdl: handoffs.length > 0 ? generateSDL(handoffs) : '',
    resolvers: handoffs.length > 0 ? buildResolvers(handoffs) : { Mutation: {} },
  };
}
