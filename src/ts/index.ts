/**
 * CLI entry point for BridgingWorlds TypeScript stages (Store + Export).
 */

import { readFileSync, readdirSync, existsSync } from "fs";
import { Command } from "commander";
import { loadConfig } from "./config.js";
import { SolidClient } from "./store/solid-client.js";
import { createContainerHierarchy } from "./store/container-manager.js";
import { uploadRdfResources, uploadMediaFiles } from "./store/resource-uploader.js";
import { registerTypeIndex } from "./store/type-index.js";
import {
  exportToBluesky,
  LocalMediaResolver,
  PodMediaResolver,
} from "./export/bluesky-exporter.js";
import { exportActivityPub } from "./export/activitypub-export.js";
import { exportToActivityPods } from "./export/activitypods-exporter.js";
import { exportFollowingCsv } from "./export/csv-exporter.js";

const program = new Command();

program
  .name("bridging-worlds")
  .description("Solid Pod storage and cross-platform export")
  .version("0.1.0");

// ── Cleanup command ────────────────────────────────────────────────

const RETIRED_POD_PATHS = [
  // Children first, then their containers (CSS only deletes empty containers).
  "/social/likes/likes.ttl",
  "/social/likes/",
  "/social/comments/comments.ttl",
  "/social/comments/",
  "/social/messages/messages.ttl",
  "/social/messages/",
  "/social/saved/saved.ttl",
  "/social/saved/",
  "/social/searches/searches.ttl",
  "/social/searches/",
];

program
  .command("cleanup")
  .description(
    "Delete retired private/non-public categories (likes, comments, messages, saved, searches) from the Pod."
  )
  .option("--config <path>", "Config file", "config/default.yaml")
  .option("--dry-run", "List paths without deleting")
  .action(async (opts) => {
    const config = loadConfig(opts.config);

    if (!config.solid.podUrl) {
      console.error("Error: SOLID_POD_URL not configured. Set it in .env");
      process.exit(1);
    }

    console.log(`Cleaning up Pod: ${config.solid.podUrl}`);
    console.log("Targets:");
    for (const p of RETIRED_POD_PATHS) console.log(`  ${p}`);

    if (opts.dryRun) {
      console.log("\nDry run — nothing deleted.");
      return;
    }

    const client = new SolidClient(config.solid);
    try {
      await client.authenticate();
      let deleted = 0;
      let alreadyGone = 0;
      for (const p of RETIRED_POD_PATHS) {
        try {
          const ok = await client.deleteResource(p);
          if (ok) {
            console.log(`  Deleted:    ${p}`);
            deleted++;
          } else {
            console.log(`  Not found:  ${p}`);
            alreadyGone++;
          }
        } catch (err) {
          console.error(`  Error on ${p}: ${err}`);
        }
      }
      console.log(`\nDone. Deleted ${deleted}, already gone ${alreadyGone}.`);
      console.log(
        "Note: re-run `npm run store` to refresh /settings/privateTypeIndex.ttl " +
          "with the pruned registrations."
      );
    } finally {
      await client.logout();
    }
  });

// ── Store command ──────────────────────────────────────────────────

program
  .command("store")
  .description("Upload RDF and media to a Solid Pod")
  .option("--rdf-dir <path>", "RDF Turtle directory", "output/rdf")
  .option("--config <path>", "Config file", "config/default.yaml")
  .option("--skip-media", "Skip media upload")
  .option("--skip-rdf", "Skip RDF upload (only upload media)")
  .option(
    "--media-categories <list>",
    "Comma-separated media categories to upload (posts,stories,reels,profile). Default: all."
  )
  .option(
    "--media-types <list>",
    "Comma-separated MIME top-levels to upload (image,video). Default: all."
  )
  .action(async (opts) => {
    const config = loadConfig(opts.config);

    if (!config.solid.podUrl) {
      console.error("Error: SOLID_POD_URL not configured. Set it in .env");
      process.exit(1);
    }

    console.log(`Storing to Pod: ${config.solid.podUrl}`);
    const client = new SolidClient(config.solid);

    try {
      await client.authenticate();

      console.log("\nCreating container hierarchy...");
      await createContainerHierarchy(client, config.store.containerBase);

      if (!opts.skipRdf) {
        console.log("\nUploading RDF resources...");
        const rdfCount = await uploadRdfResources(
          client,
          opts.rdfDir,
          config.store.containerBase
        );
        console.log(`Uploaded ${rdfCount} RDF resources`);
      } else {
        console.log("\nSkipping RDF upload (--skip-rdf).");
      }

      if (!opts.skipMedia && config.store.uploadMedia) {
        console.log("\nUploading media files...");
        const filter = {
          categories: opts.mediaCategories
            ? String(opts.mediaCategories).split(",").map((s) => s.trim()).filter(Boolean)
            : undefined,
          types: opts.mediaTypes
            ? String(opts.mediaTypes).split(",").map((s) => s.trim()).filter(Boolean)
            : undefined,
        };
        const mediaCount = await uploadMediaFiles(
          client,
          opts.rdfDir,
          config.store.containerBase,
          config.store.batchSize,
          filter
        );
        console.log(`Uploaded ${mediaCount} media files`);
      }

      if (config.store.registerTypeIndex) {
        console.log("\nRegistering type index...");
        await registerTypeIndex(client);
      }

      console.log("\nStore complete!");
    } finally {
      await client.logout();
    }
  });

