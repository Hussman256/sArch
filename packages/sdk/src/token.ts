/**
 * Decoders for the APL token program's accounts and the token metadata
 * program's metadata account.
 */
import { type Address, ByteReader } from "./bytes.ts";

export const MINT_LEN = 82;
export const TOKEN_ACCOUNT_LEN = 165;

export interface MintAccount {
  /** Who can mint more, or null if the supply is fixed. */
  mintAuthority: Address | null;
  supply: bigint;
  decimals: number;
  isInitialized: boolean;
  /** Who can freeze holders' accounts, or null if nobody can. */
  freezeAuthority: Address | null;
}

export interface TokenAccount {
  mint: Address;
  /** Who can move the balance. */
  owner: Address;
  amount: bigint;
  /** Someone the owner has allowed to spend from the account, if anyone. */
  delegate: Address | null;
  isInitialized: boolean;
  isFrozen: boolean;
  /** How much the delegate may still spend. */
  delegatedAmount: bigint;
  /** Who besides the owner can close the account, if anyone. */
  closeAuthority: Address | null;
}

export interface TokenMetadata {
  mint: Address;
  name: string;
  symbol: string;
  image: string;
  description: string;
  /** Who can change the metadata, or null if it is immutable. */
  updateAuthority: Address | null;
}

/** The token program's optional key: a 4-byte tag, then 32 bytes that are always present. */
function optionalAddress(reader: ByteReader): Address | null {
  const tag = reader.u32();
  const address = reader.address();
  return tag === 0 ? null : address;
}

export function decodeMint(data: Uint8Array): MintAccount {
  if (data.length < MINT_LEN) throw new Error("not a mint account");
  const reader = new ByteReader(data);
  return {
    mintAuthority: optionalAddress(reader),
    supply: reader.u64(),
    decimals: reader.u8(),
    isInitialized: reader.bool(),
    freezeAuthority: optionalAddress(reader),
  };
}

export function decodeTokenAccount(data: Uint8Array): TokenAccount {
  if (data.length < TOKEN_ACCOUNT_LEN) throw new Error("not a token account");
  const reader = new ByteReader(data);
  const mint = reader.address();
  const owner = reader.address();
  const amount = reader.u64();
  const delegate = optionalAddress(reader);
  const state = reader.u8();
  reader.bytes(12); // is_native: unused on Arch, where there is no wrapped native token
  const delegatedAmount = reader.u64();
  const closeAuthority = optionalAddress(reader);
  return {
    mint,
    owner,
    amount,
    delegate,
    isInitialized: state !== 0,
    isFrozen: state === 2,
    delegatedAmount,
    closeAuthority,
  };
}

export function decodeTokenMetadata(data: Uint8Array): TokenMetadata {
  const reader = new ByteReader(data);
  if (!reader.bool()) throw new Error("metadata account is not initialised");
  return {
    mint: reader.address(),
    name: reader.string(),
    symbol: reader.string(),
    image: reader.string(),
    description: reader.string(),
    updateAuthority: reader.bool() ? reader.address() : null,
  };
}
