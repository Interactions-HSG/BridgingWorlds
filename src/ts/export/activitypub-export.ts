/**
 * Export RDF data as ActivityPub JSON-LD objects (proof-of-concept).
 *
 * Mastodon does NOT support post import, so these objects serve as
 * a demonstration that the RDF data can be expressed in AP format.
 * For actual Solid↔Fediverse federation, use activitypods-exporter.ts.
 *
 * Supports two sources:
 *   - Local: reads .ttl from disk, resolves media to local paths
 *   - Pod:   reads .ttl from Pod, uses Pod URLs for media attachments
 */

import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join, resolve } from "path";
import {
  RdfPost,
  RdfProfile,
  readPosts,
  readProfile,
  readPostsFromPod,
  readProfileFromPod,
} from "./rdf-reader.js";
import type { SolidClient } from "../store/solid-client.js";

interface ActivityPubNote {
  "@context": string;
  id: string;
  type: "Note";
  attributedTo: string;
  content: string;
  published: string;
  to: string[];
  attachment?: {
    type: string;
    mediaType: string;
    url: string;
  }[];
}

interface ActivityPubActor {
  "@context": string;
  id: string;
  type: "Person";
  preferredUsername: string;
  summary: string;
  url: string;
}

/**
 * Resolve attachment URLs.
 * - Local mode: resolves relative paths against mediaBasePath
 * - Pod mode:   uses Pod public URLs for media
 */
interface AttachmentResolver {
  resolve(att: { type: string; url: string }): string | null;
}

class LocalAttachmentResolver implements AttachmentResolver {
  constructor(private basePath: string) {}
  resolve(att: { type: string; url: string }): string | null {
    if (!att.url || !this.basePath) return null;
    const absPath = resolve(this.basePath, att.url);
    return existsSync(absPath) ? absPath : null;
  }
}

class PodAttachmentResolver implements AttachmentResolver {
  constructor(
    private client: SolidClient,
    private containerBase: string,
    private manifest: { uri: string; file_hash: string; mime_type: string }[]
  ) {}

  resolve(att: { type: string; url: string }): string | null {
    if (!att.url) return null;
    const entry = this.manifest.find((m) => m.uri === att.url);
    if (!entry) return null;
    const ext = att.url.split(".").pop() || "bin";
    const isVideo = entry.mime_type.startsWith("video/");
    const podPath = `${this.containerBase}media/${isVideo ? "videos" : "images"}/${entry.file_hash}.${ext}`;
    return this.client.getPublicUrl(podPath);
  }
}

function postToActivityPub(
  post: RdfPost,
  profile: RdfProfile,
  resolver: AttachmentResolver
): ActivityPubNote {
  const note: ActivityPubNote = {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: post.uri,
    type: "Note",
    attributedTo: profile.uri,
    content: `<p>${escapeHtml(post.content)}</p>`,
    published: post.published,
    to: ["https://www.w3.org/ns/activitystreams#Public"],
  };

  const resolved = post.attachments
    .map((att) => ({ att, url: resolver.resolve(att) }))
    .filter((r): r is { att: typeof r.att; url: string } => r.url !== null);

  if (resolved.length > 0) {
    note.attachment = resolved.map(({ att, url }) => ({
      type: "Document",
      mediaType: att.type === "video" ? "video/mp4" : "image/jpeg",
      url,
    }));
  }

  return note;
}

function profileToActor(profile: RdfProfile): ActivityPubActor {
  return {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: profile.uri,
    type: "Person",
    preferredUsername: profile.username,
    summary: profile.bio,
    url: profile.homepage,
  };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export interface ActivityPubExportOptions {
  rdfDir: string;
  outputDir: string;
  mediaBasePath: string;
  solidClient?: SolidClient;
  containerBase?: string;
  manifest?: { uri: string; file_hash: string; mime_type: string }[];
}

export async function exportActivityPub(
  opts: ActivityPubExportOptions
): Promise<{ posts: number; hasActor: boolean }> {
  const outDir = join(opts.outputDir, "activitypub");
  mkdirSync(outDir, { recursive: true });

  // Read data from Pod or local files
  let profile: RdfProfile | null;
  let posts: RdfPost[];

  if (opts.solidClient) {
    console.log("  Reading from Solid Pod...");
    [profile, posts] = await Promise.all([
      readProfileFromPod(opts.solidClient),
      readPostsFromPod(opts.solidClient),
    ]);
  } else {
    profile = readProfile(opts.rdfDir);
    posts = readPosts(opts.rdfDir);
  }

  // Build attachment resolver
  const resolver: AttachmentResolver =
    opts.solidClient && opts.manifest && opts.containerBase
      ? new PodAttachmentResolver(opts.solidClient, opts.containerBase, opts.manifest)
      : new LocalAttachmentResolver(opts.mediaBasePath);

  if (profile) {
    const actor = profileToActor(profile);
    writeFileSync(join(outDir, "actor.json"), JSON.stringify(actor, null, 2));
  }

  for (let i = 0; i < posts.length; i++) {
    if (!profile) continue;
    const note = postToActivityPub(posts[i], profile, resolver);
    writeFileSync(join(outDir, `note_${i}.json`), JSON.stringify(note, null, 2));
  }

  const source = opts.solidClient ? "Pod" : "local";
  console.log(
    `ActivityPub: exported ${posts.length} notes + actor from ${source} to ${outDir}`
  );

  return { posts: posts.length, hasActor: !!profile };
}
