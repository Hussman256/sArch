import { describe, expect, it } from "vitest";
import {
  type Curve,
  type Pool,
  CurveStatus,
  applySlippage,
  bytesToAddress,
  curveFeeRates,
  curveReserves,
  poolFeeRates,
  poolQuoteBuy,
  poolQuoteSell,
  poolReserves,
  quoteBuy,
  quoteSell,
} from "@archpad/sdk";
import {
  compact,
  formatBps,
  formatDuration,
  formatPrice,
  formatQuote,
  formatTokens,
  formatUnits,
  parseUnits,
  shortAddress,
  significant,
  timeAgo,
} from "../src/lib/format.ts";
import { maxUsefulBuy, previewTrade } from "../src/lib/quote.ts";

const BTC = { symbol: "BTC", decimals: 8 };
const USD = { symbol: "USD", decimals: 6 };
const key = (byte: number) => bytesToAddress(new Uint8Array(32).fill(byte));

describe("showing amounts", () => {
  it("writes base units as decimals without losing or inventing anything", () => {
    expect(formatUnits(1_234_500n, 6)).toBe("1.2345");
    expect(formatUnits(0n, 8)).toBe("0");
    expect(formatUnits(123_456_789_012_345n, 6)).toBe("123,456,789.012345");
    expect(formatUnits("100000000", 8)).toBe("1");
    expect(formatUnits(-1_500_000n, 6)).toBe("-1.5");
    // Extra decimals are cut, never rounded up: a balance must not be overstated.
    expect(formatUnits(1_999_999n, 6, 2)).toBe("1.99");
    expect(formatUnits(999n, 6, 2)).toBe("0");
    // Amounts beyond what a JavaScript number can hold stay exact.
    expect(formatUnits(18_446_744_073_709_551_615n, 6)).toBe("18,446,744,073,709.551615");
  });

  it("reads back what a person typed, and refuses what it cannot represent", () => {
    expect(parseUnits("1.5", 8)).toBe(150_000_000n);
    expect(parseUnits("0.00018966", 8)).toBe(18_966n);
    expect(parseUnits("1,000.5", 6)).toBe(1_000_500_000n);
    expect(parseUnits(".5", 6)).toBe(500_000n);
    expect(parseUnits("5.", 6)).toBe(5_000_000n);
    expect(parseUnits(" 42 ", 0)).toBe(42n);
    expect(parseUnits("0", 6)).toBe(0n);

    // More decimals than the asset has would silently lose money, so it is not a number here.
    expect(parseUnits("0.123456789", 8)).toBeNull();
    expect(parseUnits("1.5", 0)).toBeNull();
    for (const bad of ["", ".", "abc", "-1", "1e5", "1.2.3", "0x10", "١٢٣"]) {
      expect(parseUnits(bad, 6), bad).toBeNull();
    }
  });

  it("round-trips: what is shown parses back to the same amount", () => {
    for (const amount of [0n, 1n, 999_999n, 1_000_000n, 123_456_789_012n, 21_000_000n * 100_000_000n]) {
      expect(parseUnits(formatUnits(amount, 8), 8)).toBe(amount);
    }
  });

  it("shortens big numbers and keeps the digits that matter in small ones", () => {
    expect(compact(999)).toBe("999");
    expect(compact(1_500)).toBe("1.5K");
    expect(compact(1_234_567)).toBe("1.23M");
    expect(compact(2_500_000_000)).toBe("2.5B");
    expect(compact(0)).toBe("0");

    expect(significant(0.00000000004694)).toBe("0.00000000004694");
    expect(significant(0.004694)).toBe("0.004694");
    expect(significant(1234.5678)).toBe("1235");
    expect(significant(0.5)).toBe("0.5");
    expect(significant(0)).toBe("0");
    expect(significant(Number.NaN)).toBe("0");
  });

  it("formats quote assets the way people write them", () => {
    expect(formatQuote(18_966n, BTC)).toBe("0.00018966 BTC");
    expect(formatQuote(150_000_000n, BTC)).toBe("1.5 BTC");
    expect(formatQuote(14_167_560n, BTC)).toBe("0.1416756 BTC");
    expect(formatQuote(1_234_560_000n, USD)).toBe("$1,234.56");
    expect(formatQuote(1_234_560_000n, USD, { compact: true })).toBe("$1.23K");
    expect(formatQuote(166_900n, USD)).toBe("$0.1669");
    expect(formatQuote("0", USD)).toBe("$0");
  });

  it("prices a bitcoin-quoted token in sats, and a dollar-quoted one in dollars", () => {
    // 4.694e-9 sats of base unit per token base unit, six token decimals.
    expect(formatPrice(4.694e-9, 6, BTC)).toBe("0.004694 sats");
    expect(formatPrice(0.0001, 6, BTC)).toBe("100 sats");
    expect(formatPrice(4.2e-6, 6, USD)).toBe("$0.0000042");
    expect(formatPrice(1.5e-3, 9, { symbol: "aUSD", decimals: 6 })).toBe("$1.5");
    // Any other asset is shown in its own units.
    expect(formatPrice(2e-6, 6, { symbol: "SOL", decimals: 9 })).toBe("0.000000002 SOL");
  });

  it("formats the small things", () => {
    expect(formatTokens(3_965_500_000_000n, 6)).toBe("3.97M");
    expect(shortAddress("GdrABXTfK9PqkinymJWEeZvwrmq5HFYFU6ym5o77LwU6")).toBe("GdrA…LwU6");
    expect(shortAddress("short")).toBe("short");
    expect(timeAgo(1_000, 1_005)).toBe("5s");
    expect(timeAgo(1_000, 1_000 + 125)).toBe("2m");
    expect(timeAgo(1_000, 1_000 + 7_300)).toBe("2h");
    expect(timeAgo(1_000, 1_000 + 200_000)).toBe("2d");
    // A clock a little ahead of the chain never shows a negative age.
    expect(timeAgo(1_010, 1_000)).toBe("0s");
    expect(formatBps(225)).toBe("2.25%");
    expect(formatBps(100)).toBe("1%");
    expect(formatBps(30)).toBe("0.3%");
    expect(formatDuration(10)).toBe("10 seconds");
    expect(formatDuration(1)).toBe("1 second");
    expect(formatDuration(3_600)).toBe("1 hour");
    expect(formatDuration(86_400)).toBe("1 day");
  });
});

