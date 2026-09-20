import { afterEach, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import {
  Account,
  Asset,
  Keypair,
  Memo,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

const orderId = "ab".repeat(32);
const wallet = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1)).publicKey();
const issuer = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2)).publicKey();
const token = new Asset("USDC", issuer).contractId(Networks.TESTNET);
const policy = {
  min_age: 18,
  allowed_nationalities: ["ZKR"],
  allowed_issuers: ["ZKR"],
  mock_only: true,
  max_proof_age: 600,
  verifier_vk_hash: "cd".repeat(32),
};

interface PageNode {
  tag: string;
  parent?: PageNode;
  hidden: boolean;
  disabled: boolean;
  textContent: string;
  value: string;
  href: string;
  children: PageNode[];
  addEventListener(name: string, callback: () => void): void;
  trigger(name: string): void;
  setAttribute(): void;
  removeAttribute(): void;
  replaceChildren(): void;
  append(...children: PageNode[]): void;
  getContext(): { clearRect(): void };
}
function node(tag: string, parent?: PageNode): PageNode {
  const events = new Map<string, () => void>();
  return {
    tag,
    parent,
    hidden: false,
    disabled: false,
    textContent: "",
    value: "",
    href: "",
    children: [],
    addEventListener(name: string, callback: () => void) {
      events.set(name, callback);
    },
    trigger(name: string) {
      events.get(name)?.();
    },
    setAttribute() {},
    removeAttribute() {},
    replaceChildren() {
      this.children = [];
    },
    append(...children) {
      this.children.push(...children);
    },
    getContext() {
      return { clearRect() {} };
    },
  };
}
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.doUnmock("@stellar/freighter-api");
  vi.doUnmock("@zkpassport/sdk");
  vi.doUnmock("qrcode");
  vi.resetModules();
});

