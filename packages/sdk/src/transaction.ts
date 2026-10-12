/**
 * Arch transactions: compiling instructions into a message, the bytes that
 * get signed, and the wire formats.
 *
 * This mirrors `arch_program::sanitized::ArchMessage` and
 * `arch_sdk::RuntimeTransaction` (node 0.12) byte for byte; the test suite
 * checks it against fixtures produced by those types.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import {
  type Address,
  addressToBytes,
  bytesToAddress,
  bytesToHex,
  compareBytes,
  concatBytes,
  ByteWriter,
} from "./bytes.ts";

/** Largest transaction a node accepts, in bytes. */
export const MAX_TRANSACTION_SIZE = 1232;
/** Most signatures a node will verify on one transaction. */
export const MAX_SIGNERS = 11;

export interface AccountMeta {
  pubkey: Address;
  isSigner: boolean;
  isWritable: boolean;
}

export interface Instruction {
  programId: Address;
  accounts: AccountMeta[];
  data: Uint8Array;
}

export interface MessageHeader {
  numRequiredSignatures: number;
  numReadonlySignedAccounts: number;
  numReadonlyUnsignedAccounts: number;
}

export interface CompiledInstruction {
  programIdIndex: number;
  accounts: number[];
  data: Uint8Array;
}

/** Instructions with their accounts deduplicated into one ordered key list. */
export interface Message {
  header: MessageHeader;
  accountKeys: Address[];
  recentBlockhash: Uint8Array;
  instructions: CompiledInstruction[];
}

export interface Transaction {
  version: 0;
  /** One 64-byte signature per required signer, in `accountKeys` order. */
  signatures: Uint8Array[];
  message: Message;
}

/**
 * Compiles instructions into a message.
 *
 * Key order follows the node's own compiler: the payer first, then writable
 * signers, read-only signers, writable non-signers and read-only non-signers,
 * each group sorted by key bytes. Any order with the right grouping is valid,
 * but matching the reference keeps a message reproducible across clients.
 */
export function compileMessage(
  instructions: Instruction[],
  payer: Address,
  recentBlockhash: Uint8Array,
): Message {
  if (recentBlockhash.length !== 32) throw new Error("recent blockhash must be 32 bytes");

  const metas = new Map<Address, { isSigner: boolean; isWritable: boolean }>();
  const touch = (key: Address) => {
    let meta = metas.get(key);
    if (!meta) {
      addressToBytes(key);
      meta = { isSigner: false, isWritable: false };
      metas.set(key, meta);
    }
    return meta;
  };
  for (const instruction of instructions) {
    touch(instruction.programId);
    for (const account of instruction.accounts) {
      const meta = touch(account.pubkey);
      meta.isSigner ||= account.isSigner;
      meta.isWritable ||= account.isWritable;
    }
  }
  touch(payer);
  metas.delete(payer);

  const sorted = [...metas.entries()].sort(([a], [b]) =>
    compareBytes(addressToBytes(a), addressToBytes(b)),
  );
  const group = (isSigner: boolean, isWritable: boolean) =>
    sorted
      .filter(([, meta]) => meta.isSigner === isSigner && meta.isWritable === isWritable)
      .map(([key]) => key);

  const writableSigners = [payer, ...group(true, true)];
  const readonlySigners = group(true, false);
  const writableOthers = group(false, true);
  const readonlyOthers = group(false, false);
  const accountKeys = [...writableSigners, ...readonlySigners, ...writableOthers, ...readonlyOthers];
  if (accountKeys.length > 255) throw new Error("a transaction can reference at most 255 accounts");

  const index = new Map(accountKeys.map((key, i) => [key, i]));
  const indexOf = (key: Address) => index.get(key)!;

  return {
    header: {
      numRequiredSignatures: writableSigners.length + readonlySigners.length,
      numReadonlySignedAccounts: readonlySigners.length,
      numReadonlyUnsignedAccounts: readonlyOthers.length,
    },
    accountKeys,
    recentBlockhash,
    instructions: instructions.map((instruction) => ({
      programIdIndex: indexOf(instruction.programId),
      accounts: instruction.accounts.map((account) => indexOf(account.pubkey)),
      data: instruction.data,
    })),
  };
}

