---
name: add-vlop-provider
description: Port a new VLOP (Very Large Online Platform) GDPR/DSA data export into the BridgingWorlds pipeline (ingest → convert → store → export). TRIGGER when the user asks to add support for a new social media provider's data archive (e.g. TikTok, Facebook, X/Twitter, YouTube, LinkedIn, Snapchat, Pinterest, Reddit, Threads), wire up a new export format, or generalize the Instagram-specific code to another platform.
---

# Adding a VLOP Data Provider

Port a new social media provider's data export into the BridgingWorlds pipeline. The reference implementation is **Instagram** under [src/python/bridging_worlds/ingest/](src/python/bridging_worlds/ingest/) and [src/python/bridging_worlds/convert/](src/python/bridging_worlds/convert/) — read those before starting.

## Pipeline shape (don't violate this)

```
ZIP / dir  →  ingest  →  normalized JSON  →  convert  →  RDF (Turtle)  →  store (Solid Pod)  →  export (Bluesky / ActivityPub / CSV)
             [ extractor + parser + schema + normalizer ]   [ graph_builder ]
                                  ↑                              ↑
                          all data, including                only PUBLIC data;
                          private (local only)              private types blocked
```

- **Ingest is per-provider.** Every provider has its own extractor, parser, schema, normalizer.
- **Convert is provider-agnostic AND public-only.** [graph_builder.py](src/python/bridging_worlds/convert/graph_builder.py) consumes the *normalized contract* (clean dicts) and emits AS2/SIOC/FOAF/schema.org RDF. Do **not** add provider branches there. If your provider needs a new content type, add a new builder function — don't fork existing ones.
- **Store + export are downstream.** They never see provider raw data. If they need new behavior, that is a separate change.

## Privacy rule — non-negotiable

**Only data that is publicly visible on the source platform AND is not an aggregated activity log of the account holder may be converted to RDF.** Everything else must be dropped before normalization — no schema model, no normalizer, no graph builder.

| Convert to RDF | Do not convert (no schema, no normalizer, no builder) |
|---|---|
| Posts, reels (public captions + public attachments — but NOT raw EXIF GPS, which the platform strips before display) | DMs / messages |
| Stories (while live, publicly visible to followers) | "Saved"/bookmarks lists |
| Profile: username, public bio, public profile photo, homepage | Search history |
| Followers / following lists (when account is public) | "Liked posts" lists (private on Instagram, X, etc.) |
|  | The user's own comment history (each individual comment is public on its source post, but the aggregated list is an activity log — excluded) |
|  | Profile PII: email, phone, date of birth, gender |
|  | EXIF GPS coordinates from media metadata |

If unsure whether a field qualifies, **default to exclude**. Excluded categories should have **no Pydantic model in `schema.py`, no `normalize_<type>` function, and no graph builder.** Don't normalize them "just in case" — that creates a leak surface. Document the public-visibility evidence in the PR description before adding a new builder.

The reference implementation enforces this rule — see the privacy policy docstring and `convert_all` allowlist in [graph_builder.py](src/python/bridging_worlds/convert/graph_builder.py). Mirror the same allowlist pattern for your provider.

## Three-PR workflow

Develop each new provider in **three sequential PRs**. Stop and request review after each.

### PR 1 — Schema, fixtures, parser

Goal: prove you can load the raw archive into typed Python without losing data.

1. **Collect a real export** (temporary, gitignored). Drop the archive (zip or directory) into the project root using a `<provider>-<handle>-<date>-<id>/` naming convention, e.g. `tiktok-myhandle-2026-04-28-XXXX/`. Add the directory pattern to [.gitignore](.gitignore) if not already covered.
2. **Generate a JSON Schema from samples** with `genson` (merge multiple files of the same type to capture optionality):
   ```bash
   uvx genson path/to/posts_*.json > config/schemas/<provider>/posts.schema.json
   ```
3. **Generate Pydantic models** with `datamodel-codegen` into a new module:
   ```
   src/python/bridging_worlds/ingest/<provider>/schema.py
   ```
   Follow the conventions in [ingest/schema.py](src/python/bridging_worlds/ingest/schema.py): `BaseModel`, `Field(default_factory=...)`, `from __future__ import annotations`, all fields optional with sensible defaults so partial archives don't crash. Hand-edit generated models — don't ship raw codegen.
4. **Provider-specific parser** at `src/python/bridging_worlds/ingest/<provider>/parser.py`. Mirror [ingest/parser.py](src/python/bridging_worlds/ingest/parser.py): one `load_<provider>_json(path)` and one `load_all_paginated(dir, prefix)` if the provider paginates.
   - **Encoding gotchas — research before coding.** Instagram's JSON double-encodes UTF-8 as latin-1 (see `fix_instagram_encoding` in [parser.py:10](src/python/bridging_worlds/ingest/parser.py#L10)). Facebook/Messenger has the same bug. TikTok and X are normally clean UTF-8. Snapchat ships CSV not JSON. **Verify with a real emoji / non-ASCII string from the export** before deciding whether you need an encoding fix.
