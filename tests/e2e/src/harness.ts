/**
 * Shared setup for the end-to-end tests: a connection to the local chain and
 * freshly funded wallets.
 */
import { randomBytes } from "node:crypto";
import {
  type Address,
  type ArchpadEvent,
  type Instruction,
  type LaunchPlan,
  type ProcessedTransaction,
  type Signer,
  ArchpadClient,
  ArchRpc,
  TransactionFailedError,
  associatedTokenAddress,
  createAssociatedTokenAccountIdempotent,
  eventsOf as recordedEventsOf,
  keypairSigner,
  systemTransfer,
  tokenMintTo,
} from "@archpad/sdk";
import { type Deployment, NETWORKS, fundFromFaucet, lamportsOf, loadKeySet, readDeployment } from "@archpad/ops";

export interface Chain {
  rpc: ArchRpc;
  client: ArchpadClient;
  /** The dev authority: config admin, and mint authority of the test assets. */
  authority: Signer;
  deployment: Deployment;
  btc: Address;
  usd: Address;
}

let cached: Chain | undefined;

/** Connects to the local chain. Fails with instructions if it is not set up. */
export async function connect(): Promise<Chain> {
  if (cached) return cached;
  const deployment = readDeployment("localnet");
  if (!deployment) {
    throw new Error("no local deployment found: start the chain, then run `pnpm ops deploy` and `pnpm ops bootstrap`");
  }
  const rpc = new ArchRpc(process.env["ARCH_RPC_URL"] ?? NETWORKS.localnet.rpcUrl);
  try {
    await rpc.getBlockCount();
  } catch {
    throw new Error(`no Arch node at ${rpc.url}: start one with scripts/localnet.sh run`);
  }
  const quote = (symbol: string): Address => {
    const found = deployment.quotes.find((entry) => entry.symbol === symbol);
    if (!found) throw new Error(`the local deployment has no ${symbol} quote asset`);
    return found.mint;
  };
  cached = {
    rpc,
    client: new ArchpadClient(rpc),
    authority: loadKeySet("dev").authority,
    deployment,
    btc: quote("BTC"),
    usd: quote("USD"),
  };
  return cached;
}

export interface WalletFunding {
  /** Lamports for fees and rent. */
  lamports?: bigint;
  /** Test BTC, in base units (8 decimals). */
  btc?: bigint;
  /** Test USD, in base units (6 decimals). */
  usd?: bigint;
}

/** A brand-new wallet holding the requested balances. */
export async function newWallet(chain: Chain, funding: WalletFunding = {}): Promise<Signer> {
  const wallet = keypairSigner(randomBytes(32));
  const { authority, client } = chain;
  const lamports = funding.lamports ?? 2_000_000n;

  if ((await lamportsOf(chain.rpc, authority.address)) < lamports + 1_000_000n) {
    await fundFromFaucet(chain.rpc, authority, lamports + 50_000_000n);
  }
  const instructions: Instruction[] = [systemTransfer(authority.address, wallet.address, lamports)];
  for (const [mint, amount] of [
    [chain.btc, funding.btc ?? 0n],
    [chain.usd, funding.usd ?? 0n],
  ] as const) {
    if (amount === 0n) continue;
    instructions.push(
      createAssociatedTokenAccountIdempotent(authority.address, wallet.address, mint),
      tokenMintTo(mint, associatedTokenAddress(wallet.address, mint), authority.address, amount),
    );
  }
  await client.sendAndConfirm(instructions, [authority]);
  return wallet;
}

/**
 * Sends a transaction that is expected to fail and returns the failure.
 * Throws if the chain accepts it.
 */
export async function expectFailure(
  chain: Chain,
  instructions: Instruction[],
  signers: Signer[],
): Promise<TransactionFailedError> {
  let processed: ProcessedTransaction;
  try {
    processed = await chain.client.sendAndConfirm(instructions, signers);
  } catch (error) {
    if (error instanceof TransactionFailedError) return error;
    throw error;
  }
  throw new Error(`expected the transaction to fail, but it was processed:\n${processed.logs.join("\n")}`);
}

/**
 * Waits until the chain's finalized blockhash changes. Two byte-identical
 * transactions share an ID, so a test that repeats an action exactly must let
 * the blockhash move on first.
 */
export async function nextBlockhash(chain: Chain): Promise<void> {
  const before = await chain.rpc.getBestFinalizedBlockHash();
  for (let i = 0; i < 400; i++) {
    if ((await chain.rpc.getBestFinalizedBlockHash()) !== before) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the chain stopped producing blocks");
}

/** A unique, valid coin name and ticker for a test. */
export function coinText(label: string): { name: string; symbol: string; image: string; description: string } {
  const tag = randomBytes(2).toString("hex").toUpperCase();
  return {
    name: `${label} ${tag}`.slice(0, 32),
    symbol: `T${tag}`,
    image: `https://example.test/coin/${tag}.png`,
    description: `End-to-end test coin (${label}).`,
  };
}

/** Every launchpad event a processed transaction recorded, in order. */
export function eventsOf(processed: ProcessedTransaction): ArchpadEvent[] {
  return recordedEventsOf(processed);
}

/** The one event of a given type in a transaction. Throws if there is not exactly one. */
export function eventOf<T extends ArchpadEvent["type"]>(
  processed: ProcessedTransaction,
  type: T,
): Extract<ArchpadEvent, { type: T }> {
  const matches = eventsOf(processed).filter((event) => event.type === type);
  if (matches.length !== 1) {
    throw new Error(`expected one ${type} event, found ${matches.length}:\n${processed.logs.join("\n")}`);
  }
  return matches[0] as Extract<ArchpadEvent, { type: T }>;
}

/** Compute units the outermost launchpad instruction used, from the logs. */
export function computeUnits(processed: ProcessedTransaction, programId: Address): number {
  const prefix = `Program ${programId} consumed `;
  let best = 0;
  for (const line of processed.logs) {
    if (line.startsWith(prefix)) best = Math.max(best, Number.parseInt(line.slice(prefix.length), 10));
  }
  return best;
}

export interface LaunchedCoin {
  mint: Address;
  creator: Signer;
  plan: LaunchPlan;
  processed: ProcessedTransaction;
}

/** Launches a coin with a fresh, funded creator. */
export async function launchCoin(
  chain: Chain,
  options: { quote?: Address; creatorBuyBps?: number; creator?: Signer; label?: string } = {},
): Promise<LaunchedCoin> {
  const quote = options.quote ?? chain.btc;
  const creator = options.creator ?? (await newWallet(chain, { btc: 1_000_000_000n, usd: 1_000_000_000_000n }));
  const plan = await chain.client.planLaunch(creator.address, quote, {
    ...coinText(options.label ?? "Coin"),
    creatorBuyBps: options.creatorBuyBps ?? 50,
  });
  const processed = await chain.client.sendAndConfirm(plan.instructions, [creator]);
  return { mint: plan.mint, creator, plan, processed };
}

/** Waits until the chain's clock has passed `unixSeconds`. */
export async function waitUntil(chain: Chain, unixSeconds: bigint): Promise<void> {
  for (let i = 0; i < 2_000; i++) {
    const height = await chain.rpc.getBlockCount();
    const block = await chain.rpc.getBlock(height - 1);
    // Block timestamps are microseconds; the programs' clock is seconds.
    if (block && BigInt(Math.floor(block.timestamp / 1_000_000)) > unixSeconds) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("timed out waiting for the chain clock");
}
