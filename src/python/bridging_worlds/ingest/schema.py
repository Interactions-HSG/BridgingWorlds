"""Pydantic models for Instagram GDPR export JSON schemas.

These models reflect the actual structure observed in real exports (April 2026).
Instagram's export format is undocumented and may change without notice.
"""

from __future__ import annotations

from pydantic import BaseModel, Field


# --- Shared building blocks ---

class StringMapEntry(BaseModel):
    href: str = ""
    value: str = ""
    timestamp: int = 0


class MediaItem(BaseModel):
    uri: str = ""
    creation_timestamp: int = 0


class CrossPostSource(BaseModel):
    source_app: str = ""


class ExifEntry(BaseModel):
    latitude: float | None = None
    longitude: float | None = None
    device_id: str | None = None
    camera_position: str | None = None
    source_type: str | None = None


class PhotoMetadata(BaseModel):
    exif_data: list[ExifEntry] = Field(default_factory=list)


class SubtitleRef(BaseModel):
    uri: str = ""
    creation_timestamp: int = 0


class VideoMetadata(BaseModel):
    music_genre: str | None = None
    exif_data: list[ExifEntry] = Field(default_factory=list)
    subtitles: SubtitleRef | None = None


class CameraMetadata(BaseModel):
    has_camera_metadata: bool = False


class MediaMetadata(BaseModel):
    photo_metadata: PhotoMetadata | None = None
    video_metadata: VideoMetadata | None = None
    camera_metadata: CameraMetadata | None = None


# --- Posts ---

class PostMedia(BaseModel):
    uri: str
    creation_timestamp: int = 0
    media_metadata: MediaMetadata = Field(default_factory=MediaMetadata)
    title: str = ""
    cross_post_source: CrossPostSource | None = None


class Post(BaseModel):
    media: list[PostMedia] = Field(default_factory=list)


# --- Profile ---

class ProfileUser(BaseModel):
    title: str = ""
    media_map_data: dict[str, MediaItem] = Field(default_factory=dict)
    string_map_data: dict[str, StringMapEntry] = Field(default_factory=dict)


class PersonalInformation(BaseModel):
    profile_user: list[ProfileUser] = Field(default_factory=list)


# --- Connections ---

class StringListEntry(BaseModel):
    href: str = ""
    value: str = ""
    timestamp: int = 0


class FollowerEntry(BaseModel):
    title: str = ""
    media_list_data: list[MediaItem] = Field(default_factory=list)
    string_list_data: list[StringListEntry] = Field(default_factory=list)


class FollowingEntry(BaseModel):
    title: str = ""
    string_list_data: list[StringListEntry] = Field(default_factory=list)


class FollowingFile(BaseModel):
    relationships_following: list[FollowingEntry] = Field(default_factory=list)


# --- Stories ---

class StoryMedia(BaseModel):
    uri: str
    creation_timestamp: int = 0
    media_metadata: MediaMetadata = Field(default_factory=MediaMetadata)
    title: str = ""
    cross_post_source: CrossPostSource | None = None
    dubbing_info: list = Field(default_factory=list)
    media_variants: list = Field(default_factory=list)


class StoriesFile(BaseModel):
    ig_stories: list[StoryMedia] = Field(default_factory=list)


# --- Reels ---

class ReelEntry(BaseModel):
    media: list[PostMedia] = Field(default_factory=list)


class ReelsFile(BaseModel):
    ig_reels_media: list[ReelEntry] = Field(default_factory=list)


