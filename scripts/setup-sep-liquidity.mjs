import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  Asset,
  Horizon,
  Keypair,
  Memo,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
  rpc,
} from "@stellar/stellar-sdk";

const PROVIDER =
  process.env.TR_ANCHOR_PROVIDER_PUBLIC ??
  "GDAHV4MVSXLCR4ELY4JK3F6WNEQCONAZTLTKBGDJZARXBRGWMTTIMK22";
const ISSUER =
  process.env.TR_ANCHOR_ISSUER_PUBLIC ??
  "GDQYN2SNSRQCGBJYB7SQFQIKKKN4YWZCHYZQ5W7UKAB6P36MSIKCVKQN";
const CODE = "USDC";
const AMOUNT = "100.0000000";
const TRUST_LIMIT = "1000.0000000";
const STROOPS = 1_000_000_000n;
const FEE = "10000";
const HORIZON = "https://horizon-testnet.stellar.org";
const RPC = "https://soroban-testnet.stellar.org";
const MARKER = createHash("sha256")
  .update(
    JSON.stringify(["sep-anchor-liquidity-v1", PROVIDER, ISSUER, CODE, AMOUNT])
  )
  .digest("hex");
const asset = new Asset(CODE, ISSUER);
const horizon = new Horizon.Server(HORIZON);
const stellarRpc = new rpc.Server(RPC, { timeout: 15_000 });

class SafeError extends Error {}
const fail = (message) => {
  throw new SafeError(message);
};
const now = () => Math.floor(Date.now() / 1000);
const usage = `Testnet-only, one-time SEP provider liquidity setup.
Usage: node scripts/setup-sep-liquidity.mjs --keydir PATH --journal FILE [--execute]

The default mode only checks public keys, Testnet endpoints and account state.
--execute creates an exact 1000 mock-USDC trustline and mints exactly 100 once.
Original version-1 journals retain their signed 100 limit without replacement.
The journal and signed envelopes are private (0600); keep the same journal.
Existing trustline without the original journal blocks a new mint.
Unknown outcomes reuse the same signed transaction hash, never a new payment.
A failed or expired journaled transaction requires operator recovery.
Only identities sep-anchor-provider-v1 and anchor-gate-issuer-v1 are accepted.
This script never funds accounts, changes issuer settings or uses Mainnet.
`;

function options() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") return null;
  const result = { execute: false, keydir: null, journal: null };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (seen.has(arg)) fail("Repeated command-line option.");
    seen.add(arg);
    if (arg === "--execute") result.execute = true;
    else if (arg === "--keydir" || arg === "--journal") {
      const value = args[++i];
      if (!value || value.startsWith("--"))
        fail("An option is missing its path.");
      result[arg.slice(2)] = resolve(value);
    } else fail("Unsupported option. Use --help for the exact interface.");
  }
  if (!result.keydir || !result.journal)
    fail("Both --keydir and --journal are required.");
  if (!lstatSync(result.keydir).isDirectory())
    fail("The configured key directory is not a directory.");
  return result;
}

function plannedOperation(kind, version = 2) {
  return kind === "trust"
    ? Operation.changeTrust({
        asset,
        limit: version === 1 ? AMOUNT : TRUST_LIMIT,
      })
    : Operation.payment({ destination: PROVIDER, asset, amount: AMOUNT });
}

function identity(keydir, name, secret = false) {
  let value;
  try {
    value = execFileSync(
      "stellar",
      [
        "keys",
        secret ? "secret" : "public-key",
        name,
        "--config-dir",
        keydir,
        "--quiet",
        "--no-cache",
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15_000,
      }
    ).trim();
  } catch {
    fail(
      "The required local Stellar identity could not be loaded. No CLI output was logged."
    );
  }
  const expected = name === "sep-anchor-provider-v1" ? PROVIDER : ISSUER;
  if (secret) {
    let key;
    try {
      key = Keypair.fromSecret(value);
    } catch {
      fail("The local identity did not contain a valid signing key.");
    }
    if (key.publicKey() !== expected)
      fail("A signing identity does not match the pinned Testnet account.");
    return key;
  }
  if (value !== expected)
    fail("A local identity does not match the pinned Testnet account.");
  return value;
}

