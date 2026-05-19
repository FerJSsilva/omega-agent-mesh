import { Database } from '../src/db.js';
import { config } from '../src/config.js';
const db = await new Database(config.paths.dbFile).init();
console.log('=== artefatos indexados no mesh-index.db ===');
for (const a of db.getAllArtifacts()) {
  console.log(`  ${String(a.type).padEnd(12)} id=${a.id}`);
}
console.log('\n=== jobs ===');
for (const j of db.getAllJobs()) {
  console.log(`  ${String(j.status).padEnd(9)} ${j.caller} -> ${j.callee}`);
}
db.close();
