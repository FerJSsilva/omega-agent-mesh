// Workspace: schema GraphQL de leitura inferido dos artefatos do disco.
//
// O workspace é uma pasta compartilhada onde os agents salvam artefatos .md
// com frontmatter YAML. Cada arquivo precisa de `id` e `type`. No boot, o mesh:
//
//   1. lê todos os workspace/**/*.md                        (loadFiles)
//   2. infere, por `type`, os campos e seus tipos GraphQL    (inferSchema)
//   3. deduz relações reversas a partir das foreign keys     (inferReverseRelations)
//   4. gera o SDL dos query types                           (generateSDL)
//   5. gera os resolvers, que releem o disco a cada query    (buildResolvers)
//
// Regras de inferência:
//   - Escalares detectados automaticamente (Int/Float/String/Boolean).
//   - Um campo cujo nome bate com algum `type` vira foreign key.
//   - Relação reversa autogerada: se Chapter tem `book`, então Book ganha
//     `chapters: [Chapter!]!` de graça.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import { config } from './config.js';

const WORKSPACE_DIR = config.paths.workspace;

// ── Leitura do disco ─────────────────────────────────────────────────────────

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

// Lê um artefato do disco no momento da query — frontmatter + corpo.
function readArtifact(path) {
  const { data, content } = matter(readFileSync(path, 'utf8'));
  return { ...data, body: content };
}

// Carrega todos os artefatos do workspace, validando os campos obrigatórios.
function loadFiles() {
  const files = [];
  for (const path of walkRecursive(WORKSPACE_DIR)) {
    const { data, content } = matter(readFileSync(path, 'utf8'));
    if (!data.id) throw new Error(`workspace: ${path} sem 'id' no frontmatter`);
    if (!data.type) throw new Error(`workspace: ${path} sem 'type' no frontmatter`);
    files.push({ path, frontmatter: data, body: content });
  }
  return files;
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

// Resolvers releem o disco a cada query — workspace é sempre fresh, sem cache.
function buildResolvers(typeFields, reverseRelations) {
  const Query = {};
  const typeResolvers = {};

  for (const [type, fields] of typeFields) {
    Query[type] = (_parent, { id }) =>
      walkRecursive(WORKSPACE_DIR)
        .map(readArtifact)
        .find((o) => o.id === id && o.type === type) ?? null;

    Query[`${type}s`] = () =>
      walkRecursive(WORKSPACE_DIR)
        .map(readArtifact)
        .filter((o) => o.type === type);

    const forType = {};

    // Resolver de foreign key: segue o id referenciado.
    for (const [name, meta] of fields) {
      if (!meta.fkType) continue;
      forType[name] = (parent) => {
        const refId = parent[name];
        if (!refId) return null;
        return (
          walkRecursive(WORKSPACE_DIR)
            .map(readArtifact)
            .find((o) => o.id === refId && o.type === meta.fkType) ?? null
        );
      };
    }

    // Resolver de relação reversa: lista quem aponta de volta para este id.
    for (const { sourceType, fieldName } of reverseRelations.get(type) ?? []) {
      const reverseField = `${sourceType}s`;
      if (fields.has(reverseField)) continue;
      forType[reverseField] = (parent) =>
        walkRecursive(WORKSPACE_DIR)
          .map(readArtifact)
          .filter((o) => o.type === sourceType && o[fieldName] === parent.id);
    }

    if (Object.keys(forType).length > 0) {
      typeResolvers[capitalize(type)] = forType;
    }
  }

  return { Query, ...typeResolvers };
}

// Carrega tudo: arquivos, SDL inferido e resolvers.
export function loadWorkspace() {
  const files = loadFiles();
  const typeFields = inferSchema(files);
  const reverseRelations = inferReverseRelations(typeFields);
  return {
    files,
    sdl: files.length > 0 ? generateSDL(typeFields, files, reverseRelations) : '',
    resolvers: buildResolvers(typeFields, reverseRelations),
  };
}
