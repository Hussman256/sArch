/**
 * Follows the chain: reads each finalized block in order and stores what the
 * launchpad programs did in it.
 *
 * Only finalized blocks are read. A block above the finalized height can
 * still change, and waiting for it costs about a second.
 */
import type { ArchRpc, ProgramIds } from "@archpad/sdk";
import { type Db, getMeta, setMeta } from "./db.ts";
import { type IngestContext, type Notification, applyBlock, isRelevant } from "./ingest.ts";

export interface FollowerOptions {
  programs: ProgramIds;
  /** First block to read on a fresh database. */
  startHeight: number;
  loadCoin: IngestContext["loadCoin"];
  /** Blocks fetched per request while catching up. */
  batchSize?: number;
  /** How long to wait for a new block once caught up, in milliseconds. */
  pollMs?: number;
  /** Called after a block is stored, with what happened in it. */
  onNotifications?: (notes: Notification[]) => void;
  /**
   * What to do when the database turns out to have been built from a
   * different chain than the node is serving. "fail" (the default) stops
   * with an explanation. "reindex" empties the database and starts again,
   * which is what a local chain that gets reset now and then wants.
   */
  onChainChanged?: "fail" | "reindex";
  log?: (line: string) => void;
}

/** The database was built from a different chain than the node is serving. */
export class ChainChangedError extends Error {
  override readonly name = "ChainChangedError";
}

const CURSOR = "cursor";
/** `<height>:<hash>` of the first block this database indexed. */
const ANCHOR = "anchor";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class Follower {
  private readonly context: IngestContext;
  private readonly batchSize: number;
  private readonly pollMs: number;
  private running = false;
  private loop: Promise<void> | undefined;
  private loaded = false;
  private anchored = false;
  /** Height of the last block stored, or one below the start on a fresh database. */
  private cursor = -1;
  /** The chain's finalized height as last seen. */
  finalizedHeight = 0;

  constructor(
    private readonly db: Db,
    private readonly rpc: ArchRpc,
    private readonly options: FollowerOptions,
  ) {
    this.context = { programs: options.programs, loadCoin: options.loadCoin };
    this.batchSize = options.batchSize ?? 50;
    this.pollMs = options.pollMs ?? 300;
  }

  /** Height of the last block stored. */
  get height(): number {
    return this.cursor;
  }

  private async loadCursor(): Promise<void> {
    // A database is only worth anything against the chain it was built
    // from. Its first indexed block is remembered by hash; if the node now
    // has a different block at that height, or none, this is another chain
    // (a reset test network, or the wrong RPC address).
    const anchor = await getMeta(this.db, ANCHOR);
    if (anchor !== null) {
      const [height = "", hash = ""] = anchor.split(":");
      const current = await this.rpc.getBlockHash(Number(height)).catch(() => null);
      if (current === hash) {
        this.anchored = true;
      } else if (this.options.onChainChanged === "reindex") {
        this.options.log?.("the chain is not the one this database was built from; indexing it from the start");
        await this.db.query("TRUNCATE coins, trades, payouts RESTART IDENTITY");
        await this.db.query("DELETE FROM meta WHERE key IN ('cursor', 'anchor')");
      } else {
        throw new ChainChangedError(
          `this database was built from a different chain: block ${height} is no longer ${hash.slice(0, 12)}…. ` +
            "Point DATABASE_URL at an empty database to index this chain, or check ARCH_RPC_URL.",
        );
      }
    }
    const stored = await getMeta(this.db, CURSOR);
    this.cursor = stored === null ? this.options.startHeight - 1 : Number(stored);
  }

  /**
   * Reads whatever finalized blocks are waiting. Returns how many blocks the
   * cursor moved, which is zero once caught up.
   */
  async catchUp(): Promise<number> {
    if (!this.loaded) {
      await this.loadCursor();
      this.loaded = true;
    }

    this.finalizedHeight = await this.rpc.getFinalizedHeight();
    const from = this.cursor + 1;
    const to = Math.min(this.finalizedHeight, from + this.batchSize - 1);
    if (to < from) return 0;

    const heights = Array.from({ length: to - from + 1 }, (_, i) => from + i);
    const blocks = await this.rpc.getFullBlocks(heights);

    let moved = 0;
    let unsaved = false;
    for (const [i, block] of blocks.entries()) {
      // A node can report a height it cannot serve yet. Stop and come back.
      if (!block) break;
      if (block.height !== heights[i]) throw new Error(`asked for block ${heights[i]}, got ${block.height}`);

      if (isRelevant(block, this.options.programs)) {
        // The block and the cursor that marks it done go in together.
        const notes = await this.db.transaction(async (tx) => {
          const applied = await applyBlock(tx, block, this.context);
          await setMeta(tx, CURSOR, String(block.height));
          return applied;
        });
        unsaved = false;
        this.cursor = block.height;
        if (notes.length > 0) this.options.onNotifications?.(notes);
      } else {
        // Most blocks hold nothing of ours. Skip them without a write each.
        this.cursor = block.height;
        unsaved = true;
      }
      moved++;
    }
    if (unsaved) await setMeta(this.db, CURSOR, String(this.cursor));
    if (!this.anchored && moved > 0) {
      await setMeta(this.db, ANCHOR, `${from}:${await this.rpc.getBlockHash(from)}`);
      this.anchored = true;
    }
    return moved;
  }

  /** Starts following in the background. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = (async () => {
      let failures = 0;
      while (this.running) {
        try {
          const moved = await this.catchUp();
          failures = 0;
          // Behind: go again at once. Caught up: wait for the next block.
          if (moved < this.batchSize) await sleep(this.pollMs);
        } catch (error) {
          if (error instanceof ChainChangedError) {
            // Retrying cannot fix this; say so once and stop.
            this.options.log?.(`indexing stopped: ${error.message}`);
            this.running = false;
            return;
          }
          failures++;
          this.options.log?.(`indexing paused by an error, retrying: ${(error as Error).message}`);
          await sleep(Math.min(30_000, 500 * 2 ** Math.min(failures, 6)));
        }
      }
    })();
  }

  /** Stops following and waits for the block in hand to finish. */
  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
  }
}
