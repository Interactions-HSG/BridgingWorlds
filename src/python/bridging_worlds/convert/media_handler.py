"""Generate a media manifest mapping RDF media references to local file paths."""

from __future__ import annotations

import hashlib
import json
import mimetypes
from pathlib import Path


def _file_hash(path: Path) -> str:
    """SHA-256 hash of file content (first 16 hex chars)."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()[:16]


def _mime_type(path: Path) -> str:
    """Get MIME type for a file."""
    mime, _ = mimetypes.guess_type(str(path))
    return mime or "application/octet-stream"


def build_media_manifest(export_root: Path, normalized_dir: Path) -> list[dict]:
    """Scan normalized data for media URIs and build a manifest.

    Returns a list of dicts: {uri, local_path, mime_type, file_hash, size_bytes}
    """
    seen_uris = set()
    media_uris = []

    # Collect all media URIs from posts, stories, reels
    for name in ("posts", "stories", "reels"):
        path = normalized_dir / f"{name}.json"
        if not path.exists():
            continue
        with open(path) as f:
            data = json.load(f)

        for item in data:
            # Direct uri (stories)
            if "uri" in item and item["uri"]:
                media_uris.append(item["uri"])
            # Attachments (posts, reels)
            for att in item.get("attachments", []):
                if att.get("uri"):
                    media_uris.append(att["uri"])

    # Profile photo
    profile_path = normalized_dir / "profile.json"
    if profile_path.exists():
        with open(profile_path) as f:
            profile = json.load(f)
        if profile.get("profile_photo_uri"):
            media_uris.append(profile["profile_photo_uri"])

    manifest = []
    for uri in media_uris:
        if uri in seen_uris:
            continue
        seen_uris.add(uri)

        local_path = export_root / uri
        if not local_path.exists():
            continue

        manifest.append({
            "uri": uri,
            "local_path": str(local_path),
            "mime_type": _mime_type(local_path),
            "file_hash": _file_hash(local_path),
            "size_bytes": local_path.stat().st_size,
        })

    return manifest


def write_manifest(export_root: Path, normalized_dir: Path, output_dir: Path) -> int:
    """Build and write media manifest. Returns count of media files."""
    manifest = build_media_manifest(export_root, normalized_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    out_path = output_dir / "media_manifest.json"
    with open(out_path, "w") as f:
        json.dump(manifest, f, indent=2)
    return len(manifest)
