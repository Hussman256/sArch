/**
 * Graduation and the pool (PRD module: graduation, GR-1 to GR-5).
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  type Curve,
  type Instruction,
  type Signer,
  CurveStatus,
  TOKEN_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TRADE_COMPUTE_UNITS,
  ByteWriter,
  bpsCeil,
  curveFeeRates,
  curveReserves,
  decodeTokenAccount,
  poolFeeRates,
  poolQuoteBuy,
  poolQuoteSell,
  poolReserves,
  quoteInForTokensOut,
  setComputeUnitLimit,
  systemTransfer,
} from "@archpad/sdk";
import { lamportsOf } from "@archpad/ops";
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

beforeAll(async () => {
  chain = await connect();
});

const curveOf = async (mint: string): Promise<Curve> => (await chain.client.getCurve(mint))!;

/** A coin past its launch window with `soldBps` of its curve already sold. */
async function coinSoldTo(label: string, soldBps: number, quote = chain.btc) {
  const coin = await launchCoin(chain, { quote, label });
  const launched = await curveOf(coin.mint);
  await waitUntil(chain, launched.earlyWindowEnd);
  const whale = await newWallet(chain, { btc: 5_000_000_000n, usd: 5_000_000_000_000n });
  const sold = launched.curveSupply - launched.realToken;
  const target = bpsCeil(launched.curveSupply, soldBps) - sold;
  if (target > 0n) {
    const cost = quoteInForTokensOut(curveReserves(launched), curveFeeRates(launched), target);
    await chain.client.sendAndConfirm(chain.client.planCurveBuy(whale.address, launched, cost, 100).instructions, [whale]);
  }
  return { ...coin, whale };
}

/** Buys everything left on the curve, which graduates the coin. */
async function finish(mint: string, buyer: Signer) {
  const curve = await curveOf(mint);
  // Offer far more than the remaining tokens cost; the program takes only what it needs.
  const plan = chain.client.planCurveBuy(buyer.address, curve, 2_000_000_000n, 100);
  expect(plan.quote.completesCurve).toBe(true);
  return { plan, processed: await chain.client.sendAndConfirm(plan.instructions, [buyer]) };
}

