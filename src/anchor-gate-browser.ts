import { join } from "node:path";
import { Hono } from "hono";
import { assetText, nodeAssets, type AssetStore } from "./assets.js";

export function anchorGateBrowserRoutes(
  publicUrl: string,
  source: string | AssetStore = process.env.PUBLIC_DIR ??
    join(process.cwd(), "public")
) {
  const assets = typeof source === "string" ? nodeAssets(source) : source;
  const app = new Hono();
  const expected = new URL(publicUrl);
  const fonts = [
    "playfair-display.ttf",
    "playfair-display-italic.ttf",
    "ibm-plex-sans.ttf",
    "ibm-plex-mono.ttf",
  ];
  for (const path of [
    "/anchor-gate",
    "/anchor-gate/bundle.js",
    "/anchor-gate/style.css",
    ...fonts.map((name) => `/anchor-gate/fonts/${name}`),
  ])
    app.use(path, async (c, next) => {
      c.header("Cache-Control", "no-store");
      c.header("Referrer-Policy", "no-referrer");
      c.header("X-Content-Type-Options", "nosniff");
      c.header(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' https: wss:; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
      );
      if (new URL(c.req.url).host !== expected.host)
        return c.text("Use the configured anchor origin.", 403);
      await next();
    });
  app.get("/anchor-gate", async (c) =>
    c.html(await assetText(assets, "/anchor-gate.html"))
  );
  app.get("/anchor-gate/bundle.js", async (c) =>
    c.body(await assetText(assets, "/anchor-gate.js"), 200, {
      "Content-Type": "application/javascript; charset=utf-8",
    })
  );
  app.get("/anchor-gate/style.css", async (c) =>
    c.body(await assetText(assets, "/anchor-gate.css"), 200, {
      "Content-Type": "text/css; charset=utf-8",
    })
  );
  for (const name of fonts)
    app.get(`/anchor-gate/fonts/${name}`, async (c) =>
      c.body(
        await (await assets.fetch(`/anchor-gate-fonts/${name}`)).arrayBuffer(),
        200,
        { "Content-Type": "font/ttf" }
      )
    );
  return app;
}
