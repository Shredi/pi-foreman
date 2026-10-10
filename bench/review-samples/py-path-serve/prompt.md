Let callers read a report by the path a client gives us.

- Add `ReportStore.read(subpath)` to `reports/store.py`. `subpath` is a relative path with `/` separators such as `2026/q1.txt`, taken from a request. It returns the file's content as bytes.
- If there is no such file, raise `ReportNotFound` with the subpath as its message.
- Add tests for `read`.
