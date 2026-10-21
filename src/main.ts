#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  cleanTags,
  urlDetails,
  addMedia,
} from "./media.ts";
import {
  encode, ensureFts, getItem, inTransaction, itemId, now, records, refreshSearch,
  rootPath, saveRecord, store, expand,
} from "./db.ts";
import type { Kind, Reference, Preference, Feedback, Observation, Media, XPost } from "./db.ts";
import { generateGallery } from "./gallery.ts";
import { ingestXPost } from "./x-post.ts";

const USAGE = `Design Memory — Bun CLI (no server unless you run open or install the service)

Usage: taste [--root DIR] COMMAND [arguments]

  add SOURCE [SOURCE ...] [--note TEXT] [--image IMAGE] [--tag TAG] [--project NAME] [--fetch yes|no]
  list [--kind KIND] [--tag TAG] [--project NAME] [--limit N]
  search QUERY [--kind KIND] [--tag TAG] [--project NAME] [--limit N]
  show ref_ID
  observe ref_ID --aspect TEXT --detail TEXT --evidence TEXT [--certainty observed|inferred]
  feedback ref_ID --vote like|dislike|mixed --aspect TEXT [--quote TEXT] [--reason TEXT]
  candidates [--min N]
  prefer --kind prefer|avoid --rule TEXT (--statement QUOTE | --from-feedback fb_ID)
         [--scope global|project --project NAME]
  retire pref_ID --reason TEXT
  profile [--project NAME] [--output FILE]
  brief [--project NAME] [--topic TEXT] [--ref ref_ID] [--limit N] [--output FILE]
  gallery [--output FILE]   Export a read-only HTML gallery
  open [--port N] [--browser yes|no]   Open an editable local workspace (reuses the service if it runs)
  service install|uninstall|restart|status [--port N]   Keep the workspace running in the background (macOS)

Data: ~/.design-memory (override with DESIGN_MEMORY_HOME or --root)
`;
const VALID = new Set(["add","list","search","show","observe","feedback","candidates","prefer","retire","profile","brief","gallery","open","service"]);
const FLAGS: Record<string, Set<string>> = {
  add: new Set(["image","note","title","tag","kind","project","fetch"]),
  list: new Set(["project","kind","tag","limit"]),
  search: new Set(["project","kind","tag","limit"]),
  show: new Set(),
  observe: new Set(["aspect","detail","evidence","effect","certainty"]),
  feedback: new Set(["aspect","vote","reason","quote","project"]),
  candidates: new Set(["min"]),
  prefer: new Set(["kind","rule","scope","project","from-feedback","statement"]),
  retire: new Set(["reason"]),
  profile: new Set(["project","output"]),
  brief: new Set(["project","topic","ref","limit","output"]),
  gallery: new Set(["output"]),
  open: new Set(["port","browser"]),
  service: new Set(["port"]),
};

type Arguments = { cmd: string; args: string[]; flags: Map<string,string[]>; root?: string };
const HELP_WORDS = new Set(["--help", "-h"]);
function nextValue(argv: string[], index: number, message: string, allowEmpty = true): string {
  const value = argv[index + 1];
  const missing = value === undefined || value.startsWith("--") || (!allowEmpty && !value);
  if (missing) throw new Error(message);
  return value!;
}
function checkFlag(parsed: Arguments, key: string): void {
  if (!parsed.cmd) throw new Error(`Specify a command before --${key}`);
  if (!FLAGS[parsed.cmd]?.has(key)) throw new Error(`Unknown flag --${key} for ${parsed.cmd}`);
}
function takeWord(parsed: Arguments, word: string): void {
  if (parsed.cmd) { parsed.args.push(word); return; }
  if (!VALID.has(word)) throw new Error(`Unknown command: ${word}\n${USAGE}`);
  parsed.cmd = word;
}
function parseArgs(argv: string[]): Arguments {
  const parsed: Arguments = { cmd: "", args: [], flags: new Map<string,string[]>() };
  for (let i = 0; i < argv.length; ++i) {
    const word = argv[i]!;
    if (HELP_WORDS.has(word)) return { cmd: "help", args: [], flags: parsed.flags };
    if (word === "--root") parsed.root = nextValue(argv, i++, "--root requires a path", false);
    else if (word.startsWith("--")) {
      const key = word.slice(2);
      checkFlag(parsed, key);
      parsed.flags.set(key, [...(parsed.flags.get(key) ?? []), nextValue(argv, i++, `--${key} requires a value`)]);
    } else takeWord(parsed, word);
  }
  return parsed.cmd ? parsed : { cmd: "help", args: [], flags: parsed.flags };
}
const arg = (a: Arguments, name: string) => a.flags.get(name)?.at(-1);
const all = (a: Arguments, name: string) => a.flags.get(name) ?? [];
const required = (a: Arguments, name: string) => {
  const value = arg(a, name)?.trim();
  if (!value) throw new Error(`--${name} is required`);
  return value;
};
const first = (a: Arguments, label: string) => {
  const value = a.args[0];
  if (!value) throw new Error(`${label} is required`);
  return value;
};
const choose = <T extends string>(value: string | undefined, allowed: readonly T[], label: string, fallback: T): T => {
  const chosen = value ?? fallback;
  if (!allowed.includes(chosen as T)) throw new Error(`Invalid ${label}: ${chosen}; use ${allowed.join("|")}`);
  return chosen as T;
};
const positiveInt = (value: string | undefined, fallback: number, cap: number) => {
  if (value === undefined) return fallback;
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("Limit must be a positive integer");
  return Math.min(count, cap);
};
const emit = (data: unknown) => console.log(typeof data === "string" ? data : JSON.stringify(data, null, 2));

