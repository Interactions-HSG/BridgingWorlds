/**
 * Register content types in the Solid Pod's Type Index.
 */

import { SolidClient } from "./solid-client.js";

// Public-only type registrations. Likes, message threads, saved, and searches
// are deliberately absent — these are private to the account holder on the
// source platform and never converted to RDF.
const TYPE_INDEX_TURTLE = `@prefix solid: <http://www.w3.org/ns/solid/terms#> .
@prefix as: <https://www.w3.org/ns/activitystreams#> .
@prefix sioc: <http://rdfs.org/sioc/ns#> .
@prefix schema: <https://schema.org/> .
@prefix foaf: <http://xmlns.com/foaf/0.1/> .

<> a solid:TypeIndex, solid:UnlistedDocument .

<#posts> a solid:TypeRegistration ;
    solid:forClass as:Note ;
    solid:instanceContainer </social/posts/> .

<#follows> a solid:TypeRegistration ;
    solid:forClass as:Follow ;
    solid:instanceContainer </social/following/> .

<#images> a solid:TypeRegistration ;
    solid:forClass schema:ImageObject ;
    solid:instanceContainer </social/media/images/> .

<#stories> a solid:TypeRegistration ;
    solid:forClass as:Note ;
    solid:instanceContainer </social/stories/> .
`;

export async function registerTypeIndex(
  client: SolidClient
): Promise<void> {
  try {
    await client.uploadTurtle(
      "/settings/privateTypeIndex.ttl",
      TYPE_INDEX_TURTLE
    );
    console.log("  Registered type index");
  } catch (err) {
    console.error(`  Error registering type index: ${err}`);
  }
}
