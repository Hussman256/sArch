/**
 * Wires the pieces into one running service: database, chain follower and
 * API. `main.ts` starts it from environment variables; tests start it
 * directly with their own settings.
 */
import { type Address, type ProgramIds, ArchRpc, ArchpadClient, decodeCurve } from "@archpad/sdk";
import { type Api, type QuoteInfo, buildApi } from "./api.ts";
import { type Db, openDb } from "./db.ts";
import { Follower } from "./follower.ts";
import { UploadStore } from "./uploads.ts";
import { ensureCoin } from "./ingest.ts";

export interface ServiceOptions {
  network: string;
  bitcoinNetwork: string;
  rpcUrl: string;
  programs: ProgramIds;
  quotes: QuoteInfo[];
  /** First block to index on a fresh database. */
  startHeight: number;
  /** `postgres://...`, `pglite:<directory>`, or `pglite:` for an in-memory database. */
  databaseUrl: string;
  /** Where uploaded images and metadata documents are kept. */
  dataDir: string;
  /** Where the API is reachable from a browser. */
  publicUrl: string;
  corsOrigin?: string[];
  /** See `FollowerOptions.onChainChanged`. */
  onChainChanged?: "fail" | "reindex";
  /** Local chains only: see `ApiOptions.devFaucet`. */
  devFaucet?: (wallet: Address) => Promise<void>;
  logger?: boolean;
  log?: (line: string) => void;
}

export interface Service {
  api: Api;
  db: Db;
  follower: Follower;
  client: ArchpadClient;
  /** Stops following the chain and closes the server and the database. */
  close(): Promise<void>;
}

export async function startService(options: ServiceOptions): Promise<Service> {
  const rpc = new ArchRpc(options.rpcUrl);
  const client = new ArchpadClient(rpc, { programIds: options.programs });
  const db = await openDb(options.databaseUrl);

  // The API is built before the follower so the follower can hand it what it finds.
  let follower: Follower | undefined;
  const api = await buildApi({
    db,
    client,
    uploads: new UploadStore(options.dataDir),
    network: options.network,
    bitcoinNetwork: options.bitcoinNetwork,
    programs: options.programs,
    quotes: options.quotes,
    publicUrl: options.publicUrl,
    progress: () => ({ height: follower?.height ?? -1, finalizedHeight: follower?.finalizedHeight ?? 0 }),
    ...(options.corsOrigin && { corsOrigin: options.corsOrigin }),
    ...(options.devFaucet && { devFaucet: options.devFaucet }),
    ...(options.logger !== undefined && { logger: options.logger }),
  });

  const loadCoin = async (mint: Address) => {
    const coin = await client.getCoin(mint);
    return coin ? { curve: coin.curve, metadata: coin.metadata } : null;
  };

  const hiddenMints = new Set([
    "8wYMr72kKBejLA58pWyfcK7H9639PjudQTsz8VwqStU5", // duplicate Cactus Hands
    "4CbZAkwe6Z4E22wwbxoUKLshF3aLN8RK4wNEvFCY1tS9", // duplicate Archpad Genesis
  ]);

  // Purge any hidden coins from the database
  for (const hidden of hiddenMints) {
    try {
      await db.query("DELETE FROM coins WHERE mint = $1", [hidden]);
    } catch {
      // Ignore
    }
  }

  // Ensure historical coins are present even if launched before the sync cursor
  const knownMints = [
    "AiUNL95dfsVG8pozNUQ5mMHsYh3oD9mtGkuey1YWgmf9", // Rio
    "JD26RJ1sd6yexjuLBsaTWvCN4Ea88tHsZXGRf73mpwxW", // Cactus Hands
    "3amFQSPiuGLarsSWpCeSmU9CXaXkgZ5yhVsYRvjXu7Kd", // Archpad Genesis
  ];
  const historical = new Set<string>(knownMints);
  try {
    const accounts = await rpc.getProgramAccounts(options.programs.launch);
    for (const acc of accounts) {
      try {
        const curve = decodeCurve(acc.account.data);
        if (curve?.mint && !hiddenMints.has(curve.mint)) historical.add(curve.mint);
      } catch {
        // Not a curve account
      }
    }
  } catch {
    // If dynamic program accounts query fails, knownMints fallback is used
  }

  for (const mint of historical) {
    if (hiddenMints.has(mint)) continue;
    try {
      const details = await loadCoin(mint);
      if (details) {
        await ensureCoin(db, { programs: options.programs, loadCoin }, mint);
      }
    } catch {
      // Ignore
    }
  }

  follower = new Follower(db, rpc, {
    programs: options.programs,
    startHeight: options.startHeight,
    loadCoin,
    ...(options.onChainChanged && { onChainChanged: options.onChainChanged }),
    onNotifications: (notes) => {
      api.publish(notes).catch((error: Error) => options.log?.(`could not publish to the stream: ${error.message}`));
    },
    ...(options.log && { log: options.log }),
  });
  follower.start();

  const running = follower;
  return {
    api,
    db,
    follower: running,
    client,
    async close() {
      await running.stop();
      await api.app.close();
      await db.close();
    },
  };
}
