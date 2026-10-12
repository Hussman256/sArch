/**
 * Builds the blocks an indexer would read, without a chain: transactions whose
 * recorded inner calls carry launchpad events.
 */
import {
  type Address,
  type ArchpadEvent,
  type Curve,
  type FullBlock,
  type ProcessedTransaction,
  type TokenMetadata,
  Addresses,
  CurveStatus,
  DEFAULT_PROGRAM_IDS,
  bytesToAddress,
  encodeEventInstruction,
} from "@archpad/sdk";
import type { CoinDetails } from "../src/ingest.ts";

export const programs = DEFAULT_PROGRAM_IDS;
export const addresses = new Addresses(programs);

/** A readable, valid address: 32 bytes of `byte`. */
export const key = (byte: number): Address => bytesToAddress(new Uint8Array(32).fill(byte));

export const BTC = key(0xb7);
export const USD = key(0xd0);
export const CREATOR = key(0x11);
export const ALICE = key(0x21);
export const BOB = key(0x22);

const SOURCE: Record<ArchpadEvent["type"], keyof typeof programs> = {
  CoinCreated: "launch",
  Trade: "launch",
  Graduated: "launch",
  PoolSwap: "pool",
  CreatorFeesClaimed: "fees",
  PlatformFeesWithdrawn: "fees",
};

let nonce = 0;

/** A processed transaction that recorded the given events, in order, under one instruction. */
export function transaction(events: ArchpadEvent[], status: ProcessedTransaction["status"] = { type: "processed" }): ProcessedTransaction {
  const keys = [key(0x01), programs.launch, programs.pool, programs.fees];
  // A different blockhash each time, so every transaction has its own ID.
  const recentBlockhash = new Uint8Array(32);
  new DataView(recentBlockhash.buffer).setUint32(0, ++nonce);
  return {
    status,
    bitcoinTxid: null,
    logs: [],
    transaction: {
      version: 0,
      signatures: [new Uint8Array(64)],
      message: {
        header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 3 },
        accountKeys: keys,
        recentBlockhash,
        instructions: [{ programIdIndex: 1, accounts: [0], data: Uint8Array.of(1) }],
      },
    },
    innerInstructions: [
      events.map((event) => ({
        stackHeight: 2,
        instruction: {
          programIdIndex: keys.indexOf(programs[SOURCE[event.type]]),
          accounts: [0],
          data: encodeEventInstruction(event),
        },
      })),
    ],
  };
}

export function block(height: number, transactions: ProcessedTransaction[]): FullBlock {
  return {
    height,
    timestamp: (1_800_000_000 + height) * 1_000_000,
    previousBlockHash: "00".repeat(32),
    bitcoinBlockHeight: 101,
    transactions,
  };
}

export const TOTAL_SUPPLY = 1_000_000_000_000_000n;
export const CURVE_SUPPLY = 793_100_000_000_000n;
export const INITIAL_VIRTUAL_TOKEN = 1_073_000_000_000_000n;
export const INITIAL_VIRTUAL_QUOTE = 5_000_000n;

/** What the chain would return for a coin's curve and metadata accounts. */
export function coinDetails(mint: Address, overrides: Partial<Curve> = {}, metadata: Partial<TokenMetadata> = {}): CoinDetails {
  return {
    curve: {
      version: 1,
      bump: 255,
      status: CurveStatus.Trading,
      tokenDecimals: 6,
      mint,
      quoteMint: BTC,
      creator: CREATOR,
      tokenVault: addresses.tokenVault(mint),
      quoteVault: addresses.quoteVault(mint),
      platformFeeVault: addresses.platformVault(BTC),
      creatorFeeVault: addresses.creatorVault(mint),
      virtualQuote: INITIAL_VIRTUAL_QUOTE,
      virtualToken: INITIAL_VIRTUAL_TOKEN,
      realQuote: 0n,
      realToken: CURVE_SUPPLY,
      totalSupply: TOTAL_SUPPLY,
      curveSupply: CURVE_SUPPLY,
      initialVirtualQuote: INITIAL_VIRTUAL_QUOTE,
      initialVirtualToken: INITIAL_VIRTUAL_TOKEN,
      platformFeeBps: 100,
      creatorFeeBps: 125,
      poolLpFeeBps: 20,
      poolPlatformFeeBps: 5,
      poolCreatorFeeBps: 5,
      launchedAt: 1_800_000_000n,
      earlyWindowEnd: 1_800_000_010n,
      earlyWalletCap: 15_862_000_000_000n,
      graduatedAt: 0n,
      metadataHash: "00".repeat(32),
      ...overrides,
    },
    metadata: {
      mint,
      name: "Arch Cat",
      symbol: "ACAT",
      image: "https://example.test/acat.png",
      description: "The first cat on Arch.",
      updateAuthority: null,
      ...metadata,
    },
  };
}

export const created = (mint: Address, timestamp: number, quoteMint: Address = BTC): ArchpadEvent => ({
  type: "CoinCreated",
  mint,
  creator: CREATOR,
  quoteMint,
  timestamp: BigInt(timestamp),
});

/**
 * A curve trade that leaves the curve with the given reserves. Fees are the
 * usual 1% and 1.25% of the amount traded.
 */
export function trade(
  mint: Address,
  trader: Address,
  timestamp: number,
  after: { virtualQuote: bigint; virtualToken: bigint; realQuote: bigint; realToken: bigint },
  amounts: { quote: bigint; token: bigint; isBuy?: boolean },
): ArchpadEvent {
  return {
    type: "Trade",
    mint,
    trader,
    isBuy: amounts.isBuy ?? true,
    quoteAmount: amounts.quote,
    tokenAmount: amounts.token,
    platformFee: amounts.quote / 100n,
    creatorFee: amounts.quote / 80n,
    ...after,
    timestamp: BigInt(timestamp),
  };
}