5. **Extractor** at `src/python/bridging_worlds/ingest/<provider>/extractor.py`. Pattern from [ingest/extractor.py](src/python/bridging_worlds/ingest/extractor.py): accept zip-or-dir, return the export root. Use *provider-specific marker directories* in `_find_export_root` (e.g. TikTok uses `user_data.json` at root; Facebook uses `your_facebook_activity/`, `messages/`, `profile_information/`).
6. **Refactor existing Instagram code if needed.** If this is the *second* provider being added, move Instagram-specific code from `ingest/parser.py`, `ingest/extractor.py`, `ingest/schema.py`, `ingest/normalizer.py` into `ingest/instagram/` first, in the same PR or as a prep commit. Keep backwards-compatible re-exports in the package `__init__.py` for one release if anything imports them.
7. **Fixtures** under `tests/fixtures/<provider>/v1/...` mirroring the real archive layout. Validate them against the JSON Schema in a tiny test.

**Out of scope for PR 1:** normalizer logic, RDF, anything downstream.

### PR 2 — Normalizer (extract→convert contract)

Goal: produce the **exact same dict shape** as Instagram's normalizer for each content type, so [graph_builder.py](src/python/bridging_worlds/convert/graph_builder.py) consumes it unchanged.

1. **Read the contract.** Only the categories below are normalized at all. Anything not listed (DMs, saved, searches, likes, comment history, EXIF, profile PII) must not have a schema model, normalizer, or builder.

   | Content type | Required keys |
   |---|---|
   | `profile` | `username`, `bio`, `profile_photo_uri`. (Do not include `email`, `phone`, `gender`, `date_of_birth`, `private_account` — they are not publicly visible.) |
   | `posts` | `id`, `caption`, `created_at` (ISO 8601), `timestamp` (epoch s), `attachments[{uri, type:Image|Video}]`, `content_type`. **No EXIF GPS** — the source platform strips it before display. |
   | `reels` | same shape as `posts` (merged downstream) |
   | `followers` / `following` | `username`, `profile_url`, `timestamp`, `followed_at` |
   | `stories` | `id`, `uri`, `type`, `created_at`, `timestamp`, `title`, `music_genre`, `content_type` |

