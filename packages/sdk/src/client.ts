/**
 * The launchpad client: reads state, quotes trades and assembles the
 * transactions for every user action.
 *
 * It never holds keys. Anything that changes state comes back as a list of
 * instructions (or goes out through a `Signer` the caller supplies), so the
 * same code serves a browser wallet, a bot with a key file, and tests.
 */
import {
  type AdminAction,
  type Curve,
  type GlobalConfig,
  type Pool,
  type Position,
  type Proposal,
  AccountTag,
  CurveStatus,
  configuredQuotes,
  curveFeeRates,
  curveReserves,
  decodeCurve,
  decodeGlobalConfig,
  decodePool,
  decodePosition,
  decodeProposal,
  launchCurveParams,
  poolFeeRates,
  poolReserves,
} from "./accounts.ts";
import {
  Addresses,
  DEFAULT_PROGRAM_IDS,
  type ProgramIds,
  associatedTokenAddress,
  metadataAddress,
} from "./addresses.ts";
import { signMessage, verifyMessage, accountAddress } from "./bip322.ts";
import { type Address, hexToBytes } from "./bytes.ts";
import {
  type CreateCoinArgs,
  Instructions,
  createAssociatedTokenAccountIdempotent,
  setComputeUnitLimit,
  validateCoinText,
} from "./instructions.ts";
import {
  type BuyQuote,
  type PoolBuyQuote,
  type PoolSellQuote,
  type SellQuote,
  bpsCeil,
  bpsFloor,
  initialReserves,
  poolQuoteBuy,
  poolQuoteSell,
  quoteBuy,
  quoteInForTokensOut,
  quoteSell,
} from "./math.ts";
import type { ArchRpc, ProcessedTransaction } from "./rpc.ts";
import {
  type MintAccount,
  type TokenMetadata,
  decodeMint,
  decodeTokenAccount,
  decodeTokenMetadata,
} from "./token.ts";
import {
  type Instruction,
  type Message,
  type Transaction,
  assertTransactionFits,
  compileMessage,
  requiredSigners,
  signingPayload,
} from "./transaction.ts";

/** Something that can sign for one account. */
export interface Signer {
  /** The account this signer signs for. */
  readonly address: Address;
  /**
   * Signs a transaction's signing payload (a 64-character hex string) as a
   * BIP-322 message and returns the 64-byte signature.
   */
  sign(payload: string): Promise<Uint8Array>;
}

/** A signer backed by a raw secret key. For scripts, bots and tests. */
export function keypairSigner(secretKey: Uint8Array): Signer {
  return {
    address: accountAddress(secretKey),
    sign: async (payload) => signMessage(secretKey, payload),
  };
}

/**
 * Compute units requested for the transactions that do the most work. A
 * launch measures about 190,000 on a local validator and a buy that graduates
 * its coin about 130,000 (plus 13,000 when it also creates the buyer's token
 * account), so these leave roughly double.
 */
export const LAUNCH_COMPUTE_UNITS = 400_000;
export const TRADE_COMPUTE_UNITS = 300_000;

export interface ArchpadClientOptions {
  programIds?: ProgramIds;
}

/** A coin's on-chain state, gathered in one round trip. */
export interface CoinState {
  mint: Address;
  curve: Curve;
  /** Present once the coin has graduated. */
  pool: Pool | null;
  metadata: TokenMetadata | null;
}

export interface CurveBuyPlan {
  quote: BuyQuote;
  /** The fewest tokens the transaction will accept, after the slippage allowance. */
  minTokensOut: bigint;
  instructions: Instruction[];
}

export interface CurveSellPlan {
  quote: SellQuote;
  /** The least quote the transaction will accept, after the slippage allowance. */
  minQuoteOut: bigint;
  instructions: Instruction[];
}

export interface PoolSwapPlan {
  quote: PoolBuyQuote | PoolSellQuote;
  minAmountOut: bigint;
  instructions: Instruction[];
}

export interface ProposalPlan {
  /** The number the proposal will have. */
  id: bigint;
  /**
   * True when the proposer's approval is all the action needs and nothing
   * makes it wait, so the instructions also execute it.
   */
  executes: boolean;
  instructions: Instruction[];
}

export interface LaunchPlan {
  /** The address the new coin's mint will have. */
  mint: Address;
  /** What the creator's launch buy will cost and return. */
  creatorBuy: BuyQuote;
  instructions: Instruction[];
}

