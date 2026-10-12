/**
 * The accounts the launchpad programs own, decoded.
 *
 * Layouts mirror the Rust interface crate field for field. Amounts are
 * `bigint`s in base units; addresses are base58 strings.
 */
import { type Address, ByteReader, ByteWriter, bytesToHex } from "./bytes.ts";
import type { CurveParams, FeeRates, PoolFeeRates, PoolReserves, Reserves } from "./math.ts";

/** First byte of every account the programs own. */
export const AccountTag = {
  Uninitialized: 0,
  GlobalConfig: 1,
  Curve: 2,
  Position: 3,
  Pool: 4,
  Proposal: 5,
} as const;

/** Quote assets the config can hold at once. */
export const MAX_QUOTE_ASSETS = 8;
/** Admin keys the config can hold at once. */
export const MAX_ADMINS = 8;
/** Mint of an unused quote slot: all zero bytes. */
export const EMPTY_ADDRESS: Address = "11111111111111111111111111111111";

export const GLOBAL_CONFIG_LEN = 673;
/** Size of a proposal account before its action. */
export const PROPOSAL_HEADER_LEN = 72;
export const CURVE_LEN = 367;
export const POSITION_LEN = 75;
export const POOL_LEN = 257;

/** A quote asset coins may be priced in. */
export interface QuoteAsset {
  mint: Address;
  /** Starting virtual quote reserves for curves priced in this asset. */
  virtualQuoteReserves: bigint;
}

/** Parameters copied into every new curve. */
export interface LaunchParams {
  platformFeeBps: number;
  creatorFeeBps: number;
  /** Smallest share of curve supply the creator must buy at launch. */
  minCreatorBuyBps: number;
  /** Most of the curve supply one wallet may buy during the launch window. */
  earlyWalletCapBps: number;
  earlyWindowSecs: number;
  tokenDecimals: number;
  totalSupply: bigint;
  curveSupply: bigint;
  virtualTokenReserves: bigint;
  poolLpFeeBps: number;
  poolPlatformFeeBps: number;
  poolCreatorFeeBps: number;
}

/** The keys that govern the config, and how many of them must agree. */
export interface Admins {
  /** The admin keys. A key's position is its bit in a proposal's approvals. */
  members: Address[];
  /** How many of them must approve an action before it can be executed. */
  threshold: number;
}

/** The config: everything an approved, delayed change can set. */
export interface ConfigData {
  admins: Admins;
  /** Wallet that receives platform fees when they are withdrawn. */
  treasury: Address;
  /** Seconds an approved config change must wait before it can be executed. */
  timelockSecs: number;
  launch: LaunchParams;
  /** Always {@link MAX_QUOTE_ASSETS} slots; unused ones have the empty mint. */
  quotes: QuoteAsset[];
}

export interface GlobalConfig {
  version: number;
  bump: number;
  /** When true, no new coin can be launched. Existing coins keep trading. */
  launchesPaused: boolean;
  /** Bit `i` set: no new coin can be launched against quote slot `i`. */
  pausedQuotes: number;
  /**
   * Counts replacements of `active`. A proposal can only be approved or
   * executed while the epoch it was made under is still the current one.
   */
  epoch: number;
  /** How many proposals have been made. The next one takes this number. */
  proposalCount: bigint;
  active: ConfigData;
}

/**
 * Something the admins can do. This is the complete list: there is no action
 * that moves funds or changes a coin that already exists.
 */
export type AdminAction =
  | { type: "SetConfig"; config: ConfigData }
  | { type: "SetLaunchesPaused"; paused: boolean }
  | { type: "SetQuotePaused"; mint: Address; paused: boolean };

/** A proposed admin action and the approvals it has gathered. */
export interface Proposal {
  version: number;
  bump: number;
  id: bigint;
  /** The config epoch it was made under. */
  epoch: number;
  proposer: Address;
  /** Bit `i` set: the admin at position `i` approves. */
  approvals: number;
  createdAt: bigint;
  /** Unix time approvals reached the threshold, or 0 while short of it. */
  approvedAt: bigint;
  /** Unix time it was executed, or 0 if it has not been. */
  executedAt: bigint;
  action: AdminAction;
}

export const CurveStatus = { Trading: 0, Graduated: 1 } as const;