2. **Implement** `src/python/bridging_worlds/ingest/<provider>/normalizer.py` with one `normalize_<type>(export_root)` per supported content type and a `normalize_all(export_root, output_dir)` that writes `<type>.json` files. Mirror the Instagram pattern at [ingest/normalizer.py:408](src/python/bridging_worlds/ingest/normalizer.py#L408). The normalizer may produce private-type JSON locally — that is fine, it is not what gets converted. The public/private gate is enforced one step downstream in `convert_all`.
3. **IDs are deterministic.** Use `uuid5` from a stable namespace + content + timestamp, like `_make_id` at [ingest/normalizer.py:44](src/python/bridging_worlds/ingest/normalizer.py#L44). Do **not** invent random IDs — re-runs must be idempotent for the Pod store layer.
4. **Skip what the provider doesn't have.** If TikTok has no "stories" concept, return `[]` from `normalize_stories` — don't fabricate. Don't fail.
5. **New content type?** Three-step rule:
   - Add the normalizer that produces the new dict shape.
   - Add a `build_<type>_graph(items, username)` in [convert/graph_builder.py](src/python/bridging_worlds/convert/graph_builder.py) using AS2/SIOC vocab — **only if** the content is publicly visible on the source platform.
   - Register it in `convert_all`'s `builders` dict.
   Justify in the PR description (a) **why** existing AS2 types don't fit, and (b) **evidence that the data is publicly visible on the source platform** (e.g. shows up on the public profile page when not logged in). If you can't show public visibility, do not add a builder — leave the data in the local normalized JSON.
6. **Wire the CLI/dispatcher.** Add a provider flag/auto-detect in [cli.py](src/python/bridging_worlds/cli.py) so `bridging-worlds ingest --provider tiktok ...` routes to the new module. Auto-detect via the same marker dirs used in step PR1.5.

**Tests:** unit tests on every `normalize_<type>` against the fixture, asserting exact dict keys and at least one row's values.

### PR 3 — Convert + end-to-end

Goal: real export → Turtle → Solid Pod → exported to a target platform.

1. **Run [convert/graph_builder.py](src/python/bridging_worlds/convert/graph_builder.py) unchanged** against the normalized output. If it fails, the bug is in PR 2 (your normalizer broke the contract) — fix it there, not here.
2. **End-to-end test** under `tests/integration/test_<provider>_e2e.py`: archive → normalize → convert → assert triple counts and a few SPARQL queries (e.g. all posts have `as:published`, all `as:Follow` activities have an actor and object).
3. **Cross-platform export check.** Run [src/ts/export/bluesky-exporter.ts](src/ts/export/bluesky-exporter.ts) in dry-run mode against the new provider's Turtle. The TS export layer reads RDF, not the provider — if it works for Instagram it should work here. If it doesn't, you broke the contract.
4. **Update [config/default.yaml](config/default.yaml)** with any provider-specific knobs (e.g. `tiktok.fix_encoding: false`) under an `ingest.<provider>:` section.

## Key design rules

- **Normalized dict = stable contract.** Convert and everything downstream are provider-agnostic. Don't leak provider-specific fields into the normalized output. If you must, prefix them (`x_tiktok_*`) and document why.
- **One module per provider.** `ingest/<provider>/` is self-contained: `extractor.py`, `parser.py`, `schema.py`, `normalizer.py`. No cross-provider imports.
- **Timestamps go through a helper.** Use module-level `_ts_to_iso` / `_ts_ms_to_iso`. Don't inline `datetime.fromtimestamp` calls. **Do not** add ms-vs-s autodetection unless you've seen the provider actually mix them in real exports.
- **Validate at the parser, not the normalizer.** Pydantic models in `schema.py` are the trust boundary. Once data passes them, the normalizer treats fields as present.
- **No silent data loss.** If the provider has a field with no AS2 mapping, log it once and drop it — don't quietly omit. Future PR can add a builder for it.
- **Privacy.** GDPR exports contain DMs, phone numbers, email, location. Never commit a real archive. Add the export dir glob to [.gitignore](.gitignore). Tests use synthetic fixtures only.

## VLOP-specific notes (start points, verify with a real export)

| Provider | Format | Root marker | Encoding |
|---|---|---|---|
| Instagram (Meta) | JSON, paginated | `personal_information/`, `your_instagram_activity/`, `connections/` | broken UTF-8 (latin-1 hop) |
| Facebook (Meta) | JSON, paginated | `your_facebook_activity/`, `personal_information/`, `messages/` | broken UTF-8 (same bug) |
| TikTok | single `user_data.json` (or `user_data_tiktok.json`) | file at root | clean UTF-8 |
| X / Twitter | JS-wrapped JSON (`window.YTD.* = [...]`) | `data/` directory | clean UTF-8, **strip JS prefix** |
| YouTube (Takeout) | JSON + HTML (watch-history.html / .json) | `Takeout/YouTube and YouTube Music/` | clean UTF-8 |
| LinkedIn | CSV per type | flat dir, `Profile.csv`, `Connections.csv`, ... | clean UTF-8 |
| Snapchat | JSON + HTML index | `mydata~*/json/` | clean UTF-8 |
| Reddit | CSV + JSON | flat zip, `comments.csv`, `posts.csv`, ... | clean UTF-8 |
| Threads (Meta) | JSON, Instagram-shaped | `your_threads_activity/` | broken UTF-8 (same bug) |

These are starting hypotheses, not facts. **Confirm structure from a real export before writing code** — VLOPs change formats without notice.

## Checklist before opening each PR

**PR 1**
- [ ] `ingest/<provider>/{extractor,parser,schema}.py` exist
- [ ] Real archive parses without error (manually verified)
- [ ] Encoding/format gotchas documented in module docstring
- [ ] No archive committed; `.gitignore` updated
- [ ] Synthetic fixtures + schema-validation test pass

**PR 2**
- [ ] `ingest/<provider>/normalizer.py` covers only the public content types in the contract table — no `normalize_messages`, `normalize_likes`, `normalize_saved`, `normalize_searches`, or `normalize_comments`
- [ ] No Pydantic models in `schema.py` for excluded categories
- [ ] Normalized dicts match the contract table above (keys, types)
- [ ] IDs are `uuid5`-deterministic
- [ ] Unit tests per `normalize_<type>` pass
- [ ] CLI / auto-detect routes to the new module

**PR 3**
- [ ] `convert_all` produces non-empty Turtle for every **PUBLIC** type the provider has
- [ ] **No private types in the `convert_all` builders dict** (no `messages`, no `saved`, no `searches`, no `likes`-equivalent, no profile PII, no EXIF GPS)
- [ ] Test asserts that no `<type>.ttl` file exists for any private category
- [ ] E2E test passes (archive → ttl → SPARQL assertions)
- [ ] `bluesky-exporter.ts --dry-run` succeeds on the new Turtle
- [ ] `config/default.yaml` updated if needed
- [ ] No edits to `convert/graph_builder.py` unless a new content type was justified **and** its public visibility on the source platform was documented in the PR
