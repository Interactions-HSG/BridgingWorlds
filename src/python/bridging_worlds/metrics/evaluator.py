"""Compute coverage, completeness, and overhead metrics for the paper."""

from __future__ import annotations

import json
import os
from pathlib import Path

from rdflib import Graph

# Instagram export categories the normalizer emits to local JSON. Aligns with
# the public-only policy in convert/graph_builder.py — likes, comments,
# messages, saved, and searches are not normalized at all anymore.
INSTAGRAM_CATEGORIES = [
    "posts", "profile", "followers", "following", "stories", "reels",
]

# Fields per category that are mapped to RDF.
MAPPED_FIELDS = {
    "posts": ["caption", "created_at", "attachments"],
    "profile": ["username", "bio", "profile_photo_uri"],
    "followers": ["username", "profile_url", "followed_at"],
    "following": ["username", "profile_url", "followed_at"],
    "stories": ["uri", "type", "created_at", "music_genre"],
    "reels": ["caption", "created_at", "attachments"],
}

# Ontology prefixes for triple categorization
ONTOLOGY_PREFIXES = {
    "as": "https://www.w3.org/ns/activitystreams#",
    "sioc": "http://rdfs.org/sioc/ns#",
    "foaf": "http://xmlns.com/foaf/0.1/",
    "schema": "https://schema.org/",
    "dct": "http://purl.org/dc/terms/",
    "geo": "http://www.w3.org/2003/01/geo/wgs84_pos#",
    "bw": "https://bridgingworlds.io/ns#",
    "rdf": "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
}


def compute_metrics(
    export_root: Path,
    normalized_dir: Path,
    rdf_dir: Path,
) -> dict:
    """Compute all evaluation metrics."""
    metrics = {
        "item_counts": {},
        "triple_counts": {},
        "ontology_usage": {},
        "field_coverage": {},
        "storage": {},
        "predicate_inventory": {},
    }

    # 1. Item counts from normalized JSON
    for cat in INSTAGRAM_CATEGORIES:
        path = normalized_dir / f"{cat}.json"
        if path.exists():
            with open(path) as f:
                data = json.load(f)
            if isinstance(data, list):
                metrics["item_counts"][cat] = len(data)
            elif isinstance(data, dict):
                metrics["item_counts"][cat] = 1 if data else 0

    # 2. Triple counts per graph + ontology breakdown
    total_triples = 0
    ontology_counts: dict[str, int] = {k: 0 for k in ONTOLOGY_PREFIXES}
    all_predicates: set[str] = set()

    for ttl_file in rdf_dir.glob("*.ttl"):
        g = Graph()
        g.parse(ttl_file, format="turtle")
        count = len(g)
        metrics["triple_counts"][ttl_file.stem] = count
        total_triples += count

        for _, p, _ in g:
            pred = str(p)
            all_predicates.add(pred)
            for prefix, uri in ONTOLOGY_PREFIXES.items():
                if pred.startswith(uri):
                    ontology_counts[prefix] = ontology_counts.get(prefix, 0) + 1
                    break

    metrics["triple_counts"]["_total"] = total_triples
    metrics["ontology_usage"] = {k: v for k, v in ontology_counts.items() if v > 0}
    metrics["predicate_inventory"] = sorted(all_predicates)

    # 3. Field coverage: for each category, what % of fields are non-empty
    for cat in INSTAGRAM_CATEGORIES:
        path = normalized_dir / f"{cat}.json"
        if not path.exists():
            continue
        with open(path) as f:
            data = json.load(f)

        if isinstance(data, dict):
            data = [data]

        fields = MAPPED_FIELDS.get(cat, [])
        if not fields or not data:
            continue

        total_fields = len(data) * len(fields)
        filled = 0
        for item in data:
            for field in fields:
                val = item.get(field)
                if val and val != "" and val != 0:
                    filled += 1

        metrics["field_coverage"][cat] = {
            "total_fields": total_fields,
            "filled_fields": filled,
            "coverage_pct": round(filled / total_fields * 100, 1) if total_fields > 0 else 0,
        }

    # 4. Storage metrics
    # Original export size
    export_size = sum(
        f.stat().st_size for f in export_root.rglob("*") if f.is_file()
    )
    # RDF output size
    rdf_size = sum(
        f.stat().st_size for f in rdf_dir.glob("*.ttl")
    )
    # Normalized JSON size
    normalized_size = sum(
        f.stat().st_size for f in normalized_dir.glob("*.json")
    )

    metrics["storage"] = {
        "original_export_bytes": export_size,
        "normalized_json_bytes": normalized_size,
        "rdf_turtle_bytes": rdf_size,
        "rdf_to_original_ratio": round(rdf_size / export_size, 4) if export_size > 0 else 0,
        "original_export_mb": round(export_size / 1_048_576, 1),
        "rdf_turtle_mb": round(rdf_size / 1_048_576, 1),
    }

    return metrics


def print_metrics(metrics: dict) -> None:
    """Print metrics in a human-readable format."""
    from rich.console import Console
    from rich.table import Table

    console = Console()

    # Item counts
    t = Table(title="Instagram Data Items")
    t.add_column("Category", style="cyan")
    t.add_column("Count", justify="right", style="green")
    for cat, count in metrics["item_counts"].items():
        t.add_row(cat, str(count))
    console.print(t)

    # Triple counts
    t = Table(title="RDF Triple Counts")
    t.add_column("Graph", style="cyan")
    t.add_column("Triples", justify="right", style="green")
    for name, count in metrics["triple_counts"].items():
        style = "bold" if name == "_total" else ""
        t.add_row(name, str(count), style=style)
    console.print(t)

    # Ontology usage
    t = Table(title="Ontology Usage (predicates)")
    t.add_column("Ontology", style="cyan")
    t.add_column("Predicates Used", justify="right", style="green")
    for ont, count in metrics["ontology_usage"].items():
        t.add_row(ont, str(count))
    console.print(t)

    # Field coverage
    t = Table(title="Field Coverage")
    t.add_column("Category", style="cyan")
    t.add_column("Filled / Total", justify="right")
    t.add_column("Coverage", justify="right", style="green")
    for cat, info in metrics["field_coverage"].items():
        t.add_row(
            cat,
            f"{info['filled_fields']} / {info['total_fields']}",
            f"{info['coverage_pct']}%",
        )
    console.print(t)

    # Storage
    s = metrics["storage"]
    t = Table(title="Storage Metrics")
    t.add_column("Metric", style="cyan")
    t.add_column("Value", justify="right", style="green")
    t.add_row("Original export", f"{s['original_export_mb']} MB")
    t.add_row("RDF Turtle output", f"{s['rdf_turtle_mb']} MB")
    t.add_row("RDF/Original ratio", f"{s['rdf_to_original_ratio']}")
    console.print(t)
