"use client";

/**
 * The admin dashboard: how the launchpad is configured, what it has done, and
 * the proposals that change it. Anyone can read it. Only the admin keys can
 * propose or approve, and the chain is what enforces that, not this page.
 */
import { useState } from "react";
import {
  type AdminAction,
  type GlobalConfig,
  type Proposal,
  approvers,
  associatedTokenAddress,
  configuredQuotes,
  createAssociatedTokenAccountIdempotent,
  proposalState,
} from "@archpad/sdk";
import { api } from "@/lib/api.ts";
import { useApp } from "@/lib/app.tsx";
import { formatBps, formatDuration, formatQuote, shortAddress } from "@/lib/format.ts";
import { useLoaded } from "@/lib/hooks.ts";
import { Address, Notice, Skeleton, Stat } from "./ui.tsx";

function describeAction(action: AdminAction, symbolOf: (mint: string) => string): string {
  switch (action.type) {
    case "SetConfig":
      return "Replace the config";
    case "SetLaunchesPaused":
      return action.paused ? "Pause new launches" : "Resume new launches";
    case "SetQuotePaused":
      return `${action.paused ? "Pause" : "Resume"} launches priced in ${symbolOf(action.mint)}`;
  }
}

const when = (unixSeconds: bigint) => new Date(Number(unixSeconds) * 1000).toLocaleString();

/** What a proposed config would change, compared with the one in force. */
function configChanges(current: GlobalConfig["active"], next: GlobalConfig["active"]): string[] {
  const changes: string[] = [];
  const note = (label: string, before: unknown, after: unknown) => {
    if (String(before) !== String(after)) changes.push(`${label}: ${before} → ${after}`);
  };
  note("Admin keys", current.admins.members.map((key) => shortAddress(key)).join(", "), next.admins.members.map((key) => shortAddress(key)).join(", "));
  note("Approvals needed", current.admins.threshold, next.admins.threshold);
  note("Treasury", shortAddress(current.treasury), shortAddress(next.treasury));
  note("Delay on config changes", formatDuration(current.timelockSecs), formatDuration(next.timelockSecs));
  note("Platform fee", formatBps(current.launch.platformFeeBps), formatBps(next.launch.platformFeeBps));
  note("Creator fee", formatBps(current.launch.creatorFeeBps), formatBps(next.launch.creatorFeeBps));
  note("Creator's minimum buy", formatBps(current.launch.minCreatorBuyBps), formatBps(next.launch.minCreatorBuyBps));
  note("Launch-window wallet cap", formatBps(current.launch.earlyWalletCapBps), formatBps(next.launch.earlyWalletCapBps));
  note("Launch window", formatDuration(current.launch.earlyWindowSecs), formatDuration(next.launch.earlyWindowSecs));
  note("Total supply", current.launch.totalSupply, next.launch.totalSupply);
  note("Curve supply", current.launch.curveSupply, next.launch.curveSupply);
  note("Starting virtual tokens", current.launch.virtualTokenReserves, next.launch.virtualTokenReserves);
  note(
    "Pool fee",
    formatBps(current.launch.poolLpFeeBps + current.launch.poolPlatformFeeBps + current.launch.poolCreatorFeeBps),
    formatBps(next.launch.poolLpFeeBps + next.launch.poolPlatformFeeBps + next.launch.poolCreatorFeeBps),
  );
  const quotes = (config: GlobalConfig["active"]) =>
    configuredQuotes(config)
      .map((quote) => `${shortAddress(quote.mint)} @ ${quote.virtualQuoteReserves}`)
      .join(", ");
  note("Quote assets", quotes(current), quotes(next));
  return changes.length > 0 ? changes : ["No difference from the current config."];
}

