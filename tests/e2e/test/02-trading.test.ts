/**
 * Trading on the curve (PRD module: bonding curve, BC-1 to BC-8; fees FE-1).
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  type Curve,
  type GlobalConfig,
  type Instruction,
  EVENT_IX_TAG,
  TRADE_COMPUTE_UNITS,
  bpsCeil,
  bpsFloor,
  curveFeeRates,
  curveReserves,
  quoteBuy,
  quoteInForTokensOut,
  quoteSell,
  setComputeUnitLimit,
} from "@archpad/sdk";
import {
  type Chain,
  computeUnits,
  connect,
  eventOf,
  eventsOf,
  expectFailure,
  launchCoin,
  newWallet,
  waitUntil,
} from "../src/harness.ts";

let chain: Chain;
let config: GlobalConfig;

beforeAll(async () => {
  chain = await connect();
  config = (await chain.client.getConfig())!;
});

const curveOf = async (mint: string): Promise<Curve> => (await chain.client.getCurve(mint))!;

/** Quote needed right now to buy `bps` of the curve supply. */
const costOf = (curve: Curve, bps: number): bigint =>
  quoteInForTokensOut(curveReserves(curve), curveFeeRates(curve), bpsCeil(curve.curveSupply, bps));

/** A coin whose launch window has already closed, so the wallet cap is out of the way. */
async function seasonedCoin(label: string, quote = chain.btc) {
  const coin = await launchCoin(chain, { quote, label });
  const curve = await curveOf(coin.mint);
  await waitUntil(chain, curve.earlyWindowEnd);
  return coin;
}

