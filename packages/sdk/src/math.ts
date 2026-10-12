/**
 * Bonding-curve and fee math, mirrored bit-for-bit from the `archpad-math`
 * Rust crate that the on-chain programs use.
 *
 * Every amount is a `bigint` in base units (token base units, satoshis, ...).
 * The golden vectors in `crates/archpad-math/tests/vectors/curve.json` are
 * replayed against this file in the test suite, so a quote computed here is
 * the amount the program will settle. If you change one side, change both.
 *
 * Rounding always favours the curve: payouts round down, costs and fees round up.
 */

/** Largest amount the chain can represent. */
export const U64_MAX = (1n << 64n) - 1n;
/** 10 000 basis points = 100%. */
export const BPS_DENOMINATOR = 10_000n;
/** Hard ceiling on the total trade fee, in basis points (10%). */
export const MAX_TOTAL_FEE_BPS = 1_000;
/** How far a pool's opening price may sit from the curve's closing price (1%). */
export const PRICE_CONTINUITY_TOLERANCE_BPS = 100n;

export type MathErrorCode =
  | "Overflow"
  | "ZeroAmount"
  | "DustTrade"
  | "CurveComplete"
  | "InsufficientReserves"
  | "InvalidParams";

const MESSAGES: Record<MathErrorCode, string> = {
  Overflow: "arithmetic overflow",
  ZeroAmount: "amount is zero",
  DustTrade: "trade too small",
  CurveComplete: "curve is complete",
  InsufficientReserves: "insufficient curve reserves",
  InvalidParams: "invalid parameters",
};

/** A calculation the on-chain program would also refuse, with the same reason. */
export class MathError extends Error {
  override readonly name = "MathError";
  constructor(readonly code: MathErrorCode) {
    super(MESSAGES[code]);
  }
}

/** The two shares of the trade fee, in basis points of the trade's quote amount. */
export interface FeeRates {
  platformBps: number;
  creatorBps: number;
}

/** A trade fee, already split between its two recipients. */
export interface Fees {
  platform: bigint;
  creator: bigint;
}

/** The fixed shape of a bonding curve, set at launch. */
export interface CurveParams {
  totalSupply: bigint;
  curveSupply: bigint;
  virtualTokenReserves: bigint;
  virtualQuoteReserves: bigint;
}

/** The live state of a curve. */
export interface Reserves {
  virtualQuote: bigint;
  virtualToken: bigint;
  realQuote: bigint;
  realToken: bigint;
}

export interface BuyQuote {
  /** Quote that enters the curve. */
  quoteToCurve: bigint;
  /** Fee charged on top of `quoteToCurve`. */
  fees: Fees;
  /** Total taken from the buyer. Never more than the stated maximum. */
  quoteCharged: bigint;
  /** Tokens the buyer receives. */
  tokensOut: bigint;
  reservesAfter: Reserves;
  /** True when this buy takes the last curve tokens. */
  completesCurve: boolean;
}

export interface SellQuote {
  /** Quote that leaves the curve. */
  quoteFromCurve: bigint;
  /** Fee taken out of `quoteFromCurve`. */
  fees: Fees;
  /** Quote the seller receives. */
  quoteOut: bigint;
  reservesAfter: Reserves;
}

function fail(code: MathErrorCode): never {
  throw new MathError(code);
}

/** Rust takes `u64` arguments; anything else is a caller bug, not a quote error. */
function assertU64(name: string, value: bigint): void {
  if (typeof value !== "bigint" || value < 0n || value > U64_MAX) {
    throw new RangeError(`${name} must be an unsigned 64-bit integer, got ${String(value)}`);
  }
}

function assertReserves(reserves: Reserves): void {
  assertU64("virtualQuote", reserves.virtualQuote);
  assertU64("virtualToken", reserves.virtualToken);
  assertU64("realQuote", reserves.realQuote);
  assertU64("realToken", reserves.realToken);
}

