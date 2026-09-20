import {
  getAddress,
  getNetworkDetails,
  isConnected,
  requestAccess,
  signTransaction,
} from "@stellar/freighter-api";
import {
  Account,
  Asset,
  Memo,
  Networks,
  Operation,
  StrKey,
  Transaction,
  TransactionBuilder,
  WebAuth,
  xdr,
} from "@stellar/stellar-sdk";
import { ZKPassport, VERSION } from "@zkpassport/sdk";
import { countryCodeAlpha3ToName } from "@zkpassport/utils";
import QRCode from "qrcode";
import { z } from "zod";
import { createTestnetWalletSetup } from "./anchor-wallet-setup.js";
import type { GateWallet } from "./anchor-gate-flow.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const policySchema = z.object({
  min_age: z.number().int().min(1).max(99),
  allowed_nationalities: z.array(z.string().regex(/^[A-Z]{3}$/)).max(10),
  allowed_issuers: z.array(z.string().regex(/^[A-Z]{3}$/)).max(10),
  mock_only: z.literal(true),
  max_proof_age: z.number().int().positive().max(86400),
  verifier_vk_hash: hash,
  sanctions: z.object({ root: hash, strict: z.boolean() }).optional(),
});
const infoSchema = z.object({
  network: z.literal("testnet"),
  network_passphrase: z.literal(Networks.TESTNET),
  asset: z.object({
    code: z.string(),
    issuer: z.string(),
    contract: z.string(),
  }),
  config: z.object({
    contract: z.string(),
    domain: z.string(),
    scope: z.string(),
    policy: policySchema,
    proof_bytes: z.number().int(),
    external_inputs: z.number().int(),
    policy_valid_until: z.number().int(),
  }),
});
const transactionSchema = z.object({
  id: hash,
  kind: z.enum(["deposit", "withdrawal"]),
  status: z.string(),
  wallet: z.string(),
  quote_id: z.string().nullable(),
  amount_in: z.string().nullable(),
  amount_out: z.string().nullable(),
  amount_in_asset: z.string(),
  amount_out_asset: z.string(),
  to: z.string().nullable().optional(),
  message: z.string(),
  policy: policySchema,
  native: z.object({
    eligible: z.boolean(),
    valid_until: z.number().nullable(),
    confirmed_ledger: z.number().nullable(),
  }),
  ready_for_payment: z.boolean(),
  recovery_required: z.boolean(),
  payment_recovery_required: z.boolean().optional(),
  requested_amount: z.string().nullable().optional(),
  requested_quote_id: z.string().nullable().optional(),
  escrowed: z.boolean().optional(),
  payout_authorized: z.boolean().optional(),
  can_refund: z.boolean().optional(),
  withdraw_anchor_account: z.string().nullable(),
  withdraw_memo: z.string().nullable(),
  withdraw_memo_type: z.string().nullable(),
  actions: z.array(
    z.object({
      kind: z.string(),
      transaction_hash: hash,
      status: z.string(),
      ledger: z.number().nullable(),
    })
  ),
});
const quoteSchema = z.object({
  id: z.string(),
  sell_amount: z.string(),
  sell_asset: z.string(),
  buy_amount: z.string(),
  buy_asset: z.string(),
  expires_at: z.string(),
  fee: z.object({ total: z.string(), asset: z.string() }),
});
type TransactionView = z.infer<typeof transactionSchema>;
type Quote = z.infer<typeof quoteSchema>;
type Acceptance = {
  quoteId: string;
  bankDestination: string | undefined;
  afterSequence: number;
};
const element = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const show = (id: string, visible: boolean) => {
  element(id).hidden = !visible;
};
const text = (id: string, value: string) => {
  element(id).textContent = value;
};
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const id = /^\/sep24\/interactive\/([a-f0-9]{64})$/.exec(
  location.pathname
)?.[1];
const resume = hash.safeParse(
  new URLSearchParams(location.search).get("resume")
);
const base = id ? `/sep24/interactive/${id}` : "";
let info: z.infer<typeof infoSchema>;
let transaction: TransactionView | undefined;
let quote: Quote | undefined;
let csrf = "";
let busy = false;
let closed = false;
let direction: "deposit" | "withdrawal" = "deposit";
let address = "";
let token = "";
let client: ZKPassport | undefined;
let phoneEpoch = 0;
let phoneTimer: ReturnType<typeof setTimeout> | undefined;
let activePhone = false;
let proofReceived = false;
let prefetched = false;
let amountSide: "sell_amount" | "buy_amount" = "sell_amount";
let failures = 0;
let refreshSequence = 0;
let appliedRefreshSequence = 0;
let queuedProof: (() => Promise<void>) | undefined;
let uncertainAcceptance: Acceptance | undefined;
let confirmedPaymentHash: string | undefined;
let paymentMessage = "";
let paymentCheck: Promise<void> | undefined;
let problemSource:
  "action" | "acceptance" | "status" | "configuration" | undefined;