export function serializeMessage(message: Message): Uint8Array {
  const writer = new ByteWriter()
    .u8(message.header.numRequiredSignatures)
    .u8(message.header.numReadonlySignedAccounts)
    .u8(message.header.numReadonlyUnsignedAccounts)
    .u32(message.accountKeys.length);
  for (const key of message.accountKeys) writer.address(key);
  writer.bytes(message.recentBlockhash).u32(message.instructions.length);
  for (const instruction of message.instructions) {
    writer
      .u8(instruction.programIdIndex)
      .u32(instruction.accounts.length)
      .bytes(Uint8Array.from(instruction.accounts))
      .u32(instruction.data.length)
      .bytes(instruction.data);
  }
  return writer.finish();
}

/** `hex(sha256(utf8(hex(sha256(bytes)))))`: the node's "double hash" over hex text. */
function doubleHashHex(bytes: Uint8Array): string {
  const first = bytesToHex(sha256(bytes));
  return bytesToHex(sha256(new TextEncoder().encode(first)));
}

/**
 * What each signer signs: a 64-character hex string.
 *
 * The signature is a BIP-322 message signature over this string as text. It is
 * not a signature over the 32 bytes the string encodes; signing those instead
 * is the classic way to get "error checking transaction sigs" from a node.
 */
export function signingPayload(message: Message): string {
  return doubleHashHex(serializeMessage(message));
}

/** The keys that must sign, in the order their signatures go in the transaction. */
export function requiredSigners(message: Message): Address[] {
  return message.accountKeys.slice(0, message.header.numRequiredSignatures);
}

export function serializeTransaction(transaction: Transaction): Uint8Array {
  if (transaction.signatures.length > MAX_SIGNERS) {
    throw new Error(`a transaction can carry at most ${MAX_SIGNERS} signatures`);
  }
  for (const signature of transaction.signatures) {
    if (signature.length !== 64) throw new Error("a signature is 64 bytes");
  }
  return concatBytes(
    new ByteWriter().u32(transaction.version).u8(transaction.signatures.length).finish(),
    ...transaction.signatures,
    serializeMessage(transaction.message),
  );
}

/** The transaction's ID, as the node reports it. */
export function transactionId(transaction: Transaction): string {
  return doubleHashHex(serializeTransaction(transaction));
}

/** Throws if the transaction is larger than a node will accept. */
export function assertTransactionFits(transaction: Transaction): void {
  const size = serializeTransaction(transaction).length;
  if (size > MAX_TRANSACTION_SIZE) {
    throw new Error(`transaction is ${size} bytes; the limit is ${MAX_TRANSACTION_SIZE}`);
  }
}

/** The JSON body `send_transaction` expects: every byte string as an array of numbers. */
export function transactionToJson(transaction: Transaction): unknown {
  return {
    version: transaction.version,
    signatures: transaction.signatures.map((signature) => Array.from(signature)),
    message: {
      header: {
        num_required_signatures: transaction.message.header.numRequiredSignatures,
        num_readonly_signed_accounts: transaction.message.header.numReadonlySignedAccounts,
        num_readonly_unsigned_accounts: transaction.message.header.numReadonlyUnsignedAccounts,
      },
      account_keys: transaction.message.accountKeys.map((key) => Array.from(addressToBytes(key))),
      recent_blockhash: Array.from(transaction.message.recentBlockhash),
      instructions: transaction.message.instructions.map((instruction) => ({
        program_id_index: instruction.programIdIndex,
        accounts: instruction.accounts,
        data: Array.from(instruction.data),
      })),
    },
  };
}

interface TransactionJson {
  version: number;
  signatures: number[][];
  message: {
    header: {
      num_required_signatures: number;
      num_readonly_signed_accounts: number;
      num_readonly_unsigned_accounts: number;
    };
    account_keys: number[][];
    recent_blockhash: number[];
    instructions: { program_id_index: number; accounts: number[]; data: number[] }[];
  };
}

/** Reads a transaction as a node returns it. */
export function transactionFromJson(json: unknown): Transaction {
  const raw = json as TransactionJson;
  return {
    version: 0,
    signatures: raw.signatures.map((signature) => Uint8Array.from(signature)),
    message: {
      header: {
        numRequiredSignatures: raw.message.header.num_required_signatures,
        numReadonlySignedAccounts: raw.message.header.num_readonly_signed_accounts,
        numReadonlyUnsignedAccounts: raw.message.header.num_readonly_unsigned_accounts,
      },
      accountKeys: raw.message.account_keys.map((key) => bytesToAddress(Uint8Array.from(key))),
      recentBlockhash: Uint8Array.from(raw.message.recent_blockhash),
      instructions: raw.message.instructions.map((instruction) => ({
        programIdIndex: instruction.program_id_index,
        accounts: [...instruction.accounts],
        data: Uint8Array.from(instruction.data),
      })),
    },
  };
}
