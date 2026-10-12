/**
 * Byte-level helpers: encodings, and a reader and writer for the fixed
 * little-endian layouts the programs and the node use.
 */
import { base58, hex } from "@scure/base";

/** An account or program address: the base58 form of a 32-byte key. */
export type Address = string;

export const bytesToHex = (bytes: Uint8Array): string => hex.encode(bytes);

export function hexToBytes(value: string): Uint8Array {
  return hex.decode(value.toLowerCase());
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** Byte-wise ordering, the order Rust gives `[u8; 32]`. */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}

/** The 32 bytes behind an address. Throws if it is not a valid 32-byte key. */
export function addressToBytes(address: Address): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = base58.decode(address);
  } catch {
    throw new Error(`not a base58 address: ${address}`);
  }
  if (bytes.length !== 32) {
    throw new Error(`address must decode to 32 bytes, got ${bytes.length}: ${address}`);
  }
  return bytes;
}

export function bytesToAddress(bytes: Uint8Array): Address {
  if (bytes.length !== 32) throw new Error(`a key is 32 bytes, got ${bytes.length}`);
  return base58.encode(bytes);
}

export function isAddress(value: string): boolean {
  try {
    addressToBytes(value);
    return true;
  } catch {
    return false;
  }
}

const U64_MAX = (1n << 64n) - 1n;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;

/** Writes values in the order given, little-endian. */
export class ByteWriter {
  private readonly parts: Uint8Array[] = [];

  u8(value: number): this {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) throw new RangeError(`u8 out of range: ${value}`);
    this.parts.push(Uint8Array.of(value));
    return this;
  }

  bool(value: boolean): this {
    return this.u8(value ? 1 : 0);
  }

  u16(value: number): this {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new RangeError(`u16 out of range: ${value}`);
    const out = new Uint8Array(2);
    new DataView(out.buffer).setUint16(0, value, true);
    this.parts.push(out);
    return this;
  }

  u32(value: number): this {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) throw new RangeError(`u32 out of range: ${value}`);
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value, true);
    this.parts.push(out);
    return this;
  }

  u64(value: bigint): this {
    if (value < 0n || value > U64_MAX) throw new RangeError(`u64 out of range: ${value}`);
    const out = new Uint8Array(8);
    new DataView(out.buffer).setBigUint64(0, value, true);
    this.parts.push(out);
    return this;
  }

  i64(value: bigint): this {
    if (value < I64_MIN || value > I64_MAX) throw new RangeError(`i64 out of range: ${value}`);
    const out = new Uint8Array(8);
    new DataView(out.buffer).setBigInt64(0, value, true);
    this.parts.push(out);
    return this;
  }

  bytes(value: Uint8Array): this {
    this.parts.push(value);
    return this;
  }

  address(value: Address): this {
    return this.bytes(addressToBytes(value));
  }

  /** A Borsh string: u32 byte length, then UTF-8. */
  string(value: string): this {
    const encoded = new TextEncoder().encode(value);
    return this.u32(encoded.length).bytes(encoded);
  }

  finish(): Uint8Array {
    return concatBytes(...this.parts);
  }
}

/** Reads values in order, little-endian. Throws if the data runs out. */
export class ByteReader {
  private offset = 0;
  private readonly view: DataView;

  constructor(private readonly data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  private take(length: number): number {
    if (this.offset + length > this.data.length) {
      throw new RangeError(`data ends at ${this.data.length}, needed ${this.offset + length}`);
    }
    const start = this.offset;
    this.offset += length;
    return start;
  }

  u8(): number {
    return this.view.getUint8(this.take(1));
  }

  bool(): boolean {
    const value = this.u8();
    if (value > 1) throw new RangeError(`invalid bool: ${value}`);
    return value === 1;
  }

  u16(): number {
    return this.view.getUint16(this.take(2), true);
  }

  u32(): number {
    return this.view.getUint32(this.take(4), true);
  }

  u64(): bigint {
    return this.view.getBigUint64(this.take(8), true);
  }

  i64(): bigint {
    return this.view.getBigInt64(this.take(8), true);
  }

  bytes(length: number): Uint8Array {
    const start = this.take(length);
    return this.data.slice(start, start + length);
  }

  address(): Address {
    return bytesToAddress(this.bytes(32));
  }

  string(): string {
    return new TextDecoder("utf-8", { fatal: true }).decode(this.bytes(this.u32()));
  }

  get remaining(): number {
    return this.data.length - this.offset;
  }
}