function amount(value) {
  if (typeof value !== "string" || !/^\d+(?:\.\d{1,7})?$/.test(value))
    fail("Invalid account amount returned by Horizon.");
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 10_000_000n + BigInt(fraction.padEnd(7, "0"));
}

async function network() {
  const [h, r] = await Promise.all([horizon.root(), stellarRpc.getNetwork()]);
  if (
    h.network_passphrase !== Networks.TESTNET ||
    r.passphrase !== Networks.TESTNET
  )
    fail("Both endpoints must independently identify Stellar Testnet.");
}

async function accounts() {
  const [provider, issuer] = await Promise.all([
    horizon.loadAccount(PROVIDER),
    horizon.loadAccount(ISSUER),
  ]);
  if (provider.accountId() !== PROVIDER || issuer.accountId() !== ISSUER)
    fail("Account identity mismatch.");
  const line = provider.balances.find(
    (b) => b.asset_code === CODE && b.asset_issuer === ISSUER
  );
  return { provider, issuer, line };
}

function validateStep(kind, step, version) {
  if (
    !step ||
    typeof step !== "object" ||
    !["prepared", "pending", "success", "failed"].includes(step.status) ||
    typeof step.transaction !== "string" ||
    !/^[a-f0-9]{64}$/.test(step.hash)
  )
    fail("The journal contains an invalid transaction record.");
  let transaction;
  try {
    transaction = TransactionBuilder.fromXdr(
      step.transaction,
      Networks.TESTNET
    );
  } catch {
    fail("The journal contains an invalid signed envelope.");
  }
  const source = kind === "trust" ? PROVIDER : ISSUER;
  const op = transaction.operations[0];
  const bounds = transaction.timeBounds;
  if (
    !(transaction instanceof Transaction) ||
    transaction.source !== source ||
    transaction.operations.length !== 1 ||
    Buffer.from(transaction.hash()).toString("hex") !== step.hash ||
    BigInt(transaction.fee) > 10_000_000n ||
    BigInt(transaction.fee) <= 0n ||
    !bounds ||
    Number(bounds.maxTime) !== step.expires_at ||
    Number(bounds.minTime) !== step.min_time ||
    !Number.isSafeInteger(step.expires_at) ||
    !Number.isSafeInteger(step.min_time) ||
    step.min_time < 0 ||
    step.expires_at <= step.min_time ||
    step.expires_at - step.min_time > 305 ||
    transaction.memo.type !== "hash" ||
    Buffer.from(transaction.memo.value).toString("hex") !== MARKER ||
    !transaction.signatures.some((signature) =>
      Keypair.fromPublicKey(source).verify(
        transaction.hash(),
        signature.signature
      )
    )
  )
    fail("The journal transaction does not match the pinned Testnet plan.");
  if (op.source && op.source !== source)
    fail("Unexpected operation source in the journal.");
  const operationAsset = kind === "trust" ? op.line : op.asset;
  if (
    !operationAsset ||
    operationAsset.getCode() !== CODE ||
    operationAsset.getIssuer() !== ISSUER
  )
    fail("Unexpected asset in the journal.");
  if (
    kind === "trust"
      ? op.type !== "changeTrust" ||
        op.limit !== (version === 1 ? AMOUNT : TRUST_LIMIT)
      : op.type !== "payment" ||
        op.destination !== PROVIDER ||
        op.amount !== AMOUNT
  )
    fail("Unexpected financial terms in the journal.");
  return transaction;
}

function readJournal(path) {
  if (!existsSync(path)) return null;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.size > 128_000 ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      fail("The journal must be an owned regular file with mode 0600.");
    let value;
    try {
      value = JSON.parse(readFileSync(fd, "utf8"));
    } catch {
      fail("The journal is not valid JSON.");
    }
    if (
      ![1, 2].includes(value.version) ||
      (value.version === 2 && value.trust_limit !== TRUST_LIMIT) ||
      (value.version === 1 && value.trust_limit !== undefined) ||
      value.network !== Networks.TESTNET ||
      value.provider !== PROVIDER ||
      value.issuer !== ISSUER ||
      value.code !== CODE ||
      value.amount !== AMOUNT ||
      value.marker !== MARKER ||
      value.initial_trustline_absent !== true ||
      !value.steps ||
      typeof value.steps !== "object" ||
      Object.keys(value.steps).some((key) => key !== "trust" && key !== "mint")
    )
      fail("The journal describes a different liquidity setup.");
    if (value.steps.trust)
      validateStep("trust", value.steps.trust, value.version);
    if (value.steps.mint) {
      validateStep("mint", value.steps.mint, value.version);
      if (value.steps.trust?.status !== "success")
        fail(
          "The journal mint does not have a confirmed trustline predecessor."
        );
    }
    return value;
  } finally {
    closeSync(fd);
  }
}