function fitsU64(value: bigint): bigint {
  return value > U64_MAX ? fail("Overflow") : value;
}

/** `floor(a * b / d)`. */
export function mulDivFloor(a: bigint, b: bigint, d: bigint): bigint {
  if (d === 0n) fail("InvalidParams");
  return fitsU64((a * b) / d);
}

/** `ceil(a * b / d)`. */
export function mulDivCeil(a: bigint, b: bigint, d: bigint): bigint {
  if (d === 0n) fail("InvalidParams");
  const product = a * b;
  return fitsU64(product / d + (product % d === 0n ? 0n : 1n));
}

/** `floor(amount * bps / 10_000)`. */
export function bpsFloor(amount: bigint, bps: number): bigint {
  return mulDivFloor(amount, BigInt(bps), BPS_DENOMINATOR);
}

/** `ceil(amount * bps / 10_000)`. */
export function bpsCeil(amount: bigint, bps: number): bigint {
  return mulDivCeil(amount, BigInt(bps), BPS_DENOMINATOR);
}

function totalBps(rates: FeeRates): number {
  for (const [name, bps] of [
    ["platformBps", rates.platformBps],
    ["creatorBps", rates.creatorBps],
  ] as const) {
    if (!Number.isInteger(bps) || bps < 0 || bps > 0xffff) {
      throw new RangeError(`${name} must be an unsigned 16-bit integer, got ${bps}`);
    }
  }
  const total = rates.platformBps + rates.creatorBps;
  return total > MAX_TOTAL_FEE_BPS ? fail("InvalidParams") : total;
}

/**
 * Fee on the quote that enters the curve on a buy or leaves it on a sell.
 * The total rounds up; the platform takes the floor of its share and the
 * creator takes the rest.
 */
export function splitFee(curveQuoteAmount: bigint, rates: FeeRates): Fees {
  assertU64("curveQuoteAmount", curveQuoteAmount);
  const total = BigInt(totalBps(rates));
  if (total === 0n) return { platform: 0n, creator: 0n };
  const fee = mulDivCeil(curveQuoteAmount, total, BPS_DENOMINATOR);
  const platform = mulDivFloor(fee, BigInt(rates.platformBps), total);
  return { platform, creator: fee - platform };
}

/** Tokens held back from the curve to seed the pool at graduation. */
export function poolSupply(params: CurveParams): bigint {
  const supply = params.totalSupply - params.curveSupply;
  return supply < 0n ? fail("InvalidParams") : supply;
}

/** Quote the curve must take in to sell its whole curve supply. */
export function graduationQuote(params: CurveParams): bigint {
  const tokensLeft = params.virtualTokenReserves - params.curveSupply;
  if (tokensLeft <= 0n) fail("InvalidParams");
  return mulDivCeil(params.virtualQuoteReserves, params.curveSupply, tokensLeft);
}

/** Throws unless the shape is usable and the pool opens at the curve's closing price. */
export function validateCurveParams(params: CurveParams): void {
  assertU64("totalSupply", params.totalSupply);
  assertU64("curveSupply", params.curveSupply);
  assertU64("virtualTokenReserves", params.virtualTokenReserves);
  assertU64("virtualQuoteReserves", params.virtualQuoteReserves);
  if (
    params.curveSupply === 0n ||
    params.virtualQuoteReserves === 0n ||
    params.curveSupply >= params.totalSupply ||
    params.virtualTokenReserves <= params.curveSupply
  ) {
    fail("InvalidParams");
  }
  const pool = params.totalSupply - params.curveSupply;
  const target = graduationQuote(params);
  const endVirtualQuote = fitsU64(params.virtualQuoteReserves + target);
  const endVirtualToken = params.virtualTokenReserves - params.curveSupply;

  const poolSide = target * endVirtualToken;
  const curveSide = endVirtualQuote * pool;
  const allowed = (curveSide / BPS_DENOMINATOR) * PRICE_CONTINUITY_TOLERANCE_BPS;
  const gap = poolSide > curveSide ? poolSide - curveSide : curveSide - poolSide;
  if (gap > allowed) fail("InvalidParams");
}