export interface Curve {
  version: number;
  bump: number;
  /** A {@link CurveStatus}. */
  status: number;
  tokenDecimals: number;
  mint: Address;
  quoteMint: Address;
  creator: Address;
  tokenVault: Address;
  quoteVault: Address;
  platformFeeVault: Address;
  creatorFeeVault: Address;
  virtualQuote: bigint;
  virtualToken: bigint;
  realQuote: bigint;
  realToken: bigint;
  totalSupply: bigint;
  curveSupply: bigint;
  initialVirtualQuote: bigint;
  initialVirtualToken: bigint;
  platformFeeBps: number;
  creatorFeeBps: number;
  poolLpFeeBps: number;
  poolPlatformFeeBps: number;
  poolCreatorFeeBps: number;
  launchedAt: bigint;
  /** Unix time the launch window closes. Before it, each wallet is capped. */
  earlyWindowEnd: bigint;
  /** Most tokens one wallet may buy before the launch window closes. */
  earlyWalletCap: bigint;
  /** Unix time of graduation, or 0 while still trading. */
  graduatedAt: bigint;
  /** SHA-256 of the coin's off-chain metadata document, as hex. */
  metadataHash: string;
}

export interface Position {
  version: number;
  bump: number;
  mint: Address;
  wallet: Address;
  /** Tokens this wallet bought before the launch window closed. */
  windowBought: bigint;
}

export interface Pool {
  version: number;
  bump: number;
  mint: Address;
  quoteMint: Address;
  creator: Address;
  tokenVault: Address;
  quoteVault: Address;
  platformFeeVault: Address;
  creatorFeeVault: Address;
  quoteReserve: bigint;
  tokenReserve: bigint;
  lpFeeBps: number;
  platformFeeBps: number;
  creatorFeeBps: number;
  /** Unix time the pool was created, which is when the coin graduated. */
  createdAt: bigint;
}

function expectTag(reader: ByteReader, tag: number, name: string): void {
  const found = reader.u8();
  if (found !== tag) throw new Error(`not a ${name} account (tag ${found})`);
}

function readConfigData(reader: ByteReader): ConfigData {
  const slots: Address[] = [];
  for (let i = 0; i < MAX_ADMINS; i++) slots.push(reader.address());
  const admins: Admins = {
    // Unused slots are the empty address and always trail the real keys.
    members: slots.filter((member) => member !== EMPTY_ADDRESS),
    threshold: reader.u8(),
  };
  const treasury = reader.address();
  const timelockSecs = reader.u32();
  const launch: LaunchParams = {
    platformFeeBps: reader.u16(),
    creatorFeeBps: reader.u16(),
    minCreatorBuyBps: reader.u16(),
    earlyWalletCapBps: reader.u16(),
    earlyWindowSecs: reader.u32(),
    tokenDecimals: reader.u8(),
    totalSupply: reader.u64(),
    curveSupply: reader.u64(),
    virtualTokenReserves: reader.u64(),
    poolLpFeeBps: reader.u16(),
    poolPlatformFeeBps: reader.u16(),
    poolCreatorFeeBps: reader.u16(),
  };
  const quotes: QuoteAsset[] = [];
  for (let i = 0; i < MAX_QUOTE_ASSETS; i++) {
    quotes.push({ mint: reader.address(), virtualQuoteReserves: reader.u64() });
  }
  return { admins, treasury, timelockSecs, launch, quotes };
}

/** Writes a config in the layout the config program's instructions take. */
export function writeConfigData(writer: ByteWriter, data: ConfigData): void {
  if (data.quotes.length > MAX_QUOTE_ASSETS) {
    throw new Error(`a config holds at most ${MAX_QUOTE_ASSETS} quote assets`);
  }
  const { members, threshold } = data.admins;
  if (members.length > MAX_ADMINS) throw new Error(`a config holds at most ${MAX_ADMINS} admins`);
  for (let i = 0; i < MAX_ADMINS; i++) writer.address(members[i] ?? EMPTY_ADDRESS);
  writer.u8(threshold);

  const launch = data.launch;
  writer
    .address(data.treasury)
    .u32(data.timelockSecs)
    .u16(launch.platformFeeBps)
    .u16(launch.creatorFeeBps)
    .u16(launch.minCreatorBuyBps)
    .u16(launch.earlyWalletCapBps)
    .u32(launch.earlyWindowSecs)
    .u8(launch.tokenDecimals)
    .u64(launch.totalSupply)
    .u64(launch.curveSupply)
    .u64(launch.virtualTokenReserves)
    .u16(launch.poolLpFeeBps)
    .u16(launch.poolPlatformFeeBps)
    .u16(launch.poolCreatorFeeBps);
  for (let i = 0; i < MAX_QUOTE_ASSETS; i++) {
    const quote = data.quotes[i] ?? { mint: EMPTY_ADDRESS, virtualQuoteReserves: 0n };
    writer.address(quote.mint).u64(quote.virtualQuoteReserves);
  }
}