function persist(path, journal) {
  if (existsSync(path)) readJournal(path);
  const temp = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let fd;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(journal, null, 2)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
    const directory = openSync(dirname(path), constants.O_RDONLY);
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temp)) unlinkSync(temp);
  }
}

async function reconcile(step) {
  try {
    const known = await stellarRpc.getTransaction(step.hash);
    if (known.status === "SUCCESS" || known.status === "FAILED") {
      if (!Number.isSafeInteger(known.ledger) || known.ledger <= 0)
        fail("The RPC confirmation has no valid ledger.");
      return {
        status: known.status === "SUCCESS" ? "success" : "failed",
        ledger: known.ledger,
      };
    }
  } catch (error) {
    if (error instanceof SafeError) throw error;
  }
  try {
    const known = await horizon.transactions().transaction(step.hash).call();
    const ledger =
      typeof known.ledger === "number" ? known.ledger : known.ledger_attr;
    if (
      known.hash !== step.hash ||
      typeof known.successful !== "boolean" ||
      !Number.isSafeInteger(ledger) ||
      ledger <= 0
    )
      fail("Horizon returned inconsistent transaction evidence.");
    return {
      status: known.successful ? "success" : "failed",
      ledger,
    };
  } catch (error) {
    if (error instanceof SafeError) throw error;
  }
  return {
    status:
      step.status === "success" || step.status === "failed"
        ? step.status
        : "pending",
    ledger: step.ledger ?? null,
  };
}