/**
 * Derives the virtual reserves for a curve that raises `targetQuote` by
 * selling `curveSupply`, with the pool opening at the curve's closing price.
 * The curve must sell more than half the supply.
 */
export function curveParamsFromTarget(
  totalSupply: bigint,
  curveSupply: bigint,
  targetQuote: bigint,
): CurveParams {
  assertU64("totalSupply", totalSupply);
  assertU64("curveSupply", curveSupply);
  assertU64("targetQuote", targetQuote);
  const pool = totalSupply - curveSupply;
  if (pool < 0n) fail("InvalidParams");
  const spread = curveSupply - pool;
  if (spread <= 0n) fail("InvalidParams");

  const squared = curveSupply * curveSupply;
  const virtualTokenReserves = fitsU64(squared / spread + (squared % spread === 0n ? 0n : 1n));
  const virtualQuoteReserves = mulDivFloor(
    targetQuote,
    virtualTokenReserves - curveSupply,
    curveSupply,
  );
  const params = { totalSupply, curveSupply, virtualTokenReserves, virtualQuoteReserves };
  validateCurveParams(params);
  return params;
}

/** Reserves of a freshly launched curve. */
export function initialReserves(params: CurveParams): Reserves {
  return {
    virtualQuote: params.virtualQuoteReserves,
    virtualToken: params.virtualTokenReserves,
    realQuote: 0n,
    realToken: params.curveSupply,
  };
}

/** True once every curve token is sold. */
export function isComplete(reserves: Reserves): boolean {
  return reserves.realToken === 0n;
}

/**
 * Prices a buy that spends at most `maxQuoteIn`, fee included. A buy larger
 * than the curve can fill is cut down to the remaining tokens and charged only
 * for those.
 */
export function quoteBuy(reserves: Reserves, rates: FeeRates, maxQuoteIn: bigint): BuyQuote {
  assertReserves(reserves);
  assertU64("maxQuoteIn", maxQuoteIn);
  const total = BigInt(totalBps(rates));
  if (maxQuoteIn === 0n) fail("ZeroAmount");
  if (isComplete(reserves)) fail("CurveComplete");

  let quoteToCurve = mulDivFloor(maxQuoteIn, BPS_DENOMINATOR, BPS_DENOMINATOR + total);
  if (quoteToCurve === 0n) fail("DustTrade");

  const virtualQuoteAfter = fitsU64(reserves.virtualQuote + quoteToCurve);
  let tokensOut = mulDivFloor(reserves.virtualToken, quoteToCurve, virtualQuoteAfter);

  const completesCurve = tokensOut >= reserves.realToken;
  if (completesCurve) {
    tokensOut = reserves.realToken;
    const virtualTokenAfter = reserves.virtualToken - tokensOut;
    if (virtualTokenAfter <= 0n) fail("InvalidParams");
    quoteToCurve = mulDivCeil(reserves.virtualQuote, tokensOut, virtualTokenAfter);
  }
  if (tokensOut === 0n) fail("DustTrade");

  const fees = splitFee(quoteToCurve, rates);
  const quoteCharged = fitsU64(quoteToCurve + fees.platform + fees.creator);
  if (quoteCharged > maxQuoteIn) fail("InvalidParams");

  const virtualToken = reserves.virtualToken - tokensOut;
  if (virtualToken < 0n) fail("InvalidParams");
  return {
    quoteToCurve,
    fees,
    quoteCharged,
    tokensOut,
    completesCurve,
    reservesAfter: {
      virtualQuote: fitsU64(reserves.virtualQuote + quoteToCurve),
      virtualToken,
      realQuote: fitsU64(reserves.realQuote + quoteToCurve),
      realToken: reserves.realToken - tokensOut,
    },
  };
}

