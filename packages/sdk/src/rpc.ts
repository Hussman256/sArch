/**
 * A client for an Arch node's JSON-RPC interface (node 0.12 wire format).
 *
 * On the wire, keys, hashes and signatures travel as arrays of numbers;
 * transaction IDs and block hashes passed as parameters are hex strings. This
 * client converts both ways, so callers see base58 addresses, hex IDs and
 * `Uint8Array` data.
 */
import { type Address, addressToBytes, bytesToAddress, bytesToHex } from "./bytes.ts";
import { TransactionFailedError } from "./errors.ts";
import {
  type CompiledInstruction,
  type Transaction,
  transactionFromJson,
  transactionToJson,
} from "./transaction.ts";

export interface AccountInfo {
  /** Native ARCH balance, in lamports. */
  lamports: bigint;
  /** The program that owns the account. */
  owner: Address;
  data: Uint8Array;
  isExecutable: boolean;
}

export type TransactionStatus =
  | { type: "queued" }
  | { type: "processed" }
  | { type: "failed"; message: string };

export interface InnerInstruction {
  instruction: CompiledInstruction;
  /** 1 for the transaction's own instructions, 2 for what they invoke, and so on. */
  stackHeight: number;
}

export interface ProcessedTransaction {
  transaction: Transaction;
  status: TransactionStatus;
  /** The Bitcoin transaction this one was anchored in, if any. */
  bitcoinTxid: string | null;
  logs: string[];
  /** For each top-level instruction, the instructions it invoked. */
  innerInstructions: InnerInstruction[][];
}

export interface BlockHeader {
  height: number;
  /** Microseconds since the Unix epoch. */
  timestamp: number;
  previousBlockHash: string;
  bitcoinBlockHeight: number;
}

export interface Block extends BlockHeader {
  transactionIds: string[];
}

export interface FullBlock extends BlockHeader {
  transactions: ProcessedTransaction[];
}

export type AccountFilter =
  | { dataSize: number }
  | { dataContent: { offset: number; bytes: Uint8Array } };

/** An error returned by the node. */
export class RpcError extends Error {
  override readonly name = "RpcError";
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(`${method}: ${message}`);
  }
}

export interface ArchRpcOptions {
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Extra headers for every request, for example an API key. */
  headers?: Record<string, string>;
}

type Json = unknown;
const NOT_FOUND = 404;

const keyParam = (address: Address): number[] => Array.from(addressToBytes(address));

/** A hash as hex, whether the node sent it as a hex string or as bytes. */
function hashToHex(value: Json): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return bytesToHex(Uint8Array.from(value as number[]));
  throw new Error("unexpected hash encoding from node");
}

function parseStatus(value: Json): TransactionStatus {
  // Current nodes send {"type":"processed"}; older ones sent "Processed" or
  // {"Failed":"reason"}. Accept both so the client survives a mixed fleet.
  if (typeof value === "string") {
    return value.toLowerCase() === "queued" ? { type: "queued" } : { type: "processed" };
  }
  const object = (value ?? {}) as Record<string, Json>;
  if (typeof object["Failed"] === "string") return { type: "failed", message: object["Failed"] };
  const type = String(object["type"] ?? "").toLowerCase();
  if (type === "failed") return { type: "failed", message: String(object["message"] ?? "") };
  if (type === "queued") return { type: "queued" };
  if (type === "processed") return { type: "processed" };
  throw new Error(`unexpected transaction status from node: ${JSON.stringify(value)}`);
}

function parseAccount(value: Json): AccountInfo {
  const raw = value as { lamports: number; owner: number[]; data: number[]; is_executable: boolean };
  return {
    lamports: BigInt(raw.lamports),
    owner: bytesToAddress(Uint8Array.from(raw.owner)),
    data: Uint8Array.from(raw.data),
    isExecutable: raw.is_executable,
  };
}

function parseProcessed(value: Json): ProcessedTransaction {
  const raw = value as {
    runtime_transaction: Json;
    status: Json;
    bitcoin_txid?: Json;
    logs?: string[];
    inner_instructions_list?: {
      instruction: { program_id_index: number; accounts: number[]; data: number[] };
      stack_height: number;
    }[][];
  };
  return {
    transaction: transactionFromJson(raw.runtime_transaction),
    status: parseStatus(raw.status),
    bitcoinTxid: raw.bitcoin_txid == null ? null : hashToHex(raw.bitcoin_txid),
    logs: raw.logs ?? [],
    innerInstructions: (raw.inner_instructions_list ?? []).map((list) =>
      list.map((inner) => ({
        stackHeight: inner.stack_height,
        instruction: {
          programIdIndex: inner.instruction.program_id_index,
          accounts: [...inner.instruction.accounts],
          data: Uint8Array.from(inner.instruction.data),
        },
      })),
    ),
  };
}

