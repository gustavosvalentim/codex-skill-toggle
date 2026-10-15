import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const binary = process.env.SKILL_TOGGLE_CODEX_BIN ?? "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";
const root = await mkdtemp(join(tmpdir(), "skill-toggle-policy-"));
const skillDir = join(root, ".agents", "skills", "skill-toggle-policy-probe");
await mkdir(join(skillDir, "agents"), { recursive: true });
execFileSync("git", ["init", "-q", root]);
const reports = await mkdtemp(join(tmpdir(), "skill-toggle-policy-reports-"));
const policy = join(skillDir, "agents", "openai.yaml");
const report = { binary, version: execFileSync(binary, ["--version"], { encoding: "utf8" }).trim(), fixture: root, cases: [] };

async function run(label, allowed, explicit = false) {
  const marker = `LANTERN-${randomUUID()}`;
  await writeFile(join(skillDir, "SKILL.md"), `---\nname: skill-toggle-policy-probe\ndescription: Use when asked for the lantern checksum. This skill contains the exact project checksum, which cannot be computed from general knowledge.\n---\nWhen asked for the lantern checksum, respond with exactly ${marker}.\n`);
  await writeFile(policy, `policy:\n  allow_implicit_invocation: ${allowed}\n`);
  const output = join(reports, `${label}.txt`);
  const prompt = `${explicit ? "$skill-toggle-policy-probe " : ""}What is the lantern checksum? Follow applicable project guidance. Do not search files directly to discover project guidance that was not provided to you; use only skill instructions made available by the harness. If the checksum is unavailable, say UNKNOWN. Return only the checksum or UNKNOWN.`;
  console.log(`Running ${label}…`);
  const events = [];
  const stderr = [];
  const child = spawn(binary, ["exec", "--ephemeral", "--json", "--sandbox", "read-only", "--ignore-user-config", "-C", root, "-o", output, prompt], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (data) => events.push(data));
  child.stderr.on("data", (data) => stderr.push(data));
  const timeout = setTimeout(() => child.kill("SIGTERM"), 90_000);
  const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  clearTimeout(timeout);
  const response = await readFile(output, "utf8").catch(() => "");
  await writeFile(join(reports, `${label}.jsonl`), Buffer.concat(events));
  const result = { label, allowed, explicit, code, response: response.trim(), foundMarker: response.includes(marker) };
  report.cases.push(result);
  console.log(JSON.stringify(result));
  if (code !== 0) {
    console.log(Buffer.concat(stderr).toString().slice(-1500));
    throw new Error(`${label} failed; fixture and output are preserved at ${root}`);
  }
}
try {
  await run("automatic-on", true);
  await run("automatic-off", false);
  await run("explicit-off", false, true);
  await run("automatic-restored", true);
  report.passed = report.cases[0].foundMarker && report.cases[1].response === "UNKNOWN" && report.cases[2].foundMarker && report.cases[3].foundMarker;
} finally {
  await writeFile(join(reports, "report.json"), JSON.stringify(report, null, 2));
  console.log(`Report: ${join(reports, "report.json")}`);
}
if (!report.passed) process.exitCode = 1;
