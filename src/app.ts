import { Database } from "bun:sqlite";
import { createWriteStream, existsSync, mkdirSync, rmSync } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { extname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { addOne } from "./main.ts";
import { ensureFts, getItem, groupByArea, inTransaction, itemId, now, records, refreshSearch, saveRecord } from "./db.ts";
import type { Reference, Feedback, Preference } from "./db.ts";
import { appHTML } from "./app-template.ts";
import { finalizeUploadedMedia } from "./media.ts";

const MAX_IMAGE = 70 * 1024 * 1024;
const EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"]);
const json = (data: unknown, status=200) => Response.json(data, { status, headers: {"Cache-Control":"no-store"} });
const error = (message: string, status=400) => json({error:message},status);
const str = (v: unknown, max=500):string => typeof v === "string" ? v.trim().slice(0,max) : "";
const parseJSON = async (request: Request) => {
  if (Number(request.headers.get("content-length") ?? 0) > 32_768) throw new Error("Request is too large");
  const body = await request.text();
  if (body.length > 32_768) throw new Error("Request is too large");
  const value:unknown = JSON.parse(body);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return value as Record<string,unknown>;
};
const fileURL = (path: string | undefined): string | null => {
  if (!path) return null;
  const match = /^(media|thumbs)\/([a-f0-9]{64}\.(?:png|jpe?g|webp|gif|avif))$/i.exec(path);
  return match ? `/asset/${match[1]}/${match[2]}` : null;
};
const card = (r:Reference) => ({
  id:r.id,kind:r.kind,title:r.title,source:r.source.value,
  note:r.notes.at(-1)?.text ?? "",tags:r.tags,projects:r.projects,
  created_at:r.created_at,
  thumbnail:fileURL(r.media[0]?.thumbnail ?? r.media[0]?.path),
  original:fileURL(r.media[0]?.path),
});
function lookup(db: Database, q:URLSearchParams) {
  const kind = str(q.get("kind"),16);
  if (kind && !["screenshot","website","shadcn","x"].includes(kind)) throw new Error("Invalid source filter");
  const phrase = str(q.get("q"),120).toLowerCase();
  const project = str(q.get("project"),100);
  const page = Math.min(10_000,Math.max(1,Number.parseInt(q.get("page") || "1",10) || 1));
  const clauses:string[]=[]; const values:(string|number)[]=[];
  const terms=phrase.match(/[\p{L}\p{N}_-]+/gu)?.slice(0,10) ?? [];
  const useFts=!!phrase && terms.length>0 && ensureFts(db);
  const joins=[useFts?"refs_fts JOIN refs r ON r.rowid=refs_fts.rowid":"refs r"];
  let order="r.created_at DESC,r.id DESC";
  if (useFts) {clauses.push("refs_fts MATCH ?");values.push(terms.map(w=>`"${w.replaceAll('"','')}"*`).join(" AND "));}
  else if (phrase) {clauses.push("r.search_text LIKE ? ESCAPE '\\'");values.push(`%${phrase.replaceAll("\\","\\\\").replaceAll("%","\\%").replaceAll("_","\\_")}%`);}
  if (project) {joins.push("JOIN ref_projects p ON p.ref_id=r.id");clauses.push("p.project=?");values.push(project);if(!useFts)order="p.created_at DESC,p.ref_id DESC";}
  if (kind) {clauses.push("r.kind=?");values.push(kind);}
  const from=joins.join(" ");
  const where=clauses.length?` WHERE ${clauses.join(" AND ")}`:"";
  const countSql=useFts&&clauses.length===1?"SELECT count(*) AS count FROM refs_fts WHERE refs_fts MATCH ?":`SELECT count(*) AS count FROM ${from}${where}`;
  const total=(db.query(countSql).get(...values) as {count:number}).count;
  const rows=db.query(`SELECT r.data FROM ${from}${where} ORDER BY ${order} LIMIT 24 OFFSET ?`).all(...values,(page-1)*24) as {data:string}[];
  return {items:rows.map(r=>card(JSON.parse(r.data))),total,page,pages:Math.max(1,Math.ceil(total/24))};
}
function stats(db:Database) {
  const references = (db.query("SELECT count(*) AS count FROM refs").get() as {count:number}).count;
  const preferences = (db.query("SELECT count(*) AS count FROM preferences p LEFT JOIN retired r ON p.id=r.preference_id WHERE r.preference_id IS NULL").get() as {count:number}).count;
  return {references,preferences};
}
function preferenceList(db:Database): unknown[] {
  const prefs=[];
  for(const row of db.query(`SELECT p.data FROM preferences p LEFT JOIN retired r ON p.id=r.preference_id WHERE r.preference_id IS NULL ORDER BY p.created_at DESC LIMIT 250`).iterate() as Iterable<{data:string}>) {
    prefs.push(JSON.parse(row.data));
  }
  return prefs;
}
function validateMediaPath(url:URL,root:string): string | null {
  const m=/^\/asset\/(media|thumbs)\/([a-f0-9]{64}\.(?:png|jpe?g|webp|gif|avif))$/i.exec(url.pathname);
  if (!m) return null;
  return join(root,m[1]!,m[2]!);
}
async function uploaded(root:string,db:Database,request:Request,url:URL) {
  const name = str(url.searchParams.get("name"),180);
  const ext=extname(name).toLowerCase();
  if (!EXTENSIONS.has(ext)) return error("Upload a PNG, JPG, WebP, GIF, or AVIF image");
  if (!request.body) return error("No file received");
  if (Number(request.headers.get("content-length") ?? 0) > MAX_IMAGE) return error("Image exceeds 70 MB",413);
  const dir=join(root,"incoming");mkdirSync(dir,{recursive:true});
  const tmp=join(dir,`incoming_${randomBytes(8).toString("hex")}${ext}`);
  let bytes=0;
  const hash=createHash("sha256");
  try {
    const guard=new Transform({transform(chunk:Buffer,_encoding,done){bytes+=chunk.length;if(bytes<=MAX_IMAGE)hash.update(chunk);done(bytes>MAX_IMAGE?new Error("Image exceeds 70 MB"):null,chunk);}});
    await pipeline(Readable.fromWeb(request.body as any),guard,createWriteStream(tmp,{flags:"wx"}));
    if (bytes===0) throw new Error("Empty image");
    const flags=new Map<string,string[]>();
    const note=str(url.searchParams.get("note"),1500), project=str(url.searchParams.get("project"),100);
    if (note) flags.set("note",[note]);
    if (project) flags.set("project",[project]);
    const media=finalizeUploadedMedia(root,tmp,hash.digest("hex"),name);
    const added=await addOne(root,db,join(root,media.path),{cmd:"add",args:[name],flags},media);
    return json(added);
  } finally {rmSync(tmp,{force:true});}
}
const isLoopbackHost=(host:string|null,port:number|undefined)=>host===`127.0.0.1:${port}`;
export function launchBrowser(address:string) {
  const cmd=process.platform==="darwin"?"open":process.platform==="win32"?"cmd":"xdg-open";
  const args=process.platform==="win32"?["/c","start","",address]:[address];
  try {const p=spawn(cmd,args,{stdio:"ignore",detached:true});p.on("error",()=>{});p.unref();} catch { return; }
}
export type ServerOptions = { port?:number; launch?:boolean };
type AppContext = { root:string; db:Database; page:string; secret:string; port:()=>number|undefined };
type RequestData = Awaited<ReturnType<typeof parseJSON>>;
type GetRoute = (ctx:AppContext, url:URL) => Response;
type PostRoute = (ctx:AppContext, data:RequestData) => Response | Promise<Response>;

const PAGE_HEADERS = {"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer","Content-Security-Policy":"default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"};
const ASSET_HEADERS = {"Cache-Control":"private, max-age=3600","X-Content-Type-Options":"nosniff"};

function serveAsset(ctx:AppContext, url:URL): Response {
  const path=validateMediaPath(url,ctx.root);
  if (!path || !existsSync(path)) return error("Image not found",404);
  return new Response(Bun.file(path),{headers:ASSET_HEADERS});
}
function referenceDetail(db:Database, id:string) {
  const ref=getItem(db,"refs",id);
  const media=ref.media.map(m=>({...m,original_url:fileURL(m.path),thumbnail_url:fileURL(m.thumbnail??m.path)}));
  return {reference:{...ref,media},observations:[...records(db,"observations",id)],feedback:[...records(db,"feedback",id)]};
}
function profilePrompt(db:Database, project:string): string {
  const lines=["My design preferences (explicitly confirmed):"];
  const prefs=(preferenceList(db) as Preference[]).filter(p=>p.scope==="global" || p.project===project);
  for (const group of groupByArea(prefs)) {
    lines.push(`${group.label}:`, ...group.items.map(p=>`- ${p.kind==="prefer"?"Prefer":"Avoid"}${p.scope==="project"?` in ${p.project}`:""}: ${p.rule}`));
  }
  return lines.join("\n");
}
const GET_ROUTES: Record<string,GetRoute> = {
  "/": ctx=>new Response(ctx.page,{headers:PAGE_HEADERS}),
  "/api/list": (ctx,url)=>json(lookup(ctx.db,url.searchParams)),
  "/api/stats": ctx=>json(stats(ctx.db)),
  "/api/preferences": ctx=>json(preferenceList(ctx.db)),
  "/api/ref": (ctx,url)=>json(referenceDetail(ctx.db,str(url.searchParams.get("id"),30))),
  "/api/profile": (ctx,url)=>new Response(profilePrompt(ctx.db,str(url.searchParams.get("project"),100)),{headers:{"Content-Type":"text/plain; charset=utf-8"}}),
};

async function addSources(ctx:AppContext, data:RequestData): Promise<Response> {
  const sources=Array.isArray(data.sources)?data.sources.filter(s=>typeof s==="string").slice(0,30) as string[]:[];
  if (!sources.length) return error("Paste at least one URL");
  const flags=new Map<string,string[]>();
  const note=str(data.note,1500), project=str(data.project,100);
  if (note) flags.set("note",[note]);
  if (project) flags.set("project",[project]);
  if (sources.some(source=>!/^https?:\/\//i.test(source))) throw new Error("Only website URLs can be pasted here. Drop images to upload.");
  const items=[];
  for (const source of sources) items.push(await addOne(ctx.root,ctx.db,source,{cmd:"add",args:[source],flags}));
  return json({items});
}
function addNote(ctx:AppContext, data:RequestData): Response {
  const id=str(data.id,30), note=str(data.note,1500);
  if (!note) return error("Write a short note first");
  const ref=getItem(ctx.db,"refs",id);
  if (ref.notes.some(n=>n.text===note)) return json({saved:true});
  ref.notes.push({text:note,added_at:now()});
  ref.updated_at=now();
  inTransaction(ctx.db,()=>{saveRecord(ctx.db,"refs",ref);refreshSearch(ctx.db,id);});
  return json({saved:true});
}
function addFeedback(ctx:AppContext, data:RequestData): Response {
  const id=str(data.id,30), vote=str(data.vote,16), text=str(data.text,500);
  getItem(ctx.db,"refs",id);
  if (!["like","dislike"].includes(vote) || !text) return error("Choose like or dislike and say what specifically");
  const feedback:Feedback={id:itemId("fb"),ref_id:id,vote:vote as Feedback["vote"],aspect:text.slice(0,160),quote:text,reason:"",project:null,created_at:now()};
  inTransaction(ctx.db,()=>{saveRecord(ctx.db,"feedback",feedback);refreshSearch(ctx.db,id);});
  return json({saved:true,id:feedback.id});
}
function addPreference(ctx:AppContext, data:RequestData): Response {
  const rule=str(data.rule,500), kind=str(data.kind,10), project=str(data.project,100);
  if (!rule || !["prefer","avoid"].includes(kind)) return error("Enter a preference and choose Prefer or Avoid");
  const p:Preference={id:itemId("pref"),kind:kind as Preference["kind"],rule,scope:project?"project":"global",project:project||null,feedback_ids:[],statement:rule,created_at:now()};
  inTransaction(ctx.db,()=>saveRecord(ctx.db,"preferences",p));
  return json({saved:true,id:p.id});
}
function retirePreference(ctx:AppContext, data:RequestData): Response {
  const id=str(data.id,30);
  getItem(ctx.db,"preferences",id);
  const record=JSON.stringify({preference_id:id,reason:"Retired in Taste workspace",retired_at:now()});
  inTransaction(ctx.db,()=>insertRetirement(ctx.db,id,record));
  return json({retired:true});
}
const insertRetirement=(db:Database,id:string,record:string)=>db.query("INSERT OR IGNORE INTO retired (preference_id,data) VALUES (?,?)").run(id,record);
const POST_ROUTES: Record<string,PostRoute> = {
  "/api/add": addSources, "/api/note": addNote, "/api/feedback": addFeedback, "/api/preference": addPreference, "/api/retire": retirePreference,
};

function handleGet(ctx:AppContext, url:URL): Response {
  if (url.pathname.startsWith("/asset/")) return serveAsset(ctx,url);
  const route=GET_ROUTES[url.pathname];
  return route ? route(ctx,url) : error("Not found",404);
}
function writeRejection(ctx:AppContext, req:Request): Response | undefined {
  if (req.headers.get("x-taste-token")!==ctx.secret) return error("Unauthorized",403);
  const origin=req.headers.get("origin");
  if (origin && origin!==`http://127.0.0.1:${ctx.port()}`) return error("Forbidden origin",403);
  return undefined;
}
async function handleWrite(ctx:AppContext, req:Request, url:URL): Promise<Response> {
  const rejected=writeRejection(ctx,req);
  if (rejected) return rejected;
  if (req.method==="PUT" && url.pathname==="/api/upload") return await uploaded(ctx.root,ctx.db,req,url);
  const route=req.method==="POST" ? POST_ROUTES[url.pathname] : undefined;
  if (!route) return error("Not found",404);
  return await route(ctx,await parseJSON(req));
}
async function routeRequest(ctx:AppContext, req:Request): Promise<Response> {
  const url=new URL(req.url);
  if (req.method==="GET") return handleGet(ctx,url);
  const isApiWrite=["POST","PUT"].includes(req.method) && url.pathname.startsWith("/api/");
  return isApiWrite ? await handleWrite(ctx,req,url) : error("Not found",404);
}

export function startApp(root:string, db:Database, opts:ServerOptions={}) {
  const secret=randomBytes(24).toString("hex");
  const ctx:AppContext={root,db,secret,page:appHTML.replace("__TASTE_SESSION_TOKEN__",secret),port:()=>server.port};
  const server=Bun.serve({
    hostname:"127.0.0.1", port: opts.port ?? 0, idleTimeout:60,
    async fetch(req) {
      if (!isLoopbackHost(req.headers.get("host"),server.port)) return error("Forbidden host",403);
      try { return await routeRequest(ctx,req); }
      catch(e) { return error(e instanceof Error?e.message:String(e)); }
    },
  });
  const address=`http://127.0.0.1:${server.port}`;
  console.log(`\nTaste workspace: ${address}\nData: ${root}\n${process.stdout.isTTY ? "Close with Ctrl+C.\n" : ""}`);
  if (opts.launch!==false) launchBrowser(address);
  return server;
}
