import { describe, expect, test } from "bun:test";
import { isTasteCommand } from "../bench/taste-hook.ts";

const dir = "/run/.taste-plugin/skills/taste-use";
const ok = (cmd: string) => isTasteCommand(cmd, [dir]);

describe("taste hook classifier", () => {
  test("allows the taste CLI in the shapes agents use", () => {
    expect(ok(`S=${dir}/scripts/taste; $S profile; $S brief --topic 'dark usage dashboard' --limit 6`)).toBe(true);
    expect(ok(`S="${dir}/scripts/taste" && "$S" profile 2>&1 | head -80`)).toBe(true);
    expect(ok(`cd ${dir} && ./scripts/taste profile; ./scripts/taste brief --topic 'SaaS; analytics' --limit 6`)).toBe(true);
    expect(ok(`${dir}/scripts/taste show ref_abc123`)).toBe(true);
    expect(ok("taste profile\ntaste search 'tables'")).toBe(true);
  });

  test("rejects anything else", () => {
    expect(ok(`S=${dir}/scripts/taste; $S profile; ls ~`)).toBe(false);
    expect(ok(`${dir}/scripts/taste profile > out.txt`)).toBe(false);
    expect(ok(`${dir}/scripts/taste add https://x.com/a`)).toBe(false);
    expect(ok(`taste profile $(cat ~/.ssh/id_rsa)`)).toBe(false);
    expect(ok("taste profile `whoami`")).toBe(false);
    expect(ok("taste profile | sh")).toBe(false);
    expect(ok("taste profile || rm -rf x")).toBe(false);
    expect(ok("./scripts/taste profile")).toBe(false);
    expect(ok("S=/tmp/evil/scripts/taste; $S profile")).toBe(false);
    expect(ok("cd /tmp && ./scripts/taste profile")).toBe(false);
    expect(ok("$T profile")).toBe(false);
    expect(ok("taste brief --topic 'unclosed")).toBe(false);
    expect(ok("")).toBe(false);
  });
});
