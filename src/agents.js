// Registro de agents do mesh.
//
// Descobre agents varrendo cada home configurado por `.claude/agents/*.md` e
// expõe um loader que lê o frontmatter de cada definição.
//
// Read-only: o que está no .md aparece aqui. Defaults só onde a spec do
// Claude Code define um — ver https://code.claude.com/docs/en/sub-agents.
import { readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import matter from 'gray-matter';
import { config } from './config.js';

// Convenção: todo agent é referenciado como `<home-basename>/<agent-name>`.
// Namespace universal — a origem fica explícita e dois agents com o mesmo
// nome em homes diferentes coexistem sem conflito.
function discover(homes) {
  const map = {};
  for (const home of homes) {
    const ns = basename(home);
    const dir = join(home, '.claude', 'agents');
    let files;
    try {
      files = readdirSync(dir);
    } catch {
      continue; // home sem .claude/agents — ignora
    }
    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      map[`${ns}/${file.slice(0, -3)}`] = home;
    }
  }
  return map;
}

// Mapa `<qualifiedName>` → `<home dir>`. Construído uma vez, no boot.
export const AGENT_HOME = discover(config.homes);

// Lê a definição de um agent e normaliza o frontmatter para o tipo GraphQL.
// Retorna null se o agent não está registrado ou o .md não pôde ser lido.
export function loadAgent(qualifiedName) {
  const workdir = AGENT_HOME[qualifiedName];
  if (!workdir) return null;

  // qualifiedName = `<home-basename>/<agent-name>`; o .md vem do agent-name.
  const realName = qualifiedName.split('/').pop();
  const agentDefinition = join(workdir, '.claude', 'agents', `${realName}.md`);

  let data;
  try {
    data = matter(readFileSync(agentDefinition, 'utf8')).data;
  } catch {
    return null;
  }

  return {
    // Metadata do próprio mesh.
    name: qualifiedName,
    description: data.description ?? '',
    workdir,
    agentDefinition,

    // Frontmatter da spec Claude Code (defaults conforme a spec).
    tools:           data.tools ?? null,
    disallowedTools: data.disallowedTools ?? [],
    skills:          data.skills ?? [],
    model:           data.model ?? 'inherit',
    permissionMode:  data.permissionMode ?? null,
    effort:          data.effort ?? null,
    background:      data.background ?? false,
    maxTurns:        data.maxTurns ?? null,
    memory:          data.memory ?? null,
    isolation:       data.isolation ?? null,
    color:           data.color ?? null,
    initialPrompt:   data.initialPrompt ?? null,

    // Resolvido pelo resolver Agent.delegatesTo (ver resolvers.js).
    _delegatesToNames: data.delegatesTo ?? [],
  };
}

export function listAgents() {
  return Object.keys(AGENT_HOME).map(loadAgent).filter(Boolean);
}
