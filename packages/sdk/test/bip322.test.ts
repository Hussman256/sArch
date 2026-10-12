import { sha256 } from "@noble/hashes/sha2.js";
import { base64, createBase58check } from "@scure/base";
import { describe, expect, it } from "vitest";
import {
  accountAddress,
  bytesToHex,
  extractSignature,
  signMessage,
  taprootAddress,
  verifyMessage,
} from "../src/index.ts";

/**
 * BIP-322's own published test vector for a taproot address: this key, this
 * address, this message, this signature. If the SDK's sighash construction
 * were off by a byte, the vector's signature would not verify.
 */
const VECTOR = {
  wif: "L3VFeEujGtevx9w18HD1fhRbCH67Az2dpCymeRE1SoPK6XQtaN2k",
  address: "bc1ppv609nr0vr25u07u95waq5lucwfm6tde4nydujnu8npg4q75mr5sxq8lt3",
  message: "Hello World",
  signature:
    "AUHd69PrJQEv+oKTfZ8l+WROBHuy9HKrbFCJu7U1iK2iiEy1vMU5EfMtjc+VSHM7aU0SDbak5IUZRVno2P5mjSafAQ==",
};

/** WIF: version byte, 32-byte key, compression flag. */
const secretKey = createBase58check(sha256).decode(VECTOR.wif).subarray(1, 33);
const account = accountAddress(secretKey);

describe("BIP-322 taproot signatures", () => {
  it("derives the published address from the key", () => {
    expect(taprootAddress(account, "mainnet")).toBe(VECTOR.address);
  });

  it("verifies the published signature", () => {
    const signature = extractSignature(VECTOR.signature);
    expect(signature).toHaveLength(64);
    expect(verifyMessage(account, VECTOR.message, signature)).toBe(true);
  });

  it("rejects the published signature for a different message or account", () => {
    const signature = extractSignature(VECTOR.signature);
    expect(verifyMessage(account, "Hello World!", signature)).toBe(false);
    const other = accountAddress(sha256(new TextEncoder().encode("someone else")));
    expect(verifyMessage(other, VECTOR.message, signature)).toBe(false);
  });

  it("signs messages that verify, for keys of either parity", () => {
    // Enough keys that both even- and odd-y public points are exercised.
    for (let i = 0; i < 16; i++) {
      const key = sha256(Uint8Array.of(i));
      const address = accountAddress(key);
      const payload = bytesToHex(sha256(Uint8Array.of(i, i)));
      const signature = signMessage(key, payload);
      expect(signature).toHaveLength(64);
      expect(verifyMessage(address, payload, signature)).toBe(true);
      expect(verifyMessage(address, payload.toUpperCase(), signature)).toBe(false);
    }
  });

  it("rejects a tampered signature", () => {
    const signature = signMessage(secretKey, "payload");
    signature[10]! ^= 1;
    expect(verifyMessage(account, "payload", signature)).toBe(false);
    expect(verifyMessage(account, "payload", signature.subarray(0, 63))).toBe(false);
  });

  it("uses the network's address prefix", () => {
    expect(taprootAddress(account, "testnet")).toMatch(/^tb1p/);
    expect(taprootAddress(account, "regtest")).toMatch(/^bcrt1p/);
  });
});

describe("extracting a signature from what a wallet returns", () => {
  const bare = signMessage(secretKey, "payload");
  const withSighash = Uint8Array.from([...bare, 0x01]);
  const witness = (item: Uint8Array) => Uint8Array.from([0x01, item.length, ...item]);

  it("accepts a base64 witness stack, with or without a sighash byte", () => {
    expect(extractSignature(base64.encode(witness(bare)))).toEqual(bare);
    expect(extractSignature(base64.encode(witness(withSighash)))).toEqual(bare);
  });

  it("accepts a hex witness stack", () => {
    expect(extractSignature(bytesToHex(witness(bare)))).toEqual(bare);
    expect(extractSignature(bytesToHex(witness(withSighash)).toUpperCase())).toEqual(bare);
  });

  it("accepts a bare signature in hex or base64", () => {
    expect(extractSignature(bytesToHex(bare))).toEqual(bare);
    expect(extractSignature(base64.encode(bare))).toEqual(bare);
    expect(extractSignature(bytesToHex(withSighash))).toEqual(bare);
  });

  it("rejects anything that is not a taproot signature", () => {
    expect(() => extractSignature("")).toThrow();
    expect(() => extractSignature("not a signature")).toThrow();
    // A segwit v0 witness: signature plus public key, two items.
    const ecdsa = Uint8Array.from([0x02, 0x47, ...new Uint8Array(0x47), 0x21, ...new Uint8Array(0x21)]);
    expect(() => extractSignature(base64.encode(ecdsa))).toThrow();
  });
});
