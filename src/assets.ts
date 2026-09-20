import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

export interface AssetStore {
  fetch(path: string): Promise<Response>;
}

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
};

export function nodeAssets(directory: string): AssetStore {
  return {
    async fetch(path) {
      const relative = normalize(path).replace(/^[/\\]+/, "");
      if (
        relative === ".." ||
        relative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
      )
        return new Response("Invalid path", { status: 400 });
      try {
        return new Response(
          new Uint8Array(await readFile(join(directory, relative))),
          {
            headers: {
              "Content-Type":
                contentTypes[extname(relative).toLowerCase()] ??
                "application/octet-stream",
            },
          }
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return new Response("Not found", { status: 404 });
        throw error;
      }
    },
  };
}

export async function assetText(
  assets: AssetStore,
  path: string
): Promise<string> {
  const response = await assets.fetch(path);
  if (!response.ok)
    throw new Error(`Asset ${path} returned ${response.status}`);
  return response.text();
}
