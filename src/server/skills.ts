import { createHash, randomUUID } from "node:crypto";
import { access, chmod, lstat, mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isMap, parseDocument } from "yaml";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import type { Skill, SkillList } from "../shared.js";

const Project = z.object({ id: z.string().min(1), name: z.string().min(1), cwd: z.string() });
const Config = z.object({
  roots: z.array(z.object({ path: z.string(), writable: z.boolean().default(true) })).optional(),
  projects: z.array(Project).default([]),
});
export type ManagerConfig = z.infer<typeof Config>;
export class SkillError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const inside = (parent: string, path: string) => { const rel = relative(parent, path); return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel)); };
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

export async function loadConfig(path?: string): Promise<ManagerConfig> {
  const config = Config.parse(path ? JSON.parse(await readFile(path, "utf8")) : {});
  const home = homedir();
  config.roots ??= [{ path: join(home, ".agents/skills"), writable: true }, { path: join(home, ".codex/skills"), writable: true }];
  const ids = new Set<string>();
  for (const project of config.projects) {
    if (ids.has(project.id)) throw new Error(`Duplicate project ID: ${project.id}`);
    ids.add(project.id);
  }
  for (const path of [...config.roots.map((r) => r.path), ...config.projects.map((p) => p.cwd)]) {
    if (!isAbsolute(path)) throw new Error(`Configuration paths must be absolute: ${path}`);
  }
  return config;
}

type Root = { path: string; writable: boolean; scope: "personal" | "project"; projectId: string | null; cwd?: string };
type Record = { directory: string; root: Root };
type Policy = { text: string | null; revision: string; allowed: boolean | null; state: Skill["policyState"]; error: string | null; mode: number };

async function policyAt(directory: string): Promise<Policy> {
  const file = join(directory, "agents/openai.yaml");
  let text: string;
  let mode = 0o600;
  try { text = await readFile(file, "utf8"); mode = (await stat(file)).mode & 0o777; }
  catch (error) { if (isMissing(error)) return { text: null, revision: "missing", allowed: true, state: "default", error: null, mode }; throw error; }
  const revision = hash(text);
  const doc = parseDocument(text, { uniqueKeys: true });
  const invalid = (message: string): Policy => ({ text, revision, allowed: null, state: "invalid", error: message, mode });
  if (doc.errors.length) return invalid(doc.errors[0].message);
  if (doc.contents !== null && !isMap(doc.contents)) return invalid("Policy file must contain a YAML mapping.");
  const policy = doc.get("policy", true);
  if (policy !== undefined && !isMap(policy)) return invalid("policy must be a YAML mapping.");
  const value = doc.getIn(["policy", "allow_implicit_invocation"]);
  if (value !== undefined && typeof value !== "boolean") return invalid("allow_implicit_invocation must be true or false.");
  return { text, revision, allowed: value === undefined ? true : value as boolean, state: value === undefined ? "default" : "configured", error: null, mode };
}

async function safePolicyPath(directory: string) {
  const agents = join(directory, "agents");
  try { if ((await lstat(agents)).isSymbolicLink()) throw new SkillError("UNSAFE_PATH", "The agents directory is a symlink; editing is disabled."); }
  catch (error) { if (!isMissing(error)) throw error; }
  const file = join(agents, "openai.yaml");
  try { if ((await lstat(file)).isSymbolicLink()) throw new SkillError("UNSAFE_PATH", "The policy file is a symlink; editing is disabled."); }
  catch (error) { if (!isMissing(error)) throw error; }
  return file;
}

async function enabledAt(manifest: string, cwd?: string): Promise<boolean | null> {
  let enabled = true;
  const files = [join(homedir(), ".codex/config.toml"), ...(cwd ? [join(cwd, ".codex/config.toml")] : [])];
  for (const file of files) {
    try {
      const config = parseToml(await readFile(file, "utf8")) as { skills?: { config?: Array<{ path?: string; enabled?: boolean }> } };
      for (const rule of config.skills?.config ?? []) {
        if (typeof rule.path !== "string" || typeof rule.enabled !== "boolean") continue;
        // Codex paths are normally absolute. Resolve project-relative entries from the project.
        const rulePath = isAbsolute(rule.path) ? rule.path : resolve(cwd ?? homedir(), rule.path);
        if (await realpath(rulePath).catch(() => rulePath) === manifest) enabled = rule.enabled;
      }
    } catch (error) { if (!isMissing(error)) return null; }
  }
  return enabled;
}

export class SkillManager {
  private registry = new Map<string, Record>();
  private pending = new Map<string, Promise<unknown>>();
  constructor(private config: ManagerConfig) {}

  private async roots(projectId?: string, errors: string[] = []): Promise<Root[]> {
    const roots: Root[] = (this.config.roots ?? []).map((r) => ({ ...r, scope: "personal", projectId: null }));
    if (projectId && !this.config.projects.some((p) => p.id === projectId)) throw new SkillError("UNKNOWN_PROJECT", "Unknown configured project.");
    for (const project of this.config.projects.filter((p) => !projectId || p.id === projectId)) {
      let cwd: string;
      try { cwd = await realpath(project.cwd); }
      catch (error) { errors.push(`${project.cwd}: ${(error as Error).message}`); continue; }
      // Stop at the nearest repository marker; without a repository, scan only cwd.
      const directories = [cwd];
      let current = cwd;
      let foundRepository = false;
      while (true) {
        if (await stat(join(current, ".git")).then(() => true).catch(() => false)) { foundRepository = true; break; }
        const parent = dirname(current);
        if (parent === current) break;
        directories.push(parent); current = parent;
      }
      for (const directory of foundRepository ? directories : [cwd]) roots.push({ path: join(directory, ".agents/skills"), writable: true, scope: "project", projectId: project.id, cwd });
    }
    return roots;
  }

