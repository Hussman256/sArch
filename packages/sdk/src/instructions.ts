/**
 * Instruction builders for the launchpad programs and the handful of system
 * and token instructions that go alongside them.
 *
 * Account order and data encoding mirror the Rust interface crate; the test
 * suite compares every builder here against fixtures generated from it.
 *
 * Instructions that record an event end with the program's own address in
 * their account list: the program calls itself to record it (see events.ts).
 */
import {
  type AdminAction,
  type ConfigData,
  type Pool,
  writeAdminAction,
  writeConfigData,
} from "./accounts.ts";
import {
  Addresses,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  COMPUTE_BUDGET_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_METADATA_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  associatedTokenAddress,
  metadataAddress,
} from "./addresses.ts";
import { type Address, ByteWriter, hexToBytes } from "./bytes.ts";
import type { AccountMeta, Instruction } from "./transaction.ts";

/** Longest coin name, in bytes. */
export const MAX_NAME_LEN = 32;
/** Longest ticker, in bytes. */
export const MAX_SYMBOL_LEN = 10;
/** Longest image URI, in bytes. */
export const MAX_IMAGE_LEN = 128;
/** Longest on-chain description, in bytes. */
export const MAX_DESCRIPTION_LEN = 140;

const writable = (pubkey: Address, isSigner = false): AccountMeta => ({
  pubkey,
  isSigner,
  isWritable: true,
});
const readonly = (pubkey: Address, isSigner = false): AccountMeta => ({
  pubkey,
  isSigner,
  isWritable: false,
});

export interface CreateCoinArgs {
  /** Any u64 the creator has not used before. It makes the mint address unique. */
  salt: bigint;
  name: string;
  symbol: string;
  /** Image URI. */
  image: string;
  /** Short description stored on chain. */
  description: string;
  /** SHA-256 of the off-chain metadata document as hex, or omitted if there is none. */
  metadataHash?: string;
  /** The most quote the creator will spend on their launch buy, fee included. */
  creatorBuyMaxQuote: bigint;
  /** The fewest tokens the creator will accept for it. */
  creatorBuyMinTokens: bigint;
}

const utf8Length = (value: string) => new TextEncoder().encode(value).length;

/** Throws with a readable reason if the launch program would reject the text fields. */
export function validateCoinText(args: Pick<CreateCoinArgs, "name" | "symbol" | "image" | "description">): void {
  const check = (label: string, value: string, max: number, required: boolean) => {
    const length = utf8Length(value);
    if (required && length === 0) throw new Error(`${label} is required`);
    if (length > max) throw new Error(`${label} is ${length} bytes; the limit is ${max}`);
  };
  check("name", args.name, MAX_NAME_LEN, true);
  check("ticker", args.symbol, MAX_SYMBOL_LEN, true);
  check("image link", args.image, MAX_IMAGE_LEN, false);
  check("description", args.description, MAX_DESCRIPTION_LEN, false);
}

/** Builders bound to one set of program IDs. */
export class Instructions {
  readonly addresses: Addresses;

  constructor(addresses: Addresses = new Addresses()) {
    this.addresses = addresses;
  }

  // --- config ---------------------------------------------------------------

  /** Creates the config account. Only the initial authority may call this, once. */
  initializeConfig(initialAuthority: Address, config: ConfigData): Instruction {
    const writer = new ByteWriter().u8(0);
    writeConfigData(writer, config);
    return {
      programId: this.addresses.programs.config,
      accounts: [
        writable(initialAuthority, true),
        writable(this.addresses.config()),
        readonly(SYSTEM_PROGRAM_ID),
      ],
      data: writer.finish(),
    };
  }

  /**
   * Proposes an admin action and records the proposer's approval of it.
   * `id` must be the config's current `proposalCount`.
   */
  propose(admin: Address, id: bigint, action: AdminAction): Instruction {
    const writer = new ByteWriter().u8(1);
    writeAdminAction(writer, action);
    return {
      programId: this.addresses.programs.config,
      accounts: [
        writable(admin, true),
        writable(this.addresses.config()),
        writable(this.addresses.proposal(id)),
        readonly(SYSTEM_PROGRAM_ID),
      ],
      data: writer.finish(),
    };
  }

  private vote(admin: Address, id: bigint, tag: number): Instruction {
    return {
      programId: this.addresses.programs.config,
      accounts: [
        readonly(admin, true),
        readonly(this.addresses.config()),
        writable(this.addresses.proposal(id)),
      ],
      data: Uint8Array.of(tag),
    };
  }

  /** Adds an admin's approval to a proposal. */
  approve(admin: Address, id: bigint): Instruction {
    return this.vote(admin, id, 2);
  }

  /** Withdraws an admin's approval from a proposal. */
  revoke(admin: Address, id: bigint): Instruction {
    return this.vote(admin, id, 3);
  }

