// Bootstrap do omega-agent-mesh.
//
// Sequência de boot:
//   1. sincroniza skills para os homes
//   2. monta o schema (base + workspace + handoffs)
//   3. sobe o servidor Apollo
//   4. inicia o watcher do workspace
import { ApolloServer } from '@apollo/server';
import { startStandaloneServer } from '@apollo/server/standalone';
import { config } from './config.js';
import { syncSkills } from './skills.js';
import { AGENT_HOME } from './agents.js';
import { buildSchema } from './schema.js';
import { startWatcher } from './watcher.js';

// 1. Replica as skills do mesh para o .claude/skills/ de cada home.
syncSkills();

// 2. Monta o schema final e reporta o que foi descoberto.
const { typeDefs, resolvers, workspace, handoffs } = buildSchema();

console.log(`[workspace] ${workspace.files.length} artefato(s)`);

console.log(`[handoffs] ${handoffs.handoffs.length} rota(s):`);
for (const h of handoffs.handoffs) {
  const mode = h.trigger ? `trigger: ${h.trigger}` : 'manual';
  console.log(`  ${h.action}(${h.arg}) → ${h.to} (${mode})`);
}

const agents = Object.keys(AGENT_HOME);
console.log(`[agents] ${agents.length} agent(s):`);
for (const a of agents) console.log(`  → ${a}`);

// 3. Sobe o servidor GraphQL (Apollo Sandbox abre direto na URL).
const server = new ApolloServer({ typeDefs, resolvers, introspection: true });
const { url } = await startStandaloneServer(server, { listen: { port: config.port } });

// 4. Watcher só inicia depois do servidor — e só faz algo se houver triggers.
startWatcher();

console.log(`\nmesh on ${url}\n`);
