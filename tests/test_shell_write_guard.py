"""shell_write_guard.py: decisions over command STRINGS only. Nothing here runs a command
from the table; the guard only parses them against a temp workspace."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "shell_write_guard.py"
sys.path.insert(0, str(ROOT / "scripts"))
import shell_write_guard as swg  # noqa: E402

# (command, expected kind or None). `WS` is replaced by the workspace root.
TABLE = [
    # bench shapes (the 2b foreman wrote project files this way)
    ("cd WS && python3 - <<'EOF'\np='internal/api/router.go'\ns=open(p).read()\ns=s.replace('a','b')\n"
     "open(p,'w').write(s)\nEOF", "python"),
    ("cd WS && cat > internal/api/cors_test.go <<'EOF'\npackage api\nEOF", "redirect"),
    # reads and writes outside the project
    ("cat f", None),
    ("grep x src/a.go > /dev/null", None),
    ("echo x > .workflow/n.md", None),
    ("cp a /tmp/b", None),
    ("cd .workflow && cat > n.md <<'EOF'\nnote\nEOF", None),
    ("go test ./... 2>&1 | tail -20", None),
    ("ls -la # a comment > x", None),
    ("echo 'a > b'", None),
    ("[[ 3 > 2 ]] && echo ok", None),
    ("(( i > 3 )) && echo ok", None),
    # redirections
    ("echo x > f", "redirect"),
    ("echo x >> f", "redirect"),
    ("echo x >| f", "redirect"),
    ("ls &> f", "redirect"),
    ("ls 2> err.txt", "redirect"),
    ("echo x>f", "redirect"),
    ("ls >&out.log", "redirect"),
    ("ls 2>&1 | head", None),
    ("ls >&2", None),
    # tee
    ("echo x | tee -a out.txt", "tee"),
    ("echo x | tee .workflow/x", None),
    # in-place editors
    ("sed -i 's/a/b/' src/x.go", "sed-i"),
    ("sed -i '' 's/a/b/' src/x.go", "sed-i"),
    ("sed --in-place=.bak -e s/a/b/ f", "sed-i"),
    ("sed -i '' 's/a/b/' .workflow/x", None),
    ("sed 's/a/b/' src/x.go", None),
    ("perl -pi -e 's/a/b/' f", "perl-i"),
    ("perl -lne 'print' f", None),
    ("ruby -i -pe 'x' f", "ruby-i"),
    # file utilities
    ("cp a src/b", "cp"),
    ("mv .workflow/a src/", "mv"),
    ("mv src/a /tmp/", "mv"),
    ("install -m 644 a src/b", "install"),
    ("ln -s x src/y", "ln"),
    ("rsync -a x/ src/", "rsync"),
    ("rsync -a src/ host:/x", None),
    ("touch src/new.go", "touch"),
    ("truncate -s 0 f", "truncate"),
    ("dd if=/dev/zero of=f bs=1 count=1", "dd"),
    ("dd if=f of=/tmp/x", None),
    # git and patch
    ("git apply x.diff", "git"),
    ("git apply --check x.diff", None),
    ("git am < x.mbox", "git"),
    ("git restore src/x", "git"),
    ("git checkout -- src/x", "git"),
    ("git checkout HEAD~1 -- src/x", "git"),
    ("git checkout -b feat", None),
    ("git stash pop", "git"),
    ("git stash apply", "git"),
    ("git stash list", None),
    ("git reset --hard", "git"),
    ("git reset HEAD~1", None),
    ("git -C /tmp/other reset --hard", None),
    ("patch -p1 < x.diff", "patch"),
    ("patch --dry-run -p1 < x.diff", None),
    # interpreter code
    ("python3 -c \"open('f','w').write('x')\"", "python"),
    ("python3 -c \"open('/tmp/f','w').write('x')\"", None),
    ("python3 -c \"print(open('f', encoding='ascii').read())\"", None),
    ("python3 <<'EOF'\nfrom pathlib import Path\nPath('src/a').write_text('x')\nEOF", "python"),
    ("python3 <<'EOF'\nfrom pathlib import Path\nPath('.workflow/a').write_text('x')\nEOF", None),
    ("printf \"open('f','w')\" | python3", "python"),
    ("node -e \"require('fs').writeFileSync('a.txt','x')\"", "node"),
    ("node -e \"require('fs').writeFileSync('.workflow/a.txt','x')\"", None),
    ("perl -e 'open(my $fh, \">\", \"f\"); print $fh 1'", "perl"),
    ("perl -e 'open(my $fh, \"<\", \"f\"); print <$fh>'", None),
    ("ruby -e 'File.write(\"f\", \"x\")'", "ruby"),
    ("sh -c 'echo x > f'", "redirect"),
    ("bash -c \"cd src && echo hi > x\"", "redirect"),
    ("sh -c 'echo x > /tmp/f'", None),
    ("eval \"echo x > f\"", "redirect"),
    # unresolvable targets count as writes
    ("echo x > $OUT", "redirect"),
    ("echo x > *.go", "redirect"),
    ("echo x > \"$(pwd)/f\"", "redirect"),
    ("cp a `echo b`", "cp"),
    ("cd $D && echo x > f", "redirect"),
    ("echo x 'unterminated", "unreadable"),
    # cd tracking and scoping
    ("(cd .workflow); echo x > f", "redirect"),
    ("(cd .workflow && echo x > f)", None),
    ("cd .workflow | true; echo x > f", "redirect"),
    ("cd .workflow && sed -i s/a/b/ ../src/x", "sed-i"),
    ("cd /tmp && echo x > f", None),
    ("cd /tmp; cd WS/src; echo x > f", "redirect"),
    # wrappers and nested commands
    ("find . -name '*.go' -exec sed -i s/a/b/ {} \\;", "sed-i"),
    ("ls | xargs sed -i s/a/b/", "sed-i"),
    ("sudo tee f < x", "tee"),
    ("env -C src touch x", "touch"),
    ("env -C /tmp touch x", None),
    ("echo $(echo x > f)", "redirect"),
    # method-call open: the mode is the first argument (security review A-M1)
    ("python3 - <<'EOF'\nfrom pathlib import Path\np = Path('src/a.py')\nwith p.open('w') as f:\n    f.write('x')\nEOF", "python"),
    ("python3 -c \"from pathlib import Path; Path('src/a.py').open(mode='w')\"", "python"),
    ("python3 -c \"open(mode='w', file='src/a.py')\"", "python"),
    ("python3 -c \"from pathlib import Path; print(Path('src/a.py').open().read())\"", None),
    # git checkout/switch: anything but creating a branch at HEAD rewrites the work tree (A-M2)
    ("git checkout src/a.py", "git"),
    ("git checkout .", "git"),
    ("git checkout HEAD src/a.py", "git"),
    ("git checkout main", "git"),
    ("git switch main", "git"),
    ("git switch -c feat", None),
    # deletes and renames (A-M3)
    ("rm -rf src", "delete"),
    ("unlink src/a.py", "delete"),
    ("git rm src/a.py", "delete"),
    ("git mv src/a.py src/c.py", "rename"),
    ("rm -f .workflow/tmp.md", None),
    ("rm /tmp/x", None),
    # project runners are looked through (A-M4)
    ("uv run python - <<'X'\nopen('src/a.py','w')\nX", "python"),
    ("npx tsx -e \"require('fs').writeFileSync('src/a.py','x')\"", "node"),
    ("pnpm exec node -e \"require('fs').writeFileSync('src/a.py','x')\"", "node"),
    ("poetry run sed -i s/a/b/ src/a.py", "sed-i"),
    ("deno eval \"Deno.writeTextFileSync('src/a.py','x')\"", "node"),
    ("uv run pytest -q", None),
    # minors: shell option clusters, simple destination forms
    ("bash -euo pipefail -c 'echo x > src/a.py'", "redirect"),
    ("bash -euo pipefail -c 'echo x > /tmp/a'", None),
    ("sort -o src/a.txt src/a.txt", "sort"),
    ("curl -sSLO https://example.invalid/a.py", "curl"),
    ("curl -o /tmp/a https://example.invalid/a", None),
    ("wget -P src https://example.invalid/a", "wget"),
    ("wget -qO- https://example.invalid/a", None),
    ("tar -xf /tmp/a.tar -C src", "tar"),
    ("tar tzf /tmp/a.tgz", None),
    ("unzip /tmp/a.zip", "unzip"),
    ("unzip -l /tmp/a.zip", None),
    ("awk -i inplace '{print}' src/a.py", "awk-i"),
    ("awk '{print $1}' src/a.py", None),
    # harness-friction lane A literal rows: read-only commands (rows 12, 13, 18, 20) never count as writes
    ("cd WS; grep -rln \"symbols.json\" --exclude-dir=node_modules --exclude-dir=.git . | head", None),
    ("cat <<'EOT'\nnotes: the .pi dir and $x are prose\nEOT", None),
    ("grep -rn x --exclude-dir=.claude src", None),
    ("git branch -a && python3 -c 'print(\"git\")'", None),
    ("env | grep PATH", None),
]

# PowerShell (the foreman's opt-in powershell tool, security review B-M1)
PS_TABLE = [
    ("Set-Content -Path src/a.py -Value x", "set-content"),
    ("'x' | Out-File src/a.py", "out-file"),
    ("Add-Content src/a.py x", "add-content"),
    ("ni -ItemType File -Path src -Name b.py", "new-item"),
    ("Copy-Item /tmp/x src/a.py", "copy-item"),
    ("mv /tmp/x src/a.py", "move-item"),
    ("del src/a.py", "remove-item"),
    ("Get-ChildItem src | Remove-Item", "remove-item"),
    ("ren src/a.py b.py", "rename-item"),
    ("Clear-Content src/a.py", "clear-content"),
    ("echo x > src/a.py", "redirect"),
    ("[IO.File]::WriteAllText('src/a.py', 'x')", "io-file"),
    ("git checkout src/a.py", "git"),
    ("Set-Content $f x", "set-content"),
    ("Set-Content .workflow/n.md 'hello'", None),
    ("Copy-Item src/a.py /tmp/x", None),
    ("echo x > $null; git status 2>&1", None),
    ("[IO.File]::ReadAllText('src/a.py')", None),
    ("Get-Content src/a.py | Select-String foo", None),
]


class ShellWriteGuardTest(unittest.TestCase):
    def setUp(self):
        self.ws = os.path.realpath(tempfile.mkdtemp(prefix="pf-swg-"))
        for d in (".workflow", "src"):
            os.mkdir(os.path.join(self.ws, d))

    def tearDown(self):
        shutil.rmtree(self.ws, ignore_errors=True)

    def test_table(self):
        for command, kind in TABLE:
            cmd = command.replace("WS", self.ws)
            with self.subTest(command=command):
                hit = swg.decide(cmd, self.ws, self.ws)
                self.assertEqual(hit[0] if hit else None, kind, hit)

    def test_powershell_table(self):
        for command, kind in PS_TABLE:
            with self.subTest(command=command):
                hit = swg.decide(command, self.ws, self.ws, "powershell")
                self.assertEqual(hit[0] if hit else None, kind, hit)

    @unittest.skipIf(os.name == "nt", "Win32 folds `..` before it resolves links (so does ntpath.realpath)")
    def test_workflow_symlink_dotdot(self):
        # `.workflow/l/..` is the project root when `l` points into the project: the kernel
        # resolves the link before the `..`
        try:
            os.symlink(os.path.join("..", "src"), os.path.join(self.ws, ".workflow", "l"))
        except (OSError, NotImplementedError):
            self.skipTest("no symlinks")
        for cmd in ("echo x > .workflow/l/../a.py", "cd -P .workflow/l/.. && echo x > a.py"):
            with self.subTest(command=cmd):
                self.assertIsNotNone(swg.decide(cmd, self.ws, self.ws))
        self.assertIsNone(swg.decide("cd .workflow/l/.. && echo x > a.py", self.ws, self.ws))   # logical cd

    def test_allow_dir_for_the_worktree_convention_dir(self):
        # row 16: `cp -R node_modules ../<repo>.worktrees/<b>/node_modules` writes below an owned dir
        base = os.path.realpath(tempfile.mkdtemp(prefix="pf-swg-wt-"))
        self.addCleanup(shutil.rmtree, base, True)
        repo = os.path.join(base, "repo")
        owned = os.path.join(base, "repo.worktrees")
        for d in (repo, os.path.join(repo, "node_modules"), os.path.join(owned, "b")):
            os.makedirs(d)
        cmd = "git worktree add -b hf ../repo.worktrees/b origin/main; cp -R node_modules ../repo.worktrees/b/node_modules"
        elsewhere = "cp -R node_modules ../repo.other/b/node_modules"
        # confined (a planner child): a write outside the workspace counts, unless an owned dir covers it
        refused = swg.decide(cmd, repo, repo, "bash", None, True)
        self.assertIsNotNone(refused)
        self.assertIsNone(swg.decide(cmd, repo, repo, "bash", None, True, None, [owned]))
        self.assertIsNotNone(swg.decide(elsewhere, repo, repo, "bash", None, True, None, [owned]))
        self.assertIsNotNone(swg.decide("cp -R node_modules ../repo.worktrees", repo, repo, "bash", None, True, None, [owned]), "the owned dir itself")
        # relative and root entries are ignored
        for bad in (["repo.worktrees"], ["/"], [""]):
            with self.subTest(dirs=bad):
                self.assertIsNotNone(swg.decide(cmd, repo, repo, "bash", None, True, None, bad))
        # inside the workspace an owned dir lifts the project-write refusal too
        os.makedirs(os.path.join(repo, "out"))
        self.assertIsNotNone(swg.decide("echo x > out/f", repo, repo))
        self.assertIsNone(swg.decide("echo x > out/f", repo, repo, "bash", None, False, None, [os.path.join(repo, "out")]))

    def test_allow_dir_argv_option_and_the_raw_operand_message(self):
        base = os.path.realpath(tempfile.mkdtemp(prefix="pf-swg-argv-"))
        self.addCleanup(shutil.rmtree, base, True)
        repo = os.path.join(base, "repo")
        owned = os.path.join(base, "repo.worktrees")
        os.makedirs(repo)
        os.makedirs(owned)
        payload = json.dumps({"tool_input": {"command": "cp -R node_modules ../repo.worktrees/b/node_modules"}, "cwd": repo, "workspace": repo, "confine": True})
        def run(*args):
            return subprocess.run([sys.executable, "-E", "-s", str(SCRIPT), *args], input=payload, capture_output=True, text=True)
        self.assertIn("deny", run().stdout)
        self.assertEqual(run("--allow-dir", owned).stdout, "")
        self.assertEqual(run("--allow-dir", os.path.join(base, "x"), "--allow-dir", owned).stdout, "", "repeatable")
        # an unresolvable target shows its operand text and says so, instead of a bare <unresolved>
        bad = json.dumps({"tool_input": {"command": "cp a $UNKNOWN/b"}, "cwd": repo, "workspace": repo, "confine": True})
        out = subprocess.run([sys.executable, "-E", "-s", str(SCRIPT)], input=bad, capture_output=True, text=True).stdout
        self.assertIn("/b (unresolved)", out)
        self.assertNotIn("<unresolved>", out)

    def test_allowed_dirs(self):
        # scratchpad mode: the adapter adds the scratch dir; default (missing) is .workflow only
        os.mkdir(os.path.join(self.ws, "notes"))
        dirs = [".workflow", "notes"]
        self.assertIsNone(swg.decide("echo x > notes/n.md", self.ws, self.ws, "bash", dirs))
        self.assertIsNone(swg.decide("echo x > .workflow/n.md", self.ws, self.ws, "bash", dirs))
        self.assertEqual(swg.decide("echo x > notes/n.md", self.ws, self.ws)[0], "redirect")
        self.assertEqual(swg.decide("echo x > notes", self.ws, self.ws, "bash", dirs)[0], "redirect")   # the dir itself
        self.assertEqual(swg.decide("echo x > src/f", self.ws, self.ws, "bash", dirs)[0], "redirect")
        # absolute, `..` and root entries are ignored
        for bad in (["/"], [".."], ["."], ["notes/../src"], [self.ws]):
            with self.subTest(dirs=bad):
                self.assertEqual(swg.decide("echo x > src/f", self.ws, self.ws, "bash", bad)[0], "redirect")
        try:
            os.symlink(os.path.join("..", "src"), os.path.join(self.ws, "notes", "l"))
        except (OSError, NotImplementedError):
            return
        self.assertEqual(swg.decide("echo x > notes/l/f", self.ws, self.ws, "bash", dirs)[0], "redirect")

    def test_confine_refuses_writes_outside_the_workspace(self):
        # planner child: outside the workspace counts too (absolute, `..`, `~`); allowed dirs and /dev/null stay open
        out = tempfile.mkdtemp(prefix="pf-swg-out-")
        self.addCleanup(shutil.rmtree, out, True)
        out = out.replace("\\", "/")  # a Windows temp path goes unquoted into the bash command below
        for cmd, kind in (("echo x > %s/f" % out, "redirect"), ("echo x > ../f", "redirect"), ("echo x | tee ~/f", "tee")):
            with self.subTest(command=cmd):
                self.assertIsNone(swg.decide(cmd, self.ws, self.ws))
                hit = swg.decide(cmd, self.ws, self.ws, "bash", [".workflow"], True)
                self.assertEqual(hit[0] if hit else None, kind, hit)
        self.assertIsNone(swg.decide("echo x > .workflow/n.md; echo y > /dev/null", self.ws, self.ws, "bash", [".workflow"], True))

    def test_confine_allows_writes_inside_the_child_scratch_dir_only(self):
        # planner child with a scratch dir (childscratch.ts): inside it, also via $FOREMAN_SCRATCH, writes pass
        root = tempfile.mkdtemp(prefix="pf-swg-scratch-")
        self.addCleanup(shutil.rmtree, root, True)
        scratch = os.path.join(os.path.realpath(root), "L1")
        os.mkdir(scratch)
        sc = scratch.replace("\\", "/")
        for cmd, kind in (("echo x > %s/f" % sc, None), ("cp -r . $FOREMAN_SCRATCH/copy && rm -rf ${FOREMAN_SCRATCH}/copy", None),
                          ("echo x > '$FOREMAN_SCRATCH/f'", "redirect"), ("rm -rf %s" % sc, "delete"),
                          ("echo x > %s/../f" % sc, "redirect"), ("echo x > src/f", "redirect")):
            with self.subTest(command=cmd):
                hit = swg.decide(cmd, self.ws, self.ws, "bash", [".workflow"], True, scratch)
                self.assertEqual(hit[0] if hit else None, kind, hit)

    def test_symlinked_allowed_dir_is_not_writable(self):
        # `.workflow/scratch` -> `../src`: the allowed dir is lexical, the target real, so nothing lands in it
        os.makedirs(os.path.join(self.ws, ".workflow"), exist_ok=True)
        try:
            os.symlink(os.path.join("..", "src"), os.path.join(self.ws, ".workflow", "scratch"), target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("no symlinks")
        hit = swg.decide("echo x > .workflow/scratch/a.ts", self.ws, self.ws, "bash", [".workflow", ".workflow/scratch"])
        self.assertEqual(hit[0] if hit else None, "redirect")

    def test_windows_path_flavour(self):
        # Windows (CI item 29) emulated with ntpath on any host: bash strips the backslashes of an
        # unquoted `C:\a\b`, leaving the drive-relative `C:ab`, whose directory is unknown -> refused
        import ntpath
        import types
        fake = types.SimpleNamespace(**{k: getattr(os, k) for k in dir(os) if not k.startswith("__")})
        fake.name, fake.path, fake.sep, fake.altsep = "nt", ntpath, "\\", "/"
        real_os, real_sys = swg.os, swg.sys
        swg.os, swg.sys = fake, types.SimpleNamespace(platform="win32")
        try:
            ws = "C:\\Users\\u\\AppData\\Local\\Temp\\pf-swg-x"
            for cmd, kind in (("cd /tmp; cd %s/src; echo x > f" % ws, "redirect"),
                              ("cd /tmp; cd '%s/src'; echo x > f" % ws, "redirect"),
                              ("cd /tmp; cd %s/src; echo x > f" % ws.replace("\\", "/"), "redirect"),
                              ("cd D: && echo x > f", "redirect"),
                              ("cd C:/other && echo x > f", None),
                              ("echo x > %s/.workflow/n.md" % ws.replace("\\", "/"), None)):
                with self.subTest(command=cmd):
                    hit = swg.decide(cmd, ws, ws)
                    self.assertEqual(hit[0] if hit else None, kind, hit)
        finally:
            swg.os, swg.sys = real_os, real_sys

    def test_cwd_outside_workspace(self):
        other = os.path.realpath(tempfile.mkdtemp(prefix="pf-swg-out-"))
        try:
            self.assertIsNone(swg.decide("echo x > f; git reset --hard", other, self.ws))
            self.assertEqual(swg.decide("echo x > %s" % os.path.join(self.ws, "f").replace("\\", "/"), other, self.ws)[0], "redirect")
        finally:
            shutil.rmtree(other, ignore_errors=True)

    def test_windows_paths(self):
        if os.name == "nt":
            target = os.path.join(self.ws, "src", "x.go")
            self.assertEqual(swg.decide("cp a '%s'" % target, self.ws, self.ws)[0], "cp")
            msys = "/" + self.ws[0].lower() + self.ws[2:].replace("\\", "/")
            self.assertEqual(swg.decide("cd %s && echo x > f" % msys, "C:\\", self.ws)[0], "redirect")
        else:
            # a drive-letter path is never inside a POSIX workspace
            self.assertIsNone(swg.decide("cp a 'C:\\proj\\x.go'", self.ws, self.ws))

    def test_main_contract(self):
        def call(payload):
            return subprocess.run([sys.executable, "-E", "-s", str(SCRIPT)], input=payload.encode("utf-8"),
                                  capture_output=True, timeout=30)
        deny = call(json.dumps({"tool_name": "Bash", "tool_input": {"command": "echo x > f"}, "cwd": self.ws, "workspace": self.ws}))
        self.assertEqual(deny.returncode, 0)
        out = json.loads(deny.stdout.decode())
        self.assertEqual(out["kind"], "redirect")
        self.assertEqual(out["hookSpecificOutput"]["permissionDecision"], "deny")
        self.assertIn(swg.REFUSAL, out["hookSpecificOutput"]["permissionDecisionReason"])
        allow = call(json.dumps({"tool_name": "Bash", "tool_input": {"command": "echo x > .workflow/n.md"}, "cwd": self.ws, "workspace": self.ws}))
        self.assertEqual((allow.returncode, allow.stdout), (0, b""))
        scratch = {"tool_name": "Bash", "tool_input": {"command": "echo x > notes/n.md"}, "cwd": self.ws, "workspace": self.ws}
        self.assertEqual(json.loads(call(json.dumps(scratch)).stdout.decode())["kind"], "redirect")
        scratch["allowed_dirs"] = [".workflow", "notes"]
        self.assertEqual(call(json.dumps(scratch)).stdout, b"")
        broken = call("[1, 2]")
        self.assertEqual((broken.returncode, broken.stdout), (2, b""))
        self.assertIn(b"internal error", broken.stderr)


class ShellVarsTest(unittest.TestCase):
    """Same-line `NAME=/abs/literal` statements resolve a later `$NAME` (ledger item 12)."""

    def setUp(self):
        self.ws = os.path.realpath(tempfile.mkdtemp(prefix="pf-swg-vars-"))
        self.hand = os.path.join(self.ws, "handoffs", "s1")
        os.makedirs(self.hand)
        os.mkdir(os.path.join(self.ws, "src"))
        self.addCleanup(shutil.rmtree, self.ws, True)

    def kind(self, cmd, scratch=None):
        hit = swg.decide(cmd, self.ws, self.ws, "bash", [".workflow"], False, scratch, [self.hand])
        return hit[0] if hit else None

    def test_assignment_statement_resolves_the_use(self):
        h = self.hand
        self.assertIsNone(self.kind('cp plan.md %s/plan.md' % h))
        self.assertIsNone(self.kind('H=%s; cp plan.md "$H/plan.md"' % h))
        self.assertIsNone(self.kind('H=%s && mkdir -p ${H}/x' % h))
        self.assertIsNone(self.kind('H=%s || true; echo x > $H/n.md' % h))
        # the last assignment wins
        self.assertEqual(self.kind('H=%s; H=%s/src; echo x > $H/f' % (h, self.ws)), "redirect")
        self.assertIsNone(self.kind('H=%s/src; H=%s; echo x > $H/f' % (self.ws, h)))
        # the resolved path is checked like the literal: outside the allowed dir it is refused
        self.assertEqual(self.kind('H=%s/src; echo x > $H/f' % self.ws), "redirect")

    def test_unresolved_forms_keep_the_conservative_verdict(self):
        h = self.hand
        unknown = self.kind('cp plan.md "$H/plan.md"')
        self.assertEqual(unknown, "cp")
        for cmd in (
            'H=%s cp plan.md "$H/plan.md"' % h,                      # prefix assignment
            'true && H=%s; cp plan.md "$H/plan.md"' % h,            # after a non-assignment &&
            '(H=%s); cp plan.md "$H/plan.md"' % h,                  # subshell
            'for H in a; do cp plan.md "$H/plan.md"; done',
            'H=%s; export H=x; cp plan.md "$H/plan.md"' % h,
            'H=%s; read H; cp plan.md "$H/plan.md"' % h,
            'H=%s; while true; do cp plan.md "$H/plan.md"; done' % h,
            'H=%s; f() { cp plan.md "$H/plan.md"; }; f' % h,
            'H=%s/*; cp plan.md "$H/plan.md"' % h,                  # glob
            'H=$(pwd); cp plan.md "$H/plan.md"',
            'H=handoffs/s1; cp plan.md "$H/plan.md"',               # relative
            'H=%s & cp plan.md "$H/plan.md"' % h,
        ):
            with self.subTest(command=cmd):
                self.assertEqual(self.kind(cmd), "cp", cmd)

    def test_foreman_names_come_from_the_harness_only(self):
        root = tempfile.mkdtemp(prefix="pf-swg-vscratch-")
        self.addCleanup(shutil.rmtree, root, True)
        scratch = os.path.join(os.path.realpath(root), "L1")
        os.mkdir(scratch)
        self.assertIsNone(self.kind('mkdir -p $FOREMAN_SCRATCH/probe/x', scratch))
        # a line assignment never replaces the harness value: the write still lands in the scratch dir
        self.assertIsNone(self.kind('FOREMAN_SCRATCH=%s/src; echo x > $FOREMAN_SCRATCH/f' % self.ws, scratch))
        self.assertEqual(self.kind('FOREMAN_X=%s; echo x > $FOREMAN_X/f' % self.hand), "redirect")


class ShellVarsSecurityTest(unittest.TestCase):
    """Forms that set or split a variable keep it unresolved (reviewer findings on ledger item 12)."""

    def setUp(self):
        self.ws = os.path.realpath(tempfile.mkdtemp(prefix="pf-swg-vsec-"))
        self.hand = os.path.join(self.ws, "handoffs", "s1")
        os.makedirs(self.hand)
        os.mkdir(os.path.join(self.ws, "src"))
        self.addCleanup(shutil.rmtree, self.ws, True)

    def kind(self, cmd):
        hit = swg.decide(cmd, self.ws, self.ws, "bash", [".workflow"], False, None, [self.hand])
        return hit[0] if hit else None

    def test_append_assignment_is_refused(self):
        h = self.hand
        self.assertEqual(self.kind('H=%s; H+=/../../src/f; cp plan.md "$H/plan.md"' % h), "cp")
        self.assertEqual(self.kind('H=%s; H+=/x; cp plan.md "$H/plan.md"' % h), "cp")

    def test_other_setting_forms_are_refused(self):
        h = self.hand
        for setter in ('let H=1', 'H[0]=/x', '((H=1))', 'declare H=/x', 'typeset H=/x', 'export H=/x',
                       'read H', 'unset H', 'eval H=/x', 'source f', '. f'):
            cmd = 'H=%s; %s; cp plan.md "$H/plan.md"' % (h, setter)
            with self.subTest(command=cmd):
                self.assertEqual(self.kind(cmd), "cp", cmd)

    def test_ifs_poisons_the_line(self):
        h = self.hand
        attack = 'IFS=Z; H=%s/aZ\t%s/src/f; cp plan.md $H' % (h, self.ws)
        self.assertEqual(self.kind(attack), "cp")
        self.assertEqual(self.kind('IFS=Z; H=%s; cp plan.md "$H/plan.md"' % h), "cp")
        self.assertEqual(self.kind('H=%s; IFS=Z; cp plan.md "$H/plan.md"' % h), "cp")
        self.assertEqual(self.kind('H="%s/a %s/src/f"; cp plan.md $H' % (h, self.ws)), "cp")

    def test_control_plain_assignment_still_resolves(self):
        self.assertIsNone(self.kind('H=%s; cp plan.md "$H/plan.md"' % self.hand))


class ShellVarsReviewTest(unittest.TestCase):
    """Pre-PR review: conditional or prefixed assignments and glob values stay unresolved."""

    def setUp(self):
        self.ws = os.path.realpath(tempfile.mkdtemp(prefix="pf-swg-vrev-"))
        self.hand = os.path.join(self.ws, ".workflow", "s1")
        os.makedirs(self.hand)
        os.mkdir(os.path.join(self.ws, "src"))
        self.addCleanup(shutil.rmtree, self.ws, True)

    def kind(self, cmd):
        hit = swg.decide(cmd, self.ws, self.ws, "bash", [".workflow"], False, None, [self.hand])
        return hit[0] if hit else None

    def test_later_assignment_in_any_other_form_poisons(self):
        a, w = self.hand, self.ws
        for cmd in (
            'H=%s; if true; then H=%s/src; fi; cp f $H' % (a, w),
            'H=%s; { H=%s/src; }; cp f $H' % (a, w),
            'H=%s; ! H=%s/src; cp f $H' % (a, w),
            'H=%s; time H=%s/src; cp f $H' % (a, w),
            'H=%s; H=%s/src :; cp f $H' % (a, w),
            'H=%s; H=%s/src set --; cp f $H' % (a, w),
            'H=%s; true && { H=%s/src; }; cp f $H' % (a, w),
            'H=%s; if H=%s/src; then :; fi; cp f $H' % (a, w),
            "trap 'H=%s/src' DEBUG; H=%s; cp f $H" % (w, a),
        ):
            with self.subTest(command=cmd):
                self.assertEqual(self.kind(cmd), "cp", cmd)

    def test_glob_value_is_not_resolved(self):
        cmd = "H='%s/.workflow/.?'; cp f $H" % self.ws
        self.assertEqual(self.kind(cmd), "cp")


if __name__ == "__main__":
    unittest.main()
