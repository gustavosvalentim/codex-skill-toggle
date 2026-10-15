import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { App } from "@modelcontextprotocol/ext-apps";
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// This verifies the SDK bridge path, not the installed desktop host or DOM rendering.
test("MCP App bridge forwards a UI request to the real local STDIO server", async (t) => {
  const client = new Client({ name: "test-host", version: "0.1.0" }, {});
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../dist/server.js", import.meta.url))],
    stderr: "pipe",
  }));
  const bridge = new AppBridge(client, { name: "test-host", version: "0.1.0" }, { serverTools: {}, serverResources: {} });
  const app = new App({ name: "test-panel", version: "0.1.0" }, {}, { autoResize: false });
  const [appTransport, hostTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await app.close(); await bridge.close(); await client.close(); });
  await bridge.connect(hostTransport);
  await app.connect(appTransport);
  const nonce = crypto.randomUUID();
  const response = await app.callServerTool({ name: "check_connection", arguments: { nonce } });
  assert.equal(response.isError, undefined);
  assert.equal(response.structuredContent.nonce, nonce);
  assert.equal(response.structuredContent.server, "codex-skill-toggle");
});
