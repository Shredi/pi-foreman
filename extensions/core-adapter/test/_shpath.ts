// A path for a shell line a test builds. The shell parser reads an unquoted backslash as an escape (as bash does), so a native
// win32 path (`C:\Users\x`) becomes `C:Usersx`; forward slashes keep the same path one word. A posix path is unchanged.
export function shPath(p: string): string {
  return p.replace(/\\/g, "/");
}
