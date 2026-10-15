import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { ManagerConfig } from "./skills.js";

type Project = ManagerConfig["projects"][number];
export type ThreadMetadata = { cwd?: string; ephemeral?: boolean; source?: unknown };

// This connection only reads metadata. It never resumes a chat or starts a model turn.
export async function readThreadMetadata(threadId: string): Promise<ThreadMetadata | null> {
  if (!/^[\w-]{1,200}$/.test(threadId)) return null;
  const bundled = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";
  const binary = process.env.SKILL_TOGGLE_CODEX_BIN ?? (await access(bundled).then(() => bundled).catch(() => "codex"));
  return new Promise((resolve) => {
    const child = spawn(binary, ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "ignore"] });
    let buffer = "", settled = false;
    const finish = (value: ThreadMetadata | null) => {
      if (settled) return;
      settled = true; clearTimeout(timer); child.kill(); resolve(value);
    };
    const timer = setTimeout(() => finish(null), 6000);
    child.on("error", () => finish(null)); child.on("exit", () => finish(null));
    child.stdin.on("error", () => finish(null));
    const send = (value: unknown) => child.stdin.write(JSON.stringify(value) + "\n");
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 2_000_000) { finish(null); return; }
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let response;
        try { response = JSON.parse(line); } catch { finish(null); return; }
        if (response.id === 1) {
          if (response.error) { finish(null); return; }
          send({ method: "initialized" });
          send({ id: 2, method: "thread/read", params: { threadId, includeTurns: false } });
        } else if (response.id === 2) {
          const thread = response.result?.thread;
          finish(thread && typeof thread.cwd === "string" && isAbsolute(thread.cwd) ? { cwd: thread.cwd, ephemeral: thread.ephemeral === true, source: thread.source } : null);
        }
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "skill-toggle-project-context", version: "1" }, capabilities: null } });
  });
}

export class Projects {
  readonly errors: string[] = [];
  private remembered: Project[] = [];
  private detected = new Map<string, Promise<Project | null>>();
  private saving: Promise<void> = Promise.resolve();
  constructor(private config: ManagerConfig, private store: string | null, private lookup = readThreadMetadata) {}

  async init() {
    if (!this.store) return;
    this.errors.length = 0;
    try {
      const data = JSON.parse(await readFile(this.store, "utf8"));
      if (!Array.isArray(data) || !data.every((p) => typeof p?.cwd === "string" && isAbsolute(p.cwd) && typeof p.id === "string" && typeof p.name === "string")) throw new Error("Invalid project list");
      this.remembered = data;
      for (const project of data) this.register(project);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.errors.push("Saved project folders could not be read. Add a folder to replace the saved list."); }
  }

  private register(project: Project) {
    const existing = this.config.projects.find((p) => p.cwd === project.cwd);
    if (existing) return existing;
    this.config.projects.push(project); return project;
  }

  private async project(path: string): Promise<Project> {
    if (!isAbsolute(path)) throw new Error("Enter an absolute project folder path.");
    const cwd = await realpath(path);
    if (!(await stat(cwd)).isDirectory()) throw new Error("Choose a project folder, not a file.");
    return { id: createHash("sha256").update(cwd).digest("hex"), name: basename(cwd) || cwd, cwd };
  }

  async add(path: string) {
    const project = await this.project(path);
    const run = this.saving.then(async () => {
      await this.init();
      const next = [...this.remembered.filter((p) => p.cwd !== project.cwd), project];
      if (this.store) {
        await mkdir(dirname(this.store), { recursive: true });
        const temporary = `${this.store}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
          await rename(temporary, this.store);
        } finally { await unlink(temporary).catch(() => {}); }
      }
      this.remembered = next; this.errors.length = 0;
    });
    this.saving = run.catch(() => {}); await run;
    return this.register(project);
  }

  async current(threadId: unknown): Promise<Project | null> {
    if (typeof threadId !== "string") return null;
    const previous = this.detected.get(threadId);
    if (previous) return previous;
    const pending = this.detect(threadId).catch(() => null);
    this.detected.set(threadId, pending);
    // Coalesce concurrent calls only. A refresh must observe worktree/directory changes.
    try { return await pending; }
    finally { if (this.detected.get(threadId) === pending) this.detected.delete(threadId); }
  }

  private async detect(threadId: string) {
    const metadata = await this.lookup(threadId);
    if (!metadata?.cwd || metadata.ephemeral || metadata.source === "mcp_extension_host") return null;
    const project = await this.project(metadata.cwd);
    // Projectless chats have a directory too. Require a repository or project skill folder.
    let directory = project.cwd;
    while (true) {
      if (await stat(join(directory, ".git")).then(() => true).catch(() => false)) return this.register(project);
      const parent = dirname(directory);
      if (parent === directory || directory === homedir()) break;
      directory = parent;
    }
    if (await stat(join(project.cwd, ".agents/skills")).then((s) => s.isDirectory()).catch(() => false)) return this.register(project);
    return null;
  }
}

export function projectStore() { return join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "skill-toggle", "projects.json"); }
