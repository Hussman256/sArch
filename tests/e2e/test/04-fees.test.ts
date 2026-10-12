/**
 * Fee vaults (PRD module: fees, FE-1 to FE-3).
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  type Curve,
  associatedTokenAddress,
  createAssociatedTokenAccountIdempotent,
  curveFeeRates,
  curveReserves,
  quoteInForTokensOut,
} from "@archpad/sdk";
import {
  type Chain,
  connect,
  eventOf,
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

describe("creator fees", () => {
  it("accrue per coin on every trade and can be claimed at any time", async () => {
    const { client } = chain;
    const { mint, creator, plan } = await launchCoin(chain, { label: "Earn" });
    const launched = await curveOf(mint);
    await waitUntil(chain, launched.earlyWindowEnd);
    const trader = await newWallet(chain, { btc: 100_000_000n });

    // The creator's own launch buy already paid them a fee.
    let accrued = plan.creatorBuy.fees.creator;
    expect(await client.getUnclaimedCreatorFees(mint)).toBe(accrued);

    // A buy and a sell by someone else each add their creator share.
    const buy = client.planCurveBuy(trader.address, await curveOf(mint), 4_000_000n, 100);
    await client.sendAndConfirm(buy.instructions, [trader]);
    accrued += buy.quote.fees.creator;
    const sell = client.planCurveSell(trader.address, await curveOf(mint), buy.quote.tokensOut / 2n, 100);
    await client.sendAndConfirm(sell.instructions, [trader]);
    accrued += sell.quote.fees.creator;
    expect(await client.getUnclaimedCreatorFees(mint)).toBe(accrued);

    // FE-2: the creator takes all of it, whenever they like, into their own account.
    const before = await client.getTokenBalance(creator.address, chain.btc);
    const claimed = await client.sendAndConfirm(client.planClaimCreatorFees(creator.address, launched), [creator]);
    expect((await client.getTokenBalance(creator.address, chain.btc)) - before).toBe(accrued);
    expect(await client.getUnclaimedCreatorFees(mint)).toBe(0n);
    expect(eventOf(claimed, "CreatorFeesClaimed")).toMatchObject({ mint, creator: creator.address, amount: accrued });

    // Nothing left: a second claim is refused rather than paying zero.
    const empty = await expectFailure(chain, client.planClaimCreatorFees(creator.address, launched), [creator]);
    expect(empty.programError?.name).toBe("NothingToClaim");

    // More trading, more fees, claimable again.
    const again = client.planCurveBuy(trader.address, await curveOf(mint), 1_000_000n, 100);
    await client.sendAndConfirm(again.instructions, [trader]);
    expect(await client.getUnclaimedCreatorFees(mint)).toBe(again.quote.fees.creator);
    await client.sendAndConfirm(client.planClaimCreatorFees(creator.address, launched), [creator]);
    expect(await client.getUnclaimedCreatorFees(mint)).toBe(0n);
  });

  it("can only be claimed by the coin's creator", async () => {
    const { client } = chain;
    const { mint } = await launchCoin(chain, { label: "Mine" });
    const thief = await newWallet(chain, { btc: 1_000_000n });
    const accrued = await client.getUnclaimedCreatorFees(mint);
    expect(accrued).toBeGreaterThan(0n);

    // The thief signs, and asks for the money in their own account.
    const destination = associatedTokenAddress(thief.address, chain.btc);
    const attempt = await expectFailure(
      chain,
      [client.instructions.claimCreatorFees(thief.address, mint, destination)],
      [thief],
    );
    expect(attempt.programError?.name).toBe("Unauthorized");

    // Another coin's creator cannot reach across either.
    const other = await launchCoin(chain, { label: "Theirs" });
    const crossed = await expectFailure(
      chain,
      [
        client.instructions.claimCreatorFees(
          other.creator.address,
          mint,
          associatedTokenAddress(other.creator.address, chain.btc),
        ),
      ],
      [other.creator],
    );
    expect(crossed.programError?.name).toBe("Unauthorized");
    expect(await client.getUnclaimedCreatorFees(mint)).toBe(accrued);
  });

  it("keep accruing from the pool after graduation", async () => {
    const { client } = chain;
    const { mint, creator } = await launchCoin(chain, { label: "AfterGrad" });
    const launched = await curveOf(mint);
    await waitUntil(chain, launched.earlyWindowEnd);
    const whale = await newWallet(chain, { btc: 5_000_000_000n });

    // Buy the whole curve: the coin graduates.
    const curve = await curveOf(mint);
    const all = quoteInForTokensOut(curveReserves(curve), curveFeeRates(curve), curve.realToken);
    await client.sendAndConfirm(client.planCurveBuy(whale.address, curve, all * 2n, 100).instructions, [whale]);
    const pool = (await client.getPool(mint))!;
    expect(pool.creator).toBe(creator.address);
    await client.sendAndConfirm(client.planClaimCreatorFees(creator.address, launched), [creator]);

    // Pool swaps pay the creator's share into the same vault.
    const swap = client.planPoolSwap(whale.address, pool, true, 50_000_000n, 100);
    await client.sendAndConfirm(swap.instructions, [whale]);
    const earned = await client.getUnclaimedCreatorFees(mint);
    expect(earned).toBe(swap.quote.fees.creator);
    expect(earned).toBeGreaterThan(0n);

    const before = await client.getTokenBalance(creator.address, chain.btc);
    await client.sendAndConfirm(client.planClaimCreatorFees(creator.address, launched), [creator]);
    expect((await client.getTokenBalance(creator.address, chain.btc)) - before).toBe(earned);
  });
});

describe("platform fees", () => {
  it("can be sent on by anyone, but only ever to the treasury", async () => {
    const { client } = chain;
    const config = (await client.getConfig())!;
    const treasury = config.active.treasury;
    // Make sure there is something in the vault.
    await launchCoin(chain, { quote: chain.usd, label: "Platform" });
    const waiting = await client.getUnwithdrawnPlatformFees(chain.usd);
    expect(waiting).toBeGreaterThan(0n);

    // A passer-by triggers the withdrawal and names their own account.
    const stranger = await newWallet(chain, { usd: 1_000_000n });
    const greedy = await expectFailure(
      chain,
      [client.instructions.withdrawPlatformFees(chain.usd, associatedTokenAddress(stranger.address, chain.usd))],
      [stranger],
    );
    expect(greedy.programError?.name).toBe("AccountMismatch");
    expect(await client.getUnwithdrawnPlatformFees(chain.usd)).toBe(waiting);

    // Pointed at the treasury's account, the same passer-by's transaction goes through.
    const treasuryAccount = associatedTokenAddress(treasury, chain.usd);
    const before = await client.getTokenAccountBalance(treasuryAccount);
    const sent = await client.sendAndConfirm(
      [
        createAssociatedTokenAccountIdempotent(stranger.address, treasury, chain.usd),
        client.instructions.withdrawPlatformFees(chain.usd, treasuryAccount),
      ],
      [stranger],
    );
    expect((await client.getTokenAccountBalance(treasuryAccount)) - before).toBe(waiting);
    expect(await client.getUnwithdrawnPlatformFees(chain.usd)).toBe(0n);
    expect(eventOf(sent, "PlatformFeesWithdrawn")).toMatchObject({ quoteMint: chain.usd, amount: waiting });

    const empty = await expectFailure(
      chain,
      [client.instructions.withdrawPlatformFees(chain.usd, treasuryAccount)],
      [stranger],
    );
    expect(empty.programError?.name).toBe("NothingToClaim");
  });

  it("cannot be drained by naming one asset's vault and another's destination", async () => {
    const { client } = chain;
    const config = (await client.getConfig())!;
    await launchCoin(chain, { label: "Mismatch" });
    const stranger = await newWallet(chain);
    // The BTC vault, with the treasury's dollar account as the destination.
    const honest = client.instructions.withdrawPlatformFees(chain.btc, associatedTokenAddress(config.active.treasury, chain.usd));
    const failure = await expectFailure(
      chain,
      [createAssociatedTokenAccountIdempotent(stranger.address, config.active.treasury, chain.usd), honest],
      [stranger],
    );
    expect(failure.programError?.name).toBe("AccountMismatch");
  });
});
