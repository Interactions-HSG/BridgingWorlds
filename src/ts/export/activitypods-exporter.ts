/**
 * Live Solid ↔ Fediverse federation via ActivityPods.
 *
 * ActivityPods (https://activitypods.org) pods are Solid Pods that natively
 * speak ActivityPub: every pod owner has an AS2 actor with an inbox/outbox,
 * and activities posted to the outbox federate to followers on Mastodon
 * and the rest of the Fediverse.
 *
 * This exporter reads posts from the Solid Pod (RDF) and publishes them as
 * Create/Note activities to the ActivityPods actor's outbox. Media is NOT
 * re-uploaded anywhere: attachments reference the files by their public
 * Solid Pod URLs, so the Pod remains the single host of the data and
 * Mastodon clients fetch images straight from it.
 */

import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import {
  RdfPost,
  RdfProfile,
  readPosts,
  readProfile,
  readPostsFromPod,
  readProfileFromPod,
} from "./rdf-reader.js";
import type { SolidClient } from "../store/solid-client.js";
import type { ActivityPodsConfig } from "../config.js";

const AS_PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

interface Actor {
  id: string;
  outbox: string;
  followers: string;
}

interface ManifestEntry {
  uri: string;
  file_hash: string;
  mime_type: string;
}

/**
 * Minimal ActivityPods client: local-account login + ActivityPub C2S
 * outbox posting.
 */
export class ActivityPodsClient {
  private token = "";
  private baseUrl: string;

  constructor(private config: ActivityPodsConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
  }

  get actorUri(): string {
    return `${this.baseUrl}/${this.config.username}`;
  }

  async login(): Promise<void> {
    const response = await fetch(`${this.baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: this.config.username,
        password: this.config.password,
      }),
    });
    if (!response.ok) {
      throw new Error(
        `ActivityPods login failed: ${response.status} ${response.statusText}. ` +
          "Check ACTIVITYPODS_BASE_URL / ACTIVITYPODS_USERNAME / ACTIVITYPODS_PASSWORD."
      );
    }
    const body = (await response.json()) as { token?: string };
    if (!body.token) {
      throw new Error("ActivityPods login succeeded but returned no token");
    }
    this.token = body.token;
    console.log(`Authenticated to ActivityPods as ${this.actorUri}`);
  }

  async getActor(): Promise<Actor> {
    const response = await fetch(this.actorUri, {
      headers: {
        Accept: "application/activity+json",
        Authorization: `Bearer ${this.token}`,
      },
    });
    if (!response.ok) {
      throw new Error(
        `Failed to fetch ActivityPods actor ${this.actorUri}: ` +
          `${response.status} ${response.statusText}`
      );
    }
    const actor = (await response.json()) as Record<string, unknown>;
    return {
      id: (actor.id as string) || this.actorUri,
      outbox: (actor.outbox as string) || `${this.actorUri}/outbox`,
      followers: (actor.followers as string) || `${this.actorUri}/followers`,
    };
  }

  /** POST an activity to the actor's outbox. Returns the created activity URI. */
  async postToOutbox(outbox: string, activity: object): Promise<string> {
    const response = await fetch(outbox, {
      method: "POST",
      headers: {
        "Content-Type": "application/activity+json",
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify(activity),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Outbox POST failed: ${response.status} ${response.statusText} ${detail}`.trim()
      );
    }
    return response.headers.get("location") || "";
  }
}

/**
 * Resolve a post attachment to its public Solid Pod URL.
 * Built from the media manifest — no Pod round-trip needed, the URL
 * scheme mirrors resource-uploader's layout.
 */
