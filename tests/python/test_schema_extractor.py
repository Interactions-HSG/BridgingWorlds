"""Tests for deterministic, value-free schema extraction.

All fixture data here is synthetic. The tests assert the two privacy
properties the pipeline depends on: no data value ever appears in a
schema, and dynamic (user-content) keys are collapsed away.
"""

from __future__ import annotations

import json

from bridging_worlds.ingest.schema_extractor import extract_schemas

SECRET = "SECRET_VALUE_XYZ"


def _make_export(tmp_path):
    root = tmp_path / "export"
    media = root / "your_activity" / "media"
    media.mkdir(parents=True)

    # Paginated files with differing optional fields.
    (media / "posts_1.json").write_text(
        json.dumps([{"title": SECRET, "timestamp": 1700000000}])
    )
    (media / "posts_2.json").write_text(
        json.dumps([{"title": SECRET, "timestamp": 1700000001, "location": SECRET}])
    )

    # Dynamic keys: user content used as dict keys.
    dynamic = {f"{SECRET}_{i}": {"count": i} for i in range(25)}
    (root / "story_interactions.json").write_text(json.dumps(dynamic))

    # X/Twitter-style JS-wrapped JSON.
    (root / "tweets.js").write_text(
        f'window.YTD.tweets.part0 = [{{"full_text": "{SECRET}"}}]'
    )

    # Unparseable file must be skipped, not crash.
    (root / "broken.json").write_text("{not json")

    return root


def test_extract_schemas(tmp_path):
    root = _make_export(tmp_path)
    out_dir = tmp_path / "schemas"

    schemas, skipped = extract_schemas(root, out_dir, "testprovider")

    # Paginated files merged into one schema.
    assert schemas["your_activity/media/posts"] == 2
    posts = json.loads(
        (out_dir / "testprovider" / "your_activity" / "media" / "posts.schema.json").read_text()
    )
    item = posts["items"]
    assert set(item["properties"]) == {"title", "timestamp", "location"}
    # Optionality captured: location only appears in page 2.
    assert item["required"] == ["timestamp", "title"]

    # JS wrapper stripped.
    assert schemas["tweets"] == 1

    # Broken file skipped.
    assert skipped == ["broken.json"]


def test_no_values_leak(tmp_path):
    root = _make_export(tmp_path)
    out_dir = tmp_path / "schemas"
    extract_schemas(root, out_dir, "testprovider")

    for schema_file in out_dir.rglob("*.schema.json"):
        assert SECRET not in schema_file.read_text(), schema_file


def test_dynamic_keys_collapsed(tmp_path):
    root = _make_export(tmp_path)
    out_dir = tmp_path / "schemas"
    extract_schemas(root, out_dir, "testprovider")

    schema = json.loads(
        (out_dir / "testprovider" / "story_interactions.schema.json").read_text()
    )
    assert "properties" not in schema
    assert schema["additionalProperties"]["properties"]["count"]["type"] == "integer"
