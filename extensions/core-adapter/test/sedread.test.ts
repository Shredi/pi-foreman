import { test } from "node:test";
import assert from "node:assert/strict";
import { isReadOnlySed } from "../sedread.ts";

test("isReadOnlySed: print-only scripts with addresses are allowed", () => {
  for (const c of ["sed -n 1,20p f.go", "sed -n '5,9p' g.go", "sed -n '/func/,/^}/p' a.go", "sed -n '$p' f", "sed -nE -e '1p;3,$!d' f", "sed -n '/[a-z]x/{p;q}' f", "sed -n '0~4p' f"]) assert.ok(isReadOnlySed(c), c);
});

test("isReadOnlySed: writes, exec, reads, s, script files and shell tricks are refused", () => {
  for (const c of [
    "sed -n '1wout' f", "sed -n 's/a/b/wout' f", "sed -n '1etouch x' f", "sed -n -f s.sed f", "sed -i 1d f",
    "sed -n 1p f > out", "sed --in-place=.bak -n 1p f", "sed -n 'w out' f", "sed -n '1r /etc/passwd' f", "sed -n s/a/b/p f",
    "sed -n 1p $(x)", "sed -n 1p `x`", "sed -n \"$p\" f", "sed -n 1p *.go", "sed -n '/[/]w x/p' f", "sed -n '1p' f; rm f",
    "sed -n --file=s f", "sed -n '1p w' f", "sed -n '1{p' f", "sed",
  ]) assert.ok(!isReadOnlySed(c), c);
});
