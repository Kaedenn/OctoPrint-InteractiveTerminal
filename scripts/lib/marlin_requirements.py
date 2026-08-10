#!/usr/bin/env python3
"""Parse MarlinDocumentation ``requires`` expressions into a JSON-safe AST.

The Marlin docs use a small, informal requirement notation rather than a formal
language.  This module deliberately supports only syntax that appears in the
_gcode corpus:

    FEATURE
    FEATURE_A | FEATURE_B
    FEATURE_A or FEATURE_B
    FEATURE_A, FEATURE_B
    FEATURE_A & FEATURE_B
    FEATURE_A && FEATURE_B
    FEATURE & (OTHER_A | OTHER_B)
    EXTRUDERS > 1
    AXIS4_NAME 'A'
    AUTO_BED_LEVELING_*
    (MIN|MAX)_SOFTWARE_ENDSTOPS
    AUTO_BED_LEVELING_(BILINEAR|UBL)
    INPUT_SHAPING_[XYZ]

Unknown atomic forms are retained losslessly as ``text`` nodes.  Thus upstream
Marlin documentation can add notation without breaking extraction or silently
changing meaning.

No third-party dependencies.
"""

from __future__ import annotations

import re
from typing import Any


_FEATURE_RE = re.compile(r"^[A-Z][A-Z0-9_]*$")
_COMPARISON_RE = re.compile(
    r"^([A-Z][A-Z0-9_]*)\s*(>=|<=|==|!=|>|<)\s*(-?\d+(?:\.\d+)?)$"
)
_ASSIGNMENT_RE = re.compile(
    r'''^([A-Z][A-Z0-9_]*)\s+(?:'([^']*)'|"([^"]*)"|`([^`]*)`)$'''
)

# Protect Marlin's feature-name shorthand before parsing Boolean parentheses.
# Examples:
#   (MIN|MAX)_SOFTWARE_ENDSTOPS
#   AUTO_BED_LEVELING_(BILINEAR|UBL)
_PATTERN_GROUP_RE = re.compile(
    r"(?:[A-Z0-9_*]+)?\([A-Z0-9_]+(?:\|[A-Z0-9_]+)+\)[A-Z0-9_*]*"
)


class RequirementSyntaxError(ValueError):
    """Raised only for malformed Boolean structure, not unknown atom syntax."""


def parse_requires(value: Any) -> dict[str, Any] | None:
    """Return a normalized AST for a Marlin ``requires`` value.

    ``None`` / an empty string means no requirement and returns ``None``.
    Non-string scalar values are converted to strings because YAML metadata can
    technically contain them and preserving data is preferable to failing.
    """
    if value is None:
        return None

    text = str(value).strip()
    if not text:
        return None

    protected, patterns = _protect_pattern_groups(text)
    parser = _Parser(protected, patterns)
    result = parser.parse()
    return _simplify(result)


def _protect_pattern_groups(text: str) -> tuple[str, list[str]]:
    patterns: list[str] = []

    def replace(match: re.Match[str]) -> str:
        token = f"\x00P{len(patterns)}\x00"
        patterns.append(match.group(0))
        return token

    return _PATTERN_GROUP_RE.sub(replace, text), patterns