function problem(
  message = "",
  source: "action" | "acceptance" | "status" | "configuration" = "action"
) {
  problemSource = message ? source : undefined;
  text("problem", message);
  show("problem", !!message);
}
function status(message: string) {
  text("status", message);
}
class AnchorNetworkError extends Error {}
async function json(
  path: string,
  body?: unknown,
  bearer?: string
): Promise<unknown> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      ...(body === undefined
        ? {}
        : {
            "Content-Type": "application/json",
            ...(base ? { "X-CSRF-Token": csrf } : {}),
          }),
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
  }).catch(() => {
    throw new AnchorNetworkError(
      body === undefined
        ? "Connection interrupted while reading anchor status. Keep this order open."
        : "The anchor response was lost. This request may have reached the server. Keep this order open for reconciliation; do not send another payment."
    );
  });
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 403 && id) {
      element<HTMLAnchorElement>("resume-session").href =
        `/anchor?resume=${id}`;
      show("resume-session", true);
    }
    const error = z
      .object({
        error: z.union([z.string(), z.object({ message: z.string() })]),
      })
      .safeParse(value);
    throw new Error(
      error.success
        ? typeof error.data.error === "string"
          ? error.data.error
          : error.data.error.message
        : `Anchor request failed (${response.status}). Keep this order and reconcile before retrying.`
    );
  }
  return value;
}
async function action(work: () => Promise<void>) {
  if (busy) return;
  busy = true;
  problem();
  render();
  try {
    await work();
  } catch (error) {
    if (error instanceof AnchorNetworkError && pollingComplete()) problem();
    else
      problem(
        error instanceof Error
          ? error.message
          : "Request failed. Keep this order and reconcile before retrying."
      );
  } finally {
    busy = false;
    render();
    if (queuedProof && !closed) {
      const pending = queuedProof;
      queuedProof = undefined;
      void action(pending);
    }
  }
}
const unit = (asset: string) =>
  asset === "iso4217:TRY" ? "simulated TRY" : "mock USDC";
