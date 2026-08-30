import { readFileSync, existsSync } from "fs";
import { parse as parseYaml } from "yaml";
import { config as loadDotenv } from "dotenv";

export interface SolidConfig {
  podUrl: string;
  idp: string;
  clientId: string;
  clientSecret: string;
}

export interface BlueskyConfig {
  handle: string;
  appPassword: string;
  dryRun: boolean;
  rateLimitDelay: number;
  maxTextLength: number;
}

export interface ActivityPodsConfig {
  baseUrl: string;
  username: string;
  password: string;
  dryRun: boolean;
  rateLimitDelay: number;
}

export interface PipelineConfig {
  workingDir: string;
  solid: SolidConfig;
  bluesky: BlueskyConfig;
  store: {
    containerBase: string;
    uploadMedia: boolean;
    registerTypeIndex: boolean;
    batchSize: number;
  };
  export: {
    mastodon: {
      generateActivitypub: boolean;
      generateCsv: boolean;
      activitypods: ActivityPodsConfig;
    };
  };
}

function interpolateEnv(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] || "");
}

function interpolateObj(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string") {
      result[k] = interpolateEnv(v);
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      result[k] = interpolateObj(v as Record<string, unknown>);
    } else {
      result[k] = v;
    }
  }
  return result;
}

export function loadConfig(
  configPath = "config/default.yaml",
  envPath = ".env"
): PipelineConfig {
  if (existsSync(envPath)) {
    loadDotenv({ path: envPath });
  }

  let raw: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    raw = parseYaml(readFileSync(configPath, "utf-8")) || {};
  }
  const cfg = interpolateObj(raw) as Record<string, unknown>;

  const store = (cfg.store || {}) as Record<string, unknown>;
  const exp = (cfg.export || {}) as Record<string, unknown>;
  const bsky = ((exp.bluesky || {}) as Record<string, unknown>);
  const masto = ((exp.mastodon || {}) as Record<string, unknown>);
  const apods = ((masto.activitypods || {}) as Record<string, unknown>);

  return {
    workingDir: ((cfg.pipeline as Record<string, unknown>)?.working_dir as string) || "./output",
    solid: {
      podUrl: process.env.SOLID_POD_URL || (store.pod_url as string) || "",
      idp: process.env.SOLID_IDP || "",
      clientId: process.env.SOLID_CLIENT_ID || "",
      clientSecret: process.env.SOLID_CLIENT_SECRET || "",
    },
    bluesky: {
      handle: process.env.BLUESKY_HANDLE || (bsky.handle as string) || "",
      appPassword: process.env.BLUESKY_APP_PASSWORD || "",
      dryRun: (bsky.dry_run as boolean) ?? true,
      rateLimitDelay: (bsky.rate_limit_delay as number) ?? 0.5,
      maxTextLength: (bsky.max_text_length as number) ?? 300,
    },
    store: {
      containerBase: (store.container_base as string) || "/social/",
      uploadMedia: (store.upload_media as boolean) ?? true,
      registerTypeIndex: (store.register_type_index as boolean) ?? true,
      batchSize: (store.batch_size as number) ?? 50,
    },
    export: {
      mastodon: {
        generateActivitypub: (masto.generate_activitypub as boolean) ?? true,
        generateCsv: (masto.generate_csv as boolean) ?? true,
        activitypods: {
          baseUrl: process.env.ACTIVITYPODS_BASE_URL || (apods.base_url as string) || "",
          username: process.env.ACTIVITYPODS_USERNAME || (apods.username as string) || "",
          password: process.env.ACTIVITYPODS_PASSWORD || "",
          dryRun: (apods.dry_run as boolean) ?? true,
          rateLimitDelay: (apods.rate_limit_delay as number) ?? 1.0,
        },
      },
    },
  };
}