describe("trading on the curve", () => {
  it("fills a buy at exactly the quoted price and pays both fees in the same transaction", async () => {
    const { client } = chain;
    const { mint } = await seasonedCoin("Buy");
    const trader = await newWallet(chain, { btc: 50_000_000n });
    const before = await curveOf(mint);
    const platformBefore = await client.getUnwithdrawnPlatformFees(chain.btc);
    const creatorBefore = await client.getUnclaimedCreatorFees(mint);

    const spend = 1_000_000n;
    const plan = client.planCurveBuy(trader.address, before, spend, 100);
    const processed = await client.sendAndConfirm(plan.instructions, [trader]);

    // BC-3: what the trader was shown is what they got.
    expect(await client.getTokenBalance(trader.address, mint)).toBe(plan.quote.tokensOut);
    expect(50_000_000n - (await client.getTokenBalance(trader.address, chain.btc))).toBe(plan.quote.quoteCharged);
    expect(plan.quote.quoteCharged).toBeLessThanOrEqual(spend);

    // FE-1: the fee is charged in the quote asset, in this transaction, and
    // split between the platform and the creator as the config says.
    const { platform, creator } = plan.quote.fees;
    expect(platform + creator).toBe(bpsCeil(plan.quote.quoteToCurve, before.platformFeeBps + before.creatorFeeBps));
    expect(platform).toBe(
      ((platform + creator) * BigInt(before.platformFeeBps)) / BigInt(before.platformFeeBps + before.creatorFeeBps),
    );
    expect((await client.getUnwithdrawnPlatformFees(chain.btc)) - platformBefore).toBe(platform);
    expect((await client.getUnclaimedCreatorFees(mint)) - creatorBefore).toBe(creator);

    // The curve's books match the money actually in its vaults.
    const after = await curveOf(mint);
    expect(curveReserves(after)).toEqual(plan.quote.reservesAfter);
    expect(await client.getTokenAccountBalance(after.quoteVault)).toBe(after.realQuote);
    expect(await client.getTokenAccountBalance(after.tokenVault)).toBe(
      after.realToken + (after.totalSupply - after.curveSupply),
    );

    expect(eventOf(processed, "Trade")).toMatchObject({
      mint,
      trader: trader.address,
      isBuy: true,
      quoteAmount: plan.quote.quoteToCurve,
      tokenAmount: plan.quote.tokensOut,
      platformFee: platform,
      creatorFee: creator,
      realQuote: after.realQuote,
      realToken: after.realToken,
    });
    const units = computeUnits(processed, chain.deployment.programs.launch);
    console.log(`curve buy: ${units} compute units`);
    expect(units).toBeGreaterThan(0);
    expect(units).toBeLessThan(TRADE_COMPUTE_UNITS);
  });

  it("fills a sell at exactly the quoted price, fee deducted from the proceeds", async () => {
    const { client } = chain;
    const { mint } = await seasonedCoin("Sell");
    const trader = await newWallet(chain, { btc: 50_000_000n });
    await client.sendAndConfirm(client.planCurveBuy(trader.address, await curveOf(mint), 2_000_000n, 100).instructions, [
      trader,
    ]);

    const held = await client.getTokenBalance(trader.address, mint);
    const quoteBefore = await client.getTokenBalance(trader.address, chain.btc);
    const platformBefore = await client.getUnwithdrawnPlatformFees(chain.btc);
    const creatorBefore = await client.getUnclaimedCreatorFees(mint);
    const before = await curveOf(mint);

    const selling = held / 2n;
    const plan = client.planCurveSell(trader.address, before, selling, 100);
    const processed = await client.sendAndConfirm(plan.instructions, [trader]);

    expect(await client.getTokenBalance(trader.address, mint)).toBe(held - selling);
    expect((await client.getTokenBalance(trader.address, chain.btc)) - quoteBefore).toBe(plan.quote.quoteOut);
    expect(plan.quote.quoteOut).toBe(
      plan.quote.quoteFromCurve - plan.quote.fees.platform - plan.quote.fees.creator,
    );
    expect((await client.getUnwithdrawnPlatformFees(chain.btc)) - platformBefore).toBe(plan.quote.fees.platform);
    expect((await client.getUnclaimedCreatorFees(mint)) - creatorBefore).toBe(plan.quote.fees.creator);

    const after = await curveOf(mint);
    expect(curveReserves(after)).toEqual(plan.quote.reservesAfter);
    expect(await client.getTokenAccountBalance(after.quoteVault)).toBe(after.realQuote);
    expect(eventOf(processed, "Trade")).toMatchObject({
      isBuy: false,
      quoteAmount: plan.quote.quoteFromCurve,
      tokenAmount: selling,
    });
    console.log(`curve sell: ${computeUnits(processed, chain.deployment.programs.launch)} compute units`);
  });

  it("never pays a round trip more than was put in", async () => {
    const { client } = chain;
    const { mint } = await seasonedCoin("RoundTrip");
    const trader = await newWallet(chain, { btc: 50_000_000n });
    const start = await client.getTokenBalance(trader.address, chain.btc);

    const buy = client.planCurveBuy(trader.address, await curveOf(mint), 3_000_000n, 0);
    await client.sendAndConfirm(buy.instructions, [trader]);
    const sell = client.planCurveSell(trader.address, await curveOf(mint), buy.quote.tokensOut, 0);
    await client.sendAndConfirm(sell.instructions, [trader]);

    const end = await client.getTokenBalance(trader.address, chain.btc);
    expect(end).toBeLessThan(start);
    // The loss is the two fees plus at most a few base units of rounding.
    const fees =
      buy.quote.fees.platform + buy.quote.fees.creator + sell.quote.fees.platform + sell.quote.fees.creator;
    expect(start - end).toBeGreaterThanOrEqual(fees);
    expect(start - end).toBeLessThanOrEqual(fees + 3n);
    expect(await client.getTokenBalance(trader.address, mint)).toBe(0n);
  });

  it("enforces the trader's slippage limit on buys and sells", async () => {
    const { client } = chain;
    const { mint } = await seasonedCoin("Slippage");
    const trader = await newWallet(chain, { btc: 50_000_000n });
    const whale = await newWallet(chain, { btc: 500_000_000n });

    // BC-4: the trader quotes a buy with 0.5% tolerance; a larger buy lands
    // first and moves the price by more than that.
    const stale = client.planCurveBuy(trader.address, await curveOf(mint), 1_000_000n, 50);
    await client.sendAndConfirm(client.planCurveBuy(whale.address, await curveOf(mint), 3_000_000n, 100).instructions, [
      whale,
    ]);
    const lateBuy = await expectFailure(chain, stale.instructions, [trader]);
    expect(lateBuy.programError?.name).toBe("SlippageExceeded");
    expect(await client.getTokenBalance(trader.address, mint)).toBe(0n);
    expect(await client.getTokenBalance(trader.address, chain.btc)).toBe(50_000_000n);

    // Re-quoted against the new price, the same buy goes through.
    const fresh = client.planCurveBuy(trader.address, await curveOf(mint), 1_000_000n, 50);
    await client.sendAndConfirm(fresh.instructions, [trader]);
    expect(fresh.quote.tokensOut).toBeLessThan(stale.quote.tokensOut);

    // The same protection on the way out: the whale sells first.
    const held = await client.getTokenBalance(trader.address, mint);
    const staleSell = client.planCurveSell(trader.address, await curveOf(mint), held, 50);
    const whaleHeld = await client.getTokenBalance(whale.address, mint);
    await client.sendAndConfirm(client.planCurveSell(whale.address, await curveOf(mint), whaleHeld, 100).instructions, [
      whale,
    ]);
    const lateSell = await expectFailure(chain, staleSell.instructions, [trader]);
    expect(lateSell.programError?.name).toBe("SlippageExceeded");
    expect(await client.getTokenBalance(trader.address, mint)).toBe(held);

    // A limit one base unit above the true price is refused; the true price is accepted.
    const curve = await curveOf(mint);
    const exact = quoteSell(curveReserves(curve), curveFeeRates(curve), held);
    const tooGreedy = await expectFailure(
      chain,
      [client.instructions.sell(trader.address, mint, chain.btc, held, exact.quoteOut + 1n)],
      [trader],
    );
    expect(tooGreedy.programError?.name).toBe("SlippageExceeded");
    await client.sendAndConfirm([client.instructions.sell(trader.address, mint, chain.btc, held, exact.quoteOut)], [
      trader,
    ]);
  });

  it("caps each wallet at 2% of the curve for the first seconds, then lifts the cap", async () => {
    const { client } = chain;
    const launch = config.active.launch;
    // Wallets are funded before the launch so the window is not spent on setup.
    const alice = await newWallet(chain, { btc: 100_000_000n });
    const bob = await newWallet(chain, { btc: 100_000_000n });
    const { mint } = await launchCoin(chain, { label: "Cap" });
    const launched = await curveOf(mint);
    const cap = bpsFloor(launched.curveSupply, launch.earlyWalletCapBps);
    expect(launched.earlyWalletCap).toBe(cap);
    expect(launched.earlyWindowEnd - launched.launchedAt).toBe(BigInt(launch.earlyWindowSecs));

    const buy = async (who: typeof alice, bps: number) =>
      client.planCurveBuy(who.address, await curveOf(mint), costOf(await curveOf(mint), bps), 10_000);

    // BC-7: one buy over the cap is refused outright.
    const tooBig = await expectFailure(chain, (await buy(alice, launch.earlyWalletCapBps + 50)).instructions, [alice]);
    expect(tooBig.programError?.name).toBe("WalletCapExceeded");

    // Under the cap is fine, and the wallet's running total is recorded (BC-8).
    const first = await buy(alice, 150);
    await client.sendAndConfirm(first.instructions, [alice]);
    expect((await client.getPosition(mint, alice.address))?.windowBought).toBe(first.quote.tokensOut);

    // The cap is on the total, so a second buy that would cross it is refused.
    const second = await expectFailure(chain, (await buy(alice, 100)).instructions, [alice]);
    expect(second.programError?.name).toBe("WalletCapExceeded");

    // It is per wallet: someone else still has their full allowance.
    const bobs = await buy(bob, 190);
    await client.sendAndConfirm(bobs.instructions, [bob]);
    expect(await client.getTokenBalance(bob.address, mint)).toBe(bobs.quote.tokensOut);

    // Selling is never restricted, and does not hand the allowance back.
    await client.sendAndConfirm(
      client.planCurveSell(alice.address, await curveOf(mint), first.quote.tokensOut, 10_000).instructions,
      [alice],
    );
    expect((await client.getPosition(mint, alice.address))?.windowBought).toBe(first.quote.tokensOut);

    // Once the window has passed, the cap is gone.
    await waitUntil(chain, launched.earlyWindowEnd);
    const later = await buy(alice, 400);
    await client.sendAndConfirm(later.instructions, [alice]);
    expect(await client.getTokenBalance(alice.address, mint)).toBe(later.quote.tokensOut);
    expect(later.quote.tokensOut).toBeGreaterThan(cap);
  });

  it("charges early buyers the same fee as everyone else", async () => {
    const { client } = chain;
    const early = await newWallet(chain, { btc: 50_000_000n });
    const late = await newWallet(chain, { btc: 50_000_000n });
    const { mint } = await launchCoin(chain, { label: "FlatFee" });
    const launched = await curveOf(mint);
    const totalBps = launched.platformFeeBps + launched.creatorFeeBps;

    // BC-5: a buy inside the launch window (small enough to sit under the cap)...
    const inWindow = await client.sendAndConfirm(
      client.planCurveBuy(early.address, launched, 20_000n, 100).instructions,
      [early],
    );
    // ...and one after it pay the same rate.
    await waitUntil(chain, launched.earlyWindowEnd);
    const afterWindow = await client.sendAndConfirm(
      client.planCurveBuy(late.address, await curveOf(mint), 20_000n, 100).instructions,
      [late],
    );
    for (const processed of [inWindow, afterWindow]) {
      const trade = eventOf(processed, "Trade");
      expect(trade.platformFee + trade.creatorFee).toBe(bpsCeil(trade.quoteAmount, totalBps));
    }
  });

  it("rejects trades that are zero, dust, or more than the trader holds", async () => {
    const { client } = chain;
    const { mint } = await seasonedCoin("Edges");
    const trader = await newWallet(chain, { btc: 1_000_000n });
    const buy = (maxQuoteIn: bigint) => [client.instructions.buy(trader.address, mint, chain.btc, maxQuoteIn, 0n)];
    const setup = client.planCurveBuy(trader.address, await curveOf(mint), 100_000n, 100);
    await client.sendAndConfirm(setup.instructions, [trader]);
    const held = await client.getTokenBalance(trader.address, mint);

    expect((await expectFailure(chain, buy(0n), [trader])).programError?.name).toBe("ZeroAmount");
    // One base unit cannot cover a fee and still buy anything.
    expect((await expectFailure(chain, buy(1n), [trader])).programError?.name).toBe("DustTrade");
    // More quote than the wallet has: the token program refuses the transfer.
    await expectFailure(chain, buy(900_000_000n), [trader]);

    const sell = (tokensIn: bigint) => [client.instructions.sell(trader.address, mint, chain.btc, tokensIn, 0n)];
    expect((await expectFailure(chain, sell(0n), [trader])).programError?.name).toBe("ZeroAmount");
    await expectFailure(chain, sell(held + 1n), [trader]);

    // None of that moved anything.
    expect(await client.getTokenBalance(trader.address, mint)).toBe(held);
    const curve = await curveOf(mint);
    expect(await client.getTokenAccountBalance(curve.quoteVault)).toBe(curve.realQuote);
  });

  it("will not let one coin's accounts be swapped for another's", async () => {
    const { client } = chain;
    const a = await seasonedCoin("VaultA");
    const b = await seasonedCoin("VaultB");
    const trader = await newWallet(chain, { btc: 10_000_000n });
    await client.sendAndConfirm(client.planCurveBuy(trader.address, await curveOf(a.mint), 500_000n, 100).instructions, [
      trader,
    ]);

    // A sell against coin A that names coin B's quote vault as the payer.
    const honest = client.instructions.sell(
      trader.address,
      a.mint,
      chain.btc,
      await client.getTokenBalance(trader.address, a.mint),
      0n,
    );
    const forged = {
      ...honest,
      accounts: honest.accounts.map((account, index) =>
        index === 3 ? { ...account, pubkey: client.addresses.quoteVault(b.mint) } : account,
      ),
    };
    const failure = await expectFailure(chain, [forged], [trader]);
    expect(failure.programError?.name).toBe("AccountMismatch");

    // And a creator fee vault that belongs to a different coin.
    const stolenFees = {
      ...honest,
      accounts: honest.accounts.map((account, index) =>
        index === 7 ? { ...account, pubkey: client.addresses.creatorVault(b.mint) } : account,
      ),
    };
    expect((await expectFailure(chain, [stolenFees], [trader])).programError?.name).toBe("AccountMismatch");
  });

  it("quotes the same numbers off chain as the program computes on chain", async () => {
    const { client } = chain;
    const { mint } = await seasonedCoin("Parity", chain.usd);
    const trader = await newWallet(chain, { usd: 50_000_000_000n });

    // A run of buys and sells of awkward sizes in the dollar asset.
    const sizes = [1_234_567n, 987_654_321n, 31n, 4_999_999_999n, 1_000n];
    for (const size of sizes) {
      const curve = await curveOf(mint);
      const expected = quoteBuy(curveReserves(curve), curveFeeRates(curve), size);
      const processed = await client.sendAndConfirm(client.planCurveBuy(trader.address, curve, size, 0).instructions, [
        trader,
      ]);
      expect(eventOf(processed, "Trade")).toMatchObject({
        quoteAmount: expected.quoteToCurve,
        tokenAmount: expected.tokensOut,
        platformFee: expected.fees.platform,
        creatorFee: expected.fees.creator,
        ...expected.reservesAfter,
      });
    }
    let held = await client.getTokenBalance(trader.address, mint);
    for (const divisor of [7n, 3n, 2n, 1n]) {
      const curve = await curveOf(mint);
      const selling = held / divisor;
      const expected = quoteSell(curveReserves(curve), curveFeeRates(curve), selling);
      const processed = await client.sendAndConfirm(
        client.planCurveSell(trader.address, curve, selling, 0).instructions,
        [trader],
      );
      expect(eventOf(processed, "Trade")).toMatchObject({
        quoteAmount: expected.quoteFromCurve,
        tokenAmount: selling,
        platformFee: expected.fees.platform,
        creatorFee: expected.fees.creator,
        ...expected.reservesAfter,
      });
      held -= selling;
    }
    expect(held).toBe(0n);
  });

  it("records every trade even when the transaction's log overflows", async () => {
    const { client } = chain;
    const { mint } = await seasonedCoin("Overflow");
    const trader = await newWallet(chain, { btc: 50_000_000n });
    // The first buy creates the trader's token account, so the rest are buys alone.
    await client.sendAndConfirm(client.planCurveBuy(trader.address, await curveOf(mint), 10_000n, 100).instructions, [
      trader,
    ]);

    // Eight buys in one transaction write more log than a node keeps.
    const buys = Array.from({ length: 8 }, (_, i) =>
      client.instructions.buy(trader.address, mint, chain.btc, 10_000n + BigInt(i), 0n),
    );
    const before = await curveOf(mint);
    const processed = await client.sendAndConfirm([setComputeUnitLimit(1_400_000), ...buys], [trader]);
    expect(processed.logs).toContain("Log truncated");

    // The log lost its tail, but all eight trades are on record, and they
    // chain: each starts from the reserves the one before left behind.
    const trades = eventsOf(processed);
    expect(trades.map((event) => event.type)).toEqual(Array(8).fill("Trade"));
    let reserves = curveReserves(before);
    for (const [i, trade] of trades.entries()) {
      const expected = quoteBuy(reserves, curveFeeRates(before), 10_000n + BigInt(i));
      expect(trade).toMatchObject({ quoteAmount: expected.quoteToCurve, tokenAmount: expected.tokensOut });
      reserves = expected.reservesAfter;
    }
    expect(curveReserves(await curveOf(mint))).toEqual(reserves);
  });

  it("refuses an event that the program did not record itself", async () => {
    const { client } = chain;
    const { mint, processed } = await seasonedCoin("Forgery");
    const forger = await newWallet(chain);

    // Take a real trade event and replay it as an instruction of our own,
    // naming the coin's curve as the signer without its signature.
    const real = processed.innerInstructions
      .flat()
      .map((inner) => inner.instruction.data)
      .find((data) => data[0] === EVENT_IX_TAG && data[1] === 1)!;
    expect(real).toBeDefined();
    const forged = (signer: string, isSigner: boolean): Instruction => ({
      programId: client.addresses.programs.launch,
      accounts: [{ pubkey: signer, isSigner, isWritable: false }],
      data: real,
    });
    const unsigned = await expectFailure(chain, [forged(client.addresses.curve(mint), false)], [forger]);
    expect(unsigned.programError?.name).toBe("Unauthorized");
    // Signing it themselves does not help: they are not the curve.
    const selfSigned = await expectFailure(chain, [forged(forger.address, true)], [forger]);
    expect(selfSigned.programError?.name).toBe("Unauthorized");
    // Nor does sending a trade event to a program that does not record trades.
    const wrongProgram = await expectFailure(
      chain,
      [{ ...forged(forger.address, true), programId: client.addresses.programs.pool }],
      [forger],
    );
    expect(wrongProgram.programError?.name).toBe("InvalidInstruction");
  });
});
