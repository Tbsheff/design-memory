import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Database } from "bun:sqlite";
import { encode, inTransaction, itemId, now, refreshSearch, saveRecord, store } from "../src/db.ts";
import type { Reference } from "../src/db.ts";

const cli = resolve(import.meta.dir, "../src/main.ts");
// A tiny valid PNG for testing zero-copy media handling without a graphics library.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+XnncAAAAASUVORK5CYII=", "base64");
process.env.TASTE_X_SYNDICATION_URL = "http://127.0.0.1:9/tweet-result";
let temp = "", root = "", image = "";

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), "design-memory-bun-"));
  root = join(temp,"library");
  image = join(temp,"ref.png");
  writeFileSync(image, PNG);
});
afterEach(() => rmSync(temp, {recursive:true,force:true}));
function cliRun(...args:string[]) {
  const p = spawnSync(process.execPath, [cli,"--root",root,...args], {encoding:"utf8", env:{...process.env,DESIGN_MEMORY_HOME:root}, timeout:15_000});
  return { code:p.status, stdout:p.stdout, stderr:p.stderr };
}
function run(...args:string[]):any {
  const p = cliRun(...args);
  expect(p.code).toBe(0);
  if (p.stdout.startsWith("{") || p.stdout.startsWith("[")) return JSON.parse(p.stdout);
  return p.stdout;
}
function add(url="https://example.com/dashboard", ...opts:string[]):string { return run("add",url,...opts).id; }

// These tests invoke a fresh Bun process for every command and exercise actual persisted data.
describe("reference inbox", () => {
  test("screenshot originals survive deletion of the source", () => {
    const saved = run("add",image,"--note","Dense layout","--tag","tables");
    expect(saved.kind).toBe("screenshot");
    expect(readFileSync(join(root,saved.media[0])).equals(PNG)).toBe(true);
    rmSync(image);
    expect(existsSync(join(root,saved.media[0]))).toBe(true);
    expect(run("show",saved.id).reference.notes[0].text).toBe("Dense layout");
  });
  test("duplicate URLs merge notes and remove tracking params", () => {
    const a = add("https://example.com/docs?utm_source=one#top", "--note","Layout","--tag","grid");
    const b = run("add","https://example.com/docs?utm_source=two","--note","Type","--tag","type");
    expect(b.id).toBe(a); expect(b.duplicate).toBe(true);
    const ref = run("show",a).reference;
    expect(ref.notes).toHaveLength(2);
    expect(ref.tags.sort()).toEqual(["grid","type"]);
  });
  test("duplicate images deduplicate by sha256", () => {
    const one=run("add",image);
    const second=join(temp,"other.png"); writeFileSync(second,PNG);
    expect(run("add",second).id).toBe(one.id);
    expect(readdirSync(join(root,"media"))).toHaveLength(1);
  });
  test("batch add uses a single process", () => {
    const rows=run("add","https://a.com/1","https://b.com/2");
    expect(rows).toHaveLength(2);
    expect(run("list")).toHaveLength(2);
    expect(cliRun("add","https://a.com","https://b.com","--image",image).stderr).toContain("one source");
  });
  test("X status IDs canonicalize between Twitter and X", () => {
    const a=add("https://twitter.com/p/something/status/123?s=20");
    const b=add("https://x.com/p/something/status/123");
    expect(b).toBe(a);
    expect(run("show",a).reference.kind).toBe("x");
  });
  test("shadcn links keep original context and type", () => {
    const id=add("https://ui.shadcn.com/docs/components/data-table");
    expect(run("show",id).reference.kind).toBe("shadcn");
  });
  test("websites can preserve a local screenshot", () => {
    const id=add("https://example.com","--image",image);
    expect(run("show",id).reference.media).toHaveLength(1);
  });
  test("invalid sources fail and avoid credentialed URLs", () => {
    expect(cliRun("add","/missing.png").code).toBe(2);
    expect(cliRun("add","https://u:p@example.com").code).toBe(2);
    expect(cliRun("add","ftp://example.com").code).toBe(2);
  });
});

describe("evidence, feedback and durable preferences", () => {
  test("observations cannot become preferences", () => {
    const id=add();
    run("observe",id,"--aspect","hierarchy","--detail","strong headings","--evidence","visible screenshot");
    expect(run("show",id).observations).toHaveLength(1);
    expect(run("profile")).toContain("No confirmed");
  });
  test("feedback alone never promotes a rule", () => {
    const id=add(); run("feedback",id,"--vote","like","--aspect","density","--quote","Great density");
    expect(run("profile")).toContain("No confirmed");
  });
  test("preference requires explicit provenance", () => {
    expect(cliRun("prefer","--kind","prefer","--rule","Tables").stderr).toContain("needs --from-feedback");
    expect(cliRun("prefer","--kind","prefer","--rule","Tables","--from-feedback","fb_000000000000").stderr).toContain("Record not found");
  });
  test("project rule stays scoped; global rule crosses projects", () => {
    run("prefer","--kind","prefer","--rule","Compact tables","--statement","I like compact tables");
    run("prefer","--kind","avoid","--rule","Avoid heavy shadows","--statement","No shadows here","--scope","project","--project","bonaparte");
    expect(run("profile")).toContain("Compact tables");
    expect(run("profile")).not.toContain("heavy shadows");
    expect(run("profile","--project","bonaparte")).toContain("heavy shadows");
    expect(run("profile","--project","other")).not.toContain("heavy shadows");
  });
  test("contradictory evidence is rejected", () => {
    const id=add();
    const fb=run("feedback",id,"--vote","like","--aspect","table").id;
    const pref=run("prefer","--kind","prefer","--rule","Use tables","--from-feedback",fb);
    expect(pref.id.startsWith("pref_")).toBe(true);
    expect(cliRun("prefer","--kind","avoid","--rule","Avoid tables","--from-feedback",fb).stderr).toContain("contradicts");
  });
  test("retirement preserves provenance and removes active rule", () => {
    const id=run("prefer","--kind","prefer","--rule","Rounded cards","--statement","Rounded cards").id;
    run("retire",id,"--reason","Changed");
    expect(run("profile")).not.toContain("Rounded cards");
    const db=new Database(join(root,"library.sqlite3"));
    expect(db.query("SELECT 1 FROM preferences WHERE id=?").get(id)).not.toBeNull();
    expect(db.query("SELECT 1 FROM retired WHERE preference_id=?").get(id)).not.toBeNull();
    db.close();
  });
  test("candidates only appear across independent sources", () => {
    const a=add("https://example.com/a"), b=add("https://example.com/b");
    run("feedback",a,"--vote","like","--aspect","compact tables");
    run("feedback",a,"--vote","like","--aspect","compact tables");
    expect(run("candidates")).toEqual([]);
    run("feedback",b,"--vote","like","--aspect","Compact  Tables");
    expect(run("candidates")[0].independent_references).toBe(2);
  });
});

