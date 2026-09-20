import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildAnchorGateBrowser } from "../scripts/build-anchor-gate.js";
import { anchorGateBrowserRoutes } from "../src/anchor-gate-browser.js";

const fonts = [
  {
    name: "playfair-display.ttf",
    sha256: "c40f2293766a503bc70cce9e512ef844a4ccb7cbcde792fe2ea31d191917d8d6",
  },
  {
    name: "playfair-display-italic.ttf",
    sha256: "a5e26dc5e2e77fb2803a0bf02fd4f81ee136ec8dea863ccdb0c59a263b21378b",
  },
  {
    name: "ibm-plex-sans.ttf",
    sha256: "3b031aa4216174205bd8471f88a49b91f093169e9e87bd5262242bc5967fe2e3",
  },
  {
    name: "ibm-plex-mono.ttf",
    sha256: "6a3412f058c7d8dfd9170c41e85ade48e5156ecb89356110ca57a0a27734af46",
  },
];

function expectAssetHeaders(response: Response) {
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  const policy = response.headers.get("Content-Security-Policy");
  expect(policy).toContain("default-src 'self'");
  expect(policy).toContain("frame-ancestors 'none'");
  expect(policy).toContain("object-src 'none'");
  expect(policy).toContain("base-uri 'none'");
}

describe("production-built native gate stylesheet and fonts", () => {
  let directory: string;
  let app: ReturnType<typeof anchorGateBrowserRoutes>;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "anchor-gate-assets-"));
    await buildAnchorGateBrowser(directory);
    app = anchorGateBrowserRoutes("https://anchor.example", directory);
  });

  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("preserves the approved Pre-KYC branding in the hosted exchange", async () => {
    const html = await readFile(join(directory, "sep-anchor.html"), "utf8");
    expect(html).toContain('href="/anchor">Pre-KYC<span>.</span>');
    expect(html).not.toContain(">pre-kyc<span>");
    // The upstream credit is not branding and stays put.
    expect(html).toContain("Kaan's TR Mock Anchor");
  });

  it("serves the built stylesheet with same-origin font references and security headers", async () => {
    const response = await app.request(
      "https://anchor.example/anchor-gate/style.css"
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "text/css; charset=utf-8"
    );
    expectAssetHeaders(response);
    const stylesheet = await response.text();
    for (const font of fonts)
      expect(stylesheet).toContain(`/anchor-gate/fonts/${font.name}`);
    expect(stylesheet).not.toMatch(/@import|https?:\/\//i);
  });

  it.each(fonts)(
    "serves pinned $name bytes with the correct MIME type",
    async (font) => {
      const response = await app.request(
        `https://anchor.example/anchor-gate/fonts/${font.name}`
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("font/ttf");
      expectAssetHeaders(response);
      const bytes = Buffer.from(await response.arrayBuffer());
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(
        font.sha256
      );
    }
  );

  it("rejects stylesheet and font requests outside the configured host and port", async () => {
    for (const path of [
      "/anchor-gate/style.css",
      ...fonts.map((font) => `/anchor-gate/fonts/${font.name}`),
    ]) {
      for (const origin of [
        "https://other.example",
        "https://anchor.example:444",
      ]) {
        const response = await app.request(`${origin}${path}`);
        expect(response.status).toBe(403);
        expectAssetHeaders(response);
        expect(await response.text()).toBe("Use the configured anchor origin.");
      }
    }
  });

  it("refuses unknown and traversal-like filenames without exposing other build files", async () => {
    for (const filename of [
      "unknown.ttf",
      "README.md",
      "ibm-plex-sans-OFL.html",
      "..%2fanchor-gate.css",
      "%2e%2e%2fanchor-gate.js",
    ]) {
      const response = await app.request(
        `https://anchor.example/anchor-gate/fonts/${filename}`
      );
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("404 Not Found");
    }
  });
});