async function page(
  overrides: Record<string, unknown> = {},
  faults: {
    initialStateFailures?: number;
    initialInfoFailures?: number;
    refundFailure?: boolean;
    acceptResponseLost?: boolean;
    acceptedQuote?: string | null;
    acceptedDestination?: string;
    launcher?: boolean;
    payment?: {
      retained?: boolean;
      receipt:
        | "failed"
        | "success"
        | "missing"
        | "offline"
        | "wrong-hash"
        | "wrong-envelope"
        | "inconsistent-result"
        | "malformed";
      submission?: "reject" | "lost";
    };
  } = {}
) {
  vi.resetModules();
  vi.useFakeTimers();
  const html = await readFile(
    new URL("../web/sep-anchor.html", import.meta.url),
    "utf8"
  );
  const nodes = new Map<string, PageNode>();
  const stack: PageNode[] = [];
  let end = 0;
  for (const match of html.matchAll(/<(\/?)([a-z][a-z0-9]*)\b([^>]*)>/gi)) {
    const content = html.slice(end, match.index).replace(/\s+/g, " ").trim();
    if (content && stack.length) stack.at(-1)!.textContent += content;
    end = match.index + match[0].length;
    const [, closing, tag, attributes] = match;
    if (closing) {
      while (stack.length && stack.pop()!.tag !== tag) {}
      continue;
    }
    const current = node(tag!, stack.at(-1));
    current.hidden = /\bhidden\b/.test(attributes!);
    const id = /\bid="([^"]+)"/.exec(attributes!)?.[1];
    if (id) nodes.set(id, current);
    if (!["input", "br", "meta", "link", "img", "hr"].includes(tag!))
      stack.push(current);
  }
  const get = (id: string) => {
    const result = nodes.get(id);
    if (!result) throw new Error(`Unknown page element ${id}`);
    return result;
  };
  const visible = (id: string) => {
    let current: PageNode | undefined = get(id);
    while (current) {
      if (current.hidden) return false;
      current = current.parent;
    }
    return true;
  };
  let transaction: Record<string, unknown> = {
    id: orderId,
    kind: "withdrawal",
    status: "pending_user",
    wallet,
    quote_id: "qt_fixture",
    amount_in: "2.0000000",
    amount_out: "79.60",
    amount_in_asset: `stellar:USDC:${issuer}`,
    amount_out_asset: "iso4217:TRY",
    message: "Exact escrow can be refunded before payout authorization.",
    policy,
    native: { eligible: false, valid_until: null, confirmed_ledger: null },
    ready_for_payment: false,
    recovery_required: false,
    escrowed: true,
    payout_authorized: false,
    can_refund: true,
    withdraw_anchor_account: null,
    withdraw_memo: null,
    withdraw_memo_type: null,
    actions: [],
    ...overrides,
  };
  const location = new URL(
    faults.launcher
      ? "http://localhost:8787/anchor"
      : `http://localhost:8787/sep24/interactive/${orderId}`
  );
  let stateFailures = faults.initialStateFailures ?? 0;
  let refundFailure = faults.refundFailure ?? false;
  let infoFailures = faults.initialInfoFailures ?? 0;
  let nextState: Promise<void> | undefined;
  let nextRefund: Promise<void> | undefined;
  let nextAcceptance: Promise<void> | undefined;
  const acceptRequests: unknown[] = [];
  const firmQuote = {
    id: "qt_browser",
    sell_amount: "100.00",
    sell_asset: "iso4217:TRY",
    buy_amount: "2.4875621",
    buy_asset: `stellar:USDC:${issuer}`,
    expires_at: new Date(Date.now() + 600000).toISOString(),
    fee: { total: "0.50", asset: "iso4217:TRY" },
  };
  let payment = new TransactionBuilder(new Account(wallet, "123"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: issuer,
        asset: new Asset("USDC", issuer),
        amount: "2.0000000",
      })
    )
    .addMemo(Memo.hash(Buffer.from(orderId, "hex")))
    .setTimeout(180)
    .build();
  const storage = new Map<string, string>();
  if (faults.payment) storage.set(`sep-anchor-launcher:${orderId}`, wallet);
  if (faults.payment?.retained)
    storage.set(
      `sep-anchor-payment:${orderId}`,
      Buffer.from(payment.hash()).toString("hex")
    );
  let paymentReceipt = faults.payment?.receipt;
  const paymentPosts: string[] = [];
  const receiptReads: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input), location.origin);
    if (
      url.origin === "https://horizon-testnet.stellar.org" &&
      faults.payment
    ) {
      if (url.pathname === `/accounts/${wallet}`)
        return Response.json({ account_id: wallet, sequence: "123" });
      if (url.pathname === "/transactions" && init?.method === "POST") {
        const envelope = new URLSearchParams(String(init.body)).get("tx")!;
        paymentPosts.push(envelope);
        payment = TransactionBuilder.fromXdr(
          envelope,
          Networks.TESTNET
        ) as typeof payment;
        if (faults.payment.submission === "lost")
          throw new TypeError("Failed to fetch");
        return Response.json(
          {
            extras: {
              result_codes: {
                transaction: "tx_failed",
                operations: ["op_underfunded"],
              },
            },
          },
          { status: 400 }
        );
      }
      if (url.pathname.startsWith("/transactions/")) {
        receiptReads.push(url.pathname);
        if (paymentReceipt === "offline")
          throw new TypeError("Failed to fetch");
        if (paymentReceipt === "missing")
          return Response.json({}, { status: 404 });
        if (paymentReceipt === "malformed")
          return Response.json({ successful: false });
        return Response.json({
          hash:
            paymentReceipt === "wrong-hash"
              ? "00".repeat(32)
              : Buffer.from(payment.hash()).toString("hex"),
          successful: paymentReceipt === "success",
          ledger: 4774150,
          envelope_xdr:
            paymentReceipt === "wrong-envelope"
              ? new TransactionBuilder(new Account(wallet, "999"), {
                  fee: "100",
                  networkPassphrase: Networks.TESTNET,
                })
                  .addOperation(
                    Operation.payment({
                      destination: issuer,
                      asset: new Asset("USDC", issuer),
                      amount: "2.0000000",
                    })
                  )
                  .setTimeout(180)
                  .build()
                  .toXdr()
              : payment.toXdr(),
          result_xdr:
            paymentReceipt === "success" ||
            paymentReceipt === "inconsistent-result"
              ? "AAAAAAAAAGQAAAAAAAAAAQAAAAAAAAABAAAAAAAAAAA="
              : "AAAAAAAAAGT/////AAAAAQAAAAAAAAAB/////gAAAAA=",
        });
      }
    }
    if (url.pathname === `/sep24/interactive/${orderId}/state`) {
      if (stateFailures > 0) {
        stateFailures -= 1;
        throw new TypeError("Failed to fetch");
      }
      const response = Response.json({
        transaction,
        csrf_token: "ef".repeat(32),
      });
      const wait = nextState;
      nextState = undefined;
      await wait;
      return response;
    }
    if (url.pathname === "/sep24/info") {
      if (infoFailures > 0) {
        infoFailures -= 1;
        throw new TypeError("Failed to fetch");
      }
      return Response.json({
        network: "testnet",
        network_passphrase: Networks.TESTNET,
        asset: { code: "USDC", issuer, contract: token },
        config: {
          contract: StrKey.encodeContract(Buffer.alloc(32, 7)),
          domain: "localhost",
          scope: "synthetic-test",
          policy,
          proof_bytes: 10240,
          external_inputs: 12,
          policy_valid_until: Math.floor(Date.now() / 1000) + 600,
        },
      });
    }
    if (url.pathname === `/sep24/interactive/${orderId}/quote`)
      return Response.json({ quote: firmQuote });
    if (
      url.pathname === `/sep24/interactive/${orderId}/accept` &&
      init?.method === "POST"
    ) {
      acceptRequests.push(JSON.parse(String(init.body)));
      transaction = {
        ...transaction,
        quote_id:
          faults.acceptedQuote === undefined
            ? firmQuote.id
            : faults.acceptedQuote,
        status: "pending_stellar",
        to: faults.acceptedDestination ?? "demo:test",
      };
      const wait = nextAcceptance;
      nextAcceptance = undefined;
      await wait;
      if (faults.acceptResponseLost) throw new TypeError("Failed to fetch");
      return Response.json({ transaction });
    }
    if (
      url.pathname === `/sep24/interactive/${orderId}/refund` &&
      init?.method === "POST"
    ) {
      const wait = nextRefund;
      nextRefund = undefined;
      await wait;
      if (refundFailure) {
        refundFailure = false;
        throw new TypeError("Failed to fetch");
      }
      if (new Headers(init.headers).get("X-CSRF-Token") !== "ef".repeat(32))
        return Response.json(
          { error: "Session binding missing" },
          { status: 403 }
        );
      transaction = {
        ...transaction,
        status: transaction.kind === "deposit" ? "expired" : "refunded",
        escrowed: false,
        can_refund: false,
      };
      return Response.json({ transaction });
    }
    throw new Error(`Unexpected browser HTTP request: ${url.pathname}`);
  };
  vi.doMock("@stellar/freighter-api", () => ({
    isConnected: async () => ({ isConnected: true }),
    requestAccess: async () => ({ address: wallet }),
    getAddress: async () => ({ address: wallet }),
    getNetworkDetails: async () => ({ networkPassphrase: Networks.TESTNET }),
    signTransaction: async (envelope: string) => {
      const tx = TransactionBuilder.fromXdr(envelope, Networks.TESTNET);
      tx.sign(Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1)));
      return { signedTxXdr: tx.toXdr(), signerAddress: wallet };
    },
  }));
  vi.doMock("@zkpassport/sdk", () => ({
    VERSION: "0.17.1",
    ZKPassport: class {},
  }));
  vi.doMock("qrcode", () => ({ default: {} }));
  const pageEvents = new Map<string, () => void>();
  vi.stubGlobal("window", {
    location,
    fetch: fetcher,
    addEventListener(name: string, callback: () => void) {
      pageEvents.set(name, callback);
    },
  });
  vi.stubGlobal("location", location);
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("document", {
    getElementById: get,
    createElement: node,
    querySelectorAll: () =>
      [...nodes.values()].filter((value) => value.tag === "button"),
  });
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  cleanups.push(() => pageEvents.get("pagehide")?.());
  const entry = "../web/sep-anchor.js";
  await import(entry);
  await vi.waitFor(() => expect(get("refund").disabled).toBe(false));
  return {
    get,
    visible,
    acceptRequests,
    storage,
    paymentPosts,
    receiptReads,
    setPaymentReceipt(value: typeof paymentReceipt) {
      paymentReceipt = value;
    },
    holdAcceptanceResponse() {
      let release!: () => void;
      nextAcceptance = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    async holdNextStatus(changes: Record<string, unknown> = {}, fail = false) {
      transaction = { ...transaction, ...changes };
      let release!: () => void;
      nextState = new Promise<void>((resolve, reject) => {
        release = fail
          ? () => reject(new TypeError("Failed to fetch"))
          : resolve;
      });
      await vi.advanceTimersByTimeAsync(2600);
      return async () => {
        release();
        await vi.advanceTimersByTimeAsync(0);
      };
    },
    holdRefundFailure() {
      let reject!: (error: Error) => void;
      nextRefund = new Promise<void>((_, fail) => {
        reject = fail;
      });
      return () => reject(new TypeError("Failed to fetch"));
    },
    async failNextStatus() {
      stateFailures = 1;
      await vi.advanceTimersByTimeAsync(2600);
    },
    async click(id: string) {
      expect(visible(id)).toBe(true);
      expect(get(id).disabled).toBe(false);
      get(id).trigger("click");
      await vi.waitFor(() => expect(get(id).disabled).toBe(false));
    },
    async update(changes: Record<string, unknown>, elapsed = 2600) {
      transaction = { ...transaction, ...changes };
      await vi.advanceTimersByTimeAsync(elapsed);
    },
  };
}