const actionLabels: Record<string, string> = {
  eligibility: "Proof verification",
  create: "Order creation",
  fund: "Withdrawal escrow",
  authorize: "Payout authorization",
  receipt: "Simulated TRY receipt",
  settle: "Token settlement",
  refund: "Token refund",
  cancel: "Reservation cancellation",
};
function cancelPhone(message?: string) {
  phoneEpoch++;
  clearTimeout(phoneTimer);
  client?.clearAllRequests();
  client = undefined;
  activePhone = false;
  show("phone", false);
  element<HTMLAnchorElement>("phone-link").removeAttribute("href");
  const canvas = element<HTMLCanvasElement>("qr");
  canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
  if (message) status(message);
}
function render() {
  document.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
    button.disabled = busy;
  });
  if (!transaction) return;
  const t = transaction;
  show("exchange", true);
  show("details", true);
  show("trustline-section", t.status === "pending_trust");
  show("extra-payment-warning", !!t.payment_recovery_required);
  const pendingPayment = sessionStorage.getItem(`sep-anchor-payment:${id}`);
  const submitted = hash.safeParse(
    pendingPayment ?? sessionStorage.getItem(`sep-anchor-failed-payment:${id}`)
  );
  text("payment-status", paymentMessage);
  show("payment-status", !!paymentMessage);
  text(
    "submitted-payment",
    pendingPayment
      ? confirmedPaymentHash === pendingPayment
        ? "Confirmed wallet payment"
        : "Check submitted wallet payment"
      : "Failed wallet payment (no tokens transferred)"
  );
  show("submitted-payment", submitted.success);
  if (submitted.success)
    element<HTMLAnchorElement>("submitted-payment").href =
      `https://stellar.expert/explorer/testnet/tx/${submitted.data}`;
  const ended = ["completed", "refunded", "expired"].includes(t.status);
  const held = !!t.escrowed || !!t.can_refund;
  const authorizedPayout = t.kind === "withdrawal" && !!t.payout_authorized;
  text(
    "direction",
    t.kind === "deposit" ? "DEPOSIT / TRY TO USDC" : "WITHDRAW / USDC TO TRY"
  );
  text("order-id", t.id);
  text("owner", t.wallet);
  const walletLink = element<HTMLAnchorElement>("wallet-explorer");
  const validWallet = StrKey.isValidEd25519PublicKey(t.wallet);
  if (validWallet)
    walletLink.href = `https://stellar.expert/explorer/testnet/account/${t.wallet}`;
  else walletLink.removeAttribute("href");
  show("wallet-explorer", validWallet);
  text(
    "eligibility",
    t.native.eligible
      ? `Confirmed on Testnet, valid until ${new Date(t.native.valid_until! * 1000).toLocaleTimeString()}`
      : "No current native eligibility"
  );
  text(
    "policy-summary",
    `Age ${t.policy.min_age}+, nationality ${t.policy.allowed_nationalities.join(", ") || "any"}, issuer ${t.policy.allowed_issuers.join(", ") || "any"}. Synthetic documents only.`
  );
  text(
    "full-policy",
    t.policy.sanctions
      ? `Sanctions: strict=${t.policy.sanctions.strict}. Pinned combined US/UK/EU/Swiss snapshot root ${t.policy.sanctions.root}. This is not current sanctions clearance.`
      : "No private sanctions predicate is enabled in this policy. A wallet-address precheck is a separate check."
  );
  const evidence = element("evidence");
  evidence.replaceChildren();
  const stages = new Set([
    "eligibility",
    "create",
    ...(t.kind === "withdrawal" ? ["fund", "authorize"] : []),
    "receipt",
    "settle",
    ...t.actions.map((entry) => entry.kind),
  ]);
  for (const stage of stages) {
    const entries = t.actions.filter((entry) => entry.kind === stage);
    if (!entries.length) {
      const item = document.createElement("li");
      item.textContent = `${actionLabels[stage] ?? stage}: ${stage === "eligibility" && t.native.eligible ? "Confirmed (reused eligibility)" : "Not submitted"}`;
      evidence.append(item);
    }
    for (const entry of entries) {
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.href = `https://stellar.expert/explorer/testnet/tx/${entry.transaction_hash}`;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      const confirmed = entry.status === "success" && (entry.ledger ?? 0) > 0;
      const label = confirmed
        ? "Confirmed"
        : entry.status === "failed"
          ? "Failed"
          : "Pending confirmation";
      item.className = confirmed
        ? "chain-confirmed"
        : entry.status === "failed"
          ? "chain-failed"
          : "";
      link.textContent = `${actionLabels[entry.kind] ?? entry.kind}: ${label}${confirmed ? ` / ledger ${entry.ledger}` : ""}`;
      item.append(link);
      evidence.append(item);
    }
  }
  show("amount-section", !t.quote_id && !quote);
  show("quote-section", !t.quote_id && !!quote);
  show("destination-section", t.kind === "withdrawal");
  show(
    "proof-section",
    !!t.quote_id && !t.native.eligible && !ended && !authorizedPayout
  );
  show(
    "finish-section",
    !!t.quote_id && (t.native.eligible || held || authorizedPayout || ended)
  );
  show("payment-instructions", t.kind === "withdrawal" && t.ready_for_payment);
  show(
    "send-payment",
    t.kind === "withdrawal" &&
      t.ready_for_payment &&
      sessionStorage.getItem(`sep-anchor-launcher:${id}`) === t.wallet
  );
  element<HTMLButtonElement>("send-payment").disabled =
    busy || !!sessionStorage.getItem(`sep-anchor-payment:${id}`);
  show(
    "mock-bank",
    !ended &&
      !t.recovery_required &&
      (t.kind === "deposit"
        ? t.ready_for_payment
        : t.native.eligible && !!t.escrowed && !t.payout_authorized)
  );
  show(
    "payout-warning",
    t.kind === "withdrawal" &&
      t.native.eligible &&
      !!t.escrowed &&
      !t.payout_authorized &&
      !ended
  );
  show("refund", !ended && !!t.can_refund);
  text(
    "refund",
    t.kind === "deposit"
      ? "Cancel unused reservation"
      : "Refund escrow before payout"
  );
  text(
    "mock-bank",
    t.kind === "deposit"
      ? "Simulate exact TRY deposit"
      : "Authorize simulated TRY payout"
  );
  element<HTMLInputElement>("payment-account").value =
    t.withdraw_anchor_account ?? "";
  element<HTMLInputElement>("payment-memo").value = t.withdraw_memo ?? "";
  text("amount-in", `${t.amount_in ?? "-"} ${unit(t.amount_in_asset)}`);
  text("amount-out", `${t.amount_out ?? "-"} ${unit(t.amount_out_asset)}`);
  text(
    "heading",
    ended
      ? t.status === "completed"
        ? "Exchange complete"
        : t.status === "refunded"
          ? "Refund confirmed"
          : "Order expired"
      : !t.quote_id
        ? "Review your exchange"
        : authorizedPayout
          ? "Completing authorized payout"
          : held && !t.native.eligible
            ? "Review held funds"
            : !t.native.eligible
              ? "Verify privately"
              : t.kind === "withdrawal" && t.ready_for_payment
                ? "Pay through your wallet"
                : "Finish your exchange"
  );
  text(
    "step",
    ended
      ? "CONFIRMED"
      : !t.quote_id
        ? "1 / AMOUNT"
        : !t.native.eligible && !held && !authorizedPayout
          ? "2 / VERIFY"
          : "3 / TRANSFER"
  );
  text(
    "next-action",
    authorizedPayout && !ended
      ? "Payout is already authorized. Receipt and settlement are reconciling automatically; no new proof or payment is needed."
      : held && !t.native.eligible && !ended && t.can_refund
        ? t.kind === "withdrawal"
          ? "Your tokens remain in escrow. Refund before payout authorization without a new proof, or refresh eligibility to continue if the order is still valid."
          : "The provider's tokens remain reserved. Cancel the unused reservation without a new proof, or refresh eligibility to continue if the order is still valid."
        : t.message
  );
  text(
    "prove",
    held ? "Refresh eligibility to continue" : "Verify with ZKPassport"
  );
  element<HTMLButtonElement>("prove").disabled =
    busy || activePhone || t.status === "pending_stellar";
  if (quote && !t.quote_id) {
    text("quote-in", `${quote.sell_amount} ${unit(quote.sell_asset)}`);
    text("quote-out", `${quote.buy_amount} ${unit(quote.buy_asset)}`);
    text("quote-fee", `${quote.fee.total} ${unit(quote.fee.asset)}`);
    text(
      "quote-expiry",
      `Quote valid until ${new Date(quote.expires_at).toLocaleTimeString()}. Acceptance fixes this order's amounts.`
    );
  }
}

