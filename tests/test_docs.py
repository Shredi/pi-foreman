"""Docs currency: the docs must keep up with config keys, commands and links.

Tests a-e need docs/ (skipped until it exists); the banner test always runs.
Set PI_FOREMAN_DOCS_ROOT to point the checks at another tree (used to prove the
checks detect misses).
"""
import importlib.util
import json
import os
import re
import unittest
from pathlib import Path

REPO = Path(os.environ.get("PI_FOREMAN_DOCS_ROOT") or Path(__file__).resolve().parent.parent)
CODE = Path(__file__).resolve().parent.parent
DOCS = REPO / "docs"
needs_docs = unittest.skipUnless(DOCS.is_dir(), "docs/ does not exist yet")

# Config keys that are internal/derived and need no user-facing doc. {dotted path: reason}
ALLOWLIST = {
    "version": "format marker, always 1",
}

PLACEHOLDER = "<x>"


def read(p):
    return Path(p).read_text(encoding="utf-8")


def docs_text():
    return "\n".join(read(p) for p in sorted(DOCS.glob("*.md")))


def schema_leaves(node, path=()):
    """Leaf key paths of the schema. A map (additionalProperties object schema) adds a
    PLACEHOLDER segment; a node with no `properties` and no object-valued
    additionalProperties with properties is a leaf."""
    props = node.get("properties", {})
    out = []
    for k, v in props.items():
        out += schema_leaves(v, path + (k,))
    ap = node.get("additionalProperties")
    if isinstance(ap, dict) and (ap.get("properties") or ap.get("additionalProperties")):
        out += schema_leaves(ap, path + (PLACEHOLDER,))
    if not props and path and not out:
        out.append(path)
    return out


def is_documented(path, text):
    """Strict but satisfiable rule. The key counts as documented when `text` contains,
    delimited by non-identifier characters, either
      - the full dotted path, where each placeholder segment matches `<name>`, `*`
        or any identifier (`providers.<p>.ranks`, `providers.anthropic.ranks`), or
      - the last two concrete segments joined by a dot (`required.trivial`), or
      - for a top-level key, the key in backticks (`` `version` ``).
    Maps' own parent key (e.g. `displayNames`) is covered by the backtick rule."""
    ident = r"[\w-]+"
    parts = [ident if s == PLACEHOLDER else re.escape(s) for s in path]
    full = r"\.".join(p if p != ident else r"(?:<[^>]*>|\*|" + ident + ")" for p in parts)
    edge_l, edge_r = r"(?<![\w.-])", r"(?![\w-])"
    pats = [edge_l + full + edge_r]
    concrete = [s for s in path if s != PLACEHOLDER]
    if len(concrete) >= 2:
        pats.append(edge_l + re.escape(concrete[-2] + "." + concrete[-1]) + edge_r)
    if len(path) == 1:
        pats.append("`" + re.escape(path[0]) + "`")
    return any(re.search(p, text) for p in pats)


def command_names():
    names = set()
    for p in sorted((CODE / "extensions").rglob("*.ts")):
        if "node_modules" in p.parts or "test" in p.parts:
            continue
        names.update(re.findall(r'pi\.registerCommand\(\s*"([^"]+)"', read(p)))
    return names


def foreman_subcommands():
    src = read(CODE / "extensions" / "core-adapter" / "index.ts")
    start = src.index('pi.registerCommand("foreman"')
    end = src.index("async function doctor", start)
    return set(re.findall(r'\bsub (?:===|!==) "([a-z][a-z-]*)"', src[start:end]))


def bin_subcommands():
    return set(re.findall(r"^\s+([a-z][a-z-]*)\)\s+script=", read(CODE / "bin" / "foreman"), re.M))


def slug(heading):
    s = re.sub(r"[`*_]", "", heading.strip().lower())
    s = re.sub(r"[^\w\- ]", "", s, flags=re.UNICODE)
    return s.replace(" ", "-")