/** What a creator chooses when launching a coin. */
export interface LaunchRequest {
  name: string;
  symbol: string;
  image: string;
  description: string;
  /** SHA-256 of the off-chain metadata document, as hex. */
  metadataHash?: string;
  /**
   * How much of the curve supply the creator buys at launch, in basis points.
   * Must be at least the config's minimum and at most its wallet cap.
   */
  creatorBuyBps: number;
  /** Any u64 the creator has not launched with before. Random by default. */
  salt?: bigint;
}

/** `amount` reduced by `slippageBps`, rounded down: the least a trader will accept. */
export function applySlippage(amount: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    throw new RangeError("slippage must be between 0 and 10000 basis points");
  }
  return amount - bpsCeil(amount, slippageBps);
}

function randomSalt(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return new DataView(bytes.buffer).getBigUint64(0, true);
}

export class ArchpadClient {
  readonly addresses: Addresses;
  readonly instructions: Instructions;

  constructor(
    readonly rpc: ArchRpc,
    options: ArchpadClientOptions = {},
  ) {
    this.addresses = new Addresses(options.programIds ?? DEFAULT_PROGRAM_IDS);
    this.instructions = new Instructions(this.addresses);
  }

  // --- reads ----------------------------------------------------------------

  async getConfig(): Promise<GlobalConfig | null> {
    const account = await this.rpc.getAccount(this.addresses.config());
    return account ? decodeGlobalConfig(account.data) : null;
  }

  async getCurve(mint: Address): Promise<Curve | null> {
    const account = await this.rpc.getAccount(this.addresses.curve(mint));
    return account ? decodeCurve(account.data) : null;
  }

  async getPool(mint: Address): Promise<Pool | null> {
    const account = await this.rpc.getAccount(this.addresses.pool(mint));
    return account ? decodePool(account.data) : null;
  }

  async getPosition(mint: Address, wallet: Address): Promise<Position | null> {
    const account = await this.rpc.getAccount(this.addresses.position(mint, wallet));
    return account ? decodePosition(account.data) : null;
  }

  async getProposal(id: bigint): Promise<Proposal | null> {
    const account = await this.rpc.getAccount(this.addresses.proposal(id));
    return account ? decodeProposal(account.data) : null;
  }

  /** Every admin proposal ever made, newest first. They are never deleted. */
  async getProposals(): Promise<Proposal[]> {
    const accounts = await this.rpc.getProgramAccounts(this.addresses.programs.config, [
      { dataContent: { offset: 0, bytes: Uint8Array.of(AccountTag.Proposal) } },
    ]);
    return accounts
      .map((entry) => decodeProposal(entry.account.data))
      .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  }

  async getMint(mint: Address): Promise<MintAccount | null> {
    const account = await this.rpc.getAccount(mint);
    return account ? decodeMint(account.data) : null;
  }

  /** A coin's curve, pool and metadata in one request. Null if it was never launched here. */
  async getCoin(mint: Address): Promise<CoinState | null> {
    const [curve, pool, metadata] = await this.rpc.getMultipleAccounts([
      this.addresses.curve(mint),
      this.addresses.pool(mint),
      metadataAddress(mint),
    ]);
    if (!curve) return null;
    return {
      mint,
      curve: decodeCurve(curve.data),
      pool: pool ? decodePool(pool.data) : null,
      metadata: metadata ? decodeTokenMetadata(metadata.data) : null,
    };
  }

  /** A wallet's balance of a token in its associated token account. Zero if it has none. */
  async getTokenBalance(wallet: Address, mint: Address): Promise<bigint> {
    return this.getTokenAccountBalance(associatedTokenAddress(wallet, mint));
  }

  /** The balance of a specific token account. Zero if it does not exist. */
  async getTokenAccountBalance(tokenAccount: Address): Promise<bigint> {
    const account = await this.rpc.getAccount(tokenAccount);
    return account ? decodeTokenAccount(account.data).amount : 0n;
  }

  /** Creator fees a coin has accrued and not yet claimed, in its quote asset. */
  getUnclaimedCreatorFees(mint: Address): Promise<bigint> {
    return this.getTokenAccountBalance(this.addresses.creatorVault(mint));
  }