const wallet: GateWallet = {
  async connect() {
    const ready = await isConnected();
    if (!ready.isConnected)
      throw new Error("Open this page in a browser with Freighter installed.");
    const result = await requestAccess();
    if (result.error || !result.address)
      throw new Error("Wallet connection declined.");
    return result.address;
  },
  async current() {
    const [account, network] = await Promise.all([
      getAddress(),
      getNetworkDetails(),
    ]);
    if (account.error || network.error)
      throw new Error("Unlock Freighter and select Testnet.");
    return { address: account.address, network: network.networkPassphrase };
  },
  async sign(xdr, account) {
    const result = await signTransaction(xdr, {
      address: account,
      networkPassphrase: Networks.TESTNET,
    });
    if (result.error || !result.signedTxXdr || result.signerAddress !== account)
      throw new Error("Wallet signing was not approved by this account.");
    return result.signedTxXdr;
  },
};
const setup = createTestnetWalletSetup({
  fetch: window.fetch.bind(window),
  wallet,
  changed: status,
});
async function sameWallet(expected: string) {
  const current = await wallet.current();
  if (current.address !== expected || current.network !== Networks.TESTNET)
    throw new Error("Keep this same wallet connected on Stellar Testnet.");
}
async function login() {
  token = "";
  address = await wallet.connect();
  await sameWallet(address);
  if (!StrKey.isValidEd25519PublicKey(address))
    throw new Error("This demo supports plain G accounts only.");
  await setup.ensureFunding(address);
  const toml = await (
    await fetch("/.well-known/stellar.toml", { cache: "no-store" })
  ).text();
  const field = (name: string) => {
    const values = [
      ...toml.matchAll(new RegExp(`^${name}="([^"\\r\\n]*)"\\s*$`, "gm")),
    ];
    if (values.length !== 1) throw new Error("Invalid anchor discovery.");
    return values[0]![1]!;
  };
  const signer = field("SIGNING_KEY");
  if (
    !StrKey.isValidEd25519PublicKey(signer) ||
    field("NETWORK_PASSPHRASE") !== Networks.TESTNET ||
    field("WEB_AUTH_ENDPOINT") !== `${location.origin}/auth`
  )
    throw new Error("Anchor discovery does not match this Testnet origin.");
  const challenge = z
    .object({
      transaction: z.string(),
      network_passphrase: z.literal(Networks.TESTNET),
    })
    .parse(await json(`/auth?account=${address}`));
  const checked = WebAuth.readChallengeTx(
    challenge.transaction,
    signer,
    Networks.TESTNET,
    location.host,
    location.host
  );
  if (
    checked.clientAccountID !== address ||
    checked.memo !== null ||
    checked.tx.operations.length !== 2
  )
    throw new Error("Unexpected login challenge.");
  await sameWallet(address);
  const signed = await wallet.sign(challenge.transaction, address);
  await sameWallet(address);
  if (
    hex(TransactionBuilder.fromXdr(signed, Networks.TESTNET).hash()) !==
    hex(checked.tx.hash())
  )
    throw new Error("Wallet changed the login challenge.");
  token = z
    .object({ token: z.string().min(1) })
    .parse(await json("/auth", { transaction: signed })).token;
  if (resume.success) {
    show("launch", true);
    status("Wallet login confirmed. Resume the original order.");
    return;
  }
  const readiness = await setup.inspect(address, info.asset);
  show("trustline", !readiness.trustline);
  show("launch", readiness.trustline && readiness.authorized);
  text(
    "wallet-description",
    `${address.slice(0, 8)}...${address.slice(-6)} / Testnet connected`
  );
  status(
    readiness.trustline
      ? "Wallet ready. Continue to the hosted exchange."
      : "Approve the mock-USDC trustline to receive demo tokens."
  );
}

