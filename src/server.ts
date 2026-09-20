import { serve } from "@hono/node-server";
import { config } from "./config.js";
import { openDb } from "./db.js";
import { createGateway } from "./stellar.js";
import { createRateService } from "./rates.js";
import { createLogger, type Deps } from "./context.js";
import { createApp } from "./app.js";
import { createWorkers } from "./workers.js";
import { createSepContext } from "./sepauth.js";
import { fmtRate, fmtUsdc } from "./money.js";
import { createAnchorGateGateway } from "./anchor-gate-rpc.js";
import { createSepAnchorGateway } from "./sep-anchor-rpc.js";
import { createSepAnchorIngress } from "./sep-anchor-ingress.js";
import { nodeAssets } from "./assets.js";
import { join } from "node:path";

export async function main() {
  const log = createLogger();
  const db = openDb(config.dbPath);
  const stellar = createGateway(config);
  const rates = createRateService(config, (m) => log.warn(m));
  const deps: Deps = {
    cfg: config,
    db,
    stellar,
    rates,
    log,
    anchorGate: createAnchorGateGateway(config),
    sepAnchorGateway: createSepAnchorGateway(config),
    sepAnchorIngress: createSepAnchorIngress(config),
  };
  const sep = createSepContext(deps);
  const app = createApp(
    deps,
    sep,
    nodeAssets(process.env.PUBLIC_DIR ?? join(process.cwd(), "public"))
  );

  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    log.info(
      `tr-mock-anchor listening on http://localhost:${info.port} (public: ${config.publicUrl})`
    );
    log.info(
      `stellar: mode=${stellar.mode} asset=${stellar.assetCode}:${stellar.assetIssuer}`
    );
    if (stellar.mode === "live")
      log.info(
        `stellar endpoints: submit/seq via RPC ${config.rpcUrl}; payment watcher via Horizon ${config.horizonUrl}`
      );
    log.info(`legacy treasury: ${stellar.treasuryPublicKey}`);
    log.info(
      `sep: signing key ${sep.signingKeypair.publicKey()} home_domain ${sep.homeDomain}`
    );
  });

  void stellar
    .treasuryUsdcBalance()
    .then((b) => {
      log.info(`legacy treasury USDC balance: ${fmtUsdc(b)}`);
      if (b < 100_0000000n)
        log.warn(
          config.anchorMode === "zkpassport"
            ? "legacy treasury balance is low; proof-gated orders use the configured vault provider liquidity or recipient escrow, not the legacy treasury"
            : "legacy treasury balance is low: fund it with the configured USDC issuer asset before legacy settlement"
        );
    })
    .catch((e) =>
      log.error(
        `legacy treasury balance check failed: ${(e as Error).message} (check account funding and its configured issuer trustline)`
      )
    );
  void rates
    .getMid()
    .then((r) =>
      log.info(`USD/TRY mid ${fmtRate(r.midMicro)} (source: ${r.source})`)
    );

  const workers = createWorkers(deps, sep);
  let sepTickRunning = false;
  const sepTimer = deps.sepAnchor
    ? setInterval(async () => {
        if (sepTickRunning) return;
        sepTickRunning = true;
        try {
          await deps.sepAnchor!.tick();
        } catch {
          log.warn(
            "SEP anchor reconciliation is pending; retained actions will be checked again."
          );
        } finally {
          sepTickRunning = false;
        }
      }, 5000)
    : undefined;
  if (config.workers) workers.start();
  else
    log.warn(
      "WORKERS=false: legacy settlement, payment-watcher, and webhook workers are disabled; the separately configured proof-gated HTTP/RPC flow does not depend on these workers"
    );

  const shutdown = () => {
    log.info("shutting down");
    workers.stop();
    if (sepTimer) clearInterval(sepTimer);
    server.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
