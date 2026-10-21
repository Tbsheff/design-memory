import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

export type Kind = "screenshot" | "website" | "shadcn" | "x";
export type Media = { sha256: string; path: string; original_filename: string; thumbnail?: string };
export type XPost = {
  author: string; name: string; text: string; created_at: string; fetched_at: string;
  quoted?: { author: string; text: string };
};
export type Reference = {
  id: string; kind: Kind; title: string;
  source: { type: "file" | "url"; value: string; key: string };
  media: Media[]; notes: { text: string; added_at: string }[];
  tags: string[]; projects: string[]; created_at: string; updated_at?: string;
  post?: XPost;
};
export type Observation = { id: string; ref_id: string; aspect: string; detail: string; evidence: string; effect: string; certainty: "observed" | "inferred"; created_at: string };
export type Feedback = { id: string; ref_id: string; aspect: string; vote: "like" | "dislike" | "mixed"; reason: string; quote: string; project: string | null; created_at: string };
export type Preference = { id: string; kind: "prefer" | "avoid"; rule: string; scope: "global" | "project"; project: string | null; feedback_ids: string[]; statement: string; created_at: string };
export type Table = "refs" | "observations" | "feedback" | "preferences";
export type RecordByTable = { refs: Reference; observations: Observation; feedback: Feedback; preferences: Preference };
export const now = () => new Date().toISOString();
export const itemId = (prefix: string) => `${prefix}_${randomBytes(6).toString("hex")}`;
export const encode = (obj: unknown) => JSON.stringify(obj);
export const expand = (name: string) => resolve(name === "~" ? homedir() : name.startsWith("~/") ? join(homedir(), name.slice(2)) : name);
export const rootPath = (override?: string) => expand(override ?? process.env.DESIGN_MEMORY_HOME ?? "~/.design-memory");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS refs (
 id TEXT PRIMARY KEY, source_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
 created_at TEXT NOT NULL, search_text TEXT NOT NULL, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS refs_date_idx ON refs(created_at DESC);
CREATE INDEX IF NOT EXISTS refs_kind_date_idx ON refs(kind, created_at DESC);
CREATE TABLE IF NOT EXISTS observations (id TEXT PRIMARY KEY, ref_id TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS observations_ref_idx ON observations(ref_id);
CREATE TABLE IF NOT EXISTS feedback (id TEXT PRIMARY KEY, ref_id TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS feedback_ref_idx ON feedback(ref_id);
CREATE TABLE IF NOT EXISTS preferences (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, scope TEXT NOT NULL, project TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS prefs_scope_idx ON preferences(scope, project);
CREATE TABLE IF NOT EXISTS retired (preference_id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ref_projects (project TEXT NOT NULL, ref_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (project, ref_id)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS ref_projects_ref_idx ON ref_projects(ref_id);
CREATE INDEX IF NOT EXISTS ref_projects_date_idx ON ref_projects(project, created_at DESC, ref_id DESC);
`;

function backfillRefProjects(db: Database): void {
  if (db.query("SELECT 1 FROM meta WHERE key='ref_projects_indexed'").get()) return;
  inTransaction(db, () => {
    db.run("INSERT OR IGNORE INTO ref_projects(project,ref_id,created_at) SELECT value,r.id,r.created_at FROM refs r, json_each(r.data,'$.projects')");
    db.run("INSERT OR REPLACE INTO meta(key,value) VALUES('ref_projects_indexed','yes')");
  });
}

export function store(root: string): Database {
  mkdirSync(root, { recursive: true });
  const db = new Database(join(root, "library.sqlite3"));
  try {
    db.run("PRAGMA cache_size=-1024");
    db.run("PRAGMA temp_store=FILE");
    db.run("PRAGMA mmap_size=0");
    db.run("PRAGMA busy_timeout=5000");
    db.run("PRAGMA journal_mode=WAL");
    db.run("PRAGMA synchronous=NORMAL");
    db.run(SCHEMA);
    migrateLegacy(root, db);
    backfillRefProjects(db);
    return db;
  } catch (error) {
    db.close(true);
    throw error;
  }
}

export function inTransaction<T>(db: Database, work: () => T): T {
  db.run("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.run("COMMIT");
    return result;
  } catch (error) {
    db.run("ROLLBACK");
    throw error;
  }
}

export function saveRecord<K extends Table>(db: Database, category: K, obj: RecordByTable[K]): void {
  const payload = encode(obj);
  if (category === "refs") {
    const r = obj as Reference;
    db.query(`INSERT INTO refs(id,source_key,kind,created_at,search_text,data) VALUES (?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET source_key=excluded.source_key,kind=excluded.kind,created_at=excluded.created_at,data=excluded.data`)
      .run(r.id, r.source.key, r.kind, r.created_at, "", payload);
    db.query("DELETE FROM ref_projects WHERE ref_id=?").run(r.id);
    const addProject = db.query("INSERT OR IGNORE INTO ref_projects(project,ref_id,created_at) VALUES (?,?,?)");
    for (const project of r.projects) addProject.run(project, r.id, r.created_at);
  } else if (category === "observations" || category === "feedback") {
    const r = obj as Observation | Feedback;
    db.query(`INSERT INTO ${category}(id,ref_id,created_at,data) VALUES (?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET ref_id=excluded.ref_id,created_at=excluded.created_at,data=excluded.data`)
      .run(r.id, r.ref_id, r.created_at, payload);
  } else {
    const r = obj as Preference;
    db.query(`INSERT INTO preferences(id,created_at,scope,project,data) VALUES (?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET created_at=excluded.created_at,scope=excluded.scope,project=excluded.project,data=excluded.data`)
      .run(r.id, r.created_at, r.scope, r.project, payload);
  }
}

export function* records<K extends Table>(db: Database, category: K, refId?: string): Generator<RecordByTable[K]> {
  const sql = (refId && (category === "observations" || category === "feedback"))
    ? `SELECT data FROM ${category} WHERE ref_id=? ORDER BY created_at`
    : `SELECT data FROM ${category} ORDER BY created_at`;
  const statement = db.query(sql);
  const rows = refId && (category === "observations" || category === "feedback") ? statement.iterate(refId) : statement.iterate();
  for (const row of rows as Iterable<{ data: string }>) yield JSON.parse(row.data);
}

export function getItem<K extends Table>(db: Database, table: K, id: string): RecordByTable[K] {
  if (!/^[a-z]+_[a-f0-9]{12}$/.test(id)) throw new Error(`Invalid record ID: ${id}`);
  const row = db.query(`SELECT data FROM ${table} WHERE id=?`).get(id) as { data: string } | null;
  if (!row) throw new Error(`Record not found: ${id}`);
  return JSON.parse(row.data);
}

function migrateLegacy(root: string, db: Database): void {
  if (db.query("SELECT 1 FROM meta WHERE key='legacy_imported'").get()) return;
  inTransaction(db, () => {
    for (const category of ["refs", "observations", "feedback", "preferences"] as const) {
      const folder = join(root, category);
      if (!existsSync(folder)) continue;
      for (const filename of readdirSync(folder)) {
        if (!filename.endsWith(".json")) continue;
        const obj = JSON.parse(readFileSync(join(folder, filename), "utf8"));
        saveRecord(db, category, obj);
      }
    }
    const retiredDir = join(root, "retired");
    if (existsSync(retiredDir)) {
      for (const filename of readdirSync(retiredDir)) {
        if (!filename.endsWith(".json")) continue;
        const r = JSON.parse(readFileSync(join(retiredDir, filename), "utf8"));
        db.query("INSERT OR REPLACE INTO retired(preference_id,data) VALUES(?,?)").run(r.preference_id, encode(r));
      }
    }
        if (existsSync(join(root, "refs"))) {
      for (const row of db.query("SELECT id FROM refs").iterate() as Iterable<{id:string}>) refreshSearch(db, row.id);
    }
    db.query("INSERT OR REPLACE INTO meta(key,value) VALUES('legacy_imported','yes')").run();
  });
}

function hasFts(db: Database): boolean {
  return !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='refs_fts'").get();
}

export function ensureFts(db: Database): boolean {
  if (hasFts(db)) return true;
  try {
    inTransaction(db, () => {
      db.run("CREATE VIRTUAL TABLE refs_fts USING fts5(body, tokenize='unicode61')");
      db.run("INSERT INTO refs_fts(rowid,body) SELECT rowid,search_text FROM refs");
    });
    return true;
  } catch {
    return false;
  }
}

export function refreshSearch(db: Database, refId: string): void {
  const row = db.query("SELECT rowid,data FROM refs WHERE id=?").get(refId) as {rowid:number;data:string} | null;
  if (!row) return;
  const ref = JSON.parse(row.data) as Reference;
  const parts = [ref.title, ref.source.value, ref.kind, ...ref.tags, ...ref.projects, ...ref.notes.map(n => n.text)];
  if (ref.post) parts.push(ref.post.name, `@${ref.post.author}`, ref.post.text, ref.post.quoted?.text ?? "");
  for (const cat of ["observations", "feedback"] as const) {
    for (const item of records(db, cat, refId)) {
      const data = item as unknown as Record<string, string>;
      for (const field of ["aspect", "detail", "effect", "reason", "quote"]) if (data[field]) parts.push(data[field]);
    }
  }
  const body = parts.join(" ").toLowerCase();
  db.query("UPDATE refs SET search_text=? WHERE rowid=?").run(body, row.rowid);
  if (hasFts(db)) {
    db.query("DELETE FROM refs_fts WHERE rowid=?").run(row.rowid);
    db.query("INSERT INTO refs_fts(rowid,body) VALUES (?,?)").run(row.rowid, body);
  }
}
