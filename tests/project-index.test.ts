import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { store } from "../src/db.ts";
import { addOne } from "../src/main.ts";

let root = "", db: ReturnType<typeof store>;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "taste-projects-")); db = store(root); });
afterEach(() => { db.close(true); rmSync(root, { recursive: true, force: true }); });

const add = (source: string, project?: string) =>
  addOne(root, db, source, { cmd: "add", args: [source], flags: new Map(project ? [["project", [project]]] : []) } as never) as Promise<any>;
const projectRows = () => db.query("SELECT project, ref_id FROM ref_projects ORDER BY project, ref_id").all() as { project: string; ref_id: string }[];

describe("project index", () => {
  test("stays in sync when an item gains another project", async () => {
    const first = await add("https://example.com/a", "atlas");
    await add("https://example.com/a", "bonaparte");
    await add("https://example.com/b");
    expect(projectRows()).toEqual([{ project: "atlas", ref_id: first.id }, { project: "bonaparte", ref_id: first.id }]);
  });

  test("an existing library is indexed once when it is opened", async () => {
    const saved = await add("https://example.com/legacy", "atlas");
    db.run("DELETE FROM ref_projects");
    db.run("DELETE FROM meta WHERE key='ref_projects_indexed'");
    db.close(true);
    db = store(root);
    expect(projectRows()).toEqual([{ project: "atlas", ref_id: saved.id }]);
  });

  test("the library uses write-ahead logging so the service and CLI can share it", () => {
    expect((db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
  });
});
