import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";
import { pipeline } from "node:stream/promises";
import { spawnSync } from "node:child_process";
import type { Kind, Media } from "./db.ts";
import { expand } from "./db.ts";

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"]);
const TRACKING = new Set(["fbclid", "gclid", "igshid", "ref_src", "s", "t", "si"]);

export function urlDetails(source: string): { kind: Kind; key: string; title: string } {
  let url: URL;
  try { url = new URL(source); } catch { throw new Error("Use a valid http(s) URL or a local image file"); }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new Error("Use a valid http(s) URL without embedded credentials or a local image file");
  }
  let host = url.hostname.toLowerCase().replace(/^www\./, "");
  const path = url.pathname.replace(/\/+$/, "") || "/";
  for (const name of [...url.searchParams.keys()]) {
    const key = name.toLowerCase();
    if (TRACKING.has(key) || key.startsWith("utm_")) url.searchParams.delete(name);
  }
  let kind: Kind;
  if (["x.com", "twitter.com", "mobile.twitter.com"].includes(host) && /\/status\/\d+/.test(path)) {
    kind = "x"; host = "x.com"; url.search = "";
  } else if (host === "ui.shadcn.com" || host.endsWith(".shadcn.com") || host.includes("shadcn")) kind = "shadcn";
  else kind = "website";
  const key = `https://${host}${path}${url.search}`;
  let title = host + (path === "/" ? "" : ` / ${path.split("/").filter(Boolean).at(-1)}`);
  if (kind === "x") title = `X post by @${path.match(/\/([^/]+)\/status\/\d+/)?.[1] ?? "unknown"}`;
  if (kind === "shadcn") title = `shadcn — ${(path.split("/").filter(Boolean).at(-1) ?? "component").replaceAll("-", " ")}`;
  return { kind, key, title };
}

function commandExists(name: string): boolean {
  const path = process.env.PATH ?? "";
  for (const dir of path.split(":")) {
    try { if (statSync(join(dir, name)).isFile()) return true; } catch { /* not present */ }
  }
  return false;
}

function thumbnail(source: string, target: string): boolean {
  if (existsSync(target)) return true;
  if (statSync(source).size > 70_000_000) return false;
  mkdirSync(dirname(target), { recursive: true });
  const temp = `${target}.${randomBytes(4).toString("hex")}.jpg`;
  try {
    let args: string[];
    let program: string;
    if (process.platform === "darwin" && commandExists("sips")) {
      program = "sips";
      args = ["-s", "format", "jpeg", "-Z", "560", source, "--out", temp];
    } else if (commandExists("magick") || commandExists("convert")) {
      program = commandExists("magick") ? "magick" : "convert";
      args = ["-limit", "memory", "64MiB", "-limit", "map", "128MiB", "-limit", "disk", "256MiB", source,
        "-auto-orient", "-thumbnail", "560x420>", "-background", "#e8e7e5", "-alpha", "remove", "-quality", "75", temp];
    } else return false;
    const result = spawnSync(program, args, { timeout: 20_000, stdio: "ignore" });
    if (result.status !== 0 || !existsSync(temp) || statSync(temp).size === 0) return false;
    renameSync(temp, target);
    return true;
  } catch { return false; }
  finally { if (existsSync(temp)) unlinkSync(temp); }
}

/** Commit a streamed upload without rereading/copying the image. */
export function finalizeUploadedMedia(root: string, tmp: string, sha256: string, filename: string): Media {
  const extension=extname(filename).toLowerCase();
  if (!IMAGE_EXTS.has(extension) || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Invalid image upload");
  const destination=join(root,"media",sha256+extension);
  mkdirSync(dirname(destination),{recursive:true});
  if (!existsSync(destination)) renameSync(tmp,destination);
  else if (existsSync(tmp)) unlinkSync(tmp);
  const media:Media={sha256,path:relative(root,destination).split("\\").join("/"),original_filename:basename(filename)};
  const thumb=join(root,"thumbs",sha256+".jpg");
  if(thumbnail(destination,thumb)) media.thumbnail=relative(root,thumb).split("\\").join("/");
  return media;
}

/** Hash and copy in streams: no original image buffers retained in Bun heap. */
export async function addMedia(root: string, file: string): Promise<Media> {
  const source = expand(file);
  const extension = extname(source).toLowerCase();
  if (!IMAGE_EXTS.has(extension)) throw new Error(`Not a supported local image file: ${file}`);
  try { if (!(await stat(source)).isFile()) throw new Error("not file"); }
  catch { throw new Error(`Not a supported local image file: ${file}`); }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(source, { highWaterMark: 1024 * 1024 })) hash.update(chunk);
  const sha256 = hash.digest("hex");
  const destination = join(root, "media", sha256 + extension);
  mkdirSync(dirname(destination), { recursive: true });
  if (!existsSync(destination)) {
    const tmp = `${destination}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await pipeline(createReadStream(source, { highWaterMark: 1024 * 1024 }), createWriteStream(tmp, { flags: "wx" }));
      // Replace is atomic on same filesystem. Originals can be deleted after ingestion.
      renameSync(tmp, destination);
    } finally { if (existsSync(tmp)) unlinkSync(tmp); }
  }
  const result: Media = { sha256, path: relative(root, destination).split("\\").join("/"), original_filename: basename(source) };
  const thumb = join(root, "thumbs", sha256 + ".jpg");
  if (thumbnail(destination, thumb)) result.thumbnail = relative(root, thumb).split("\\").join("/");
  return result;
}

export function cleanTags(inputs: string[]): string[] {
  return [...new Set(inputs.flatMap(input => input.split(",")).map(t => t.trim().toLowerCase()).filter(Boolean))];
}
