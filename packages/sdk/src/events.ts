/**
 * Events the programs record, decoded.
 *
 * An event is not a log line. A node keeps only the first ten kilobytes of a
 * transaction's log, so a trade's log line can be pushed past the cut by
 * packing other output into the same transaction. Instead each program calls
 * itself with the event as instruction data, signed by an address only it can
 * sign for. Nodes record every such inner call in full, so that record is
 * where events are read from. Layouts mirror the Rust `Event` enum.
 */
import { type Address, ByteReader, ByteWriter } from "./bytes.ts";
import { DEFAULT_PROGRAM_IDS, type ProgramIds } from "./addresses.ts";
import type { ProcessedTransaction } from "./rpc.ts";

/** First byte of an event instruction's data. */
export const EVENT_IX_TAG = 0xe7;

export interface CoinCreatedEvent {
  type: "CoinCreated";
  mint: Address;
  creator: Address;
  quoteMint: Address;
  timestamp: bigint;
}

export interface TradeEvent {
  type: "Trade";
  mint: Address;
  trader: Address;
  isBuy: boolean;
  /** Quote that entered (buy) or left (sell) the curve: the trade's volume. */
  quoteAmount: bigint;
  /** Tokens the trader received (buy) or sold (sell). */
  tokenAmount: bigint;
  platformFee: bigint;
  creatorFee: bigint;
  /** Curve reserves after the trade. */
  virtualQuote: bigint;
  virtualToken: bigint;
  realQuote: bigint;
  realToken: bigint;
  timestamp: bigint;
}

export interface GraduatedEvent {
  type: "Graduated";
  mint: Address;
  pool: Address;
  quoteAmount: bigint;
  tokenAmount: bigint;
  timestamp: bigint;
}

export interface PoolSwapEvent {
  type: "PoolSwap";
  mint: Address;
  trader: Address;
  isBuy: boolean;
  /** Quote that moved the price: the swap's volume. */
  quoteAmount: bigint;
  tokenAmount: bigint;
  lpFee: bigint;
  platformFee: bigint;
  creatorFee: bigint;
  /** Pool reserves after the swap. */
  quoteReserve: bigint;
  tokenReserve: bigint;
  timestamp: bigint;
}

export interface CreatorFeesClaimedEvent {
  type: "CreatorFeesClaimed";
  mint: Address;
  creator: Address;
  amount: bigint;
  timestamp: bigint;
}

export interface PlatformFeesWithdrawnEvent {
  type: "PlatformFeesWithdrawn";
  quoteMint: Address;
  amount: bigint;
  timestamp: bigint;
}

export type ArchpadEvent =
  | CoinCreatedEvent
  | TradeEvent
  | GraduatedEvent
  | PoolSwapEvent
  | CreatorFeesClaimedEvent
  | PlatformFeesWithdrawnEvent;

function read(reader: ByteReader): ArchpadEvent | null {
  switch (reader.u8()) {
    case 0:
      return {
        type: "CoinCreated",
        mint: reader.address(),
        creator: reader.address(),
        quoteMint: reader.address(),
        timestamp: reader.i64(),
      };
    case 1:
      return {
        type: "Trade",
        mint: reader.address(),
        trader: reader.address(),
        isBuy: reader.bool(),
        quoteAmount: reader.u64(),
        tokenAmount: reader.u64(),
        platformFee: reader.u64(),
        creatorFee: reader.u64(),
        virtualQuote: reader.u64(),
        virtualToken: reader.u64(),
        realQuote: reader.u64(),
        realToken: reader.u64(),
        timestamp: reader.i64(),
      };
    case 2:
      return {
        type: "Graduated",
        mint: reader.address(),
        pool: reader.address(),
        quoteAmount: reader.u64(),
        tokenAmount: reader.u64(),
        timestamp: reader.i64(),
      };
    case 3:
      return {
        type: "PoolSwap",
        mint: reader.address(),
        trader: reader.address(),
        isBuy: reader.bool(),
        quoteAmount: reader.u64(),
        tokenAmount: reader.u64(),
        lpFee: reader.u64(),
        platformFee: reader.u64(),
        creatorFee: reader.u64(),
        quoteReserve: reader.u64(),
        tokenReserve: reader.u64(),
        timestamp: reader.i64(),
      };
    case 4:
      return {
        type: "CreatorFeesClaimed",
        mint: reader.address(),
        creator: reader.address(),
        amount: reader.u64(),
        timestamp: reader.i64(),
      };
    case 5:
      return {
        type: "PlatformFeesWithdrawn",
        quoteMint: reader.address(),
        amount: reader.u64(),
        timestamp: reader.i64(),
      };
    default:
      return null;
  }
}

