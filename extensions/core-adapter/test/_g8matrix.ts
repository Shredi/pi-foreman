// The matrix of the restart, privilege and disk floors (plan rw4-guard-reads section 1): the shapes a real program of each group can stand in, and the
// judges that can refuse it. Shared by g8-matrix.test.ts and the recorder that writes the before/after tables. Test text with guarded words is data.
import { baseFloorEnv } from "../gate.ts";
import { lineFloors, maskLine, rawFloors, segmentFloors } from "../floors.ts";
import { parseShell } from "../shellast.ts";

export interface Group {
  name: "restart" | "privilege" | "disk";
  prog: string;
  args: string;
  /** The floor rule a refusal of this group carries. */
  rule: string;
}

export const GROUPS: Group[] = [
  { name: "restart", prog: "reboot", args: "", rule: "floor-shutdown" },
  { name: "privilege", prog: "sudo", args: "ls", rule: "floor-privilege" },
  { name: "disk", prog: "fdisk", args: "/dev/sda", rule: "floor-disk" },
];

export interface Row {
  form: string;
  line: (g: Group) => string;
}

const w = (g: Group): string => (g.args ? `${g.prog} ${g.args}` : g.prog);

/** Forms of plan section 1 where a real program of the group must be refused in every position. */
export const POSITIONS: Row[] = [
  { form: "plain", line: (g) => w(g) },
  { form: "after ;", line: (g) => `true; ${w(g)}` },
  { form: "after &&", line: (g) => `true && ${w(g)}` },
  { form: "after ||", line: (g) => `false || ${w(g)}` },
  { form: "after |", line: (g) => `echo x | ${w(g)}` },
  { form: "after &", line: (g) => `true & ${w(g)}` },
  { form: "newline", line: (g) => `true\n${w(g)}` },
  { form: "subshell", line: (g) => `(${w(g)})` },
  { form: "brace group", line: (g) => `{ ${w(g)}; }` },
  { form: "$( )", line: (g) => `echo $(${w(g)})` },
  { form: "backticks", line: (g) => `echo \`${w(g)}\`` },
  { form: "sh -c", line: (g) => `sh -c '${w(g)}'` },
  { form: "bash -lc", line: (g) => `bash -lc "${w(g)}"` },
  { form: "eval word", line: (g) => `eval ${w(g)}` },
  { form: "env", line: (g) => `env ${w(g)}` },
  { form: "xargs", line: (g) => `xargs ${w(g)}` },
  { form: "nohup", line: (g) => `nohup ${w(g)}` },
  { form: "timeout", line: (g) => `timeout 5 ${w(g)}` },
  { form: "nice", line: (g) => `nice ${w(g)}` },
  { form: "command", line: (g) => `command ${w(g)}` },
  { form: "time", line: (g) => `time ${w(g)}` },
  { form: "absolute path", line: (g) => `/usr/sbin/${w(g)}` },
  { form: ".exe", line: (g) => `${g.prog}.exe ${g.args}`.trim() },
  { form: "escaped word", line: (g) => `\\${w(g)}` },
  { form: "quoted word", line: (g) => `"${g.prog}" ${g.args}`.trim() },
  { form: "split quotes", line: (g) => `${g.prog.slice(0, 2)}''${g.prog.slice(2)} ${g.args}`.trim() },
  { form: "line continuation", line: (g) => `${g.prog.slice(0, 2)}\\\n${g.prog.slice(2)} ${g.args}`.trim() },
  { form: "if body", line: (g) => `if true; then ${w(g)}; fi` },
  { form: "while body", line: (g) => `while true; do ${w(g)}; done` },
  { form: "for body", line: (g) => `for i in 1; do ${w(g)}; done` },
  { form: "case body", line: (g) => `case x in x) ${w(g)};; esac` },
  { form: "process substitution", line: (g) => `cat <(${w(g)})` },
  { form: "here-document into sh", line: (g) => `sh <<EOF\n${w(g)}\nEOF` },
  { form: "here-string into sh", line: (g) => `sh <<< '${w(g)}'` },
];

/**
 * A here-document whose body `maskLine` does not blank (any program but `cat`/`tee`): refused on the code before the change by the word match, whatever
 * the program does with the body (an interpreter behind a wrapper, or a data sink such as `grep`).
 * The here-string variants of these shapes were not refused before and are not rows (see GAPS).
 */
