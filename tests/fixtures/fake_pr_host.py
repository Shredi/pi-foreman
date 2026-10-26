#!/usr/bin/env python3
"""Fake gh/glab for tests: fake_pr_host.py <gh|glab> <args...>.

Reads $FAKE_PR_HOST_DIR/scenario.json ({"<argv prefix joined by spaces>": {"stdout", "stderr", "exit"}},
the argv starting with the kind; the longest matching prefix wins) and appends
{"argv": [...], "body": <contents of the file after --body-file/--input, if any>} to calls.jsonl.
"""
import json
import os
import sys


def main():
    d = os.environ["FAKE_PR_HOST_DIR"]
    argv = sys.argv[1:]
    body = None
    for flag in ("--body-file", "--input"):
        if flag in argv and argv.index(flag) + 1 < len(argv):
            with open(argv[argv.index(flag) + 1], "rb") as f:
                body = f.read().decode("utf-8")
    with open(os.path.join(d, "calls.jsonl"), "a", encoding="utf-8") as f:
        f.write(json.dumps({"argv": argv, "body": body}) + "\n")
    with open(os.path.join(d, "scenario.json"), encoding="utf-8") as f:
        scenario = json.load(f)
    best = None
    for key in scenario:
        words = key.split(" ")
        if argv[:len(words)] == words and (best is None or len(words) > len(best.split(" "))):
            best = key
    if best is None:
        sys.stderr.write("fake host: no scenario for %s\n" % " ".join(argv))
        return 99
    entry = scenario[best]
    for stream, key in ((sys.stdout, "stdout"), (sys.stderr, "stderr")):
        stream.buffer.write(entry.get(key, "").encode("utf-8"))   # bytes, like gh: no \n -> \r\n translation
        stream.buffer.flush()
    return entry.get("exit", 0)


if __name__ == "__main__":
    sys.exit(main())
