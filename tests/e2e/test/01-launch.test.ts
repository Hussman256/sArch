/**
 * Launching a coin (PRD module: token creation, TC-1 to TC-5).
 */
import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type GlobalConfig,
  type Instruction,
  CurveStatus,
  LAUNCH_COMPUTE_UNITS,
  associatedTokenAddress,
  bpsCeil,
  bpsFloor,
  configuredQuotes,
  initialReserves,
  keypairSigner,
  launchCurveParams,
  metadataAddress,
  quoteBuy,
  quoteInForTokensOut,
  setComputeUnitLimit,
  splitFee,
  systemTransfer,
} from "@archpad/sdk";
import { ensureMint, lamportsOf, mintTestTokens } from "@archpad/ops";
import {
  type Chain,
  coinText,
  computeUnits,
  connect,
  eventsOf,
  expectFailure,
  launchCoin,
  newWallet,
} from "../src/harness.ts";

let chain: Chain;
let config: GlobalConfig;

beforeAll(async () => {
  chain = await connect();
  const found = await chain.client.getConfig();
  if (!found) throw new Error("the config is not initialised: run `pnpm ops bootstrap`");
  config = found;
});

const salt = () => randomBytes(8).readBigUInt64LE();

/** The quote needed to buy `bps` of the curve supply from a brand-new curve. */
function budgetFor(bps: number, quoteMint = chain.btc): bigint {
  const launch = config.active.launch;
  const quote = configuredQuotes(config.active).find((entry) => entry.mint === quoteMint)!;
  const rates = { platformBps: launch.platformFeeBps, creatorBps: launch.creatorFeeBps };
  return quoteInForTokensOut(initialReserves(launchCurveParams(launch, quote)), rates, bpsCeil(launch.curveSupply, bps));
}