  /**
   * Carries out a proposal that has enough approvals and, for a config
   * change, has waited out the timelock. Needs nobody's signature.
   */
  execute(id: bigint): Instruction {
    return {
      programId: this.addresses.programs.config,
      accounts: [writable(this.addresses.config()), writable(this.addresses.proposal(id))],
      data: Uint8Array.of(4),
    };
  }

  // --- fees -----------------------------------------------------------------

  /** Creates the platform's fee vault for a quote asset. Anyone may call it. */
  initPlatformVault(payer: Address, quoteMint: Address): Instruction {
    return {
      programId: this.addresses.programs.fees,
      accounts: [
        writable(payer, true),
        writable(this.addresses.platformVault(quoteMint)),
        readonly(quoteMint),
        readonly(this.addresses.vaultAuthority()),
        readonly(TOKEN_PROGRAM_ID),
        readonly(SYSTEM_PROGRAM_ID),
      ],
      data: Uint8Array.of(0),
    };
  }

  /** Pays a coin's accrued creator fees to `destination`, a quote token account. */
  claimCreatorFees(creator: Address, mint: Address, destination: Address): Instruction {
    return {
      programId: this.addresses.programs.fees,
      accounts: [
        readonly(creator, true),
        readonly(this.addresses.curve(mint)),
        writable(this.addresses.creatorVault(mint)),
        writable(destination),
        readonly(this.addresses.vaultAuthority()),
        readonly(TOKEN_PROGRAM_ID),
        readonly(this.addresses.programs.fees),
      ],
      data: Uint8Array.of(2),
    };
  }

  /** Sends a platform vault's balance to a token account owned by the treasury. */
  withdrawPlatformFees(quoteMint: Address, treasuryTokenAccount: Address): Instruction {
    return {
      programId: this.addresses.programs.fees,
      accounts: [
        readonly(this.addresses.config()),
        writable(this.addresses.platformVault(quoteMint)),
        writable(treasuryTokenAccount),
        readonly(this.addresses.vaultAuthority()),
        readonly(TOKEN_PROGRAM_ID),
        readonly(this.addresses.programs.fees),
      ],
      data: Uint8Array.of(3),
    };
  }

  // --- launch ---------------------------------------------------------------

  /**
   * Launches a coin and makes the creator's mandatory first buy. The creator
   * pays from, and receives into, their associated token accounts.
   */
  createCoin(creator: Address, quoteMint: Address, args: CreateCoinArgs): Instruction {
    const a = this.addresses;
    const mint = a.mint(creator, args.salt);
    const hash = args.metadataHash ? hexToBytes(args.metadataHash) : new Uint8Array(32);
    if (hash.length !== 32) throw new Error("metadata hash must be 32 bytes");

    return {
      programId: a.programs.launch,
      accounts: [
        writable(creator, true),
        readonly(a.config()),
        readonly(quoteMint),
        writable(mint),
        writable(a.curve(mint)),
        writable(a.tokenVault(mint)),
        writable(a.quoteVault(mint)),
        writable(metadataAddress(mint)),
        writable(associatedTokenAddress(creator, mint)),
        writable(associatedTokenAddress(creator, quoteMint)),
        writable(a.position(mint, creator)),
        writable(a.platformVault(quoteMint)),
        writable(a.creatorVault(mint)),
        readonly(a.vaultAuthority()),
        readonly(TOKEN_PROGRAM_ID),
        readonly(SYSTEM_PROGRAM_ID),
        readonly(ASSOCIATED_TOKEN_PROGRAM_ID),
        readonly(TOKEN_METADATA_PROGRAM_ID),
        readonly(a.programs.fees),
        readonly(a.programs.launch),
      ],
      data: new ByteWriter()
        .u8(0)
        .u64(args.salt)
        .string(args.name)
        .string(args.symbol)
        .string(args.image)
        .string(args.description)
        .bytes(hash)
        .u64(args.creatorBuyMaxQuote)
        .u64(args.creatorBuyMinTokens)
        .finish(),
    };
  }

  /**
   * Buys from a curve, spending at most `maxQuoteIn` with the fee included.
   * The graduation accounts are always attached, so the buy succeeds whether
   * or not it turns out to be the one that completes the curve.
   */
  buy(buyer: Address, mint: Address, quoteMint: Address, maxQuoteIn: bigint, minTokensOut: bigint): Instruction {
    const a = this.addresses;
    return {
      programId: a.programs.launch,
      accounts: [
        writable(buyer, true),
        writable(a.curve(mint)),
        writable(a.tokenVault(mint)),
        writable(a.quoteVault(mint)),
        writable(associatedTokenAddress(buyer, mint)),
        writable(associatedTokenAddress(buyer, quoteMint)),
        writable(a.position(mint, buyer)),
        writable(a.platformVault(quoteMint)),
        writable(a.creatorVault(mint)),
        readonly(TOKEN_PROGRAM_ID),
        readonly(SYSTEM_PROGRAM_ID),
        readonly(a.programs.launch),
        readonly(a.programs.pool),
        writable(a.pool(mint)),
        writable(a.poolTokenVault(mint)),
        writable(a.poolQuoteVault(mint)),
        readonly(mint),
        readonly(quoteMint),
      ],
      data: new ByteWriter().u8(1).u64(maxQuoteIn).u64(minTokensOut).finish(),
    };
  }

