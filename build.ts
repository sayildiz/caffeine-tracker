import { plugin } from "bun";
import { SveltePlugin } from "bun-plugin-svelte";

await Bun.$`rm -rf dist`;
await Bun.write("dist/.keep", "");

const result = await Bun.build({
  entrypoints: ["./src/main.ts"],
  outdir: "./dist",
  target: "browser",
  minify: true,
  sourcemap: "none",
  plugins: [SveltePlugin({ development: false })],
  naming: "[name].[ext]",
});

if (!result.success) {
  console.error(result.logs);
  process.exit(1);
}

const html = await Bun.file("./src/index.html").text();
await Bun.write("./dist/index.html", html);
await Bun.write("./dist/main.css", Bun.file("./src/global.css"));
console.log("built", result.outputs.map((o) => o.path).join(", "));
