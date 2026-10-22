import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { getItem, store } from "../src/db.ts";

const cli = resolve(import.meta.dir, "../src/main.ts");
let root = "";
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "taste-areas-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

function cliRun(...args: string[]) {
  const p = spawnSync(process.execPath, [cli, "--root", root, ...args], { encoding: "utf8", env: { ...process.env, DESIGN_MEMORY_HOME: root }, timeout: 15_000 });
  return { code: p.status, stdout: p.stdout, stderr: p.stderr };
}
function run(...args: string[]): any {
  const p = cliRun(...args);
  expect(p.code).toBe(0);
  return p.stdout.startsWith("{") ? JSON.parse(p.stdout) : p.stdout;
}
const prefer = (rule: string, ...extra: string[]) => run("prefer", "--kind", "prefer", "--rule", rule, "--statement", rule, ...extra);
const storedArea = (id: string) => {
  const db = store(root);
  try { return getItem(db, "preferences", id).area; } finally { db.close(true); }
};

describe("preference areas", () => {
  test("prefer stores the area from --area", () => {
    const saved = prefer("Calm spacing", "--area", "layout");
    expect(saved.area).toBe("layout");
    expect(storedArea(saved.id)).toBe("layout");
    expect(storedArea(prefer("No area").id)).toBeUndefined();
  });

  test("the area command sets and changes the area", () => {
    const id = prefer("Short labels").id;
    expect(run("area", id, "writing")).toEqual({ id, area: "writing" });
    expect(run("area", id, "type")).toEqual({ id, area: "type" });
    expect(storedArea(id)).toBe("type");
  });

  test("an invalid area is rejected", () => {
    expect(cliRun("prefer", "--kind", "prefer", "--rule", "X", "--statement", "X", "--area", "vibes").stderr).toContain("Invalid area: vibes");
    const id = prefer("Soft shadows").id;
    expect(cliRun("area", id, "vibes").stderr).toContain("Invalid area: vibes");
    expect(cliRun("area", id).stderr).toContain("Use: taste area");
    expect(cliRun("area", "pref_000000000000", "feel").stderr).toContain("Record not found");
    expect(storedArea(id)).toBeUndefined();
  });

  test("profile groups rules by area in a fixed order with Other last", () => {
    prefer("Unsorted rule");
    prefer("Short labels", "--area", "writing");
    prefer("Quiet motion", "--area", "motion");
    prefer("Calm and focused", "--area", "feel");
    run("prefer", "--kind", "avoid", "--rule", "Dense grids", "--statement", "No dense grids", "--scope", "project", "--project", "atlas", "--area", "layout");
    const text: string = run("profile", "--project", "atlas");
    const order = ["## Personal", "### Feel", "Calm and focused", "### Motion", "Quiet motion", "### Writing", "Short labels", "### Other", "Unsorted rule",
      "## Project: atlas", "### Layout", "Dense grids"];
    const positions = order.map(part => text.indexOf(part));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect([...positions].sort((x, y) => x - y)).toEqual(positions);
    expect(text).toContain("- **Prefer:** Calm and focused  _(source: direct statement: Calm and focused;");
  });

  test("profile keeps the empty state when there are no rules", () => {
    const text: string = run("profile");
    expect(text).toContain("_No confirmed personal preferences yet._");
    expect(text).not.toContain("###");
  });
});
