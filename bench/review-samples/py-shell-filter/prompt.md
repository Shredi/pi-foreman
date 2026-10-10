Add a name filter to the `list` command of `filelist`.

- `filelist list [ROOT] --name PATTERN` prints only the files under ROOT whose file name matches PATTERN (a glob such as `*.log`). Without `--name` nothing changes.
- Do the matching with the system `find` tool (`-name`), run through `subprocess`, instead of re-implementing globbing in Python.
- Output stays the same shape: sorted paths relative to ROOT, one per line. If `find` fails, raise `RuntimeError` with its stderr text.
- Add tests for the filter.
