import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie, setCookie } from "hono/cookie";
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { join } from "node:path";
import { Networks, StrKey } from "@stellar/stellar-sdk";
import type { Deps } from "../context.js";
import type { SepAnchor } from "../sep-anchor.js";
import type { SepContext, SepEnv } from "../sepauth.js";
import { ensureSepCustomer } from "../core/sep.js";
import { verifyJwt } from "../jwt.js";
import { ApiError } from "../errors.js";
import { MoneyError, parseTry, parseUsdc } from "../money.js";
import { readSepQuote } from "../sep-quotes.js";
import { z } from "zod";
import { assetText, nodeAssets, type AssetStore } from "../assets.js";

const idSchema = z.string().regex(/^[a-f0-9]{64}$/);
const quoteId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const amount = z.string().regex(/^\d{1,12}(?:\.\d{1,7})?$/);
const protocolAmount = z.union([
  amount,
  z
    .number()
    .finite()
    .nonnegative()
    .max(999999999999)
    .refine((value) => Number(value.toFixed(7)) === value)
    .transform((value) => value.toFixed(7).replace(/\.?0+$/, "")),
]);
const tokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const interactiveInput = z
  .object({
    asset_code: z.string().min(1).max(12),
    asset_issuer: z.string().optional(),
    account: z.string().optional(),
    source_asset: z.string().optional(),
    destination_asset: z.string().optional(),
    customer_id: z.string().max(100).optional(),
    amount: protocolAmount.optional(),
    quote_id: quoteId.optional(),
    lang: z.string().max(35).optional(),
  })
  .passthrough();
type WebSession = { subject: string; raw: string };

