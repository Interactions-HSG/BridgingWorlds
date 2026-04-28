/**
 * Upload RDF and binary resources to a Solid Pod.
 *
 * Reads .ttl files from the local output directory and uploads them
 * to the appropriate Pod containers. Optionally uploads media files.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { SolidClient } from "./solid-client.js";

interface MediaManifestEntry {
  uri: string;
  local_path: string;
  mime_type: string;
  file_hash: string;
  size_bytes: number;
}

// Public-only allowlist. Keep this in sync with the builders dict in
// src/python/bridging_worlds/convert/graph_builder.py::convert_all.
// Excluded categories (likes, comments, messages, saved, searches) are never
// converted to RDF and therefore never uploaded to the Pod.
const TTL_TO_CONTAINER: Record<string, string> = {
  "profile.ttl": "/profile/card.ttl",
  "posts.ttl": "/social/posts/posts.ttl",
  "followers.ttl": "/social/followers/followers.ttl",
  "following.ttl": "/social/following/following.ttl",
  "stories.ttl": "/social/stories/stories.ttl",
};

export async function uploadRdfResources(
  client: SolidClient,
  rdfDir: string,
  containerBase: string
): Promise<number> {
  let count = 0;

  for (const [filename, podPath] of Object.entries(TTL_TO_CONTAINER)) {
    const localPath = join(rdfDir, filename);
    if (!existsSync(localPath)) continue;

    const content = readFileSync(localPath, "utf-8");
    const targetPath =
      containerBase === "/social/"
        ? podPath
        : podPath.replace("/social/", containerBase);

    try {
      await client.uploadTurtle(targetPath, content);
      count++;
      console.log(`  Uploaded: ${filename} -> ${targetPath}`);
    } catch (err) {
      console.error(`  Error uploading ${filename}: ${err}`);
    }
  }

  return count;
}

export interface MediaFilter {
  /** Categories to include, matched against the URI's first path segment after "media/".
   *  Examples: "posts", "stories", "reels", "profile". Empty = all. */
  categories?: string[];
  /** MIME top-levels to include. Examples: "image", "video". Empty = all. */
  types?: string[];
}

export async function uploadMediaFiles(
  client: SolidClient,
  rdfDir: string,
  containerBase: string,
  batchSize = 50,
  filter: MediaFilter = {}
): Promise<number> {
  const manifestPath = join(rdfDir, "media_manifest.json");
  if (!existsSync(manifestPath)) {
    console.warn("No media manifest found, skipping media upload");
    return 0;
  }

  const manifest: MediaManifestEntry[] = JSON.parse(
    readFileSync(manifestPath, "utf-8")
  );

  const cats = filter.categories?.length ? new Set(filter.categories) : null;
  const types = filter.types?.length ? new Set(filter.types) : null;

  const filtered = manifest.filter((entry) => {
    if (cats) {
      const cat = entry.uri.split("/")[1] || "";
      if (!cats.has(cat)) return false;
    }
    if (types) {
      const top = entry.mime_type.split("/")[0];
      if (!types.has(top)) return false;
    }
    return true;
  });

  if (filtered.length < manifest.length) {
    console.log(
      `  Filtered ${manifest.length} → ${filtered.length} files ` +
        `(categories=${[...(cats ?? ["*"])].join(",")}, types=${[...(types ?? ["*"])].join(",")})`
    );
  }

  let count = 0;
  for (let i = 0; i < filtered.length; i += batchSize) {
    const batch = filtered.slice(i, i + batchSize);

    for (const entry of batch) {
      if (!existsSync(entry.local_path)) continue;

      const ext = entry.local_path.split(".").pop() || "bin";
      const isVideo = entry.mime_type.startsWith("video/");
      const podPath = `${containerBase}media/${isVideo ? "videos" : "images"}/${entry.file_hash}.${ext}`;

      try {
        const content = readFileSync(entry.local_path);
        await client.uploadBinary(podPath, content, entry.mime_type);
        count++;
      } catch (err) {
        console.error(`  Error uploading media ${entry.file_hash}: ${err}`);
      }
    }

    console.log(
      `  Media batch ${Math.floor(i / batchSize) + 1}: uploaded ${count} files`
    );
  }

  return count;
}
