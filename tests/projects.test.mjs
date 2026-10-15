import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "skill-toggle-project-context-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dirs = {};
  for (const name of ["a", "b"]) {
    const cwd = join(root, name); dirs[name] = cwd;
    await mkdir(join(cwd, ".git"), { recursive: true });
    const skill = join(cwd, ".agents/skills", `project-${name}`);
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, "SKILL.md"), `---\nname: project-${name}\ndescription: Project ${name} fixture.\n---\nFixture.\n`);
  }
  const empty = join(root, "projectless"); await mkdir(empty);
  const binary = join(root, "codex-probe.mjs");
  await writeFile(binary, `#!/usr/bin/env node
import { createInterface } from 'node:readline';
const chats = ${JSON.stringify({ "chat-a": { cwd: dirs.a, ephemeral: false }, "chat-b": { cwd: dirs.b, ephemeral: false }, "ephemeral": { cwd: dirs.a, ephemeral: true }, "internal": { cwd: dirs.a, source: "mcp_extension_host" }, "projectless": { cwd: empty } })};
createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line);
 if(m.id===1) console.log(JSON.stringify({id:1,result:{}}));
 if(m.method==='thread/read') {
  if(m.params.includeTurns !== false) process.exit(1);
  console.log(JSON.stringify(chats[m.params.threadId] ? {id:m.id,result:{thread:chats[m.params.threadId]}} : {id:m.id,error:{code:-32000,message:'Thread unavailable'}}));
 }
});
`, { mode: 0o755 });
  async function connect() {
    const client = new Client({ name: "project-context-test", version: "1" }, {});
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../dist/server.js", import.meta.url))], env: { ...process.env, HOME: root, CODEX_HOME: join(root, "state"), SKILL_TOGGLE_CODEX_BIN: binary }, stderr: "pipe" }));
    t.after(() => client.close()); return client;
  }
  const call = (client, threadId, arguments_ = {}) => client.callTool({ name: "list_skills", arguments: arguments_, ...(threadId ? { _meta: { threadId } } : {}) });
  return { root, dirs, connect, call };
}

test("conversation projects are isolated; global, internal, missing and projectless chats stay unselected", async (t) => {
  const f = await fixture(t); const client = await f.connect();
  const a = await f.call(client, "chat-a");
  assert.equal(a.isError, undefined); assert.equal(a.structuredContent.context.directory, f.dirs.a);
  assert.deepEqual(a.structuredContent.skills.map(s => s.name), ["project-a"]);
  const b = await f.call(client, "chat-b");
  assert.equal(b.structuredContent.context.directory, f.dirs.b);
  assert.deepEqual(b.structuredContent.skills.map(s => s.name), ["project-b"]);
  for (const id of [undefined, "ephemeral", "internal", "missing", "projectless"]) {
    const result = await f.call(client, id);
    assert.equal(result.structuredContent.context.selectedProjectId, null);
    assert.deepEqual(result.structuredContent.skills, []);
  }
  const personal = await f.call(client, "chat-a", { personalOnly: true });
  assert.equal(personal.structuredContent.context.selectedProjectId, null);
  assert.deepEqual(personal.structuredContent.skills, []);
  const override = await f.call(client, "chat-a", { projectId: b.structuredContent.context.selectedProjectId });
  assert.equal(override.structuredContent.context.directory, f.dirs.b);
  const again = await f.call(client, "chat-a");
  assert.equal(again.structuredContent.context.directory, f.dirs.a);
  assert.equal((await f.call(client, "chat-a", { projectId: "unknown" })).isError, true);
});

test("explicit folder selection persists, but does not become the global default", async (t) => {
  const f = await fixture(t); const client = await f.connect();
  const added = await client.callTool({ name: "add_project", arguments: { path: f.dirs.a } });
  assert.equal(added.isError, undefined);
  assert.deepEqual(added.structuredContent.skills.map(s => s.name), ["project-a"]);
  const projectId = added.structuredContent.context.selectedProjectId;
  assert.equal(added.structuredContent.context.directory, f.dirs.a);
  const manifest = await readFile(join(f.dirs.a, ".agents/skills/project-a/SKILL.md"), "utf8");
  assert.ok(manifest.includes("project-a"));
  const policy = join(f.dirs.a, ".agents/skills/project-a/agents/openai.yaml");
  await assert.rejects(readFile(policy), { code: "ENOENT" });
  await client.close();
  const restarted = await f.connect();
  const global = await f.call(restarted);
  assert.equal(global.structuredContent.context.selectedProjectId, null);
  assert.deepEqual(global.structuredContent.skills, []);
  assert.ok(global.structuredContent.projects.some(p => p.id === projectId));
  const selected = await f.call(restarted, undefined, { projectId });
  assert.deepEqual(selected.structuredContent.skills.map(s => s.name), ["project-a"]);
  const toggled = await restarted.callTool({ name: "set_implicit_invocation", arguments: { skillId: selected.structuredContent.skills[0].id, allowed: false, expectedRevision: selected.structuredContent.skills[0].revision } });
  assert.equal(toggled.isError, undefined);
  assert.equal(toggled.structuredContent.skill.scope, "project");
  assert.match(await readFile(policy, "utf8"), /allow_implicit_invocation: false/);
  for (const path of ["relative/path", join(f.root, "absent"), policy]) {
    const bad = await restarted.callTool({ name: "add_project", arguments: { path } });
    assert.equal(bad.isError, true);
  }
});