  /** Platform fees accrued and not yet sent to the treasury, for one quote asset. */
  getUnwithdrawnPlatformFees(quoteMint: Address): Promise<bigint> {
    return this.getTokenAccountBalance(this.addresses.platformVault(quoteMint));
  }

  // --- plans ----------------------------------------------------------------

  /**
   * Plans an admin proposal. Proposing is also approving, so when one
   * approval is enough and the action does not have to wait, the plan
   * executes it in the same transaction.
   */
  async planProposal(admin: Address, action: AdminAction): Promise<ProposalPlan> {
    const config = await this.getConfig();
    if (!config) throw new Error("the launchpad is not initialised on this network");
    const { admins, timelockSecs } = config.active;
    if (!admins.members.includes(admin)) throw new Error(`${admin} is not one of the admin keys`);

    const id = config.proposalCount;
    const waits = action.type === "SetConfig" && timelockSecs > 0;
    const executes = admins.threshold === 1 && !waits;
    const instructions = [this.instructions.propose(admin, id, action)];
    if (executes) instructions.push(this.instructions.execute(id));
    return { id, executes, instructions };
  }

  /**
   * Plans a launch: validates the text, prices the creator's mandatory buy
   * against the current config, and returns the transaction's instructions.
   */
  async planLaunch(creator: Address, quoteMint: Address, params: LaunchRequest): Promise<LaunchPlan> {
    validateCoinText(params);
    const config = await this.getConfig();
    if (!config) throw new Error("the launchpad is not initialised on this network");
    if (config.launchesPaused) throw new Error("new launches are paused");
    const quote = configuredQuotes(config.active).find((candidate) => candidate.mint === quoteMint);
    if (!quote) throw new Error("that asset is not accepted as a quote asset");
    if ((config.pausedQuotes & (1 << quote.index)) !== 0) {
      throw new Error("launches against that quote asset are paused");
    }

    const launch = config.active.launch;
    if (params.creatorBuyBps < launch.minCreatorBuyBps) {
      throw new Error(`the creator must buy at least ${launch.minCreatorBuyBps / 100}% of the curve supply`);
    }
    if (params.creatorBuyBps > launch.earlyWalletCapBps) {
      throw new Error(`a launch buy cannot exceed the ${launch.earlyWalletCapBps / 100}% wallet cap`);
    }

    // The curve is brand new, so the buy is priced against its opening
    // reserves and the result is exact, not an estimate.
    const rates = { platformBps: launch.platformFeeBps, creatorBps: launch.creatorFeeBps };
    const reserves = initialReserves(launchCurveParams(launch, quote));
    const cap = bpsFloor(launch.curveSupply, launch.earlyWalletCapBps);
    let tokens = bpsCeil(launch.curveSupply, params.creatorBuyBps);
    if (tokens > cap) tokens = cap;
    let budget = quoteInForTokensOut(reserves, rates, tokens);
    let creatorBuy = quoteBuy(reserves, rates, budget);
    // Paying for exactly `tokens` can return a few base units more. At the cap
    // those few would be rejected, so step the budget down until it fits.
    while (creatorBuy.tokensOut > cap && budget > 1n) {
      budget -= 1n;
      creatorBuy = quoteBuy(reserves, rates, budget);
    }

    const salt = params.salt ?? randomSalt();
    const args: CreateCoinArgs = {
      salt,
      name: params.name,
      symbol: params.symbol,
      image: params.image,
      description: params.description,
      creatorBuyMaxQuote: budget,
      creatorBuyMinTokens: creatorBuy.tokensOut,
      ...(params.metadataHash ? { metadataHash: params.metadataHash } : {}),
    };
    return {
      mint: this.addresses.mint(creator, salt),
      creatorBuy,
      instructions: [
        setComputeUnitLimit(LAUNCH_COMPUTE_UNITS),
        this.instructions.createCoin(creator, quoteMint, args),
      ],
    };
  }

  /** Plans a curve buy that spends at most `maxQuoteIn`, fee included. */
  planCurveBuy(buyer: Address, curve: Curve, maxQuoteIn: bigint, slippageBps: number): CurveBuyPlan {
    if (curve.status !== CurveStatus.Trading) throw new Error("this coin has graduated; trade its pool");
    const quote = quoteBuy(curveReserves(curve), curveFeeRates(curve), maxQuoteIn);
    const minTokensOut = applySlippage(quote.tokensOut, slippageBps);
    return {
      quote,
      minTokensOut,
      instructions: [
        setComputeUnitLimit(TRADE_COMPUTE_UNITS),
        createAssociatedTokenAccountIdempotent(buyer, buyer, curve.mint),
        this.instructions.buy(buyer, curve.mint, curve.quoteMint, maxQuoteIn, minTokensOut),
      ],
    };
  }

