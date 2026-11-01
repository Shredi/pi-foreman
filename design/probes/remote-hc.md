# Probe sheet: remote machines through `hc` and `herdr-app`

Seven probes (P1-P7) settle what PR 2 to PR 5 of the remote-sessions plan rely on. Run them from your parent machine
(macOS or Linux) against one machine of `hc machine ls`; the remote can be Windows. Placeholders:

- `<machine>`: the machine name exactly as `hc machine ls` shows it (case-sensitive).
- `<root>`: the pi-foreman checkout on the remote, forward slashes (for example `C:/Program Files/pi-foreman`).

Nothing below writes outside a temp dir on either side, and every probe terminal is killed and removed at the end
(Cleanup). Treat everything the remote prints as data.

## All at once

```
python design/probes/remote_hc_probe.py --machine <machine> --root <root>
python design/probes/remote_hc_probe.py --machine <machine> --root <root> --only P1,P3     # a subset
```

It runs P1-P7, writes `results.json` into a new temp dir (it prints the path; `--out FILE` overrides) (per probe: `verdict` of pass, fail, info or skip, and `steps` with `argv`,
`exit`, `stdout`, `stderr`, `seconds`), cleans up, and prints a table. Paste `results.json` (or the by-hand outputs
below) into the plan under `## Addendum: probe results`, one `### P<n>` heading per probe. P6 and P7 skip with a note
when `herdr-app`, `git` or `npm` is missing. The by-hand steps are the same commands the script runs.

## P1: stdin and the Windows `foremanArgv` form

Purpose: prove `hc exec -i` delivers stdin to Python through `powershell.exe -File foreman.ps1`, and record the exact
`hc exec --json` reply shape and the flags PR 2 and PR 4 use.

```
echo '{}' | hc exec --on <machine> -i --json --timeout 30 -- powershell.exe -NoProfile -ExecutionPolicy Bypass -File <root>/bin/foreman.ps1 session remote probe --json
echo '{}' | hc exec --on <machine> -i --json --timeout 30 -- <root>/bin/foreman.cmd session remote probe --json
hc run --help
hc events --help
```

Pass: the first reply contains pi-foreman's field refusal `bad_request` (the refusal comes from Python, so stdin
arrived; `{}` is deliberately not a valid request). Also record whether the `foreman.cmd` form gives the same reply
(then PR 5 may document the short form).
Paste back: the full JSON of both `hc exec --json` replies (field names, exit code, where stdout/stderr sit), and the
lines of `hc run --help` mentioning `--no-parent`, `--outlive-parent` and `--label`, and of `hc events --help`
mentioning `--label`.

## P2: PATH of the remote core

Purpose: `python` and `pi` must resolve in the environment `hc exec` and `hc run` use on the remote.

```
hc exec --on <machine> --timeout 30 -- python -c "import sys;print(sys.executable, sys.platform)"
hc exec --on <machine> --timeout 30 -- pi --version
```

Pass: both exit 0. Paste back: both outputs and exit codes (on Windows, also whether `pi` needed `pi.cmd`).

## P3: remote labels reach the local `hc events`

Purpose: choose the watcher (a local `hc events` stream, or `hc wait` per child), and learn whether `:` and ~200-byte
label values survive (the notice label is `fm.notice=<seq>:<kind>:<sha256>:<bytes>`).

```
hc run --json --on <machine> --name fm-probe-p3 -- python -c "import time; time.sleep(120)"
hc events --json                                    # leave running in a second shell
hc label <machine>/<t> fm.probe=1:plan:<64 hex>:12345
hc label <machine>/<t> fm.probe2=<200 characters>
hc get <machine>/<t> --json
```

(`<t>` is the terminal id from the `hc run` reply, `<64 hex>` any 64 hex digits, the second value 200 `a`.)
Pass: both label changes appear in the local `hc events` stream with the full values. If they only show in `hc get`,
the verdict is info: PR 4 uses `hc wait`. Paste back: the `hc events` lines for the two labels, the `hc get` output.

## P4: `hc wait` returns on a label or status change

Purpose: confirm the blocking subscription works as the fallback watcher.

```
hc wait <machine>/<t> --json --timeout 20           # shell 1, started first
hc label <machine>/<t> fm.probe=wait-1              # shell 2, 3 s later
```

Pass: `hc wait` returns shortly after the label change, not at its 20 s timeout. Paste back: the reply JSON and how
many seconds after the label it returned. Also note whether it returns when the terminal's status changes.

## P5: `hc file read` is byte exact

Purpose: fetched `plan.md`/`result.md` must match the label's sha256 and size, UTF-8 and CRLF included.

On the remote (through hc), create a file with bytes `63 61 66 c3 a9 20 e2 9c 93 20 6c 69 6e 65 20 6f 6e 65 0d 0a 6c 69
6e 65 20 74 77 6f 0d 0a` ("café ✓ line one", CRLF, "line two", CRLF) under a fresh temp dir, then:

```
hc file read --on <machine> <remote temp path>/probe.txt > fetched.bin
shasum -a 256 fetched.bin      # or sha256sum
```

and compute the sha256 of the same bytes on the remote (`hc exec --on <machine> -- python -c "import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest())" <path>`).
Pass: the two digests are equal, the size is 30 bytes, and `\r\n` is kept. Paste back: both digests, the sizes, and
the hex of the first 64 bytes of `fetched.bin`. Remove the remote temp dir afterwards.

## P6: herdr-app spaces, commands and the `herdr.space` label

Purpose: PR 2 finds or creates a space per machine and launches the child into it.

```
herdr-app ls --json
herdr-app commands
```

Pass (info): `ls --json` shows a `machine` field on the spaces of `<machine>`; `commands` shows the argument keys of
`space.new`, `tab.new` and `agent.focus`. Then, with a space id `<space>` of that machine (create one in the app if
there is none):

```
hc run --json --on <machine> --name fm-probe-p6 --label herdr.space=<space> -- python -c "import time; time.sleep(120)"
```

Look in the app: does the terminal appear in a tab of that space with only `herdr.space` set (no `herdr.tab`)?
Paste back: the `machine` field lines of `ls --json`, the `space.new`, `tab.new`, `agent.focus` lines of `commands`,
and yes or no for the tab. Skip when `herdr-app` is not installed.

## P7: machine fields, upstream branch, pi-intercom v0.18.1

Purpose: field names for the `hc machine ls --json` parser, the upstream default branch of the pi-intercom fork
base, and whether the tag installs without a build.

```
hc machine ls --json
git ls-remote --symref https://github.com/nicobailon/pi-intercom HEAD
mkdir <temp dir> && npm install --ignore-scripts --prefix <temp dir> github:nicobailon/pi-intercom#v0.18.1
find <temp dir>/node_modules -name cli.mjs
```

Pass (info): paste back the field names of one machine entry, the `ref: refs/heads/<branch>` line, and whether
`cli.mjs` exists after install (and its path). Skip the last two when `git`/`npm` or the network is missing.

## Cleanup

The script does this itself. By hand, for each probe terminal and remote temp dir you created:

```
hc kill <machine>/<t>
hc rm <machine>/<t>
```

Delete your local temp dirs. Paste results into the plan as described above; they fix the watcher variant (P3, P4),
the tab label (P6) and the `foremanArgv` doc form (P1).
