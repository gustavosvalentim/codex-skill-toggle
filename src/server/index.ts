import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { APP_NAME, APP_VERSION, CHECK_TOOL, ConnectionInput, ConnectionOutput, AddProjectInput, OPEN_TOOL, UI_URI, LIST_TOOL, SET_TOOL, ListInput, ListOutput, SetInput, SetOutput, REFRESH_GUIDANCE } from "../shared.js";
import { Projects, projectStore } from "./projects.js";
import { loadConfig, SkillError, SkillManager } from "./skills.js";

const configIndex = process.argv.indexOf("--config");
if (configIndex >= 0 && !process.argv[configIndex + 1]) throw new Error("--config requires an absolute configuration path.");
const config = await loadConfig(configIndex >= 0 ? process.argv[configIndex + 1] : undefined);
const projects = new Projects(config, configIndex >= 0 ? null : projectStore());
await projects.init();
const manager = new SkillManager(config);
async function listSkills(input: { projectId?: string; personalOnly?: boolean }, threadId: unknown) {
  await projects.init();
  const current = await projects.current(threadId);
  const selectedId = input.personalOnly ? null : input.projectId ?? current?.id ?? null;
  const data = await manager.list(selectedId);
  data.errors.push(...projects.errors);
  const selected = config.projects.find((p) => p.id === selectedId);
  return { ...data, context: { currentProjectId: current?.id ?? null, selectedProjectId: selectedId, directory: selected?.cwd ?? null } };
}
const icons = [{ src: `data:image/svg+xml;base64,${(await readFile(new URL("./icon.svg", import.meta.url))).toString("base64")}`, mimeType: "image/svg+xml", sizes: ["128x128"] }];
const server = new McpServer(
  { name: "codex-skill-toggle", title: APP_NAME, version: APP_VERSION, icons },
  { instructions: "Open Skill Toggle to inspect local skills. Only change invocation policy when the user requests it. Saves are verified on disk; do not claim an existing chat has refreshed." },
);
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

registerAppResource(server, APP_NAME, UI_URI, {}, async () => ({
  contents: [{ uri: UI_URI, mimeType: RESOURCE_MIME_TYPE, text: await readFile(new URL("./panel.html", import.meta.url), "utf8"), _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } } }],
}));

function errorResult(error: unknown) {
  const code = error instanceof SkillError ? error.code : "IO_ERROR";
  return { isError: true, content: [{ type: "text" as const, text: `${code}: ${error instanceof Error ? error.message : "Operation failed."}` }] };
}

registerAppTool(server, OPEN_TOOL, {
  title: APP_NAME, description: "Open the embedded skill manager. Listing does not modify skills.",
  inputSchema: ListInput.shape, outputSchema: ListOutput.shape, annotations: readOnly,
  _meta: { ui: { resourceUri: UI_URI }, "openai/outputTemplate": UI_URI, "openai/ui": { entrypoints: [{ type: "global" }, { type: "thread" }] } },
}, async (input, extra) => {
  try { return { content: [{ type: "text" as const, text: "Skill list returned; the desktop host presents the manager." }], structuredContent: await listSkills(input, extra._meta?.threadId), _meta: { ui: { resourceUri: UI_URI }, "openai/outputTemplate": UI_URI } }; }
  catch (error) { return errorResult(error); }
});

server.registerTool(LIST_TOOL, {
  title: "List skills", description: "List skills in configured personal and project roots, with invocation policy and editability.",
  inputSchema: ListInput.shape, outputSchema: ListOutput.shape, annotations: readOnly,
  _meta: { ui: { visibility: ["model", "app"] } },
}, async (input, extra) => {
  try { const data = await listSkills(input, extra._meta?.threadId); return { content: [{ type: "text" as const, text: `Found ${data.skills.length} skills.` }], structuredContent: data }; }
  catch (error) { return errorResult(error); }
});

server.registerTool("add_project", {
  title: "Add project folder", description: "Remember an explicitly selected local project folder for the manager.",
  inputSchema: AddProjectInput.shape, outputSchema: ListOutput.shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  _meta: { ui: { visibility: ["app"] } },
}, async ({ path }, extra) => {
  try {
    const project = await projects.add(path);
    return { content: [{ type: "text" as const, text: "Project folder selected." }], structuredContent: await listSkills({ projectId: project.id }, extra._meta?.threadId) };
  } catch (error) { return errorResult(error); }
});

server.registerTool(SET_TOOL, {
  title: "Set automatic invocation", description: "Persist a requested skill invocation policy, preserving other YAML fields and rejecting stale revisions.",
  inputSchema: SetInput.shape, outputSchema: SetOutput.shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  _meta: { ui: { visibility: ["model", "app"] } },
}, async ({ skillId, allowed, expectedRevision }) => {
  try { return { content: [{ type: "text" as const, text: REFRESH_GUIDANCE }], structuredContent: { skill: await manager.set(skillId, allowed, expectedRevision), refreshGuidance: REFRESH_GUIDANCE } }; }
  catch (error) { return errorResult(error); }
});

server.registerTool(CHECK_TOOL, {
  title: "Check local connection", description: "Return a nonce and timestamp to verify the embedded panel can call this local server.",
  inputSchema: ConnectionInput.shape, outputSchema: ConnectionOutput.shape,
  annotations: { ...readOnly, idempotentHint: false }, _meta: { ui: { visibility: ["app"] } },
}, async ({ nonce }) => ({ content: [{ type: "text", text: "Local connection verified." }], structuredContent: { nonce, server: "codex-skill-toggle", version: APP_VERSION, checkedAt: new Date().toISOString() } }));

await server.connect(new StdioServerTransport());
