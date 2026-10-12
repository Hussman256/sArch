/**
 * Governing the config (PRD module: admin, AD-1; fees FE-3; curve BC-6).
 *
 * The local chain starts with one admin key that can act alone and no
 * timelock. These tests turn that into a two-of-three multisig with a short
 * timelock, exercise it, and put the original config back at the end so the
 * chain is left as the other tests expect.
 */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type AdminAction,
  type ConfigData,
  type GlobalConfig,
  type Signer,
  ByteWriter,
  LAUNCH_COMPUTE_UNITS,
  approvers,
  bytesToHex,
  keypairSigner,
  proposalState,
  setComputeUnitLimit,
  systemTransfer,
  writeConfigData,
} from "@archpad/sdk";
import { desiredConfig, lamportsOf, resolveTarget } from "@archpad/ops";
import {
  type Chain,
  coinText,
  connect,
  expectFailure,
  launchCoin,
  newWallet,
  waitUntil,
} from "../src/harness.ts";

/** Seconds a config change waits in these tests. Long enough to observe, short enough to sit through. */
const TIMELOCK = 4;

let chain: Chain;
let original: ConfigData;
let bob: Signer;
let carol: Signer;

/**
 * The two extra admins have fixed keys, so that if a run dies half way a
 * later run can still sign the chain back to its starting config.
 */
const fixedKey = (label: string) =>
  keypairSigner(createHash("sha256").update(`archpad e2e admin: ${label}`).digest());

const getConfig = async (): Promise<GlobalConfig> => (await chain.client.getConfig())!;

async function fund(signer: Signer): Promise<void> {
  if ((await lamportsOf(chain.rpc, signer.address)) >= 500_000n) return;
  await chain.client.sendAndConfirm([systemTransfer(chain.authority.address, signer.address, 2_000_000n)], [
    chain.authority,
  ]);
}

/** Proposes `action` as the first signer and has the rest approve it. Returns its number. */
async function proposeAndApprove(action: AdminAction, signers: Signer[]): Promise<bigint> {
  const { client } = chain;
  const [proposer, ...others] = signers as [Signer, ...Signer[]];
  const id = (await getConfig()).proposalCount;
  await client.sendAndConfirm([client.instructions.propose(proposer.address, id, action)], [proposer]);
  for (const other of others) {
    await client.sendAndConfirm([client.instructions.approve(other.address, id)], [other]);
  }
  return id;
}

/** Runs an action through the multisig: proposed, approved, waited out if need be, executed. */
async function enact(action: AdminAction, signers: Signer[]): Promise<bigint> {
  const { client, rpc } = chain;
  const id = await proposeAndApprove(action, signers);
  const state = proposalState((await client.getProposal(id))!, await getConfig(), await rpc.getChainTime());
  if (state.status === "waiting") await waitUntil(chain, state.readyAt);
  await client.sendAndConfirm([client.instructions.execute(id)], [signers[0]!]);
  return id;
}

/** A config as the bytes the chain stores, for comparing two of them. */
function encoded(config: ConfigData): string {
  const writer = new ByteWriter();
  writeConfigData(writer, config);
  return bytesToHex(writer.finish());
}

/** Puts the chain's config back to the one the deploy files describe. */
async function restoreOriginal(): Promise<void> {
  const config = await getConfig();
  if (encoded(config.active) !== encoded(original)) {
    const admins = config.active.admins.members;
    const signers = [chain.authority, bob, carol].filter((signer) => admins.includes(signer.address));
    await enact({ type: "SetConfig", config: original }, signers.slice(0, config.active.admins.threshold));
  }
  const after = await getConfig();
  if (after.launchesPaused) await enact({ type: "SetLaunchesPaused", paused: false }, [chain.authority]);
  for (const [index, quote] of after.active.quotes.entries()) {
    if ((after.pausedQuotes & (1 << index)) !== 0) {
      await enact({ type: "SetQuotePaused", mint: quote.mint, paused: false }, [chain.authority]);
    }
  }
}

