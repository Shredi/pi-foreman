// Native paths in bash command lines (r8 item 6). The bash tools run Git Bash on Windows, where an unquoted `\` is an
// escape: `C:\Users\x` runs as the drive-relative `C:Usersx`. Fixtures that interpolate a native path into a bash line
// spell it the way bash keeps it; on POSIX hosts the path is returned unchanged.

/** `p` as a bash word: the forward-slash form on win32 (`C:/Users/x`), unchanged elsewhere. */
export function bashPath(p: string, platform: string = process.platform): string {
  return platform === "win32" ? p.replace(/\\/g, "/") : p;
}

/** `p` as a double-quoted native bash word on win32 (`"C:\Users\x"`: bash keeps a `\` before a plain character), unchanged elsewhere. */
export function bashQuoted(p: string, platform: string = process.platform): string {
  return platform === "win32" ? `"${p}"` : p;
}
