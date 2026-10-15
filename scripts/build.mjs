import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";

await mkdir("dist", { recursive: true });
await writeFile("dist/icon.svg", await readFile("plugin/assets/icon-outline.svg"));
const ui = await build({
  entryPoints: ["src/ui/index.ts"], bundle: true, write: false,
  platform: "browser", format: "esm", target: "es2022", minify: true,
});
const template = await readFile("src/ui/panel.html", "utf8");
const script = ui.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
await writeFile("dist/panel.html", template.replace("/* APP_SCRIPT */", () => script));
await build({
  entryPoints: ["src/server/index.ts"], outfile: "dist/server.js",
  bundle: true, packages: "external", platform: "node", format: "esm", target: "node22",
});
