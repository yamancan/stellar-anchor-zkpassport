import { config } from "./config.js";
import { createApp } from "./app.js";
import { type AssetStore } from "./assets.js";
import { openDurableDb, type DurableStorage } from "./cloudflare-db.js";
import { createLogger, type Deps } from "./context.js";
import { createRateService } from "./rates.js";
import { createSepContext } from "./sepauth.js";
import { createAnchorGateGateway } from "./anchor-gate-rpc.js";
import { createSepAnchorGateway } from "./sep-anchor-rpc.js";
import { createSepAnchorIngress } from "./sep-anchor-ingress.js";
import { createGateway } from "./stellar.js";

interface DurableObjectId {}
interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}
interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}
interface DurableObjectState {
  storage: DurableStorage;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}
interface AssetsBinding {
  fetch(request: Request): Promise<Response>;
}
interface Env {
  ANCHOR_STATE: DurableObjectNamespace;
  ASSETS: AssetsBinding;
}

const alarmIntervalMs = 5_000;

function cloudflareAssets(binding: AssetsBinding): AssetStore {
  return {
    fetch: (path) =>
      binding.fetch(new Request(new URL(path, "https://assets.invalid"))),
  };
}

export class AnchorState {
  private readonly app;
  private readonly deps: Deps;

  constructor(
    private readonly state: DurableObjectState,
    env: Env
  ) {
    const log = createLogger();
    const stellar = createGateway(config);
    this.deps = {
      cfg: config,
      db: openDurableDb(state.storage),
      stellar,
      rates: createRateService(config, (message) => log.warn(message)),
      log,
      anchorGate: createAnchorGateGateway(config),
      sepAnchorGateway: createSepAnchorGateway(config),
      sepAnchorIngress: createSepAnchorIngress(config),
    };
    const sep = createSepContext(this.deps);
    this.app = createApp(this.deps, sep, cloudflareAssets(env.ASSETS));
    void state.blockConcurrencyWhile(async () => {
      if ((await state.storage.getAlarm()) === null)
        await state.storage.setAlarm(Date.now() + alarmIntervalMs);
    });
  }

  fetch(request: Request): Promise<Response> {
    return Promise.resolve(this.app.fetch(request));
  }

  async alarm(): Promise<void> {
    try {
      await this.deps.sepAnchor?.tick();
    } catch (error) {
      this.deps.log.warn(
        `SEP anchor reconciliation remains pending: ${(error as Error).message}`
      );
    } finally {
      await this.state.storage.setAlarm(Date.now() + alarmIntervalMs);
    }
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const id = env.ANCHOR_STATE.idFromName("anchor");
    return env.ANCHOR_STATE.get(id).fetch(request);
  },
};