export function Admin() {
  const { network, client, wallet, send, quoteOf } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const stats = useLoaded("stats", () => api.stats(), 30_000);
  const governance = useLoaded(
    client ? "governance" : null,
    async () => {
      const [config, proposals, now] = await Promise.all([client!.getConfig(), client!.getProposals(), client!.rpc.getChainTime()]);
      const waiting = new Map<string, bigint>();
      if (config) {
        for (const quote of configuredQuotes(config.active)) {
          waiting.set(quote.mint, await client!.getUnwithdrawnPlatformFees(quote.mint));
        }
      }
      return { config, proposals, now, waiting };
    },
    10_000,
  );

  if (!network) return <Skeleton className="h-96" />;
  if (!network.initialised) return <Notice>The launchpad is not set up on this network yet.</Notice>;
  if (governance.error && !governance.data) return <Notice tone="error">Could not read the config: {governance.error}</Notice>;
  if (!governance.data?.config) return <Skeleton className="h-96" />;

  const { config, proposals, now, waiting } = governance.data;
  const { admins, launch, treasury, timelockSecs } = config.active;
  const isAdmin = wallet !== null && admins.members.includes(wallet.address);
  const symbolOf = (mint: string) => quoteOf(mint)?.symbol ?? shortAddress(mint);

  const run = async (key: string, work: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await work();
      governance.reload();
    } finally {
      setBusy(null);
    }
  };

  const propose = (action: AdminAction) =>
    run(`propose:${JSON.stringify(action, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`, async () => {
      if (!client || !wallet) return;
      const plan = await client.planProposal(wallet.address, action);
      const what = describeAction(action, symbolOf).toLowerCase();
      await send(plan.instructions, {
        doing: `Proposing to ${what}.`,
        done: plan.executes ? `Done: ${what}.` : `Proposal #${plan.id} is open for the other admins to approve.`,
      });
    });

  const withdraw = (mint: string) =>
    run(`withdraw:${mint}`, async () => {
      if (!client || !wallet) return;
      await send(
        [
          createAssociatedTokenAccountIdempotent(wallet.address, treasury, mint),
          client.instructions.withdrawPlatformFees(mint, associatedTokenAddress(treasury, mint)),
        ],
        { doing: `Sending ${symbolOf(mint)} platform fees to the treasury.`, done: "Platform fees sent to the treasury." },
      );
    });

  const open = proposals.filter((proposal) => {
    const status = proposalState(proposal, config, now).status;
    return status !== "executed" && status !== "stale";
  });
  const closed = proposals.filter((proposal) => !open.includes(proposal)).slice(0, 10);

  const renderProposal = (proposal: Proposal) => {
    const state = proposalState(proposal, config, now);
    const approvedBy = proposal.epoch === config.epoch ? approvers(proposal, admins) : [];
    const approvedByMe = wallet !== null && approvedBy.includes(wallet.address);
    const id = proposal.id;
    return (
      <li key={id.toString()} className="space-y-2 px-4 py-3 text-sm">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="font-medium">
            #{id.toString()} {describeAction(proposal.action, symbolOf)}
          </span>
          <span className="text-xs text-dim">
            {state.status === "executed" && `Executed ${when(state.at)}`}
            {state.status === "stale" && "Retired: the config was replaced after it was made"}
            {state.status === "needs-approvals" && `${state.have} of ${state.need} approvals`}
            {state.status === "waiting" && `Approved. Can be executed from ${when(state.readyAt)}`}
            {state.status === "ready" && "Approved and ready to execute"}
          </span>
        </div>
        <div className="text-xs text-dim">
          Proposed by {shortAddress(proposal.proposer)} on {when(proposal.createdAt)}
          {approvedBy.length > 0 && <> · approved by {approvedBy.map((key) => shortAddress(key)).join(", ")}</>}
        </div>
        {proposal.action.type === "SetConfig" && state.status !== "executed" && state.status !== "stale" && (
          <ul className="list-inside list-disc text-xs text-dim">
            {configChanges(config.active, proposal.action.config).map((change) => (
              <li key={change}>{change}</li>
            ))}
          </ul>
        )}
        {(state.status === "needs-approvals" || state.status === "waiting" || state.status === "ready") && (
          <div className="flex flex-wrap gap-2">
            {isAdmin && !approvedByMe && (
              <button
                className="button-primary px-3 py-1.5 text-xs"
                disabled={busy !== null}
                onClick={() =>
                  run(`approve:${id}`, () =>
                    send([client!.instructions.approve(wallet!.address, id)], {
                      doing: `Approving proposal #${id}.`,
                      done: `You approved proposal #${id}.`,
                    }),
                  )
                }
              >
                Approve
              </button>
            )}
            {isAdmin && approvedByMe && (
              <button
                className="button-quiet px-3 py-1.5 text-xs"
                disabled={busy !== null}
                onClick={() =>
                  run(`revoke:${id}`, () =>
                    send([client!.instructions.revoke(wallet!.address, id)], {
                      doing: `Withdrawing your approval of proposal #${id}.`,
                      done: `Your approval of proposal #${id} is withdrawn.`,
                    }),
                  )
                }
              >
                Withdraw my approval
              </button>
            )}
            {state.status === "ready" && wallet && (
              <button
                className="button-primary px-3 py-1.5 text-xs"
                disabled={busy !== null}
                onClick={() =>
                  run(`execute:${id}`, () =>
                    send([client!.instructions.execute(id)], {
                      doing: `Executing proposal #${id}.`,
                      done: `Proposal #${id} is in effect.`,
                    }),
                  )
                }
              >
                Execute
              </button>
            )}
          </div>
        )}
      </li>
    );
  };

  return (
    <div className="space-y-6">
      <section className="panel p-4">
        <h1 className="text-lg font-bold">Admin</h1>
        <p className="mt-1 text-sm text-dim">
          {admins.threshold} of {admins.members.length} admin key{admins.members.length === 1 ? "" : "s"} must approve any
          change. A change to the config then waits {formatDuration(timelockSecs)} before it can take effect; pausing new
          launches does not wait. Admins cannot move anyone's funds, and nothing they change affects a coin that already
          exists.
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <div className="label">Admin keys</div>
            <ul className="space-y-1 font-mono text-xs">
              {admins.members.map((member) => (
                <li key={member} className={wallet?.address === member ? "text-accent" : ""}>
                  {member}
                  {wallet?.address === member && " (you)"}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="label">Treasury (receives platform fees)</div>
            <div className="font-mono text-xs break-all">{treasury}</div>
          </div>
        </div>
      </section>

      <section className="panel p-4">
        <h2 className="text-sm font-semibold">Terms for new coins</h2>
        <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Curve fee">
            {formatBps(launch.platformFeeBps + launch.creatorFeeBps)} ({formatBps(launch.platformFeeBps)} platform, {formatBps(launch.creatorFeeBps)} creator)
          </Stat>
          <Stat label="Pool fee">{formatBps(launch.poolLpFeeBps + launch.poolPlatformFeeBps + launch.poolCreatorFeeBps)}</Stat>
          <Stat label="Creator's minimum buy">{formatBps(launch.minCreatorBuyBps)}</Stat>
          <Stat label="Wallet cap at launch">
            {formatBps(launch.earlyWalletCapBps)} for {formatDuration(launch.earlyWindowSecs)}
          </Stat>
        </div>
        <p className="mt-3 text-xs text-dim">
          To change these, edit <code>deploy/launch-config.json</code> and run <code>pnpm ops propose-config</code>. The
          proposal then appears below for the other admins to approve.
        </p>
      </section>

      <section className="panel overflow-hidden">
        <h2 className="border-b border-line px-4 py-3 text-sm font-semibold">By quote asset</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-dim">
              <tr>
                <th className="px-4 py-2 font-medium">Asset</th>
                <th className="px-4 py-2 text-right font-medium">Coins</th>
                <th className="px-4 py-2 text-right font-medium">Graduated</th>
                <th className="px-4 py-2 text-right font-medium">Trades</th>
                <th className="px-4 py-2 text-right font-medium">Volume</th>
                <th className="px-4 py-2 text-right font-medium">Platform fees</th>
                <th className="px-4 py-2 text-right font-medium">Creator fees</th>
                <th className="px-4 py-2 text-right font-medium">Waiting in vault</th>
                <th className="px-4 py-2 font-medium">New launches</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {configuredQuotes(config.active).map((slot) => {
                const quote = quoteOf(slot.mint);
                const totals = stats.data?.byQuote.find((entry) => entry.quoteMint === slot.mint);
                const paused = (config.pausedQuotes & (1 << slot.index)) !== 0;
                const inVault = waiting.get(slot.mint) ?? 0n;
                const money = (amount: string | bigint | undefined) =>
                  amount === undefined ? "–" : quote ? formatQuote(amount, quote, { compact: true }) : amount.toString();
                return (
                  <tr key={slot.mint}>
                    <td className="px-4 py-2 font-medium">
                      {quote?.symbol ?? <Address value={slot.mint} />}
                    </td>
                    <td className="tabular px-4 py-2 text-right">{totals?.coins ?? 0}</td>
                    <td className="tabular px-4 py-2 text-right">{totals?.graduated ?? 0}</td>
                    <td className="tabular px-4 py-2 text-right">{totals?.trades ?? 0}</td>
                    <td className="tabular px-4 py-2 text-right">{money(totals?.volumeQuote ?? "0")}</td>
                    <td className="tabular px-4 py-2 text-right">{money(totals?.platformFees ?? "0")}</td>
                    <td className="tabular px-4 py-2 text-right">{money(totals?.creatorFees ?? "0")}</td>
                    <td className="tabular px-4 py-2 text-right">
                      {money(inVault)}
                      {inVault > 0n && wallet && (
                        <button
                          className="ml-2 text-xs text-accent hover:underline disabled:opacity-50"
                          disabled={busy !== null}
                          title="Anyone can do this. The money can only go to the treasury."
                          onClick={() => withdraw(slot.mint)}
                        >
                          Send to treasury
                        </button>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      <span className={paused ? "text-accent" : "text-up"}>{paused ? "Paused" : "Open"}</span>
                      {isAdmin && (
                        <button
                          className="ml-2 text-xs text-dim hover:text-accent disabled:opacity-50"
                          disabled={busy !== null}
                          onClick={() => propose({ type: "SetQuotePaused", mint: slot.mint, paused: !paused })}
                        >
                          Propose {paused ? "resuming" : "pausing"}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {stats.data && (
          <p className="border-t border-line px-4 py-2 text-xs text-dim">
            {stats.data.coins} coins launched, {stats.data.graduated} graduated, {stats.data.trades} trades by{" "}
            {stats.data.traders} wallets. Amounts in different assets are not added together.
          </p>
        )}
      </section>

      <section className="panel overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold">
            New launches are {config.launchesPaused ? <span className="text-accent">paused</span> : <span className="text-up">open</span>}
          </h2>
          {isAdmin && (
            <button
              className="button-quiet px-3 py-1.5 text-xs"
              disabled={busy !== null}
              onClick={() => propose({ type: "SetLaunchesPaused", paused: !config.launchesPaused })}
            >
              Propose {config.launchesPaused ? "resuming" : "pausing"} launches
            </button>
          )}
        </div>
        <h3 className="px-4 pt-3 text-xs font-medium tracking-wide text-dim uppercase">Open proposals</h3>
        {open.length === 0 ? (
          <p className="px-4 py-4 text-sm text-dim">Nothing is waiting for approval.</p>
        ) : (
          <ul className="divide-y divide-line">{open.map(renderProposal)}</ul>
        )}
        {closed.length > 0 && (
          <>
            <h3 className="border-t border-line px-4 pt-3 text-xs font-medium tracking-wide text-dim uppercase">Recent history</h3>
            <ul className="divide-y divide-line">{closed.map(renderProposal)}</ul>
          </>
        )}
      </section>
    </div>
  );
}
