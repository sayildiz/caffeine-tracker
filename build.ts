import { plugin } from "bun";
import { SveltePlugin } from "bun-plugin-svelte";

await Bun.$`rm -rf dist`;
await Bun.write("dist/.keep", "");

const result = await Bun.build({
  entrypoints: ["./src/main.ts"],
  outdir: "./dist",
  target: "browser",
  minify: true,
  splitting: true,
  sourcemap: "none",
  plugins: [SveltePlugin({ development: false })],
  naming: "[name].[ext]",
});

if (!result.success) {
  console.error(result.logs);
  process.exit(1);
}

await Bun.write("./dist/main.css", Bun.file("./src/global.css"));

// GitHub Pages caches assets for 10 minutes, so stamp the refs with a content hash:
// every deploy gets fresh urls instead of a stale cached main.js.
const cssText = await Bun.file("./dist/main.css").text();
let html = await Bun.file("./src/index.html").text();
html = html
  .replace("main.css", `main.css?v=${Bun.hash(cssText).toString(36)}`)
  .replace("main.js", `main.js?v=${Bun.hash(await Bun.file("./dist/main.js").text()).toString(36)}`);
await Bun.write("./dist/index.html", html);
console.log("built", result.outputs.map((o) => o.path).join(", "));