async function refresh() {
  if (!id) return;
  const sequence = ++refreshSequence;
  const response = z
    .object({ transaction: transactionSchema, csrf_token: hash })
    .parse(await json(`${base}/state`));
  if (response.transaction.id !== id)
    throw new Error("The anchor returned a different order.");
  if (sequence < appliedRefreshSequence) return;
  appliedRefreshSequence = sequence;
  transaction = response.transaction;
  csrf = response.csrf_token;
  if (
    (transaction.native.eligible || transaction.payout_authorized) &&
    activePhone
  )
    cancelPhone();
  if (!prefetched) {
    if (transaction.kind === "withdrawal" && !transaction.requested_amount)
      element<HTMLInputElement>("amount").value = "1.0000000";
    if (transaction.requested_amount && !transaction.quote_id) {
      amountSide = "sell_amount";
      element<HTMLInputElement>("amount").value = transaction.requested_amount;
    }
    text(
      "amount-label",
      amountSide === "buy_amount"
        ? "Mock USDC to receive"
        : transaction.kind === "deposit"
          ? "Simulated TRY to deposit"
          : "Mock USDC to withdraw"
    );
    if (transaction.requested_quote_id && !transaction.quote_id) {
      quote = z
        .object({ quote: quoteSchema })
        .parse(
          await json(
            `${base}/quote?quote_id=${encodeURIComponent(transaction.requested_quote_id)}`
          )
        ).quote;
    }
    prefetched = true;
  }
  if (!activePhone)
    status(
      transaction.status === "completed"
        ? "Settlement confirmed on Stellar Testnet."
        : transaction.status === "refunded"
          ? "Refund confirmed on Stellar Testnet."
          : transaction.status === "pending_stellar"
            ? "Waiting for native Testnet confirmation. Keep this order open."
            : "Status updates automatically. No need to check manually."
    );
  if (
    problemSource === "acceptance" &&
    uncertainAcceptance &&
    acceptanceAcknowledged(uncertainAcceptance)
  ) {
    uncertainAcceptance = undefined;
    quote = undefined;
    problem();
  } else if (
    problemSource === "status" ||
    (problemSource !== "acceptance" && pollingComplete())
  )
    problem();
  await reconcilePayment();
  render();
}
function acceptanceAcknowledged(acceptance: Acceptance) {
  return (
    appliedRefreshSequence > acceptance.afterSequence &&
    transaction?.quote_id === acceptance.quoteId &&
    (acceptance.bankDestination === undefined ||
      transaction.to === acceptance.bankDestination)
  );
}
async function prove() {
  if (activePhone) return;
  const config = z
    .object({
      domain: z.string(),
      scope: z.string(),
      custom_data: hash,
      policy: policySchema,
      expires_at: z.number().int(),
      proof_bytes: z.number().int(),
      external_inputs: z.number().int(),
      dev_mode: z.literal(true),
      proof_type: z.literal("compressed-evm"),
      nullifier_type: z.literal(2),
    })
    .parse(await json(`${base}/proof-request`, {}));
  if (
    VERSION !== "0.17.1" ||
    config.domain !== location.hostname ||
    config.proof_bytes !== 10240 ||
    config.expires_at * 1000 <= Date.now()
  )
    throw new Error("Unsupported or expired synthetic proof request.");
  const count =
    10 +
    Number(config.policy.allowed_nationalities.length > 0) +
    Number(config.policy.allowed_issuers.length > 0) +
    Number(!!config.policy.sanctions);
  if (config.external_inputs !== count)
    throw new Error(
      "Native proof profile does not match the requested predicates."
    );
  cancelPhone();
  proofReceived = false;
  activePhone = true;
  const epoch = phoneEpoch;
  client = new ZKPassport(config.domain);
  phoneTimer = setTimeout(
    () => {
      cancelPhone("Phone request expired. Create a fresh request when ready.");
      render();
    },
    Math.min(600000, config.expires_at * 1000 - Date.now())
  );
  const current = client;
  const builder = await current.request({
    name: "Pre-KYC / Stellar anchor eligibility",
    purpose:
      "Synthetic age and country eligibility for a Testnet anchor. No real identity document or real money.",
    scope: config.scope,
    mode: "compressed-evm",
    devMode: true,
    validity: config.policy.max_proof_age,
    uniqueIdentifierType: 0,
    verifierMode: "local",
  });
  if (epoch !== phoneEpoch) {
    current.clearAllRequests();
    return;
  }
  const codes = (values: string[]) =>
    values.map((code) => {
      if (!/^[A-Z]{3}$/.test(code) || !countryCodeAlpha3ToName(code))
        throw new Error("Unsupported synthetic country.");
      return code as Parameters<typeof builder.in>[1][number];
    });
  builder.gte("age", config.policy.min_age);
  if (config.policy.allowed_nationalities.length)
    builder.in("nationality", codes(config.policy.allowed_nationalities));
  if (config.policy.allowed_issuers.length)
    builder.in("issuing_country", codes(config.policy.allowed_issuers));
  if (config.policy.sanctions)
    builder.sanctions("all", "all", { strict: config.policy.sanctions.strict });
  const request = builder.bind("custom_data", config.custom_data).done();
  const event = (message: string) => {
    if (epoch === phoneEpoch) {
      text("phone-status", message);
      status(message);
    }
  };
  request.onRequestReceived(() =>
    event("Phone connected. Review and approve the synthetic request.")
  );
  request.onGeneratingProof(() =>
    event(
      "Your phone is creating the proof. No payment or eligibility is approved yet."
    )
  );
  request.onError(() =>
    event(
      "The phone reported an error. Cancel this request before trying again."
    )
  );
  request.onReject(() => {
    if (epoch === phoneEpoch) {
      cancelPhone("Phone request declined. No approval.");
      render();
    }
  });
  request.onProofGenerated((proof) => {
    if (
      epoch !== phoneEpoch ||
      proofReceived ||
      !proof.name?.startsWith("outer")
    )
      return;
    proofReceived = true;
    const submitProof = async () => {
      if (epoch !== phoneEpoch || closed) return;
      cancelPhone();
      if (
        proof.version !== "0.20.0" ||
        proof.name !== `outer_evm_count_${config.external_inputs - 5}` ||
        proof.vkeyHash?.replace(/^0x/, "").toLowerCase() !==
          config.policy.verifier_vk_hash
      )
        throw new Error(
          "The phone produced an unsupported native proof profile."
        );
      if (typeof proof.proof !== "string")
        throw new Error("The phone did not return proof bytes.");
      const raw = proof.proof.replace(/^0x/, "").toLowerCase();
      if (
        !/^[a-f0-9]+$/.test(raw) ||
        raw.length !== (config.external_inputs * 32 + config.proof_bytes) * 2
      )
        throw new Error("Invalid proof encoding.");
      status(
        "Submitting the proof for native onchain verification. Please wait."
      );
      await json(`${base}/proof`, {
        proof: raw.slice(config.external_inputs * 64),
        public_inputs: raw.slice(0, config.external_inputs * 64),
      });
      await refresh();
    };
    if (busy) queuedProof = submitProof;
    else void action(submitProof);
  });
  const link = new URL(request.url);
  if (link.protocol !== "https:" || link.hostname !== "zkpassport.id")
    throw new Error("Unexpected phone link.");
  await QRCode.toCanvas(element<HTMLCanvasElement>("qr"), request.url, {
    width: 360,
    margin: 4,
    errorCorrectionLevel: "M",
  });
  if (epoch !== phoneEpoch) return;
  element<HTMLAnchorElement>("phone-link").href = request.url;
  show("phone", true);
  event("Scan in ZKPassport developer mode using a synthetic document.");
}