/** Decodes one event. Returns null for anything that is not exactly one event. */
export function decodeEvent(data: Uint8Array): ArchpadEvent | null {
  try {
    const reader = new ByteReader(data);
    const event = read(reader);
    return event && reader.remaining === 0 ? event : null;
  } catch {
    return null;
  }
}

/**
 * Encodes an event as the programs do. The programs are the only ones who
 * can record an event; this exists so tests and tools can build the bytes
 * an indexer will see.
 */
export function encodeEvent(event: ArchpadEvent): Uint8Array {
  const writer = new ByteWriter();
  switch (event.type) {
    case "CoinCreated":
      writer.u8(0).address(event.mint).address(event.creator).address(event.quoteMint).i64(event.timestamp);
      break;
    case "Trade":
      writer
        .u8(1)
        .address(event.mint)
        .address(event.trader)
        .bool(event.isBuy)
        .u64(event.quoteAmount)
        .u64(event.tokenAmount)
        .u64(event.platformFee)
        .u64(event.creatorFee)
        .u64(event.virtualQuote)
        .u64(event.virtualToken)
        .u64(event.realQuote)
        .u64(event.realToken)
        .i64(event.timestamp);
      break;
    case "Graduated":
      writer
        .u8(2)
        .address(event.mint)
        .address(event.pool)
        .u64(event.quoteAmount)
        .u64(event.tokenAmount)
        .i64(event.timestamp);
      break;
    case "PoolSwap":
      writer
        .u8(3)
        .address(event.mint)
        .address(event.trader)
        .bool(event.isBuy)
        .u64(event.quoteAmount)
        .u64(event.tokenAmount)
        .u64(event.lpFee)
        .u64(event.platformFee)
        .u64(event.creatorFee)
        .u64(event.quoteReserve)
        .u64(event.tokenReserve)
        .i64(event.timestamp);
      break;
    case "CreatorFeesClaimed":
      writer.u8(4).address(event.mint).address(event.creator).u64(event.amount).i64(event.timestamp);
      break;
    case "PlatformFeesWithdrawn":
      writer.u8(5).address(event.quoteMint).u64(event.amount).i64(event.timestamp);
      break;
  }
  return writer.finish();
}

/** The data of the instruction that records `event`. */
export function encodeEventInstruction(event: ArchpadEvent): Uint8Array {
  const body = encodeEvent(event);
  const data = new Uint8Array(body.length + 1);
  data[0] = EVENT_IX_TAG;
  data.set(body, 1);
  return data;
}

/** Which program records each kind of event. */
const EVENT_SOURCE: Record<ArchpadEvent["type"], keyof ProgramIds> = {
  CoinCreated: "launch",
  Trade: "launch",
  Graduated: "launch",
  PoolSwap: "pool",
  CreatorFeesClaimed: "fees",
  PlatformFeesWithdrawn: "fees",
};

/** Decodes the data of an event instruction. Null for any other instruction. */
export function decodeEventInstruction(data: Uint8Array): ArchpadEvent | null {
  return data[0] === EVENT_IX_TAG ? decodeEvent(data.subarray(1)) : null;
}

/** An event, and where in its transaction it was recorded. */
export interface RecordedEvent {
  event: ArchpadEvent;
  /** Index of the transaction's own instruction that led to the event. */
  instructionIndex: number;
  /** Position among everything that instruction invoked. */
  innerIndex: number;
}

/**
 * The launchpad events a transaction recorded, in the order they happened,
 * with their positions.
 *
 * Only a transaction the chain accepted has events: a failed one changed
 * nothing, whatever it got through before failing. An event counts only if it
 * is a call made to the program that owns that kind of event. The program
 * itself refuses the call unless it made it, so anything found here is
 * something the program really did.
 */
export function recordedEvents(
  processed: Pick<ProcessedTransaction, "transaction" | "status" | "innerInstructions">,
  programs: ProgramIds = DEFAULT_PROGRAM_IDS,
): RecordedEvent[] {
  if (processed.status.type !== "processed") return [];
  const keys = processed.transaction.message.accountKeys;
  const found: RecordedEvent[] = [];
  processed.innerInstructions.forEach((inner, instructionIndex) => {
    inner.forEach(({ instruction }, innerIndex) => {
      const event = decodeEventInstruction(instruction.data);
      if (event && keys[instruction.programIdIndex] === programs[EVENT_SOURCE[event.type]]) {
        found.push({ event, instructionIndex, innerIndex });
      }
    });
  });
  return found;
}

/** The launchpad events a transaction recorded, in the order they happened. */
export function eventsOf(
  processed: Pick<ProcessedTransaction, "transaction" | "status" | "innerInstructions">,
  programs: ProgramIds = DEFAULT_PROGRAM_IDS,
): ArchpadEvent[] {
  return recordedEvents(processed, programs).map((recorded) => recorded.event);
}
