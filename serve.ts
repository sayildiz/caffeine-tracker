const PORT = Number(process.env.PORT ?? 8099);
const ROOT = new URL("./dist/", import.meta.url).pathname;

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);
    let path = url.pathname === "/" ? "/index.html" : url.pathname;
    if (path.includes("..")) return new Response("nope", { status: 400 });
    const file = Bun.file(ROOT + path);
    if (await file.exists()) {
      return new Response(file, {
        headers: { "cache-control": "no-cache" },
      });
    }
    // SPA fallback
    return new Response(Bun.file(ROOT + "index.html"), {
      headers: { "content-type": "text/html" },
    });
  },
});

console.log(`caffeine tracker on http://0.0.0.0:${server.port}`);