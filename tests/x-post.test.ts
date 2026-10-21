import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { store } from "../src/db.ts";
import type { Reference } from "../src/db.ts";
import { addOne } from "../src/main.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const requests: string[] = [];
let mock: ReturnType<typeof Bun.serve>;
let origin = "";
let root = "", db: ReturnType<typeof store>;

const post = (id: string) => ({
  __typename: "Tweet",
  id_str: id,
  text: "Dense tables done right https://t.co/link1 https://t.co/pic1",
  display_text_range: [0, 42],
  created_at: "2026-10-01T12:00:00.000Z",
  user: { screen_name: "designer", name: "A Designer" },
  entities: { urls: [{ url: "https://t.co/link1", expanded_url: "https://example.com/tables" }], media: [{ url: "https://t.co/pic1" }] },
  mediaDetails: [
    { type: "photo", media_url_https: `${origin}/media/table.png` },
    { type: "photo", media_url_https: "https://evil.example/tracker.png" },
  ],
  quoted_tweet: { text: "Original idea", user: { screen_name: "source", name: "Source" } },
});

beforeAll(() => {
  mock = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(req) {
      const url = new URL(req.url);
      requests.push(url.pathname + url.search);
      if (url.pathname === "/media/table.png") return new Response(PNG, { headers: { "content-type": "image/png" } });
      const id = url.searchParams.get("id") ?? "";
      if (id === "404") return new Response("{}", { status: 404 });
      return Response.json(post(id));
    },
  });
  origin = `http://127.0.0.1:${mock.port}`;
  process.env.TASTE_X_SYNDICATION_URL = `${origin}/tweet-result`;
});
afterAll(async () => { await mock.stop(true); process.env.TASTE_X_SYNDICATION_URL = "http://127.0.0.1:9/tweet-result"; });
beforeEach(() => { requests.length = 0; root = mkdtempSync(join(tmpdir(), "taste-x-")); db = store(root); });
afterEach(() => { db.close(true); rmSync(root, { recursive: true, force: true }); });

const add = (source: string, flags: Record<string, string> = {}) =>
  addOne(root, db, source, { cmd: "add", args: [source], flags: new Map(Object.entries(flags).map(([k, v]) => [k, [v]])) } as never) as Promise<any>;
const saved = (id: string) => JSON.parse((db.query("SELECT data FROM refs WHERE id=?").get(id) as { data: string }).data) as Reference;

describe("X post ingest", () => {
  test("saves post text, expands links, and downloads images from trusted hosts only", async () => {
    const result = await add("https://x.com/designer/status/111?s=20");
    expect(result.kind).toBe("x");
    expect(result.post).toBe("Dense tables done right https://example.com/tables");
    expect(result.title).toBe("@designer: Dense tables done right https://example.com/tables");
    const ref = saved(result.id);
    expect(ref.post).toMatchObject({ author: "designer", name: "A Designer", quoted: { author: "source", text: "Original idea" } });
    expect(ref.media).toHaveLength(1);
    expect(readFileSync(join(root, ref.media[0]!.path)).equals(PNG)).toBe(true);
    expect(requests.some(path => path.includes("tracker"))).toBe(false);
    const search = (db.query("SELECT search_text FROM refs WHERE id=?").get(result.id) as { search_text: string }).search_text;
    expect(search).toContain("dense tables done right");
    expect(search).toContain("original idea");
  });

  test("a custom title wins over the post text", async () => {
    const result = await add("https://x.com/designer/status/112", { title: "Table density" });
    expect(result.title).toBe("Table density");
    expect(result.post).toContain("Dense tables");
  });

  test("--fetch no saves only the link and makes no request", async () => {
    const result = await add("https://x.com/designer/status/113", { fetch: "no" });
    expect(result.post).toBeUndefined();
    expect(result.title).toBe("X post by @designer");
    expect(requests).toHaveLength(0);
  });

  test("an unavailable post still saves the link, with a warning", async () => {
    const result = await add("https://x.com/designer/status/404");
    expect(result.id).toMatch(/^ref_/);
    expect(result.warnings[0]).toContain("private, deleted, or does not exist");
    expect(saved(result.id).post).toBeUndefined();
  });

  test("adding the same post again does not fetch it again", async () => {
    const first = await add("https://x.com/designer/status/114");
    const count = requests.length;
    const second = await add("https://twitter.com/designer/status/114", { note: "Still like it" });
    expect(second.id).toBe(first.id);
    expect(second.duplicate).toBe(true);
    expect(requests.length).toBe(count);
  });
});
