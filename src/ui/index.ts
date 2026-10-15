import { App } from "@modelcontextprotocol/ext-apps";
import { APP_NAME, APP_VERSION, LIST_TOOL, SET_TOOL, ListOutput, SetOutput, type Skill, type SkillList } from "../shared.js";

const app = new App({ name: APP_NAME, version: APP_VERSION }, {});
const status = document.querySelector<HTMLElement>("#status")!;
const list = document.querySelector<HTMLElement>("#skills")!;
const search = document.querySelector<HTMLInputElement>("#search")!;
const scope = document.querySelector<HTMLSelectElement>("#scope")!;
const project = document.querySelector<HTMLSelectElement>("#project")!;
const refresh = document.querySelector<HTMLButtonElement>("#refresh")!;
const count = document.querySelector<HTMLElement>("#count")!;
const addProject = document.querySelector<HTMLButtonElement>("#add-project")!;
const projectForm = document.querySelector<HTMLFormElement>("#project-form")!;
const projectPath = document.querySelector<HTMLInputElement>("#project-path")!;
const projectContext = document.querySelector<HTMLElement>("#project-context")!;
let selection = "";
let data: SkillList = { skills: [], projects: [], errors: [] };
let connected = false;
let loading = false;
const saving = new Set<string>();

function message(text: string, error = false) { status.textContent = text; status.classList.toggle("error", error); }
function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; return el; }
function theme(context: { theme?: string }) { if (context.theme) document.documentElement.dataset.theme = context.theme; }
async function expand() {
  const context = app.getHostContext();
  if (context?.displayMode !== "fullscreen" && context?.availableDisplayModes?.includes("fullscreen")) {
    try { await app.requestDisplayMode({ mode: "fullscreen" }, { timeout: 10_000 }); } catch { /* Inline remains usable. */ }
  }
}

function accept(next: SkillList) {
  data = next;
  const current = data.projects.find((p) => p.id === data.context?.currentProjectId);
  project.replaceChildren(new Option(current ? `Current chat: ${current.name}` : "Personal and system", ""),
    ...(current ? [new Option("Personal and system", "__personal")] : []),
    ...data.projects.map((p) => new Option(p.cwd ? `${p.name} — ${p.cwd}` : p.name, p.id)));
  project.value = selection;
  if (project.selectedIndex < 0) { selection = ""; project.value = ""; }
  projectContext.textContent = data.context?.directory ? `Project: ${data.context.directory}` : "Select a project folder to include project skills.";
  render();
}

function render() {
  const query = search.value.toLocaleLowerCase();
  const skills = data.skills.filter((s) => (scope.value === "all" || s.scope === scope.value) && `${s.name} ${s.description} ${s.path}`.toLocaleLowerCase().includes(query));
  count.textContent = `${skills.length} of ${data.skills.length} skills`;
  list.replaceChildren();
  if (!skills.length) list.append(element("p", scope.value === "project" && !data.context?.selectedProjectId ? "Select a project folder to see project skills." : data.skills.length ? "No skills match these filters." : "No skills found in the configured roots."));
  for (const skill of skills) {
    const row = element("article"); row.className = "skill";
    const content = element("div"); content.className = "skill-content";
    const title = element("div"); title.className = "title";
    title.append(element("h2", skill.name), element("span", skill.scope));
    const description = element("p", skill.description); description.className = "description"; description.title = skill.description;
    content.append(title, description);
    const path = element("code", skill.path); path.className = "path"; path.title = skill.path; content.append(path);
    const warning = skill.reason ?? (skill.enabled === false ? "Disabled in Codex configuration" : skill.enabled === null ? "Codex enablement could not be determined" : null);
    if (warning) { const note = element("p", warning); note.className = "note"; content.append(note); }
    const control = element("input"); control.type = "checkbox"; control.role = "switch";
    control.setAttribute("aria-label", `Allow automatic invocation for ${skill.name}`);
    control.checked = skill.allowImplicitInvocation === true;
    control.disabled = !skill.editable || saving.has(skill.id) || loading;
    control.title = skill.reason ?? "Allow Codex to choose this skill automatically";
    control.addEventListener("change", () => { void save(skill, control.checked); });
    row.append(content, control); list.append(row);
  }
}