describe("bounded retrieval and gallery", () => {
  test("FTS search finds notes and feedback", () => {
    const id=add("https://example.com/search","--note","dense layout");
    run("feedback",id,"--aspect","typography","--vote","like","--reason","Crisp monospaced headings");
    expect(run("search","monospaced")).toHaveLength(1);
    expect(run("search","monospace")).toHaveLength(1);
    expect(run("search","nonsense-unknown")).toHaveLength(0);
  });
  test("brief picks relevant project and topic", () => {
    const wanted=add("https://example.com/table","--note","table data","--project","bonaparte");
    const unwanted=add("https://example.com/home","--note","homepage");
    const output=run("brief","--project","bonaparte","--topic","table");
    expect(output).toContain(wanted);expect(output).not.toContain(unwanted);
  });
  test("gallery escapes HTML and uses local image", () => {
    run("add",image,"--title",'<script>alert("x")</script>',"--note","A&B");
    run("gallery");
    const html=readFileSync(join(root,"gallery.html"),"utf8");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain('<script>alert("x")</script>');
    expect(html).toContain("A&amp;B");
    expect(html).toContain('loading="lazy"');
  });
  test("gallery paginates and defers the search index", () => {
    const db=store(root);
    inTransaction(db,() => {
      for(let i=0;i<80;i++) {
        const r:Reference = {id:itemId("ref"),kind:"website",title:`Card ${i}`,source:{type:"url",key:`https://example.com/${i}`,value:`https://example.com/${i}`},
          media:[],notes:[{text:`Layout ${i}`,added_at:now()}],tags:[],projects:[],created_at:now()};
        saveRecord(db,"refs",r);refreshSearch(db,r.id);
      }
    });db.close();
    const info=run("gallery");
    expect(info.pages).toBe(3);
    expect(readFileSync(join(root,"gallery.html"),"utf8").match(/class="card" id=/g)?.length).toBe(36);
    expect(readFileSync(join(root,"gallery-2.html"),"utf8").match(/class="card" id=/g)?.length).toBe(36);
    expect(readFileSync(join(root,"gallery.html"),"utf8")).not.toContain("window.DM_INDEX=[");
    expect(readFileSync(join(root,"gallery-search.js"),"utf8").match(/"p":/g)?.length).toBe(80);
  });
  test("v0.1 JSON imports without touching originals", () => {
    const folder=join(root,"refs"); mkdirSync(folder,{recursive:true});
    const ref:Reference={id:"ref_000000000001",kind:"website",title:"Old ref",source:{type:"url",key:"https://example.com/old",value:"https://example.com/old"},
      media:[],notes:[{text:"precious legacy note",added_at:now()}],tags:[],projects:[],created_at:now()};
    writeFileSync(join(folder,ref.id+".json"),JSON.stringify(ref));
    expect(run("search","precious")[0].id).toBe(ref.id);
    expect(existsSync(join(folder,ref.id+".json"))).toBe(true);
  });
  test("v0.2 existing SQLite reads unchanged", () => {
    mkdirSync(root,{recursive:true});
    const db=new Database(join(root,"library.sqlite3"));
    db.run("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);");
    db.run("CREATE TABLE refs(id TEXT PRIMARY KEY,source_key TEXT NOT NULL UNIQUE,kind TEXT NOT NULL,created_at TEXT NOT NULL,search_text TEXT NOT NULL,data TEXT NOT NULL)");
    db.run("INSERT INTO meta VALUES ('legacy_imported','yes')");
    const ref:Reference={id:"ref_000000000002",kind:"website",title:"V0.2 layout",source:{type:"url",key:"https://example.com/old2",value:"https://example.com/old2"},
      media:[],notes:[{text:"old compact layout",added_at:now()}],tags:[],projects:[],created_at:now()};
    db.query("INSERT INTO refs VALUES(?,?,?,?,?,?)").run(ref.id,ref.source.key,ref.kind,ref.created_at,"old compact layout",JSON.stringify(ref));
    db.close();
    expect(run("search","compact")[0].id).toBe(ref.id);
  });
});