const HEREDOC_PROGRAMS = [
  "at now", "batch", "nsenter -t 1 -m sh", "docker exec -i c sh", "docker run -i alpine sh", "kubectl exec -i p -- sh", "podman exec -i c sh",
  "lxc exec c -- sh", "systemd-nspawn -D /x sh", "make -f -", "vagrant ssh", "gcloud compute ssh vm",
  "git commit -F -", "grep x", "wc -l", "gh pr create --body-file -",
];
export const HEREDOC_ROWS: Row[] = HEREDOC_PROGRAMS.map((p) => ({ form: `here-document into ${p}`, line: (g: Group) => `${p} <<EOF\n${w(g)}\nEOF` }));

/** Forms the parser marks opaque (or reads as a runner): the word match stays on these lines; pinned so a parser change cannot drop them silently. */
export const OPAQUE: Row[] = [
  { form: "function body", line: (g) => `f() { ${w(g)}; }; f` },
  { form: "exec", line: (g) => `exec ${w(g)}` },
  { form: "! negation", line: (g) => `! ${w(g)}` },
  { form: "coproc", line: (g) => `coproc ${w(g)}` },
  { form: "substitution in an assignment value", line: (g) => `x=$(${w(g)})` },
  { form: "substitution in a redirect target", line: (g) => `echo hi > $(${w(g)})` },
  { form: "[[ $( ) ]]", line: (g) => `[[ $(${w(g)}) ]]` },
  { form: "variable as command word", line: (g) => `c=${g.prog}; $c ${g.args}`.trim() },
  { form: "unquoted pipe into sh", line: (g) => `echo ${w(g)} | sh` },
];

/** Forms no judge reads as the program today (documented gaps of the plan); asserted as they are. */
export const GAPS: Row[] = [
  { form: "find -exec", line: (g) => `find . -exec ${w(g)} {} ;` },
  { form: "ssh host", line: (g) => `ssh host ${w(g)}` },
  { form: "docker exec", line: (g) => `docker exec c ${w(g)}` },
  { form: "alias then call", line: (g) => `alias x='${w(g)}'; x` },
  { form: "eval of a variable", line: (g) => `eval "$x"` },
  { form: "powershell -Command", line: (g) => `powershell -Command "${w(g)}"` },
  { form: "cmd /c", line: (g) => `cmd /c ${w(g)}` },
  { form: "busybox applet", line: (g) => `busybox ${w(g)}` },
  { form: "python -e", line: (g) => `python -e "x; ${w(g)}"` },
];

/** Harmless lines: a word of a group as an argument, a file name or a quoted pattern, or after an escaped pipe in a search. */
export const HARMLESS: Row[] = [
  { form: "search, escaped pipe", line: (g) => `grep -rn ${g.prog}\\|other src` },
  { form: "search, escaped pipe, word second", line: (g) => `grep -rn other\\|${g.prog} src` },
  { form: "search, escaped pipe, find", line: (g) => `find . -name x -o -regex ${g.prog}\\|y` },
  { form: "quoted pattern", line: (g) => `grep -rn '${w(g)}' src` },
  { form: "double-quoted pattern", line: (g) => `grep -rn "${w(g)}" docs` },
  { form: "file name", line: (g) => `cat docs/${g.prog}.md` },
  { form: "argument", line: (g) => `echo ${g.prog}` },
  { form: "commit message", line: (g) => `git commit -m "mention ${w(g)} in docs"` },
];

export interface Verdict {
  /** lineFloors refuses with this group's rule (kind deny). */
  refused: boolean;
  /** The word match (rawFloors over the masked line) names this group's rule. */
  word: boolean;
  /** Some segment's structured check names this group's rule. */
  structure: boolean;
}

export function judge(line: string, g: Group, cwd: string = process.cwd()): Verdict {
  const env = baseFloorEnv(cwd);
  const segs = parseShell(line, { cwd });
  const lf = lineFloors(line, segs, env);
  return {
    refused: lf?.kind === "deny" && lf.rule === g.rule,
    word: rawFloors(maskLine(line, segs))?.rule === g.rule,
    structure: segs.some((s) => segmentFloors(s, env, segs)?.rule === g.rule),
  };
}

/** `refused (word)`, `refused (structure)`, `refused (both)` or `not refused`. */
export function label(v: Verdict): string {
  if (!v.refused) return "not refused";
  return `refused (${v.word && v.structure ? "both" : v.word ? "word" : v.structure ? "structure" : "other"})`;
}
