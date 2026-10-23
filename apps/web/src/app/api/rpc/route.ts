/**
 * Forwards the browser's chain requests to the Arch node.
 *
 * The browser cannot call the node directly (different origin, and in
 * production the node's address may carry an API key). Only the methods the
 * app uses are let through, and the one expensive method only for the one
 * program the app needs it for.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { addressToBytes } from "@archpad/sdk";
import { API_URL } from "@/lib/api.ts";

function defaultRpcUrl(): string {
  if (process.env["ARCH_RPC_URL"]) return process.env["ARCH_RPC_URL"];
  try {
    const dir = dirname(fileURLToPath(import.meta.url));
    const repoRoot = join(dir, "..", "..", "..", "..", "..");
    const testnetFile = join(repoRoot, "deploy", "testnet.json");
    if (existsSync(testnetFile)) {
      const deploy = JSON.parse(readFileSync(testnetFile, "utf8")) as { rpcUrl?: string };
      if (deploy.rpcUrl) return deploy.rpcUrl;
    }
  } catch {}
  return "http://127.0.0.1:9002";
}

const RPC_URL = defaultRpcUrl();
const MAX_BODY_BYTES = 256 * 1024;
const MAX_BATCH = 50;

const ALLOWED = new Set([
  "is_node_ready",
  "get_version",
  "get_block_count",
  "get_block_hash",
  "get_block",
  "get_block_by_height",
  "get_best_block_hash",
  "get_best_finalized_block_hash",
  "read_account_info",
  "get_multiple_accounts",
  "get_program_accounts",
  "get_processed_transaction",
  "send_transaction",
]);

const refuse = (status: number, message: string) =>
  Response.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message } }, { status });

/**
 * The config program's ID, as the node writes it: 32 numbers. Listing a
 * program's accounts makes the node scan, so the app may only do it for this
 * program, whose accounts are the admin proposals. Asked of the API and
 * remembered for a minute.
 */
let configProgram: { at: number; key: string } | undefined;
async function configProgramKey(): Promise<string | null> {
  if (configProgram && Date.now() - configProgram.at < 60_000) return configProgram.key;
  try {
    const response = await fetch(`${API_URL}/v1/network`, { signal: AbortSignal.timeout(5_000), cache: "no-store" });
    if (!response.ok) return null;
    const { programs } = (await response.json()) as { programs: { config: string } };
    configProgram = { at: Date.now(), key: Array.from(addressToBytes(programs.config)).join(",") };
    return configProgram.key;
  } catch {
    return null;
  }
}

export async function POST(request: Request): Promise<Response> {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return refuse(413, "request too large");

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return refuse(400, "request is not JSON");
  }
  const calls = Array.isArray(body) ? body : [body];
  if (calls.length === 0 || calls.length > MAX_BATCH) return refuse(400, "empty or oversized batch");
  for (const call of calls) {
    const { method, params } = (call ?? {}) as { method?: unknown; params?: unknown };
    if (typeof method !== "string" || !ALLOWED.has(method)) return refuse(403, "method not allowed");
    if (method === "get_program_accounts") {
      const program = Array.isArray(params) && Array.isArray(params[0]) ? params[0].join(",") : "";
      const allowed = await configProgramKey();
      if (allowed === null || program !== allowed) return refuse(403, "program accounts may only be listed for the config program");
    }
  }

  try {
    const upstream = await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: text,
      signal: AbortSignal.timeout(20_000),
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  } catch {
    return refuse(502, "the Arch node did not answer");
  }
}
