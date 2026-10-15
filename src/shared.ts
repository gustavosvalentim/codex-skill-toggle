import { z } from "zod";

export const APP_NAME = "Skill Toggle";
export const APP_VERSION = "0.3.1";
export const UI_URI = "ui://skill-toggle/manager-v6.html";
export const OPEN_TOOL = "open_skill_toggle";
export const CHECK_TOOL = "check_connection";
export const LIST_TOOL = "list_skills";
export const SET_TOOL = "set_implicit_invocation";
export const REFRESH_GUIDANCE = "Saved on disk. Use a fresh Codex chat to pick up the setting; loaded instructions may remain in an existing chat. Live desktop refresh has not been verified.";

export const ConnectionInput = z.object({ nonce: z.string().min(1).max(128) });
export const ConnectionOutput = z.object({ nonce: z.string(), server: z.literal("codex-skill-toggle"), version: z.string(), checkedAt: z.string().datetime() });
export const SkillSchema = z.object({
  id: z.string(), name: z.string(), description: z.string(), path: z.string(),
  scope: z.enum(["personal", "project", "system"]), projectId: z.string().nullable(),
  enabled: z.boolean().nullable(), allowImplicitInvocation: z.boolean().nullable(),
  policyState: z.enum(["default", "configured", "invalid"]),
  editable: z.boolean(), reason: z.string().nullable(), revision: z.string(),
});
export const ListInput = z.object({ projectId: z.string().optional(), personalOnly: z.boolean().optional() });
export const AddProjectInput = z.object({ path: z.string().min(1) });
export const ListOutput = z.object({
  skills: z.array(SkillSchema),
  projects: z.array(z.object({ id: z.string(), name: z.string(), cwd: z.string().optional() })),
  errors: z.array(z.string()),
  context: z.object({ currentProjectId: z.string().nullable(), selectedProjectId: z.string().nullable(), directory: z.string().nullable() }).optional(),
});
export const SetInput = z.object({ skillId: z.string(), allowed: z.boolean(), expectedRevision: z.string() });
export const SetOutput = z.object({ skill: SkillSchema, refreshGuidance: z.string() });
export type Skill = z.infer<typeof SkillSchema>;
export type SkillList = z.infer<typeof ListOutput>;