async function reconcilePayment() {
  if (paymentCheck) return paymentCheck;
  paymentCheck = checkPayment().finally(() => {
    paymentCheck = undefined;
  });
  return paymentCheck;
}

async function checkPayment() {
  const retained = sessionStorage.getItem(`sep-anchor-payment:${id}`);
  const t = transaction;
  if (!retained || !t || t.kind !== "withdrawal") return;
  if (confirmedPaymentHash === retained) return;
  paymentMessage =
    "The previous payment is being checked. Do not send another payment while its outcome is unknown.";
  try {
    if (!hash.safeParse(retained).success) return;
    const response = await fetch(
      `https://horizon-testnet.stellar.org/transactions/${retained}`,
      {
        cache: "no-store",
        signal: AbortSignal.timeout(10000),
      }
    );
    // A missing, expired or unreachable receipt is not proof of failure.
    if (!response.ok) return;
    const receipt = z
      .object({
        hash: z.literal(retained),
        successful: z.boolean(),
        ledger: z.number().int().positive(),
        envelope_xdr: z.string(),
        result_xdr: z.string(),
      })
      .parse(await response.json());
    const envelope = TransactionBuilder.fromXdr(
      receipt.envelope_xdr,
      Networks.TESTNET
    );
    if (!(envelope instanceof Transaction)) return;
    const operation = envelope.operations[0];
    const memo = envelope.memo.value;
    if (
      hex(envelope.hash()) !== retained ||
      envelope.source !== t.wallet ||
      envelope.operations.length !== 1 ||
      operation?.type !== "payment" ||
      (operation.source && operation.source !== t.wallet) ||
      operation.amount !== t.amount_in ||
      `stellar:${operation.asset.getCode()}:${operation.asset.getIssuer()}` !==
        t.amount_in_asset ||
      envelope.memo.type !== "hash" ||
      !(memo instanceof Uint8Array) ||
      hex(memo) !== id ||
      (t.withdraw_anchor_account &&
        operation.destination !== t.withdraw_anchor_account)
    )
      return;
    const result = xdr.TransactionResult.fromXdr(
      receipt.result_xdr,
      "base64"
    ).result;
    if (
      closed ||
      sessionStorage.getItem(`sep-anchor-payment:${id}`) !== retained
    )
      return;
    if (receipt.successful && result.type === "txSuccess") {
      confirmedPaymentHash = retained;
      paymentMessage =
        "Your wallet payment is confirmed. Do not pay again; this order will continue reconciling automatically.";
    } else if (!receipt.successful && result.type === "txFailed") {
      const operationResult = result.results[0];
      const reason =
        operationResult?.type === "opInner" &&
        operationResult.tr.type === "payment"
          ? operationResult.tr.paymentResult.type
          : "operationFailed";
      const description =
        reason === "paymentUnderfunded"
          ? "Insufficient balance for this demo token."
          : `Stellar rejected the payment (${reason}).`;
      // Keep the failed attempt visible; unlock only this exact confirmed failure.
      sessionStorage.setItem(`sep-anchor-failed-payment:${id}`, retained);
      sessionStorage.removeItem(`sep-anchor-payment:${id}`);
      paymentMessage = `${description} No tokens were transferred; only the network fee was charged. Correct the cause, then explicitly approve a new payment if this order is still ready.`;
    }
  } catch {
    // Fail closed: parsing errors and network failures must never unlock payment.
  }
}