describe("launching a coin", () => {
  it("creates the coin, its curve and the creator's first buy in one transaction with one signature", async () => {
    const { client, rpc } = chain;
    const launch = config.active.launch;
    const creator = await newWallet(chain, { btc: 10_000_000n });
    const text = coinText("Launch");

    const lamportsBefore = await lamportsOf(rpc, creator.address);
    const quoteBefore = await client.getTokenBalance(creator.address, chain.btc);
    const platformBefore = await client.getUnwithdrawnPlatformFees(chain.btc);

    const plan = await client.planLaunch(creator.address, chain.btc, { ...text, creatorBuyBps: 50 });
    const processed = await client.sendAndConfirm(plan.instructions, [creator]);

    // TC-1: one transaction, signed once, by the creator alone.
    expect(processed.transaction.signatures).toHaveLength(1);
    expect(processed.transaction.message.accountKeys[0]).toBe(creator.address);

    // TC-3: a fixed supply nobody can add to, and nobody can freeze.
    const mint = await client.getMint(plan.mint);
    expect(mint).toMatchObject({
      mintAuthority: null,
      freezeAuthority: null,
      supply: launch.totalSupply,
      decimals: launch.tokenDecimals,
    });

    // TC-1: name, ticker, image and description are on chain, and locked.
    const coin = await client.getCoin(plan.mint);
    expect(coin?.metadata).toMatchObject({ ...text, mint: plan.mint, updateAuthority: null });

    // TC-4: the curve is priced in the asset the creator chose.
    const curve = coin!.curve;
    expect(curve.status).toBe(CurveStatus.Trading);
    expect(curve.creator).toBe(creator.address);
    expect(curve.quoteMint).toBe(chain.btc);
    expect(curve.platformFeeBps).toBe(launch.platformFeeBps);
    expect(curve.creatorFeeBps).toBe(launch.creatorFeeBps);

    // TC-5: the creator bought at least the minimum, at the curve's price,
    // paying the normal fee, and it counts toward their launch-window cap.
    const bought = await client.getTokenBalance(creator.address, plan.mint);
    expect(bought).toBe(plan.creatorBuy.tokensOut);
    expect(bought).toBeGreaterThanOrEqual(bpsCeil(launch.curveSupply, launch.minCreatorBuyBps));
    expect(await client.getPosition(plan.mint, creator.address)).toMatchObject({
      mint: plan.mint,
      wallet: creator.address,
      windowBought: bought,
    });
    expect({
      virtualQuote: curve.virtualQuote,
      virtualToken: curve.virtualToken,
      realQuote: curve.realQuote,
      realToken: curve.realToken,
    }).toEqual(plan.creatorBuy.reservesAfter);

    // TC-2: launching costs the creator nothing beyond that buy. The quote
    // they spent is exactly the buy; the platform received only its share of
    // the buy's trading fee.
    const fees = splitFee(plan.creatorBuy.quoteToCurve, {
      platformBps: launch.platformFeeBps,
      creatorBps: launch.creatorFeeBps,
    });
    const spent = quoteBefore - (await client.getTokenBalance(creator.address, chain.btc));
    expect(spent).toBe(plan.creatorBuy.quoteCharged);
    expect(spent).toBe(plan.creatorBuy.quoteToCurve + fees.platform + fees.creator);
    expect((await client.getUnwithdrawnPlatformFees(chain.btc)) - platformBefore).toBe(fees.platform);
    expect(await client.getUnclaimedCreatorFees(plan.mint)).toBe(fees.creator);
    expect(await client.getTokenAccountBalance(curve.quoteVault)).toBe(plan.creatorBuy.quoteToCurve);
    expect(await client.getTokenAccountBalance(curve.tokenVault)).toBe(launch.totalSupply - bought);

    // The log tells the story in order: the coin exists, then it trades.
    expect(eventsOf(processed).map((event) => event.type)).toEqual(["CoinCreated", "Trade"]);

    const lamportsSpent = lamportsBefore - (await lamportsOf(rpc, creator.address));
    const units = computeUnits(processed, chain.deployment.programs.launch);
    console.log(`launch: ${units} compute units, ${lamportsSpent} lamports in network fee and account rent`);
    expect(units).toBeGreaterThan(0);
    expect(units).toBeLessThan(LAUNCH_COMPUTE_UNITS);
  });

  it("can be priced in the dollar quote asset instead", async () => {
    const { client } = chain;
    const { mint, creator, plan } = await launchCoin(chain, { quote: chain.usd, label: "Dollar" });
    const curve = (await client.getCurve(mint))!;
    expect(curve.quoteMint).toBe(chain.usd);
    expect(await client.getTokenAccountBalance(curve.quoteVault)).toBe(plan.creatorBuy.quoteToCurve);
    expect(await client.getTokenBalance(creator.address, mint)).toBe(plan.creatorBuy.tokensOut);
  });

  it("rejects a launch whose creator buy is below the minimum, and leaves nothing behind", async () => {
    const { client, rpc } = chain;
    const creator = await newWallet(chain, { btc: 10_000_000n });
    const args = {
      ...coinText("TooSmall"),
      salt: salt(),
      // Enough for 0.4% of the curve supply; the minimum is 0.5%.
      creatorBuyMaxQuote: budgetFor(40),
      creatorBuyMinTokens: 0n,
    };
    const failure = await expectFailure(
      chain,
      [setComputeUnitLimit(LAUNCH_COMPUTE_UNITS), client.instructions.createCoin(creator.address, chain.btc, args)],
      [creator],
    );
    expect(failure.programError?.name).toBe("CreatorBuyTooSmall");

    // The whole transaction was undone: no mint, no curve, no tokens.
    const mint = client.addresses.mint(creator.address, args.salt);
    expect(await rpc.getAccount(mint)).toBeNull();
    expect(await rpc.getAccount(client.addresses.curve(mint))).toBeNull();
    expect(await client.getTokenBalance(creator.address, chain.btc)).toBe(10_000_000n);
  });

  it("holds the creator to the same wallet cap as everyone else", async () => {
    const { client } = chain;
    const launch = config.active.launch;
    const creator = await newWallet(chain, { btc: 10_000_000n });

    // 2.5% in the launch transaction is over the 2% cap.
    const failure = await expectFailure(
      chain,
      [
        setComputeUnitLimit(LAUNCH_COMPUTE_UNITS),
        client.instructions.createCoin(creator.address, chain.btc, {
          ...coinText("OverCap"),
          salt: salt(),
          creatorBuyMaxQuote: budgetFor(launch.earlyWalletCapBps + 50),
          creatorBuyMinTokens: 0n,
        }),
      ],
      [creator],
    );
    expect(failure.programError?.name).toBe("WalletCapExceeded");

    // Exactly the cap is allowed...
    const plan = await client.planLaunch(creator.address, chain.btc, {
      ...coinText("AtCap"),
      creatorBuyBps: launch.earlyWalletCapBps,
    });
    await client.sendAndConfirm(plan.instructions, [creator]);
    const cap = bpsFloor(launch.curveSupply, launch.earlyWalletCapBps);
    const bought = await client.getTokenBalance(creator.address, plan.mint);
    expect(bought).toBeLessThanOrEqual(cap);
    expect(bought).toBeGreaterThan((cap * 999n) / 1000n);

    // ...and then the creator cannot add to it while the window is open.
    const curve = (await client.getCurve(plan.mint))!;
    const more = client.planCurveBuy(creator.address, curve, budgetFor(50), 10_000);
    const second = await expectFailure(chain, more.instructions, [creator]);
    expect(second.programError?.name).toBe("WalletCapExceeded");
  });

  it("refuses an asset that is not a configured quote asset", async () => {
    const { client } = chain;
    const stranger = keypairSigner(randomBytes(32));
    await ensureMint(client, chain.authority, stranger, 6);
    const creator = await newWallet(chain);
    await mintTestTokens(client, chain.authority, stranger.address, creator.address, 1_000_000_000n);

    const failure = await expectFailure(
      chain,
      [
        setComputeUnitLimit(LAUNCH_COMPUTE_UNITS),
        client.instructions.createCoin(creator.address, stranger.address, {
          ...coinText("Stranger"),
          salt: salt(),
          creatorBuyMaxQuote: 1_000_000n,
          creatorBuyMinTokens: 0n,
        }),
      ],
      [creator],
    );
    expect(failure.programError?.name).toBe("UnknownQuoteAsset");
  });

  it("refuses a missing name or an over-long ticker", async () => {
    const { client } = chain;
    const creator = await newWallet(chain, { btc: 10_000_000n });
    const attempt = (override: Partial<ReturnType<typeof coinText>>): Instruction[] => [
      setComputeUnitLimit(LAUNCH_COMPUTE_UNITS),
      client.instructions.createCoin(creator.address, chain.btc, {
        ...coinText("BadText"),
        ...override,
        salt: salt(),
        creatorBuyMaxQuote: budgetFor(50),
        creatorBuyMinTokens: 0n,
      }),
    ];
    expect((await expectFailure(chain, attempt({ name: "" }), [creator])).programError?.name).toBe("InvalidMetadata");
    expect((await expectFailure(chain, attempt({ symbol: "ELEVENCHARS" }), [creator])).programError?.name).toBe(
      "InvalidMetadata",
    );
    // The client catches the same mistakes before anything is signed.
    await expect(
      client.planLaunch(creator.address, chain.btc, { ...coinText("BadText"), name: "", creatorBuyBps: 50 }),
    ).rejects.toThrow(/name is required/);
  });

  it("gives every launch its own mint, and never reuses one", async () => {
    const { client } = chain;
    const creator = await newWallet(chain, { btc: 10_000_000n });
    const fixed = salt();
    const first = await client.planLaunch(creator.address, chain.btc, {
      ...coinText("First"),
      creatorBuyBps: 50,
      salt: fixed,
    });
    await client.sendAndConfirm(first.instructions, [creator]);

    // Same creator, same salt: the mint address is taken.
    const again = await client.planLaunch(creator.address, chain.btc, {
      ...coinText("Again"),
      creatorBuyBps: 50,
      salt: fixed,
    });
    expect(again.mint).toBe(first.mint);
    await expectFailure(chain, again.instructions, [creator]);
    expect((await client.getCoin(first.mint))?.metadata?.name).toMatch(/^First/);

    // A different salt is a different coin.
    const second = await client.planLaunch(creator.address, chain.btc, { ...coinText("Second"), creatorBuyBps: 50 });
    expect(second.mint).not.toBe(first.mint);
    await client.sendAndConfirm(second.instructions, [creator]);
  });

  it("cannot be blocked by someone sending lamports to its addresses first", async () => {
    const { client, rpc } = chain;
    const creator = await newWallet(chain, { btc: 10_000_000n });
    const plan = await client.planLaunch(creator.address, chain.btc, { ...coinText("Prefund"), creatorBuyBps: 50 });
    const a = client.addresses;

    // A griefer who learns the coin's addresses funds every account the
    // launch is about to create.
    const targets = [
      plan.mint,
      a.curve(plan.mint),
      a.tokenVault(plan.mint),
      a.quoteVault(plan.mint),
      a.position(plan.mint, creator.address),
      a.creatorVault(plan.mint),
      metadataAddress(plan.mint),
      associatedTokenAddress(creator.address, plan.mint),
    ];
    const griefer = await newWallet(chain, { lamports: 5_000_000n });
    await client.sendAndConfirm(
      targets.map((target) => systemTransfer(griefer.address, target, 1_000n)),
      [griefer],
    );
    for (const target of targets) expect(await lamportsOf(rpc, target)).toBe(1_000n);

    await client.sendAndConfirm(plan.instructions, [creator]);
    expect((await client.getCurve(plan.mint))?.status).toBe(CurveStatus.Trading);
    expect(await client.getTokenBalance(creator.address, plan.mint)).toBe(plan.creatorBuy.tokensOut);
  });

  it("prices the creator's buy exactly as the client predicted", async () => {
    const launch = config.active.launch;
    const quote = configuredQuotes(config.active).find((entry) => entry.mint === chain.btc)!;
    const { plan, processed } = await launchCoin(chain, { creatorBuyBps: 120, label: "Exact" });
    const expected = quoteBuy(
      initialReserves(launchCurveParams(launch, quote)),
      { platformBps: launch.platformFeeBps, creatorBps: launch.creatorFeeBps },
      plan.creatorBuy.quoteCharged,
    );
    const trade = eventsOf(processed).find((event) => event.type === "Trade");
    expect(trade).toMatchObject({
      isBuy: true,
      quoteAmount: expected.quoteToCurve,
      tokenAmount: expected.tokensOut,
      platformFee: expected.fees.platform,
      creatorFee: expected.fees.creator,
    });
  });
});
