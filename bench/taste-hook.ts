const SUBCOMMANDS = new Set(["profile", "brief", "show", "list", "search"]);

type Part = { text: string; pipedFrom: boolean };

type Separator = { size: number; piped: boolean } | "bad" | null;

function separatorAt(command: string, i: number): Separator {
  const c = command[i];
  const next = command[i + 1];
  if (c === ";" || c === "\n") return { size: 1, piped: false };
  if (c === "&" && next === "&") return { size: 2, piped: false };
  if (c === "|" && next === "|") return "bad";
  if (c === "|") return { size: 1, piped: true };
  return null;
}

function splitTop(command: string): Part[] | null {
  const parts: Part[] = [];
  let quote = "";
  let current = "";
  let piped = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    const sep = quote ? null : separatorAt(command, i);
    if (sep === "bad") return null;
    if (sep) {
      parts.push({ text: current.trim(), pipedFrom: piped });
      current = "";
      piped = sep.piped;
      i += sep.size - 1;
      continue;
    }
    if (quote && c === quote) quote = "";
    else if (!quote && (c === "'" || c === '"')) quote = c;
    current += c;
  }
  if (quote) return null;
  parts.push({ text: current.trim(), pipedFrom: piped });
  return parts.filter(p => p.text);
}

function unquote(word: string): string {
  return word.replace(/^(['"])(.*)\1$/, "$2");
}

function hasRedirect(text: string): boolean {
  let quote = "";
  const bare = [...text.replaceAll("2>&1", "")].filter(c => {
    if (quote) { if (c === quote) quote = ""; return false; }
    if (c === "'" || c === '"') { quote = c; return false; }
    return true;
  }).join("");
  return /[<>&]/.test(bare);
}

type State = { vars: Set<string>; cwdAllowed: boolean; allowedDirs: string[] };

function isAllowedPath(path: string, state: State): boolean {
  const p = unquote(path);
  if (p === "taste") return true;
  if (p === "./scripts/taste" || p === "scripts/taste") return state.cwdAllowed;
  return state.allowedDirs.some(dir => p === `${dir}/scripts/taste`);
}

function invokes(head: string, state: State): boolean {
  const name = unquote(head).match(/^\$\{?([A-Za-z_]\w*)\}?$/)?.[1];
  return name ? state.vars.has(name) : isAllowedPath(head, state);
}

function segmentOk(part: Part, state: State): boolean {
  const text = part.text;
  if (part.pipedFrom) return /^head(\s+-n)?\s+-?\d+$/.test(text);
  if (hasRedirect(text)) return false;
  const assign = text.match(/^([A-Za-z_]\w*)=(\S+)$/);
  if (assign) {
    if (!isAllowedPath(assign[2]!, state)) return false;
    state.vars.add(assign[1]!);
    return true;
  }
  const cd = text.match(/^cd\s+(\S+)$/);
  if (cd) {
    state.cwdAllowed = state.allowedDirs.includes(unquote(cd[1]!).replace(/\/$/, ""));
    return state.cwdAllowed;
  }
  const words = text.replace(/\s*2>&1$/, "").split(/\s+/);
  return invokes(words[0]!, state) && SUBCOMMANDS.has(words[1] ?? "");
}

export function isTasteCommand(command: string, allowedDirs: string[]): boolean {
  if (command.includes("$(") || command.includes("`")) return false;
  const parts = splitTop(command);
  if (!parts?.length) return false;
  const state: State = { vars: new Set(), cwdAllowed: false, allowedDirs: allowedDirs.map(d => d.replace(/\/$/, "")) };
  return parts.every(p => segmentOk(p, state));
}

async function main() {
  const input = JSON.parse(await Bun.stdin.text()) as { tool_name?: string; tool_input?: { command?: string } };
  const dirs = (process.env.TASTE_HOOK_DIRS ?? "").split(":").filter(Boolean);
  if (input.tool_name !== "Bash" || !isTasteCommand(input.tool_input?.command ?? "", dirs)) return;
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "taste CLI read command" } }));
}

if (import.meta.main) await main();
