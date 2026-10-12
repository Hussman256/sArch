/**
 * BIP-322 "simple" message signatures for taproot key-path addresses.
 *
 * This is how Arch authenticates a transaction: each signer produces a BIP-322
 * signature over the transaction's signing payload, for the plain taproot
 * address whose internal key is their 32-byte account key. Browser wallets do
 * this themselves; this module is for signing with a raw key (scripts, bots,
 * tests) and for checking a wallet's signature before it is sent.
 */
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base64, bech32m, hex } from "@scure/base";
import { type Address, addressToBytes, bytesToAddress, concatBytes } from "./bytes.ts";

export type BitcoinNetwork = "mainnet" | "testnet" | "regtest";

const CURVE_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SIGHASH_DEFAULT = 0x00;
const SIGHASH_ALL = 0x01;
const ZERO_32 = new Uint8Array(32);
const ZERO_8 = new Uint8Array(8);
const ZERO_4 = new Uint8Array(4);

const { taggedHash, lift_x: liftX, pointToBytes } = schnorr.utils;

function bytesToBigInt(bytes: Uint8Array): bigint {
  return BigInt(`0x${hex.encode(bytes)}`);
}

function bigIntToBytes32(value: bigint): Uint8Array {
  return hex.decode(value.toString(16).padStart(64, "0"));
}

/** The taproot tweak for a key with no script tree. */
function tapTweak(internalKey: Uint8Array): bigint {
  const tweak = bytesToBigInt(taggedHash("TapTweak", internalKey));
  if (tweak >= CURVE_ORDER) throw new Error("taproot tweak is not a valid scalar");
  return tweak;
}

/** The x-only output key of the key-path-only taproot address for an internal key. */
function outputKey(internalKey: Uint8Array): Uint8Array {
  if (internalKey.length !== 32) throw new Error("an account key is 32 bytes");
  const point = liftX(bytesToBigInt(internalKey));
  return pointToBytes(point.add(schnorr.Point.BASE.multiply(tapTweak(internalKey))));
}

/** `OP_1 <32-byte output key>`. */
function scriptPubKey(internalKey: Uint8Array): Uint8Array {
  return concatBytes(Uint8Array.of(0x51, 0x20), outputKey(internalKey));
}

/** The account key for a secret key: its BIP-340 x-only public key, as an address. */
export function accountAddress(secretKey: Uint8Array): Address {
  return bytesToAddress(schnorr.getPublicKey(secretKey));
}

/**
 * The taproot address a wallet shows for an account key. This is the address
 * BIP-322 signatures commit to; it is not where the account lives on Arch.
 */
export function taprootAddress(account: Address, network: BitcoinNetwork): string {
  const prefix = network === "mainnet" ? "bc" : network === "regtest" ? "bcrt" : "tb";
  return bech32m.encode(prefix, [1, ...bech32m.toWords(outputKey(addressToBytes(account)))]);
}

/**
 * The BIP-341 signature hash of BIP-322's virtual `to_sign` transaction for
 * `message`, spending the address of `internalKey`.
 */
function messageSighash(internalKey: Uint8Array, message: Uint8Array, sighashType: number): Uint8Array {
  const script = scriptPubKey(internalKey);
  const scriptWithLength = concatBytes(Uint8Array.of(script.length), script);

  // to_spend: one input carrying the message hash, one zero-value output to the address.
  const messageHash = taggedHash("BIP0322-signed-message", message);
  const toSpend = concatBytes(
    ZERO_4, // version 0
    Uint8Array.of(0x01), // one input
    ZERO_32, // previous txid
    Uint8Array.of(0xff, 0xff, 0xff, 0xff), // previous index
    Uint8Array.of(0x22, 0x00, 0x20), // scriptSig: OP_0 PUSH32
    messageHash,
    ZERO_4, // sequence
    Uint8Array.of(0x01), // one output
    ZERO_8, // value 0
    scriptWithLength,
    ZERO_4, // locktime
  );
  const toSpendTxid = sha256(sha256(toSpend));

  // to_sign: spends that output into a single OP_RETURN. Its key-path sighash:
  const signatureMessage = concatBytes(
    Uint8Array.of(0x00), // sighash epoch
    Uint8Array.of(sighashType),
    ZERO_4, // version 0
    ZERO_4, // locktime 0
    sha256(concatBytes(toSpendTxid, ZERO_4)), // prevouts
    sha256(ZERO_8), // amounts
    sha256(scriptWithLength), // scriptPubKeys
    sha256(ZERO_4), // sequences
    sha256(concatBytes(ZERO_8, Uint8Array.of(0x01, 0x6a))), // outputs: 0 sats to OP_RETURN
    Uint8Array.of(0x00), // spend type: key path, no annex
    ZERO_4, // input index 0
  );
  return taggedHash("TapSighash", signatureMessage);
}