async function sendPayment() {
  if (!info)
    throw new Error(
      "New payment configuration is unavailable. Keep this order and wait for recovery."
    );
  await refresh();
  const t = transaction;
  if (
    !t ||
    !t.ready_for_payment ||
    t.kind !== "withdrawal" ||
    !t.amount_in ||
    !t.withdraw_anchor_account ||
    !StrKey.isValidEd25519PublicKey(t.withdraw_anchor_account) ||
    t.withdraw_memo_type !== "hash" ||
    !t.withdraw_memo
  )
    throw new Error("Confirmed payment instructions are not ready.");
  if (sessionStorage.getItem(`sep-anchor-payment:${id}`))
    throw new Error(
      "A payment was already submitted or has an unknown outcome. Wait for reconciliation; do not send again."
    );
  await wallet.connect();
  await sameWallet(t.wallet);
  const account = z
    .object({
      account_id: z.literal(t.wallet),
      sequence: z.string().regex(/^\d+$/),
    })
    .parse(
      await (
        await fetch(`https://horizon-testnet.stellar.org/accounts/${t.wallet}`)
      ).json()
    );
  const memo = Uint8Array.from(atob(t.withdraw_memo), (c) => c.charCodeAt(0));
  if (memo.length !== 32) throw new Error("Invalid withdrawal memo.");
  const payment = new TransactionBuilder(
    new Account(t.wallet, account.sequence),
    { fee: "100", networkPassphrase: Networks.TESTNET }
  )
    .addOperation(
      Operation.payment({
        destination: t.withdraw_anchor_account,
        asset: new Asset(info.asset.code, info.asset.issuer),
        amount: t.amount_in,
      })
    )
    .addMemo(Memo.hash(memo))
    .setTimeout(180)
    .build();
  const signed = await wallet.sign(payment.toXdr(), t.wallet);
  await sameWallet(t.wallet);
  if (
    hex(TransactionBuilder.fromXdr(signed, Networks.TESTNET).hash()) !==
    hex(payment.hash())
  )
    throw new Error("Wallet changed the payment.");
  await refresh();
  if (
    Math.floor(Date.now() / 1000) >= Number(payment.timeBounds!.maxTime) ||
    !transaction?.ready_for_payment ||
    transaction.withdraw_anchor_account !== t.withdraw_anchor_account ||
    transaction.withdraw_memo !== t.withdraw_memo ||
    transaction.amount_in !== t.amount_in
  )
    throw new Error(
      "Payment instructions changed or expired while signing. Nothing was submitted. Review this same order."
    );
  sessionStorage.setItem(`sep-anchor-payment:${id}`, hex(payment.hash()));
  confirmedPaymentHash = undefined;
  paymentMessage =
    "Payment submitted; checking its outcome. Do not send another payment.";
  render();
  status(
    "Submitting one standard Testnet payment. Do not submit another while its outcome is unknown."
  );
  await fetch("https://horizon-testnet.stellar.org/transactions", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ tx: signed }),
    signal: AbortSignal.timeout(30000),
  }).catch(() => undefined);
  // HTTP failure (including a lost response) does not determine the ledger outcome.
  // Read the retained hash; the normal status poll keeps checking if still unknown.
  await reconcilePayment();
  await refresh();
}

element("connect").addEventListener("click", () => void action(login));
element("trustline").addEventListener(
  "click",
  () =>
    void action(async () => {
      await sameWallet(address);
      const ready = await setup.addTrustline(address, info.asset);
      show("trustline", !ready.trustline || !ready.authorized);
      show("launch", ready.trustline && ready.authorized && !ready.pending);
    })
);
element("order-trustline").addEventListener(
  "click",
  () =>
    void action(async () => {
      if (!transaction) throw new Error("Load the original order first.");
      if (!info) await loadInfo();
      await wallet.connect();
      await sameWallet(transaction.wallet);
      const ready = await setup.addTrustline(transaction.wallet, info.asset);
      if (!ready.trustline || !ready.authorized || ready.pending)
        status(
          "Trustline setup is not confirmed yet. Keep this order open for reconciliation."
        );
      await refresh();
    })
);
for (const [button, kind] of [
  ["deposit", "deposit"],
  ["withdraw", "withdrawal"],
] as const)
  element(button).addEventListener("click", () => {
    direction = kind;
    element("deposit").setAttribute("aria-pressed", String(kind === "deposit"));
    element("withdraw").setAttribute(
      "aria-pressed",
      String(kind === "withdrawal")
    );
  });