/** Prices a sell of exactly `tokensIn`. */
export function quoteSell(reserves: Reserves, rates: FeeRates, tokensIn: bigint): SellQuote {
  assertReserves(reserves);
  assertU64("tokensIn", tokensIn);
  totalBps(rates);
  if (tokensIn === 0n) fail("ZeroAmount");
  if (isComplete(reserves)) fail("CurveComplete");

  const virtualTokenAfter = fitsU64(reserves.virtualToken + tokensIn);
  const quoteFromCurve = mulDivFloor(reserves.virtualQuote, tokensIn, virtualTokenAfter);
  if (quoteFromCurve > reserves.realQuote) fail("InsufficientReserves");

  const fees = splitFee(quoteFromCurve, rates);
  const quoteOut = quoteFromCurve - fees.platform - fees.creator;
  if (quoteOut < 0n) fail("Overflow");
  if (quoteOut === 0n) fail("DustTrade");

  return {
    quoteFromCurve,
    fees,
    quoteOut,
    reservesAfter: {
      virtualQuote: reserves.virtualQuote - quoteFromCurve,
      virtualToken: virtualTokenAfter,
      realQuote: reserves.realQuote - quoteFromCurve,
      realToken: fitsU64(reserves.realToken + tokensIn),
    },
  };
}

/** A `maxQuoteIn` that is enough for {@link quoteBuy} to return at least `tokensOut`. */
export function quoteInForTokensOut(
  reserves: Reserves,
  rates: FeeRates,
  tokensOut: bigint,
): bigint {
  assertReserves(reserves);
  assertU64("tokensOut", tokensOut);
  totalBps(rates);
  if (tokensOut === 0n) fail("ZeroAmount");
  if (isComplete(reserves)) fail("CurveComplete");
  if (tokensOut > reserves.realToken) fail("InsufficientReserves");
  const virtualTokenAfter = reserves.virtualToken - tokensOut;
  if (virtualTokenAfter <= 0n) fail("InvalidParams");
  const quoteToCurve = mulDivCeil(reserves.virtualQuote, tokensOut, virtualTokenAfter);
  const fees = splitFee(quoteToCurve, rates);
  return fitsU64(quoteToCurve + fees.platform + fees.creator);
}

// ---------------------------------------------------------------------------
// Graduated pool: a constant-product pool over real reserves. Fees work as on
// the curve (computed on the quote amount that moves the price, in the quote
// asset), with a third share that stays in the pool.
// ---------------------------------------------------------------------------

/** Hard ceiling on the pool's total swap fee, in basis points (3%). */
export const MAX_POOL_FEE_BPS = 300;

/** The three shares of the pool's swap fee, in basis points of the quote amount. */
export interface PoolFeeRates {
  lpBps: number;
  platformBps: number;
  creatorBps: number;
}

/** What the pool holds. */
export interface PoolReserves {
  quote: bigint;
  token: bigint;
}

/** A pool swap fee, split three ways. `lp` stays in the pool. */
export interface PoolFees {
  lp: bigint;
  platform: bigint;
  creator: bigint;
}

export interface PoolBuyQuote {
  /** Quote that moves the price. */
  quoteToPool: bigint;
  /** Fee charged on top of `quoteToPool`. */
  fees: PoolFees;
  /** Total taken from the buyer. Never more than the stated maximum. */
  quoteCharged: bigint;
  /** Tokens the buyer receives. */
  tokensOut: bigint;
  reservesAfter: PoolReserves;
}

export interface PoolSellQuote {
  /** Quote the swap frees from the pool, before fees. */
  quoteFromPool: bigint;
  /** Fee taken out of `quoteFromPool`. */
  fees: PoolFees;
  /** Quote the seller receives. */
  quoteOut: bigint;
  reservesAfter: PoolReserves;
}