async function load() {
  if (!connected || loading || saving.size) return;
  loading = true; refresh.disabled = true; project.disabled = true; addProject.disabled = true; render();
  message("Reading skill settings…");
  try {
    const result = await app.callServerTool({ name: LIST_TOOL, arguments: selection === "__personal" ? { personalOnly: true } : selection ? { projectId: selection } : {} }, { timeout: 20_000 });
    if (result.isError) throw new Error(result.content.filter((c) => c.type === "text").map((c) => c.text).join(" "));
    accept(ListOutput.parse(result.structuredContent));
    message(data.errors.length ? `Some roots could not be read: ${data.errors.join("; ")}` : "Settings are read from disk. Changes are verified before reporting success.", data.errors.length > 0);
  } catch (error) { message(error instanceof Error ? error.message : "Could not load skills.", true); }
  finally { loading = false; refresh.disabled = false; project.disabled = false; addProject.disabled = false; render(); }
}

async function save(skill: Skill, allowed: boolean) {
  if (saving.has(skill.id)) return;
  saving.add(skill.id); refresh.disabled = true; project.disabled = true; addProject.disabled = true; render();
  message(`Saving ${skill.name}…`);
  try {
    const result = await app.callServerTool({ name: SET_TOOL, arguments: { skillId: skill.id, allowed, expectedRevision: skill.revision } }, { timeout: 20_000 });
    if (result.isError) throw new Error(result.content.filter((c) => c.type === "text").map((c) => c.text).join(" "));
    const saved = SetOutput.parse(result.structuredContent);
    data.skills = data.skills.map((s) => s.id === skill.id ? saved.skill : s);
    message(saved.refreshGuidance);
  } catch (error) { message(error instanceof Error ? error.message : "Save failed. Refresh and try again.", true); }
  finally { saving.delete(skill.id); refresh.disabled = saving.size > 0; project.disabled = saving.size > 0; addProject.disabled = saving.size > 0; render(); }
}

search.addEventListener("input", render);
scope.addEventListener("change", render);
project.addEventListener("change", () => { selection = project.value; void load(); });
addProject.addEventListener("click", () => { projectForm.hidden = false; projectPath.focus(); });
document.querySelector("#cancel-project")!.addEventListener("click", () => { projectForm.hidden = true; });
projectForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!connected || loading || saving.size) return;
  void (async () => {
    loading = true; refresh.disabled = true; project.disabled = true; addProject.disabled = true;
    for (const button of projectForm.querySelectorAll("button")) button.disabled = true;
    render(); message("Opening project folder…");
    try {
      const result = await app.callServerTool({ name: "add_project", arguments: { path: projectPath.value.trim() } }, { timeout: 20_000 });
      if (result.isError) throw new Error(result.content.filter((c) => c.type === "text").map((c) => c.text).join(" "));
      const next = ListOutput.parse(result.structuredContent);
      selection = next.context?.selectedProjectId ?? ""; accept(next);
      projectForm.hidden = true; projectPath.value = "";
      message(next.errors.length ? next.errors.join("; ") : "Project folder selected.", next.errors.length > 0);
    } catch (error) { message(error instanceof Error ? error.message : "Could not open project folder.", true); }
    finally {
      loading = false; refresh.disabled = false; project.disabled = false; addProject.disabled = false;
      for (const button of projectForm.querySelectorAll("button")) button.disabled = false;
      render();
    }
  })();
});
refresh.addEventListener("click", () => { void load(); });
app.onhostcontextchanged = theme;
app.ontoolresult = (result) => {
  const parsed = ListOutput.safeParse(result.structuredContent);
  if (parsed.success && !saving.size && !loading) accept(parsed.data);
  // Reopen a retained inline instance when the launch tool is called again.
  if (connected) void expand();
};
try {
  await app.connect(undefined, { timeout: 15_000 }); connected = true;
  const context = app.getHostContext(); if (context) theme(context);
  await expand(); await load();
} catch (error) { message(error instanceof Error ? error.message : "Desktop bridge unavailable.", true); }