// ── Export command ──────────────────────────────────────────────────

program
  .command("export")
  .description("Export RDF data to target platforms")
  .option("--rdf-dir <path>", "RDF Turtle directory", "output/rdf")
  .option("--output-dir <path>", "Export output directory", "output/export")
  .option("--media-base <path>", "Instagram export root for local media")
  .option(
    "--source <source>",
    "Data source: 'local' reads .ttl from disk, 'pod' reads from Solid Pod",
    "local"
  )
  .option(
    "--target <platform>",
    "Target: bluesky, mastodon (federates via ActivityPods when configured), activitypods, all",
    "all"
  )
  .option("--config <path>", "Config file", "config/default.yaml")
  .option("--dry-run", "Don't actually post, just generate JSON")
  .action(async (opts) => {
    const config = loadConfig(opts.config);

    if (opts.dryRun !== undefined) {
      config.bluesky.dryRun = opts.dryRun;
      config.export.mastodon.activitypods.dryRun = opts.dryRun;
    }

    const source: "local" | "pod" = opts.source === "pod" ? "pod" : "local";

    // ── Set up Solid client if reading from Pod ────────────────
    let solidClient: SolidClient | undefined;

    if (source === "pod") {
      if (!config.solid.podUrl) {
        console.error("Error: SOLID_POD_URL not configured. Set it in .env");
        process.exit(1);
      }
      console.log(`Reading data from Pod: ${config.solid.podUrl}`);
      solidClient = new SolidClient(config.solid);
      await solidClient.authenticate();
    }

    // ── Resolve media base path for local mode ─────────────────
    let mediaBasePath = opts.mediaBase || "";
    if (source === "local" && !mediaBasePath) {
      const dirs = readdirSync(".").filter(
        (d) => d.startsWith("instagram-") && !d.endsWith(".zip")
      );
      if (dirs.length > 0) {
        mediaBasePath = dirs[0];
        console.log(`Auto-detected media base: ${mediaBasePath}`);
      }
    }

    // ── Load media manifest (needed for Pod media resolver) ────
    let manifest: { uri: string; file_hash: string; mime_type: string }[] = [];
    const manifestPath = `${opts.rdfDir}/media_manifest.json`;
    if (existsSync(manifestPath)) {
      manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    }

    const target = opts.target.toLowerCase();
    const results: Record<string, unknown> = {};

    // ── Bluesky export ─────────────────────────────────────────
    if (target === "bluesky" || target === "all") {
      console.log("\n=== Bluesky Export ===");
      if (!config.bluesky.dryRun && !config.bluesky.handle) {
        console.error(
          "Error: BLUESKY_HANDLE not configured. Set it in .env or use --dry-run"
        );
      } else {
        const resolver =
          source === "pod" && solidClient
            ? new PodMediaResolver(
                solidClient,
                config.store.containerBase,
                manifest
              )
            : new LocalMediaResolver(mediaBasePath);

        results.bluesky = await exportToBluesky({
          rdfDir: opts.rdfDir,
          outputDir: opts.outputDir,
          config: config.bluesky,
          resolver,
          solidClient: source === "pod" ? solidClient : undefined,
        });
      }
    }

    // ── Mastodon federation via ActivityPods ───────────────────
    // Publishes Create/Note activities to an ActivityPods actor's
    // outbox; media stays hosted on the Solid Pod (public URLs).
    const apods = config.export.mastodon.activitypods;
    if (
      target === "activitypods" ||
      ((target === "mastodon" || target === "all") && apods.baseUrl)
    ) {
      console.log("\n=== ActivityPods Federation (Solid Pod → Mastodon) ===");
      if (!apods.baseUrl || !apods.username) {
        console.error(
          "Error: ActivityPods not configured. Set ACTIVITYPODS_BASE_URL, " +
            "ACTIVITYPODS_USERNAME and ACTIVITYPODS_PASSWORD in .env"
        );
      } else {
        results.activitypods = await exportToActivityPods({
          rdfDir: opts.rdfDir,
          outputDir: opts.outputDir,
          config: apods,
          podBaseUrl: config.solid.podUrl,
          containerBase: config.store.containerBase,
          manifest,
          solidClient: source === "pod" ? solidClient : undefined,
        });
      }
    }

    // ── ActivityPub / Mastodon export ──────────────────────────
    if (target === "mastodon" || target === "all") {
      if (config.export.mastodon.generateActivitypub) {
        console.log("\n=== ActivityPub Export (proof-of-concept) ===");
        results.activitypub = await exportActivityPub({
          rdfDir: opts.rdfDir,
          outputDir: opts.outputDir,
          mediaBasePath,
          solidClient: source === "pod" ? solidClient : undefined,
          containerBase: config.store.containerBase,
          manifest,
        });
      }

      if (config.export.mastodon.generateCsv) {
        console.log("\n=== Mastodon CSV Export ===");
        results.mastodonCsv = exportFollowingCsv(opts.rdfDir, opts.outputDir);
      }
    }

    // ── Cleanup ────────────────────────────────────────────────
    if (solidClient) {
      await solidClient.logout();
    }

    console.log("\nExport results:", JSON.stringify(results, null, 2));
  });

program.parse();
