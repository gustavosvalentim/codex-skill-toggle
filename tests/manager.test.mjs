import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, symlink, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parse } from "yaml";

async function fixture(t, configure) {
  const root = await mkdtemp(join(tmpdir(), "skill-toggle-manager-test-"));
  const skills = join(root, "skills"); await mkdir(skills);
  const config = join(root, "config.json");
  await writeFile(config, JSON.stringify(configure ? await configure(root, skills) : { roots: [{ path: skills, writable: true }], projects: [] }));
  const client = new Client({ name: "manager-test", version: "1" }, {});
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../dist/server.js", import.meta.url)), "--config", config], stderr: "pipe" }));
  t.after(async () => { await client.close(); await rm(root, { recursive: true, force: true }); });
  async function skill(folder, yaml, name = folder) {
    const dir = join(skills, folder); await mkdir(dir);
    await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Fixture for ${folder}.\n---\nFixture.\n`);
    if (yaml !== undefined) { await mkdir(join(dir, "agents")); await writeFile(join(dir, "agents/openai.yaml"), yaml, { mode: 0o640 }); }
    return dir;
  }
  async function list() { const result = await client.callTool({ name: "list_skills", arguments: {} }); assert.ok(!result.isError); return result.structuredContent; }
  async function set(s, allowed) { return client.callTool({ name: "set_implicit_invocation", arguments: { skillId: s.id, allowed, expectedRevision: s.revision } }); }
  return { root, skills, client, skill, list, set };
}

test("creates a missing policy and restores automatic invocation", async (t) => {
  const f = await fixture(t); const dir = await f.skill("fresh");
  const [skill] = (await f.list()).skills;
  assert.equal(skill.policyState, "default"); assert.equal(skill.allowImplicitInvocation, true);
  const saved = await f.set(skill, false); assert.ok(!saved.isError);
  assert.equal(saved.structuredContent.skill.allowImplicitInvocation, false);
  assert.match(saved.structuredContent.refreshGuidance, /on disk/);
  const restored = await f.set(saved.structuredContent.skill, true); assert.ok(!restored.isError);
  assert.equal(parse(await readFile(join(dir, "agents/openai.yaml"), "utf8")).policy.allow_implicit_invocation, true);
});

test("preserves YAML fields, comments and permissions; rejects stale revisions", async (t) => {
  const f = await fixture(t);
  const dir = await f.skill("preserve", '# keep this\ninterface:\n  display_name: "Fixture" # keep this too\npolicy:\n  allow_implicit_invocation: true\n  products: [CODEX]\n');
  const [skill] = (await f.list()).skills;
  const saved = await f.set(skill, false); assert.ok(!saved.isError);
  const path = join(dir, "agents/openai.yaml"); const text = await readFile(path, "utf8");
  assert.match(text, /# keep this/); assert.match(text, /# keep this too/);
  assert.equal(parse(text).interface.display_name, "Fixture"); assert.deepEqual(parse(text).policy.products, ["CODEX"]);
  assert.equal((await stat(path)).mode & 0o777, 0o640);
  const stale = await f.set(skill, true); assert.equal(stale.isError, true); assert.match(stale.content[0].text, /CONFLICT/);
  await writeFile(path, text + '# external edit\n');
  const external = await f.set(saved.structuredContent.skill, true); assert.equal(external.isError, true); assert.match(external.content[0].text, /CONFLICT/);
});

test("malformed YAML, aliases and non-booleans are read-only", async (t) => {
  const f = await fixture(t);
  await f.skill("bad", 'policy:\n  allow_implicit_invocation: "false"\n');
  await f.skill("duplicate", 'policy: {}\npolicy: {}\n');
  await f.skill("alias", 'base: &base {allow_implicit_invocation: true}\npolicy: *base\n');
  const data = await f.list(); assert.equal(data.skills.length, 3);
  for (const skill of data.skills) {
    assert.equal(skill.editable, false); assert.equal(skill.allowImplicitInvocation, null);
    assert.equal((await f.set(skill, false)).isError, true);
  }
});

test("duplicate names have separate IDs; symlink escapes and bundled skills cannot be edited", async (t) => {
  const f = await fixture(t);
  await f.skill("one", undefined, "same"); await f.skill("two", undefined, "same");
  const outside = join(f.root, "outside"); await mkdir(outside);
  await writeFile(join(outside, "SKILL.md"), '---\nname: outside\ndescription: Outside root.\n---\n');
  await symlink(outside, join(f.skills, "linked"));
  const bundled = join(f.skills, ".system"); await mkdir(bundled);
  await mkdir(join(bundled, "test")); await writeFile(join(bundled, "test/SKILL.md"), '---\nname: bundled\ndescription: Bundled fixture.\n---\n');
  const data = await f.list(); const same = data.skills.filter((s) => s.name === "same");
  assert.equal(same.length, 2); assert.notEqual(same[0].id, same[1].id);
  assert.ok(same.every((s) => s.scope === "personal"));
  assert.equal(data.skills.find((s) => s.name === "bundled").scope, "system");
  assert.equal(data.skills.find((s) => s.name === "outside").scope, "personal");
  for (const name of ["outside", "bundled"]) { const s = data.skills.find((s) => s.name === name); assert.equal(s.editable, false); assert.equal((await f.set(s, false)).isError, true); }
  assert.equal((await f.client.callTool({ name: "set_implicit_invocation", arguments: { skillId: "unknown", allowed: false, expectedRevision: "missing" } })).isError, true);
});

test("a symlinked policy file and a symlinked agents directory are never replaced", async (t) => {
  const f = await fixture(t); const dir = await f.skill("link"); const other = join(f.root, "other.yaml");
  await writeFile(other, 'policy:\n  allow_implicit_invocation: true\n');
  await mkdir(join(dir, "agents")); await symlink(other, join(dir, "agents/openai.yaml"));
  const [s] = (await f.list()).skills; assert.equal(s.editable, false); assert.equal((await f.set(s, false)).isError, true);
  assert.equal(parse(await readFile(other, "utf8")).policy.allow_implicit_invocation, true);
  const second = await f.skill("directory-link");
  const outsideAgents = join(f.root, "outside-agents"); await mkdir(outsideAgents);
  await writeFile(join(outsideAgents, "openai.yaml"), 'policy:\n  allow_implicit_invocation: true\n');
  await symlink(outsideAgents, join(second, "agents"));
  const linked = (await f.list()).skills.find((s) => s.name === "directory-link");
  assert.equal(linked.editable, false); assert.equal((await f.set(linked, false)).isError, true);
});


test("project discovery stops at the repo root and reports unavailable projects without losing other skills", async (t) => {
  const f = await fixture(t, async (root, skills) => {
    await mkdir(join(root, ".git"));
    const cwd = join(root, "service"); await mkdir(cwd);
    const dir = join(root, ".agents/skills/project-fixture"); await mkdir(dir, { recursive: true });
    const manifest = join(dir, "SKILL.md");
    await writeFile(manifest, '---\nname: project-fixture\ndescription: Project fixture.\n---\n');
    await mkdir(join(cwd, ".codex"));
    await writeFile(join(cwd, ".codex/config.toml"), `[[skills.config]]\npath = ${JSON.stringify(manifest)}\nenabled = false\n`);
    return { roots: [{ path: skills, writable: true }], projects: [{ id: "project", name: "Fixture project", cwd }, { id: "missing", name: "Missing project", cwd: join(root, "absent") }] };
  });
  await f.skill("personal-fixture");
  const global = await f.list();
  assert.equal(global.skills.length, 1); assert.equal(global.errors.length, 0);
  const selected = await f.client.callTool({ name: "list_skills", arguments: { projectId: "project" } });
  const all = selected.structuredContent;
  assert.equal(all.skills.length, 2); assert.equal(all.errors.length, 0);
  const missing = await f.client.callTool({ name: "list_skills", arguments: { projectId: "missing" } });
  assert.equal(missing.structuredContent.skills.length, 1); assert.equal(missing.structuredContent.errors.length, 1);
  assert.equal(all.skills.find((s) => s.name === "personal-fixture").scope, "personal");
  const project = all.skills.find((s) => s.name === "project-fixture");
  assert.equal(project.scope, "project"); assert.equal(project.projectId, "project"); assert.equal(project.enabled, false);
  const unknown = await f.client.callTool({ name: "list_skills", arguments: { projectId: "unknown" } });
  assert.equal(unknown.isError, true); assert.match(unknown.content[0].text, /UNKNOWN_PROJECT/);
});
