/**
 * Export RDF posts to Bluesky via the AT Protocol.
 *
 * Converts as:Note triples to app.bsky.feed.post Lexicon records.
 * Supports two media sources:
 *   - Local: reads images from disk (Instagram export folder)
 *   - Pod:   fetches images from a Solid Pod via SolidClient
 *
 * Supports dry-run mode (writes JSON to disk) and live posting.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "fs";
import { join, resolve } from "path";
import { BskyAgent, RichText } from "@atproto/api";
import { RdfPost, readPosts, readPostsFromPod } from "./rdf-reader.js";
import { BlueskyConfig } from "../config.js";
import type { SolidClient } from "../store/solid-client.js";

// ── Media resolution ───────────────────────────────────────────────

export interface ResolvedImage {
  data: Buffer;
  mimeType: string;
  sizeBytes: number;
  /** For dry-run output: describes where the image came from */
  source: string;
}

/**
 * Abstraction for fetching image bytes — works with local files or Pod.
 */
export interface MediaResolver {
  resolveImage(relativeUri: string): Promise<ResolvedImage | null>;
}

/**
 * Resolves media from the local Instagram export folder.
 */
export class LocalMediaResolver implements MediaResolver {
  constructor(private basePath: string) {}

  async resolveImage(relativeUri: string): Promise<ResolvedImage | null> {
    if (!relativeUri || !this.basePath) return null;

    const absPath = resolve(this.basePath, relativeUri);
    if (!existsSync(absPath)) return null;

    const sizeBytes = statSync(absPath).size;
    if (sizeBytes > 1_000_000) return null; // Bluesky 1MB limit

    return {
      data: readFileSync(absPath),
      mimeType: absPath.endsWith(".png") ? "image/png" : "image/jpeg",
      sizeBytes,
      source: absPath,
    };
  }
}

/**
 * Resolves media from a Solid Pod.
 *
 * The media manifest maps relative Instagram URIs (e.g. "media/posts/202207/xxx.jpg")
 * to Pod paths (e.g. "/social/media/images/abc123def456.jpg") via file hashes.
 */
export class PodMediaResolver implements MediaResolver {
  private hashMap: Map<string, { podPath: string; mimeType: string }>;

  constructor(
    private client: SolidClient,
    private containerBase: string,
    manifest: { uri: string; file_hash: string; mime_type: string }[]
  ) {
    // Build a lookup: relative URI → Pod path
    this.hashMap = new Map();
    for (const entry of manifest) {
      const ext = entry.uri.split(".").pop() || "bin";
      const isVideo = entry.mime_type.startsWith("video/");
      const podPath = `${containerBase}media/${isVideo ? "videos" : "images"}/${entry.file_hash}.${ext}`;
      this.hashMap.set(entry.uri, { podPath, mimeType: entry.mime_type });
    }
  }

  async resolveImage(relativeUri: string): Promise<ResolvedImage | null> {
    if (!relativeUri) return null;

    const mapping = this.hashMap.get(relativeUri);
    if (!mapping) return null;
    if (mapping.mimeType.startsWith("video/")) return null; // Bluesky images only

    try {
      const { data, contentType } = await this.client.readBinary(mapping.podPath);
      if (data.length > 1_000_000) return null; // Bluesky 1MB limit

      return {
        data,
        mimeType: contentType,
        sizeBytes: data.length,
        source: `pod:${mapping.podPath}`,
      };
    } catch {
      return null;
    }
  }
}

// ── Bluesky record types ───────────────────────────────────────────

export interface BlueskyImageEmbed {
  $type: "app.bsky.embed.images";
  images: {
    alt: string;
    image: unknown;
  }[];
}

export interface BlueskyRecord {
  $type: "app.bsky.feed.post";
  text: string;
  createdAt: string;
  facets?: unknown[];
  embed?: BlueskyImageEmbed;
}

// ── Helpers ────────────────────────────────────────────────────────

function truncateText(text: string, maxLength: number): string {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const segments = [...segmenter.segment(text)];
  if (segments.length <= maxLength) return text;
  return (
    segments
      .slice(0, maxLength - 1)
      .map((s) => s.segment)
      .join("") + "…"
  );
}