  async list(projectId?: string): Promise<SkillList> {
    const records = new Map<string, Record>();
    const errors: string[] = [];
    for (const root of await this.roots(projectId, errors)) {
      let canonicalRoot: string;
      try { canonicalRoot = await realpath(root.path); }
      catch (error) { if (!isMissing(error)) errors.push(`${root.path}: ${(error as Error).message}`); continue; }
      const visited = new Set<string>();
      const walk = async (path: string, depth: number): Promise<void> => {
        if (depth > 8) return;
        try {
          const canonical = await realpath(path);
          if (visited.has(canonical)) return;
          visited.add(canonical);
          const manifest = join(canonical, "SKILL.md");
          if (await stat(manifest).then((s) => s.isFile()).catch(() => false)) {
            const restricted = !inside(canonicalRoot, canonical) || canonical.split(sep).includes(".system") || canonical.split(sep).includes("plugins");
            const previous = records.get(canonical);
            const record = { directory: canonical, root: { ...root, path: canonicalRoot, writable: root.writable && !restricted } };
            if (!previous || (!previous.root.writable && record.root.writable)) records.set(canonical, record);
            return;
          }
          for (const entry of await readdir(canonical, { withFileTypes: true })) {
            if (entry.name === ".git" || entry.name === "node_modules") continue;
            if (entry.isDirectory() || entry.isSymbolicLink()) await walk(join(canonical, entry.name), depth + 1);
          }
        } catch (error) { errors.push(`${path}: ${(error as Error).message}`); }
      };
      await walk(canonicalRoot, 0);
    }
    const skills: Skill[] = [];
    const registry = new Map<string, Record>();
    for (const record of records.values()) {
      try {
        const skill = await this.describe(record);
        skills.push(skill); registry.set(skill.id, record);
      } catch (error) { errors.push(`${record.directory}: ${(error as Error).message}`); }
    }
    // Preserve IDs from other configured project views; writes still revalidate paths and files.
    for (const [id, record] of registry) this.registry.set(id, record);
    skills.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
    return { skills, projects: this.config.projects.map(({ id, name }) => ({ id, name })), errors };
  }

  private async describe(record: Record): Promise<Skill> {
    const manifest = join(record.directory, "SKILL.md");
    const text = await readFile(manifest, "utf8");
    const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!frontmatter) throw new Error("SKILL.md is missing YAML frontmatter.");
    const doc = parseDocument(frontmatter[1]);
    if (doc.errors.length) throw new Error(doc.errors[0].message);
    const data = doc.toJS() as { name?: unknown; description?: unknown };
    if (!data || typeof data.name !== "string" || typeof data.description !== "string") throw new Error("Skill requires a string name and description.");
    const policy = await policyAt(record.directory);
    let editable = record.root.writable && inside(record.root.path, record.directory);
    let reason: string | null = editable ? null : "Outside the configured writable root, or a bundled/system skill.";
    try {
      await safePolicyPath(record.directory);
      await access(record.directory, constants.W_OK);
      if (policy.text !== null) {
        await access(join(record.directory, "agents"), constants.W_OK);
        await access(join(record.directory, "agents/openai.yaml"), constants.W_OK);
      }
    } catch (error) { editable = false; reason = (error as Error).message; }
    if (policy.error) { editable = false; reason = policy.error; }
    return { id: hash(record.directory), name: data.name, description: data.description, path: manifest, scope: record.root.scope, projectId: record.root.projectId, enabled: await enabledAt(manifest, record.root.cwd), allowImplicitInvocation: policy.allowed, policyState: policy.state, editable, reason, revision: policy.revision };
  }

  async set(id: string, allowed: boolean, expectedRevision: string): Promise<Skill> {
    const prior = this.pending.get(id) ?? Promise.resolve();
    const current = prior.catch(() => {}).then(() => this.write(id, allowed, expectedRevision));
    this.pending.set(id, current);
    try { return await current; }
    finally { if (this.pending.get(id) === current) this.pending.delete(id); }
  }

  private async write(id: string, allowed: boolean, expectedRevision: string): Promise<Skill> {
    const record = this.registry.get(id);
    if (!record) throw new SkillError("UNKNOWN_SKILL", "Refresh the list before changing this skill.");
    const canonical = await realpath(record.directory);
    if (canonical !== record.directory || !inside(record.root.path, canonical)) throw new SkillError("UNSAFE_PATH", "The skill path changed. Refresh the list.");
    const skill = await this.describe(record);
    if (!skill.editable) throw new SkillError("READ_ONLY", skill.reason ?? "Skill is read-only.");
    const before = await policyAt(canonical);
    if (before.revision !== expectedRevision) throw new SkillError("CONFLICT", "The policy changed outside this panel. Refresh and try again.");
    if (before.allowed === allowed) return skill;
    const doc = parseDocument(before.text ?? "");
    doc.setIn(["policy", "allow_implicit_invocation"], allowed);
    const file = await safePolicyPath(canonical);
    await mkdir(dirname(file), { recursive: true });
    const temporary = join(dirname(file), `.skill-toggle-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, doc.toString(), { flag: "wx", mode: before.mode });
      await chmod(temporary, before.mode);
      await safePolicyPath(canonical);
      if ((await policyAt(canonical)).revision !== expectedRevision) throw new SkillError("CONFLICT", "The policy changed while saving. Refresh and try again.");
      await rename(temporary, file);
    } finally { await unlink(temporary).catch((error) => { if (!isMissing(error)) throw error; }); }
    const after = await this.describe(record);
    if (after.allowImplicitInvocation !== allowed) throw new SkillError("VERIFY_FAILED", "The saved policy did not match the requested value.");
    return after;
  }
}
