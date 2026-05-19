// Workspace: schema GraphQL de leitura inferido dos artefatos, servido do índice.
//
// O workspace é uma pasta compartilhada onde os agents salvam artefatos .md
// com frontmatter YAML. Cada arquivo precisa de `id` e `type`. Os .md são a
// fonte da verdade; o índice SQLite (db.js) é um espelho descartável deles.
//
// No boot, reindexWorkspace varre os .md para dentro do índice. Daí em diante:
//
//   1. lê os artefatos do índice SQLite                      (loadFiles)
//   2. infere, por `type`, os campos e seus tipos GraphQL    (inferSchema)
//   3. deduz relações reversas a partir das foreign keys     (inferReverseRelations)
//   4. gera o SDL dos query types                           (generateSDL)
//   5. gera os resolvers, que consultam o índice a cada query (buildResolvers)
//
// O watcher (watcher.js) mantém o índice em dia: add/change/unlink de .md viram
// upsert/delete no banco. A inferência (passos 2-4) é idêntica ao que era —
// opera sobre a mesma lista de artefatos, só que vinda do índice em vez do disco.
//
// Regras de inferência:
//   - Escalares detectados automaticamente (Int/Float/String/Boolean).
//   - Um campo cujo nome bate com algum `type` vira foreign key.
//   - Relação reversa autogerada: se Chapter tem `book`, então Book ganha
//     `chapters: [Chapter!]!` de graça.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import matter from 'gray-matter';
import { config } from './config.js';

const WORKSPACE_DIR = config.paths.workspace;

// ── Indexação: .md do disco → índice SQLite ──────────────────────────────────

