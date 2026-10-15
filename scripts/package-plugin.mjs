import { build } from "esbuild";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const destination = resolve("dist/plugin");
await rm(destination, { recursive: true, force: true });
await mkdir(join(destination, "server"), { recursive: true });
await cp("plugin", destination, { recursive: true });
await cp("dist/panel.html", join(destination, "server/panel.html"));
await cp("plugin/assets/icon-outline.svg", join(destination, "server/icon.svg"));
const result = await build({
  entryPoints: ["src/server/index.ts"], outfile: join(destination, "server/server.mjs"),
  bundle: true, platform: "node", format: "esm", target: "node22", metafile: true,
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
});
// Preserve dependency license notices in the redistributable bundle.
const packages = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const parts = input.split("/"); const index = parts.lastIndexOf("node_modules");
  if (index < 0) continue;
  packages.add(parts.slice(0, index + (parts[index + 1].startsWith("@") ? 3 : 2)).join("/"));
}
const notices = [];
for (const directory of [...packages].sort()) {
  const pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  const files = (await readdir(directory)).filter((name) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(name));
  notices.push(`${pkg.name}@${pkg.version} — ${pkg.license ?? "See license below"}`);
  for (const name of files) notices.push(await readFile(join(directory, name), "utf8"));
}
await writeFile(join(destination, "THIRD_PARTY_NOTICES.txt"), notices.join("\n\n"));
const manifest = JSON.parse(await readFile(join(destination, "plugin.json"), "utf8"));
await mkdir("release", { recursive: true });
const archive = resolve(`release/${manifest.name}-${manifest.version}.zip`);
await rm(archive, { force: true });
execFileSync("zip", ["-qr", archive, "."], { cwd: destination });
console.log(`Plugin: ${destination}\nArchive: ${archive}`);

// A second archive includes a marketplace catalog for direct local installation.
const marketplace = resolve("dist/marketplace");
await rm(marketplace, { recursive: true, force: true });
await mkdir(join(marketplace, ".agents/plugins"), { recursive: true });
await mkdir(join(marketplace, "plugins"), { recursive: true });
await cp(destination, join(marketplace, "plugins", manifest.name), { recursive: true });
const catalog = JSON.parse(await readFile(".agents/plugins/marketplace.json", "utf8"));
catalog.plugins[0].source.path = `./plugins/${manifest.name}`;
await writeFile(join(marketplace, ".agents/plugins/marketplace.json"), JSON.stringify(catalog, null, 2) + "\n");
const marketplaceArchive = resolve(`release/${manifest.name}-marketplace-${manifest.version}.zip`);
await rm(marketplaceArchive, { force: true });
execFileSync("zip", ["-qr", marketplaceArchive, "."], { cwd: marketplace });
console.log(`Installable marketplace: ${marketplaceArchive}`);