export function createSepAnchorRoutes(
  deps: Deps,
  sep: SepContext,
  engine: SepAnchor,
  assets: AssetStore = nodeAssets(join(process.cwd(), "public"))
) {
  const app = new Hono<SepEnv>();
  const origin = new URL(deps.cfg.publicUrl).origin;
  const host = new URL(deps.cfg.publicUrl).host;
  const now = () => Math.floor(Date.now() / 1000);
  deps.db.exec(`CREATE TABLE IF NOT EXISTS sep_anchor_web_sessions_v1 (
    hash TEXT PRIMARY KEY, transaction_id TEXT NOT NULL, subject TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('bootstrap','session')), expires_at INTEGER NOT NULL,
    nonce TEXT
  ); CREATE INDEX IF NOT EXISTS sep_anchor_web_expiry ON sep_anchor_web_sessions_v1(expires_at);`);
  if (
    !deps.db
      .prepare("PRAGMA table_info(sep_anchor_web_sessions_v1)")
      .all()
      .some((column) => column.name === "nonce")
  )
    deps.db.exec(
      "ALTER TABLE sep_anchor_web_sessions_v1 ADD COLUMN nonce TEXT"
    );
  const cookieName = (id: string) => `sep_anchor_${id}`;
  function issue(id: string, subject: string, kind: "bootstrap" | "session") {
    deps.db
      .prepare("DELETE FROM sep_anchor_web_sessions_v1 WHERE expires_at <= ?")
      .run(now());
    const derive = (nonce: string) =>
      createHmac("sha256", sep.jwtSecret)
        .update(JSON.stringify(["sep-bootstrap-v1", id, subject, nonce]))
        .digest("hex");
    if (kind === "bootstrap") {
      const existing = deps.db
        .prepare(
          "SELECT nonce FROM sep_anchor_web_sessions_v1 WHERE transaction_id=? AND subject=? AND kind='bootstrap' AND expires_at>? ORDER BY expires_at DESC LIMIT 1"
        )
        .get(id, subject, now() + 15) as { nonce: string } | undefined;
      if (existing?.nonce) return derive(existing.nonce);
    }
    const nonce = randomBytes(32).toString("hex");
    const raw = kind === "bootstrap" ? derive(nonce) : nonce;
    deps.db
      .prepare(
        "INSERT INTO sep_anchor_web_sessions_v1(hash,transaction_id,subject,kind,expires_at,nonce) VALUES (?,?,?,?,?,?)"
      )
      .run(
        tokenHash(raw),
        id,
        subject,
        kind,
        now() + (kind === "bootstrap" ? 120 : 1800),
        kind === "bootstrap" ? nonce : null
      );
    return raw;
  }
  const csrf = (raw: string) =>
    createHmac("sha256", sep.jwtSecret)
      .update(`sep-anchor-csrf-v1:${raw}`)
      .digest("hex");
  function session(c: Context<SepEnv>, id: string): WebSession {
    if (new URL(c.req.url).host !== host)
      throw new ApiError(
        403,
        "invalid_origin",
        "Use the configured anchor origin."
      );
    const raw = getCookie(c, cookieName(id)) ?? "";
    if (!/^[a-f0-9]{64}$/.test(raw))
      throw new ApiError(
        403,
        "session_required",
        "Reopen this order from your authenticated wallet."
      );
    const row = deps.db
      .prepare(
        "SELECT subject FROM sep_anchor_web_sessions_v1 WHERE hash=? AND transaction_id=? AND kind='session' AND expires_at>?"
      )
      .get(tokenHash(raw), id, now()) as { subject: string } | undefined;
    if (!row)
      throw new ApiError(
        403,
        "session_expired",
        "This session expired. Reopen this order from your authenticated wallet."
      );
    if (c.req.method !== "GET") {
      const supplied = c.req.header("X-CSRF-Token") ?? "";
      if (
        c.req.header("origin") !== origin ||
        !/^[a-f0-9]{64}$/.test(supplied) ||
        !timingSafeEqual(
          Buffer.from(supplied, "hex"),
          Buffer.from(csrf(raw), "hex")
        )
      )
        throw new ApiError(
          403,
          "invalid_origin",
          "Refresh this same-origin page before continuing."
        );
    }
    return { subject: row.subject, raw };
  }
  async function body(c: Context<SepEnv>): Promise<Record<string, unknown>> {
    const ct = c.req.header("Content-Type") ?? "";
    let value: unknown;
    try {
      if (ct.startsWith("application/json")) value = await c.req.json();
      else if (
        ct.startsWith("application/x-www-form-urlencoded") ||
        ct.startsWith("multipart/form-data")
      )
        value = await c.req.parseBody();
      else throw new Error("unsupported_body");
    } catch {
      throw new ApiError(
        400,
        "invalid_request",
        "Provide a JSON or form request body."
      );
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new ApiError(
        400,
        "invalid_request",
        "Provide an object request body."
      );
    for (const field of [
      "callback",
      "on_change_callback",
      "redirect_url",
      "return_url",
    ])
      if (field in value)
        throw new ApiError(
          400,
          "callback_unsupported",
          "Callbacks and redirects are not supported by this Testnet profile. Poll transaction status instead."
        );
    return value as Record<string, unknown>;
  }
  app.onError((error, c) => {
    if (error instanceof z.ZodError)
      return c.json({ error: "Invalid or missing request parameters." }, 400);
    if (error instanceof MoneyError)
      return c.json(
        {
          error:
            "Invalid amount. TRY supports 2 decimal places and mock USDC supports 7.",
          code: "invalid_amount",
        },
        400
      );
    if (error instanceof ApiError)
      return c.json(
        {
          error: error.message,
          code: error.code,
          ...(error.code === "native_eligibility_required"
            ? {
                onboarding_url: `${deps.cfg.publicUrl}/anchor`,
                transfer_server_sep0024: `${deps.cfg.publicUrl}/sep24`,
              }
            : {}),
        },
        error.status as 400
      );
    deps.log.error("SEP anchor request failed.");
    return c.json(
      {
        error:
          "The anchor could not complete this request. Reconcile before retrying.",
      },
      500
    );
  });
  async function bearer(c: Context<SepEnv>, next: () => Promise<void>) {
    const raw = c.req.header("authorization") ?? "";
    const match =
      /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(raw);
    const token = match?.[1];
    let header: { alg?: string; typ?: string } = {};
    if (token && token.length < 8192) {
      try {
        header = JSON.parse(
          Buffer.from(token.split(".")[0]!, "base64url").toString("utf8")
        );
      } catch {
        header = {};
      }
    }
    const claims =
      token && token.length < 8192 ? verifyJwt(token, sep.jwtSecret) : null;
    const now = Math.floor(Date.now() / 1000);
    if (
      !claims ||
      !header ||
      header.alg !== "HS256" ||
      header.typ !== "JWT" ||
      claims.iss !== `${deps.cfg.publicUrl}/auth` ||
      !Number.isSafeInteger(claims.iat) ||
      !Number.isSafeInteger(claims.exp) ||
      claims.iat < 0 ||
      claims.iat > now + 30 ||
      claims.exp <= now ||
      claims.exp <= claims.iat
    ) {
      return c.json(
        {
          type: "authentication_required",
          error: "A valid SEP-10 bearer session is required.",
        },
        403
      );
    }
    if (!StrKey.isValidEd25519PublicKey(claims.sub))
      return c.json(
        {
          error:
            "This Testnet profile supports plain G accounts only, without shared-account memos.",
        },
        400
      );
    c.set("sepSub", claims.sub);
    c.set("sepCustomer", ensureSepCustomer(deps.db, claims.sub, "zkpassport"));
    await next();
  }
  for (const prefix of ["/sep24/*", "/sep6/*", "/sep12/*"])
    app.use(prefix, async (c, next) => {
      c.header("Cache-Control", "no-store");
      c.header("Referrer-Policy", "no-referrer");
      if (c.req.url.length > 8192)
        return c.json({ error: "Request URL is too long." }, 414);
      if (!c.req.path.startsWith("/sep24/interactive/")) {
        c.header("Access-Control-Allow-Origin", "*");
        c.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
        c.header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
        if (c.req.method === "OPTIONS") return c.body(null, 204);
      }
      if (
        c.req.path.startsWith("/sep24/interactive/") ||
        c.req.path.endsWith("/info")
      )
        return next();
      return bearer(c, next);
    });
  for (const prefix of ["/sep24/*", "/sep12/*"])
    app.use(
      prefix,
      bodyLimit({
        maxSize: 64 * 1024,
        onError: (c) => c.json({ error: "Request body exceeds 64 KiB." }, 413),
      })
    );
  app.get("/sep24/info", async (c) => {
    let config;
    try {
      config = await engine.configuration();
    } catch {
      return c.json(
        {
          error:
            "Native policy configuration is unavailable. New transfers are disabled.",
        },
        503
      );
    }
    return c.json({
      deposit: { [deps.cfg.usdcCode]: { enabled: true } },
      withdraw: { [deps.cfg.usdcCode]: { enabled: true } },
      fee: { enabled: false },
      features: { account_creation: false, claimable_balances: false },
      profile: {
        network: "testnet",
        accounts: "plain_g_only",
        synthetic_documents_only: true,
        simulated_fiat: true,
        custodial_ingress: true,
      },
      network: "testnet",
      network_passphrase: Networks.TESTNET,
      asset: {
        code: deps.cfg.usdcCode,
        issuer: deps.cfg.usdcIssuer,
        contract: config.token,
      },
      config,
    });
  });
  app.get("/sep6/info", async (c) => {
    try {
      await engine.configuration();
    } catch {
      return c.json(
        {
          error:
            "Native policy configuration is unavailable. New transfers are disabled.",
        },
        503
      );
    }
    return c.json({
      deposit: { [deps.cfg.usdcCode]: { enabled: false } },
      withdraw: { [deps.cfg.usdcCode]: { enabled: false } },
      "deposit-exchange": {
        [deps.cfg.usdcCode]: {
          enabled: true,
          authentication_required: true,
          funding_methods: ["bank_account"],
          fields: {
            type: {
              description: "Simulated bank transfer",
              choices: ["bank_account"],
              optional: false,
            },
          },
        },
      },
      "withdraw-exchange": {
        [deps.cfg.usdcCode]: {
          enabled: true,
          authentication_required: true,
          funding_methods: ["bank_account"],
          types: {
            bank_account: {
              fields: {
                bank_destination: {
                  description:
                    "Synthetic destination, such as demo:wallet. Never use a real IBAN.",
                  optional: false,
                },
              },
            },
          },
        },
      },
      fee: { enabled: false },
      transactions: { enabled: true, authentication_required: true },
      transaction: { enabled: true, authentication_required: true },
      features: { account_creation: false, claimable_balances: false },
      profile: {
        accounts: "plain_g_only",
        native_eligibility_required: true,
        first_time_onboarding: "sep24",
        onboarding_url: `${deps.cfg.publicUrl}/anchor`,
        transfer_server_sep0024: `${deps.cfg.publicUrl}/sep24`,
      },
    });
  });
  for (const protocol of ["sep6", "sep24"] as const)
    app.get(`/${protocol}/transactions`, async (c) => {
      if (c.req.query("asset_code") !== deps.cfg.usdcCode)
        throw new ApiError(
          400,
          "invalid_asset",
          "Provide the configured asset_code."
        );
      const input = z
        .object({
          kind: z.enum(["deposit", "withdrawal"]).optional(),
          limit: z.coerce.number().int().min(1).max(100).optional(),
          no_older_than: z.string().datetime({ offset: true }).optional(),
          paging_id: idSchema.optional(),
        })
        .parse(c.req.query());
      return c.json({
        transactions: await engine.list(c.get("sepSub"), input),
      });
    });
  async function beginInteractive(
    c: Context<SepEnv>,
    direction: "deposit" | "withdrawal"
  ) {
    const input = interactiveInput.safeParse(await body(c));
    if (
      !input.success ||
      input.data.asset_code !== deps.cfg.usdcCode ||
      (input.data.asset_issuer &&
        input.data.asset_issuer !== deps.cfg.usdcIssuer)
    )
      throw new ApiError(
        400,
        "invalid_request",
        "Provide this demo's exact asset code and issuer."
      );
    if (
      (direction === "deposit" &&
        (input.data.destination_asset !== undefined ||
          (input.data.source_asset !== undefined &&
            input.data.source_asset !== "iso4217:TRY"))) ||
      (direction === "withdrawal" &&
        (input.data.source_asset !== undefined ||
          (input.data.destination_asset !== undefined &&
            input.data.destination_asset !== "iso4217:TRY")))
    )
      throw new ApiError(
        400,
        "unsupported_asset",
        "This profile exchanges only simulated TRY and the configured mock token."
      );
    if (
      input.data.customer_id !== undefined &&
      input.data.customer_id !== c.get("sepCustomer").id
    )
      throw new ApiError(
        400,
        "invalid_customer",
        "Use this authenticated wallet's customer ID."
      );
    const parseAmount = direction === "deposit" ? parseTry : parseUsdc;
    if (input.data.amount !== undefined && parseAmount(input.data.amount) <= 0n)
      throw new ApiError(
        400,
        "invalid_amount",
        "The requested amount must be positive."
      );
    if (input.data.quote_id) {
      const firm = readSepQuote(
        deps,
        c.get("sepCustomer").id,
        input.data.quote_id
      );
      const tokenAsset = `stellar:${deps.cfg.usdcCode}:${deps.cfg.usdcIssuer}`;
      if (
        firm.sell_asset !==
          (direction === "deposit" ? "iso4217:TRY" : tokenAsset) ||
        firm.buy_asset !==
          (direction === "deposit" ? tokenAsset : "iso4217:TRY") ||
        (input.data.amount !== undefined &&
          parseAmount(input.data.amount) !== parseAmount(firm.sell_amount))
      )
        throw new ApiError(
          400,
          "quote_mismatch",
          "The requested assets or source amount do not match the firm quote."
        );
    }
    for (const field of [
      "memo",
      "memo_type",
      "refund_memo",
      "refund_memo_type",
    ])
      if (input.data[field] !== undefined)
        throw new ApiError(
          400,
          "unsupported_account",
          "This profile supports plain G accounts without account or refund memos."
        );
    const view = await engine.begin(
      c.get("sepSub"),
      c.get("sepCustomer").id,
      "sep24",
      direction,
      {
        account: input.data.account,
        amount: input.data.amount,
        quote_id: input.data.quote_id,
      }
    );
    return c.json({
      type: "interactive_customer_info_needed",
      id: view.id,
      url: `${deps.cfg.publicUrl}/sep24/interactive/${view.id}?token=${issue(view.id, c.get("sepSub"), "bootstrap")}`,
    });
  }
  app.post("/sep24/transactions/deposit/interactive", (c) =>
    beginInteractive(c, "deposit")
  );
  app.post("/sep24/transactions/withdraw/interactive", (c) =>
    beginInteractive(c, "withdrawal")
  );
  app.get("/sep24/interactive/:id", async (c) => {
    const id = idSchema.parse(c.req.param("id"));
    if (new URL(c.req.url).host !== host)
      throw new ApiError(
        403,
        "invalid_origin",
        "Use the configured anchor origin."
      );
    c.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self' https: wss:; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
    );
    c.header("X-Content-Type-Options", "nosniff");
    const token = c.req.query("token");
    if (token !== undefined) {
      if (!/^[a-f0-9]{64}$/.test(token))
        throw new ApiError(
          403,
          "invalid_session",
          "The order link is invalid or already used. Reopen it from your wallet."
        );
      const existing = getCookie(c, cookieName(id));
      if (existing && /^[a-f0-9]{64}$/.test(existing)) {
        const valid = deps.db
          .prepare(
            "SELECT subject FROM sep_anchor_web_sessions_v1 WHERE hash=? AND transaction_id=? AND kind='session' AND expires_at>?"
          )
          .get(tokenHash(existing), id, now()) as
          { subject: string } | undefined;
        if (valid) {
          await engine.get(valid.subject, id);
          return c.redirect(`/sep24/interactive/${id}`, 303);
        }
      }
      const row = deps.db
        .prepare(
          "DELETE FROM sep_anchor_web_sessions_v1 WHERE hash=? AND transaction_id=? AND kind='bootstrap' AND expires_at>? RETURNING subject"
        )
        .get(tokenHash(token), id, now()) as { subject: string } | undefined;
      if (!row)
        throw new ApiError(
          403,
          "invalid_session",
          "The order link is invalid or already used. Reopen it from your wallet."
        );
      await engine.get(row.subject, id);
      setCookie(c, cookieName(id), issue(id, row.subject, "session"), {
        httpOnly: true,
        secure: origin.startsWith("https:"),
        sameSite: "Lax",
        path: `/sep24/interactive/${id}`,
        maxAge: 1800,
      });
      return c.redirect(`/sep24/interactive/${id}`, 303);
    }
    let owner: WebSession;
    try {
      owner = session(c, id);
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.code === "session_required" || error.code === "session_expired")
      )
        return c.redirect(`/anchor?resume=${id}`, 303);
      throw error;
    }
    await engine.get(owner.subject, id);
    return c.html(await assetText(assets, "/sep-anchor.html"));
  });
  app.get("/sep24/interactive/:id/state", async (c) => {
    const id = idSchema.parse(c.req.param("id"));
    const owner = session(c, id);
    return c.json({
      transaction: await engine.get(owner.subject, id),
      csrf_token: csrf(owner.raw),
    });
  });
  app.get("/sep24/interactive/:id/quote", async (c) => {
    const id = idSchema.parse(c.req.param("id"));
    const owner = session(c, id);
    return c.json({
      quote: await engine.readQuote(
        owner.subject,
        id,
        quoteId.parse(c.req.query("quote_id"))
      ),
    });
  });
  app.post("/sep24/interactive/:id/quote", async (c) => {
    const id = idSchema.parse(c.req.param("id"));
    const owner = session(c, id);
    const input = z
      .object({ sell_amount: amount.optional(), buy_amount: amount.optional() })
      .strict()
      .refine(
        (value) =>
          (value.sell_amount === undefined) !== (value.buy_amount === undefined)
      )
      .parse(await body(c));
    return c.json({ quote: await engine.quote(owner.subject, id, input) });
  });
  app.post("/sep24/interactive/:id/accept", async (c) => {
    const id = idSchema.parse(c.req.param("id"));
    const owner = session(c, id);
    const input = z
      .object({
        quote_id: quoteId,
        bank_destination: z
          .string()
          .regex(/^demo:[A-Za-z0-9_-]{1,64}$/)
          .optional(),
      })
      .strict()
      .parse(await body(c));
    return c.json({
      transaction: await engine.accept(
        owner.subject,
        id,
        input.quote_id,
        input.bank_destination
      ),
    });
  });
  app.post("/sep24/interactive/:id/proof-request", async (c) => {
    const id = idSchema.parse(c.req.param("id"));
    const owner = session(c, id);
    return c.json(await engine.proofRequest(owner.subject, id));
  });
  app.post("/sep24/interactive/:id/proof", async (c) => {
    const id = idSchema.parse(c.req.param("id"));
    const owner = session(c, id);
    const hex = z.string().regex(/^(?:[a-f0-9]{2})+$/);
    const input = z
      .object({ proof: hex.max(22000), public_inputs: hex.max(2048) })
      .strict()
      .parse(await body(c));
    return c.json({
      transaction: await engine.submitProof(
        owner.subject,
        id,
        Buffer.from(input.proof, "hex"),
        Buffer.from(input.public_inputs, "hex")
      ),
    });
  });
  for (const [path, action] of [
    ["mock-bank", "simulateBank"],
    ["refund", "refund"],
  ] as const)
    app.post(`/sep24/interactive/:id/${path}`, async (c) => {
      const id = idSchema.parse(c.req.param("id"));
      const owner = session(c, id);
      return c.json({ transaction: await engine[action](owner.subject, id) });
    });
  for (const protocol of ["sep6", "sep24"] as const)
    app.get(`/${protocol}/transaction`, async (c) => {
      if (
        ["id", "stellar_transaction_id", "external_transaction_id"].some(
          (name) => (c.req.queries(name) ?? []).length > 1
        )
      )
        throw new ApiError(
          400,
          "invalid_request",
          "Provide exactly one transaction identifier."
        );
      const input = z
        .object({
          id: z.string().min(1).max(128).optional(),
          stellar_transaction_id: idSchema.optional(),
          external_transaction_id: z.string().min(1).max(100).optional(),
        })
        .refine(
          (value) =>
            Object.values(value).filter((value) => value !== undefined)
              .length === 1
        )
        .parse(c.req.query());
      const view = await engine.find(c.get("sepSub"), input);
      return c.json({
        transaction: {
          ...view,
          more_info_url: `${deps.cfg.publicUrl}/sep24/interactive/${view.id}?token=${issue(view.id, c.get("sepSub"), "bootstrap")}`,
        },
      });
    });
  for (const path of ["deposit", "withdraw"] as const)
    app.get(`/sep6/${path}`, (c) =>
      c.json(
        {
          error:
            "This anchor exchanges TRY and the demo token. Use the advertised exchange endpoint and a firm SEP-38 quote.",
        },
        400
      )
    );
  for (const [path, direction] of [
    ["deposit-exchange", "deposit"],
    ["withdraw-exchange", "withdrawal"],
  ] as const)
    app.get(`/sep6/${path}`, async (c) => {
      const input = z
        .object({
          quote_id: quoteId,
          account: z.string().optional(),
          amount,
          source_asset: z.string(),
          destination_asset: z.string(),
          funding_method: z.literal("bank_account").optional(),
          type: z.literal("bank_account").optional(),
          bank_destination: z
            .string()
            .regex(/^demo:[A-Za-z0-9_-]{1,64}$/)
            .optional(),
          lang: z.string().max(35).optional(),
          claimable_balance_supported: z.enum(["true", "false"]).optional(),
        })
        .strict()
        .refine((value) => !!value.funding_method || !!value.type)
        .parse(c.req.query());
      if (
        input.source_asset !==
          (direction === "deposit" ? "iso4217:TRY" : deps.cfg.usdcCode) ||
        input.destination_asset !==
          (direction === "deposit" ? deps.cfg.usdcCode : "iso4217:TRY")
      )
        throw new ApiError(
          400,
          "invalid_asset",
          "The exchange asset pair does not match this Testnet anchor."
        );
      const requireEligibility = async () => {
        if ((await engine.customer(c.get("sepSub"))).status !== "ACCEPTED")
          throw new ApiError(
            403,
            "native_eligibility_required",
            "First-time or expired eligibility must be verified through the separately advertised SEP-24 hosted flow. Programmatic SEP-6 requires a current native grant; no automatic popup is provided."
          );
      };
      await requireEligibility();
      const created = await engine.begin(
        c.get("sepSub"),
        c.get("sepCustomer").id,
        "sep6",
        direction,
        input
      );
      await requireEligibility();
      const view = await engine.accept(
        c.get("sepSub"),
        created.id,
        input.quote_id,
        input.bank_destination
      );
      return c.json({
        id: view.id,
        ...(direction === "deposit"
          ? {
              how: "Use these simulated bank instructions only while the exact transaction is ready for payment. Status must be confirmed before proceeding.",
              instructions: view.instructions ?? {},
            }
          : {
              account_id: view.withdraw_anchor_account,
              memo_type: view.withdraw_memo_type,
              memo: view.withdraw_memo,
            }),
        status: view.status,
        more_info_url: `${deps.cfg.publicUrl}/sep24/interactive/${view.id}?token=${issue(view.id, c.get("sepSub"), "bootstrap")}`,
      });
    });
  async function checkCustomerContext(
    c: Context<SepEnv>,
    input: { type?: unknown; transaction_id?: unknown }
  ) {
    const type = z.enum(["sep6", "sep24"]).optional().parse(input.type);
    const transactionId = idSchema.optional().parse(input.transaction_id);
    if (transactionId) {
      if (!type)
        throw new ApiError(
          400,
          "customer_type_required",
          "Specify the customer type when referencing a transaction."
        );
      const transaction = await engine.get(c.get("sepSub"), transactionId);
      if (transaction.protocol !== type)
        throw new ApiError(
          400,
          "customer_type_mismatch",
          "The customer type does not match this transaction."
        );
    }
  }
  async function customer(c: Context<SepEnv>) {
    await checkCustomerContext(c, c.req.query());
    const account = c.req.query("account");
    const id = c.req.query("id");
    if (
      (account !== undefined && account !== c.get("sepSub")) ||
      (id !== undefined && id !== c.get("sepCustomer").id)
    )
      throw new ApiError(404, "customer_not_found", "Customer not found.");
    if (
      c.req.query("memo") !== undefined ||
      c.req.query("memo_type") !== undefined
    )
      throw new ApiError(
        400,
        "unsupported_account",
        "Shared-account memos are not supported by this profile."
      );
    const state = await engine.customer(c.get("sepSub"));
    return {
      id: c.get("sepCustomer").id,
      ...state,
      fields:
        state.status === "ACCEPTED"
          ? {}
          : {
              zkpassport_proof: {
                type: "binary",
                description:
                  "Custom synthetic proof upload. Generate it in the SEP-24 hosted flow; ordinary wallets do not generate ZKPassport proofs.",
                optional: false,
              },
            },
      message:
        state.status === "ACCEPTED"
          ? "The native Testnet document policy is currently satisfied. This is not production KYC approval."
          : "Complete the synthetic ZKPassport flow hosted by this anchor. No personal document data is requested.",
    };
  }
  app.get("/sep12/customer", async (c) => c.json(await customer(c)));
  app.put("/sep12/customer", async (c) => {
    const input = z
      .object({
        id: z.string().optional(),
        account: z.string().optional(),
        type: z.enum(["sep6", "sep24"]).optional(),
        transaction_id: idSchema.optional(),
        zkpassport_proof: z.unknown().optional(),
      })
      .strict()
      .parse(await body(c));
    if (
      (input.id !== undefined && input.id !== c.get("sepCustomer").id) ||
      (input.account !== undefined && input.account !== c.get("sepSub"))
    )
      throw new ApiError(404, "customer_not_found", "Customer not found.");
    await checkCustomerContext(c, input);
    if (input.zkpassport_proof === undefined)
      return c.json({ id: c.get("sepCustomer").id });
    if (!input.transaction_id)
      throw new ApiError(
        400,
        "transaction_required",
        "A custom native proof upload must reference the owned SEP transaction and its type."
      );
    let supplied = input.zkpassport_proof;
    if (supplied instanceof File) {
      if (supplied.size > 32000)
        throw new ApiError(
          400,
          "invalid_proof",
          "The proof upload is too large."
        );
      supplied = await supplied.text();
    }
    if (typeof supplied === "string") {
      try {
        supplied = JSON.parse(supplied);
      } catch {
        throw new ApiError(
          400,
          "invalid_proof",
          "Upload proof JSON, not an identity document."
        );
      }
    }
    const hex = z.string().regex(/^(?:[a-f0-9]{2})+$/);
    const proof = z
      .object({ proof: hex.max(22000), public_inputs: hex.max(2048) })
      .strict()
      .parse(supplied);
    await engine.submitProof(
      c.get("sepSub"),
      input.transaction_id,
      Buffer.from(proof.proof, "hex"),
      Buffer.from(proof.public_inputs, "hex")
    );
    return c.json(await customer(c));
  });
  app.get("/anchor", async (c) => {
    if (new URL(c.req.url).host !== host)
      return c.text("Use the configured anchor origin.", 403);
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Content-Type-Options", "nosniff");
    c.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self' https: wss:; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
    );
    return c.html(await assetText(assets, "/sep-anchor.html"));
  });
  return app;
}
