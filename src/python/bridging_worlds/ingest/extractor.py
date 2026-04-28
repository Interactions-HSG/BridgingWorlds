"""Extract and locate Instagram GDPR export data from ZIP or directory."""

from __future__ import annotations

import zipfile
from pathlib import Path


def extract_export(source: str | Path) -> Path:
    """Given a ZIP file or directory, return the path to the extracted export root.

    The export root is the directory containing subdirectories like
    'personal_information', 'your_instagram_activity', 'connections', etc.
    """
    source = Path(source)

    if source.is_file() and source.suffix == ".zip":
        extract_dir = source.parent / source.stem
        if not extract_dir.exists():
            with zipfile.ZipFile(source, "r") as zf:
                zf.extractall(extract_dir)
        return _find_export_root(extract_dir)

    if source.is_dir():
        return _find_export_root(source)

    raise FileNotFoundError(f"Source not found: {source}")


def _find_export_root(path: Path) -> Path:
    """Find the actual export root which contains the Instagram data directories."""
    # Check if this directory itself is the root
    marker_dirs = {"personal_information", "your_instagram_activity", "connections"}
    children = {p.name for p in path.iterdir() if p.is_dir()}

    if marker_dirs & children:
        return path

    # Check one level deeper (ZIP might have a wrapper dir)
    for child in path.iterdir():
        if child.is_dir():
            grandchildren = {p.name for p in child.iterdir() if p.is_dir()}
            if marker_dirs & grandchildren:
                return child

    raise FileNotFoundError(
        f"Could not find Instagram export root in {path}. "
        "Expected directories: personal_information, your_instagram_activity, connections"
    )
