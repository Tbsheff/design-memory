import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { store } from "../src/db.ts";
import { startApp } from "../src/app.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+XnncAAAAASUVORK5CYII=", "base64");
process.env.TASTE_X_SYNDICATION_URL = "http://127.0.0.1:9/tweet-result";
let root="", db:ReturnType<typeof store>, server:ReturnType<typeof startApp>, base="", token="";
const request = (path:string, init:RequestInit={}) => fetch(base+path, init);
const write = (path:string, data:unknown) => request(path, {
  method:"POST", headers:{"x-taste-token":token,"Content-Type":"application/json"}, body:JSON.stringify(data),
});

beforeEach(async()=>{
  root=mkdtempSync(join(tmpdir(),"taste-web-"));
  db=store(root);
  server=startApp(root,db,{launch:false,port:0});
  base=`http://127.0.0.1:${server.port}`;
  const html=await (await request("/")).text();
  token=html.match(/const TOKEN='([a-f0-9]{48})'/)?.[1] ?? "";
  expect(token).toHaveLength(48);
});
afterEach(async()=>{await server.stop(true);db.close(true);rmSync(root,{recursive:true,force:true});});

describe("on-demand local Taste workspace",()=>{
  test("adds and retrieves links, with server-side kind and text filters", async()=>{
    const added=await (await write("/api/add",{sources:["https://ui.shadcn.com/docs/components/data-table","https://x.com/demo/status/12345"],note:"Dense readable tables"})).json();
    expect(added.items).toHaveLength(2);
    const list=await (await request("/api/list?q=dense")).json();
    expect(list.total).toBe(2);
    const filtered=await (await request("/api/list?kind=x")).json();
    expect(filtered.total).toBe(1);
    expect(filtered.items[0].kind).toBe("x");
  });
  test("streams uploads, retains originals and writes feedback separately from preferences",async()=>{
    const response=await request("/api/upload?name=clipboard.png&note=Compact%20spacing",{
      method:"PUT",headers:{"x-taste-token":token,"Content-Type":"application/octet-stream"},body:new Blob([PNG]),
    });
    expect(response.status).toBe(200);
    const added=await response.json();
    const detail=await (await request("/api/ref?id="+added.id)).json();
    expect(detail.reference.kind).toBe("screenshot");
    expect(readFileSync(detail.reference.source.value).equals(PNG)).toBe(true);
    expect(readdirSync(join(root,"incoming"))).toHaveLength(0);
    expect((await write("/api/feedback",{id:added.id,vote:"like",text:"Compact spacing"})).ok).toBe(true);
    expect((await (await request("/api/preferences")).json())).toHaveLength(0);
    expect((await write("/api/preference",{kind:"prefer",rule:"Prefer compact spacing"})).ok).toBe(true);
    expect((await (await request("/api/preferences")).json())).toHaveLength(1);
  });
  test("rejects writes without session token or from a different origin",async()=>{
    const payload=JSON.stringify({sources:["https://example.com"]});
    const plain=await request("/api/add",{method:"POST",body:payload,headers:{"Content-Type":"application/json"}});
    expect(plain.status).toBe(403);
    const foreign=await request("/api/add",{method:"POST",body:payload,headers:{"Content-Type":"application/json","x-taste-token":token,"Origin":"https://evil.example"}});
    expect(foreign.status).toBe(403);
  });
});
