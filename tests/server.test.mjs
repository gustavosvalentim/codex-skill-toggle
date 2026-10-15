import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverPath = fileURLToPath(new URL("../dist/server.js", import.meta.url));

test("STDIO server exposes an embedded resource and answers validated connection checks", async (t) => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (data) => { stderr += data; });
  const client = new Client({ name: "skill-toggle-test", version: "0.1.0" }, {});
  t.after(() => client.close());
  await client.connect(transport);

  const { tools } = await client.listTools();
  const launch = tools.find((tool) => tool.name === "open_skill_toggle");
  assert.ok(launch);
  assert.deepEqual(launch._meta["openai/ui"].entrypoints, [{ type: "global" }, { type: "thread" }]);
  assert.equal(launch._meta.ui.resourceUri, "ui://skill-toggle/manager-v5.html");
  assert.equal(launch.annotations.readOnlyHint, true);
  assert.deepEqual(tools.find((tool) => tool.name === "check_connection")._meta.ui.visibility, ["app"]);

  const resource = await client.readResource({ uri: launch._meta.ui.resourceUri });
  const html = resource.contents[0];
  assert.equal(html.mimeType, "text/html;profile=mcp-app");
  assert.match(html.text, /Search skills/);
  assert.doesNotMatch(html.text, /APP_SCRIPT/);
  assert.doesNotMatch(html.text, /<script[^>]+src=/);
  assert.deepEqual(html._meta.ui.csp.connectDomains, []);

  const opened = await client.callTool({ name: launch.name, arguments: {} });
  assert.ok(Array.isArray(opened.structuredContent.skills));
  assert.equal(opened._meta.ui.resourceUri, launch._meta.ui.resourceUri);
  assert.equal(opened._meta["openai/outputTemplate"], launch._meta.ui.resourceUri);
  assert.doesNotMatch(opened.content[0].text, /is open/);
  const nonce = crypto.randomUUID();
  const checked = await client.callTool({ name: "check_connection", arguments: { nonce } });
  assert.equal(checked.structuredContent.nonce, nonce);
  assert.equal(checked.structuredContent.server, "codex-skill-toggle");
  assert.ok(Number.isFinite(Date.parse(checked.structuredContent.checkedAt)));

  const invalid = await client.callTool({ name: "check_connection", arguments: { nonce: "" } });
  assert.equal(invalid.isError, true);
  assert.equal(stderr, "");
});
