// Skill visibility (ledger item 3): the three inputs in precedence, the frontmatter reader, the hint text and a stable split.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isHiddenSkill, parseFrontmatter, readVisibility, skillRulesOf, skillsHint, splitSkills, SKILLS_SECTION } from "../skillvisibility.ts";
import { childSkillRefs } from "../skilldirs.ts";

const none = { visible: [], hidden: [] };

test("frontmatter: top-level keys and the nested metadata map", () => {
  const fm = parseFrontmatter('---\nname: example-domain-skill\ndescription: "Handles example widgets."\nmetadata:\n  visibility: search\n  owner: "someone"\nlicense: MIT\n---\n\n# Body\nmetadata:\n  visibility: always\n');
  assert.equal(fm.name, "example-domain-skill");
  assert.equal(fm.description, "Handles example widgets.");
  assert.deepEqual(fm.metadata, { visibility: "search", owner: "someone" });
});

test("frontmatter: a skill without metadata, without frontmatter and with CRLF", () => {
  assert.deepEqual(parseFrontmatter("---\nname: plain-skill\ndescription: Plain.\n---\nBody").metadata, {});
  assert.deepEqual(parseFrontmatter("# no frontmatter\nmetadata:\n  visibility: search"), { metadata: {} });
  assert.equal(parseFrontmatter("---\r\nname: x\r\nmetadata:\r\n  visibility: search\r\n---\r\n").metadata.visibility, "search");
  assert.deepEqual(parseFrontmatter("---\nname: x\ntags:\n  visibility: search\n---\n").metadata, {}, "a nested key of another map is not metadata");
});

test("readVisibility reads the file once from disk and is undefined for a missing one", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillvis-"));
  try {
    const f = path.join(dir, "SKILL.md");
    fs.writeFileSync(f, "---\nname: example-domain-skill\nmetadata:\n  visibility: search\n---\n");
    assert.equal(readVisibility(f), "search");
    assert.equal(readVisibility(path.join(dir, "missing.md")), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("precedence: visible list, then hidden list, then frontmatter; anything but search is always on", () => {
  assert.equal(isHiddenSkill("example-domain-skill", none, undefined), false);
  assert.equal(isHiddenSkill("example-domain-skill", none, "search"), true);
  assert.equal(isHiddenSkill("example-domain-skill", none, "Search"), true);
  assert.equal(isHiddenSkill("example-domain-skill", none, "always"), false);
  assert.equal(isHiddenSkill("example-domain-skill", { visible: [], hidden: ["example-*"] }, undefined), true);
  // a non-empty visible list makes everything else searchable, and beats the hidden list and the frontmatter
  assert.equal(isHiddenSkill("other-skill", { visible: ["example-*"], hidden: [] }, undefined), true);
  assert.equal(isHiddenSkill("example-domain-skill", { visible: ["example-*"], hidden: ["example-*"] }, "search"), false);
});

test("splitSkills keeps order, reads the frontmatter only when the config does not decide, and is stable", () => {
  const skills = ["a-skill", "b-skill", "c-skill", "d-skill"].map((name) => ({ name, description: `${name} d`, filePath: `/s/${name}/SKILL.md` }));
  const read: string[] = [];
  const visibilityOf = (s: { name: string }) => (read.push(s.name), s.name === "c-skill" ? "search" : undefined);
  const first = splitSkills(skills, { visible: [], hidden: ["b-*"] }, visibilityOf);
  assert.deepEqual(first.hidden.map((s) => s.name), ["b-skill", "c-skill"]);
  assert.deepEqual(first.visible.map((s) => s.name), ["a-skill", "d-skill"]);
  assert.deepEqual(read, ["a-skill", "c-skill", "d-skill"], "b-skill was decided by the config");
  assert.deepEqual(splitSkills(skills, { visible: [], hidden: ["b-*"] }, visibilityOf), first, "the same input gives the same split");
  assert.deepEqual(splitSkills(skills, { visible: ["a-*"], hidden: [] }, () => assert.fail("config decides")).hidden.map((s) => s.name), ["b-skill", "c-skill", "d-skill"]);
});

test("the hint section names only, in the planned wording", () => {
  assert.equal(SKILLS_SECTION, "pi-foreman-skills");
  assert.equal(skillsHint([{ name: "example-domain-skill" }, { name: "other-skill" }]), "Searchable skills, find one with `tool_search <words>` and read its file: example-domain-skill, other-skill");
});

test("skillRulesOf reads the config lists and ignores junk", () => {
  assert.deepEqual(skillRulesOf({ skills: { visible: ["a"], hidden: ["b", 3] } }), { visible: ["a"], hidden: ["b"] });
  assert.deepEqual(skillRulesOf({}), none);
  assert.deepEqual(skillRulesOf({ skills: "x" }), none);
});

test("the shared fixture (also asserted by the Python skill_is_hidden) gives the same hidden list", () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "..", "..", "tests", "fixtures", "skill-visibility-cases.json"), "utf8")) as { cases: { name: string; rules: { visible: string[]; hidden: string[] }; skillMd: string; hidden: boolean }[]; expectedHidden: string[] };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillvis-fixture-"));
  try {
    const hidden: string[] = [];
    for (const c of fixture.cases) {
      const file = path.join(dir, `${c.name}.md`);
      fs.writeFileSync(file, c.skillMd);
      const got = splitSkills([{ name: c.name, description: "d", filePath: file }], c.rules).hidden.length === 1;
      assert.equal(got, c.hidden, c.name);
      if (got) hidden.push(c.name);
    }
    assert.deepEqual(hidden, fixture.expectedHidden);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("childSkillRefs resolves the role's skill names to name, description and file", async () => {
  const resolve = (names: string[]) => ({ resolved: names.filter((n) => n !== "gone-skill").map((n) => ({ name: n, description: `${n} d`, path: `/s/${n}/SKILL.md` })) });
  const roles = { builder: { skills: ["example-domain-skill", "gone-skill"] } };
  assert.deepEqual(await childSkillRefs(roles, "builder", "/w", resolve), [{ name: "example-domain-skill", description: "example-domain-skill d", filePath: "/s/example-domain-skill/SKILL.md" }]);
  assert.deepEqual(await childSkillRefs(roles, "reviewer", "/w", resolve), []);
  assert.deepEqual(await childSkillRefs(roles, "builder", "/w", () => { throw new Error("boom"); }), []);
});
