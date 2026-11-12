"""Text reads in tests/ name their encoding: a bare read_text() or text-mode open() decodes with the legacy code page on Windows.

The checker parses each tests/*.py with ast and flags:
- `.read_text(...)` with no `encoding` keyword and no positional argument;
- builtin `open(...)` or `io.open(...)`, and `.open(...)` on any receiver except `self` and `cls`,
  unless the mode is a constant string containing "b" or an encoding is given.
Skipped on purpose: `self.open(...)` and `cls.open(...)` (helper methods of a test class, assumed not file I/O),
and `os.open(...)` (a file descriptor call that takes flags, not a mode).
A mode that is not a constant string counts as text mode. `write_text()` is not checked.
"""
from __future__ import annotations

import ast
import unittest
from pathlib import Path

TESTS = Path(__file__).resolve().parent
SKIPPED_RECEIVERS = {"self", "cls", "os"}


def _arg(call: ast.Call, index: int, keyword: str):
    for kw in call.keywords:
        if kw.arg == keyword:
            return kw.value
    return call.args[index] if len(call.args) > index else None


def _is_binary(mode) -> bool:
    return isinstance(mode, ast.Constant) and isinstance(mode.value, str) and "b" in mode.value


def find_violations(source: str, name: str = "<snippet>") -> list[str]:
    hits = []
    for node in ast.walk(ast.parse(source)):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        where = f"{name}:{node.lineno}"
        if isinstance(func, ast.Attribute) and func.attr == "read_text":
            if _arg(node, 0, "encoding") is None:
                hits.append(f"{where} read_text() without encoding")
            continue
        if isinstance(func, ast.Name) and func.id == "open":
            mode_at, encoding_at = 1, 3
        elif isinstance(func, ast.Attribute) and func.attr == "open":
            receiver = func.value
            if isinstance(receiver, ast.Name) and receiver.id in SKIPPED_RECEIVERS:
                continue
            if isinstance(receiver, ast.Name) and receiver.id == "io":
                mode_at, encoding_at = 1, 3
            else:
                mode_at, encoding_at = 0, 2
        else:
            continue
        if _is_binary(_arg(node, mode_at, "mode")):
            continue
        if _arg(node, encoding_at, "encoding") is None:
            hits.append(f"{where} open() in text mode without encoding")
    return hits


class TestsEncodingTest(unittest.TestCase):
    def test_tests_are_scanned(self):
        names = {p.name for p in TESTS.rglob("*.py")}
        self.assertIn("test_tests_encoding.py", names)
        self.assertIn("test_foreman_session.py", names)

    def test_no_bare_text_reads_in_tests(self):
        hits = []
        for path in sorted(TESTS.rglob("*.py")):
            source = path.read_text(encoding="utf-8")
            hits.extend(find_violations(source, str(path.relative_to(TESTS.parent))))
        self.assertEqual(hits, [], "text I/O without encoding=\"utf-8\":\n" + "\n".join(hits))


class CheckerTest(unittest.TestCase):
    def flagged(self, source: str) -> int:
        return len(find_violations(source))

    def test_bare_read_text_is_flagged(self):
        self.assertEqual(self.flagged("p.read_text()"), 1)

    def test_read_text_with_encoding_keyword_passes(self):
        self.assertEqual(self.flagged("p.read_text(encoding='utf-8')"), 0)

    def test_read_text_positional_encoding_passes(self):
        self.assertEqual(self.flagged("p.read_text('utf-8')"), 0)

    def test_bare_open_is_flagged(self):
        self.assertEqual(self.flagged("open(p)"), 1)

    def test_open_text_mode_without_encoding_is_flagged(self):
        self.assertEqual(self.flagged("open(p, 'r')"), 1)

    def test_open_binary_passes(self):
        self.assertEqual(self.flagged("open(p, 'rb')"), 0)

    def test_open_binary_mode_keyword_passes(self):
        self.assertEqual(self.flagged("open(p, mode='wb')"), 0)

    def test_open_with_encoding_passes(self):
        self.assertEqual(self.flagged("open(p, encoding='utf-8')"), 0)

    def test_path_open_without_encoding_is_flagged(self):
        self.assertEqual(self.flagged("p.open()"), 1)
        self.assertEqual(self.flagged("p.open('r')"), 1)

    def test_path_open_binary_and_encoding_pass(self):
        self.assertEqual(self.flagged("p.open('rb')"), 0)
        self.assertEqual(self.flagged("p.open(encoding='utf-8')"), 0)

    def test_io_open_follows_builtin_rules(self):
        self.assertEqual(self.flagged("io.open(p)"), 1)
        self.assertEqual(self.flagged("io.open(p, 'rb')"), 0)

    def test_self_open_helper_is_skipped(self):
        self.assertEqual(self.flagged("self.open(x)"), 0)

    def test_violation_names_file_and_line(self):
        self.assertEqual(find_violations("x = 1\np.read_text()", "a.py"), ["a.py:2 read_text() without encoding"])


if __name__ == "__main__":
    unittest.main()