beforeAll(async () => {
  chain = await connect();
  bob = fixedKey("bob");
  carol = fixedKey("carol");
  await fund(bob);
  await fund(carol);

  // The starting config is the one the deploy files describe: the authority
  // alone, no timelock. If an earlier run was cut short and left the chain
  // some other way, sign our way back to it before starting.
  original = await desiredConfig(resolveTarget({}), {}, () => undefined);
  expect(original.admins).toEqual({ members: [chain.authority.address], threshold: 1 });
  expect(original.timelockSecs).toBe(0);
  await restoreOriginal();
});

afterAll(async () => {
  await restoreOriginal();
  const config = await getConfig();
  expect(config.active.admins).toEqual({ members: [chain.authority.address], threshold: 1 });
  expect(config.launchesPaused).toBe(false);
});

describe("governing the config", () => {
  it("hands control from one key to a two-of-three multisig", async () => {
    const multisig: ConfigData = {
      ...original,
      admins: { members: [chain.authority.address, bob.address, carol.address], threshold: 2 },
      timelockSecs: TIMELOCK,
    };
    const before = await getConfig();
    // One key, no timelock: the plan proposes and executes in one transaction.
    const plan = await chain.client.planProposal(chain.authority.address, { type: "SetConfig", config: multisig });
    expect(plan.executes).toBe(true);
    await chain.client.sendAndConfirm(plan.instructions, [chain.authority]);

    const after = await getConfig();
    expect(after.active.admins).toEqual(multisig.admins);
    expect(after.active.timelockSecs).toBe(TIMELOCK);
    expect(after.epoch).toBe(before.epoch + 1);
    // From here the same call no longer executes anything on its own.
    const next = await chain.client.planProposal(chain.authority.address, { type: "SetLaunchesPaused", paused: true });
    expect(next.executes).toBe(false);
  });

  it("does nothing on one admin's say-so, and lets nobody else propose at all", async () => {
    const { client } = chain;
    const stranger = await newWallet(chain);
    const pause: AdminAction = { type: "SetLaunchesPaused", paused: true };
    const next = (await getConfig()).proposalCount;

    const refused = await expectFailure(chain, [client.instructions.propose(stranger.address, next, pause)], [stranger]);
    expect(refused.programError?.name).toBe("NotAnAdmin");
    expect(await chain.rpc.getAccount(client.addresses.proposal(next))).toBeNull();

    // Bob proposes. His approval is recorded, and is not enough.
    const id = await proposeAndApprove(pause, [bob]);
    expect(id).toBe(next);
    const proposal = (await client.getProposal(id))!;
    const config = await getConfig();
    expect(proposal).toMatchObject({ id, proposer: bob.address, epoch: config.epoch, approvedAt: 0n, executedAt: 0n });
    expect(approvers(proposal, config.active.admins)).toEqual([bob.address]);
    expect(proposalState(proposal, config, await chain.rpc.getChainTime())).toEqual({
      status: "needs-approvals",
      have: 1,
      need: 2,
    });

    const early = await expectFailure(chain, [client.instructions.execute(id)], [bob]);
    expect(early.programError?.name).toBe("NotEnoughApprovals");
    const twice = await expectFailure(chain, [client.instructions.approve(bob.address, id)], [bob]);
    expect(twice.programError?.name).toBe("AlreadyApproved");
    const outsider = await expectFailure(chain, [client.instructions.approve(stranger.address, id)], [stranger]);
    expect(outsider.programError?.name).toBe("NotAnAdmin");
    expect((await getConfig()).launchesPaused).toBe(false);
  });

  it("pauses new launches once two admins agree, without touching coins that exist", async () => {
    const { client } = chain;
    const existing = await launchCoin(chain, { label: "Existing" });
    const curve = (await client.getCurve(existing.mint))!;
    await waitUntil(chain, curve.earlyWindowEnd);

    // AD-1: Carol proposes, the authority approves, and a passer-by executes.
    const id = await proposeAndApprove({ type: "SetLaunchesPaused", paused: true }, [carol, chain.authority]);
    const passerBy = await newWallet(chain);
    await client.sendAndConfirm([client.instructions.execute(id)], [passerBy]);
    expect((await getConfig()).launchesPaused).toBe(true);

    // New launches are refused, on chain and in the client.
    const creator = await newWallet(chain, { btc: 10_000_000n });
    await expect(
      client.planLaunch(creator.address, chain.btc, { ...coinText("Paused"), creatorBuyBps: 50 }),
    ).rejects.toThrow(/paused/);
    const blocked = await expectFailure(
      chain,
      [
        setComputeUnitLimit(LAUNCH_COMPUTE_UNITS),
        client.instructions.createCoin(creator.address, chain.btc, {
          ...coinText("Paused"),
          salt: 1n,
          creatorBuyMaxQuote: 1_000_000n,
          creatorBuyMinTokens: 0n,
        }),
      ],
      [creator],
    );
    expect(blocked.programError?.name).toBe("LaunchesPaused");

    // The coin that already exists trades exactly as before, in both directions.
    const trader = await newWallet(chain, { btc: 10_000_000n });
    const buy = client.planCurveBuy(trader.address, (await client.getCurve(existing.mint))!, 500_000n, 100);
    await client.sendAndConfirm(buy.instructions, [trader]);
    const sell = client.planCurveSell(trader.address, (await client.getCurve(existing.mint))!, buy.quote.tokensOut, 100);
    await client.sendAndConfirm(sell.instructions, [trader]);
    await client.sendAndConfirm(client.planClaimCreatorFees(existing.creator.address, curve), [existing.creator]);

    // An executed proposal is finished: it cannot run again or change its votes.
    const again = await expectFailure(chain, [client.instructions.execute(id)], [passerBy]);
    expect(again.programError?.name).toBe("ProposalExecuted");
    const late = await expectFailure(chain, [client.instructions.revoke(carol.address, id)], [carol]);
    expect(late.programError?.name).toBe("ProposalExecuted");

    // Resuming takes the same two approvals.
    await enact({ type: "SetLaunchesPaused", paused: false }, [chain.authority, bob]);
    expect((await getConfig()).launchesPaused).toBe(false);
    await launchCoin(chain, { label: "Resumed" });
  });

  it("can pause one quote asset and leave the other open", async () => {
    const { client } = chain;
    await enact({ type: "SetQuotePaused", mint: chain.usd, paused: true }, [bob, carol]);

    const creator = await newWallet(chain, { usd: 100_000_000_000n, btc: 10_000_000n });
    const blocked = await expectFailure(
      chain,
      [
        setComputeUnitLimit(LAUNCH_COMPUTE_UNITS),
        client.instructions.createCoin(creator.address, chain.usd, {
          ...coinText("UsdPaused"),
          salt: 2n,
          creatorBuyMaxQuote: 100_000_000n,
          creatorBuyMinTokens: 0n,
        }),
      ],
      [creator],
    );
    expect(blocked.programError?.name).toBe("QuoteAssetPaused");
    await launchCoin(chain, { quote: chain.btc, creator, label: "BtcOpen" });

    await enact({ type: "SetQuotePaused", mint: chain.usd, paused: false }, [carol, chain.authority]);
    await launchCoin(chain, { quote: chain.usd, creator, label: "UsdOpen" });

    // An asset that is not configured cannot be paused, or even proposed.
    const unknown = await expectFailure(
      chain,
      [
        client.instructions.propose(bob.address, (await getConfig()).proposalCount, {
          type: "SetQuotePaused",
          mint: creator.address,
          paused: true,
        }),
      ],
      [bob],
    );
    expect(unknown.programError?.name).toBe("UnknownQuoteAsset");
  });

  it("applies a new fee split only after the timelock, and only to coins launched afterwards", async () => {
    const { client, rpc } = chain;
    const before = await getConfig();
    const old = await launchCoin(chain, { label: "OldFees" });

    // FE-3 / BC-6: the split lives in the config. Move it from 100/125 to 150/75.
    expect(before.active.launch).toMatchObject({ platformFeeBps: 100, creatorFeeBps: 125 });
    const next: ConfigData = {
      ...before.active,
      launch: { ...before.active.launch, platformFeeBps: 150, creatorFeeBps: 75 },
    };
    const id = await proposeAndApprove({ type: "SetConfig", config: next }, [chain.authority, bob]);

    // Approved, but the timelock has only just started.
    const proposal = (await client.getProposal(id))!;
    const state = proposalState(proposal, before, await rpc.getChainTime());
    expect(state.status).toBe("waiting");
    const tooSoon = await expectFailure(chain, [client.instructions.execute(id)], [bob]);
    expect(tooSoon.programError?.name).toBe("TimelockNotElapsed");
    expect((await getConfig()).active.launch.platformFeeBps).toBe(before.active.launch.platformFeeBps);

    // A coin launched during the wait still gets the old split.
    const during = await launchCoin(chain, { label: "DuringWait" });
    expect((await client.getCurve(during.mint))!.platformFeeBps).toBe(before.active.launch.platformFeeBps);

    if (state.status === "waiting") await waitUntil(chain, state.readyAt);
    await client.sendAndConfirm([client.instructions.execute(id)], [bob]);
    const after = await getConfig();
    expect(after.active.launch).toMatchObject({ platformFeeBps: 150, creatorFeeBps: 75 });
    expect(after.epoch).toBe(before.epoch + 1);

    // New coins launch with the new split...
    const fresh = await launchCoin(chain, { label: "NewFees" });
    expect(await client.getCurve(fresh.mint)).toMatchObject({ platformFeeBps: 150, creatorFeeBps: 75 });
    expect(fresh.plan.creatorBuy.fees.platform).toBeGreaterThan(fresh.plan.creatorBuy.fees.creator);

    // ...and the coin that existed before keeps the terms it launched with.
    const oldCurve = (await client.getCurve(old.mint))!;
    expect(oldCurve).toMatchObject({
      platformFeeBps: before.active.launch.platformFeeBps,
      creatorFeeBps: before.active.launch.creatorFeeBps,
    });
    await waitUntil(chain, oldCurve.earlyWindowEnd);
    const trader = await newWallet(chain, { btc: 10_000_000n });
    const buy = client.planCurveBuy(trader.address, oldCurve, 1_000_000n, 100);
    await client.sendAndConfirm(buy.instructions, [trader]);
    expect(buy.quote.fees.creator).toBeGreaterThan(buy.quote.fees.platform);
  });

  it("retires every open proposal when the config is replaced", async () => {
    const { client } = chain;
    // A pause that has both approvals it needs, left unexecuted.
    const pause = await proposeAndApprove({ type: "SetLaunchesPaused", paused: true }, [bob, carol]);
    expect(proposalState((await client.getProposal(pause))!, await getConfig(), await chain.rpc.getChainTime())).toEqual({
      status: "ready",
    });

    // The config is replaced: back to the starting fee split.
    const current = await getConfig();
    await enact(
      { type: "SetConfig", config: { ...current.active, launch: { ...original.launch } } },
      [chain.authority, carol],
    );

    // The pause was approved under the old config, so it is dead.
    const stale = await expectFailure(chain, [client.instructions.execute(pause)], [bob]);
    expect(stale.programError?.name).toBe("ProposalStale");
    const vote = await expectFailure(chain, [client.instructions.approve(chain.authority.address, pause)], [
      chain.authority,
    ]);
    expect(vote.programError?.name).toBe("ProposalStale");
    expect((await getConfig()).launchesPaused).toBe(false);
    expect(proposalState((await client.getProposal(pause))!, await getConfig(), 0n)).toEqual({ status: "stale" });
  });

  it("restarts the timelock when an approval is withdrawn and given again", async () => {
    const { client, rpc } = chain;
    const current = await getConfig();
    const change: AdminAction = {
      type: "SetConfig",
      config: { ...current.active, launch: { ...current.active.launch, earlyWindowSecs: 12 } },
    };
    const id = await proposeAndApprove(change, [bob, carol]);
    const first = (await client.getProposal(id))!.approvedAt;
    expect(first).toBeGreaterThan(0n);

    // Carol withdraws: under the threshold, so the clock is cleared.
    await client.sendAndConfirm([client.instructions.revoke(carol.address, id)], [carol]);
    expect((await client.getProposal(id))!.approvedAt).toBe(0n);
    const nothing = await expectFailure(chain, [client.instructions.revoke(carol.address, id)], [carol]);
    expect(nothing.programError?.name).toBe("NotApproved");

    // Sit out what would have been the whole delay, then approve again.
    await waitUntil(chain, first + BigInt(TIMELOCK));
    const short = await expectFailure(chain, [client.instructions.execute(id)], [bob]);
    expect(short.programError?.name).toBe("NotEnoughApprovals");
    await client.sendAndConfirm([client.instructions.approve(chain.authority.address, id)], [chain.authority]);
    const second = (await client.getProposal(id))!.approvedAt;
    expect(second).toBeGreaterThan(first);

    // The delay runs in full from the new approval.
    const tooSoon = await expectFailure(chain, [client.instructions.execute(id)], [bob]);
    expect(tooSoon.programError?.name).toBe("TimelockNotElapsed");
    await waitUntil(chain, second + BigInt(TIMELOCK));
    await client.sendAndConfirm([client.instructions.execute(id)], [bob]);
    expect((await getConfig()).active.launch.earlyWindowSecs).toBe(12);
    expect(await rpc.getChainTime()).toBeGreaterThanOrEqual(second + BigInt(TIMELOCK));
  });

  it("refuses a config that would break launches or leave nobody in charge", async () => {
    const { client } = chain;
    const current = await getConfig();
    const propose = async (config: ConfigData) =>
      expectFailure(
        chain,
        [client.instructions.propose(bob.address, (await getConfig()).proposalCount, { type: "SetConfig", config })],
        [bob],
      );

    const greedy = await propose({
      ...current.active,
      launch: { ...current.active.launch, platformFeeBps: 900, creatorFeeBps: 200 },
    });
    expect(greedy.programError?.name).toBe("InvalidConfig");

    const lockedOut = await propose({
      ...current.active,
      admins: { members: [bob.address, carol.address], threshold: 3 },
    });
    expect(lockedOut.programError?.name).toBe("InvalidConfig");

    const noTreasury = await propose({ ...current.active, treasury: "11111111111111111111111111111111" });
    expect(noTreasury.programError?.name).toBe("InvalidConfig");
  });

  it("keeps a record of every proposal", async () => {
    const proposals = await chain.client.getProposals();
    const config = await getConfig();
    expect(BigInt(proposals.length)).toBe(config.proposalCount);
    // Newest first, numbered without gaps.
    expect(proposals.map((proposal) => proposal.id)).toEqual(
      Array.from({ length: proposals.length }, (_, i) => BigInt(proposals.length - 1 - i)),
    );
  });

  it("cannot be initialised a second time", async () => {
    const { client } = chain;
    const again = await expectFailure(
      chain,
      [client.instructions.initializeConfig(chain.authority.address, original)],
      [chain.authority],
    );
    expect(again.programError?.name).toBe("AlreadyInitialized");
    const stranger = await newWallet(chain);
    const notDeployer = await expectFailure(
      chain,
      [client.instructions.initializeConfig(stranger.address, original)],
      [stranger],
    );
    expect(notDeployer.programError?.name).toBe("Unauthorized");
  });
});