describe("graduation", () => {
  it("moves the curve into a locked pool inside the buy that sells the last token", async () => {
    const { client, rpc } = chain;
    const a = client.addresses;
    const { mint, creator } = await coinSoldTo("Graduate", 6_000);
    const buyer = await newWallet(chain, { btc: 2_000_000_000n });

    const before = await curveOf(mint);
    const quoteVaultBefore = await client.getTokenAccountBalance(before.quoteVault);
    const platformBefore = await client.getUnwithdrawnPlatformFees(chain.btc);
    const creatorFeesBefore = await client.getUnclaimedCreatorFees(mint);
    expect(await rpc.getAccount(a.pool(mint))).toBeNull();

    const { plan, processed } = await finish(mint, buyer);

    // GR-1: no separate step, no keeper. One transaction, signed by the buyer.
    expect(processed.transaction.signatures).toHaveLength(1);
    expect(eventsOf(processed).map((event) => event.type)).toEqual(["Trade", "Graduated"]);

    // The buyer received every token that was left and paid only for those.
    expect(await client.getTokenBalance(buyer.address, mint)).toBe(before.realToken);
    expect(plan.quote.tokensOut).toBe(before.realToken);
    expect(plan.quote.quoteCharged).toBeLessThan(2_000_000_000n);
    expect(2_000_000_000n - (await client.getTokenBalance(buyer.address, chain.btc))).toBe(plan.quote.quoteCharged);

    const curve = await curveOf(mint);
    expect(curve.status).toBe(CurveStatus.Graduated);
    expect(curve.graduatedAt).toBeGreaterThan(0n);
    expect(curve.realToken).toBe(0n);

    // GR-2: everything the curve held is now the pool's, to the base unit.
    const pool = (await client.getPool(mint))!;
    const raised = quoteVaultBefore + plan.quote.quoteToCurve;
    const heldBack = before.totalSupply - before.curveSupply;
    expect(pool).toMatchObject({
      mint,
      quoteMint: chain.btc,
      creator: creator.address,
      quoteReserve: raised,
      tokenReserve: heldBack,
      platformFeeVault: before.platformFeeVault,
      creatorFeeVault: before.creatorFeeVault,
      lpFeeBps: before.poolLpFeeBps,
      platformFeeBps: before.poolPlatformFeeBps,
      creatorFeeBps: before.poolCreatorFeeBps,
    });
    expect(curve.realQuote).toBe(raised);
    expect(await client.getTokenAccountBalance(pool.quoteVault)).toBe(raised);
    expect(await client.getTokenAccountBalance(pool.tokenVault)).toBe(heldBack);
    expect(await client.getTokenAccountBalance(curve.quoteVault)).toBe(0n);
    expect(await client.getTokenAccountBalance(curve.tokenVault)).toBe(0n);
    expect(eventOf(processed, "Graduated")).toMatchObject({
      mint,
      pool: a.pool(mint),
      quoteAmount: raised,
      tokenAmount: heldBack,
    });

    // GR-4: graduating cost nothing. The only fees in this transaction are the
    // ordinary trading fees on the final buy.
    expect((await client.getUnwithdrawnPlatformFees(chain.btc)) - platformBefore).toBe(plan.quote.fees.platform);
    expect((await client.getUnclaimedCreatorFees(mint)) - creatorFeesBefore).toBe(plan.quote.fees.creator);

    // GR-3: the liquidity belongs to an address only the pool program can
    // sign for. There is no LP token and no key that could withdraw it.
    for (const vault of [pool.tokenVault, pool.quoteVault]) {
      const account = (await rpc.getAccount(vault))!;
      expect(account.owner).toBe(TOKEN_PROGRAM_ID);
      const token = decodeTokenAccount(account.data);
      expect(token.owner).toBe(a.pool(mint));
      expect(token.delegate).toBeNull();
      expect(token.closeAuthority).toBeNull();
    }

    // The pool opens at the price the curve closed at.
    const curvePrice = Number(curve.virtualQuote) / Number(curve.virtualToken);
    const poolPrice = Number(pool.quoteReserve) / Number(pool.tokenReserve);
    expect(Math.abs(poolPrice / curvePrice - 1)).toBeLessThan(0.01);

    const units = computeUnits(processed, chain.deployment.programs.launch);
    console.log(
      `graduating buy: ${units} compute units; pool opened at ${(100 * (poolPrice / curvePrice - 1)).toFixed(3)}% ` +
        `from the curve's closing price with ${raised} base units of quote`,
    );
    expect(units).toBeGreaterThan(0);
    expect(units).toBeLessThan(TRADE_COMPUTE_UNITS);
  });

  it("closes the curve for good and trades on through the pool", async () => {
    const { client } = chain;
    const { mint, whale } = await coinSoldTo("PoolTrade", 9_000);
    const trader = await newWallet(chain, { btc: 2_000_000_000n });
    await finish(mint, trader);
    const graduated = await curveOf(mint);

    // The curve refuses both directions from now on.
    const lateBuy = await expectFailure(
      chain,
      [client.instructions.buy(whale.address, mint, chain.btc, 100_000n, 0n)],
      [whale],
    );
    expect(lateBuy.programError?.name).toBe("CurveGraduated");
    const lateSell = await expectFailure(
      chain,
      [client.instructions.sell(whale.address, mint, chain.btc, 1_000_000n, 0n)],
      [whale],
    );
    expect(lateSell.programError?.name).toBe("CurveGraduated");
    expect(() => client.planCurveBuy(whale.address, graduated, 100_000n, 100)).toThrow(/graduated/);

    // A pool buy fills at the quoted price and pays the pool's fee split.
    let pool = (await client.getPool(mint))!;
    const platformBefore = await client.getUnwithdrawnPlatformFees(chain.btc);
    const creatorBefore = await client.getUnclaimedCreatorFees(mint);
    const tokensBefore = await client.getTokenBalance(trader.address, mint);
    const expectedBuy = poolQuoteBuy(poolReserves(pool), poolFeeRates(pool), 1_000_000n);
    const buyPlan = client.planPoolSwap(trader.address, pool, true, 1_000_000n, 50);
    const bought = await client.sendAndConfirm(buyPlan.instructions, [trader]);
    expect((await client.getTokenBalance(trader.address, mint)) - tokensBefore).toBe(expectedBuy.tokensOut);
    expect(eventOf(bought, "PoolSwap")).toMatchObject({
      mint,
      trader: trader.address,
      isBuy: true,
      quoteAmount: expectedBuy.quoteToPool,
      tokenAmount: expectedBuy.tokensOut,
      lpFee: expectedBuy.fees.lp,
      platformFee: expectedBuy.fees.platform,
      creatorFee: expectedBuy.fees.creator,
    });
    expect((await client.getUnwithdrawnPlatformFees(chain.btc)) - platformBefore).toBe(expectedBuy.fees.platform);
    expect((await client.getUnclaimedCreatorFees(mint)) - creatorBefore).toBe(expectedBuy.fees.creator);

    // The liquidity share of the fee stays in the pool, so the pool only deepens.
    const afterBuy = (await client.getPool(mint))!;
    expect(afterBuy.quoteReserve).toBe(pool.quoteReserve + expectedBuy.quoteToPool + expectedBuy.fees.lp);
    expect(afterBuy.tokenReserve).toBe(pool.tokenReserve - expectedBuy.tokensOut);
    expect(afterBuy.quoteReserve * afterBuy.tokenReserve).toBeGreaterThan(pool.quoteReserve * pool.tokenReserve);
    expect(await client.getTokenAccountBalance(afterBuy.quoteVault)).toBe(afterBuy.quoteReserve);
    expect(await client.getTokenAccountBalance(afterBuy.tokenVault)).toBe(afterBuy.tokenReserve);

    // A pool sell, by someone who bought on the curve.
    pool = afterBuy;
    const selling = (await client.getTokenBalance(whale.address, mint)) / 10n;
    const quoteBefore = await client.getTokenBalance(whale.address, chain.btc);
    const expectedSell = poolQuoteSell(poolReserves(pool), poolFeeRates(pool), selling);
    const sold = await client.sendAndConfirm(client.planPoolSwap(whale.address, pool, false, selling, 50).instructions, [
      whale,
    ]);
    expect((await client.getTokenBalance(whale.address, chain.btc)) - quoteBefore).toBe(expectedSell.quoteOut);
    expect(eventOf(sold, "PoolSwap")).toMatchObject({
      isBuy: false,
      quoteAmount: expectedSell.quoteFromPool,
      tokenAmount: selling,
      lpFee: expectedSell.fees.lp,
    });
    const afterSell = (await client.getPool(mint))!;
    expect(afterSell.quoteReserve * afterSell.tokenReserve).toBeGreaterThan(pool.quoteReserve * pool.tokenReserve);
    expect(await client.getTokenAccountBalance(afterSell.quoteVault)).toBe(afterSell.quoteReserve);
    expect(await client.getTokenAccountBalance(afterSell.tokenVault)).toBe(afterSell.tokenReserve);
    console.log(
      `pool buy: ${computeUnits(bought, chain.deployment.programs.pool)} compute units; ` +
        `pool sell: ${computeUnits(sold, chain.deployment.programs.pool)}`,
    );

    // Slippage limits hold on the pool too.
    const greedy = await expectFailure(
      chain,
      [client.instructions.swap(trader.address, afterSell, true, 1_000_000n, 2n ** 62n)],
      [trader],
    );
    expect(greedy.programError?.name).toBe("SlippageExceeded");
  });

  it("undoes the whole buy if graduation cannot complete, and keeps the curve trading", async () => {
    const { client, rpc } = chain;
    const a = client.addresses;
    const { mint, whale } = await coinSoldTo("Revert", 9_500);
    const buyer = await newWallet(chain, { btc: 2_000_000_000n });
    const before = await curveOf(mint);
    const rawBefore = (await rpc.getAccount(a.curve(mint)))!.data;
    const honest = client.planCurveBuy(buyer.address, before, 2_000_000_000n, 100);
    expect(honest.quote.completesCurve).toBe(true);
    const [budget, ata, buy] = honest.instructions as [Instruction, Instruction, Instruction];

    // GR-5, first way to fail: the buy completes the curve but brings no pool accounts.
    const noPool = { ...buy, accounts: buy.accounts.slice(0, 12) };
    const missing = await expectFailure(chain, [budget, ata, noPool], [buyer]);
    expect(missing.programError?.name).toBe("GraduationAccountsRequired");

    // Second way: the pool accounts are wrong, so the pool program refuses.
    const other = await launchCoin(chain, { label: "Other" });
    const wrongPool = {
      ...buy,
      accounts: buy.accounts.map((account, index) =>
        index === 13 ? { ...account, pubkey: a.pool(other.mint) } : account,
      ),
    };
    await expectFailure(chain, [budget, ata, wrongPool], [buyer]);

    // Third way: the buyer cannot actually pay for the last tokens.
    const broke = await newWallet(chain, { btc: 1_000n });
    await expectFailure(chain, client.planCurveBuy(broke.address, before, 2_000_000_000n, 100).instructions, [broke]);

    // Nothing happened: same curve bytes, no pool, buyer's money untouched.
    expect((await rpc.getAccount(a.curve(mint)))!.data).toEqual(rawBefore);
    expect(await rpc.getAccount(a.pool(mint))).toBeNull();
    expect(await client.getTokenBalance(buyer.address, chain.btc)).toBe(2_000_000_000n);
    expect(await client.getTokenBalance(buyer.address, mint)).toBe(0n);

    // And the coin still trades: a sell goes through, then the honest buy graduates it.
    const selling = (await client.getTokenBalance(whale.address, mint)) / 100n;
    await client.sendAndConfirm(client.planCurveSell(whale.address, before, selling, 100).instructions, [whale]);
    expect((await curveOf(mint)).status).toBe(CurveStatus.Trading);
    await finish(mint, buyer);
    expect((await curveOf(mint)).status).toBe(CurveStatus.Graduated);
    expect((await client.getPool(mint))!.tokenReserve).toBe(before.totalSupply - before.curveSupply);
  });

  it("cannot be blocked by someone funding the pool's addresses in advance", async () => {
    const { client, rpc } = chain;
    const a = client.addresses;
    const { mint } = await coinSoldTo("PoolGrief", 9_000);
    const griefer = await newWallet(chain, { lamports: 5_000_000n });
    const targets = [a.pool(mint), a.poolTokenVault(mint), a.poolQuoteVault(mint)];
    await client.sendAndConfirm(
      targets.map((target) => systemTransfer(griefer.address, target, 5_000n)),
      [griefer],
    );
    for (const target of targets) expect(await lamportsOf(rpc, target)).toBe(5_000n);

    const buyer = await newWallet(chain, { btc: 2_000_000_000n });
    await finish(mint, buyer);
    expect((await curveOf(mint)).status).toBe(CurveStatus.Graduated);
  });

  it("lets nobody but a completed curve open a pool, and offers no way to take liquidity out", async () => {
    const { client } = chain;
    const a = client.addresses;
    const { mint } = await coinSoldTo("Outsider", 5_000);
    const outsider = await newWallet(chain, { btc: 100_000_000n });
    const curve = await curveOf(mint);

    // Someone calls the pool program directly to open this coin's pool early
    // on their own terms. The curve's address has not signed, so it is refused.
    const initialize: Instruction = {
      programId: a.programs.pool,
      accounts: [
        { pubkey: outsider.address, isSigner: true, isWritable: true },
        { pubkey: a.curve(mint), isSigner: false, isWritable: false },
        { pubkey: a.pool(mint), isSigner: false, isWritable: true },
        { pubkey: a.poolTokenVault(mint), isSigner: false, isWritable: true },
        { pubkey: a.poolQuoteVault(mint), isSigner: false, isWritable: true },
        { pubkey: curve.tokenVault, isSigner: false, isWritable: true },
        { pubkey: curve.quoteVault, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: chain.btc, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: new ByteWriter()
        .u8(0)
        .u64(1_000n)
        .u64(1_000n)
        .address(outsider.address)
        .address(curve.platformFeeVault)
        .address(curve.creatorFeeVault)
        .u16(0)
        .u16(0)
        .u16(0)
        .finish(),
    };
    const refused = await expectFailure(chain, [setComputeUnitLimit(TRADE_COMPUTE_UNITS), initialize], [outsider]);
    expect(refused.programError?.name).toBe("Unauthorized");
    expect(await chain.rpc.getAccount(a.pool(mint))).toBeNull();

    // The pool program has two instructions, open and swap. Anything else,
    // including whatever a "remove liquidity" would be numbered, does not exist.
    for (const tag of [2, 3, 4, 255]) {
      const unknown: Instruction = { programId: a.programs.pool, accounts: [], data: Uint8Array.of(tag) };
      const failure = await expectFailure(chain, [unknown], [outsider]);
      expect(failure.programError?.name).toBe("InvalidInstruction");
    }
  });
});