function withdrawalReady() {
  return {
    native: {
      eligible: true,
      valid_until: Math.floor(Date.now() / 1000) + 3600,
      confirmed_ledger: 123,
    },
    escrowed: false,
    can_refund: false,
    ready_for_payment: true,
    withdraw_anchor_account: issuer,
    withdraw_memo: Buffer.from(orderId, "hex").toString("base64"),
    withdraw_memo_type: "hash",
  };
}

it("unlocks a retained withdrawal only after confirming its failed ledger receipt", async () => {
  const browser = await page(withdrawalReady(), {
    payment: { retained: true, receipt: "failed" },
  });
  expect(browser.storage.has(`sep-anchor-payment:${orderId}`)).toBe(false);
  expect(browser.get("send-payment").disabled).toBe(false);
  expect(browser.get("submitted-payment").textContent).toContain("Failed");
  expect(browser.get("payment-status").textContent).toContain(
    "No tokens were transferred"
  );
  expect(browser.paymentPosts).toHaveLength(0);
});

it.each([
  "success",
  "missing",
  "offline",
  "wrong-hash",
  "wrong-envelope",
  "inconsistent-result",
  "malformed",
] as const)("retains the withdrawal lock for a %s receipt", async (receipt) => {
  const browser = await page(withdrawalReady(), {
    payment: { retained: true, receipt },
  });
  expect(browser.receiptReads.length).toBeGreaterThan(0);
  expect(browser.storage.has(`sep-anchor-payment:${orderId}`)).toBe(true);
  expect(browser.get("send-payment").disabled).toBe(true);
  await browser.update({}, 30000);
  expect(browser.get("send-payment").disabled).toBe(true);
  expect(browser.paymentPosts).toHaveLength(0);
  if (receipt === "success")
    expect(browser.get("payment-status").textContent).toContain(
      "Do not pay again"
    );
});

