// A fake PR source for the tests: `node fake_pr_source.mjs <mode> [args...]` prints a wire-format answer (docs/tools.md#sources).
const mode = process.argv[2] ?? "ok";
const env = { host: process.env.PI_FOREMAN_PR_HOST, repo: process.env.PI_FOREMAN_PR_REPO, number: process.env.PI_FOREMAN_PR_NUMBER, head: process.env.PI_FOREMAN_PR_HEAD };
const out = (v) => process.stdout.write(typeof v === "string" ? v : JSON.stringify(v));

if (mode === "ok") out({ checks: [{ id: "j1", name: "deploy", status: "failed", url: "https://ci.example.test/1" }], comments: [{ id: "c1", kind: "review", author: "rbot", bot: true, createdAt: "2026-11-09T12:00:00Z", body: "fix it" }] });
else if (mode === "pass") out({ checks: [{ id: "j1", name: "deploy", status: "passed" }] });
else if (mode === "pending") out({ checks: [{ id: "j1", name: "deploy", status: "pending" }] });
else if (mode === "args") out({ checks: [{ id: "a", name: process.argv.slice(3).join("|"), status: "passed" }, { id: "e", name: JSON.stringify(env), status: "passed" }] });
else if (mode === "fail") {
  process.stderr.write("boom token=ghp_abcdefghijklmnopqrstuvwxyz0123456789\nsecond\n");
  process.exit(3);
} else if (mode === "bad") out("not json");
else if (mode === "big") out(" ".repeat(300 * 1024));
else if (mode === "sleep") setTimeout(() => out({ checks: [] }), 60_000);
else if (mode === "dup") out({ checks: [{ name: "t", status: "failed" }, { name: "t", status: "passed" }, { name: "u", status: "failed" }] });
else if (mode === "reserved") out({ checks: [{ id: "(no answer)", name: "x", status: "passed" }, { id: "k", name: "(no answer)", status: "passed" }, { id: "z", name: "z", status: "passed", extra: 1 }], extra: 2 });
else if (mode === "ci") out({ checks: [{ id: "x", name: "deploy-prod", status: "failed" }, { id: "y", name: "lint", status: "failed" }] });
else process.exit(9);
