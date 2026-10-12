/**
 * Turns a block into database rows.
 *
 * Everything here is driven by the events the programs record. A block is
 * applied inside one database transaction together with the cursor that marks
 * it done, so a crash can never leave half a block stored or apply one twice.
 */
import {
  type Address,
  type ArchpadEvent,
  type Curve,
  type FullBlock,
  type ProgramIds,
  type TokenMetadata,
  curveParams,
  graduationQuote,
  recordedEvents,
  transactionId,
} from "@archpad/sdk";
import type { Queryable } from "./db.ts";

/** What the chain says about a coin that never changes after launch. */
export interface CoinDetails {
  curve: Curve;
  metadata: TokenMetadata | null;
}

export interface IngestContext {
  programs: ProgramIds;
  /** Reads a coin's curve and metadata accounts. Null if the chain has no such coin. */
  loadCoin(mint: Address): Promise<CoinDetails | null>;
}

/** A trade as stored, in the shape the API serves. */
export interface TradeRecord {
  id: string;
  height: number;
  txid: string;
  mint: Address;
  trader: Address;
  /** "curve" before graduation, "pool" after. */
  venue: "curve" | "pool";
  side: "buy" | "sell";
  quoteAmount: string;
  tokenAmount: string;
  feeQuote: string;
  /** Price after the trade, in quote base units per token base unit. */
  price: number;
  timestamp: number;
}

/** Something that just happened, for anyone listening live. */
export type Notification =
  | { type: "coin"; mint: Address }
  | { type: "trade"; trade: TradeRecord }
  | { type: "graduated"; mint: Address; timestamp: number };

/** True when a block holds anything the indexer stores. */
export function isRelevant(block: FullBlock, programs: ProgramIds): boolean {
  return block.transactions.some((processed) => recordedEvents(processed, programs).length > 0);
}

const ratio = (quote: bigint, token: bigint): number => (token === 0n ? 0 : Number(quote) / Number(token));

interface Origin {
  height: number;
  txid: string;
  createdAt: bigint;
}

/**
 * Makes sure a coin has a row, creating it from the chain if not.
 *
 * `origin` is given when the coin's launch is the event being handled. Without
 * it the indexer has met a coin it did not see launch (it was started part
 * way through the chain's history) and fills in what the curve account says.
 */
async function ensureCoin(tx: Queryable, ctx: IngestContext, mint: Address, origin?: Origin): Promise<boolean> {
  const existing = await tx.query("SELECT 1 FROM coins WHERE mint = $1", [mint]);
  if (existing.length > 0) return false;

  const details = await ctx.loadCoin(mint);
  if (!details) throw new Error(`the chain has no curve for ${mint}, but an event names it`);
  const { curve, metadata } = details;
  const params = curveParams(curve);

  // A new row starts from the curve's opening reserves. The events that
  // follow, in order, bring it to wherever the coin is now.
  await tx.query(
    `INSERT INTO coins (
       mint, creator, quote_mint, name, symbol, image, description, metadata_hash,
       token_decimals, total_supply, curve_supply, initial_virtual_quote, initial_virtual_token,
       graduation_quote, platform_fee_bps, creator_fee_bps, pool_fee_bps,
       early_window_end, early_wallet_cap, created_at, created_height, created_txid,
       price_quote, price_token, real_quote, real_token
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8,
       $9, $10, $11, $12, $13,
       $14, $15, $16, $17,
       $18, $19, $20, $21, $22,
       $12, $13, 0, $11
     )`,
    [
      mint,
      curve.creator,
      curve.quoteMint,
      metadata?.name ?? "",
      metadata?.symbol ?? "",
      metadata?.image ?? "",
      metadata?.description ?? "",
      curve.metadataHash,
      curve.tokenDecimals,
      curve.totalSupply.toString(),
      curve.curveSupply.toString(),
      curve.initialVirtualQuote.toString(),
      curve.initialVirtualToken.toString(),
      graduationQuote(params).toString(),
      curve.platformFeeBps,
      curve.creatorFeeBps,
      curve.poolLpFeeBps + curve.poolPlatformFeeBps + curve.poolCreatorFeeBps,
      curve.earlyWindowEnd.toString(),
      curve.earlyWalletCap.toString(),
      (origin?.createdAt ?? curve.launchedAt).toString(),
      origin?.height ?? 0,
      origin?.txid ?? "",
    ],
  );
  return true;
}

interface Position {
  height: number;
  txIndex: number;
  instructionIndex: number;
  innerIndex: number;
  txid: string;
}

async function insertTrade(
  tx: Queryable,
  at: Position,
  trade: {
    mint: Address;
    trader: Address;
    onPool: boolean;
    isBuy: boolean;
    quoteAmount: bigint;
    tokenAmount: bigint;
    fee: bigint;
    price: number;
    timestamp: bigint;
  },
): Promise<TradeRecord> {
  const [row] = await tx.query<{ id: string }>(
    `INSERT INTO trades (
       height, tx_index, instruction_index, inner_index, txid, mint, trader,
       on_pool, is_buy, quote_amount, token_amount, fee_quote, price, timestamp
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING id::text AS id`,
    [
      at.height,
      at.txIndex,
      at.instructionIndex,
      at.innerIndex,
      at.txid,
      trade.mint,
      trade.trader,
      trade.onPool,
      trade.isBuy,
      trade.quoteAmount.toString(),
      trade.tokenAmount.toString(),
      trade.fee.toString(),
      trade.price,
      trade.timestamp.toString(),
    ],
  );
  return {
    id: row!.id,
    height: at.height,
    txid: at.txid,
    mint: trade.mint,
    trader: trade.trader,
    venue: trade.onPool ? "pool" : "curve",
    side: trade.isBuy ? "buy" : "sell",
    quoteAmount: trade.quoteAmount.toString(),
    tokenAmount: trade.tokenAmount.toString(),
    feeQuote: trade.fee.toString(),
    price: trade.price,
    timestamp: Number(trade.timestamp),
  };
}

