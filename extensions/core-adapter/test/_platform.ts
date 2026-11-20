// Shared platform switch for the core-adapter tests. A test that needs POSIX semantics
// (a shell line, a unix mode, a symlink fixture) sets `skip: posixOnly`; `posix` is the
// boolean for the rest.

/** The skip reason on win32, false elsewhere: pass it as a test's `skip` option. */
export function skipUnlessPosix(platform: string = process.platform): false | string {
  return platform === "win32" ? "POSIX only" : false;
}

export const posix = process.platform !== "win32";
export const posixOnly = skipUnlessPosix();
