import esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/**
 * Prints the markers the .vscode/tasks.json problem matcher looks for.
 * Without them VS Code cannot tell when a background watch has finished a
 * rebuild, and F5 hangs waiting on a task that never exits.
 */
const watchPlugin = {
  name: "watch-markers",
  setup(build) {
    build.onStart(() => {
      console.log("[watch] build started");
    });
    build.onEnd((result) => {
      for (const error of result.errors) {
        const at = error.location;
        console.error(`✘ [ERROR] ${error.text}${at ? ` (${at.file}:${at.line}:${at.column})` : ""}`);
      }
      console.log("[watch] build finished");
    });
  },
};

const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  platform: "node",
  target: "node20",
  format: "cjs",
  // The vscode module is provided by the extension host at runtime, never bundled.
  external: ["vscode"],
  sourcemap: !production,
  minify: production,
  logLevel: watch ? "silent" : "info",
  plugins: watch ? [watchPlugin] : [],
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