const CURVE_SUPPLY = 793_100_000_000_000n;

function curve(overrides: Partial<Curve> = {}): Curve {
  const mint = key(0xc1);
  return {
    version: 1,
    bump: 255,
    status: CurveStatus.Trading,
    tokenDecimals: 6,
    mint,
    quoteMint: key(0xb7),
    creator: key(0x11),
    tokenVault: key(0x01),
    quoteVault: key(0x02),
    platformFeeVault: key(0x03),
    creatorFeeVault: key(0x04),
    virtualQuote: 5_000_000n,
    virtualToken: 1_073_000_000_000_000n,
    realQuote: 0n,
    realToken: CURVE_SUPPLY,
    totalSupply: 1_000_000_000_000_000n,
    curveSupply: CURVE_SUPPLY,
    initialVirtualQuote: 5_000_000n,
    initialVirtualToken: 1_073_000_000_000_000n,
    platformFeeBps: 100,
    creatorFeeBps: 125,
    poolLpFeeBps: 20,
    poolPlatformFeeBps: 5,
    poolCreatorFeeBps: 5,
    launchedAt: 1_800_000_000n,
    earlyWindowEnd: 1_800_000_010n,
    earlyWalletCap: 15_862_000_000_000n,
    graduatedAt: 0n,
    metadataHash: "00".repeat(32),
    ...overrides,
  };
}

function pool(): Pool {
  return {
    version: 1,
    bump: 255,
    mint: key(0xc1),
    quoteMint: key(0xb7),
    creator: key(0x11),
    tokenVault: key(0x05),
    quoteVault: key(0x06),
    platformFeeVault: key(0x03),
    creatorFeeVault: key(0x04),
    quoteReserve: 14_167_560n,
    tokenReserve: 206_900_000_000_000n,
    lpFeeBps: 20,
    platformFeeBps: 5,
    creatorFeeBps: 5,
    createdAt: 1_800_000_500n,
  };
}

