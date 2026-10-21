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

const X_HOSTS = new Set(["x.com", "twitter.com", "mobile.twitter.com"]);
const X_STATUS_PATH = /\/status\/\d+/;

function parseHttpUrl(source: string): URL {
  if (!URL.canParse(source)) throw new Error("Use a valid http(s) URL or a local image file");
  const url = new URL(source);
  const unsafe = !["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password;
  if (unsafe) throw new Error("Use a valid http(s) URL without embedded credentials or a local image file");
  return url;
}
function stripTracking(url: URL): void {
  for (const name of [...url.searchParams.keys()]) {
    const key = name.toLowerCase();
    if (TRACKING.has(key) || key.startsWith("utm_")) url.searchParams.delete(name);
  }
}
function classifyUrl(host: string, path: string): Kind {
  if (X_HOSTS.has(host) && X_STATUS_PATH.test(path)) return "x";
  return host.includes("shadcn") ? "shadcn" : "website";
}
const lastSegment = (path: string) => path.split("/").filter(Boolean).at(-1);
function urlTitle(kind: Kind, host: string, path: string): string {
  if (kind === "x") return `X post by @${path.match(/\/([^/]+)\/status\/\d+/)?.[1] ?? "unknown"}`;
  if (kind === "shadcn") return `shadcn — ${(lastSegment(path) ?? "component").replaceAll("-", " ")}`;
  return host + (path === "/" ? "" : ` / ${lastSegment(path)}`);
}
export function urlDetails(source: string): { kind: Kind; key: string; title: string } {
  const url = parseHttpUrl(source);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  stripTracking(url);
  const kind = classifyUrl(url.hostname.toLowerCase().replace(/^www\./, ""), path);
  const host = kind === "x" ? "x.com" : url.hostname.toLowerCase().replace(/^www\./, "");
  if (kind === "x") url.search = "";
  return { kind, key: `https://${host}${path}${url.search}`, title: urlTitle(kind, host, path) };
}

function commandExists(name: string): boolean {
  const path = process.env.PATH ?? "";
  for (const dir of path.split(":")) {
    const candidate = join(dir, name);
    if (existsSync(candidate) && statSync(candidate).isFile()) return true;
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
