import type { Database } from "bun:sqlite";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { basename, dirname, extname, join, relative } from "node:path";
import type { Preference, Reference } from "./db.ts";
import { expand } from "./db.ts";
import { galleryTemplate } from "./gallery-template.ts";

export const PER_PAGE = 36;
export function esc(value: unknown): string {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
const safeJSON = (input: unknown) => JSON.stringify(input).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026");

function cardHtml(root: string, outputDir: string, reference: Reference): string {
  const m = reference.media[0];
  let preview: string;
  if (m) {
    const src = relative(outputDir, join(root, m.thumbnail ?? m.path)).split("\\").join("/");
    preview = `<img src="${esc(src)}" alt="Saved reference preview" loading="lazy" decoding="async">`;
  } else {
    const symbol = ({ website: "↗", shadcn: "▣", x: "𝕏", screenshot: "▧" } as const)[reference.kind];
    preview = `<div class="placeholder ${esc(reference.kind)}"><div class="symbol">${symbol}</div><small>${esc(reference.kind)} reference</small></div>`;
  }
  const url = reference.source.type === "url" ? reference.source.value : relative(outputDir, join(root, m!.path)).split("\\").join("/");
  const note = reference.notes.at(-1)?.text ?? "Saved for inspiration";
  const tags = reference.tags.slice(0, 3).map(tag => `<span class="pill">${esc(tag)}</span>`).join("");
  return `<article class="card" id="${esc(reference.id)}" data-kind="${esc(reference.kind)}"><div class="preview">${preview}</div><div class="detail"><div class="cardmeta"><span>${esc(reference.kind)}</span><span class="tag">Saved</span></div><h3 title="${esc(reference.title)}">${esc(reference.title)}</h3><p class="note">${esc(note)}</p><div class="cardbottom"><span>${tags}</span><a class="open" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open ↗</a></div></div></article>`;
}

function preferenceHtml(db: Database): string {
  const rows: string[] = [];
  for (const { data } of db.query(`SELECT p.data FROM preferences p LEFT JOIN retired r ON r.preference_id=p.id
      WHERE r.preference_id IS NULL ORDER BY p.created_at DESC LIMIT 80`).iterate() as Iterable<{data:string}>) {
    const pref = JSON.parse(data) as Preference;
    const scope = pref.scope === "global" ? "Personal" : `Project / ${pref.project ?? "unknown"}`;
    rows.push(`<div class="rule"><div class="scope">${esc(scope)} · ${pref.kind === "prefer" ? "Prefer" : "Avoid"}</div><p>${esc(pref.rule)}</p></div>`);
  }
  return rows.join("") || '<div class="empty-note">No confirmed preferences yet. Save references now; feedback builds your taste over time.</div>';
}

export async function generateGallery(db: Database, root: string, output?: string): Promise<unknown> {
  const file = output ? expand(output) : join(root, "gallery.html");
  const folder = dirname(file);
  mkdirSync(folder, { recursive: true });
  const count = (db.query("SELECT COUNT(*) AS count FROM refs").get() as {count:number}).count;
  const pages = Math.max(1, Math.ceil(count / PER_PAGE));
  const prefs = preferenceHtml(db);
  const base = basename(file, extname(file));
  const ext = extname(file) || ".html";
  const searchFile = `${base}-search.js`;
  const firstFile = basename(file);
  const nameOf = (p: number) => p === 1 ? firstFile : `${base}-${p}${ext}`;
  const indexFile = join(folder, searchFile);
  const outputStream = createWriteStream(indexFile, { encoding: "utf8" });
  const writeChunk = async (chunk: string) => {
    if (!outputStream.write(chunk)) await once(outputStream, "drain");
  };
  await writeChunk("window.DM_INDEX=[\n");
  let group: Reference[] = [];
  let page = 1;
  let first = true;
  const savePage = (number: number, refs: Reference[]) => {
    const older = number < pages ? `<a href="${esc(nameOf(number + 1))}">Older references →</a>` : '<a class="disabled">Older references →</a>';
    const newer = number > 1 ? `<a href="${esc(nameOf(number - 1))}">← Newer references</a>` : '<a class="disabled">← Newer references</a>';
    const nav = `${newer}<span>${number} / ${pages}</span>${older}`;
    const cards = refs.map(ref => cardHtml(root, folder, ref)).join("\n");
    writeFileSync(join(folder, nameOf(number)), galleryTemplate({ nav, cards, preferences: prefs, count, page: number, pages, searchFile, firstFile }), "utf8");
  };
  try {
    for (const row of db.query("SELECT data,search_text FROM refs ORDER BY created_at DESC,id DESC").iterate() as Iterable<{data:string;search_text:string}>) {
      const ref = JSON.parse(row.data) as Reference;
      if (group.length === PER_PAGE) { savePage(page++, group); group = []; }
      group.push(ref);
      const entry = { i: ref.id, p: page, k: ref.kind, t: ref.title, n: (ref.notes.at(-1)?.text ?? "").slice(0, 180), s: row.search_text.slice(0, 1600) };
      await writeChunk(`${first ? "" : ",\n"}${safeJSON(entry)}`);
      first = false;
    }
    savePage(page, group);
    await writeChunk("\n];\n");
  } finally {
    outputStream.end();
    await once(outputStream, "finish");
  }
  return { written: file, references: count, pages, page_size: PER_PAGE, search_index: indexFile };
}
