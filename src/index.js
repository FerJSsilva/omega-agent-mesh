// Bootstrap do omega-agent-mesh.
//
// Sequência de boot:
//   1. sincroniza skills para os homes
//   2. abre o índice SQLite (workspace + jobs)
//   3. reindexa o workspace: varre os .md para dentro do índice
//   4. liga o estado dos jobs ao índice (hidrata cache, migra jobs.json legado)
//   5. monta o schema (base + workspace + handoffs) — a inferência lê do índice
//   6. sobe o servidor Apollo
//   7. inicia o watcher do workspace (indexação + triggers)
import { ApolloServer } from '@apollo/server';
import { startStandaloneServer } from '@apollo/server/standalone';
import { config } from './config.js';
import { syncSkills } from './skills.js';
import { AGENT_HOME } from './agents.js';
import { Database } from './db.js';
import { setJobsDb } from './jobs.js';
import { reindexWorkspace } from './workspace.js';
import { buildSchema } from './schema.js';
import { startWatcher } from './watcher.js';

// 1. Replica as skills do mesh para o .claude/skills/ de cada home.
syncSkills();

// 2. Abre o índice SQLite. sql.js é assíncrono pra inicializar.
const db = await new Database(config.paths.dbFile).init();

// 3. Reindexa o workspace — os .md são a fonte da verdade, o índice os espelha.
const reindex = reindexWorkspace(db);
console.log(
  `[index] workspace: ${reindex.added} indexado(s), ` +
    `${reindex.skipped} em cache, ${reindex.removed} removido(s)`,
);

// 4. Liga jobs.js ao índice antes do servidor subir — a primeira mutation
//    depende disto. Hidrata o cache e migra um jobs.json legado, se houver.
setJobsDb(db);

// 5. Monta o schema final (a inferência do workspace lê do índice) e reporta.
const { typeDefs, resolvers, workspace, handoffs } = buildSchema(db);

console.log(`[workspace] ${workspace.files.length} artefato(s)`);

console.log(`[handoffs] ${handoffs.handoffs.length} rota(s):`);
for (const h of handoffs.handoffs) {
  const mode = h.trigger ? `trigger: ${h.trigger}` : 'manual';
  console.log(`  ${h.action}(${h.arg}) → ${h.to} (${mode})`);
}

const agents = Object.keys(AGENT_HOME);
console.log(`[agents] ${agents.length} agent(s):`);
for (const a of agents) console.log(`  → ${a}`);

// 6. Sobe o servidor GraphQL (Apollo Sandbox abre direto na URL).
const server = new ApolloServer({ typeDefs, resolvers, introspection: true });
const { url } = await startStandaloneServer(server, { listen: { port: config.port } });

// 7. Watcher só inicia depois do servidor — mantém o índice em dia e dispara triggers.
startWatcher(db);

// Persiste o índice no encerramento (defensivo — toda escrita já faz save()).
process.on('SIGINT', () => {
  db.close();
  process.exit(0);
});

console.log(`\nmesh on ${url}\n`);