export function decodeGlobalConfig(data: Uint8Array): GlobalConfig {
  const reader = new ByteReader(data);
  expectTag(reader, AccountTag.GlobalConfig, "config");
  return {
    version: reader.u8(),
    bump: reader.u8(),
    launchesPaused: reader.bool(),
    pausedQuotes: reader.u8(),
    epoch: reader.u32(),
    proposalCount: reader.u64(),
    active: readConfigData(reader),
  };
}

function readAdminAction(reader: ByteReader): AdminAction {
  const tag = reader.u8();
  switch (tag) {
    case 0:
      return { type: "SetConfig", config: readConfigData(reader) };
    case 1:
      return { type: "SetLaunchesPaused", paused: reader.bool() };
    case 2:
      return { type: "SetQuotePaused", mint: reader.address(), paused: reader.bool() };
    default:
      throw new Error(`unknown admin action ${tag}`);
  }
}

/** Writes an admin action in the layout the config program takes. */
export function writeAdminAction(writer: ByteWriter, action: AdminAction): void {
  switch (action.type) {
    case "SetConfig":
      writer.u8(0);
      writeConfigData(writer, action.config);
      return;
    case "SetLaunchesPaused":
      writer.u8(1).bool(action.paused);
      return;
    case "SetQuotePaused":
      writer.u8(2).address(action.mint).bool(action.paused);
      return;
  }
}

export function decodeProposal(data: Uint8Array): Proposal {
  const reader = new ByteReader(data);
  expectTag(reader, AccountTag.Proposal, "proposal");
  return {
    version: reader.u8(),
    bump: reader.u8(),
    id: reader.u64(),
    epoch: reader.u32(),
    proposer: reader.address(),
    approvals: reader.u8(),
    createdAt: reader.i64(),
    approvedAt: reader.i64(),
    executedAt: reader.i64(),
    action: readAdminAction(reader),
  };
}

/** The admins who have approved a proposal, given the admin list it was made under. */
export function approvers(proposal: Pick<Proposal, "approvals">, admins: Admins): Address[] {
  return admins.members.filter((_, index) => (proposal.approvals & (1 << index)) !== 0);
}

/** Where a proposal stands, and what would have to happen next. */
export type ProposalState =
  | { status: "executed"; at: bigint }
  /** The config was replaced after it was made; it can never be executed. */
  | { status: "stale" }
  | { status: "needs-approvals"; have: number; need: number }
  /** Approved, waiting out the timelock. */
  | { status: "waiting"; readyAt: bigint }
  | { status: "ready" };

/** Works out a proposal's state against the config and the chain's current time. */
export function proposalState(proposal: Proposal, config: GlobalConfig, now: bigint): ProposalState {
  if (proposal.executedAt !== 0n) return { status: "executed", at: proposal.executedAt };
  if (proposal.epoch !== config.epoch) return { status: "stale" };
  const have = approvers(proposal, config.active.admins).length;
  const need = config.active.admins.threshold;
  if (have < need || proposal.approvedAt === 0n) return { status: "needs-approvals", have, need };
  const delay = proposal.action.type === "SetConfig" ? BigInt(config.active.timelockSecs) : 0n;
  const readyAt = proposal.approvedAt + delay;
  return now >= readyAt ? { status: "ready" } : { status: "waiting", readyAt };
}