  /** Sells `tokensIn` back to a curve for at least `minQuoteOut` after the fee. */
  sell(seller: Address, mint: Address, quoteMint: Address, tokensIn: bigint, minQuoteOut: bigint): Instruction {
    const a = this.addresses;
    return {
      programId: a.programs.launch,
      accounts: [
        readonly(seller, true),
        writable(a.curve(mint)),
        writable(a.tokenVault(mint)),
        writable(a.quoteVault(mint)),
        writable(associatedTokenAddress(seller, mint)),
        writable(associatedTokenAddress(seller, quoteMint)),
        writable(a.platformVault(quoteMint)),
        writable(a.creatorVault(mint)),
        readonly(TOKEN_PROGRAM_ID),
        readonly(a.programs.launch),
      ],
      data: new ByteWriter().u8(2).u64(tokensIn).u64(minQuoteOut).finish(),
    };
  }

  // --- pool -----------------------------------------------------------------

  /**
   * Swaps against a graduated coin's pool. A buy spends at most `amountIn`
   * quote, fee included; a sell sends exactly `amountIn` tokens.
   */
  swap(
    trader: Address,
    pool: Pick<Pool, "mint" | "quoteMint" | "tokenVault" | "quoteVault" | "platformFeeVault" | "creatorFeeVault">,
    buy: boolean,
    amountIn: bigint,
    minAmountOut: bigint,
  ): Instruction {
    return {
      programId: this.addresses.programs.pool,
      accounts: [
        readonly(trader, true),
        writable(this.addresses.pool(pool.mint)),
        writable(pool.tokenVault),
        writable(pool.quoteVault),
        writable(associatedTokenAddress(trader, pool.mint)),
        writable(associatedTokenAddress(trader, pool.quoteMint)),
        writable(pool.platformFeeVault),
        writable(pool.creatorFeeVault),
        readonly(TOKEN_PROGRAM_ID),
        readonly(this.addresses.programs.pool),
      ],
      data: new ByteWriter().u8(1).bool(buy).u64(amountIn).u64(minAmountOut).finish(),
    };
  }
}

// --- system, compute budget, token -------------------------------------------

/** Moves native ARCH lamports. */
export function systemTransfer(from: Address, to: Address, lamports: bigint): Instruction {
  return {
    programId: SYSTEM_PROGRAM_ID,
    accounts: [writable(from, true), writable(to)],
    data: new ByteWriter().u32(3).u64(lamports).finish(),
  };
}

/** Raises the compute units a transaction may use. */
export function setComputeUnitLimit(units: number): Instruction {
  return {
    programId: COMPUTE_BUDGET_PROGRAM_ID,
    accounts: [],
    data: new ByteWriter().u32(1).u32(units).finish(),
  };
}

/** Moves tokens between two token accounts on the owner's signature. */
export function tokenTransfer(source: Address, destination: Address, owner: Address, amount: bigint): Instruction {
  return {
    programId: TOKEN_PROGRAM_ID,
    accounts: [writable(source), writable(destination), readonly(owner, true)],
    data: new ByteWriter().u8(3).u64(amount).finish(),
  };
}

/**
 * Initialises a mint in an account already created for it (82 bytes, owned by
 * the token program). The mint has no freeze authority.
 */
export function tokenInitializeMint(mint: Address, mintAuthority: Address, decimals: number): Instruction {
  return {
    programId: TOKEN_PROGRAM_ID,
    accounts: [writable(mint)],
    data: new ByteWriter().u8(19).u8(decimals).address(mintAuthority).u8(0).finish(),
  };
}

/** Mints new tokens to a token account on the mint authority's signature. */
export function tokenMintTo(mint: Address, destination: Address, mintAuthority: Address, amount: bigint): Instruction {
  return {
    programId: TOKEN_PROGRAM_ID,
    accounts: [writable(mint), writable(destination), readonly(mintAuthority, true)],
    data: new ByteWriter().u8(7).u64(amount).finish(),
  };
}

/**
 * Creates `wallet`'s associated token account for `mint` if it does not exist
 * yet. Safe to put in front of any instruction that needs the account.
 */
export function createAssociatedTokenAccountIdempotent(payer: Address, wallet: Address, mint: Address): Instruction {
  return {
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    accounts: [
      writable(payer, true),
      writable(associatedTokenAddress(wallet, mint)),
      readonly(wallet),
      readonly(mint),
      readonly(SYSTEM_PROGRAM_ID),
      readonly(TOKEN_PROGRAM_ID),
    ],
    data: Uint8Array.of(1),
  };
}
