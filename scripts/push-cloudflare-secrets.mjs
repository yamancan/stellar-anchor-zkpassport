import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const position = process.argv.indexOf("--keys");
if (position < 0 || !process.argv[position + 1])
  throw new Error(
    "Usage: node scripts/push-cloudflare-secrets.mjs --keys PATH"
  );
const keyDirectory = resolve(process.argv[position + 1]);

function secret(identity) {
  return execFileSync(
    "stellar",
    [
      "keys",
      "secret",
      identity,
      "--config-dir",
      keyDirectory,
      "--quiet",
      "--no-cache",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  ).trim();
}

const jwtPath = resolve(dirname(keyDirectory), "jwt-secret");
if (!existsSync(jwtPath))
  writeFileSync(jwtPath, randomBytes(48).toString("base64url"), {
    mode: 0o600,
  });

const provider = secret("sep-anchor-provider-v1");
const values = {
  TREASURY_SECRET: provider,
  SEP_ANCHOR_PROVIDER_SECRET: provider,
  SEP_ANCHOR_BANK_NOTARY_SECRET: secret("anchor-gate-bank-notary-v1"),
  ANCHOR_SIGNING_SECRET: secret("cloudflare-anchor-signing"),
  JWT_SECRET: readFileSync(jwtPath, "utf8").trim(),
};

for (const [name, value] of Object.entries(values)) {
  try {
    execFileSync("wrangler", ["secret", "put", name], {
      input: `${value}\n`,
      stdio: ["pipe", "ignore", "pipe"],
    });
    console.log(`${name}: configured`);
  } catch {
    throw new Error(`Could not configure Cloudflare secret ${name}`);
  }
}
