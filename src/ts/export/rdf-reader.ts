/**
 * Read and query RDF Turtle files using N3.js.
 *
 * Supports two data sources:
 *   - Local: reads .ttl files from disk (output/rdf/)
 *   - Pod:   fetches .ttl resources from a Solid Pod via SolidClient
 *
 * Both paths produce the same RdfPost/RdfProfile/RdfFollow structures.
 */

import { readFileSync, existsSync } from "fs";
import { Store, Parser, DataFactory } from "n3";
import type { SolidClient } from "../store/solid-client.js";

const { namedNode } = DataFactory;

const AS = "https://www.w3.org/ns/activitystreams#";
const FOAF = "http://xmlns.com/foaf/0.1/";
const BW = "https://bridgingworlds.io/ns#";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

export interface RdfPost {
  uri: string;
  content: string;
  published: string;
  attachments: { type: string; url: string }[];
  geo?: { lat: number; lng: number };
  contentType?: string;
}

export interface RdfProfile {
  uri: string;
  username: string;
  bio: string;
  homepage: string;
}

export interface RdfFollow {
  username: string;
  profileUrl: string;
  timestamp: string;
}

// ── Turtle → N3 Store helpers ──────────────────────────────────────

function parseTurtle(turtle: string): Store {
  const store = new Store();
  const parser = new Parser();
  store.addQuads(parser.parse(turtle));
  return store;
}

function parseFile(filePath: string): Store {
  if (!existsSync(filePath)) return new Store();
  return parseTurtle(readFileSync(filePath, "utf-8"));
}

function getObject(store: Store, subject: string, predicate: string): string {
  let quads = store.getQuads(namedNode(subject), namedNode(predicate), null, null);
  if (quads.length === 0) {
    const bnId = subject.replace(/^_:/, "");
    quads = store.getQuads(
      DataFactory.blankNode(bnId),
      namedNode(predicate),
      null,
      null
    );
  }
  return quads.length > 0 ? quads[0].object.value : "";
}

function getObjects(store: Store, subject: string, predicate: string): string[] {
  let quads = store.getQuads(namedNode(subject), namedNode(predicate), null, null);
  if (quads.length === 0) {
    const bnId = subject.replace(/^_:/, "");
    quads = store.getQuads(
      DataFactory.blankNode(bnId),
      namedNode(predicate),
      null,
      null
    );
  }
  return quads.map((q) => q.object.value);
}

// ── Extract structured data from an N3 Store ───────────────────────

function extractPosts(store: Store): RdfPost[] {
  const posts: RdfPost[] = [];
  const noteQuads = store.getQuads(null, namedNode(RDF_TYPE), namedNode(`${AS}Note`), null);

  for (const quad of noteQuads) {
    const uri = quad.subject.value;
    const contentType = getObject(store, uri, `${BW}contentType`);
    const content = getObject(store, uri, `${AS}content`);
    const published = getObject(store, uri, `${AS}published`);

    const attachmentUris = getObjects(store, uri, `${AS}attachment`);
    const attachments = attachmentUris.map((attUri) => {
      const types = getObjects(store, attUri, RDF_TYPE);
      const isVideo = types.some((t) => t === `${AS}Video`);
      const url = getObject(store, attUri, `${AS}url`);
      return { type: isVideo ? "video" : "image", url };
    });

    posts.push({
      uri,
      content,
      published,
      attachments,
      contentType: contentType || "post",
    });
  }

  return posts.sort(
    (a, b) => new Date(a.published).getTime() - new Date(b.published).getTime()
  );
}

function extractProfile(store: Store): RdfProfile | null {
  const personQuads = store.getQuads(
    null, namedNode(RDF_TYPE), namedNode(`${FOAF}Person`), null
  );
  if (personQuads.length === 0) return null;

  const uri = personQuads[0].subject.value;
  return {
    uri,
    username: getObject(store, uri, `${FOAF}accountName`),
    bio: getObject(store, uri, `${AS}summary`),
    homepage: getObject(store, uri, `${FOAF}homepage`),
  };
}

function extractFollowing(store: Store): RdfFollow[] {
  const follows: RdfFollow[] = [];
  const followQuads = store.getQuads(
    null, namedNode(RDF_TYPE), namedNode(`${AS}Follow`), null
  );

  for (const quad of followQuads) {
    const uri = quad.subject.value;
    const objectUri = getObject(store, uri, `${AS}object`);
    const username = getObject(store, objectUri, `${FOAF}accountName`);
    const profileUrl = getObject(store, objectUri, `${FOAF}homepage`);
    const timestamp = getObject(store, uri, `${AS}published`);
    if (username) {
      follows.push({ username, profileUrl, timestamp });
    }
  }
  return follows;
}

// ── Local file readers (original API, kept for backwards compat) ───

export function readPosts(rdfDir: string): RdfPost[] {
  return extractPosts(parseFile(`${rdfDir}/posts.ttl`));
}

export function readProfile(rdfDir: string): RdfProfile | null {
  return extractProfile(parseFile(`${rdfDir}/profile.ttl`));
}

export function readFollowing(rdfDir: string): RdfFollow[] {
  return extractFollowing(parseFile(`${rdfDir}/following.ttl`));
}

// ── Pod-based readers ──────────────────────────────────────────────

/** Pod path mapping — public-only, mirrors resource-uploader's TTL_TO_CONTAINER */
const POD_PATHS = {
  posts: "/social/posts/posts.ttl",
  profile: "/profile/card.ttl",
  following: "/social/following/following.ttl",
  followers: "/social/followers/followers.ttl",
  stories: "/social/stories/stories.ttl",
};

async function fetchAndParse(client: SolidClient, podPath: string): Promise<Store> {
  try {
    const turtle = await client.readResource(podPath);
    return parseTurtle(turtle);
  } catch (err) {
    console.warn(`Could not read ${podPath} from Pod: ${err}`);
    return new Store();
  }
}

export async function readPostsFromPod(client: SolidClient): Promise<RdfPost[]> {
  const store = await fetchAndParse(client, POD_PATHS.posts);
  return extractPosts(store);
}

export async function readProfileFromPod(client: SolidClient): Promise<RdfProfile | null> {
  const store = await fetchAndParse(client, POD_PATHS.profile);
  return extractProfile(store);
}

export async function readFollowingFromPod(client: SolidClient): Promise<RdfFollow[]> {
  const store = await fetchAndParse(client, POD_PATHS.following);
  return extractFollowing(store);
}
