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

// Campos de roteamento do handoff — consumidos pelo mesh, não pertencem ao
// artefato que o agent produz. São removidos do template antes de ir no prompt.
const ROUTING_KEYS = ['to', 'action', 'arg', 'argType', 'trigger', 'filename'];

// Converte um handoff bruto no template de artefato visto pelo agent: o corpo
// intacto + um frontmatter sem campos de roteamento, com `id` (vazio) no topo
// para o agent preencher.
export function artifactTemplate(data, content) {
  const artifact = { id: data.id ?? '', type: data.type };
  for (const [key, value] of Object.entries(data)) {
    if (key === 'id' || key === 'type' || ROUTING_KEYS.includes(key)) continue;
    artifact[key] = value ?? ''; // campos a preencher entram vazios, não como null
  }
  return matter.stringify(content, artifact);
}

// Instrução de nomeação do artefato: nome do arquivo + campo `id`. Nenhum dos
// dois é conteúdo do artefato — são ordens para o agent, então vão no prompt e
// não no template. O prefixo `<type>-` é fixo para o watcher rotear. O `id` é
// amarrado ao nome do arquivo para sair sempre preenchido e consistente.
export function namingInstruction(type) {
  return (
    `Salve o artefato em workspace/ com o nome \`${type}-<slug>.md\`, onde ` +
    `<slug> é um identificador curto em kebab-case derivado do tema/título. ` +
    `O prefixo do nome DEVE ser exatamente \`${type}-\` — não use o nome do ` +
    `arquivo recebido como entrada. O campo \`id:\` do frontmatter DEVE ser ` +
    `preenchido com esse mesmo nome sem a extensão (\`${type}-<slug>\`) — ` +
    `nunca deixe \`id\` vazio.`
  );
}

// Instrução de preenchimento da foreign key. Quando o handoff recebe um caminho
// de arquivo (`arg` terminado em "Path") e o template do artefato tem um campo
// de FK com o nome correspondente (ideiaPath → ideia), manda o agent copiar o
// `id` lido do arquivo recebido — não o tema, o título nem o caminho. Sem isso,
// o agent tende a preencher a FK com prosa e a relação GraphQL não liga.
// Devolve '' quando não há FK a preencher.
export function fkInstruction(arg, template) {
  if (!arg || !arg.endsWith('Path')) return '';
  const fkField = arg.slice(0, -'Path'.length);
  const { data } = matter(template);
  if (!(fkField in data)) return '';
  return (
    `O campo \`${fkField}:\` do seu artefato é uma referência. Abra o arquivo ` +
    `recebido em ${arg}, leia o campo \`id:\` do frontmatter dele, e copie ` +
    `esse valor exato para \`${fkField}:\`. Não use o tema, o título nem o ` +
    `caminho do arquivo — apenas o \`id\`.`
  );
}

// Lê handoffs/*.md e devolve as rotas válidas (com to/action/arg).
function loadHandoffs() {
  if (!existsSync(HANDOFFS_DIR)) return [];

  const handoffs = [];
  for (const file of readdirSync(HANDOFFS_DIR).filter((f) => f.endsWith('.md'))) {
    const raw = readFileSync(join(HANDOFFS_DIR, file), 'utf8');
    const { data, content } = matter(raw);

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
      // Só a parte de artefato vai no prompt — sem o frontmatter de roteamento.
      template: artifactTemplate(data, content),
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

// Constrói o resolver map: Query.handoffs (catálogo das rotas), Mutation.<ns>
// → objeto de ações, e cada ação spawna o agent destino.
function buildResolvers(handoffs) {
  const byNamespace = groupByNamespace(handoffs);
  const resolvers = {
    Query: {
      handoffs: () =>
        handoffs.map((h) => ({
          type: h.type,
          to: h.to,
          action: h.action,
          arg: h.arg,
          file: h.file,
        })),
    },
    Mutation: {},
  };

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
        if (a.type) {
          promptParts.push('', namingInstruction(a.type));
        }
        if (outputTemplate) {
          const fk = fkInstruction(a.arg, outputTemplate.template);
          if (fk) promptParts.push('', fk);
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
// buildResolvers funciona com lista vazia (Query.handoffs → []), então é sempre
// chamado; só o SDL precisa do guard, pois `extend type` vazio quebra o parser.
export function loadHandoffsModule() {
  const handoffs = loadHandoffs();
  return {
    handoffs,
    sdl: handoffs.length > 0 ? generateSDL(handoffs) : '',
    resolvers: buildResolvers(handoffs),
  };
}