const TITLE_TEXT_LIMIT = 70;
const postTitle = (post: XPost) => {
  const line = post.text.replace(/\s+/g, " ").trim();
  return `@${post.author}: ${line.length > TITLE_TEXT_LIMIT ? line.slice(0, TITLE_TEXT_LIMIT - 1).trimEnd() + "…" : line}`;
};

const KINDS = ["screenshot","website","shadcn","x"] as const;
type SourceInfo = { kind: Kind; title: string; origin: Reference["source"]; media?: Media };

async function describeSource(root: string, source: string, uploaded?: Media): Promise<SourceInfo> {
  if (source.startsWith("http://") || source.startsWith("https://")) {
    const d = urlDetails(source);
    return { kind: d.kind, title: d.title, origin: { type: "url", value: source, key: d.key } };
  }
  const media = uploaded ?? await addMedia(root, source);
  const value = uploaded ? join(root, media.path) : expand(source);
  return { kind: "screenshot", title: media.original_filename, media, origin: { type: "file", value, key: media.sha256 } };
}
function loadOrCreateRef(db: Database, info: SourceInfo, kind: Kind, name: string | undefined): { ref: Reference; existing: boolean } {
  const old = db.query("SELECT data FROM refs WHERE source_key=?").get(info.origin.key) as { data:string } | null;
  const ref: Reference = old ? JSON.parse(old.data) : {
    id: itemId("ref"), kind, title: name ?? info.title, source: info.origin, media: [], notes: [], tags: [], projects: [], created_at: now(),
  };
  if (name) ref.title = name;
  return { ref, existing: !!old };
}
function mergeMedia(ref: Reference, items: Array<Media | undefined>): void {
  for (const m of items) {
    if (!m) continue;
    const previous = ref.media.find(prior => prior.sha256 === m.sha256);
    if (!previous) ref.media.push(m);
    else if (m.thumbnail) previous.thumbnail = m.thumbnail;
  }
}
async function attachXPost(root: string, ref: Reference, args: Arguments, name: string | undefined): Promise<string[]> {
  const fetchPost = choose(arg(args, "fetch"), ["yes", "no"] as const, "fetch", "yes") === "yes";
  if (ref.kind !== "x" || !fetchPost || ref.post) return [];
  try {
    const fetched = await ingestXPost(root, ref.source.key);
    ref.post = fetched.post;
    mergeMedia(ref, fetched.media);
    if (!name && fetched.post.text) ref.title = postTitle(fetched.post);
    return fetched.warnings;
  } catch (cause) {
    return [`Saved the link only. Could not fetch the X post: ${(cause as Error).message}`];
  }
}
function applyUserFields(ref: Reference, args: Arguments): void {
  const note = arg(args, "note");
  if (note && !ref.notes.some(entry => entry.text === note)) ref.notes.push({ text: note, added_at: now() });
  ref.tags = [...new Set([...ref.tags, ...cleanTags(all(args, "tag"))])];
  const project = arg(args, "project");
  if (project && !ref.projects.includes(project)) ref.projects.push(project);
}
export async function addOne(root: string, db: Database, source: string, args: Arguments, uploaded?: Media): Promise<unknown> {
  const info = await describeSource(root, source.trim(), uploaded);
  const name = arg(args, "title");
  const { ref, existing } = loadOrCreateRef(db, info, choose(arg(args, "kind"), KINDS, "kind", info.kind), name);
  const image = arg(args, "image");
  mergeMedia(ref, [info.media, image ? await addMedia(root, image) : undefined]);
  const warnings = await attachXPost(root, ref, args, name);
  applyUserFields(ref, args);
  ref.updated_at = now();
  inTransaction(db, () => { saveRecord(db, "refs", ref); refreshSearch(db, ref.id); });
  return { id: ref.id, kind: ref.kind, duplicate: existing, title: ref.title, media: ref.media.map(m => m.path),
    ...(ref.post ? { post: ref.post.text } : {}), ...(warnings.length ? { warnings } : {}) };
}
async function cmdAdd(root: string, db: Database, a: Arguments) {
  if (!a.args.length) throw new Error("A screenshot path or URL is required");
  if (a.args.length > 1 && arg(a, "image")) throw new Error("--image can only be used with one source");
  const results = [];
  for (const source of a.args) results.push(await addOne(root, db, source, a));
  emit(results.length === 1 ? results[0] : results);
}