it.each(["reject", "lost"] as const)(
  "reconciles a %s submission without automatically resending",
  async (submission) => {
    const browser = await page(withdrawalReady(), {
      payment: { receipt: "missing", submission },
    });
    browser.get("send-payment").trigger("click");
    await vi.waitFor(() => expect(browser.get("refund").disabled).toBe(false));
    expect(browser.paymentPosts).toHaveLength(1);
    expect(browser.get("send-payment").disabled).toBe(true);
    expect(browser.storage.has(`sep-anchor-payment:${orderId}`)).toBe(true);
    browser.setPaymentReceipt("failed");
    await browser.update({});
    expect(browser.get("send-payment").disabled).toBe(false);
    expect(browser.paymentPosts).toHaveLength(1);
    await browser.click("send-payment");
    expect(browser.paymentPosts).toHaveLength(2);
  }
);

it("reconciles a lost quote acceptance response from status without repeating acceptance", async () => {
  const browser = await page(
    {
      kind: "deposit",
      quote_id: null,
      escrowed: false,
      can_refund: false,
      native: {
        eligible: true,
        valid_until: Math.floor(Date.now() / 1000) + 600,
        confirmed_ledger: 123,
      },
    },
    { acceptResponseLost: true }
  );
  browser.get("amount").value = "100";
  await browser.click("quote");
  await browser.click("accept");
  expect(browser.get("problem").textContent).toContain("response was lost");
  await browser.update({});
  expect(browser.visible("quote-section")).toBe(false);
  expect(browser.get("heading").textContent).toBe("Finish your exchange");
  expect(browser.acceptRequests).toEqual([{ quote_id: "qt_browser" }]);
  expect(browser.visible("problem")).toBe(false);
});

