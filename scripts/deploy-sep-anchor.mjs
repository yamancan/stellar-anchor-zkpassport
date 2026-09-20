import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { gunzipSync } from "node:zlib";
import {
  Address,
  Contract,
  Keypair,
  Networks,
  Operation,
  StrKey,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

const args = process.argv.slice(2);
const execute = args.includes("--execute");
const option = (name) => {
  const position = args.indexOf(name);
  assert.ok(
    position >= 0 && args[position + 1] && !args[position + 1].startsWith("--"),
    `Missing ${name}`
  );
  return args[position + 1];
};
const journalPath = resolve(option("--journal"));
const keyDirectory = resolve(option("--keys"));
const domain = option("--domain");
assert.ok(
  domain === "localhost" ||
    /^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/.test(domain),
  "Expected a bare hostname"
);
const artifacts = {
  verifier: {
    path: resolve(option("--verifier-wasm")),
    hash: "64f5462bc11869ce9ac145d89bec64084ab200be88e9a4ec38c6c8150e73546f",
  },
  anchor: {
    path: resolve(option("--anchor-wasm")),
    hash: "e6ff58f1115fbdf71488caf2599f74e12e72dc21ddea1c231b013cdce6a88828",
  },
};
const source =
  process.env.TR_ANCHOR_DEPLOYER_PUBLIC ??
  "GAZOT6YMKME6R7DYCLPUOI22IEQGCO5LX3ZJ24GOZ3NVPNPDIJQXCKKR";
const provider =
  process.env.TR_ANCHOR_PROVIDER_PUBLIC ??
  "GDAHV4MVSXLCR4ELY4JK3F6WNEQCONAZTLTKBGDJZARXBRGWMTTIMK22";
const bankNotary =
  process.env.TR_ANCHOR_NOTARY_PUBLIC ??
  "GCCDVX4UKCL36M3566XGK6HGTFINNSBKMG3DVCLKP2G3JCPIJL6IWUD2";
const token =
  process.env.TR_ANCHOR_TOKEN_CONTRACT ??
  "CDC35FLF2CZWYA2EFBMW4GCCL2BBYZZGXRZGLJLEAE5UR4CIDUA44OXE";
const policySeconds = Number(process.env.TR_ANCHOR_POLICY_SECONDS ?? "72000");
assert.ok(
  Number.isSafeInteger(policySeconds) &&
    policySeconds >= 3600 &&
    policySeconds <= 2592000,
  "Policy lifetime must be between one hour and 30 days"
);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const networkId = sha(Networks.TESTNET);
const server = new rpc.Server("https://soroban-testnet.stellar.org", {
  timeout: 15000,
});
const certificateRoot =
  "0230cf7904896615a2fab194d5d0e7115bce9749aaaf61805fea7aaf1c8200c0";
const circuitRoot =
  "1bcacb8abb52ef2834e4862b264e1209368ac8e006aa8512f6d62116e8657a46";
const sanctionsRoot =
  "2dfcc0ca426d9d8e751bb00fc9ab502bfb081ba8d2ce3f5f94a8f1712b3afca8";
const vkHash =
  "03dbb84b656cdf3b9f93d809c530b4c3901fe5be6f56c424a04ae827ebe45a08";
const configAt = (time, verifier) => ({
  provider,
  bank_notary: bankNotary,
  token,
  verifier,
  verifier_wasm_hash: artifacts.verifier.hash,
  verifier_vk_hash: vkHash,
  network_id: networkId,
  certificate_root: certificateRoot,
  circuit_root: circuitRoot,
  sanctions_root: sanctionsRoot,
  sanctions_strict: true,
  domain,
  scope: "tr-anchor-sep-synthetic-v1",
  min_age: 18,
  allowed_nationalities: ["5a4b52"],
  allowed_issuers: ["5a4b52"],
  proof_bytes: 10240,
  external_inputs: 13,
  max_proof_age: 3600,
  policy_valid_until: time + policySeconds,
  max_order_lifetime: 3600,
  max_amount: "100000000",
  max_try_minor: 50000,
});
function encodeConfig(config) {
  const addresses = new Set(["provider", "bank_notary", "token", "verifier"]);
  const bytes = new Set([
    "verifier_wasm_hash",
    "verifier_vk_hash",
    "network_id",
    "certificate_root",
    "circuit_root",
    "sanctions_root",
  ]);
  const wide = new Set([
    "max_proof_age",
    "policy_valid_until",
    "max_order_lifetime",
    "max_try_minor",
  ]);
  return xdr.ScVal.scvMap(
    Object.entries(config)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(
        ([key, value]) =>
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol(key),
            val: addresses.has(key)
              ? new Address(value).toScVal()
              : bytes.has(key)
                ? xdr.ScVal.scvBytes(Buffer.from(value, "hex"))
                : Array.isArray(value)
                  ? xdr.ScVal.scvVec(
                      value.map((v) =>
                        xdr.ScVal.scvBytes(Buffer.from(v, "hex"))
                      )
                    )
                  : typeof value === "boolean"
                    ? xdr.ScVal.scvBool(value)
                    : key === "max_amount"
                      ? nativeToScVal(BigInt(value), { type: "i128" })
                      : typeof value === "string"
                        ? nativeToScVal(value, { type: "string" })
                        : nativeToScVal(BigInt(value), {
                            type: wide.has(key) ? "u64" : "u32",
                          }),
          })
      )
  );
}
function contractId(salt) {
  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId: Buffer.from(networkId, "hex"),
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new xdr.ContractIdPreimageFromAddress({
          address: new Address(source).toScAddress(),
          salt: Buffer.from(salt, "hex"),
        })
      ),
    })
  );
  return StrKey.encodeContract(Buffer.from(sha(preimage.toXdr()), "hex"));
}
function save(report, first = false) {
  const temporary = first
    ? journalPath
    : `${journalPath}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(report, null, 2) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (!first) renameSync(temporary, journalPath);
  const parent = openSync(dirname(journalPath), "r");
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}
async function read(contract, method) {
  const draft = new TransactionBuilder(await server.getAccount(source), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(new Contract(contract).call(method))
    .setTimeout(120)
    .build();
  const response = await server.simulateTransaction(
    draft,
    undefined,
    "enforce"
  );
  assert.ok(
    rpc.Api.isSimulationSuccess(response) &&
      !rpc.Api.isSimulationRestore(response),
    `Cannot read ${method}`
  );
  return response.result.retval;
}
async function verifyCode(contract, artifact) {
  const instance = await server.getContractData(
    contract,
    xdr.ScVal.scvLedgerKeyContractInstance()
  );
  const executable =
    instance.val.toXdrObject().contractData.val.instance.executable;
  assert.equal(Buffer.from(executable.wasmHash).toString("hex"), artifact.hash);
  const code = await server.getLedgerEntries(
    xdr.LedgerKey.contractCode(
      new xdr.LedgerKeyContractCode({ hash: Buffer.from(artifact.hash, "hex") })
    )
  );
  assert.equal(code.entries.length, 1);
  assert.equal(
    sha(code.entries[0].val.toXdrObject().contractCode.code),
    artifact.hash
  );
}
async function preflight() {
  assert.equal((await server.getNetwork()).passphrase, Networks.TESTNET);
  for (const artifact of Object.values(artifacts))
    assert.equal(
      sha(readFileSync(artifact.path)),
      artifact.hash,
      "Artifact hash changed; review before deploying"
    );
  const require = createRequire(import.meta.url);
  const sdkRequire = createRequire(require.resolve("@zkpassport/sdk"));
  const { RegistryClient } = sdkRequire("@zkpassport/registry");
  const certificates = new RegistryClient({ chainId: 11155111 });
  const circuits = new RegistryClient({ chainId: 1 });
  const [certificate, circuit] = await Promise.all([
    certificates.getLatestCertificateRoot(),
    circuits.getLatestCircuitRoot(),
  ]);
  assert.equal(
    certificate.toLowerCase(),
    `0x${certificateRoot}`,
    "Certificate root changed"
  );
  assert.equal(
    circuit.toLowerCase(),
    `0x${circuitRoot}`,
    "Circuit root changed"
  );
  assert.ok(await certificates.isCertificateRootValid(certificate));
  assert.ok(await circuits.isCircuitRootValid(circuit));
  const response = await fetch(
    "https://cdn.zkpassport.id/sanctions/all_sanctions_tree.json.gz",
    { signal: AbortSignal.timeout(30000) }
  );
  assert.ok(response.ok, "Sanctions snapshot unavailable");
  const body = Buffer.from(await response.arrayBuffer());
  const tree = JSON.parse(
    (body[0] === 31 ? gunzipSync(body) : body).toString()
  );
  assert.deepEqual(
    tree.at(-1),
    [`0x${sanctionsRoot}`],
    "Sanctions root changed"
  );
  return {
    checked_at: new Date().toISOString(),
    sanctions_last_modified: response.headers.get("last-modified"),
    sanctions_check:
      "CDN snapshot root, not proof of current sanctions compliance",
  };
}
async function action(report, label, operation, expected) {
  const feeCap = label.startsWith("upload-") ? 200000000n : 10000000n;
  let record = report.actions.find((a) => a.label === label);
  const planned = Operation.fromXdrObject(operation);
  if (!record) {
    const ledger = await server.getLatestLedger();
    const draft = new TransactionBuilder(await server.getAccount(source), {
      fee: "1000",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(operation)
      .setTimebounds(
        Number(ledger.closeTime) - 5,
        Number(ledger.closeTime) + 180
      )
      .build();
    const simulation = await server.simulateTransaction(draft);
    assert.ok(
      rpc.Api.isSimulationSuccess(simulation) &&
        !rpc.Api.isSimulationRestore(simulation),
      `${label} simulation failed`
    );
    const tx = rpc.assembleTransaction(draft, simulation).build();
    assert.ok(BigInt(tx.fee) <= feeCap, "Fee exceeds the Testnet action cap");
    const key = Keypair.fromSecret(
      execFileSync(
        "stellar",
        [
          "keys",
          "secret",
          "zkpassport-native-testnet",
          "--config-dir",
          keyDirectory,
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
      ).trim()
    );
    assert.equal(key.publicKey(), source);
    tx.sign(key);
    record = {
      label,
      hash: Buffer.from(tx.hash()).toString("hex"),
      envelope: tx.toXdr(),
      status: "PREPARED",
    };
    report.actions.push(record);
    save(report);
  }
  const tx = TransactionBuilder.fromXdr(record.envelope, Networks.TESTNET);
  assert.ok(tx instanceof Transaction);
  assert.equal(tx.source, source);
  assert.equal(Buffer.from(tx.hash()).toString("hex"), record.hash);
  assert.equal(tx.operations.length, 1);
  assert.equal(tx.operations[0].type, "invokeHostFunction");
  assert.equal(
    tx.operations[0].func.toXdr("base64"),
    planned.func.toXdr("base64")
  );
  assert.ok(!tx.operations[0].source || tx.operations[0].source === source);
  assert.ok(
    !tx.operations[0].auth.some(
      (entry) => entry.credentials.type !== "sorobanCredentialsSourceAccount"
    )
  );
  assert.ok(BigInt(tx.fee) <= feeCap);
  assert.ok(
    tx.signatures.some((signature) =>
      Keypair.fromPublicKey(source).verify(tx.hash(), signature.signature)
    )
  );
  for (let attempt = 0; attempt < 24; attempt++) {
    const receipt = await server.getTransaction(record.hash);
    if (receipt.status === "SUCCESS") {
      const value = scValToNative(receipt.returnValue);
      assert.equal(
        typeof value === "string" ? value : Buffer.from(value).toString("hex"),
        expected
      );
      record.status = "SUCCESS";
      record.ledger = receipt.ledger;
      save(report);
      console.log(
        JSON.stringify({
          action: label,
          status: record.status,
          hash: record.hash,
          ledger: record.ledger,
        })
      );
      return;
    }
    assert.notEqual(
      receipt.status,
      "FAILED",
      `${label} failed onchain; retain journal for review`
    );
    if (record.status === "SUCCESS")
      throw new Error(`${label} receipt no longer available; do not resubmit`);
    const now = Number((await server.getLatestLedger()).closeTime);
    assert.ok(
      now < Number(tx.timeBounds.maxTime),
      `${label} envelope expired or outcome unknown; no replacement created`
    );
    if (attempt === 0) {
      record.status = "UNKNOWN";
      save(report);
      const sent = await server.sendTransaction(tx);
      record.send_status = sent.status;
      save(report);
      assert.notEqual(
        sent.status,
        "ERROR",
        `${label} rejected; retain journal for review`
      );
    }
    await delay(2000);
  }
  throw new Error(`${label} still pending; rerun to reconcile the same hash`);
}
async function main() {
  const check = await preflight();
  let report = existsSync(journalPath)
    ? JSON.parse(readFileSync(journalPath, "utf8"))
    : null;
  if (!execute) {
    console.log(
      JSON.stringify({
        mode: "check",
        artifacts_verified: true,
        roots_checked: check,
        journal_exists: !!report,
        submitted: false,
      })
    );
    return;
  }
  if (!report) {
    const salts = {
      verifier: randomBytes(32).toString("hex"),
      anchor: randomBytes(32).toString("hex"),
    };
    const contracts = {
      verifier: contractId(salts.verifier),
      anchor: contractId(salts.anchor),
    };
    const time = Number((await server.getLatestLedger()).closeTime);
    report = {
      schema: 1,
      network: "testnet",
      source,
      domain,
      salts,
      contracts,
      config: configAt(time, contracts.verifier),
      checks: check,
      actions: [],
    };
    save(report, true);
  }
  assert.equal(report.schema, 1);
  assert.equal(report.network, "testnet");
  assert.equal(report.source, source);
  assert.equal(report.domain, domain);
  for (const name of ["verifier", "anchor"])
    assert.equal(report.contracts[name], contractId(report.salts[name]));
  assert.deepEqual(
    report.config,
    configAt(
      report.config.policy_valid_until - policySeconds,
      report.contracts.verifier
    )
  );
  for (const name of ["verifier", "anchor"]) {
    await action(
      report,
      `upload-${name}`,
      Operation.uploadContractWasm({
        wasm: readFileSync(artifacts[name].path),
      }),
      artifacts[name].hash
    );
    if (name === "anchor")
      assert.ok(
        report.config.policy_valid_until >
          Number((await server.getLatestLedger()).closeTime)
      );
    await action(
      report,
      `deploy-${name}`,
      Operation.createCustomContract({
        address: new Address(source),
        wasmHash: Buffer.from(artifacts[name].hash, "hex"),
        salt: Buffer.from(report.salts[name], "hex"),
        constructorArgs: name === "anchor" ? [encodeConfig(report.config)] : [],
      }),
      report.contracts[name]
    );
    await verifyCode(report.contracts[name], artifacts[name]);
    if (name === "verifier") {
      const profile = scValToNative(
        await read(report.contracts.verifier, "profile")
      );
      assert.equal(profile.external_inputs, 13);
      assert.equal(profile.proof_bytes, 10240);
      assert.equal(profile.log_n, 23);
      assert.equal(Buffer.from(profile.vk_hash).toString("hex"), vkHash);
    }
  }
  assert.equal(
    (await read(report.contracts.anchor, "get_config")).toXdr("base64"),
    encodeConfig(report.config).toXdr("base64")
  );
  report.policy_hash = Buffer.from(
    scValToNative(await read(report.contracts.anchor, "get_policy_hash"))
  ).toString("hex");
  report.deployment_verified_at = new Date().toISOString();
  report.fresh_phone_proof_verified = false;
  save(report);
  console.log(
    JSON.stringify({
      verified: true,
      contracts: report.contracts,
      policy_hash: report.policy_hash,
      fresh_phone_proof_verified: false,
    })
  );
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