function* iterMatches(db: Database, a: Arguments): Generator<Reference> {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  const kind = arg(a, "kind");
  if (kind) { choose(kind, ["screenshot", "website", "shadcn", "x"], "kind", "website"); clauses.push("r.kind = ?"); params.push(kind); }
  const project = arg(a,"project"), tag = arg(a,"tag")?.toLowerCase();
  if (tag) { clauses.push("EXISTS (SELECT 1 FROM json_each(r.data,'$.tags') WHERE value=?)"); params.push(tag); }
  const text = a.cmd === "search" ? first(a,"A search query").trim().toLowerCase() : "";
  const terms = text.match(/[\p{L}\p{N}_-]+/gu)?.slice(0, 12) ?? [];
  let useFts = false;
  if (text && terms.length && ensureFts(db)) {
    useFts = true;
    clauses.push("refs_fts MATCH ?");
    params.push(terms.map(term => `"${term.replaceAll('"', '')}"*`).join(" AND "));
  } else if (text) {
    clauses.push("r.search_text LIKE ? ESCAPE '\\'");
    params.push(`%${text.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`);
  }
  const joins = [useFts ? "refs_fts JOIN refs r ON r.rowid=refs_fts.rowid" : "refs r"];
  let order = "r.created_at DESC,r.id DESC";
  if (project) {
    joins.push("JOIN ref_projects p ON p.ref_id=r.id");
    clauses.push("p.project = ?"); params.push(project);
    if (!useFts) order = "p.created_at DESC,p.ref_id DESC";
  }
  const sql = `SELECT r.data FROM ${joins.join(" ")}` + (clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "") + ` ORDER BY ${order}`;
  const max = positiveInt(arg(a,"limit"), 100, 500);
  let returned = 0;
  for (const row of db.query(sql).iterate(...params) as Iterable<{data:string}>) {
    yield JSON.parse(row.data) as Reference;
    if (++returned >= max) break;
  }
}
function summary(r: Reference) {
  return { id: r.id, kind: r.kind, title: r.title, source: r.source.value, tags: r.tags, projects: r.projects,
    note: r.notes.at(-1)?.text ?? "", media: r.media.map(m => m.path) };
}
function cmdList(db: Database, a: Arguments) { emit(Array.from(iterMatches(db,a), summary)); }
function cmdShow(db: Database, a: Arguments) {
  const id = first(a,"Reference ID");
  emit({ reference: getItem(db,"refs",id), observations: [...records(db,"observations",id)], feedback: [...records(db,"feedback",id)] });
}
function cmdObserve(db: Database, a: Arguments) {
  const id = first(a,"Reference ID"); getItem(db,"refs",id);
  const item: Observation = { id: itemId("obs"), ref_id: id, aspect: required(a,"aspect"), detail: required(a,"detail"),
    evidence: required(a,"evidence"), effect: arg(a,"effect") ?? "", certainty: choose(arg(a,"certainty"), ["observed","inferred"], "certainty", "observed"), created_at: now() };
  inTransaction(db, () => { saveRecord(db,"observations",item); refreshSearch(db,id); });
  emit({id:item.id,ref_id:id});
}
function cmdFeedback(db: Database, a: Arguments) {
  const id = first(a,"Reference ID"); getItem(db,"refs",id);
  const item: Feedback = { id: itemId("fb"), ref_id:id, aspect:required(a,"aspect"), vote: choose(arg(a,"vote"),["like","dislike","mixed"],"vote","mixed"),
    reason:arg(a,"reason") ?? "", quote:arg(a,"quote") ?? "", project:arg(a,"project") ?? null, created_at:now() };
  if (!arg(a,"vote")) throw new Error("--vote is required");
  inTransaction(db, () => { saveRecord(db,"feedback",item); refreshSearch(db,id); });
  emit({id:item.id,ref_id:id,vote:item.vote,aspect:item.aspect});
}
function cmdPrefer(db: Database, a: Arguments) {
  const ids = [...new Set(all(a,"from-feedback"))];
  const statement = arg(a,"statement")?.trim() ?? "";
  if (!ids.length && !statement) throw new Error("A preference needs --from-feedback ID or --statement (explicit user wording)");
  const kind = choose(arg(a,"kind"),["prefer","avoid"],"kind","prefer");
  if (!arg(a,"kind")) throw new Error("--kind is required");
  const scope = choose(arg(a,"scope"),["global","project"],"scope","global");
  const project = arg(a,"project") ?? null;
  if (scope === "project" && !project) throw new Error("Project-scoped preferences need --project NAME");
  if (scope === "global" && project) throw new Error("Use --scope project with --project; global preferences have no project");
  const linked = ids.map(id => getItem(db,"feedback",id));
  const opposite = kind === "prefer" ? "dislike" : "like";
  if (linked.length && linked.every(fb => fb.vote === opposite)) throw new Error("Feedback contradicts this preference; check --kind");
  const item: Preference = {id:itemId("pref"),kind,rule:required(a,"rule"),scope,project,feedback_ids:ids,statement,created_at:now()};
  inTransaction(db, () => saveRecord(db,"preferences",item));
  emit({id:item.id,rule:item.rule,scope:item.scope,kind:item.kind});
}
function cmdRetire(db: Database, a: Arguments) {
  const id = first(a,"Preference ID"); getItem(db,"preferences",id);
  if (db.query("SELECT 1 FROM retired WHERE preference_id=?").get(id)) throw new Error("Preference already retired");
  const reason = required(a,"reason");
  inTransaction(db, () => db.query("INSERT INTO retired(preference_id,data) VALUES(?,?)").run(id,encode({preference_id:id,reason,retired_at:now()})));
  emit({retired:id});
}
function activePreferences(db: Database, project?: string): {global: Preference[]; local: Preference[]} {
  const global: Preference[] = [], local: Preference[] = [];
  for (const { data } of db.query(`SELECT p.data FROM preferences p LEFT JOIN retired r ON r.preference_id=p.id
      WHERE r.preference_id IS NULL AND (p.scope='global' OR (p.scope='project' AND p.project=?))
      ORDER BY p.created_at,p.id`).iterate(project ?? null) as Iterable<{data:string}>) {
    const pref = JSON.parse(data) as Preference;
    (pref.scope === "global" ? global : local).push(pref);
  }
  return { global, local };
}
const prefLine = (pref: Preference) => {
  const sources = pref.feedback_ids.length ? pref.feedback_ids.join(", ") : `direct statement: ${pref.statement}`;
  return `- **${pref.kind === "prefer" ? "Prefer" : "Avoid"}:** ${pref.rule}  _(source: ${sources}; ${pref.id})_`;
};
function profile(db: Database, project?: string): string {
  const prefs = activePreferences(db,project);
  const lines = ["# Design Memory profile","","Only confirmed preferences appear here. Saved references are not approval.",
    "Priority: current request > project decisions > personal preferences > inspiration.","","## Personal", ""];
  lines.push(...(prefs.global.length ? prefs.global.map(prefLine) : ["_No confirmed personal preferences yet._"]));
  if (project) lines.push("", `## Project: ${project}`, "", ...(prefs.local.length ? prefs.local.map(prefLine) : ["_No confirmed preferences for this project._"]));
  return lines.join("\n")+"\n";
}
function writeOrPrint(content: string, file?: string): void {
  if (!file) return emit(content);
  const dest = expand(file);
  mkdirSync(dirname(dest), {recursive:true});
  writeFileSync(dest,content,"utf8");
  emit({written:dest});
}
function cmdProfile(db:Database,a:Arguments) { writeOrPrint(profile(db,arg(a,"project")),arg(a,"output")); }
function cmdCandidates(db: Database, a: Arguments) {
  const min = positiveInt(arg(a,"min"),2,100);
  const groups = new Map<string,{aspect:string;signal:string;refs:Set<string>;feedback_ids:string[];reasons:string[]}>();
  for (const fb of records(db,"feedback")) {
    if (fb.vote === "mixed") continue;
    const aspect = fb.aspect.trim().toLowerCase().replace(/\s+/g," ");
    const key = `${aspect}\0${fb.vote}`;
    let group = groups.get(key);
    if (!group) { group = {aspect,signal:fb.vote,refs:new Set(),feedback_ids:[],reasons:[]};groups.set(key,group); }
    group.refs.add(fb.ref_id);
    group.feedback_ids.push(fb.id);
    if (fb.reason || fb.quote) group.reasons.push(fb.reason || fb.quote);
  }
  const found = [...groups.values()].filter(g => g.refs.size >= min).map(g => ({aspect:g.aspect,signal:g.signal,independent_references:g.refs.size,
    feedback_ids:g.feedback_ids,reasons:g.reasons})).sort((a,b) => b.independent_references-a.independent_references || a.aspect.localeCompare(b.aspect));
  emit(found);
}
const PROJECT_MATCH_SCORE = 5;
const TOPIC_WORD_SCORE = 2;
function topBriefReferences(db: Database, topic: string, project: string | undefined, limit: number): Reference[] {
  const words = [...new Set(topic.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])];
  const terms = [
    ...(project ? [`(CASE WHEN r.id IN (SELECT ref_id FROM ref_projects WHERE project=?) THEN ${PROJECT_MATCH_SCORE} ELSE 0 END)`] : []),
    ...words.map(() => `(CASE WHEN instr(r.search_text, ?) > 0 THEN ${TOPIC_WORD_SCORE} ELSE 0 END)`),
  ];
  const score = terms.length ? terms.join(" + ") : "0";
  const filter = terms.length ? "WHERE score > 0" : "";
  const sql = `SELECT data FROM (SELECT r.data, r.created_at, r.id, ${score} AS score FROM refs r) ${filter}
    ORDER BY score DESC, created_at DESC, id DESC LIMIT ?`;
  const params = [...(project ? [project] : []), ...words, limit];
  return (db.query(sql).all(...params) as { data: string }[]).map(row => JSON.parse(row.data) as Reference);
}
const flatten = (text: string) => text.replace(/\s+/g, " ");
function briefReferenceLines(db: Database, root: string, ref: Reference, project: string | undefined): string[] {
  const lines = [`### ${ref.title} (${ref.id})`, `- Type: ${ref.kind}`, `- Original: ${ref.source.value}`];
  for (const media of ref.media) lines.push(`- Local image: \`${join(root, media.path)}\``);
  if (ref.post) lines.push(`- Post by @${ref.post.author}: ${flatten(ref.post.text)}`);
  if (ref.post?.quoted) lines.push(`- Quoted post by @${ref.post.quoted.author}: ${flatten(ref.post.quoted.text)}`);
  for (const note of ref.notes) lines.push(`- User note: ${note.text}`);
  for (const ob of records(db, "observations", ref.id)) {
    lines.push(`- Observation (${ob.certainty}, ${ob.aspect}): ${ob.detail} | Evidence: ${ob.evidence}${ob.effect ? ` | Effect: ${ob.effect}` : ""}`);
  }
  for (const fb of records(db, "feedback", ref.id)) {
    const applies = !project || !fb.project || fb.project === project;
    if (applies) lines.push(`- Explicit feedback (${fb.vote}, ${fb.aspect}): ${fb.reason || fb.quote}`);
  }
  lines.push("");
  return lines;
}
const BRIEF_FOOTER = ["## Build and review","","1. Follow product constraints first; select only relevant design ideas.",
  "2. Translate observations into concrete hierarchy, density, spacing, states, and components.",
  "3. Do not infer approval of an entire reference from a single liked element.",
  "4. Inspect the implemented UI and ask for specific keep/reject feedback. Save the answer."];
