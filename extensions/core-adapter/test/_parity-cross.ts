// The cross product of the destructive-parity fixture (PR B2): up to two stacked command prefixes in front of a destructive body, inside a context that runs it.
// The lines are generated here; the fixture holds only the baseline of each (`cross`, one letter per line in this order).
const q = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;

export const PREFIXES = ["sudo", "sudo -u x", "doas", "env", "command", "nice", "nice -n 5", "timeout 5", "nohup", "exec", "time", "busybox", "toybox", "xargs"];
export const BODIES = ["rm -rf ~", "rm -rf /opt/x", "find / -delete", "shred /dev/sda", "mkfs /dev/sda", "sh -c 'rm -rf /'", "docker exec c rm -rf /data"];
export const CONTEXTS: { name: string; wrap: (cmd: string) => string }[] = [
  { name: "top", wrap: (c) => c },
  { name: "function-body", wrap: (c) => `f(){ ${c}; }; f` },
  { name: "sh-c", wrap: (c) => `sh -c ${q(c)}` },
  { name: "eval", wrap: (c) => `eval ${q(c)}` },
  { name: "busybox-sh-c", wrap: (c) => `busybox sh -c ${q(c)}` },
];

/** Every line: context x body x (no prefix, one prefix, two stacked prefixes), in a fixed order. */
export function crossLines(): { context: string; line: string }[] {
  const stacks: string[] = [""];
  for (const a of PREFIXES) stacks.push(`${a} `);
  for (const a of PREFIXES) for (const b of PREFIXES) stacks.push(`${a} ${b} `);
  const out: { context: string; line: string }[] = [];
  for (const c of CONTEXTS) for (const b of BODIES) for (const s of stacks) out.push({ context: c.name, line: c.wrap(s + b) });
  return out;
}
