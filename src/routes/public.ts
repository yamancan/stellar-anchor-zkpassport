import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Networks } from "@stellar/stellar-sdk";
import type { AppEnv, Deps } from "../context.js";
import { fmtRate, fmtUsdc } from "../money.js";
import type { SepContext } from "../sepauth.js";
import {
  economicActionsEnabled,
  POLICY_PENDING_MESSAGE,
} from "../anchor-policy.js";

const PUBLIC_DIR = process.env.PUBLIC_DIR ?? join(process.cwd(), "public");
const page = (name: string) => readFileSync(join(PUBLIC_DIR, name), "utf8");

export function publicRoutes(deps: Deps, sep: SepContext) {
  const { cfg, stellar, rates } = deps;
  const app = new Hono<AppEnv>();
  const legacy = economicActionsEnabled(cfg);
  const nativeGateConfigured =
    !legacy && cfg.networkPassphrase === Networks.TESTNET && !!deps.anchorGate;
  const sepGateConfigured =
    !legacy &&
    cfg.networkPassphrase === Networks.TESTNET &&
    !!deps.sepAnchorGateway;
  const strictPolicyMessage = sepGateConfigured
    ? "SEP-24 hosts synthetic phone verification; SEP-6 exchange transfers require confirmed native eligibility. Standard payment-and-memo custody is observed by the anchor. Legacy ungated payouts stay disabled."
    : nativeGateConfigured
      ? "Legacy economic routes remain disabled. The native Testnet gate is configured; each order still requires its own proof, wallet authorization, and mock-bank receipt."
      : POLICY_PENDING_MESSAGE;

  if (!legacy) {
    const title = sepGateConfigured
      ? "TR Anchor - native proof-gated SEP demo"
      : nativeGateConfigured
        ? "ZKPassport native gate Testnet demo"
        : "ZKPassport anchor diagnostics";
    const notice =
      nativeGateConfigured || sepGateConfigured
        ? "Use test assets only. TRY bank transfers and document identities are simulated. No real fiat moves."
        : "Do not send funds. Deposits, withdrawals, bank simulation, and payout processing are disabled.";
    const gateLinks = sepGateConfigured
      ? '<p><a href="/anchor">Open the standard-wallet anchor demo</a> | <a href="/sep24/info">SEP-24 capabilities and native policy</a></p><p>Classic G accounts only. SEP-24 is required for first-time phone onboarding. This experimental profile is not a universal wallet conformance claim.</p>'
      : nativeGateConfigured
        ? '<p><a href="/anchor-gate">Proof-gated deposit and withdrawal demo</a> | <a href="/anchor-gate/info">Native gate configuration and policy</a></p>'
        : "";
    const diagnosticPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head><body><main><h1>${title}</h1><p>${strictPolicyMessage}</p><p>${notice} ${sepGateConfigured ? "SEP-12 reflects a confirmed, unexpired native eligibility grant." : "SEP-12 does not grant KYC approval."}</p><p>A mathematically valid proof alone does not authorize a customer or transaction. This is not a production or mainnet financial service.</p>${gateLinks}<p><a href="/zkpassport/info">Native verifier diagnostic information</a></p><p><a href="/health">Service health</a> | <a href="/.well-known/stellar.toml">SEP-1 discovery</a> | <a href="/sep6/info">Current SEP-6 capabilities</a></p></main></body></html>`;
    for (const path of ["/", "/sep", "/explorer", "/guide", "/mainnet"]) {
      app.get(path, (c) =>
        path === "/" && sepGateConfigured
          ? c.redirect("/anchor", 302)
          : c.html(diagnosticPage)
      );
    }
    const diagnosticReference = [
      `# ${title}`,
      "",
      strictPolicyMessage,
      notice,
      sepGateConfigured
        ? "SEP-12 reflects current native eligibility, not production identity or compliance approval."
        : "SEP-12 remains pending; proof validity alone is not KYC or transaction authorization.",
      "This service is not production-ready and provides no mainnet payout workflow.",
      "",
      `Base URL: ${cfg.publicUrl}`,
      ...(sepGateConfigured
        ? [
            `- SEP-24 hosted demo: ${cfg.publicUrl}/anchor`,
            `- SEP-24 capabilities: ${cfg.publicUrl}/sep24/info`,
          ]
        : []),
      ...(nativeGateConfigured
        ? [
            `- Proof-gated deposit and withdrawal demo: ${cfg.publicUrl}/anchor-gate`,
            `- Native gate configuration and policy: ${cfg.publicUrl}/anchor-gate/info`,
          ]
        : []),
      `- Native verifier diagnostic information: ${cfg.publicUrl}/zkpassport/info`,
      `- Service health: ${cfg.publicUrl}/health`,
      `- SEP-1 discovery: ${cfg.publicUrl}/.well-known/stellar.toml`,
      `- Current SEP-6 capabilities: ${cfg.publicUrl}/sep6/info`,
      `- Authenticated transaction history: ${cfg.publicUrl}/sep6/transactions`,
      "Pending transactions are held. Historical completed/error records remain available.",
      "",
    ].join("\n");
    for (const path of ["/llms.txt", "/llms-full.txt", "/sitemap.md"]) {
      app.get(path, (c) =>
        c.text(diagnosticReference, 200, {
          "content-type": path.endsWith(".md")
            ? "text/markdown; charset=utf-8"
            : "text/plain; charset=utf-8",
          "access-control-allow-origin": "*",
        })
      );
    }
  }

  app.get("/", (c) => c.html(page("index.html")));
  app.get("/sep", (c) => c.html(page("sep.html")));
  app.get("/explorer", (c) => c.html(page("explorer.html")));
  app.get("/guide", (c) => c.html(page("guide.html")));
  app.get("/mainnet", (c) => c.html(page("mainnet.html")));

  const PAGES: Array<[string, string, string]> = [
    [
      "/",
      "Home",
      "What this is: a SEP-6 mock anchor for a Turkish TRY <-> USDC ramp on Stellar testnet. Two values to integrate: a home domain and the USDC asset.",
    ],
    [
      "/sep",
      "The SEP path (start here)",
      "The full integration guide: standard SEP-1/10/6/12/38 over one home domain + asset, with copyable requests. Integrate once on testnet, ship to any real SEP anchor by changing only the network and home domain.",
    ],
    [
      "/explorer",
      "SEP demo (interactive)",
      "Run the SEP door live in your browser - SEP-1 discovery, SEP-10 key-signature login, SEP-6 deposit and withdraw against this anchor, with real testnet transactions and no API key.",
    ],
    [
      "/guide",
      "Guide",
      "Concepts, Turkish rails (IBAN, FAST, aciklama), the SEP-6 flow, simulated KYC, statuses, testing with wallets, glossary (TR/EN).",
    ],
    [
      "/mainnet",
      "Mainnet: what to expect",
      "What carries over and what changes moving from this sandbox to a production SEP anchor.",
    ],
  ];
  const MACHINE: Array<[string, string]> = [
    ["/llms.txt", "Concise machine index of this anchor (this file)."],
    [
      "/llms-full.txt",
      "Full text: the SEP flow, statuses, pricing, mainnet notes - one document.",
    ],
    ["/sitemap.md", "Human- and AI-readable Markdown sitemap."],
    ["/sitemap.xml", "XML sitemap for crawlers."],
    [
      "/health",
      "Service, treasury balance, live rates, SEP endpoints, limits (JSON).",
    ],
    [
      "/.well-known/stellar.toml",
      "SEP-1 metadata (SIGNING_KEY, TRANSFER_SERVER, WEB_AUTH_ENDPOINT, KYC_SERVER, ANCHOR_QUOTE_SERVER).",
    ],
  ];

  app.get("/sitemap.md", (c) =>
    c.text(
      [
        "# TR Mock Anchor - Sitemap",
        "",
        `> A SEP-6 mock anchor for a Turkish TRY <-> USDC ramp on Stellar testnet. One standard door: SEP-1 / SEP-10 / SEP-6 / SEP-12 / SEP-38. Base URL: ${cfg.publicUrl}`,
        "",
        "If you are an AI reading this: fetch `/llms-full.txt` for the complete reference in one request, and `/.well-known/stellar.toml` for the SEP-1 metadata.",
        "",
        "## Pages",
        ...PAGES.map(([p, t, d]) => `- [${t}](${cfg.publicUrl}${p}) - ${d}`),
        "",
        "## Machine-readable",
        ...MACHINE.map(
          ([p, d]) => `- [${cfg.publicUrl}${p}](${cfg.publicUrl}${p}) - ${d}`
        ),
        "",
      ].join("\n"),
      200,
      {
        "content-type": "text/markdown; charset=utf-8",
        "access-control-allow-origin": "*",
      }
    )
  );

  app.get("/sitemap.xml", (c) => {
    const urls = PAGES.map(([p]) => p).concat(MACHINE.map(([p]) => p));
    return c.text(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
        urls
          .map((u) => `  <url><loc>${cfg.publicUrl}${u}</loc></url>`)
          .join("\n") +
        `\n</urlset>\n`,
      200,
      {
        "content-type": "application/xml; charset=utf-8",
        "access-control-allow-origin": "*",
      }
    );
  });

  app.get("/llms-full.txt", async (c) => {
    const [buy, sell] = await Promise.all([
      rates.quote("buy"),
      rates.quote("sell"),
    ]);
    return c.text(
      [
        "# TR Mock Anchor - full reference",
        `Base URL: ${cfg.publicUrl}`,
        "",
        "A SEP-6 mock anchor for a Turkish TRY <-> USDC ramp on Stellar testnet, for builders integrating a TRY ramp before a production anchor exists.",
        "One standard door: SEP-1 discovery, SEP-10 auth, SEP-6 deposit/withdraw, SEP-12 (simulated) KYC, SEP-38 quotes (TRY <-> USDC). The bank and KYC are simulated; the Stellar leg is real testnet USDC.",
        "The whole integration handoff is two values: a home domain and an asset. Everything else is discovered from stellar.toml. Integrate once here, then move to any real SEP anchor by changing only the network and home domain.",
        `Asset: ${stellar.assetCode}:${stellar.assetIssuer}. Treasury: ${stellar.treasuryPublicKey}.`,
        `Rates: USD/TRY from Reflector oracle + ${buy.spreadBps} bps spread (buy ${fmtRate(buy.rateMicro)}, sell ${fmtRate(sell.rateMicro)}). Amounts are decimal strings (TRY 2dp, USDC 7dp).`,
        Number(cfg.maxOnrampTry) > 0 || Number(cfg.minOnrampTry) > 0
          ? `Limits: ${cfg.minOnrampTry || "0"} - ${cfg.maxOnrampTry || "no max"} TRY per deposit; min off-ramp ${Number(cfg.minOfframpUsdc) > 0 ? cfg.minOfframpUsdc + " USDC" : "none"}.`
          : "Limits: no per-transaction limits (testnet sandbox).",
        "",
        "## SEP flow (end to end)",
        "1. SEP-1: GET /.well-known/stellar.toml -> WEB_AUTH_ENDPOINT (/auth), TRANSFER_SERVER (/sep6), KYC_SERVER (/sep12), SIGNING_KEY, the USDC currency.",
        "2. SEP-10: GET /auth?account=G... -> a challenge transaction; sign it with the user key; POST /auth {transaction} -> { token } (JWT). Send it as Authorization: Bearer <token>.",
        "3. SEP-6 /sep6/info -> capabilities (deposit/withdraw USDC, fee, min/max).",
        "4. SEP-6 deposit: GET /sep6/deposit?asset_code=USDC&account=G...&amount=... -> order id + bank instructions (IBAN + reference).",
        '5. Simulate the bank (sandbox): POST /sep6/tx/{id}/simulate-bank-transfer {"amount":"..."} (or press the button on the transaction more_info_url). The anchor then pays real testnet USDC (a payment, or a claimable balance / pending_trust if the account has no USDC trustline).',
        "6. Poll: GET /sep6/transaction?id={id} until status=completed.",
        "7. SEP-6 withdraw: GET /sep6/withdraw?asset_code=USDC&type=bank_account&amount=... -> treasury account_id + memo (type id). Send that USDC on-chain with the memo; the anchor detects it and pays TRY (simulated FAST).",
        "8. History: GET /sep6/transactions?asset_code=USDC and GET /sep6/transaction?id=|stellar_transaction_id=|external_transaction_id=.",
        "SEP-12 KYC is simulated: a wallet user is auto-approved, no personal data is required or stored. SEP-38 gives firm TRY<->USDC quotes (/sep38/{info,prices,price,quote}); SEP-6 deposit-exchange/withdraw-exchange lock a quote_id.",
        "",
        "## Statuses",
        "SEP-6 deposit: pending_user_transfer_start -> pending_anchor -> completed. pending_trust while waiting for a USDC trustline (when the wallet did not opt into claimable balances). error on failure.",
        "SEP-6 withdrawal: pending_user_transfer_start -> completed (once the USDC payment is detected and TRY is paid out).",
        "",
        "## Errors",
        'JSON {"error": "..."} on the SEP endpoints. SEP-10 verification failures return 400. Common SEP-6 errors: unsupported asset_code, amount below/above the limits, missing/!bank_account funding_method.',
        "",
        "## What changes on mainnet",
        "The SEP endpoints and your integration code do not change; you switch the network passphrase to public and the home domain to the real anchor. The one dependency: the mainnet anchor must implement SEP-6. Mainnet USDC issuer is GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN. Real bank transfer and real KYC replace the simulated ones. See /mainnet.",
        "",
      ].join("\n"),
      200,
      {
        "content-type": "text/plain; charset=utf-8",
        "access-control-allow-origin": "*",
      }
    );
  });

  app.get("/health", async (c) => {
    const [bal, buy, sell] = await Promise.all([
      stellar.treasuryUsdcBalance().catch(() => null),
      rates.quote("buy"),
      rates.quote("sell"),
    ]);
    return c.json({
      ok: true,
      service: "tr-mock-anchor",
      environment: "sandbox",
      anchor_mode: cfg.anchorMode,
      diagnostic_only: !legacy && !nativeGateConfigured && !sepGateConfigured,
      native_sep_configured: sepGateConfigured,
      native_gate_configured: nativeGateConfigured,
      native_gate: nativeGateConfigured
        ? {
            app_url: `${cfg.publicUrl}/anchor-gate`,
            info_url: `${cfg.publicUrl}/anchor-gate/info`,
          }
        : null,
      payout_authorized: legacy,
      policy_message: legacy
        ? "Legacy sandbox payout processing is enabled, subject to normal per-order checks. No ZKPassport eligibility policy is enforced."
        : strictPolicyMessage,
      stellar_mode: stellar.mode,
      network_passphrase: cfg.networkPassphrase,
      horizon_url: cfg.horizonUrl,
      asset: { code: stellar.assetCode, issuer: stellar.assetIssuer },
      sep: {
        signing_key: sep.signingKeypair.publicKey(),
        web_auth_endpoint: `${cfg.publicUrl}/auth`,
        transfer_server: `${cfg.publicUrl}/sep6`,
        ...(sepGateConfigured
          ? { transfer_server_sep0024: `${cfg.publicUrl}/sep24` }
          : {}),
        kyc_server: `${cfg.publicUrl}/sep12`,
        anchor_quote_server: `${cfg.publicUrl}/sep38`,
      },
      treasury: {
        address: stellar.treasuryPublicKey,
        usdc_balance: bal === null ? null : fmtUsdc(bal),
        low_balance: bal === null ? null : bal < 100_0000000n,
      },
      rates: {
        pair: "USDC/TRY",
        mid_rate: fmtRate(buy.mid.midMicro),
        buy_rate: fmtRate(buy.rateMicro),
        sell_rate: fmtRate(sell.rateMicro),
        spread_bps: buy.spreadBps,
        source: buy.mid.source,
      },
      limits: {
        min_onramp_try: Number(cfg.minOnrampTry) > 0 ? cfg.minOnrampTry : null,
        max_onramp_try: Number(cfg.maxOnrampTry) > 0 ? cfg.maxOnrampTry : null,
        min_offramp_usdc:
          Number(cfg.minOfframpUsdc) > 0 ? cfg.minOfframpUsdc : null,
      },
      time: new Date().toISOString(),
    });
  });

  app.get("/llms.txt", (c) =>
    c.text(
      [
        "# TR Mock Anchor (Stellar testnet sandbox)",
        "",
        "> A SEP-6 mock anchor for a Turkish TRY <-> USDC ramp on Stellar testnet. It models how Turkish exchanges ramp: bank transfer with a reference code -> TRY balance -> convert to USDC at USD/TRY -> USDC paid to the wallet (off-ramp is the reverse). Nothing here is a real financial service.",
        "",
        "> One standard door. It speaks SEP-1 / SEP-10 / SEP-6 / SEP-12 / SEP-38 - the surface a real Turkish anchor (BiLira) will expose. An integration built here moves to production by changing only the network and the home domain. There is no bespoke API: the whole handoff is a home domain + the USDC asset.",
        "",
        `- Base URL: ${cfg.publicUrl}`,
        `- THE SEP PATH (start here - the portable way, full guide): ${cfg.publicUrl}/sep`,
        `- Full reference in one document: ${cfg.publicUrl}/llms-full.txt`,
        `- Sitemap (Markdown): ${cfg.publicUrl}/sitemap.md`,
        `- Guide (concepts, Turkish rails, flows, statuses, glossary): ${cfg.publicUrl}/guide`,
        `- Mainnet expectations (what carries over, what changes): ${cfg.publicUrl}/mainnet`,
        `- SEP demo (run the SEP door live in your browser, no wallet app, no API key): ${cfg.publicUrl}/explorer`,
        `- Health, treasury, live rates, limits: ${cfg.publicUrl}/health`,
        `- Stellar: testnet, asset ${stellar.assetCode}:${stellar.assetIssuer}, treasury ${stellar.treasuryPublicKey}`,
        "",
        "## Integrate (two values + the standard)",
        `- Home domain: ${new URL(cfg.publicUrl).host}   Asset: ${stellar.assetCode}`,
        `- SEP-1: ${cfg.publicUrl}/.well-known/stellar.toml (TRANSFER_SERVER, WEB_AUTH_ENDPOINT, KYC_SERVER, SIGNING_KEY, USDC currency)`,
        `- SEP-10: GET/POST ${cfg.publicUrl}/auth -> JWT (sign a challenge with the user's Stellar key)`,
        `- SEP-6: ${cfg.publicUrl}/sep6/{info,deposit,withdraw,deposit-exchange,withdraw-exchange,transactions,transaction}. Deposit -> bank details + reference; simulate the TRY arrival at more_info_url. Withdraw -> treasury account + memo id; pay real testnet USDC.`,
        `- SEP-12: ${cfg.publicUrl}/sep12/customer (simulated KYC, no personal data required, auto-approved)`,
        `- SEP-38: ${cfg.publicUrl}/sep38/{info,prices,price,quote} (TRY <-> USDC quotes; SEP-6 deposit-exchange/withdraw-exchange consume quote_id)`,
        "- Tooling: any SEP-capable wallet, demo-wallet.stellar.org (enter the home domain), or @stellar/typescript-wallet-sdk.",
      ].join("\n")
    )
  );

  app.get("/.well-known/stellar.toml", (c) =>
    c.text(
      [
        'VERSION="2.7.0"',
        `NETWORK_PASSPHRASE="${cfg.networkPassphrase}"`,
        `SIGNING_KEY="${sep.signingKeypair.publicKey()}"`,
        `WEB_AUTH_ENDPOINT="${cfg.publicUrl}/auth"`,
        `TRANSFER_SERVER="${cfg.publicUrl}/sep6"`,
        ...(sepGateConfigured
          ? [`TRANSFER_SERVER_SEP0024="${cfg.publicUrl}/sep24"`]
          : []),
        `KYC_SERVER="${cfg.publicUrl}/sep12"`,
        `ANCHOR_QUOTE_SERVER="${cfg.publicUrl}/sep38"`,
        `ACCOUNTS=["${sepGateConfigured && deps.sepAnchorIngress ? deps.sepAnchorIngress.account : stellar.treasuryPublicKey}", "${sep.signingKeypair.publicKey()}"]`,
        "",
        "[DOCUMENTATION]",
        'ORG_NAME="Pre-KYC Anchor (testnet sandbox)"',
        `ORG_URL="${cfg.publicUrl}"`,
        legacy
          ? 'ORG_DESCRIPTION="Mock Turkish TRY <-> USDC SEP-6 anchor for Stellar testnet builders. Not a real financial service. No real money moves."'
          : sepGateConfigured
            ? 'ORG_DESCRIPTION="Experimental Testnet anchor with native eligibility, SEP-24 synthetic phone onboarding and SEP-6 exchange transfers. Classic G accounts; simulated TRY and mock USDC. No real money moves."'
            : 'ORG_DESCRIPTION="Experimental Testnet anchor with SEP-10 login, SEP-38 quotes and custom proof-gated settlement. Legacy SEP-6 transfers are disabled; this is not a portable SEP-6 ramp. No real money moves."',
        "",
        "[[CURRENCIES]]",
        `code="${stellar.assetCode}"`,
        `issuer="${stellar.assetIssuer}"`,
        'status="test"',
        "display_decimals=2",
        "is_asset_anchored=true",
        'anchor_asset_type="fiat"',
        'anchor_asset="TRY"',
        legacy
          ? 'desc="USDC on Stellar testnet (Circle testnet issuer unless overridden). This anchor ramps it against TRY via SEP-6."'
          : sepGateConfigured
            ? 'desc="Mock USDC exchanged for simulated TRY through native proof-gated settlement. Use SEP-24 for first-time eligibility and SEP-6 exchange transfers for accepted customers. Verify this exact issuer."'
            : 'desc="Configured Testnet issuer asset exchanged for simulated TRY through a separately configured proof-gated vault. Check the exact issuer and /anchor-gate/info; an asset code alone does not establish the issuer."',
        "",
      ].join("\n"),
      200,
      {
        "content-type": "text/plain; charset=utf-8",
        "access-control-allow-origin": "*",
      }
    )
  );

  return app;
}