def anchors(path):
    out, seen, fence = set(), {}, False
    for line in read(path).splitlines():
        if line.startswith("```"):
            fence = not fence
        m = None if fence else re.match(r"#{1,6}\s+(.*?)\s*#*\s*$", line)
        if m:
            s = slug(m.group(1))
            n = seen.get(s, 0)
            seen[s] = n + 1
            out.add(s if n == 0 else f"{s}-{n}")
    return out


class DocsCurrency(unittest.TestCase):
    @needs_docs
    def test_config_keys_documented(self):
        schema = json.loads(read(CODE / "config" / "foreman.schema.json"))
        text = docs_text()
        missing = [".".join(p) for p in schema_leaves(schema)
                   if ".".join(p) not in ALLOWLIST and not is_documented(p, text)]
        self.assertEqual(missing, [], "config keys missing from docs/*.md")

    @needs_docs
    def test_commands_documented(self):
        text = docs_text()
        cmds, subs, bins = command_names(), foreman_subcommands(), bin_subcommands()
        self.assertTrue(cmds and subs and bins, "command parsing found nothing")
        missing = [f"/{c}" for c in sorted(cmds) if f"/{c}" not in text]
        missing += [f"/foreman {s}" for s in sorted(subs) if f"/foreman {s}" not in text]
        missing += [f"foreman {b}" for b in sorted(bins)
                    if not re.search(r"(?<![\w/])foreman " + re.escape(b) + r"\b", text)]
        self.assertEqual(missing, [], "commands missing from docs/*.md")

    @needs_docs
    def test_relative_links_resolve(self):
        files = [REPO / "README.md", REPO / "AGENTS.md"] + sorted(DOCS.glob("*.md"))
        bad = []
        for f in files:
            body = re.sub(r"```.*?```", "", read(f), flags=re.S)
            for target in re.findall(r"\]\(([^)\s]+)\)", body):
                if re.match(r"[a-z][a-z0-9+.-]*:", target, re.I) or target.startswith("//"):
                    continue
                rel, _, frag = target.partition("#")
                dest = (f.parent / rel).resolve() if rel else f
                if not dest.exists():
                    bad.append(f"{f.name}: {target} (no such file)")
                elif frag and dest.suffix == ".md" and frag.lower() not in anchors(dest):
                    bad.append(f"{f.name}: {target} (no such heading)")
        self.assertEqual(bad, [])

    @needs_docs
    def test_docs_header_shape(self):
        bad = []
        for f in sorted(DOCS.glob("*.md")):
            ls = read(f).splitlines() + ["", "", "", "", ""]
            ok = (ls[0].startswith("# ") and ls[1] == ""
                  and all(l.startswith("> ") for l in ls[2:5])
                  and not ls[5].startswith(">"))
            if not ok:
                bad.append(f.name)
        self.assertEqual(bad, [], "need '# title', blank, exactly three '> ' lines, then a non-'>' line")

    @needs_docs
    def test_readme_lean(self):
        lines = read(REPO / "README.md").splitlines()
        self.assertLessEqual(len(lines), 90)
        self.assertIn(lines[0], ("<p>", '<p align="center">'))
        self.assertTrue(lines[1].lstrip().startswith('<img src="banner.svg"'), lines[1])
        self.assertEqual(lines[2].strip(), "</p>")
        hits = re.findall(r"(?:ceremony|ladder|safety|review|bridge)\.[a-zA-Z]\w*", "\n".join(lines))
        self.assertEqual(hits, [], "README must not name config keys")

    def test_banner_current(self):
        spec = importlib.util.spec_from_file_location("make_banner", CODE / "scripts" / "make_banner.py")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        self.assertEqual((CODE / "banner.svg").read_bytes(), mod.build_svg().encode("utf-8"),
                         "banner.svg is stale; run python scripts/make_banner.py")


if __name__ == "__main__":
    unittest.main()