class _Parser:
    def __init__(self, text: str, patterns: list[str]) -> None:
        self.text = text
        self.patterns = patterns
        self.pos = 0

    def parse(self) -> dict[str, Any]:
        node = self._parse_or()
        self._skip_ws()
        if self.pos != len(self.text):
            raise RequirementSyntaxError(
                f"unexpected text at column {self.pos + 1}: {self.text[self.pos:]!r}"
            )
        return node

    # Precedence, high to low: parentheses, AND, OR.
    # A comma in Marlin docs denotes simultaneous requirements, i.e. AND.
    def _parse_or(self) -> dict[str, Any]:
        nodes = [self._parse_and()]
        while True:
            self._skip_ws()
            if self._consume("|") or self._consume_word("or"):
                nodes.append(self._parse_and())
            else:
                break
        return _combine("or", nodes)

    def _parse_and(self) -> dict[str, Any]:
        nodes = [self._parse_primary()]
        while True:
            self._skip_ws()
            if self._consume("&&") or self._consume("&") or self._consume(","):
                nodes.append(self._parse_primary())
            else:
                break
        return _combine("and", nodes)

    def _parse_primary(self) -> dict[str, Any]:
        self._skip_ws()
        if self._consume("("):
            node = self._parse_or()
            self._skip_ws()
            if not self._consume(")"):
                raise RequirementSyntaxError(
                    f"missing ')' at column {self.pos + 1} in {self.text!r}"
                )
            return node
        return self._parse_atom()

    def _parse_atom(self) -> dict[str, Any]:
        self._skip_ws()
        start = self.pos
        quote: str | None = None
        backtick = False

        while self.pos < len(self.text):
            ch = self.text[self.pos]

            if quote:
                if ch == quote:
                    quote = None
                self.pos += 1
                continue

            if backtick:
                if ch == "`":
                    backtick = False
                self.pos += 1
                continue

            if ch in "'\"":
                quote = ch
                self.pos += 1
                continue
            if ch == "`":
                backtick = True
                self.pos += 1
                continue

            if ch in "|&,()":
                break
            if self.text.startswith(" or ", self.pos):
                break
            self.pos += 1

        atom = self.text[start:self.pos].strip()
        if not atom:
            raise RequirementSyntaxError(
                f"expected requirement at column {start + 1} in {self.text!r}"
            )

        atom = self._restore_patterns(atom)
        return _classify_atom(atom)

    def _restore_patterns(self, text: str) -> str:
        for index, pattern in enumerate(self.patterns):
            text = text.replace(f"\x00P{index}\x00", pattern)
        return text

    def _skip_ws(self) -> None:
        while self.pos < len(self.text) and self.text[self.pos].isspace():
            self.pos += 1

    def _consume(self, token: str) -> bool:
        if self.text.startswith(token, self.pos):
            self.pos += len(token)
            return True
        return False

    def _consume_word(self, word: str) -> bool:
        end = self.pos + len(word)
        if self.text[self.pos:end].lower() != word:
            return False
        before_ok = self.pos == 0 or not self.text[self.pos - 1].isalnum()
        after_ok = end == len(self.text) or not self.text[end].isalnum()
        if before_ok and after_ok:
            self.pos = end
            return True
        return False


def _classify_atom(text: str) -> dict[str, Any]:
    """Classify one indivisible requirement while retaining its source text."""
    match = _COMPARISON_RE.fullmatch(text)
    if match:
        raw_value = match.group(3)
        value: int | float = float(raw_value) if "." in raw_value else int(raw_value)
        return {
            "op": "compare",
            "name": match.group(1),
            "operator": match.group(2),
            "value": value,
        }

    match = _ASSIGNMENT_RE.fullmatch(text)
    if match:
        value = next(group for group in match.groups()[1:] if group is not None)
        return {
            "op": "equals",
            "name": match.group(1),
            "value": value,
        }

    if _FEATURE_RE.fullmatch(text):
        return {"op": "feature", "name": text}

    # Marlin uses *, [...] and parenthesized alternatives as shorthand for
    # families of compile-time symbols.  Keep these patterns intact; an
    # evaluator can match them against known feature names later.
    if (
        "*" in text
        or re.search(r"\[[A-Z0-9_|-]+\]", text)
        or re.search(r"\([A-Z0-9_]+(?:\|[A-Z0-9_]+)+\)", text)
    ):
        return {"op": "pattern", "pattern": text}

    # The docs occasionally contain human-oriented phrases such as
    # ``temperature sensor `1000``` rather than preprocessor expressions.
    # Preserve them instead of guessing at semantics.
    return {"op": "text", "text": text}


def _combine(op: str, nodes: list[dict[str, Any]]) -> dict[str, Any]:
    if len(nodes) == 1:
        return nodes[0]
    return {"op": op, "items": nodes}


def _simplify(node: dict[str, Any]) -> dict[str, Any]:
    """Flatten nested associative AND/OR nodes for cleaner generated JSON."""
    op = node.get("op")
    if op not in {"and", "or"}:
        return node

    items: list[dict[str, Any]] = []
    for child in node["items"]:
        child = _simplify(child)
        if child.get("op") == op:
            items.extend(child["items"])
        else:
            items.append(child)
    return {"op": op, "items": items}


if __name__ == "__main__":
    import argparse
    import json

    parser = argparse.ArgumentParser(description="Parse a Marlin requires expression")
    parser.add_argument("expression")
    args = parser.parse_args()
    print(json.dumps(parse_requires(args.expression), indent=2))