it.each([null, "qt_different"])(
  "does not acknowledge lost acceptance from an unrelated quote state: %j",
  async (acceptedQuote) => {
    const browser = await page(
      {
        kind: "deposit",
        quote_id: null,
        escrowed: false,
        can_refund: false,
      },
      { acceptResponseLost: true, acceptedQuote, initialInfoFailures: 3 }
    );
    browser.get("amount").value = "100";
    await browser.click("quote");
    await browser.click("accept");
    await browser.update({});
    await browser.update({});
    expect(browser.visible("problem")).toBe(true);
    expect(browser.get("problem").textContent).toContain("response was lost");
    expect(browser.acceptRequests).toEqual([{ quote_id: "qt_browser" }]);
    await browser.update({ status: "completed" });
    expect(browser.visible("problem")).toBe(true);
  }
);

it.each(["demo:test", "demo:other"])(
  "matches the frozen withdrawal destination before clearing lost acceptance: %s",
  async (acceptedDestination) => {
    const browser = await page(
      { quote_id: null, escrowed: false, can_refund: false },
      { acceptResponseLost: true, acceptedDestination }
    );
    browser.get("amount").value = "2";
    browser.get("destination").value = "demo:test";
    await browser.click("quote");
    await browser.click("accept");
    browser.get("destination").value = "demo:edited";
    await browser.update({});
    expect(browser.visible("problem")).toBe(
      acceptedDestination !== "demo:test"
    );
    expect(browser.acceptRequests).toEqual([
      { quote_id: "qt_browser", bank_destination: "demo:test" },
    ]);
  }
);

it("does not restore a lost acceptance warning after its exact acknowledgement arrived", async () => {
  const browser = await page(
    { kind: "deposit", quote_id: null, escrowed: false, can_refund: false },
    { acceptResponseLost: true }
  );
  browser.get("amount").value = "100";
  await browser.click("quote");
  const releaseStatus = await browser.holdNextStatus({
    quote_id: "qt_browser",
    status: "pending_stellar",
  });
  const releaseAcceptance = browser.holdAcceptanceResponse();
  const clicked = browser.click("accept");
  await releaseStatus();
  releaseAcceptance();
  await clicked;
  expect(browser.visible("problem")).toBe(false);
  expect(browser.acceptRequests).toEqual([{ quote_id: "qt_browser" }]);
});

it("does not replace a confirmed refund with an older pending status response", async () => {
  const browser = await page();
  const release = await browser.holdNextStatus();
  await browser.click("refund");
  expect(browser.get("heading").textContent).toBe("Refund confirmed");
  await release();
  expect(browser.get("heading").textContent).toBe("Refund confirmed");
});

it("does not resurrect a connection warning when an old poll fails after confirmation", async () => {
  const browser = await page();
  const release = await browser.holdNextStatus({}, true);
  await browser.click("refund");
  expect(browser.get("heading").textContent).toBe("Refund confirmed");
  await release();
  expect(browser.visible("problem")).toBe(false);
});

it("does not restore transport uncertainty after a clean terminal status arrives", async () => {
  const browser = await page();
  const release = await browser.holdNextStatus({
    status: "completed",
    escrowed: false,
    can_refund: false,
  });
  const reject = browser.holdRefundFailure();
  const clicked = browser.click("refund");
  await release();
  expect(browser.get("heading").textContent).toBe("Exchange complete");
  reject();
  await clicked;
  expect(browser.visible("problem")).toBe(false);
});