function poolTotalBps(rates: PoolFeeRates): number {
  for (const [name, bps] of [
    ["lpBps", rates.lpBps],
    ["platformBps", rates.platformBps],
    ["creatorBps", rates.creatorBps],
  ] as const) {
    if (!Number.isInteger(bps) || bps < 0 || bps > 0xffff) {
      throw new RangeError(`${name} must be an unsigned 16-bit integer, got ${bps}`);
    }
  }
  const total = rates.lpBps + rates.platformBps + rates.creatorBps;
  return total > MAX_POOL_FEE_BPS ? fail("InvalidParams") : total;
}

function assertPoolReserves(reserves: PoolReserves): void {
  assertU64("quote", reserves.quote);
  assertU64("token", reserves.token);
}

/**
 * Fee on the quote amount that moves the pool price. The total rounds up; the
 * LP and platform shares take the floor of their part and the creator takes
 * the rest.
 */
export function splitPoolFee(quoteAmount: bigint, rates: PoolFeeRates): PoolFees {
  assertU64("quoteAmount", quoteAmount);
  const total = BigInt(poolTotalBps(rates));
  if (total === 0n) return { lp: 0n, platform: 0n, creator: 0n };
  const fee = mulDivCeil(quoteAmount, total, BPS_DENOMINATOR);
  const lp = mulDivFloor(fee, BigInt(rates.lpBps), total);
  const platform = mulDivFloor(fee, BigInt(rates.platformBps), total);
  return { lp, platform, creator: fee - lp - platform };
}

/** Prices a pool buy that spends at most `maxQuoteIn`, fee included. */
export function poolQuoteBuy(
  reserves: PoolReserves,
  rates: PoolFeeRates,
  maxQuoteIn: bigint,
): PoolBuyQuote {
  assertPoolReserves(reserves);
  assertU64("maxQuoteIn", maxQuoteIn);
  const total = BigInt(poolTotalBps(rates));
  if (maxQuoteIn === 0n) fail("ZeroAmount");
  if (reserves.quote === 0n || reserves.token === 0n) fail("InsufficientReserves");

  const quoteToPool = mulDivFloor(maxQuoteIn, BPS_DENOMINATOR, BPS_DENOMINATOR + total);
  if (quoteToPool === 0n) fail("DustTrade");
  const quoteAfterSwap = fitsU64(reserves.quote + quoteToPool);
  const tokensOut = mulDivFloor(reserves.token, quoteToPool, quoteAfterSwap);
  if (tokensOut === 0n) fail("DustTrade");

  const fees = splitPoolFee(quoteToPool, rates);
  const quoteCharged = fitsU64(quoteToPool + fees.lp + fees.platform + fees.creator);
  if (quoteCharged > maxQuoteIn) fail("InvalidParams");

  return {
    quoteToPool,
    fees,
    quoteCharged,
    tokensOut,
    reservesAfter: {
      quote: fitsU64(quoteAfterSwap + fees.lp),
      token: reserves.token - tokensOut,
    },
  };
}

/** Prices a pool sell of exactly `tokensIn`. */
export function poolQuoteSell(
  reserves: PoolReserves,
  rates: PoolFeeRates,
  tokensIn: bigint,
): PoolSellQuote {
  assertPoolReserves(reserves);
  assertU64("tokensIn", tokensIn);
  poolTotalBps(rates);
  if (tokensIn === 0n) fail("ZeroAmount");
  if (reserves.quote === 0n || reserves.token === 0n) fail("InsufficientReserves");

  const tokenAfter = fitsU64(reserves.token + tokensIn);
  const quoteFromPool = mulDivFloor(reserves.quote, tokensIn, tokenAfter);
  const fees = splitPoolFee(quoteFromPool, rates);
  const quoteOut = quoteFromPool - fees.lp - fees.platform - fees.creator;
  if (quoteOut < 0n) fail("Overflow");
  if (quoteOut === 0n) fail("DustTrade");

  return {
    quoteFromPool,
    fees,
    quoteOut,
    reservesAfter: {
      quote: reserves.quote - quoteFromPool + fees.lp,
      token: tokenAfter,
    },
  };
}
