"""Normalize Instagram export data into clean, pipeline-ready structures."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .parser import load_instagram_json, load_all_paginated
from .schema import (
    FollowerEntry,
    FollowingFile,
    PersonalInformation,
    Post,
    ReelsFile,
    StoriesFile,
)

# UUID namespace for deterministic resource IDs
BW_NAMESPACE = uuid.UUID("a1b2c3d4-e5f6-7890-abcd-ef1234567890")


def _ts_to_iso(timestamp: int) -> str:
    """Convert Unix timestamp (seconds) to ISO 8601 datetime string."""
    if timestamp <= 0:
        return ""
    return datetime.fromtimestamp(timestamp, tz=timezone.utc).isoformat()


def _make_id(content: str, timestamp: int) -> str:
    """Generate a deterministic UUID from content + timestamp."""
    return str(uuid.uuid5(BW_NAMESPACE, f"{content}:{timestamp}"))


def _media_type(uri: str) -> str:
    """Determine if a media URI is an image or video."""
    lower = uri.lower()
    if lower.endswith((".mp4", ".mov")):
        return "Video"
    return "Image"


def normalize_posts(export_root: Path) -> list[dict[str, Any]]:
    """Normalize posts into a clean list of dicts."""
    media_dir = export_root / "your_instagram_activity" / "media"

    # Load paginated posts (posts_1.json, posts_2.json, ...)
    raw = load_all_paginated(media_dir, "posts")
    posts = [Post.model_validate(p) for p in raw]

    normalized = []
    for post in posts:
        if not post.media:
            continue

        first = post.media[0]
        post_id = _make_id(first.uri, first.creation_timestamp)

        # Extract geo from first media item
        geo = None
        if first.media_metadata.photo_metadata:
            for exif in first.media_metadata.photo_metadata.exif_data:
                if exif.latitude is not None and exif.longitude is not None:
                    geo = {"latitude": exif.latitude, "longitude": exif.longitude}
                    break
        if geo is None and first.media_metadata.video_metadata:
            for exif in first.media_metadata.video_metadata.exif_data:
                if exif.latitude is not None and exif.longitude is not None:
                    geo = {"latitude": exif.latitude, "longitude": exif.longitude}
                    break

        attachments = []
        for m in post.media:
            attachments.append({
                "uri": m.uri,
                "type": _media_type(m.uri),
            })

        normalized.append({
            "id": post_id,
            "caption": first.title,
            "created_at": _ts_to_iso(first.creation_timestamp),
            "timestamp": first.creation_timestamp,
            "geo": geo,
            "attachments": attachments,
            "content_type": "post",
        })

    return normalized


def normalize_profile(export_root: Path) -> dict[str, Any]:
    """Normalize profile information."""
    path = export_root / "personal_information" / "personal_information" / "personal_information.json"
    raw = load_instagram_json(path)
    info = PersonalInformation.model_validate(raw)

    if not info.profile_user:
        return {}

    user = info.profile_user[0]
    smd = user.string_map_data

    def _get(key: str) -> str:
        return smd[key].value if key in smd else ""

    profile_photo_uri = ""
    if "Profile Photo" in user.media_map_data:
        profile_photo_uri = user.media_map_data["Profile Photo"].uri

    return {
        "username": _get("Username"),
        "bio": _get("Bio"),
        "email": _get("Email"),
        "phone": _get("Phone Number"),
        "gender": _get("Gender"),
        "date_of_birth": _get("Date of birth"),
        "private_account": _get("Private Account").lower() == "true",
        "profile_photo_uri": profile_photo_uri,
    }


def normalize_followers(export_root: Path) -> list[dict[str, Any]]:
    """Normalize followers list."""
    path = export_root / "connections" / "followers_and_following" / "followers_1.json"
    if not path.exists():
        return []

    raw = load_instagram_json(path)
    # Followers can be paginated
    all_raw = raw if isinstance(raw, list) else [raw]

    # Also check for followers_2.json, etc.
    page = 2
    while True:
        p = path.parent / f"followers_{page}.json"
        if not p.exists():
            break
        extra = load_instagram_json(p)
        if isinstance(extra, list):
            all_raw.extend(extra)
        page += 1

    entries = [FollowerEntry.model_validate(e) for e in all_raw]
    normalized = []
    for entry in entries:
        for sld in entry.string_list_data:
            normalized.append({
                "username": sld.value,
                "profile_url": sld.href,
                "timestamp": sld.timestamp,
                "followed_at": _ts_to_iso(sld.timestamp),
            })
    return normalized


def normalize_following(export_root: Path) -> list[dict[str, Any]]:
    """Normalize following list."""
    path = export_root / "connections" / "followers_and_following" / "following.json"
    if not path.exists():
        return []

    raw = load_instagram_json(path)
    data = FollowingFile.model_validate(raw)

    normalized = []
    for entry in data.relationships_following:
        for sld in entry.string_list_data:
            # Clean _u/ prefix from URLs
            href = sld.href.replace("/_u/", "/") if sld.href else ""
            normalized.append({
                "username": entry.title,
                "profile_url": href,
                "timestamp": sld.timestamp,
                "followed_at": _ts_to_iso(sld.timestamp),
            })
    return normalized


def normalize_stories(export_root: Path) -> list[dict[str, Any]]:
    """Normalize stories."""
    path = export_root / "your_instagram_activity" / "media" / "stories.json"
    if not path.exists():
        return []

    raw = load_instagram_json(path)
    data = StoriesFile.model_validate(raw)

    normalized = []
    for story in data.ig_stories:
        music_genre = None
        if story.media_metadata.video_metadata:
            music_genre = story.media_metadata.video_metadata.music_genre

        normalized.append({
            "id": _make_id(story.uri, story.creation_timestamp),
            "uri": story.uri,
            "type": _media_type(story.uri),
            "created_at": _ts_to_iso(story.creation_timestamp),
            "timestamp": story.creation_timestamp,
            "title": story.title,
            "music_genre": music_genre,
            "content_type": "story",
        })
    return normalized


def normalize_reels(export_root: Path) -> list[dict[str, Any]]:
    """Normalize reels."""
    path = export_root / "your_instagram_activity" / "media" / "reels.json"
    if not path.exists():
        return []

    raw = load_instagram_json(path)
    data = ReelsFile.model_validate(raw)

    normalized = []
    for reel in data.ig_reels_media:
        if not reel.media:
            continue

        first = reel.media[0]
        reel_id = _make_id(first.uri, first.creation_timestamp)

        geo = None
        if first.media_metadata.video_metadata:
            for exif in first.media_metadata.video_metadata.exif_data:
                if exif.latitude is not None and exif.longitude is not None:
                    geo = {"latitude": exif.latitude, "longitude": exif.longitude}
                    break

        attachments = []
        for m in reel.media:
            attachments.append({
                "uri": m.uri,
                "type": _media_type(m.uri),
            })

        normalized.append({
            "id": reel_id,
            "caption": first.title,
            "created_at": _ts_to_iso(first.creation_timestamp),
            "timestamp": first.creation_timestamp,
            "geo": geo,
            "attachments": attachments,
            "content_type": "reel",
        })
    return normalized


def normalize_all(export_root: Path, output_dir: Path) -> dict[str, int]:
    """Run all normalizers and write output JSON files. Returns item counts."""
    output_dir.mkdir(parents=True, exist_ok=True)

    normalizers = {
        "posts": normalize_posts,
        "profile": normalize_profile,
        "followers": normalize_followers,
        "following": normalize_following,
        "stories": normalize_stories,
        "reels": normalize_reels,
    }

    counts = {}
    for name, func in normalizers.items():
        data = func(export_root)
        out_path = output_dir / f"{name}.json"
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)

        if isinstance(data, list):
            counts[name] = len(data)
        elif isinstance(data, dict):
            counts[name] = 1 if data else 0

    return counts