/**
 * Signs `message` for the taproot address of `secretKey`. Returns the bare
 * 64-byte Schnorr signature, which is what an Arch transaction carries.
 */
export function signMessage(secretKey: Uint8Array, message: Uint8Array | string): Uint8Array {
  const bytes = typeof message === "string" ? new TextEncoder().encode(message) : message;
  const internalKey = schnorr.getPublicKey(secretKey);

  // Key-path spends sign with the tweaked key. BIP-340 keys have even y, so
  // negate the secret first if its point does not.
  let secret = bytesToBigInt(secretKey);
  if (secret === 0n || secret >= CURVE_ORDER) throw new Error("invalid secret key");
  if (schnorr.Point.BASE.multiply(secret).y % 2n === 1n) secret = CURVE_ORDER - secret;
  const tweaked = (secret + tapTweak(internalKey)) % CURVE_ORDER;
  if (tweaked === 0n) throw new Error("tweaked key is zero");

  return schnorr.sign(
    messageSighash(internalKey, bytes, SIGHASH_DEFAULT),
    bigIntToBytes32(tweaked),
  );
}

/**
 * Checks a 64-byte signature of `message` by `account`. Accepts signatures
 * made with either sighash type wallets use, as the node does.
 */
export function verifyMessage(
  account: Address,
  message: Uint8Array | string,
  signature: Uint8Array,
): boolean {
  if (signature.length !== 64) return false;
  const bytes = typeof message === "string" ? new TextEncoder().encode(message) : message;
  try {
    const internalKey = addressToBytes(account);
    const key = outputKey(internalKey);
    return [SIGHASH_DEFAULT, SIGHASH_ALL].some((sighashType) =>
      schnorr.verify(signature, messageSighash(internalKey, bytes, sighashType), key),
    );
  } catch {
    return false;
  }
}

function readCompactSize(bytes: Uint8Array, offset: number): [value: number, next: number] | null {
  const first = bytes[offset];
  if (first === undefined) return null;
  if (first < 0xfd) return [first, offset + 1];
  if (first === 0xfd && offset + 3 <= bytes.length) {
    return [bytes[offset + 1]! | (bytes[offset + 2]! << 8), offset + 3];
  }
  return null;
}

/** The first item of a serialized witness stack, if `bytes` is exactly one. */
function firstWitnessItem(bytes: Uint8Array): Uint8Array | null {
  const count = readCompactSize(bytes, 0);
  if (!count || count[0] < 1) return null;
  let offset = count[1];
  let first: Uint8Array | null = null;
  for (let i = 0; i < count[0]; i++) {
    const length = readCompactSize(bytes, offset);
    if (!length || length[1] + length[0] > bytes.length) return null;
    first ??= bytes.subarray(length[1], length[1] + length[0]);
    offset = length[1] + length[0];
  }
  return offset === bytes.length ? first : null;
}

/**
 * Extracts the 64-byte signature from whatever a wallet's BIP-322 signing call
 * returned.
 *
 * Wallets differ: most return the witness stack in base64, some in hex, and a
 * few the bare signature. The signature itself may carry a trailing sighash
 * byte. Hex is tried first because a hex string is also valid base64.
 */
export function extractSignature(walletSignature: string): Uint8Array {
  const text = walletSignature.trim();
  const candidates: Uint8Array[] = [];
  if (/^(?:[0-9a-fA-F]{2})+$/.test(text)) candidates.push(hex.decode(text.toLowerCase()));
  try {
    candidates.push(base64.decode(text));
  } catch {
    // not base64
  }

  for (const bytes of candidates) {
    const item = firstWitnessItem(bytes) ?? bytes;
    if (item.length === 64) return Uint8Array.from(item);
    if (item.length === 65) return Uint8Array.from(item.subarray(0, 64));
  }
  throw new Error("wallet did not return a taproot BIP-322 signature");
}
