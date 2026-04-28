"""Configuration loading: YAML defaults + .env credentials + CLI overrides."""

from __future__ import annotations

import os
import re
from pathlib import Path

import yaml
from dotenv import load_dotenv


def _interpolate_env(value: str) -> str:
    """Replace ${ENV_VAR} references in a string with environment variable values."""
    def _replace(match):
        var_name = match.group(1)
        return os.environ.get(var_name, match.group(0))
    return re.sub(r"\$\{(\w+)\}", _replace, value)


def _interpolate_dict(d: dict) -> dict:
    """Recursively interpolate env vars in all string values of a dict."""
    result = {}
    for k, v in d.items():
        if isinstance(v, dict):
            result[k] = _interpolate_dict(v)
        elif isinstance(v, str):
            result[k] = _interpolate_env(v)
        else:
            result[k] = v
    return result


def load_config(
    config_path: str | Path = "config/default.yaml",
    env_path: str | Path | None = ".env",
) -> dict:
    """Load pipeline configuration with env var interpolation."""
    if env_path:
        load_dotenv(env_path)

    config_path = Path(config_path)
    if config_path.exists():
        with open(config_path) as f:
            config = yaml.safe_load(f) or {}
    else:
        config = {}

    return _interpolate_dict(config)