element("launch").addEventListener(
  "click",
  () =>
    void action(async () => {
      if (!token || !address)
        throw new Error("Sign in with your wallet first.");
      await sameWallet(address);
      const result = resume.success
        ? await (async () => {
            const value = z
              .object({
                transaction: z.object({ id: hash, more_info_url: z.string() }),
              })
              .parse(
                await json(
                  `/sep24/transaction?id=${resume.data}`,
                  undefined,
                  token
                )
              );
            if (value.transaction.id !== resume.data)
              throw new Error("The anchor returned a different order.");
            return {
              id: value.transaction.id,
              url: value.transaction.more_info_url,
            };
          })()
        : z
            .object({
              id: hash,
              url: z.string(),
              type: z.literal("interactive_customer_info_needed"),
            })
            .parse(
              await json(
                `/sep24/transactions/${direction === "deposit" ? "deposit" : "withdraw"}/interactive`,
                {
                  asset_code: info.asset.code,
                  asset_issuer: info.asset.issuer,
                  account: address,
                },
                token
              )
            );
      const target = new URL(result.url);
      if (
        target.origin !== location.origin ||
        target.pathname !== `/sep24/interactive/${result.id}`
      )
        throw new Error("Unexpected hosted exchange location.");
      sessionStorage.setItem(`sep-anchor-launcher:${result.id}`, address);
      token = "";
      location.assign(target.href);
    })
);
element("quote").addEventListener(
  "click",
  () =>
    void action(async () => {
      quote = z.object({ quote: quoteSchema }).parse(
        await json(`${base}/quote`, {
          [amountSide]: element<HTMLInputElement>("amount").value,
        })
      ).quote;
    })
);
element("change").addEventListener("click", () => {
  quote = undefined;
  render();
});
element("accept").addEventListener(
  "click",
  () =>
    void action(async () => {
      if (!quote) throw new Error("Get a quote first.");
      const acceptance: Acceptance = {
        quoteId: quote.id,
        bankDestination:
          transaction?.kind === "withdrawal"
            ? element<HTMLInputElement>("destination").value
            : undefined,
        afterSequence: appliedRefreshSequence,
      };
      try {
        await json(`${base}/accept`, {
          quote_id: acceptance.quoteId,
          ...(acceptance.bankDestination === undefined
            ? {}
            : { bank_destination: acceptance.bankDestination }),
        });
      } catch (error) {
        if (!(error instanceof AnchorNetworkError)) throw error;
        if (acceptanceAcknowledged(acceptance)) {
          uncertainAcceptance = undefined;
          quote = undefined;
        } else {
          uncertainAcceptance = acceptance;
          problem(error.message, "acceptance");
        }
        return;
      }
      uncertainAcceptance = undefined;
      quote = undefined;
      await refresh();
    })
);
element("prove").addEventListener(
  "click",
  () =>
    void action(async () => {
      try {
        await prove();
      } catch (error) {
        cancelPhone();
        throw error;
      }
    })
);
element("cancel-proof").addEventListener("click", () => {
  cancelPhone("Phone request cancelled. No new eligibility granted.");
  render();
});
element("mock-bank").addEventListener(
  "click",
  () =>
    void action(async () => {
      await json(`${base}/mock-bank`, {});
      await refresh();
    })
);
element("refund").addEventListener(
  "click",
  () =>
    void action(async () => {
      await json(`${base}/refund`, {});
      await refresh();
    })
);
element("send-payment").addEventListener(
  "click",
  () => void action(sendPayment)
);
window.addEventListener("pagehide", () => {
  closed = true;
  cancelPhone();
  token = "";
});
async function poll() {
  if (closed || !id || pollingComplete()) return;
  if (!busy)
    try {
      await refresh();
      failures = 0;
      if (!info && !pollingComplete()) await recoverConfiguration();
    } catch (error) {
      failures++;
      if (
        !(error instanceof AnchorNetworkError && pollingComplete()) &&
        (!problemSource || problemSource === "status")
      )
        problem(
          error instanceof AnchorNetworkError
            ? "Connection interrupted. Reconnecting to this same order automatically. Do not send another payment."
            : error instanceof Error
              ? error.message
              : "Status unavailable. Keep this order open.",
          "status"
        );
    }
  if (closed || pollingComplete()) return;
  setTimeout(
    () => void poll(),
    Math.min(30000, 2500 * 2 ** Math.min(failures, 3))
  );
}
function pollingComplete() {
  return (
    !!transaction &&
    ["completed", "refunded"].includes(transaction.status) &&
    !transaction.recovery_required &&
    !transaction.payment_recovery_required &&
    !transaction.actions.some((entry) =>
      ["prepared", "pending"].includes(entry.status)
    )
  );
}
async function loadInfo() {
  const candidate = infoSchema.parse(await json("/sep24/info"));
  if (
    !StrKey.isValidEd25519PublicKey(candidate.asset.issuer) ||
    !StrKey.isValidContract(candidate.config.contract) ||
    new Asset(candidate.asset.code, candidate.asset.issuer).contractId(
      Networks.TESTNET
    ) !== candidate.asset.contract ||
    candidate.config.domain !== location.hostname
  )
    throw new Error("The native policy does not match this Testnet anchor.");
  info = candidate;
}
async function recoverConfiguration() {
  try {
    await loadInfo();
    if (problemSource === "configuration") problem();
  } catch {
    if (problemSource !== "action" && problemSource !== "acceptance")
      problem(
        "New transfers are unavailable while the anchor configuration reconnects. This same order will continue reconciling.",
        "configuration"
      );
  }
}
async function loadLauncher() {
  if (closed) return;
  try {
    if (!resume.success) await loadInfo();
  } catch (error) {
    if (!(error instanceof AnchorNetworkError)) throw error;
    failures++;
    problem(
      "Connection interrupted. Reconnecting to the Testnet anchor automatically.",
      "configuration"
    );
    setTimeout(
      () => void action(loadLauncher),
      Math.min(30000, 2500 * 2 ** Math.min(failures - 1, 3))
    );
    return;
  }
  failures = 0;
  if (problemSource === "configuration") problem();
  show("launcher", true);
  if (resume.success) {
    show("direction-tabs", false);
    text("launch", "Resume this exact order");
    status(
      "Sign in with the original wallet. This will not create a replacement order."
    );
  } else
    status(
      "The demo can fund your wallet with Testnet XLM for network fees when needed."
    );
}
void action(async () => {
  if (id) {
    try {
      await refresh();
    } catch (error) {
      problem(
        error instanceof Error
          ? error.message
          : "Status unavailable. Reconnecting to this same order.",
        "status"
      );
    }
    if (!pollingComplete()) await recoverConfiguration();
    void poll();
  } else {
    await loadLauncher();
  }
});
