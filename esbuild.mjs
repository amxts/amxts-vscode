// Bundles the extension into dist/extension.js: one file with its
// dependencies in it, `vscode` left to the editor.
import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const options = {
	entryPoints: ["src/extension.ts"],
	bundle: true,
	outfile: "dist/extension.js",
	format: "cjs",
	platform: "node",
	target: "node20",
	external: ["vscode"],
	// jsonc-parser's main entry is UMD, whose requires esbuild cannot follow: its ES module build instead.
	mainFields: ["module", "main"],
	minify: !watch,
	sourcemap: watch,
	logLevel: "info",
};

if (watch) await (await esbuild.context(options)).watch();
else await esbuild.build(options);
