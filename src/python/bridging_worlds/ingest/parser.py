"""JSON parsing with Instagram's broken UTF-8 encoding fix."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def fix_instagram_encoding(text: str) -> str:
    """Fix Instagram's broken UTF-8 encoding.

    Instagram exports encode UTF-8 characters as latin-1 byte sequences in JSON.
    For example, the pizza emoji (U+1F355) appears as \\u00f0\\u009f\\u008d\\u0095.
    """
    try:
        return text.encode("latin-1").decode("utf-8")
    except (UnicodeDecodeError, UnicodeEncodeError):
        return text


def fix_encoding_recursive(obj: Any) -> Any:
    """Recursively fix Instagram encoding on all string values in a JSON structure."""
    if isinstance(obj, str):
        return fix_instagram_encoding(obj)
    if isinstance(obj, dict):
        return {k: fix_encoding_recursive(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [fix_encoding_recursive(item) for item in obj]
    return obj


def load_instagram_json(path: str | Path, fix_encoding: bool = True) -> Any:
    """Load an Instagram export JSON file with optional encoding fix."""
    path = Path(path)
    with open(path, encoding="utf-8") as f:
        data = json.load(f)

    if fix_encoding:
        data = fix_encoding_recursive(data)

    return data


def load_all_paginated(directory: str | Path, prefix: str, fix_encoding: bool = True) -> list:
    """Load and merge paginated Instagram JSON files (e.g., posts_1.json, posts_2.json).

    Returns a single merged list from all matching files.
    """
    directory = Path(directory)
    results = []
    page = 1

    while True:
        path = directory / f"{prefix}_{page}.json"
        if not path.exists():
            break
        data = load_instagram_json(path, fix_encoding)
        if isinstance(data, list):
            results.extend(data)
        page += 1

    return results
