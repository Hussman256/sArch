/**
 * Starts the indexer and its API.
 *
 *   pnpm --filter @archpad/indexer start
 *
 * Settings come from the environment:
 *
 *   ARCHPAD_NETWORK   localnet (default), testnet or mainnet. Picks deploy/<network>.json,
 *                     which `pnpm ops bootstrap` writes.
 *   ARCH_RPC_URL      Arch node to read from. Defaults to the one in the deployment file.
 *   DATABASE_URL      postgres://... or pglite:<directory>. Defaults to an embedded
 *                     database under .data/.
 *   DATA_DIR          Where uploads are kept. Defaults to .data/uploads-<network>.
 *   HOST, PORT        Where to listen. Defaults to 127.0.0.1:8787.
 *   PUBLIC_URL        Where browsers reach this API. Defaults to http://localhost:<PORT>.
 *   CORS_ORIGIN       Comma-separated origins allowed to call the API. Defaults to any.
 *   START_HEIGHT      First block to index on a fresh database. Defaults to the
 *                     deployment's.
 *
 * On a local chain it also offers a faucet, so a wallet in the browser can be
 * given test funds without the command line.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Address, type ProgramIds, ArchRpc, ArchpadClient, systemTransfer } from "@archpad/sdk";
import type { QuoteInfo } from "./api.ts";
import { startService } from "./service.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

interface DeploymentFile {
  network: string;
  rpcUrl: string;
  bitcoinNetwork: string;
  programs: ProgramIds;
  quotes: QuoteInfo[];
  startHeight: number;
}

const env = (name: string): string | undefined => process.env[name] || undefined;

/**
 * A faucet for a local chain: the public development key pays lamports and
 * mints test assets. Returns undefined anywhere else, or if the development
 * keys are not present.
 */
async function localFaucet(deployment: DeploymentFile, rpcUrl: string) {
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(new URL(rpcUrl).hostname);
  if (deployment.network !== "localnet" || !local) return undefined;
  if (!existsSync(join(REPO_ROOT, "keys", "dev", "authority.key"))) return undefined;

  const { fundFromFaucet, loadKeySet, mintTestTokens } = await import("@archpad/ops");
  const authority = loadKeySet("dev").authority;
  const rpc = new ArchRpc(rpcUrl);
  const client = new ArchpadClient(rpc, { programIds: deployment.programs });
  // One request at a time: they are all paid for by the same account.
  let queue: Promise<unknown> = Promise.resolve();

  return (wallet: Address): Promise<void> => {
    const run = queue.then(async () => {
      await fundFromFaucet(rpc, authority, 20_000_000n);
      await client.sendAndConfirm([systemTransfer(authority.address, wallet, 5_000_000n)], [authority]);
      for (const quote of deployment.quotes) {
        // One whole test bitcoin, ten thousand test dollars.
        const units = quote.symbol === "BTC" ? 1n : 10_000n;
        await mintTestTokens(client, authority, quote.mint, wallet, units * 10n ** BigInt(quote.decimals));
      }
    });
    queue = run.catch(() => undefined);
    return run;
  };
}

async function main(): Promise<void> {
  const network = env("ARCHPAD_NETWORK") ?? "localnet";
  const path = join(REPO_ROOT, "deploy", `${network}.json`);
  if (!existsSync(path)) {
    throw new Error(`${path} not found: run \`pnpm ops bootstrap --network ${network}\` first`);
  }
  const deployment = JSON.parse(readFileSync(path, "utf8")) as DeploymentFile;

  const port = Number(env("PORT") ?? 8787);
  const host = env("HOST") ?? "127.0.0.1";
  const log = (line: string) => console.log(`[indexer] ${line}`);
  const rpcUrl = env("ARCH_RPC_URL") ?? deployment.rpcUrl;
  const devFaucet = await localFaucet(deployment, rpcUrl);

  const service = await startService({
    network: deployment.network,
    bitcoinNetwork: deployment.bitcoinNetwork,
    rpcUrl,
    programs: deployment.programs,
    quotes: deployment.quotes,
    startHeight: Number(env("START_HEIGHT") ?? deployment.startHeight),
    databaseUrl: env("DATABASE_URL") ?? `pglite:${join(REPO_ROOT, ".data", `indexer-${network}`)}`,
    dataDir: env("DATA_DIR") ?? join(REPO_ROOT, ".data", `uploads-${network}`),
    publicUrl: env("PUBLIC_URL") ?? `http://localhost:${port}`,
    ...(env("CORS_ORIGIN") && { corsOrigin: env("CORS_ORIGIN")!.split(",").map((origin) => origin.trim()) }),
    ...(devFaucet && { devFaucet }),
    // A test chain gets wiped and restarted; follow it rather than stop.
    onChainChanged: deployment.network === "mainnet" ? "fail" : "reindex",
    log,
  });

  await service.api.app.listen({ host, port });
  log(`${deployment.network}: API on http://${host}:${port}, reading ${rpcUrl}`);
  if (devFaucet) log("local test faucet enabled at POST /v1/dev/fund");

  // Say how far behind we are while catching up, then go quiet.
  const report = setInterval(() => {
    const { height, finalizedHeight } = service.follower;
    const behind = finalizedHeight - height;
    if (behind > 100) log(`catching up: block ${height} of ${finalizedHeight}`);
  }, 10_000);

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    clearInterval(report);
    log("stopping");
    await service.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  console.error(`[indexer] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
