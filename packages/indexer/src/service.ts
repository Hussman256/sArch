/**
 * Wires the pieces into one running service: database, chain follower and
 * API. `main.ts` starts it from environment variables; tests start it
 * directly with their own settings.
 */
import { type Address, type ProgramIds, ArchRpc, ArchpadClient } from "@archpad/sdk";
import { type Api, type QuoteInfo, buildApi } from "./api.ts";
import { type Db, openDb } from "./db.ts";
import { Follower } from "./follower.ts";
import { UploadStore } from "./uploads.ts";

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

  follower = new Follower(db, rpc, {
    programs: options.programs,
    startHeight: options.startHeight,
    loadCoin: async (mint: Address) => {
      const coin = await client.getCoin(mint);
      return coin ? { curve: coin.curve, metadata: coin.metadata } : null;
    },
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
