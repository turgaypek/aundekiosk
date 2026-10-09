import { createStaticHandler } from "./static.ts";
import { createConfigApi } from "./config_api.ts";

// import.meta.dirname (not new URL(...).pathname) because on Windows a
// file:// URL's pathname keeps a leading slash before the drive letter
// (e.g. "/C:/..."), which is not a path Deno.realPathSync can resolve.
const DEFAULT_PUBLIC_DIR = `${import.meta.dirname}/public`;
const DEFAULT_CONFIG_PATH = "/opt/aundekiosk/config.json";
const DEFAULT_SAMPLE_PATH = `${import.meta.dirname}/../config.json.sample`;

export interface HandlerOptions {
  configPath?: string;
  samplePath?: string;
  publicDir?: string;
}

export function createHandler(options: HandlerOptions = {}) {
  const publicDir = options.publicDir ?? DEFAULT_PUBLIC_DIR;
  const configPath = options.configPath ?? Deno.env.get("AUNDEKIOSK_CONFIG_FILE") ?? DEFAULT_CONFIG_PATH;
  const samplePath = options.samplePath ?? DEFAULT_SAMPLE_PATH;

  const serveStatic = createStaticHandler(publicDir);
  const configApi = createConfigApi({ configPath, samplePath });

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/config") {
      if (req.method === "GET") return configApi.handleGet();
      if (req.method === "POST") return configApi.handlePost(req);
      return new Response("Method Not Allowed", { status: 405 });
    }

    return serveStatic(url.pathname);
  };
}

if (import.meta.main) {
  const port = Number(Deno.env.get("PORT") ?? "8080");
  console.log(`AundeKiosk dashboard starting on port ${port}...`);
  Deno.serve({ port }, createHandler());
}