describe("previewing a trade", () => {
  it("shows exactly what the program will do for a curve buy", () => {
    const market = { curve: curve(), pool: null };
    const result = previewTrade(market, "buy", 200_000n, 100);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const expected = quoteBuy(curveReserves(market.curve), curveFeeRates(market.curve), 200_000n);
    expect(result.preview).toMatchObject({
      venue: "curve",
      side: "buy",
      amountIn: 200_000n,
      amountOut: expected.tokensOut,
      minOut: applySlippage(expected.tokensOut, 100),
      fee: expected.fees.platform + expected.fees.creator,
      charged: expected.quoteCharged,
      graduates: false,
    });
    // The minimum is 1% under the quote, never more than the quote itself.
    expect(result.preview.minOut).toBeLessThan(result.preview.amountOut);
    expect(result.preview.minOut).toBeGreaterThanOrEqual((result.preview.amountOut * 99n) / 100n - 1n);
    // Buying 4% of the virtual reserves moves the price about 4% against the buyer.
    expect(result.preview.priceImpactBps).toBeGreaterThan(300);
    expect(result.preview.priceImpactBps).toBeLessThan(450);
  });

  it("shows a small trade as moving the price hardly at all, and a zero limit as no room", () => {
    const market = { curve: curve(), pool: null };
    const small = previewTrade(market, "buy", 1_000n, 0);
    expect(small.ok && small.preview.priceImpactBps).toBeLessThan(5);
    expect(small.ok && small.preview.minOut === small.preview.amountOut).toBe(true);
  });

  it("previews a sell, fee taken out of what comes back", () => {
    const sold = curve({ virtualQuote: 5_200_000n, virtualToken: 1_031_730_769_230_770n, realQuote: 200_000n, realToken: 751_830_769_230_770n });
    const market = { curve: sold, pool: null };
    const result = previewTrade(market, "sell", 10_000_000_000_000n, 50);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const expected = quoteSell(curveReserves(sold), curveFeeRates(sold), 10_000_000_000_000n);
    expect(result.preview).toMatchObject({
      venue: "curve",
      side: "sell",
      amountOut: expected.quoteOut,
      minOut: applySlippage(expected.quoteOut, 50),
      fee: expected.fees.platform + expected.fees.creator,
      charged: 0n,
    });
    expect(expected.quoteOut + result.preview.fee).toBe(expected.quoteFromCurve);
  });

  it("says when a buy would graduate the coin, and that it costs only what is left", () => {
    const nearlyDone = curve({
      virtualQuote: 19_000_000n,
      virtualToken: 282_368_421_052_632n,
      realQuote: 14_000_000n,
      realToken: 2_468_421_052_632n,
    });
    const result = previewTrade({ curve: nearlyDone, pool: null }, "buy", 2_000_000_000n, 100);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.graduates).toBe(true);
    expect(result.preview.amountOut).toBe(nearlyDone.realToken);
    expect(result.preview.charged).toBeLessThan(2_000_000_000n);
    expect(result.preview.charged).toBeLessThan(300_000n);
  });

  it("holds a buy to the wallet's launch-window allowance", () => {
    const market = { curve: curve(), pool: null };
    const cap = market.curve.earlyWalletCap;
    // 200,000 sats buys about 5% of the curve: over a 2% allowance.
    const over = previewTrade(market, "buy", 200_000n, 100, cap);
    expect(over).toEqual({ ok: false, reason: expect.stringMatching(/more than one wallet can buy/) });
    const spent = previewTrade(market, "buy", 1_000n, 100, 0n);
    expect(spent).toEqual({ ok: false, reason: expect.stringMatching(/bought the most one wallet can/) });
    // Under the allowance is fine, and selling is never limited by it.
    expect(previewTrade(market, "buy", 20_000n, 100, cap).ok).toBe(true);
    expect(previewTrade(market, "buy", 200_000n, 100).ok).toBe(true);
  });

  it("offers a Max that buys as much as allowed and no more", () => {
    const fresh = curve();
    const cap = fresh.earlyWalletCap;
    const budget = maxUsefulBuy(fresh, cap);
    const bought = quoteBuy(curveReserves(fresh), curveFeeRates(fresh), budget).tokensOut;
    expect(bought).toBeLessThanOrEqual(cap);
    expect(bought).toBeGreaterThan((cap * 999n) / 1000n);
    expect(previewTrade({ curve: fresh, pool: null }, "buy", budget, 100, cap).ok).toBe(true);

    // With no allowance in the way, Max is what it takes to buy the whole curve.
    const all = maxUsefulBuy(fresh);
    const everything = quoteBuy(curveReserves(fresh), curveFeeRates(fresh), all);
    expect(everything.completesCurve).toBe(true);
    expect(everything.quoteCharged).toBe(all);
    expect(maxUsefulBuy(fresh, 0n)).toBe(0n);
  });

  it("explains amounts that cannot be traded instead of failing", () => {
    const market = { curve: curve(), pool: null };
    expect(previewTrade(market, "buy", 0n, 100)).toEqual({ ok: false, reason: "Enter an amount." });
    expect(previewTrade(market, "buy", 1n, 100)).toEqual({ ok: false, reason: "That amount is too small to trade." });
    // Nothing has been bought yet, so there is nothing for the curve to buy back with.
    const sell = previewTrade(market, "sell", 1_000_000_000n, 100);
    expect(sell.ok).toBe(false);
    expect(!sell.ok && sell.reason).toMatch(/does not hold that much|too small|too large/);
  });

  it("prices against the pool once a coin has graduated", () => {
    const market = { curve: curve({ status: CurveStatus.Graduated, realToken: 0n }), pool: pool() };
    const buy = previewTrade(market, "buy", 1_000_000n, 100);
    expect(buy.ok).toBe(true);
    if (!buy.ok) return;
    const expectedBuy = poolQuoteBuy(poolReserves(market.pool), poolFeeRates(market.pool), 1_000_000n);
    expect(buy.preview).toMatchObject({
      venue: "pool",
      amountOut: expectedBuy.tokensOut,
      fee: expectedBuy.fees.lp + expectedBuy.fees.platform + expectedBuy.fees.creator,
      graduates: false,
    });
    // The pool's fee is 0.3%, far below the curve's 2.25%.
    expect(Number(buy.preview.fee) / 1_000_000).toBeLessThan(0.0035);

    const sell = previewTrade(market, "sell", 5_000_000_000_000n, 100);
    expect(sell.ok).toBe(true);
    if (!sell.ok) return;
    const expectedSell = poolQuoteSell(poolReserves(market.pool), poolFeeRates(market.pool), 5_000_000_000_000n);
    expect(sell.preview).toMatchObject({ venue: "pool", side: "sell", amountOut: expectedSell.quoteOut });
    // The launch-window allowance means nothing on the pool.
    expect(previewTrade(market, "buy", 1_000_000n, 100, 0n).ok).toBe(true);
  });
});