it.each([
  { payment_recovery_required: true },
  { recovery_required: true },
  {
    actions: [
      {
        kind: "refund",
        status: "pending",
        transaction_hash: "78".repeat(32),
        ledger: null,
      },
    ],
  },
])(
  "keeps a lost response warning when terminal reconciliation is incomplete: %j",
  async (outstanding) => {
    const browser = await page();
    const release = await browser.holdNextStatus({
      status: "completed",
      escrowed: false,
      can_refund: false,
      ...outstanding,
    });
    const reject = browser.holdRefundFailure();
    const clicked = browser.click("refund");
    await release();
    reject();
    await clicked;
    expect(browser.visible("problem")).toBe(true);
    expect(browser.get("problem").textContent).toContain("response was lost");
    await browser.update({});
    expect(browser.visible("problem")).toBe(true);
  }
);

it("clears a transient status error when settlement is subsequently confirmed", async () => {
  const browser = await page({
    status: "pending_stellar",
    payout_authorized: true,
    can_refund: false,
  });
  await browser.failNextStatus();
  expect(browser.visible("problem")).toBe(true);
  await browser.update({ status: "completed", escrowed: false }, 6000);
  expect(browser.get("heading").textContent).toBe("Exchange complete");
  expect(browser.visible("problem")).toBe(false);
});

it("keeps confirmed settlement visible without polling a completed order", async () => {
  const browser = await page({
    status: "completed",
    escrowed: false,
    can_refund: false,
  });
  await browser.failNextStatus();
  expect(browser.get("heading").textContent).toBe("Exchange complete");
  expect(browser.visible("problem")).toBe(false);
});

it("recovers an interrupted first status read without restarting the order", async () => {
  const browser = await page({}, { initialStateFailures: 1 });
  expect(browser.visible("problem")).toBe(true);
  await browser.update({}, 6000);
  expect(browser.visible("exchange")).toBe(true);
  expect(browser.get("order-id").textContent).toBe(orderId);
  expect(browser.visible("problem")).toBe(false);
});

it("does not replay a failed refund or erase its uncertainty on an unrelated status read", async () => {
  const browser = await page({}, { refundFailure: true });
  await browser.click("refund");
  expect(browser.visible("problem")).toBe(true);
  const originalWarning = browser.get("problem").textContent;
  await browser.failNextStatus();
  expect(browser.get("problem").textContent).toBe(originalWarning);
  await browser.update({}, 6000);
  expect(browser.visible("problem")).toBe(true);
  expect(browser.get("heading").textContent).not.toBe("Refund confirmed");
});

it("reconnects the launcher after a transient configuration fetch failure", async () => {
  const browser = await page({}, { launcher: true, initialInfoFailures: 1 });
  expect(browser.visible("launcher")).toBe(false);
  await browser.update({}, 6000);
  expect(browser.visible("launcher")).toBe(true);
  expect(browser.visible("problem")).toBe(false);
});

it("recovers missing configuration without discarding the current order", async () => {
  const browser = await page({}, { initialInfoFailures: 1 });
  expect(browser.visible("problem")).toBe(true);
  await browser.update({}, 6000);
  expect(browser.get("order-id").textContent).toBe(orderId);
  expect(browser.visible("problem")).toBe(false);
});

it("continues reconciliation when a completed order has payment recovery outstanding", async () => {
  const browser = await page({
    status: "completed",
    payment_recovery_required: true,
  });
  await browser.failNextStatus();
  expect(browser.visible("extra-payment-warning")).toBe(true);
  expect(browser.visible("problem")).toBe(true);
});

