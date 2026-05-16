// Montagem do schema GraphQL final do mesh.
//
// O schema do mesh nasce de três fontes:
//
//   - base       — o esqueleto estável em src/schema.graphql
//   - workspace  — query types inferidos dos artefatos .md (workspace.js)
//   - handoffs   — mutations geradas das rotas declaradas (handoffs.js)
//
// buildSchema() junta os três SDLs num só typeDefs e mescla os resolver maps.
import { readFileSync } from 'node:fs';
import gql from 'graphql-tag';
import { config } from './config.js';
import { resolvers as staticResolvers } from './resolvers.js';
import { loadHandoffsModule } from './handoffs.js';
import { loadWorkspace } from './workspace.js';

export function buildSchema() {
  const baseSDL = readFileSync(config.paths.schema, 'utf8');
  const workspace = loadWorkspace();
  const handoffs = loadHandoffsModule();

  // Concatena os SDLs. Partes vazias são omitidas — `extend type` sem alvo,
  // ou um type sem campos, quebraria o parser.
  const parts = [baseSDL];
  if (workspace.sdl.trim()) parts.push(workspace.sdl);
  if (handoffs.sdl.trim()) parts.push(handoffs.sdl);
  const typeDefs = gql(parts.join('\n\n'));

  // Mescla os resolver maps. Query e Mutation precisam de merge campo a campo
  // (várias fontes contribuem); os demais types vão direto.
  const resolvers = {
    ...staticResolvers,
    Query: {
      ...staticResolvers.Query,
      ...workspace.resolvers.Query,
      handoffs: () =>
        handoffs.handoffs.map((h) => ({
          type: h.type,
          to: h.to,
          action: h.action,
          arg: h.arg,
          file: h.file,
        })),
    },
    Mutation: {
      ...staticResolvers.Mutation,
      ...handoffs.resolvers.Mutation,
    },
  };
  for (const [type, map] of Object.entries(workspace.resolvers)) {
    if (type !== 'Query') resolvers[type] = map;
  }
  for (const [type, map] of Object.entries(handoffs.resolvers)) {
    if (type !== 'Query' && type !== 'Mutation') resolvers[type] = map;
  }

  return { typeDefs, resolvers, workspace, handoffs };
}