function prepare(kind, source, signer, version) {
  const minTime = Math.max(0, now() - 5);
  const maxTime = now() + 180;
  const transaction = new TransactionBuilder(source, {
    fee: FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(plannedOperation(kind, version))
    .addMemo(Memo.hash(MARKER))
    .setTimebounds(minTime, maxTime)
    .build();
  transaction.sign(signer);
  const step = {
    transaction: transaction.toXdr(),
    hash: Buffer.from(transaction.hash()).toString("hex"),
    min_time: minTime,
    expires_at: maxTime,
    status: "prepared",
    ledger: null,
  };
  validateStep(kind, step, version);
  return step;
}

async function runStep(kind, journal, path) {
  const step = journal.steps[kind];
  Object.assign(step, await reconcile(step));
  persist(path, journal);
  if (step.status === "success") return true;
  if (step.status === "failed")
    fail(
      `The journaled ${kind} transaction definitively failed. No replacement transaction was prepared.`
    );
  if (now() >= step.expires_at)
    fail(
      `The ${kind} envelope expired with an unknown outcome. Keep the journal and reconcile its hash; no new transaction was prepared.`
    );
  await network();
  step.status = "pending";
  persist(path, journal);
  try {
    const response = await stellarRpc.sendTransaction(
      validateStep(kind, step, journal.version)
    );
    if (response.hash && response.hash !== step.hash)
      fail("RPC submission returned a different hash.");
  } catch (error) {
    if (error instanceof SafeError) throw error;
  }
  for (let attempt = 0; attempt < 12; attempt++) {
    Object.assign(step, await reconcile(step));
    persist(path, journal);
    if (step.status === "success") return true;
    if (step.status === "failed")
      fail(
        `The journaled ${kind} transaction failed onchain. No replacement transaction was prepared.`
      );
    await delay(2000);
  }
  return false;
}

function report(execute, journal, snapshot, message) {
  console.log(
    JSON.stringify(
      {
        mode: execute ? "execute" : "read-only",
        network: "Stellar Testnet",
        provider: PROVIDER,
        issuer: ISSUER,
        asset: CODE,
        one_time_liquidity: AMOUNT,
        trustline_present: !!snapshot.line,
        current_balance: snapshot.line?.balance ?? null,
        steps: Object.entries(journal?.steps ?? {}).map(([kind, step]) => ({
          kind,
          hash: step.hash,
          status: step.status,
          ledger: step.ledger,
        })),
        message,
      },
      null,
      2
    )
  );
}

async function main() {
  const args = options();
  if (!args) {
    console.log(usage);
    return;
  }
  identity(args.keydir, "sep-anchor-provider-v1");
  identity(args.keydir, "anchor-gate-issuer-v1");
  await network();
  let journal = readJournal(args.journal);
  let snapshot = await accounts();
  if (!args.execute) {
    if (journal)
      for (const step of Object.values(journal.steps))
        Object.assign(step, await reconcile(step));
    report(
      false,
      journal,
      snapshot,
      !journal && snapshot.line
        ? "Blocked: an existing trustline requires its original journal; creating a new journal could duplicate minting."
        : "No state changed. Use --execute with this same journal path only after reviewing the fixed Testnet plan."
    );
    return;
  }
  mkdirSync(dirname(args.journal), { recursive: true, mode: 0o700 });
  const lockPath = `${args.journal}.lock`;
  let lock;
  try {
    lock = openSync(lockPath, "wx", 0o600);
  } catch {
    fail(
      "The journal is locked. Do not remove the lock until the previous process is confirmed stopped."
    );
  }
  try {
    writeFileSync(
      lock,
      JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })
    );
    fsyncSync(lock);
    journal = readJournal(args.journal);
    snapshot = await accounts();
    if (!journal) {
      if (snapshot.line)
        fail(
          "Existing trustline without the original journal: refusing to create a possibly duplicate mint."
        );
      journal = {
        version: 2,
        network: Networks.TESTNET,
        provider: PROVIDER,
        issuer: ISSUER,
        code: CODE,
        amount: AMOUNT,
        trust_limit: TRUST_LIMIT,
        marker: MARKER,
        initial_trustline_absent: true,
        created_at: new Date().toISOString(),
        steps: {},
      };
      persist(args.journal, journal);
    }
    if (!journal.steps.trust) {
      if (snapshot.line)
        fail(
          "A trustline appeared outside the journal. Stop for operator reconciliation."
        );
      journal.steps.trust = prepare(
        "trust",
        snapshot.provider,
        identity(args.keydir, "sep-anchor-provider-v1", true),
        journal.version
      );
      persist(args.journal, journal);
    }
    if (!(await runStep("trust", journal, args.journal))) {
      report(
        true,
        journal,
        snapshot,
        "Trustline outcome is pending. Rerun with the same journal; no mint has been prepared."
      );
      return;
    }
    if (!journal.steps.mint) {
      snapshot = await accounts();
      if (
        !snapshot.line ||
        snapshot.line.is_authorized !== true ||
        amount(snapshot.line.balance) !== 0n ||
        amount(snapshot.line.limit) -
          amount(snapshot.line.buying_liabilities ?? "0") <
          STROOPS
      )
        fail(
          "The confirmed trustline must be authorized, empty and have capacity for exactly 100 mock USDC before the first mint."
        );
      journal.steps.mint = prepare(
        "mint",
        snapshot.issuer,
        identity(args.keydir, "anchor-gate-issuer-v1", true),
        journal.version
      );
      persist(args.journal, journal);
    }
    const complete = await runStep("mint", journal, args.journal);
    snapshot = await accounts();
    report(
      true,
      journal,
      snapshot,
      complete
        ? "The one-time 100 mock-USDC liquidity payment is confirmed. Future runs will only reconcile this hash."
        : "Mint outcome is pending. Keep and reuse this journal; do not create a replacement payment."
    );
  } finally {
    closeSync(lock);
    unlinkSync(lockPath);
  }
}

try {
  await main();
} catch (error) {
  console.error(
    error instanceof SafeError
      ? error.message
      : "Liquidity setup stopped safely. Endpoint or local state could not be confirmed; no raw error or credential output was logged."
  );
  process.exitCode = 1;
}