// Caminho de todos os .md sob workspace/, recursivo. Pasta ausente → lista vazia.
function walkRecursive(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walkRecursive(full));
    } else if (entry.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

// Path relativo a workspace/, sempre com barras / — é a chave do artefato no índice.
function relPath(absPath) {
  return relative(WORKSPACE_DIR, absPath).replace(/\\/g, '/');
}

function checksum(content) {
  return createHash('md5').update(content).digest('hex');
}

// Indexa um único .md no banco. Valida `id`/`type`; arquivo malformado é PULADO
// com aviso (não lança) — um throw aqui derrubaria o callback do watcher.
// Insere os campos de frontmatter NA ORDEM DO YAML (Object.entries) — essa ordem
// vira a ordem dos campos no SDL gerado; ver db.js #hydrate. Devolve o `type`
// indexado, ou null se o arquivo foi pulado.
export function indexArtifact(db, absPath) {
  const raw = readFileSync(absPath, 'utf8');
  const { data, content } = matter(raw);
  const path = relPath(absPath);

  if (!data.id || !data.type) {
    console.warn(`[workspace] ${path}: sem 'id'/'type' no frontmatter — pulando`);
    return null;
  }

  const mtime = statSync(absPath).mtimeMs;
  const artifactId = db.upsertArtifact(
    path, data.id, data.type, content, mtime, checksum(raw),
  );
  db.clearFrontmatter(artifactId);
  for (const [key, value] of Object.entries(data)) {
    db.insertFrontmatter(artifactId, key, value);
  }
  return data.type;
}

// Remove um artefato do índice (o .md foi apagado).
export function removeArtifact(db, absPath) {
  db.deleteArtifactByPath(relPath(absPath));
}

// Reindexação completa: varre workspace/, reparseando só os .md cujo checksum
// mudou (incremental), e remove do índice os que sumiram do disco. Chamado no
// boot. Persiste o banco ao final.
export function reindexWorkspace(db) {
  const onDisk = walkRecursive(WORKSPACE_DIR);
  const indexed = new Map(db.getAllArtifactRows().map((r) => [r.path, r]));

  let added = 0;
  let skipped = 0;
  for (const absPath of onDisk) {
    const path = relPath(absPath);
    const row = indexed.get(path);
    indexed.delete(path);
    if (row && row.checksum === checksum(readFileSync(absPath, 'utf8'))) {
      skipped += 1;
      continue;
    }
    if (indexArtifact(db, absPath) !== null) added += 1;
  }
  // O que sobrou em `indexed` não existe mais no disco.
  const removed = indexed.size;
  for (const [path] of indexed) db.deleteArtifactByPath(path);

  db.save();
  return { added, skipped, removed };
}

// ── Inferência de tipos ──────────────────────────────────────────────────────

function detectScalarType(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isInteger(value) ? 'Int' : 'Float';
  if (typeof value === 'boolean') return 'Boolean';
  return 'String'; // string, Date e demais casos
}

// Concilia dois tipos detectados para o mesmo campo. Promove quando seguro,
// lança erro quando os tipos são genuinamente incompatíveis.
function reconcileType(a, b, fieldName, idA, idB) {
  if (a === b) return a;
  if (a === null) return b;
  if (b === null) return a;
  const set = new Set([a, b]);
  if (set.has('Float') && (set.has('Int') || set.has('String'))) {
    console.warn(`[workspace] campo "${fieldName}" diverge entre ${idA} (${a}) e ${idB} (${b}) — promovendo para Float`);
    return 'Float';
  }
  if (set.has('Int') && set.has('String')) {
    console.warn(`[workspace] campo "${fieldName}" diverge entre ${idA} (${a}) e ${idB} (${b}) — promovendo para String`);
    return 'String';
  }
  throw new Error(`[workspace] campo "${fieldName}" com tipos incompatíveis: ${a} (${idA}) vs ${b} (${idB})`);
}

// Para cada `type`, mapeia seus campos: tipo escalar, se é lista, se é FK.
function inferSchema(files) {
  const typesSet = new Set(files.map((f) => f.frontmatter.type));
  const typeFields = new Map();

  for (const f of files) {
    const { type } = f.frontmatter;
    if (!typeFields.has(type)) typeFields.set(type, new Map());
    const fields = typeFields.get(type);

    for (const [key, value] of Object.entries(f.frontmatter)) {
      if (!fields.has(key)) {
        fields.set(key, { occurrences: 0, scalarType: null, isList: false, fkType: null, sources: [] });
      }
      const meta = fields.get(key);
      meta.occurrences += 1;
      meta.sources.push(f.frontmatter.id);

      const isArray = Array.isArray(value);
      const elem = isArray ? (value[0] ?? null) : value;
      if (isArray) meta.isList = true;

      if (typesSet.has(key) && typeof elem === 'string') {
        // Campo cujo nome é um `type` conhecido → foreign key.
        if (meta.fkType && meta.fkType !== key) {
          throw new Error(`[workspace] campo "${key}" em ${type} aparece como FK para tipos diferentes`);
        }
        meta.fkType = key;
      } else {
        const detected = detectScalarType(elem);
        const prevSource = meta.sources[meta.sources.length - 2] ?? meta.sources[0];
        meta.scalarType = reconcileType(meta.scalarType, detected, key, prevSource, f.frontmatter.id);
      }
    }
  }
  return typeFields;
}

// Relação reversa: se um type tem FK para outro, o alvo ganha a lista inversa.
// Cada entrada guarda o type de origem e o nome do campo FK que o liga.
function inferReverseRelations(typeFields) {
  const reverse = new Map();
  for (const [sourceType, fields] of typeFields) {
    for (const [fieldName, meta] of fields) {
      if (!meta.fkType) continue;
      if (!reverse.has(meta.fkType)) reverse.set(meta.fkType, []);
      reverse.get(meta.fkType).push({ sourceType, fieldName });
    }
  }
  return reverse;
}

// ── Geração de SDL ───────────────────────────────────────────────────────────

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Monta o tipo GraphQL de um campo. `!` (non-null) só quando o campo aparece
// em todos os artefatos do type.
function fieldGqlType(meta, totalForType) {
  const inner = meta.fkType ? capitalize(meta.fkType) : meta.scalarType ?? 'String';
  const required = meta.occurrences === totalForType;
  if (meta.isList) return required ? `[${inner}!]!` : `[${inner}!]`;
  return required ? `${inner}!` : inner;
}

function generateSDL(typeFields, files, reverseRelations) {
  const counts = new Map();
  for (const f of files) {
    counts.set(f.frontmatter.type, (counts.get(f.frontmatter.type) ?? 0) + 1);
  }

  const lines = [];
  for (const [type, fields] of typeFields) {
    lines.push(`type ${capitalize(type)} {`);
    for (const [name, meta] of fields) {
      lines.push(`  ${name}: ${fieldGqlType(meta, counts.get(type))}`);
    }
    lines.push('  body: String!');

    for (const { sourceType } of reverseRelations.get(type) ?? []) {
      const reverseField = `${sourceType}s`;
      if (fields.has(reverseField)) {
        console.warn(`[workspace] type "${type}" já tem campo "${reverseField}" — pulando relação reversa`);
        continue;
      }
      lines.push(`  ${reverseField}: [${capitalize(sourceType)}!]!`);
    }
    lines.push('}', '');
  }

  lines.push('extend type Query {');
  for (const type of typeFields.keys()) {
    lines.push(`  ${type}(id: ID!): ${capitalize(type)}`);
    lines.push(`  ${type}s: [${capitalize(type)}!]!`);
  }
  lines.push('}');

  return lines.join('\n');
}

// ── Geração de resolvers ─────────────────────────────────────────────────────

// Resolvers consultam o índice SQLite a cada query. O índice é mantido em dia
// pelo watcher — o workspace continua sempre fresh, sem releitura de disco.
function buildResolvers(typeFields, reverseRelations, db) {
  const Query = {};
  const typeResolvers = {};

  for (const [type, fields] of typeFields) {
    Query[type] = (_parent, { id }) => db.getArtifactByTypeAndId(type, id);

    Query[`${type}s`] = () => db.getArtifactsByType(type);

    const forType = {};

    // Resolver de foreign key: segue o id referenciado.
    for (const [name, meta] of fields) {
      if (!meta.fkType) continue;
      forType[name] = (parent) => {
        const refId = parent[name];
        if (!refId) return null;
        return db.getArtifactByTypeAndId(meta.fkType, refId);
      };
    }

    // Resolver de relação reversa: lista quem aponta de volta para este id.
    for (const { sourceType, fieldName } of reverseRelations.get(type) ?? []) {
      const reverseField = `${sourceType}s`;
      if (fields.has(reverseField)) continue;
      forType[reverseField] = (parent) =>
        db.getArtifactsByType(sourceType).filter((o) => o[fieldName] === parent.id);
    }

    if (Object.keys(forType).length > 0) {
      typeResolvers[capitalize(type)] = forType;
    }
  }

  return { Query, ...typeResolvers };
}

// ── Carga do workspace ───────────────────────────────────────────────────────

// Lê todos os artefatos do índice na forma { frontmatter, body } — a mesma
// estrutura que a inferência sempre consumiu. Valida os obrigatórios
// (defensivo: só artefatos válidos chegam a ser indexados, então é inalcançável).
function loadFiles(db) {
  const files = [];
  for (const artifact of db.getAllArtifacts()) {
    const { body, ...frontmatter } = artifact;
    if (!frontmatter.id) throw new Error(`workspace: artefato sem 'id' no frontmatter`);
    if (!frontmatter.type) throw new Error(`workspace: artefato sem 'type' no frontmatter`);
    files.push({ frontmatter, body });
  }
  return files;
}

// Carrega tudo: artefatos do índice, SDL inferido e resolvers.
export function loadWorkspace(db) {
  const files = loadFiles(db);
  const typeFields = inferSchema(files);
  const reverseRelations = inferReverseRelations(typeFields);
  return {
    files,
    sdl: files.length > 0 ? generateSDL(typeFields, files, reverseRelations) : '',
    resolvers: buildResolvers(typeFields, reverseRelations, db),
  };
}
