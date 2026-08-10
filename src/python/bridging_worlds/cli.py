"""CLI entry point for the BridgingWorlds pipeline (Python stages)."""

from __future__ import annotations

import json
from pathlib import Path

import click
from rich.console import Console

from .config import load_config

console = Console()


@click.group()
@click.option("--config", "config_path", default="config/default.yaml", help="Config file path")
@click.pass_context
def main(ctx, config_path):
    """BridgingWorlds — Social media data portability pipeline."""
    ctx.ensure_object(dict)
    ctx.obj["config"] = load_config(config_path)


@main.command()
@click.argument("source", type=click.Path(exists=True))
@click.option("--output-dir", default="output/normalized", help="Output directory")
def ingest(source, output_dir):
    """Parse an Instagram GDPR/DMA export (ZIP or directory)."""
    from .ingest.extractor import extract_export
    from .ingest.normalizer import normalize_all

    console.print(f"[bold]Ingesting from:[/bold] {source}")

    export_root = extract_export(source)
    console.print(f"Export root: {export_root}")

    output_path = Path(output_dir)
    counts = normalize_all(export_root, output_path)

    console.print("\n[bold green]Ingest complete:[/bold green]")
    for name, count in counts.items():
        console.print(f"  {name}: {count} items")


@main.command()
@click.argument("source", type=click.Path(exists=True))
@click.option("--provider", required=True, help="Provider name, e.g. instagram, tiktok")
@click.option("--output-dir", default="config/schemas", help="Schema output directory")
def schema(source, provider, output_dir):
    """Extract structure-only JSON Schemas from a raw export (deterministic, genson).

    Runs genson over every JSON file in the archive (merging paginated
    files) and writes value-free schemas to config/schemas/<provider>/.
    This is the only interface an LLM may use when authoring a mapper for
    a new provider — the raw data itself is never shown to the model.
    """
    from .ingest.schema_extractor import extract_schemas, extract_source

    console.print(f"[bold]Extracting schemas from:[/bold] {source}")
    export_root = extract_source(source)
    schemas, skipped = extract_schemas(export_root, Path(output_dir), provider)

    console.print(f"\n[bold green]Schema extraction complete:[/bold green] {len(schemas)} schemas")
    for key, count in schemas.items():
        pages = f" ({count} files merged)" if count > 1 else ""
        console.print(f"  {key}{pages}")
    if skipped:
        console.print(f"  [yellow]Skipped {len(skipped)} unparseable files[/yellow]")
    console.print(f"\nOutput: {Path(output_dir) / provider}/")
    console.print(
        "[dim]Schemas contain structure only (no data values) — safe to commit "
        "and to hand to an LLM for mapper authoring.[/dim]"
    )


@main.command()
@click.option("--input-dir", default="output/normalized", help="Normalized JSON directory")
@click.option("--output-dir", default="output/rdf", help="RDF output directory")
@click.option("--username", required=True, help="Instagram username")
def convert(input_dir, output_dir, username):
    """Convert normalized data to RDF Turtle files."""
    from .convert.graph_builder import convert_all
    from .convert.media_handler import write_manifest

    console.print(f"[bold]Converting to RDF for user:[/bold] {username}")

    input_path = Path(input_dir)
    output_path = Path(output_dir)

    counts = convert_all(input_path, output_path, username)

    console.print("\n[bold green]Conversion complete (public data only):[/bold green]")
    total = 0
    for name, count in counts.items():
        console.print(f"  {name}: {count} triples")
        total += count
    console.print(f"  [bold]Total: {total} triples[/bold]")
    console.print(
        "  [dim]Not converted (private or aggregated activity log): "
        "likes, comments, messages, saved, searches[/dim]"
    )

    # Also build media manifest if export root available
    # Try to find it relative to input_dir
    export_root = input_path.parent.parent
    ig_dirs = [d for d in export_root.iterdir() if d.is_dir() and d.name.startswith("instagram-")]
    if ig_dirs:
        media_count = write_manifest(ig_dirs[0], input_path, output_path)
        console.print(f"  Media manifest: {media_count} files")


@main.command()
@click.argument("source", type=click.Path(exists=True))
@click.option("--username", required=True, help="Instagram username")
@click.option("--output-dir", default="output", help="Base output directory")
def run(source, username, output_dir):
    """Run full pipeline: ingest + convert."""
    from .ingest.extractor import extract_export
    from .ingest.normalizer import normalize_all
    from .convert.graph_builder import convert_all
    from .convert.media_handler import write_manifest

    output_base = Path(output_dir)
    normalized_dir = output_base / "normalized"
    rdf_dir = output_base / "rdf"

    # Stage 1: Ingest
    console.print("[bold cyan]Stage 1: Ingest[/bold cyan]")
    export_root = extract_export(source)
    counts = normalize_all(export_root, normalized_dir)
    for name, count in counts.items():
        console.print(f"  {name}: {count} items")

    # Stage 2: Convert
    console.print("\n[bold cyan]Stage 2: Convert to RDF[/bold cyan]")
    triple_counts = convert_all(normalized_dir, rdf_dir, username)
    total = sum(triple_counts.values())
    console.print(f"  Generated {total} triples across {len(triple_counts)} graphs")

    media_count = write_manifest(export_root, normalized_dir, rdf_dir)
    console.print(f"  Media manifest: {media_count} files")

    console.print("\n[bold green]Pipeline complete.[/bold green]")
    console.print(f"RDF output: {rdf_dir}")
    console.print("Next: run TypeScript stages for Pod storage + export")


@main.command()
@click.argument("source", type=click.Path(exists=True))
@click.option("--normalized-dir", default="output/normalized")
@click.option("--rdf-dir", default="output/rdf")
@click.option("--output", default=None, help="Write metrics JSON to file")
def metrics(source, normalized_dir, rdf_dir, output):
    """Compute evaluation metrics for the paper."""
    from .metrics.evaluator import compute_metrics, print_metrics

    m = compute_metrics(Path(source), Path(normalized_dir), Path(rdf_dir))
    print_metrics(m)

    if output:
        with open(output, "w") as f:
            json.dump(m, f, indent=2, default=str)
        console.print(f"\nMetrics written to {output}")


if __name__ == "__main__":
    main()
