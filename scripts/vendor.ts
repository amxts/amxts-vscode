// Copies Config Core's YAML and JSON readers into src/vendor/config-core/, so
// the editor reports a file that does not parse exactly as the server would.
// They are plain TypeScript; the only change is the module augmentation of
// @amxts/core in types.ts, which is left out.
//
//   bun scripts/vendor.ts [path to config-core]   (default: ../amxts-modules/config-core)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? join(import.meta.dir, "../../amxts-modules/config-core"));
const from = join(root, "src");
const to = join(import.meta.dir, "../src/vendor/config-core");
if (!existsSync(join(from, "yaml.ts"))) throw new Error(`no Config Core sources in ${from}`);

const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
let commit = "";
try {
	commit = execSync("git rev-parse --short HEAD", { cwd: root }).toString().trim();
} catch {
	// not a git checkout: the version says enough
}

mkdirSync(to, { recursive: true });
for (const file of ["yaml.ts", "json.ts", "tree.ts", "internal.ts", "types.ts"]) {
	let text = readFileSync(join(from, file), "utf8");
	text = text.replaceAll("\r\n", "\n");
	if (file == "types.ts") text = text.replace(/\ndeclare module "@amxts\/core" \{[\s\S]*?\n\}\n/, "\n");
	const header = `// Copied from @amxts/config-core ${version}${commit ? ` (${commit})` : ""} src/${file} by scripts/vendor.ts - do not edit.\n// @ts-nocheck\n`;
	writeFileSync(join(to, file), header + text);
}
console.log(`vendored Config Core ${version} ${commit} into src/vendor/config-core`);
