// Domínio de Skills do mesh.
//
// O mesh mantém skills em `skills/<name>/SKILL.md` e faz duas coisas com elas:
//
//   1. listSkills() — expõe o catálogo via `Query.skills`.
//   2. syncSkills() — replica cada skill para `.claude/skills/` de cada home,
//      para que os agents a recebam no contexto quando forem spawnados.
//
// A sincronização é versionada por semver no frontmatter (`version: "1.0.0"`):
// instala se faltar no home, atualiza se a versão do home for menor, preserva
// (com aviso) se o home tiver uma versão maior.
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import { config } from './config.js';

const SKILLS_DIR = config.paths.skills;

// Lista as skills source do mesh: pastas com um SKILL.md dentro.
function listSourceSkills() {
  if (!existsSync(SKILLS_DIR)) return [];
  return readdirSync(SKILLS_DIR)
    .map((name) => ({ name, path: join(SKILLS_DIR, name, 'SKILL.md') }))
    .filter((s) => {
      try {
        return statSync(s.path).isFile();
      } catch {
        return false;
      }
    });
}

// Lê o frontmatter de um SKILL.md. Retorna null se não der pra ler.
function readSkill(path) {
  try {
    const { data } = matter(readFileSync(path, 'utf8'));
    return data;
  } catch {
    return null;
  }
}

// ── Catálogo ────────────────────────────────────────────────────────────────

// Skills registradas no mesh, para `Query.skills`.
export function listSkills() {
  return listSourceSkills().map(({ name, path }) => {
    const data = readSkill(path) ?? {};
    return {
      name: data.name ?? name,
      description: data.description ?? '',
      version: data.version != null ? String(data.version) : null,
    };
  });
}

// ── Sincronização para os homes ──────────────────────────────────────────────

// Compara duas strings semver. Retorna -1, 0 ou 1.
// Tolerante a "1", "1.0" e "1.0.0" — completa com zeros.
function compareSemver(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// Sincroniza uma skill para um home. Retorna um objeto de resultado para log.
function syncOne(skill, home) {
  const destDir = join(home, '.claude', 'skills', skill.name);
  const destPath = join(destDir, 'SKILL.md');

  const sourceVersion = readSkill(skill.path)?.version;
  if (sourceVersion == null) {
    return { status: 'skip', reason: 'source sem version' };
  }

  if (!existsSync(destPath)) {
    mkdirSync(destDir, { recursive: true });
    writeFileSync(destPath, readFileSync(skill.path));
    return { status: 'installed', version: sourceVersion };
  }

  const destVersion = readSkill(destPath)?.version;
  if (destVersion == null) {
    // Destino sem version → trata como desatualizado.
    writeFileSync(destPath, readFileSync(skill.path));
    return { status: 'updated', from: '?', to: sourceVersion };
  }

  const cmp = compareSemver(String(destVersion), String(sourceVersion));
  if (cmp < 0) {
    writeFileSync(destPath, readFileSync(skill.path));
    return { status: 'updated', from: destVersion, to: sourceVersion };
  }
  if (cmp > 0) {
    return { status: 'warn', destVersion, sourceVersion };
  }
  return { status: 'ok', version: sourceVersion };
}

// Replica todas as skills do mesh para todos os homes. Chamado no boot.
export function syncSkills() {
  if (!config.syncSkills) {
    console.log('[skills] sync desabilitado via MESH_SYNC_SKILLS=false');
    return;
  }

  const skills = listSourceSkills();
  if (skills.length === 0) {
    console.log('[skills] nenhuma skill source');
    return;
  }

  for (const skill of skills) {
    const version = readSkill(skill.path)?.version ?? '?';
    console.log(`[skills] ${skill.name} v${version}`);
    for (const home of config.homes) {
      const homeName = home.split(/[\\/]/).pop().padEnd(24);
      const r = syncOne(skill, home);
      switch (r.status) {
        case 'installed':
          console.log(`  ${homeName} → installed (v${r.version})`);
          break;
        case 'updated':
          console.log(`  ${homeName} → updated (v${r.from} → v${r.to})`);
          break;
        case 'ok':
          console.log(`  ${homeName} → ok (v${r.version})`);
          break;
        case 'warn':
          console.log(
            `  ${homeName} → warn: home v${r.destVersion} > source v${r.sourceVersion} (preservado)`,
          );
          break;
        case 'skip':
          console.log(`  ${homeName} → skip (${r.reason})`);
          break;
      }
    }
  }
}