function parseHeader(raw: Record<string, Json>): BlockHeader {
  return {
    height: Number(raw["block_height"]),
    timestamp: Number(raw["timestamp"]),
    previousBlockHash: hashToHex(raw["previous_block_hash"]),
    bitcoinBlockHeight: Number(raw["bitcoin_block_height"]),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class ArchRpc {
  private readonly fetchImpl: typeof fetch;
  private readonly headers: Record<string, string>;
  private nextId = 1;

  constructor(
    readonly url: string,
    options: ArchRpcOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.headers = { "content-type": "application/json", ...options.headers };
  }

  private async post(body: Json): Promise<Json> {
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`node returned HTTP ${response.status}`);
    return response.json();
  }

  /** Calls one RPC method. `params` is sent as given; omit it for methods that take none. */
  async call<T = Json>(method: string, params?: Json): Promise<T> {
    const request: Record<string, Json> = { jsonrpc: "2.0", id: this.nextId++, method };
    if (params !== undefined) request["params"] = params;
    const reply = (await this.post(request)) as {
      result?: T;
      error?: { code: number; message: string; data?: Json };
    };
    if (reply.error) {
      throw new RpcError(method, reply.error.code, reply.error.message, reply.error.data);
    }
    return reply.result as T;
  }

  /**
   * Sends several calls in one HTTP request. Each entry of the result is the
   * call's result, or the `RpcError` it failed with.
   */
  async batch(calls: { method: string; params?: Json }[]): Promise<(Json | RpcError)[]> {
    if (calls.length === 0) return [];
    const firstId = this.nextId;
    this.nextId += calls.length;
    const requests = calls.map((call, i) => {
      const request: Record<string, Json> = { jsonrpc: "2.0", id: firstId + i, method: call.method };
      if (call.params !== undefined) request["params"] = call.params;
      return request;
    });
    const replies = (await this.post(requests)) as {
      id: number;
      result?: Json;
      error?: { code: number; message: string; data?: Json };
    }[];
    const byId = new Map(replies.map((reply) => [reply.id, reply]));
    return calls.map((call, i) => {
      const reply = byId.get(firstId + i);
      if (!reply) return new RpcError(call.method, -32603, "no reply in batch");
      if (reply.error) {
        return new RpcError(call.method, reply.error.code, reply.error.message, reply.error.data);
      }
      return reply.result;
    });
  }

  async getVersion(): Promise<string> {
    return (await this.call<{ version: string }>("get_version", [])).version;
  }

  isNodeReady(): Promise<boolean> {
    return this.call<boolean>("is_node_ready", []);
  }

  /** Height of the newest block. */
  getBlockCount(): Promise<number> {
    return this.call<number>("get_block_count", []);
  }

  getBestBlockHash(): Promise<string> {
    return this.call<string>("get_best_block_hash", []);
  }

  /**
   * Hash of the newest finalized block. Use this as a transaction's recent
   * blockhash: nodes drop transactions whose blockhash they cannot look up
   * yet, which can happen with the very tip.
   */
  getBestFinalizedBlockHash(): Promise<string> {
    return this.call<string>("get_best_finalized_block_hash", []);
  }

  getBlockHash(height: number): Promise<string> {
    return this.call<string>("get_block_hash", height);
  }

  /**
   * Height of the newest finalized block. Everything at or below it is
   * settled; blocks above it can still change.
   */
  async getFinalizedHeight(): Promise<number> {
    const hash = await this.getBestFinalizedBlockHash();
    const raw = await this.call<Record<string, Json>>("get_block", [hash]);
    return Number(raw["block_height"]);
  }

  /**
   * The chain's current time in Unix seconds: the timestamp of its newest
   * block. Programs see the same clock, so compare deadlines against this
   * rather than the local one.
   */
  async getChainTime(): Promise<bigint> {
    const tip = await this.getBlockCount();
    // The node can report a height a moment before it serves that block.
    for (let height = tip; height >= 0 && height > tip - 5; height--) {
      const block = await this.getBlock(height);
      if (block) return BigInt(Math.floor(block.timestamp / 1_000_000));
    }
    throw new Error("the node has no recent block to read the time from");
  }

  /** A block with its transaction IDs, or null if the node does not have it. */
  async getBlock(height: number): Promise<Block | null> {
    const raw = await this.orNull(this.call<Record<string, Json>>("get_block_by_height", [height]));
    if (!raw) return null;
    return {
      ...parseHeader(raw),
      transactionIds: ((raw["transactions"] as Json[]) ?? []).map(hashToHex),
    };
  }

  /** A block with its transactions in full, or null if the node does not have it. */
  async getFullBlock(height: number): Promise<FullBlock | null> {
    const raw = await this.orNull(
      this.call<Record<string, Json>>("get_block_by_height", [height, "full"]),
    );
    return raw ? ArchRpc.parseFullBlock(raw) : null;
  }

  /** Several full blocks in one request. Missing blocks come back as null. */
  async getFullBlocks(heights: number[]): Promise<(FullBlock | null)[]> {
    const replies = await this.batch(
      heights.map((height) => ({ method: "get_block_by_height", params: [height, "full"] })),
    );
    return replies.map((reply) => {
      if (reply instanceof RpcError) {
        if (reply.code === NOT_FOUND) return null;
        throw reply;
      }
      return reply ? ArchRpc.parseFullBlock(reply as Record<string, Json>) : null;
    });
  }

  private static parseFullBlock(raw: Record<string, Json>): FullBlock {
    return {
      ...parseHeader(raw),
      transactions: ((raw["transactions"] as Json[]) ?? []).map(parseProcessed),
    };
  }

  /** An account, or null if it does not exist. */
  async getAccount(address: Address): Promise<AccountInfo | null> {
    const raw = await this.orNull(this.call("read_account_info", keyParam(address)));
    return raw ? parseAccount(raw) : null;
  }

  /** Several accounts in one request, in the order asked for. Missing ones are null. */
  async getMultipleAccounts(addresses: Address[]): Promise<(AccountInfo | null)[]> {
    if (addresses.length === 0) return [];
    const raw = await this.call<(Json | null)[]>("get_multiple_accounts", addresses.map(keyParam));
    return raw.map((entry) => (entry ? parseAccount(entry) : null));
  }

  /** Every account a program owns that passes all the filters. */
  async getProgramAccounts(
    programId: Address,
    filters: AccountFilter[] = [],
  ): Promise<{ address: Address; account: AccountInfo }[]> {
    const wireFilters = filters.map((filter) =>
      "dataSize" in filter
        ? { DataSize: filter.dataSize }
        : { DataContent: { offset: filter.dataContent.offset, bytes: Array.from(filter.dataContent.bytes) } },
    );
    const raw = await this.call<{ pubkey: number[]; account: Json }[]>("get_program_accounts", [
      keyParam(programId),
      wireFilters,
    ]);
    return raw.map((entry) => ({
      address: bytesToAddress(Uint8Array.from(entry.pubkey)),
      account: parseAccount(entry.account),
    }));
  }

  /** Submits a signed transaction. Returns its ID. */
  sendTransaction(transaction: Transaction): Promise<string> {
    return this.call<string>("send_transaction", transactionToJson(transaction));
  }

  /** Submits several signed transactions in one request (at most 100). Returns their IDs in order. */
  sendTransactions(transactions: Transaction[]): Promise<string[]> {
    return this.call<string[]>("send_transactions", transactions.map(transactionToJson));
  }

  /** A transaction's outcome, or null if the node has not seen it. */
  async getProcessedTransaction(txid: string): Promise<ProcessedTransaction | null> {
    const raw = await this.orNull(this.call("get_processed_transaction", txid));
    return raw ? parseProcessed(raw) : null;
  }

  /**
   * Waits for a transaction to be processed. Resolves with its outcome, or
   * throws `TransactionFailedError` if the chain rejected it.
   */
  async confirmTransaction(
    txid: string,
    options: { timeoutMs?: number; pollMs?: number } = {},
  ): Promise<ProcessedTransaction> {
    const deadline = Date.now() + (options.timeoutMs ?? 30_000);
    const pollMs = options.pollMs ?? 250;
    for (;;) {
      const processed = await this.getProcessedTransaction(txid);
      if (processed?.status.type === "processed") return processed;
      if (processed?.status.type === "failed") {
        throw new TransactionFailedError(txid, processed.status.message, processed.logs);
      }
      if (Date.now() >= deadline) {
        throw new Error(`transaction ${txid} was not processed within ${options.timeoutMs ?? 30_000} ms`);
      }
      await sleep(pollMs);
    }
  }

  /** Test networks only: sends lamports to an existing account. */
  requestAirdrop(address: Address): Promise<Json> {
    return this.call("request_airdrop", keyParam(address));
  }

  /**
   * Test networks only: asks the faucet to create and fund an account. The
   * returned transaction still needs the new account's own signature appended
   * before it is sent.
   */
  async createAccountWithFaucet(address: Address): Promise<Transaction> {
    return transactionFromJson(await this.call("create_account_with_faucet", keyParam(address)));
  }

  private async orNull<T>(call: Promise<T>): Promise<T | null> {
    try {
      return await call;
    } catch (error) {
      if (error instanceof RpcError && (error.code === NOT_FOUND || /not (?:in database|found)/i.test(error.message))) {
        return null;
      }
      throw error;
    }
  }
}