it("always exposes confirmed onchain evidence and wallet links outside a disclosure", async () => {
  const proofHash = "12".repeat(32);
  const settleHash = "34".repeat(32);
  const browser = await page({
    kind: "deposit",
    status: "completed",
    escrowed: false,
    can_refund: false,
    actions: [
      {
        kind: "eligibility",
        status: "success",
        transaction_hash: proofHash,
        ledger: 101,
      },
      {
        kind: "settle",
        status: "success",
        transaction_hash: settleHash,
        ledger: 104,
      },
    ],
  });
  expect(browser.visible("details")).toBe(true);
  expect(browser.get("details").tag).toBe("section");
  expect(browser.visible("wallet-explorer")).toBe(true);
  expect(browser.get("wallet-explorer").href).toBe(
    `https://stellar.expert/explorer/testnet/account/${wallet}`
  );
  const links = browser
    .get("evidence")
    .children.flatMap((row) => row.children)
    .filter((child) => child.tag === "a");
  expect(links.map((link) => [link.textContent, link.href])).toEqual([
    [
      "Proof verification: Confirmed / ledger 101",
      `https://stellar.expert/explorer/testnet/tx/${proofHash}`,
    ],
    [
      "Token settlement: Confirmed / ledger 104",
      `https://stellar.expert/explorer/testnet/tx/${settleHash}`,
    ],
  ]);
});

it("distinguishes unsubmitted and pending proof stages from confirmed transactions", async () => {
  const browser = await page({
    actions: [
      {
        kind: "eligibility",
        status: "success",
        transaction_hash: "56".repeat(32),
        ledger: null,
      },
    ],
  });
  const rows = browser.get("evidence").children;
  expect(
    rows.flatMap((row) => row.children).map((link) => link.textContent)
  ).toEqual(["Proof verification: Pending confirmation"]);
  expect(
    rows.some((row) => row.textContent === "Token settlement: Not submitted")
  ).toBe(true);
});

it("keeps an expired-grant escrow refund visible and submits it from the production page", async () => {
  const browser = await page();
  expect(browser.visible("finish-section")).toBe(true);
  expect(browser.visible("refund")).toBe(true);
  expect(browser.visible("mock-bank")).toBe(false);
  expect(browser.get("step").textContent).toBe("3 / TRANSFER");
  await browser.click("refund");
  expect(browser.get("heading").textContent).toBe("Refund confirmed");
  expect(browser.get("step").textContent).toBe("CONFIRMED");
  expect(browser.visible("refund")).toBe(false);
});

it.each(["pending_stellar", "pending_user"])(
  "reconciles an authorized payout in %s after eligibility expiry without asking for a new proof",
  async (status) => {
    const browser = await page({
      status,
      payout_authorized: true,
      can_refund: false,
    });
    expect(browser.visible("finish-section")).toBe(true);
    expect(browser.visible("proof-section")).toBe(false);
    expect(browser.visible("mock-bank")).toBe(false);
    expect(browser.visible("refund")).toBe(false);
    expect(browser.get("heading").textContent).toBe(
      "Completing authorized payout"
    );
    expect(browser.get("step").textContent).toBe("3 / TRANSFER");
    expect(browser.get("next-action").textContent).toBe(
      "Payout is already authorized. Receipt and settlement are reconciling automatically; no new proof or payment is needed."
    );
    await browser.update({ status: "completed", escrowed: false });
    expect(browser.get("heading").textContent).toBe("Exchange complete");
    expect(browser.get("step").textContent).toBe("CONFIRMED");
    expect(browser.visible("proof-section")).toBe(false);
  }
);

it("keeps first-time unfunded orders at proof onboarding", async () => {
  const browser = await page({
    status: "incomplete",
    escrowed: false,
    can_refund: false,
  });
  expect(browser.visible("proof-section")).toBe(true);
  expect(browser.visible("finish-section")).toBe(false);
  expect(browser.visible("refund")).toBe(false);
  expect(browser.get("heading").textContent).toBe("Verify privately");
  expect(browser.get("step").textContent).toBe("2 / VERIFY");
});

it("labels a held deposit cancellation as releasing a reservation rather than a wallet refund", async () => {
  const browser = await page({
    kind: "deposit",
    amount_in: "100.00",
    amount_out: "2.4875621",
    amount_in_asset: "iso4217:TRY",
    amount_out_asset: `stellar:USDC:${issuer}`,
  });
  expect(browser.visible("refund")).toBe(true);
  expect(browser.get("refund").textContent).toBe("Cancel unused reservation");
  expect(browser.get("step").textContent).toBe("3 / TRANSFER");
  await browser.click("refund");
  expect(browser.get("heading").textContent).toBe("Order expired");
  expect(browser.visible("proof-section")).toBe(false);
  expect(browser.visible("refund")).toBe(false);
});