function brief(db: Database, root: string, a: Arguments): string {
  const project = arg(a,"project"), topic = arg(a,"topic") ?? "";
  const refIds = all(a,"ref");
  const selected = refIds.length ? refIds.map(id => getItem(db,"refs",id)) : topBriefReferences(db, topic, project, positiveInt(arg(a,"limit"),8,30));
  const lines = ["# Design brief", "", `Project: ${project ?? "unspecified"}`, `Focus: ${topic || "unspecified"}`,"",
    "Use this as evidence, not a template to copy. Observe the actual visual before making claims.","",profile(db,project).trim(),"","## Relevant references",""];
  if (!selected.length) lines.push("_No matching references._");
  for (const ref of selected) lines.push(...briefReferenceLines(db, root, ref, project));
  lines.push(...BRIEF_FOOTER);
  return lines.join("\n").trim()+"\n";
}
function cmdBrief(root:string,db:Database,a:Arguments) { writeOrPrint(brief(db,root,a),arg(a,"output")); }

async function cmdService(root:string,a:Arguments) {
  const service = await import("./service.ts");
  const action = choose(a.args[0],["install","uninstall","restart","status"] as const,"service action","status");
  if (a.args.length > 1) throw new Error("Use one service action: install, uninstall, restart, or status");
  if (action==="install") {
    const port = positiveInt(arg(a,"port"),service.DEFAULT_SERVICE_PORT,65535);
    return await service.installService(root,port);
  }
  if (action==="uninstall") return service.uninstallService(root);
  if (action==="restart") return await service.restartService(root);
  return await service.serviceStatus(root);
}

