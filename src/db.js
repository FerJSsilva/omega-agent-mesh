// Índice SQLite do mesh — uma classe sobre sql.js (SQLite puro JS/WASM).
//
// Guarda duas coisas num único arquivo .db:
//
//   - workspace : os artefatos .md, indexados — `artifacts` + `frontmatter`.
//   - jobs      : o estado dos jobs (substitui o antigo jobs.json).
//
// O .db é descartável: os artefatos do workspace são regeneráveis dos .md
// (markdown é a fonte da verdade). A tabela `jobs` é a exceção — guarda
// histórico que não vem de markdown nenhum.
//
// ── Frontmatter arbitrário num schema fixo ──────────────────────────────────
// O schema GraphQL do mesh é INFERIDO de frontmatter livre — os campos não são
// conhecidos de antemão, então uma coluna por campo é impossível. Usamos o
// padrão EAV (entity-attribute-value): a tabela `frontmatter` tem uma linha por
// campo (artifact_id, key, value), e qualquer campo cabe sem alterar o schema.
//
// ── Round-trip de tipos ─────────────────────────────────────────────────────
// A inferência de schema (inferSchema, em workspace.js) precisa dos valores com
// o TIPO original — distinguir o número 42 do texto "42", uma lista de um
// escalar. Por isso `value` guarda JSON.stringify(value), não String(value):
// JSON preserva o tipo (42 → "42", "42" → "\"42\"", true → "true",
// ["a"] → "[\"a\"]"). Na leitura, JSON.parse devolve o valor tipado exato.
// É uma divergência deliberada do repo de referência, que usa String() (lossy).
import initSqlJs from 'sql.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const SCHEMA = `
  -- Índice do workspace --------------------------------------------------
  CREATE TABLE IF NOT EXISTS artifacts (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    path      TEXT UNIQUE NOT NULL,   -- relativo a workspace/, com barras /
    art_id    TEXT NOT NULL,          -- frontmatter \`id\`
    art_type  TEXT NOT NULL,          -- frontmatter \`type\`
    body      TEXT NOT NULL,          -- corpo markdown depois do frontmatter
    mtime     INTEGER NOT NULL,
    checksum  TEXT NOT NULL           -- md5 do conteúdo completo do arquivo
  );

  -- EAV: value guarda JSON.stringify do valor tipado original
  CREATE TABLE IF NOT EXISTS frontmatter (
    artifact_id  INTEGER NOT NULL,
    key          TEXT NOT NULL,
    value        TEXT,
    PRIMARY KEY (artifact_id, key),
    FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_artifacts_type       ON artifacts(art_type);
  CREATE INDEX IF NOT EXISTS idx_artifacts_artid      ON artifacts(art_id);
  CREATE INDEX IF NOT EXISTS idx_frontmatter_artifact ON frontmatter(artifact_id);
  CREATE INDEX IF NOT EXISTS idx_frontmatter_key      ON frontmatter(key);

  -- Estado dos jobs (substitui jobs.json) --------------------------------
  CREATE TABLE IF NOT EXISTS jobs (
    id          TEXT PRIMARY KEY,     -- UUID
    status      TEXT NOT NULL,        -- PENDENTE | PRONTO | ERRO
    caller      TEXT NOT NULL,
    callee      TEXT NOT NULL,
    started_at  TEXT NOT NULL,        -- ISO string
    ended_at    TEXT,
    duration_ms INTEGER,
    exit_code   INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_started ON jobs(started_at);
`;

export class Database {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
  }

  // sql.js é assíncrono pra inicializar. Carrega o arquivo .db existente, ou
  // cria um banco novo em memória. PRAGMA foreign_keys liga o ON DELETE CASCADE.
  async init() {
    const SQL = await initSqlJs();

    if (this.dbPath && existsSync(this.dbPath)) {
      this.db = new SQL.Database(readFileSync(this.dbPath));
    } else {
      this.db = new SQL.Database();
    }

    this.db.run('PRAGMA foreign_keys = ON');
    this.db.exec(SCHEMA);
    return this;
  }

  // sql.js vive 100% em memória — persistir é exportar e gravar o arquivo.
  save() {
    if (!this.dbPath) return;
    writeFileSync(this.dbPath, Buffer.from(this.db.export()));
  }

  close() {
    this.save();
    this.db.close();
  }

  // Roda um SELECT e devolve as linhas como objetos { coluna: valor }.
  #select(sql, params = []) {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }

  // ── Workspace: escrita ────────────────────────────────────────────────

  // Insere ou atualiza um artefato pelo `path`. Devolve o id interno da linha.
  upsertArtifact(path, artId, artType, body, mtime, checksum) {
    this.db.run(
      `INSERT INTO artifacts (path, art_id, art_type, body, mtime, checksum)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         art_id=excluded.art_id, art_type=excluded.art_type,
         body=excluded.body, mtime=excluded.mtime, checksum=excluded.checksum`,
      [path, artId, artType, body, mtime, checksum],
    );
    return this.#select('SELECT id FROM artifacts WHERE path = ?', [path])[0].id;
  }

  // Apaga todo o frontmatter de um artefato — chamado antes de re-inserir.
  clearFrontmatter(artifactId) {
    this.db.run('DELETE FROM frontmatter WHERE artifact_id = ?', [artifactId]);
  }

  // Insere um campo de frontmatter. `value` é JSON-encodado para preservar tipo.
  insertFrontmatter(artifactId, key, value) {
    this.db.run(
      'INSERT OR REPLACE INTO frontmatter (artifact_id, key, value) VALUES (?, ?, ?)',
      [artifactId, key, JSON.stringify(value ?? null)],
    );
  }

  // Apaga um artefato pelo path; o frontmatter some junto (ON DELETE CASCADE).
  deleteArtifactByPath(path) {
    this.db.run('DELETE FROM artifacts WHERE path = ?', [path]);
  }

  // ── Workspace: leitura ────────────────────────────────────────────────

  // Linha crua de um artefato pelo path — só o necessário pro diff de checksum.
  getArtifactRowByPath(path) {
    const rows = this.#select(
      'SELECT id, path, checksum FROM artifacts WHERE path = ?',
      [path],
    );
    return rows[0] ?? null;
  }

  // Todas as linhas cruas — usado pelo reindex pra diff incremental.
  getAllArtifactRows() {
    return this.#select('SELECT id, path, checksum FROM artifacts');
  }

  // Monta o objeto de artefato na forma EXATA que o antigo readArtifact produzia:
  // { ...frontmatter, body }. `id` e `type` voltam como campos do frontmatter.
  //
  // ORDEM IMPORTA: a ordem de inserção das linhas de frontmatter vira a ordem
  // dos campos no objeto, que por sua vez vira a ordem dos campos no SDL gerado
  // (generateSDL, em workspace.js). getFrontmatterFor ordena por rowid, e a
  // indexação insere os campos na ordem do YAML — então rowid == ordem do YAML.
  #hydrate(artifactRow) {
    const obj = {};
    for (const { key, value } of this.getFrontmatterFor(artifactRow.id)) {
      obj[key] = JSON.parse(value);
    }
    obj.body = artifactRow.body;
    return obj;
  }

  // Frontmatter de um artefato, NA ORDEM DE INSERÇÃO (rowid). Crítico: ver #hydrate.
  getFrontmatterFor(artifactId) {
    return this.#select(
      'SELECT key, value FROM frontmatter WHERE artifact_id = ? ORDER BY rowid',
      [artifactId],
    );
  }

  // Todos os artefatos hidratados.
  getAllArtifacts() {
    return this.#select(
      'SELECT id, body FROM artifacts ORDER BY path',
    ).map((row) => this.#hydrate(row));
  }

  // Artefatos de um `type`, hidratados.
  getArtifactsByType(type) {
    return this.#select(
      'SELECT id, body FROM artifacts WHERE art_type = ? ORDER BY path',
      [type],
    ).map((row) => this.#hydrate(row));
  }

  // Um artefato por (type, id de frontmatter), hidratado. Null se não existir.
  getArtifactByTypeAndId(type, artId) {
    const rows = this.#select(
      'SELECT id, body FROM artifacts WHERE art_type = ? AND art_id = ?',
      [type, artId],
    );
    return rows[0] ? this.#hydrate(rows[0]) : null;
  }

  // ── Jobs ──────────────────────────────────────────────────────────────

  // Linha crua (snake_case) → objeto Job (camelCase), igual ao que os resolvers
  // e o jobs.js sempre manipularam.
  #jobFromRow(row) {
    return {
      id: row.id,
      status: row.status,
      caller: row.caller,
      callee: row.callee,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      durationMs: row.duration_ms,
      exitCode: row.exit_code,
    };
  }

  insertJob(job) {
    this.db.run(
      `INSERT INTO jobs (id, status, caller, callee, started_at, ended_at, duration_ms, exit_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [job.id, job.status, job.caller, job.callee, job.startedAt,
       job.endedAt, job.durationMs, job.exitCode],
    );
  }

  updateJob(job) {
    this.db.run(
      `UPDATE jobs SET status=?, ended_at=?, duration_ms=?, exit_code=? WHERE id=?`,
      [job.status, job.endedAt, job.durationMs, job.exitCode, job.id],
    );
  }

  getJobById(id) {
    const rows = this.#select('SELECT * FROM jobs WHERE id = ?', [id]);
    return rows[0] ? this.#jobFromRow(rows[0]) : null;
  }

  getAllJobs() {
    return this.#select('SELECT * FROM jobs').map((row) => this.#jobFromRow(row));
  }

  countJobs() {
    return this.#select('SELECT COUNT(*) AS n FROM jobs')[0].n;
  }
}
