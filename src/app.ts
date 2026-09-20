import { Hono } from "hono";
import { Networks } from "@stellar/stellar-sdk";
import { cors } from "hono/cors";
import type { AppEnv, Deps } from "./context.js";
import { ApiError } from "./errors.js";
import {
  economicActionsEnabled,
  POLICY_PENDING_MESSAGE,
} from "./anchor-policy.js";
import { MoneyError } from "./money.js";
import { StellarError } from "./stellar.js";
import { publicRoutes } from "./routes/public.js";
import { adminRoutes } from "./routes/admin.js";
import { sep10Routes } from "./routes/sep10.js";
import { sep6Routes } from "./routes/sep6.js";
import { sep12Routes } from "./routes/sep12.js";
import { sep38Routes } from "./routes/sep38.js";
import { zkpassportRoutes } from "./routes/zkpassport.js";
import { anchorGateRoutes } from "./routes/anchor-gate.js";
import { anchorGateBrowserRoutes } from "./anchor-gate-browser.js";
import { createSepContext, type SepContext } from "./sepauth.js";
import { createSepAnchor } from "./sep-anchor.js";
import { createSepAnchorRoutes } from "./routes/sep-anchor.js";
import { createOfacPrecheck } from "./ofac-precheck.js";
import { nodeAssets, type AssetStore } from "./assets.js";
import { join } from "node:path";

export function createApp(
  deps: Deps,
  sep: SepContext = createSepContext(deps),
  assets: AssetStore = nodeAssets(
    process.env.PUBLIC_DIR ?? join(process.cwd(), "public")
  )
) {
  const app = new Hono<AppEnv>();
  if (
    deps.cfg.anchorMode === "zkpassport" &&
    deps.cfg.networkPassphrase === Networks.TESTNET &&
    deps.cfg.anchorGateOfacEnabled &&
    (deps.anchorGate || deps.sepAnchorGateway)
  )
    deps.ofac ??= createOfacPrecheck();

  // Sandbox: wallets/dApps call these directly from the browser. Testnet only.
  app.use(
    "*",
    cors({
      origin: "*",
      allowHeaders: ["Content-Type", "Authorization", "Idempotency-Key"],
      exposeHeaders: ["X-Request-Id"],
    })
  );

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json(
        {
          error: {
            code: err.code,
            message: err.message,
            ...(err.details !== undefined ? { details: err.details } : {}),
          },
        },
        err.status as 400
      );
    }
    if (err instanceof MoneyError)
      return c.json(
        { error: { code: "invalid_amount", message: err.message } },
        400
      );
    if (err instanceof StellarError)
      return c.json(
        { error: { code: "stellar_error", message: err.message } },
        502
      );
    deps.log.error(`unhandled: ${err.stack ?? err.message}`);
    return c.json(
      { error: { code: "internal_error", message: "Internal error" } },
      500
    );
  });
  app.notFound((c) =>
    c.json(
      {
        error: {
          code: "not_found",
          message: `No route for ${c.req.method} ${c.req.path}`,
        },
      },
      404
    )
  );

  app.route("/", adminRoutes(deps));
  app.route("/", publicRoutes(deps, sep));
  app.route("/", sep10Routes(deps, sep));
  if (
    deps.sepAnchorGateway &&
    deps.cfg.anchorMode === "zkpassport" &&
    deps.cfg.networkPassphrase === Networks.TESTNET
  ) {
    const engine = (deps.sepAnchor ??= createSepAnchor(
      deps,
      deps.sepAnchorGateway
    ));
    app.route(
      "/",
      createSepAnchorRoutes(
        deps,
        sep,
        engine,
        assets
      ) as unknown as Hono<AppEnv>
    );
  }
  app.route("/", sep6Routes(deps, sep) as unknown as Hono<AppEnv>);
  app.route("/", sep12Routes(deps, sep) as unknown as Hono<AppEnv>);
  app.route("/", sep38Routes(deps, sep) as unknown as Hono<AppEnv>);
  app.route("/", zkpassportRoutes(deps, sep) as unknown as Hono<AppEnv>);
  app.route("/", anchorGateRoutes(deps, sep) as unknown as Hono<AppEnv>);
  app.route("/", anchorGateBrowserRoutes(deps.cfg.publicUrl, assets));

  // Revalidate static assets every load so CSS/JS changes reach browsers immediately.
  app.use("/static/*", async (c, next) => {
    let path: string;
    try {
      path = decodeURIComponent(c.req.path);
    } catch {
      return c.text("Invalid path", 400);
    }
    if (
      !economicActionsEnabled(deps.cfg) &&
      (path.endsWith("/") || /\.html?$/i.test(path))
    ) {
      return c.text(POLICY_PENDING_MESSAGE, 403);
    }
    await next();
    c.header("Cache-Control", "no-cache");
  });
  if (assets)
    app.get("/static/*", async (c) => {
      const response = await assets.fetch(c.req.path.replace(/^\/static/, ""));
      const headers = new Headers(response.headers);
      headers.set("Cache-Control", "no-cache");
      return new Response(response.body, { status: response.status, headers });
    });

  return app;
}