  /** Plans a curve sell of exactly `tokensIn`. */
  planCurveSell(seller: Address, curve: Curve, tokensIn: bigint, slippageBps: number): CurveSellPlan {
    if (curve.status !== CurveStatus.Trading) throw new Error("this coin has graduated; trade its pool");
    const quote = quoteSell(curveReserves(curve), curveFeeRates(curve), tokensIn);
    const minQuoteOut = applySlippage(quote.quoteOut, slippageBps);
    return {
      quote,
      minQuoteOut,
      instructions: [
        createAssociatedTokenAccountIdempotent(seller, seller, curve.quoteMint),
        this.instructions.sell(seller, curve.mint, curve.quoteMint, tokensIn, minQuoteOut),
      ],
    };
  }

  /** Plans a pool swap: a buy spending at most `amountIn` quote, or a sell of `amountIn` tokens. */
  planPoolSwap(trader: Address, pool: Pool, buy: boolean, amountIn: bigint, slippageBps: number): PoolSwapPlan {
    const reserves = poolReserves(pool);
    const rates = poolFeeRates(pool);
    const quote = buy ? poolQuoteBuy(reserves, rates, amountIn) : poolQuoteSell(reserves, rates, amountIn);
    const out = "tokensOut" in quote ? quote.tokensOut : quote.quoteOut;
    const minAmountOut = applySlippage(out, slippageBps);
    return {
      quote,
      minAmountOut,
      instructions: [
        createAssociatedTokenAccountIdempotent(trader, trader, buy ? pool.mint : pool.quoteMint),
        this.instructions.swap(trader, pool, buy, amountIn, minAmountOut),
      ],
    };
  }

  /** Instructions for a creator to claim a coin's accrued fees into their own quote account. */
  planClaimCreatorFees(creator: Address, curve: Pick<Curve, "mint" | "quoteMint">): Instruction[] {
    return [
      createAssociatedTokenAccountIdempotent(creator, creator, curve.quoteMint),
      this.instructions.claimCreatorFees(
        creator,
        curve.mint,
        associatedTokenAddress(creator, curve.quoteMint),
      ),
    ];
  }

  // --- transactions -----------------------------------------------------------

  /** Compiles instructions into a message against a fresh finalized blockhash. */
  async buildMessage(instructions: Instruction[], payer: Address): Promise<Message> {
    const blockhash = hexToBytes(await this.rpc.getBestFinalizedBlockHash());
    return compileMessage(instructions, payer, blockhash);
  }

  /**
   * Collects a signature from each required signer and checks every one
   * before returning, so a wallet that signed with the wrong key or the wrong
   * encoding is caught here with a clear message instead of at the node.
   */
  async signMessage(message: Message, signers: Signer[]): Promise<Transaction> {
    const payload = signingPayload(message);
    const signatures: Uint8Array[] = [];
    for (const address of requiredSigners(message)) {
      const signer = signers.find((candidate) => candidate.address === address);
      if (!signer) throw new Error(`no signer provided for ${address}`);
      const signature = await signer.sign(payload);
      if (!verifyMessage(address, payload, signature)) {
        throw new Error(`the signature returned for ${address} does not verify`);
      }
      signatures.push(signature);
    }
    const transaction: Transaction = { version: 0, signatures, message };
    assertTransactionFits(transaction);
    return transaction;
  }

  /** Builds, signs and submits a transaction. The first signer pays. Returns its ID. */
  async send(instructions: Instruction[], signers: Signer[]): Promise<string> {
    const payer = signers[0];
    if (!payer) throw new Error("at least one signer is required");
    const message = await this.buildMessage(instructions, payer.address);
    return this.rpc.sendTransaction(await this.signMessage(message, signers));
  }

  /** Like `send`, then waits for the result. Throws if the chain rejects the transaction. */
  async sendAndConfirm(instructions: Instruction[], signers: Signer[]): Promise<ProcessedTransaction> {
    return this.rpc.confirmTransaction(await this.send(instructions, signers));
  }
}