function podMediaUrl(
  attUrl: string,
  manifest: ManifestEntry[],
  podBaseUrl: string,
  containerBase: string
): { url: string; mimeType: string } | null {
  const entry = manifest.find((m) => m.uri === attUrl);
  if (!entry || !podBaseUrl) return null;
  const ext = attUrl.split(".").pop() || "bin";
  const isVideo = entry.mime_type.startsWith("video/");
  const base = podBaseUrl.replace(/\/$/, "");
  return {
    url: `${base}${containerBase}media/${isVideo ? "videos" : "images"}/${entry.file_hash}.${ext}`,
    mimeType: entry.mime_type,
  };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildCreateActivity(
  post: RdfPost,
  actor: Actor,
  manifest: ManifestEntry[],
  podBaseUrl: string,
  containerBase: string
): object {
  const attachments = post.attachments
    .map((att) => {
      const resolved = podMediaUrl(att.url, manifest, podBaseUrl, containerBase);
      if (!resolved) return null;
      return {
        type: att.type === "video" ? "Video" : "Image",
        mediaType: resolved.mimeType,
        url: resolved.url,
      };
    })
    .filter((a): a is NonNullable<typeof a> => a !== null);

  const note: Record<string, unknown> = {
    type: "Note",
    attributedTo: actor.id,
    content: `<p>${escapeHtml(post.content)}</p>`,
    published: post.published,
    to: [AS_PUBLIC],
    cc: [actor.followers],
  };
  if (attachments.length > 0) {
    note.attachment = attachments;
  }

  return {
    "@context": "https://www.w3.org/ns/activitystreams",
    type: "Create",
    actor: actor.id,
    to: [AS_PUBLIC],
    cc: [actor.followers],
    object: note,
  };
}

export interface ActivityPodsExportOptions {
  rdfDir: string;
  outputDir: string;
  config: ActivityPodsConfig;
  /** Solid Pod that hosts the media files (public URLs referenced in notes). */
  podBaseUrl: string;
  containerBase: string;
  manifest: ManifestEntry[];
  /** When set, RDF is read from the Pod; otherwise from rdfDir on disk. */
  solidClient?: SolidClient;
}

export async function exportToActivityPods(
  opts: ActivityPodsExportOptions
): Promise<{ posts: number; published: number; dryRun: boolean }> {
  // ── Read source data (the Solid Pod is the source of truth) ──────
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

  if (posts.length === 0) {
    console.log("  No posts found — nothing to federate.");
    return { posts: 0, published: 0, dryRun: opts.config.dryRun };
  }
  if (!profile) {
    console.warn("  Warning: no profile found in RDF; continuing with posts only.");
  }

  const client = new ActivityPodsClient(opts.config);

  // ── Dry run: write the activities to disk, touch nothing remote ──
  if (opts.config.dryRun) {
    const outDir = join(opts.outputDir, "activitypods");
    mkdirSync(outDir, { recursive: true });
    const actor: Actor = {
      id: client.actorUri,
      outbox: `${client.actorUri}/outbox`,
      followers: `${client.actorUri}/followers`,
    };
    posts.forEach((post, i) => {
      const activity = buildCreateActivity(
        post, actor, opts.manifest, opts.podBaseUrl, opts.containerBase
      );
      writeFileSync(
        join(outDir, `create_${i}.json`),
        JSON.stringify(activity, null, 2)
      );
    });
    console.log(
      `ActivityPods dry run: wrote ${posts.length} Create activities to ${outDir}`
    );
    return { posts: posts.length, published: 0, dryRun: true };
  }

  // ── Live: authenticate and publish to the outbox ─────────────────
  await client.login();
  const actor = await client.getActor();

  let published = 0;
  for (const post of posts) {
    const activity = buildCreateActivity(
      post, actor, opts.manifest, opts.podBaseUrl, opts.containerBase
    );
    try {
      const uri = await client.postToOutbox(actor.outbox, activity);
      published++;
      console.log(`  [${published}/${posts.length}] ${uri || "published"}`);
    } catch (err) {
      console.error(`  Failed to publish post ${post.uri}: ${err}`);
    }
    await new Promise((r) => setTimeout(r, opts.config.rateLimitDelay * 1000));
  }

  console.log(
    `ActivityPods: federated ${published}/${posts.length} posts from the Pod. ` +
      `Mastodon users can follow @${opts.config.username}@${new URL(opts.config.baseUrl).host}`
  );
  return { posts: posts.length, published, dryRun: false };
}
