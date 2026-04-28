/**
 * Export following list as Mastodon-compatible CSV.
 *
 * Mastodon supports importing follows, blocks, and mutes via CSV.
 * The follows CSV format expects an "Account address" column with
 * user@instance format. Since Instagram users don't have Fediverse
 * addresses, we output the Instagram username as a reference.
 */

import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { readFollowing, RdfFollow } from "./rdf-reader.js";

export function exportFollowingCsv(
  rdfDir: string,
  outputDir: string
): number {
  const following = readFollowing(rdfDir);

  const outDir = join(outputDir, "mastodon");
  mkdirSync(outDir, { recursive: true });

  // Mastodon CSV format: Account address,Show boosts,Notify on new posts,Languages
  const lines = [
    "Account address,Show boosts,Notify on new posts,Languages",
  ];

  for (const follow of following) {
    // Instagram users don't have Fediverse addresses, so we use
    // a placeholder format that documents the original account
    const address = `${follow.username}@instagram.com`;
    lines.push(`${address},true,false,`);
  }

  const csvPath = join(outDir, "following_accounts.csv");
  writeFileSync(csvPath, lines.join("\n"));

  console.log(
    `Mastodon CSV: exported ${following.length} follows to ${csvPath}`
  );
  console.log(
    "  Note: These use instagram.com as placeholder domain. " +
      "Replace with actual Fediverse addresses for import."
  );

  return following.length;
}
