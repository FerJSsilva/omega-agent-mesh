// Resolvers estáticos do mesh — os campos do schema base (schema.graphql).
//
// Os resolvers dinâmicos (mutations de handoff, query types do workspace) são
// gerados em runtime e mesclados a estes pelo schema builder (ver schema.js).
import { listAgents, loadAgent } from './agents.js';
import { listSkills } from './skills.js';
import { getJob, listJobs } from './jobs.js';

export const resolvers = {
  Query: {
    ping: () => 'pong',
    agents: () => listAgents(),
    agent: (_parent, { name }) => loadAgent(name),
    skills: () => listSkills(),
    job: (_parent, { id }) => getJob(id),
    jobs: () => listJobs().sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
  },

  Agent: {
    delegatesTo: (agent) => agent._delegatesToNames.map(loadAgent).filter(Boolean),
  },

  Mutation: {
    _placeholder: () => true,
  },
};
