"""Deterministic JSON Schema extraction (genson) from a raw data export.

Privacy design — why this module exists:
The parser/normalizer ("mapper") for a new provider is authored by an LLM
following the add-vlop-provider skill. The raw archive contains DMs, phone
numbers, emails and location history, so the model must never see it. This
module is the deterministic boundary between the archive and the model: it
runs genson over the archive and emits pure structure — property names,
types, required lists — never data values. The mapper is then written from
these schemas alone.

Guards:
- genson only ever emits structure, not values.
- Objects whose keys are themselves user content (e.g. usernames or media
  paths used as dict keys) are collapsed to ``additionalProperties`` once
  the key count passes a threshold and all values share one shape, so data
  cannot leak through property names either.
- Output is fully deterministic: files are visited in sorted order,
  paginated files (``posts_1.json``, ``posts_2.json``) merge into one
  schema, and JSON is written with sorted keys.
"""

from __future__ import annotations

import json
import re
import zipfile
from pathlib import Path

from genson import SchemaBuilder

# Instagram/Facebook paginate as <type>_1.json, <type>_2.json, ...
_PAGINATION_RE = re.compile(r"_\d+$")

# An object node with at least this many properties, all sharing one shape,
# is treated as a dynamic-key map and collapsed to additionalProperties.
_DYNAMIC_KEY_THRESHOLD = 20


def extract_source(source: str | Path) -> Path:
    """Return a directory for the export, extracting a ZIP next to itself if needed.

    Provider-agnostic on purpose: unlike ingest extractors, no marker
    directories are required, so schemas can be extracted before any
    provider code exists.
    """
    source = Path(source)

    if source.is_file() and source.suffix == ".zip":
        extract_dir = source.parent / source.stem
        if not extract_dir.exists():
            with zipfile.ZipFile(source, "r") as zf:
                zf.extractall(extract_dir)
        return extract_dir

    if source.is_dir():
        return source

    raise FileNotFoundError(f"Source not found: {source}")


def _group_files(export_root: Path) -> dict[str, list[Path]]:
    """Group JSON-bearing files by relative path with pagination suffix stripped.

    ``your_instagram_activity/media/posts_1.json`` and ``..._2.json`` both
    land under the key ``your_instagram_activity/media/posts`` so genson
    merges them and captures field optionality across pages.
    """
    groups: dict[str, list[Path]] = {}
    for path in sorted(export_root.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in {".json", ".js"}:
            continue
        rel = path.relative_to(export_root)
        stem = _PAGINATION_RE.sub("", rel.stem)
        parent = rel.parent.as_posix()
        key = stem if parent == "." else f"{parent}/{stem}"
        groups.setdefault(key, []).append(path)
    return groups


def _load_json(path: Path) -> object:
    text = path.read_text(encoding="utf-8", errors="replace")
    if path.suffix.lower() == ".js":
        # X/Twitter wraps JSON in a JS assignment: window.YTD.<type>.part0 = [...]
        eq = text.find("=")
        if eq == -1:
            raise ValueError(f"No JS assignment in {path.name}")
        text = text[eq + 1 :]
    return json.loads(text)


def _collapse_dynamic_keys(node: object, threshold: int = _DYNAMIC_KEY_THRESHOLD) -> object:
    if isinstance(node, list):
        return [_collapse_dynamic_keys(item, threshold) for item in node]
    if not isinstance(node, dict):
        return node

    node = {key: _collapse_dynamic_keys(value, threshold) for key, value in node.items()}

    props = node.get("properties")
    if isinstance(props, dict) and len(props) >= threshold:
        shapes = {json.dumps(v, sort_keys=True) for v in props.values()}
        if len(shapes) == 1:
            node = {k: v for k, v in node.items() if k not in ("properties", "required")}
            node["additionalProperties"] = next(iter(props.values()))

    required = node.get("required")
    if isinstance(required, list):
        node["required"] = sorted(required)

    return node


def extract_schemas(
    export_root: str | Path,
    output_dir: str | Path,
    provider: str,
) -> tuple[dict[str, int], list[str]]:
    """Extract one structure-only JSON Schema per content type in the export.

    Returns (schemas, skipped): ``schemas`` maps content-type key to the
    number of source files merged into it; ``skipped`` lists files that
    could not be parsed as JSON.
    """
    export_root = Path(export_root)
    output_dir = Path(output_dir)

    schemas: dict[str, int] = {}
    skipped: list[str] = []

    for key, files in sorted(_group_files(export_root).items()):
        builder = SchemaBuilder()
        merged = 0
        for path in files:
            try:
                builder.add_object(_load_json(path))
                merged += 1
            except (json.JSONDecodeError, ValueError):
                skipped.append(path.relative_to(export_root).as_posix())
        if merged == 0:
            continue

        schema = _collapse_dynamic_keys(builder.to_schema())
        out_path = output_dir / provider / f"{key}.schema.json"
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(
            json.dumps(schema, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        schemas[key] = merged

    return schemas, skipped
