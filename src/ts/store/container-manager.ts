/**
 * Manages the LDP container hierarchy on a Solid Pod.
 *
 * Creates the directory structure for *public* social data storage. Private
 * categories (likes, messages, saved, searches) are intentionally absent —
 * the public-only conversion policy means no triples for those types ever
 * reach the Pod, so the containers are not created either.
 */

import { SolidClient } from "./solid-client.js";

/** The container hierarchy to create on the Pod. */
const CONTAINER_TREE = [
  "/profile/",
  "/social/",
  "/social/posts/",
  "/social/stories/",
  "/social/followers/",
  "/social/following/",
  "/social/media/",
  "/social/media/images/",
  "/social/media/videos/",
  "/settings/",
];

export async function createContainerHierarchy(
  client: SolidClient,
  containerBase: string
): Promise<string[]> {
  const created: string[] = [];

  for (const container of CONTAINER_TREE) {
    const path = containerBase === "/social/"
      ? container
      : container.replace("/social/", containerBase);

    try {
      const isNew = await client.createContainer(path);
      if (isNew) {
        created.push(path);
        console.log(`  Created: ${path}`);
      }
    } catch (err) {
      console.warn(`  Warning: Could not create ${path}: ${err}`);
    }
  }

  return created;
}