type CommandContext = { root: string; db: Database; a: Arguments };
function parsePort(value: string | undefined): number {
  const port = value === undefined ? 0 : Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error("--port must be between 0 and 65535");
  return port;
}
async function cmdOpen({ root, db, a }: CommandContext): Promise<void> {
  const { startApp, launchBrowser } = await import("./app.ts");
  const portValue = arg(a,"port");
  const openBrowser = choose(arg(a,"browser"),["yes","no"] as const,"browser","yes") === "yes";
  const running = portValue === undefined ? await (await import("./service.ts")).runningServiceUrl(root) : undefined;
  if (running) {
    console.log(`Taste workspace (background service): ${running}`);
    if (openBrowser) launchBrowser(running);
    return;
  }
  const server = startApp(root, db, { port: parsePort(portValue), launch: openBrowser });
  await new Promise<void>(resolve => {
    const shutdown = () => { server.stop(true); resolve(); };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}
const COMMANDS: Record<string, (c: CommandContext) => unknown> = {
  add: c => cmdAdd(c.root, c.db, c.a),
  list: c => cmdList(c.db, c.a),
  search: c => cmdList(c.db, c.a),
  show: c => cmdShow(c.db, c.a),
  observe: c => cmdObserve(c.db, c.a),
  feedback: c => cmdFeedback(c.db, c.a),
  prefer: c => cmdPrefer(c.db, c.a),
  retire: c => cmdRetire(c.db, c.a),
  candidates: c => cmdCandidates(c.db, c.a),
  profile: c => cmdProfile(c.db, c.a),
  brief: c => cmdBrief(c.root, c.db, c.a),
  gallery: async c => emit(await generateGallery(c.db, c.root, arg(c.a, "output"))),
  open: cmdOpen,
  service: async c => emit(await cmdService(c.root, c.a)),
};

export async function main(argv:string[]=process.argv.slice(2)):Promise<number> {
  let db:Database | undefined;
  try {
    const a = parseArgs(argv);
    if (a.cmd === "help") { console.log(USAGE); return 0; }
    const root = rootPath(a.root);
    db = store(root);
    await COMMANDS[a.cmd]?.({ root, db, a });
    return 0;
  } catch (error) {
    console.error(`design-memory: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  } finally { db?.close(true); }
}

if (import.meta.main) process.exitCode = await main();
