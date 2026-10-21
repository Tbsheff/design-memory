import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import type { Media, XPost } from "./db.ts";
import { addMedia } from "./media.ts";

const SYNDICATION_URL = "https://cdn.syndication.twimg.com/tweet-result";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGES = 4;
const IMAGE_HOSTS = new Set(["pbs.twimg.com"]);

type Syndicated = {
  __typename?: string;
  id_str?: string;
  text?: string;
  created_at?: string;
  display_text_range?: [number, number];
  user?: { screen_name?: string; name?: string };
  entities?: { urls?: { url: string; expanded_url: string }[]; media?: { url: string }[] };
  mediaDetails?: { type?: string; media_url_https?: string }[];
  note_tweet?: { text?: string };
  quoted_tweet?: Syndicated;
};

export const xPostId = (key: string): string | undefined => key.match(/\/status\/(\d+)/)?.[1];

const syndicationToken = (id: string) => ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");

function readableText(post: Syndicated): string {
  let text = post.note_tweet?.text ?? post.text ?? "";
  const range = post.display_text_range;
  if (!post.note_tweet && range) text = [...text].slice(range[0], range[1]).join("");
  for (const link of post.entities?.urls ?? []) text = text.replaceAll(link.url, link.expanded_url);
  for (const link of post.entities?.media ?? []) text = text.replaceAll(link.url, "");
  return text.trim();
}

const syndicationBase = () => process.env.TASTE_X_SYNDICATION_URL ?? SYNDICATION_URL;
const trustedImageHosts = () => new Set([...IMAGE_HOSTS, new URL(syndicationBase()).hostname]);

const isXImageUrl = (url: string | undefined): url is string =>
  !!url && URL.canParse(url) && trustedImageHosts().has(new URL(url).hostname);

function imageUrls(post: Syndicated): string[] {
  const urls = (post.mediaDetails ?? []).map(media => media.media_url_https).filter(isXImageUrl);
  return [...new Set(urls)].slice(0, MAX_IMAGES);
}

export async function fetchXPost(id: string): Promise<{ post: XPost; images: string[] }> {
  const url = `${syndicationBase()}?id=${id}&lang=en&token=${syndicationToken(id)}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (response.status === 404) throw new Error("post is private, deleted, or does not exist");
  if (!response.ok) throw new Error(`X returned HTTP ${response.status}`);
  const data = await response.json() as Syndicated;
  if (data.__typename === "TweetTombstone" || !data.user?.screen_name) throw new Error("post is not publicly available");
  const quoted = data.quoted_tweet?.user?.screen_name
    ? { author: data.quoted_tweet.user.screen_name, text: readableText(data.quoted_tweet) }
    : undefined;
  const post: XPost = {
    author: data.user.screen_name,
    name: data.user.name ?? data.user.screen_name,
    text: readableText(data),
    created_at: data.created_at ?? "",
    fetched_at: new Date().toISOString(),
    ...(quoted ? { quoted } : {}),
  };
  return { post, images: [...imageUrls(data), ...(data.quoted_tweet ? imageUrls(data.quoted_tweet) : [])].slice(0, MAX_IMAGES) };
}

async function downloadImage(root: string, url: string): Promise<Media> {
  const original = new URL(url);
  original.searchParams.set("name", "orig");
  const response = await fetch(original, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`image download failed with HTTP ${response.status}`);
  if (Number(response.headers.get("content-length") ?? 0) > MAX_IMAGE_BYTES) throw new Error("image is too large");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("image is too large");
  const name = basename(new URL(url).pathname);
  const dir = mkdtempSync(join(tmpdir(), "taste-x-"));
  try {
    const file = join(dir, extname(name) ? name : `${name}.jpg`);
    writeFileSync(file, bytes);
    return await addMedia(root, file);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export async function ingestXPost(root: string, key: string): Promise<{ post: XPost; media: Media[]; warnings: string[] }> {
  const id = xPostId(key);
  if (!id) throw new Error("link has no post ID");
  const { post, images } = await fetchXPost(id);
  const downloads = await Promise.allSettled(images.map(url => downloadImage(root, url)));
  const media: Media[] = [];
  const warnings: string[] = [];
  downloads.forEach((result, index) => {
    if (result.status === "fulfilled") media.push(result.value);
    else warnings.push(`Could not save image ${images[index]}: ${(result.reason as Error).message}`);
  });
  return { post, media, warnings };
}
