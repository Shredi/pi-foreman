/** File identity from bigint stats: NTFS 64-bit file ids lose low bits as JS numbers, so identity is compared exactly. */
import type * as fs from "node:fs";

/** `dev:ino` as exact decimal text, or null when the file system gives no id (ino 0n). */
export function fileIdOf(st: fs.BigIntStats): string | null {
  return st.ino === 0n ? null : `${st.dev}:${st.ino}`;
}

/** True only when both ids are known and equal; an unknown id never matches (fails closed). */
export function sameFileId(a: fs.BigIntStats, b: fs.BigIntStats): boolean {
  const x = fileIdOf(a);
  const y = fileIdOf(b);
  return x !== null && y !== null && x === y;
}