async function applyEvent(
  tx: Queryable,
  ctx: IngestContext,
  event: ArchpadEvent,
  at: Position,
  notes: Notification[],
): Promise<void> {
  switch (event.type) {
    case "CoinCreated": {
      const created = await ensureCoin(tx, ctx, event.mint, {
        height: at.height,
        txid: at.txid,
        createdAt: event.timestamp,
      });
      if (created) notes.push({ type: "coin", mint: event.mint });
      return;
    }

    case "Trade": {
      await ensureCoin(tx, ctx, event.mint);
      const fee = event.platformFee + event.creatorFee;
      const trade = await insertTrade(tx, at, {
        mint: event.mint,
        trader: event.trader,
        onPool: false,
        isBuy: event.isBuy,
        quoteAmount: event.quoteAmount,
        tokenAmount: event.tokenAmount,
        fee,
        price: ratio(event.virtualQuote, event.virtualToken),
        timestamp: event.timestamp,
      });
      await tx.query(
        `UPDATE coins SET
           price_quote = $2, price_token = $3, real_quote = $4, real_token = $5,
           trade_count = trade_count + 1, volume_quote = volume_quote + $6, last_trade_at = $7,
           creator_fees = creator_fees + $8, platform_fees = platform_fees + $9
         WHERE mint = $1`,
        [
          event.mint,
          event.virtualQuote.toString(),
          event.virtualToken.toString(),
          event.realQuote.toString(),
          event.realToken.toString(),
          event.quoteAmount.toString(),
          event.timestamp.toString(),
          event.creatorFee.toString(),
          event.platformFee.toString(),
        ],
      );
      notes.push({ type: "trade", trade });
      return;
    }

    case "Graduated": {
      await ensureCoin(tx, ctx, event.mint);
      // From here the pool's reserves set the price.
      await tx.query(
        "UPDATE coins SET graduated_at = $2, price_quote = $3, price_token = $4, real_token = 0 WHERE mint = $1",
        [event.mint, event.timestamp.toString(), event.quoteAmount.toString(), event.tokenAmount.toString()],
      );
      notes.push({ type: "graduated", mint: event.mint, timestamp: Number(event.timestamp) });
      return;
    }

    case "PoolSwap": {
      const created = await ensureCoin(tx, ctx, event.mint);
      const fee = event.lpFee + event.platformFee + event.creatorFee;
      const trade = await insertTrade(tx, at, {
        mint: event.mint,
        trader: event.trader,
        onPool: true,
        isBuy: event.isBuy,
        quoteAmount: event.quoteAmount,
        tokenAmount: event.tokenAmount,
        fee,
        price: ratio(event.quoteReserve, event.tokenReserve),
        timestamp: event.timestamp,
      });
      await tx.query(
        `UPDATE coins SET
           price_quote = $2, price_token = $3,
           trade_count = trade_count + 1, volume_quote = volume_quote + $4, last_trade_at = $5,
           creator_fees = creator_fees + $6, platform_fees = platform_fees + $7,
           -- A pool swap on a coin first met here means it graduated before
           -- this indexer was watching.
           graduated_at = CASE WHEN $8::boolean AND graduated_at IS NULL THEN $5 ELSE graduated_at END,
           real_token = CASE WHEN $8::boolean THEN 0 ELSE real_token END
         WHERE mint = $1`,
        [
          event.mint,
          event.quoteReserve.toString(),
          event.tokenReserve.toString(),
          event.quoteAmount.toString(),
          event.timestamp.toString(),
          event.creatorFee.toString(),
          event.platformFee.toString(),
          created,
        ],
      );
      notes.push({ type: "trade", trade });
      return;
    }

    case "CreatorFeesClaimed": {
      await ensureCoin(tx, ctx, event.mint);
      await tx.query(
        `INSERT INTO payouts (height, txid, mint, quote_mint, recipient, amount, timestamp)
         SELECT $1, $2, mint, quote_mint, $3, $4, $5 FROM coins WHERE mint = $6`,
        [at.height, at.txid, event.creator, event.amount.toString(), event.timestamp.toString(), event.mint],
      );
      return;
    }

    case "PlatformFeesWithdrawn": {
      await tx.query(
        `INSERT INTO payouts (height, txid, mint, quote_mint, recipient, amount, timestamp)
         VALUES ($1, $2, NULL, $3, NULL, $4, $5)`,
        [at.height, at.txid, event.quoteMint, event.amount.toString(), event.timestamp.toString()],
      );
      return;
    }
  }
}

/**
 * Stores everything a block's transactions recorded. Call inside a database
 * transaction, and move the cursor in that same transaction.
 */
export async function applyBlock(tx: Queryable, block: FullBlock, ctx: IngestContext): Promise<Notification[]> {
  const notes: Notification[] = [];
  for (const [txIndex, processed] of block.transactions.entries()) {
    const recorded = recordedEvents(processed, ctx.programs);
    if (recorded.length === 0) continue;
    const txid = transactionId(processed.transaction);
    for (const { event, instructionIndex, innerIndex } of recorded) {
      await applyEvent(tx, ctx, event, { height: block.height, txIndex, instructionIndex, innerIndex, txid }, notes);
    }
  }
  return notes;
}
