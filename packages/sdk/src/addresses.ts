/**
 * Program IDs and the addresses derived from them.
 *
 * Mirrors the `find_*_address` functions of the Rust interface crate. On Arch a
 * derived address is `sha256(seeds || bump || program_id)`, and no 32-byte
 * hash counts as "on the curve", so the first bump tried (255) is always the
 * one used. The Rust test suite asserts that for every address below.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { type Address, addressToBytes, bytesToAddress, concatBytes, ByteWriter } from "./bytes.ts";
import { PROGRAM_IDS } from "./generated/program-ids.ts";

/** APL token program. */
export const TOKEN_PROGRAM_ID: Address = "TokenT4em53UrV4gSvZ3nCS2mZeHaqTLapwt6iZt6Mk";
/** APL associated token account program. */
export const ASSOCIATED_TOKEN_PROGRAM_ID: Address = "ATok9pxLsNzM5zJJ3UQpXBrMriHpZiY5Yio3GKYU4we3";
/** APL token metadata program. */
export const TOKEN_METADATA_PROGRAM_ID: Address = "MetaLUJnthcRKvy3ayXTnVcxaXqca1fbaQox8ChQqAk";
/** System program: 32 zero bytes. */
export const SYSTEM_PROGRAM_ID: Address = "11111111111111111111111111111111";
/** Compute budget program. */
export const COMPUTE_BUDGET_PROGRAM_ID: Address = "ComputeBudget111111111111111111111111111111";

/** The launchpad's four programs. */
export interface ProgramIds {
  config: Address;
  launch: Address;
  fees: Address;
  pool: Address;
}

/** The program IDs this build of the SDK was generated for. */
export const DEFAULT_PROGRAM_IDS: ProgramIds = {
  config: PROGRAM_IDS.config,
  launch: PROGRAM_IDS.launch,
  fees: PROGRAM_IDS.fees,
  pool: PROGRAM_IDS.pool,
};

/** The only key allowed to initialise the config program. */
export const INITIAL_AUTHORITY: Address = PROGRAM_IDS.initialAuthority;

/** True when {@link DEFAULT_PROGRAM_IDS} are the public development keys. */
export const IS_DEV_KEY_SET: boolean = (PROGRAM_IDS.keySet as string) === "dev";

const BUMP = 255;
const text = (value: string) => new TextEncoder().encode(value);

/** A derived address and its bump. */
export function findProgramAddress(seeds: Uint8Array[], programId: Address): [Address, number] {
  if (seeds.length >= 16) throw new Error("too many seeds");
  for (const seed of seeds) {
    if (seed.length > 32) throw new Error("a seed is at most 32 bytes");
  }
  const hash = sha256(concatBytes(...seeds, Uint8Array.of(BUMP), addressToBytes(programId)));
  return [bytesToAddress(hash), BUMP];
}

const derive = (programId: Address, ...seeds: Uint8Array[]): Address =>
  findProgramAddress(seeds, programId)[0];

/** A wallet's associated token account for a mint. */
export function associatedTokenAddress(wallet: Address, mint: Address): Address {
  return derive(
    ASSOCIATED_TOKEN_PROGRAM_ID,
    addressToBytes(wallet),
    addressToBytes(TOKEN_PROGRAM_ID),
    addressToBytes(mint),
  );
}

/** A mint's metadata account in the APL token metadata program. */
export function metadataAddress(mint: Address): Address {
  return derive(TOKEN_METADATA_PROGRAM_ID, text("metadata"), addressToBytes(mint));
}

/** Every address the launchpad derives, for one set of program IDs. */
export class Addresses {
  constructor(readonly programs: ProgramIds = DEFAULT_PROGRAM_IDS) {}

  /** The single config account. */
  config(): Address {
    return derive(this.programs.config, text("config"));
  }

  /** The admin proposal with the given number. */
  proposal(id: bigint): Address {
    return derive(this.programs.config, text("proposal"), new ByteWriter().u64(id).finish());
  }

  /** A coin's mint. `salt` is any u64 the creator has not used before. */
  mint(creator: Address, salt: bigint): Address {
    return derive(
      this.programs.launch,
      text("mint"),
      addressToBytes(creator),
      new ByteWriter().u64(salt).finish(),
    );
  }

  /** A coin's curve account. */
  curve(mint: Address): Address {
    return derive(this.programs.launch, text("curve"), addressToBytes(mint));
  }

  /** The curve's token vault. */
  tokenVault(mint: Address): Address {
    return derive(this.programs.launch, text("token_vault"), addressToBytes(mint));
  }

  /** The curve's quote vault. */
  quoteVault(mint: Address): Address {
    return derive(this.programs.launch, text("quote_vault"), addressToBytes(mint));
  }

  /** A wallet's launch-window position in a coin. */
  position(mint: Address, wallet: Address): Address {
    return derive(
      this.programs.launch,
      text("position"),
      addressToBytes(mint),
      addressToBytes(wallet),
    );
  }

  /** The address that owns every fee vault's tokens. */
  vaultAuthority(): Address {
    return derive(this.programs.fees, text("authority"));
  }

  /** The platform's fee vault for a quote asset. */
  platformVault(quoteMint: Address): Address {
    return derive(this.programs.fees, text("platform"), addressToBytes(quoteMint));
  }

  /** The creator's fee vault for a coin. */
  creatorVault(mint: Address): Address {
    return derive(this.programs.fees, text("creator"), addressToBytes(mint));
  }

  /** A coin's pool. */
  pool(mint: Address): Address {
    return derive(this.programs.pool, text("pool"), addressToBytes(mint));
  }

  /** The pool's token vault. */
  poolTokenVault(mint: Address): Address {
    return derive(this.programs.pool, text("pool_token"), addressToBytes(mint));
  }

  /** The pool's quote vault. */
  poolQuoteVault(mint: Address): Address {
    return derive(this.programs.pool, text("pool_quote"), addressToBytes(mint));
  }
}