export function decodeCurve(data: Uint8Array): Curve {
  const reader = new ByteReader(data);
  expectTag(reader, AccountTag.Curve, "curve");
  return {
    version: reader.u8(),
    bump: reader.u8(),
    status: reader.u8(),
    tokenDecimals: reader.u8(),
    mint: reader.address(),
    quoteMint: reader.address(),
    creator: reader.address(),
    tokenVault: reader.address(),
    quoteVault: reader.address(),
    platformFeeVault: reader.address(),
    creatorFeeVault: reader.address(),
    virtualQuote: reader.u64(),
    virtualToken: reader.u64(),
    realQuote: reader.u64(),
    realToken: reader.u64(),
    totalSupply: reader.u64(),
    curveSupply: reader.u64(),
    initialVirtualQuote: reader.u64(),
    initialVirtualToken: reader.u64(),
    platformFeeBps: reader.u16(),
    creatorFeeBps: reader.u16(),
    poolLpFeeBps: reader.u16(),
    poolPlatformFeeBps: reader.u16(),
    poolCreatorFeeBps: reader.u16(),
    launchedAt: reader.i64(),
    earlyWindowEnd: reader.i64(),
    earlyWalletCap: reader.u64(),
    graduatedAt: reader.i64(),
    metadataHash: bytesToHex(reader.bytes(32)),
  };
}

export function decodePosition(data: Uint8Array): Position {
  const reader = new ByteReader(data);
  expectTag(reader, AccountTag.Position, "position");
  return {
    version: reader.u8(),
    bump: reader.u8(),
    mint: reader.address(),
    wallet: reader.address(),
    windowBought: reader.u64(),
  };
}

export function decodePool(data: Uint8Array): Pool {
  const reader = new ByteReader(data);
  expectTag(reader, AccountTag.Pool, "pool");
  return {
    version: reader.u8(),
    bump: reader.u8(),
    mint: reader.address(),
    quoteMint: reader.address(),
    creator: reader.address(),
    tokenVault: reader.address(),
    quoteVault: reader.address(),
    platformFeeVault: reader.address(),
    creatorFeeVault: reader.address(),
    quoteReserve: reader.u64(),
    tokenReserve: reader.u64(),
    lpFeeBps: reader.u16(),
    platformFeeBps: reader.u16(),
    creatorFeeBps: reader.u16(),
    createdAt: reader.i64(),
  };
}

/** The quote assets actually configured, with their slot index. */
export function configuredQuotes(config: ConfigData): (QuoteAsset & { index: number })[] {
  return config.quotes
    .map((quote, index) => ({ ...quote, index }))
    .filter((quote) => quote.mint !== EMPTY_ADDRESS);
}

/** True when new launches against a quote asset are paused. */
export function isQuotePaused(config: GlobalConfig, mint: Address): boolean {
  const quote = configuredQuotes(config.active).find((candidate) => candidate.mint === mint);
  return quote !== undefined && (config.pausedQuotes & (1 << quote.index)) !== 0;
}

/** The curve shape a new coin priced in `quote` would launch with. */
export function launchCurveParams(launch: LaunchParams, quote: QuoteAsset): CurveParams {
  return {
    totalSupply: launch.totalSupply,
    curveSupply: launch.curveSupply,
    virtualTokenReserves: launch.virtualTokenReserves,
    virtualQuoteReserves: quote.virtualQuoteReserves,
  };
}

export const curveReserves = (curve: Curve): Reserves => ({
  virtualQuote: curve.virtualQuote,
  virtualToken: curve.virtualToken,
  realQuote: curve.realQuote,
  realToken: curve.realToken,
});

export const curveFeeRates = (curve: Curve): FeeRates => ({
  platformBps: curve.platformFeeBps,
  creatorBps: curve.creatorFeeBps,
});

export const curveParams = (curve: Curve): CurveParams => ({
  totalSupply: curve.totalSupply,
  curveSupply: curve.curveSupply,
  virtualTokenReserves: curve.initialVirtualToken,
  virtualQuoteReserves: curve.initialVirtualQuote,
});

export const poolReserves = (pool: Pool): PoolReserves => ({
  quote: pool.quoteReserve,
  token: pool.tokenReserve,
});

export const poolFeeRates = (pool: Pool): PoolFeeRates => ({
  lpBps: pool.lpFeeBps,
  platformBps: pool.platformFeeBps,
  creatorBps: pool.creatorFeeBps,
});

/** How much of the curve has sold, in basis points (10 000 = ready to graduate). */
export function graduationProgressBps(curve: Curve): number {
  if (curve.curveSupply === 0n) return 0;
  const sold = curve.curveSupply - curve.realToken;
  return Number((sold * 10_000n) / curve.curveSupply);
}