async function resolvePostImages(
  post: RdfPost,
  resolver: MediaResolver
): Promise<ResolvedImage[]> {
  const images: ResolvedImage[] = [];
  for (const att of post.attachments) {
    if (att.type !== "image" || !att.url) continue;
    const img = await resolver.resolveImage(att.url);
    if (img) images.push(img);
    if (images.length >= 4) break; // Bluesky max 4
  }
  return images;
}

async function postToRecord(
  post: RdfPost,
  config: BlueskyConfig,
  resolver: MediaResolver,
  agent?: BskyAgent
): Promise<BlueskyRecord> {
  let text = post.content || "(no caption)";
  text = truncateText(text, config.maxTextLength);

  const rt = new RichText({ text });
  if (agent) {
    await rt.detectFacets(agent);
  }

  const record: BlueskyRecord = {
    $type: "app.bsky.feed.post",
    text: rt.text,
    createdAt: post.published || new Date().toISOString(),
  };

  if (rt.facets && rt.facets.length > 0) {
    record.facets = rt.facets;
  }

  const images = await resolvePostImages(post, resolver);

  if (images.length > 0) {
    if (agent) {
      // Live mode: upload blobs to Bluesky
      const uploaded: { alt: string; image: unknown }[] = [];
      for (const img of images) {
        const response = await agent.uploadBlob(img.data, {
          encoding: img.mimeType,
        });
        uploaded.push({
          alt: post.content?.slice(0, 100) || "",
          image: response.data.blob,
        });
      }
      if (uploaded.length > 0) {
        record.embed = { $type: "app.bsky.embed.images", images: uploaded };
      }
    } else {
      // Dry-run: include metadata showing what would be uploaded
      record.embed = {
        $type: "app.bsky.embed.images",
        images: images.map((img) => ({
          alt: post.content?.slice(0, 100) || "",
          image: {
            $type: "dry-run/resolved-image",
            source: img.source,
            mimeType: img.mimeType,
            sizeBytes: img.sizeBytes,
          },
        })),
      };
    }
  }

  return record;
}

// ── Public API ─────────────────────────────────────────────────────

export interface ExportOptions {
  /** Local .ttl directory (used when source = "local") */
  rdfDir: string;
  outputDir: string;
  config: BlueskyConfig;
  /** Resolves media URIs to image bytes (local or Pod) */
  resolver: MediaResolver;
  /** If provided, read posts from Pod instead of local files */
  solidClient?: SolidClient;
}

export async function exportToBluesky(
  opts: ExportOptions
): Promise<{ total: number; exported: number; withImages: number; errors: number }> {
  const { rdfDir, outputDir, config, resolver, solidClient } = opts;

  // Read posts from Pod or from local .ttl files
  const posts = solidClient
    ? await readPostsFromPod(solidClient)
    : readPosts(rdfDir);

  const source = solidClient ? "Solid Pod" : `local (${rdfDir})`;
  console.log(`Found ${posts.length} posts from ${source}`);

  let agent: BskyAgent | undefined;
  if (!config.dryRun) {
    agent = new BskyAgent({ service: "https://bsky.social" });
    await agent.login({
      identifier: config.handle,
      password: config.appPassword,
    });
    console.log(`Authenticated as ${config.handle}`);
  }

  const dryRunDir = join(outputDir, "bluesky");
  if (config.dryRun) {
    mkdirSync(dryRunDir, { recursive: true });
  }

  let exported = 0;
  let withImages = 0;
  let errors = 0;

  for (const post of posts) {
    try {
      const record = await postToRecord(post, config, resolver, agent);

      if (record.embed) withImages++;

      if (config.dryRun) {
        writeFileSync(
          join(dryRunDir, `post_${exported}.json`),
          JSON.stringify(record, null, 2)
        );
      } else {
        await agent!.post({
          text: record.text,
          createdAt: record.createdAt,
          facets: record.facets as any,
          embed: record.embed as any,
        });

        if (config.rateLimitDelay > 0) {
          await new Promise((r) =>
            setTimeout(r, config.rateLimitDelay * 1000)
          );
        }
      }

      exported++;
    } catch (err) {
      console.error(`Error exporting post: ${err}`);
      errors++;
    }
  }

  const mode = config.dryRun ? "Dry-run" : "Posted";
  console.log(`${mode}: ${exported} records (${withImages} with images)`);

  return { total: posts.length, exported, withImages, errors };
}
