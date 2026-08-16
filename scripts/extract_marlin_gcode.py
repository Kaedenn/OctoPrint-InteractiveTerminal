#!/usr/bin/env python3

"""
Build a normalized commands.json from MarlinDocumentation's _gcode files.

Requires PyYAML:
    python3 -m pip install PyYAML

Examples:
    ./extract_marlin_gcode.py /path/to/MarlinDocumentation/_gcode
    ./extract_marlin_gcode.py commands.zip -o commands.json

The output is keyed by literal G-code ("G0", "M104", ...), so it is convenient
for autocomplete and lookup. Files documenting multiple codes are expanded into
one entry per code while retaining the complete alias list.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any, Iterable, Iterator

from lib.marlin_requirements import parse_requires

try:
    import yaml
except ImportError:
    sys.exit("PyYAML is required: python3 -m pip install PyYAML")

SCHEMA_VERSION = 1
FRONT_MATTER_RE = re.compile(r"\A---\s*\n(.*?)\n---\s*(?:\n|\Z)", re.DOTALL)


def as_list(value: Any) -> list[Any]:
    """Normalize absent/scalar/list metadata into a list."""
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return [value]


def clean_markdown_body(text: str) -> str:
    return text.strip()


def get_git_commit(path: Path) -> str | None:
    try:
        result = subprocess.run(
            [
                "git",
                "-C",
                str(path),
                "rev-parse",
                "HEAD",
            ],
            check=True,
            capture_output=True,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return None

    return result.stdout.strip() or None


def build_source_metadata(source_dir: Path) -> dict[str, Any]:
    repository_root = source_dir.parent

    return {
        "project": "MarlinDocumentation",
        "repository": "https://github.com/MarlinFirmware/MarlinDocumentation",
        "license": "GPL-3.0",
        "commit": get_git_commit(repository_root),
    }


def parse_document(filename: str, text: str) -> tuple[dict[str, Any], str]:
    match = FRONT_MATTER_RE.match(text)
    if not match:
        raise ValueError(f"{filename}: missing YAML front matter")

    metadata = yaml.safe_load(match.group(1)) or {}
    if not isinstance(metadata, dict):
        raise ValueError(f"{filename}: YAML front matter is not a mapping")

    body = clean_markdown_body(text[match.end():])
    return metadata, body


def normalize_parameter(param: dict[str, Any]) -> dict[str, Any]:
    out = dict(param)
    out["optional"] = bool(param.get("optional", False))
    out["values"] = as_list(param.get("values"))
    out["requirements"] = parse_requires(param.get("requires"))
    return out


def normalize_document(filename: str, metadata: dict[str, Any], body: str) -> dict[str, Any]:
    codes = [str(code).strip().upper() for code in as_list(metadata.get("codes"))]
    if not codes:
        raise ValueError(f"{filename}: no codes listed")

    # Keep the useful documented fields explicit and normalized. Unknown fields
    # are retained in `extra` so an upstream Marlin documentation addition won't
    # silently disappear from our generated data.
    known = {
        "tag", "title", "brief", "author", "contrib", "group", "since",
        "requires", "codes", "related", "notes", "devnotes", "parameters",
        "example", "examples", "videos", "images", "eeprom", "experimental",
        "deprecated", "category", "pagetype",
    }

    examples = as_list(metadata.get("example")) + as_list(metadata.get("examples"))

    doc: dict[str, Any] = {
        "tag": metadata.get("tag"),
        "title": metadata.get("title"),
        "brief": metadata.get("brief"),
        "group": as_list(metadata.get("group")),
        "since": metadata.get("since"),
        "requires": metadata.get("requires"),
        "requirements": parse_requires(metadata.get("requires")),
        "related": [str(x).upper() for x in as_list(metadata.get("related"))],
        "notes": as_list(metadata.get("notes")),
        "parameters": [normalize_parameter(p) for p in as_list(metadata.get("parameters"))],
        "examples": examples,
        "documentation": body,
        "aliases": codes,
        "source": filename,
    }

    # Preserve optional metadata only when present.
    for key in (
        "author", "contrib", "devnotes", "videos", "images", "eeprom",
        "experimental", "deprecated", "category", "pagetype",
    ):
        if key in metadata:
            doc[key] = metadata[key]

    extra = {k: v for k, v in metadata.items() if k not in known}
    if extra:
        doc["extra"] = extra

    return doc


def iter_directory(path: Path) -> Iterator[tuple[str, str]]:
    for file in sorted(path.glob("*.md")):
        yield file.name, file.read_text(encoding="utf-8")


def iter_zip(path: Path) -> Iterator[tuple[str, str]]:
    with zipfile.ZipFile(path) as archive:
        members = [
            name for name in archive.namelist()
            if name.lower().endswith(".md") and not name.endswith("/")
        ]
        for name in sorted(members):
            yield PurePosixPath(name).name, archive.read(name).decode("utf-8")


def iter_sources(path: Path) -> Iterable[tuple[str, str]]:
    if path.is_dir():
        return iter_directory(path)
    if path.is_file() and zipfile.is_zipfile(path):
        return iter_zip(path)
    raise ValueError(f"{path}: expected an _gcode directory or a ZIP archive")


def build_database(source: Path) -> dict[str, Any]:
    commands: dict[str, dict[str, Any]] = {}
    document_count = 0

    for filename, text in iter_sources(source):
        metadata, body = parse_document(filename, text)
        doc = normalize_document(filename, metadata, body)
        document_count += 1

        for code in doc["aliases"]:
            variant = {"code": code, **doc}
            if code not in commands:
                commands[code] = {
                    "code": code,
                    "variants": [variant],
                }
            else:
                commands[code]["variants"].append(variant)

    # Natural G-code ordering: G0, G1, ... G38.2, M0, M1, ... T0, ...
    def command_key(code: str) -> tuple[str, int, tuple[int, ...], str]:
        match = re.fullmatch(r"([A-Z]+)(\d+)(?:\.(\d+(?:\.\d+)*))?", code)
        if not match:
            return (code, -1, (), code)
        suffix = tuple(int(x) for x in match.group(3).split(".")) if match.group(3) else ()
        return (match.group(1), int(match.group(2)), suffix, code)

    commands = dict(sorted(commands.items(), key=lambda item: command_key(item[0])))

    return {
        "schema_version": SCHEMA_VERSION,
        "source": build_source_metadata(source),
        "document_count": document_count,
        "command_count": len(commands),
        "variant_count": sum(len(c["variants"]) for c in commands.values()),
        "commands": commands,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Extract MarlinDocumentation _gcode YAML/Markdown into commands.json"
    )
    parser.add_argument("source", type=Path, help="_gcode directory or ZIP archive")
    parser.add_argument(
        "-o", "--output", type=Path, default=Path("commands.json"),
        help="output JSON path (default: commands.json)",
    )
    parser.add_argument(
        "--compact", action="store_true", help="write compact JSON instead of pretty JSON"
    )
    args = parser.parse_args()

    try:
        database = build_database(args.source)
    except (OSError, UnicodeError, ValueError, yaml.YAMLError, zipfile.BadZipFile) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8") as f:
        if args.compact:
            json.dump(database, f, ensure_ascii=False, separators=(",", ":"))
        else:
            json.dump(database, f, ensure_ascii=False, indent=2)
            f.write("\n")

    print(
        f"Wrote {database['command_count']} commands "
        f"({database['variant_count']} documented variants) from "
        f"{database['document_count']} documents to {args.output}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
