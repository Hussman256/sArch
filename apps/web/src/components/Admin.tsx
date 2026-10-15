"use client";

/**
 * The admin dashboard: what the launchpad has done, how healthy it is, how it
 * is configured, and the proposals that change it. Anyone can read it. Only
 * the admin keys can propose or approve, and the chain is what enforces that.
 */
import Link from "next/link";
import { useState } from "react";
import {
  type AdminAction,
  type ConfigData,
  type GlobalConfig,
  type Proposal,
  MAX_TOTAL_FEE_BPS,
  approvers,
  associatedTokenAddress,
  configuredQuotes,
  createAssociatedTokenAccountIdempotent,
  curveParamsFromTarget,
  graduationQuote,
  proposalState,
} from "@archpad/sdk";
import { type CoinView, type FeedTrade, type QuoteAsset, api } from "@/lib/api.ts";
import { useApp } from "@/lib/app.tsx";
import { formatBps, formatDuration, formatQuote, formatTokens, int, parseUnits, shortAddress } from "@/lib/format.ts";
import { useLoaded } from "@/lib/hooks.ts";
import { type Money, btcText, toSats, toUsd } from "@/lib/money.ts";
import { Logo } from "./icons.tsx";
import { useWalletPicker } from "./Shell.tsx";
import { Notice, Skeleton } from "./ui.tsx";

const RANGES = [
  { key: "24h", label: "24 hours", seconds: 86_400, buckets: 24, bucket: 3_600 },
  { key: "7d", label: "7 days", seconds: 7 * 86_400, buckets: 7, bucket: 86_400 },
  { key: "30d", label: "30 days", seconds: 30 * 86_400, buckets: 30, bucket: 86_400 },
] as const;
type Range = (typeof RANGES)[number];

const MAX_TRADE_PAGES = 25;
const MAX_COIN_PAGES = 20;

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
function configChanges(current: ConfigData, next: ConfigData, symbolOf: (mint: string) => string): string[] {
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
  note("Minimum creator buy", formatBps(current.launch.minCreatorBuyBps), formatBps(next.launch.minCreatorBuyBps));
  note("Wallet cap in early window", formatBps(current.launch.earlyWalletCapBps), formatBps(next.launch.earlyWalletCapBps));
  note("Early window", formatDuration(current.launch.earlyWindowSecs), formatDuration(next.launch.earlyWindowSecs));
  note("Total supply", current.launch.totalSupply, next.launch.totalSupply);
  note("Curve supply", current.launch.curveSupply, next.launch.curveSupply);
  note("Virtual token reserves", current.launch.virtualTokenReserves, next.launch.virtualTokenReserves);
  note(
    "Pool fee",
    formatBps(current.launch.poolLpFeeBps + current.launch.poolPlatformFeeBps + current.launch.poolCreatorFeeBps),
    formatBps(next.launch.poolLpFeeBps + next.launch.poolPlatformFeeBps + next.launch.poolCreatorFeeBps),
  );
  const quotes = (config: ConfigData) =>
    configuredQuotes(config)
      .map((quote) => `${symbolOf(quote.mint)} @ ${quote.virtualQuoteReserves}`)
      .join(", ");
  note("Quote assets and virtual reserves", quotes(current), quotes(next));
  return changes.length > 0 ? changes : ["No difference from the current config."];
}

/** A total in the display unit of amounts in several assets, skipping ones that cannot be converted. */
function inUnit(amount: bigint, asset: QuoteAsset | undefined, money: Money): number | null {
  if (!asset) return null;
  return money.unit === "usd" ? toUsd(amount, asset, money.price) : toSats(amount, asset, money.price);
}
const unitText = (value: number, money: Money, decimals?: number) =>
  money.unit === "usd" ? `$${value.toLocaleString("en-US", { maximumFractionDigits: value < 100 ? 2 : 0 })}` : btcText(value, decimals ?? (value >= 1e8 ? 2 : 4));
function otherText(value: number, money: Money): string {
  if (!money.price) return "";
  return money.unit === "usd" ? btcText((value / money.price.usd) * 1e8, 4) : `$${Math.round((value / 1e8) * money.price.usd).toLocaleString("en-US")}`;
}

async function loadActivity() {
  const since = Math.floor(Date.now() / 1000) - 30 * 86_400;
  const trades: FeedTrade[] = [];
  let before: string | undefined;
  let tradesPartial = false;
  for (let page = 0; page < MAX_TRADE_PAGES; page++) {
    const batch = await api.feed(200, before);
    trades.push(...batch.filter((trade) => trade.timestamp >= since));
    const last = batch[batch.length - 1];
    if (batch.length < 200 || !last || last.timestamp < since) break;
    before = last.id;
    if (page === MAX_TRADE_PAGES - 1) tradesPartial = true;
  }
  const pageCoins = async (sort: "new" | "graduated", at: (coin: CoinView) => number) => {
    const out: CoinView[] = [];
    for (let page = 0; page < MAX_COIN_PAGES; page++) {
      const batch = await api.coins({ sort, limit: 100, offset: page * 100 });
      out.push(...batch.filter((coin) => at(coin) >= since));
      const last = batch[batch.length - 1];
      if (batch.length < 100 || !last || at(last) < since) break;
    }
    return out;
  };
  const [launched, graduated] = await Promise.all([pageCoins("new", (c) => c.createdAt), pageCoins("graduated", (c) => c.graduatedAt ?? 0)]);
  const oldest = trades[trades.length - 1];
  return { trades, launched, graduated, tradesPartial, tradesFrom: tradesPartial && oldest ? oldest.timestamp : since };
}

export function Admin() {
  const { network, client, wallet, send, quoteOf, money, networkError } = useApp();
  const openPicker = useWalletPicker();
  const [range, setRange] = useState<Range>(RANGES[0]);
  const [busy, setBusy] = useState<string | null>(null);
  const [edit, setEdit] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [draftError, setDraftError] = useState<string | null>(null);

  const stats = useLoaded("stats", () => api.stats(), 30_000);
  const activity = useLoaded("admin:activity", loadActivity, 60_000);
  const governance = useLoaded(
    client ? "governance" : null,
    async () => {
      const started = performance.now();
      const now = await client!.rpc.getChainTime();
      const rpcMs = Math.round(performance.now() - started);
      const [config, proposals] = await Promise.all([client!.getConfig(), client!.getProposals()]);
      const waiting = new Map<string, bigint>();
      if (config) {
        for (const quote of configuredQuotes(config.active)) {
          waiting.set(quote.mint, await client!.getUnwithdrawnPlatformFees(quote.mint));
        }
      }
      return { config, proposals, now, waiting, rpcMs };
    },
    10_000,
  );

  const header = (config: GlobalConfig | null) => {
    const admins = config?.active.admins;
    const index = admins && wallet ? admins.members.indexOf(wallet.address) : -1;
    return (
      <header className="flex h-14 items-center gap-3.5 border-b border-line bg-bar px-5 whitespace-nowrap">
        <Logo size={20} />
        <span className="text-[15px] font-medium tracking-[0.16em]">SARCH</span>
        <span className="rounded-[6px] border border-[rgba(245,241,232,0.2)] px-2 py-[3px] text-[12px] font-medium text-soft">Admin</span>
        {network && (
          <span className="flex items-center gap-1.5 rounded-[6px] bg-[rgba(247,147,26,0.14)] px-2 py-[3px] text-[12px] font-medium text-amber capitalize">
            <span className="h-1.5 w-1.5 rounded-full bg-orange" />
            {network.network}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2.5">
          {admins && (
            <button
              onClick={wallet ? undefined : openPicker}
              className="flex h-8 items-center gap-2 rounded-[8px] border border-[rgba(245,241,232,0.1)] bg-deep pr-2.5 pl-1.5 text-[12.5px] text-soft"
            >
              <span className="h-5 w-5 rounded-full bg-[linear-gradient(135deg,#9be7ff,#1d5a6b)]" />
              {!wallet ? "Connect an admin wallet" : index >= 0 ? `Signer ${index + 1} of ${admins.members.length}` : "Not an admin key"}
              <span className="h-3.5 w-px bg-[rgba(245,241,232,0.16)]" />
              <span className="text-faint">
                {admins.threshold} {admins.threshold === 1 ? "signature" : "signatures"} needed
              </span>
            </button>
          )}
          <Link href="/discover" className="btn-outline h-8 rounded-[8px] px-3 text-[13px]">
            Back to app
          </Link>
        </div>
      </header>
    );
  };

  const frame = (config: GlobalConfig | null, content: React.ReactNode) => (
    <div className="flex min-h-screen flex-col bg-ground text-text" data-screen-label="Admin dashboard">
      {header(config)}
      <div className="flex flex-col gap-3.5 px-5 pt-6 pb-8">{content}</div>
    </div>
  );

  if (!network) return frame(null, networkError ? <Notice tone="error">{networkError}</Notice> : <Skeleton className="h-96" />);
  if (!network.initialised) return frame(null, <Notice>The launchpad is not set up on this network yet.</Notice>);
  if (governance.error && !governance.data) return frame(null, <Notice tone="error">Could not read the config: {governance.error}</Notice>);
  if (!governance.data?.config) return frame(null, <Skeleton className="h-96" />);

  const { config, proposals, now, waiting, rpcMs } = governance.data;
  const { admins, launch, treasury, timelockSecs } = config.active;
  const isAdmin = wallet !== null && admins.members.includes(wallet.address);
  const symbolOf = (mint: string) => quoteOf(mint)?.symbol ?? shortAddress(mint);
  const slots = configuredQuotes(config.active);

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
    run("propose", async () => {
      if (!client || !wallet) return;
      const plan = await client.planProposal(wallet.address, action);
      const what = describeAction(action, symbolOf).toLowerCase();
      await send(plan.instructions, {
        doing: `Proposing to ${what}.`,
        done: plan.executes ? `Done: ${what}.` : `Proposal #${plan.id} is open for the other admins.`,
      });
    });

  const withdraw = (mint: string) =>
    run(`withdraw:${mint}`, async () => {
      if (!client || !wallet) return;
      await send(
        [createAssociatedTokenAccountIdempotent(wallet.address, treasury, mint), client.instructions.withdrawPlatformFees(mint, associatedTokenAddress(treasury, mint))],
        { doing: `Sending ${symbolOf(mint)} platform fees to the treasury.`, done: "Platform fees sent to the treasury." },
      );
    });

  // --- activity over the chosen range -------------------------------------------------
  const nowSecs = Math.floor(Date.now() / 1000);
  const since = nowSecs - range.seconds;
  const act = activity.data;
  const trades = (act?.trades ?? []).filter((trade) => trade.timestamp >= since);
  const totalBps = launch.platformFeeBps + launch.creatorFeeBps;
  let volume = 0;
  let fees = 0;
  let unconverted = 0;
  const buckets = Array.from({ length: range.buckets }, () => 0);
  for (const trade of trades) {
    const quote = quoteOf(trade.quoteMint);
    const v = inUnit(BigInt(trade.quoteAmount), quote, money);
    const f = inUnit(BigInt(trade.feeQuote), quote, money);
    if (v === null || f === null) {
      unconverted++;
      continue;
    }
    if (trade.venue === "curve") volume += v;
    fees += f;
    const index = range.buckets - 1 - Math.floor((nowSecs - trade.timestamp) / range.bucket);
    if (index >= 0 && index < range.buckets && trade.venue === "curve") buckets[index]! += v;
  }
  const platformFees = totalBps ? (fees * launch.platformFeeBps) / totalBps : 0;
  const creatorFees = totalBps ? (fees * launch.creatorFeeBps) / totalBps : 0;
  const launches = (act?.launched ?? []).filter((coin) => coin.createdAt >= since);
  const grads = (act?.graduated ?? []).filter((coin) => (coin.graduatedAt ?? 0) >= since);
  const traders = new Set(trades.map((trade) => trade.trader)).size;
  const partial = act ? act.tradesPartial && act.tradesFrom > since : false;

  const kpis = [
    { label: "Curve volume", value: unitText(volume, money), sub: otherText(volume, money), color: "#F5F1E8" },
    { label: `Platform fees, ${formatBps(launch.platformFeeBps)}`, value: unitText(platformFees, money), sub: otherText(platformFees, money), color: "#FFC98A" },
    { label: `Creator payouts, ${formatBps(launch.creatorFeeBps)}`, value: unitText(creatorFees, money), sub: otherText(creatorFees, money), color: "#F5F1E8" },
    { label: "Launches", value: int(launches.length), sub: `${int(traders)} unique traders`, color: "#F5F1E8" },
    {
      label: "Graduation rate",
      value: launches.length ? `${((grads.length / launches.length) * 100).toFixed(1)}%` : "–",
      sub: `${int(grads.length)} ${grads.length === 1 ? "coin" : "coins"} graduated`,
      color: "#F5F1E8",
    },
  ];

  const peak = Math.max(0, ...buckets);
  const top = peak > 0 ? peak * 1.1 : 1;
  const daysBack = 14;
  const today = Math.floor(nowSecs / 86_400);
  const daily = Array.from({ length: daysBack }, (_, i) => {
    const day = today - (daysBack - 1 - i);
    return {
      day,
      launched: (act?.launched ?? []).filter((coin) => Math.floor(coin.createdAt / 86_400) === day).length,
      graduated: (act?.graduated ?? []).filter((coin) => coin.graduatedAt !== null && Math.floor(coin.graduatedAt / 86_400) === day).length,
    };
  });
  const maxLaunched = Math.max(1, ...daily.map((d) => d.launched));
  const maxGraduated = Math.max(1, ...daily.map((d) => d.graduated));

  const behind = Math.max(0, network.indexer.finalizedHeight - network.indexer.height);
  const openQuotes = slots.filter((slot) => (config.pausedQuotes & (1 << slot.index)) === 0).length;
  const health: [string, string, string][] = [
    ["Arch RPC, last read", `${rpcMs} ms`, rpcMs < 1_000 ? "#66DE8E" : "#F2C46D"],
    ["Indexer lag", behind === 0 ? "In sync" : `${int(behind)} blocks behind`, behind <= 30 ? "#66DE8E" : "#F2C46D"],
    ["Indexed height", int(network.indexer.height), "#66DE8E"],
    ["New launches", config.launchesPaused ? "Paused" : "Open", config.launchesPaused ? "#F2C46D" : "#66DE8E"],
    ["Quote assets open", `${openQuotes} of ${slots.length}`, openQuotes === slots.length ? "#66DE8E" : "#F2C46D"],
    ["Config changes", `${admins.threshold} of ${admins.members.length} keys, then ${formatDuration(timelockSecs)}`, "#66DE8E"],
  ];
  const allNormal = health.every(([, , color]) => color === "#66DE8E");

  // --- config rows and proposals --------------------------------------------------------
  const percent = (bps: number) => (bps / 100).toFixed(2).replace(/\.?0+$/, "");
  const parsePercentBps = (text: string): number | null => {
    const value = parseUnits(text.replace(/%/g, "").trim(), 2);
    return value === null ? null : Number(value);
  };
  type Row = { key: string; label: string; note: string; value: string; draft: string; apply?: (text: string) => ConfigData | string };
  const withLaunch = (patch: Partial<ConfigData["launch"]>): ConfigData => ({ ...config.active, launch: { ...config.active.launch, ...patch } });
  const rows: Row[] = [
    {
      key: "split",
      label: "Curve fee split",
      note: "SARCH / creator, per trade",
      value: `${formatBps(launch.platformFeeBps)} / ${formatBps(launch.creatorFeeBps)}`,
      draft: `${percent(launch.platformFeeBps)} / ${percent(launch.creatorFeeBps)}`,
      apply: (text) => {
        const [a, b] = text.split("/").map((part) => parsePercentBps(part));
        if (a == null || b == null) return "Write it as two percentages, like 1 / 1.25.";
        if (a + b > MAX_TOTAL_FEE_BPS) return `The total fee cannot exceed ${formatBps(MAX_TOTAL_FEE_BPS)}.`;
        return withLaunch({ platformFeeBps: a, creatorFeeBps: b });
      },
    },
    ...slots.map((slot) => {
      const asset = quoteOf(slot.mint);
      const target = graduationQuote({
        totalSupply: launch.totalSupply,
        curveSupply: launch.curveSupply,
        virtualTokenReserves: launch.virtualTokenReserves,
        virtualQuoteReserves: slot.virtualQuoteReserves,
      });
      return {
        key: `target:${slot.mint}`,
        label: `Graduation target, ${symbolOf(slot.mint)}`,
        note: "Quote a curve raises before it graduates",
        value: asset ? `${formatQuote(target, asset)} raised` : `${target} raised`,
        draft: asset ? (Number(target) / 10 ** asset.decimals).toString() : target.toString(),
        apply: (text: string) => {
          if (!asset) return "This asset is not known to the app.";
          const amount = parseUnits(text, asset.decimals);
          if (amount === null || amount <= 0n) return `Enter an amount of ${asset.symbol}.`;
          try {
            const params = curveParamsFromTarget(launch.totalSupply, launch.curveSupply, amount);
            if (params.virtualTokenReserves !== launch.virtualTokenReserves) return "This target does not fit the current supply settings.";
            return {
              ...config.active,
              quotes: config.active.quotes.map((quote) => (quote.mint === slot.mint ? { ...quote, virtualQuoteReserves: params.virtualQuoteReserves } : quote)),
            };
          } catch {
            return "That target does not give a valid curve.";
          }
        },
      };
    }),
    {
      key: "window",
      label: "Early window",
      note: "Seconds after launch with a per-wallet cap",
      value: formatDuration(launch.earlyWindowSecs),
      draft: String(launch.earlyWindowSecs),
      apply: (text) => {
        const secs = Number(text.trim());
        if (!Number.isInteger(secs) || secs < 0) return "Enter a whole number of seconds.";
        return withLaunch({ earlyWindowSecs: secs });
      },
    },
    {
      key: "cap",
      label: "Wallet cap in early window",
      note: "Share of curve supply",
      value: formatBps(launch.earlyWalletCapBps),
      draft: percent(launch.earlyWalletCapBps),
      apply: (text) => {
        const bps = parsePercentBps(text);
        if (bps === null || bps <= 0 || bps > 10_000) return "Enter a percentage.";
        if (bps < launch.minCreatorBuyBps) return "The cap cannot be below the minimum creator buy.";
        return withLaunch({ earlyWalletCapBps: bps });
      },
    },
    {
      key: "min",
      label: "Minimum creator buy",
      note: "Share of curve supply",
      value: formatBps(launch.minCreatorBuyBps),
      draft: percent(launch.minCreatorBuyBps),
      apply: (text) => {
        const bps = parsePercentBps(text);
        if (bps === null || bps <= 0 || bps > 10_000) return "Enter a percentage.";
        if (bps > launch.earlyWalletCapBps) return "The minimum cannot exceed the early wallet cap.";
        return withLaunch({ minCreatorBuyBps: bps });
      },
    },
    {
      key: "pool",
      label: "Pool fee",
      note: "Liquidity / SARCH / creator, after graduation",
      value: `${formatBps(launch.poolLpFeeBps + launch.poolPlatformFeeBps + launch.poolCreatorFeeBps)} (${formatBps(launch.poolLpFeeBps)} / ${formatBps(launch.poolPlatformFeeBps)} / ${formatBps(launch.poolCreatorFeeBps)})`,
      draft: "",
    },
    {
      key: "supply",
      label: "Supply and virtual reserves",
      note: "Per coin",
      value: `${formatTokens(launch.totalSupply, launch.tokenDecimals)} · curve ${formatTokens(launch.curveSupply, launch.tokenDecimals)} · virtual ${formatTokens(launch.virtualTokenReserves, launch.tokenDecimals)}`,
      draft: "",
    },
    {
      key: "treasury",
      label: "Treasury",
      note: "Receives platform fees",
      value: shortAddress(treasury, 6),
      draft: "",
    },
  ];

  const open = proposals.filter((proposal) => {
    const status = proposalState(proposal, config, now).status;
    return status !== "executed" && status !== "stale";
  });
  const history = proposals.filter((proposal) => !open.includes(proposal)).slice(-8).reverse();
  const pausePending = open.find((proposal) => proposal.action.type === "SetLaunchesPaused");

  const renderProposal = (proposal: Proposal, pending: boolean) => {
    const state = proposalState(proposal, config, now);
    const approvedBy = proposal.epoch === config.epoch ? approvers(proposal, admins) : [];
    const approvedByMe = wallet !== null && approvedBy.includes(wallet.address);
    const id = proposal.id;
    const status =
      state.status === "executed"
        ? `Executed ${when(state.at)}`
        : state.status === "stale"
          ? "Retired: the config was replaced after it was made"
          : state.status === "needs-approvals"
            ? `${state.have} of ${state.need} approvals${approvedByMe ? " · you approved" : ""}`
            : state.status === "waiting"
              ? `Approved · can be executed from ${when(state.readyAt)}`
              : "Approved and ready to execute";
    const changes = proposal.action.type === "SetConfig" && pending ? configChanges(config.active, proposal.action.config, symbolOf) : [];
    return (
      <div
        key={id.toString()}
        className={`flex flex-col gap-2 rounded-[10px] p-3 ${pending ? "border border-[rgba(247,147,26,0.3)] bg-[rgba(247,147,26,0.08)]" : "bg-deep"}`}
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className={`text-[11px] font-medium tracking-[0.1em] uppercase ${pending ? "text-amber" : "text-faint"}`}>
            {pending ? "Pending" : state.status === "executed" ? "Executed" : "Retired"}
          </span>
          <span className="text-[13px] font-medium">
            #{id.toString()} {describeAction(proposal.action, symbolOf)}
          </span>
        </div>
        {changes.length > 0 && (
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-[12.5px] text-mute">
            {changes.map((change) => (
              <li key={change} className="tabular">
                {change}
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="text-[12px] text-dim">
            {status} · proposed by {shortAddress(proposal.proposer)}
          </span>
          {pending && (
            <span className="ml-auto flex gap-1.5">
              {isAdmin && approvedByMe && (
                <button
                  disabled={busy !== null}
                  className="btn-outline h-7 rounded-[7px] px-2.5 text-[12px]"
                  onClick={() =>
                    run(`revoke:${id}`, () =>
                      send([client!.instructions.revoke(wallet!.address, id)], {
                        doing: `Withdrawing your approval of proposal #${id}.`,
                        done: `Your approval of proposal #${id} is withdrawn.`,
                      }),
                    )
                  }
                >
                  Withdraw approval
                </button>
              )}
              {isAdmin && !approvedByMe && (
                <button
                  disabled={busy !== null}
                  className="btn-primary h-7 rounded-[7px] px-2.5 text-[12px]"
                  onClick={() =>
                    run(`approve:${id}`, () =>
                      send([client!.instructions.approve(wallet!.address, id)], { doing: `Approving proposal #${id}.`, done: `You approved proposal #${id}.` }),
                    )
                  }
                >
                  Approve
                </button>
              )}
              {state.status === "ready" && wallet && (
                <button
                  disabled={busy !== null}
                  className="btn-primary h-7 rounded-[7px] px-2.5 text-[12px]"
                  onClick={() =>
                    run(`execute:${id}`, () => send([client!.instructions.execute(id)], { doing: `Executing proposal #${id}.`, done: `Proposal #${id} is in effect.` }))
                  }
                >
                  Execute
                </button>
              )}
            </span>
          )}
        </div>
      </div>
    );
  };

  const card = "flex flex-col gap-3 rounded-[12px] border border-line bg-panel p-4";

  return frame(
    config,
    <>
      <div className="flex flex-wrap items-end justify-between gap-5 px-0.5 pb-1">
        <div className="flex flex-col gap-1.5">
          <h1 className="m-0 text-[30px] leading-[1.1] font-medium tracking-[-0.03em]">Platform overview</h1>
          <p className="m-0 text-[13.5px] text-dim">Volume, fees, launches and graduations across every coin on the curve.</p>
        </div>
        <div className="seg">
          {RANGES.map((option) => (
            <button
              key={option.key}
              onClick={() => setRange(option)}
              className={`h-7 rounded-[6px] px-[11px] text-[12.5px] font-medium ${range.key === option.key ? "seg-on" : "seg-off"}`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="tabular grid grid-cols-5 gap-2.5 max-xl:grid-cols-3 max-md:grid-cols-1">
        {kpis.map((kpi) => (
          <div key={kpi.label} className="flex flex-col gap-1.5 rounded-[12px] border border-line bg-panel px-4 py-3.5 whitespace-nowrap">
            <span className="text-[12px] text-faint">{kpi.label}</span>
            <span className="text-[24px] leading-[1.1] font-medium tracking-[-0.02em]" style={{ color: kpi.color }}>
              {act ? kpi.value : "…"}
            </span>
            <span className="truncate text-[12px] text-dim">{act ? kpi.sub : ""}</span>
          </div>
        ))}
      </div>
      {(partial || unconverted > 0) && (
        <p className="m-0 px-0.5 text-[12px] text-faint">
          {partial && `Covers trades since ${new Date(act!.tradesFrom * 1000).toLocaleString()}. `}
          {unconverted > 0 && `${int(unconverted)} trades in assets that cannot be converted without the bitcoin price are left out. `}
          Fee splits use the current config's rates.
        </p>
      )}

      <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)] items-stretch gap-2.5 max-xl:grid-cols-1">
        <section className={card}>
          <div className="flex items-baseline justify-between">
            <h2 className="m-0 text-[15px] font-medium">Curve volume by {range.bucket === 3_600 ? "hour" : "day"}</h2>
            <span className="tabular text-[12px] text-faint">{peak > 0 ? `Peak ${unitText(peak, money)} in one ${range.bucket === 3_600 ? "hour" : "day"}` : "No volume yet"}</span>
          </div>
          <div className="relative mr-14 h-[210px]">
            {[1, 0.75, 0.5, 0.25].map((t) => (
              <div key={t} className="absolute right-0 left-0 h-0" style={{ top: `${((1 - t) * 100).toFixed(1)}%` }}>
                <div className="h-px bg-[rgba(245,241,232,0.05)]" />
                <span className="tabular absolute -right-14 top-0 -translate-y-1/2 text-[11px] text-faint">{peak > 0 ? unitText(top * t, money, 3) : ""}</span>
              </div>
            ))}
            <div className="absolute inset-0 flex items-end gap-[5px]">
              {buckets.map((value, i) => (
                <span
                  key={i}
                  title={unitText(value, money)}
                  className="flex-1 rounded-[3px_3px_0_0]"
                  style={{ height: `${((value / top) * 100).toFixed(1)}%`, minHeight: 1, background: i === buckets.length - 1 ? "#F7931A" : "rgba(245,241,232,0.3)" }}
                />
              ))}
            </div>
          </div>
          <div className="tabular mr-14 flex justify-between text-[11px] text-faint">
            <span>{range.key === "24h" ? "24h ago" : `${range.buckets}d ago`}</span>
            <span>Now</span>
          </div>
        </section>
        <section className={card}>
          <div className="flex items-baseline justify-between">
            <h2 className="m-0 text-[15px] font-medium">Health</h2>
            <span className="flex items-center gap-1.5 text-[12px]" style={{ color: allNormal ? "#66DE8E" : "#F2C46D" }}>
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: allNormal ? "#66DE8E" : "#F2C46D" }} />
              {allNormal ? "All normal" : "Needs attention"}
            </span>
          </div>
          {health.map(([key, value, color]) => (
            <div key={key} className="grid grid-cols-[8px_minmax(0,1fr)_auto] items-center gap-2.5 border-t border-[rgba(245,241,232,0.05)] py-[7px] text-[12.5px]">
              <span className="h-[7px] w-[7px] rounded-full" style={{ background: color }} />
              <span className="text-mute">{key}</span>
              <span className="tabular whitespace-nowrap">{value}</span>
            </div>
          ))}
        </section>
      </div>

      <div className="grid grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] items-start gap-2.5 max-xl:grid-cols-1">
        <section className={`${card} gap-3.5`}>
          <div className="flex flex-col gap-1">
            <h2 className="m-0 text-[15px] font-medium">Config</h2>
            <span className="text-[12.5px] leading-[1.45] text-dim">
              Changes need {admins.threshold} of {admins.members.length} signers
              {timelockSecs > 0 ? `, then wait ${formatDuration(timelockSecs)}` : ""}. They apply to new launches only. The multisig cannot touch user funds or existing pools.
            </span>
          </div>
          {open.map((proposal) => renderProposal(proposal, true))}
          <div className="flex flex-col">
            {rows.map((row) => (
              <div key={row.key} className="flex flex-col gap-2 border-t border-[rgba(245,241,232,0.06)] py-2.5">
                <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_64px] items-center gap-3">
                  <span className="flex flex-col gap-0.5">
                    <span className="text-[13px]">{row.label}</span>
                    <span className="text-[11.5px] text-faint">{row.note}</span>
                  </span>
                  <span className="tabular truncate text-[13px] font-medium" title={row.key === "treasury" ? treasury : row.value}>
                    {row.value}
                  </span>
                  {isAdmin && row.apply ? (
                    <button
                      onClick={() => {
                        setEdit(row.key);
                        setDraft(row.draft);
                        setDraftError(null);
                      }}
                      className="h-7 rounded-[7px] border border-[rgba(245,241,232,0.16)] text-[12px] font-medium text-soft hover:bg-[rgba(245,241,232,0.06)]"
                    >
                      Edit
                    </button>
                  ) : (
                    <span />
                  )}
                </div>
                {edit === row.key && row.apply && (
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center gap-2">
                      <input
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        autoFocus
                        className="h-[34px] flex-1 rounded-[8px] border border-orange bg-deep px-2.5 text-[13px] text-text outline-none"
                      />
                      <button onClick={() => setEdit(null)} className="btn-outline h-[34px] rounded-[8px] px-3 text-[12.5px]">
                        Cancel
                      </button>
                      <button
                        disabled={busy !== null}
                        onClick={() => {
                          const next = row.apply!(draft);
                          if (typeof next === "string") return setDraftError(next);
                          setEdit(null);
                          void propose({ type: "SetConfig", config: next });
                        }}
                        className="btn-primary h-[34px] rounded-[8px] px-3 text-[12.5px]"
                      >
                        Propose change
                      </button>
                    </div>
                    {draftError && <span className="text-[12px] text-down">{draftError}</span>}
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="flex items-center gap-3 rounded-[10px] bg-deep p-3">
            <span className="flex flex-col gap-0.5">
              <span className="flex items-center gap-[7px] text-[13px] font-medium">
                <span className="h-[7px] w-[7px] rounded-full" style={{ background: config.launchesPaused ? "#FF6B7A" : pausePending ? "#F2C46D" : "#66DE8E" }} />
                {config.launchesPaused ? "New launches are paused" : pausePending ? "Pause proposed" : "New launches are open"}
              </span>
              <span className="text-[12px] text-dim">
                {pausePending
                  ? "Waiting for the other signers. Trading, graduation and claims keep running."
                  : "Pausing stops new coins only. Trading, graduation and claims keep running."}
              </span>
            </span>
            {isAdmin && !pausePending && (
              <button
                disabled={busy !== null}
                onClick={() => void propose({ type: "SetLaunchesPaused", paused: !config.launchesPaused })}
                className="ml-auto h-8 rounded-[8px] border px-3 text-[12.5px] font-medium whitespace-nowrap hover:bg-[rgba(255,107,122,0.08)]"
                style={config.launchesPaused ? { borderColor: "rgba(245,241,232,0.2)", color: "#F5F1E8" } : { borderColor: "rgba(255,107,122,0.6)", color: "#FF6B7A" }}
              >
                {config.launchesPaused ? "Resume new launches" : "Pause new launches"}
              </button>
            )}
          </div>
          {history.length > 0 && (
            <div className="flex flex-col gap-2">
              <span className="kicker">Recent proposals</span>
              {history.map((proposal) => renderProposal(proposal, false))}
            </div>
          )}
        </section>

        <div className="flex min-w-0 flex-col gap-2.5">
          <section className={`${card} gap-2.5`}>
            <div className="flex flex-col gap-1">
              <div className="flex items-baseline gap-2">
                <h2 className="m-0 text-[15px] font-medium">By quote asset</h2>
                <span className="text-[12px] text-faint">All time</span>
              </div>
              <span className="text-[12.5px] leading-[1.45] text-dim">
                Amounts in different assets are not added together. Anyone can send waiting platform fees on; they can only go to the treasury.
              </span>
            </div>
            {slots.map((slot) => {
              const quote = quoteOf(slot.mint);
              const totals = stats.data?.byQuote.find((entry) => entry.quoteMint === slot.mint);
              const paused = (config.pausedQuotes & (1 << slot.index)) !== 0;
              const inVault = waiting.get(slot.mint) ?? 0n;
              const moneyText = (amount: string | bigint | undefined) =>
                amount === undefined ? "–" : quote ? formatQuote(amount, quote, { compact: true }) : amount.toString();
              return (
                <div key={slot.mint} className="flex flex-col gap-2 border-t border-[rgba(245,241,232,0.06)] py-2.5">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-medium">{symbolOf(slot.mint)}</span>
                    <span className="text-[12px]" style={{ color: paused ? "#F2C46D" : "#66DE8E" }}>
                      {paused ? "Launches paused" : "Launches open"}
                    </span>
                    {isAdmin && (
                      <button
                        disabled={busy !== null}
                        onClick={() => void propose({ type: "SetQuotePaused", mint: slot.mint, paused: !paused })}
                        className="ml-auto text-[12px] text-dim hover:text-amber disabled:opacity-50"
                      >
                        Propose {paused ? "resuming" : "pausing"}
                      </button>
                    )}
                  </div>
                  <div className="tabular grid grid-cols-3 gap-2 text-[12px]">
                    <span className="flex flex-col">
                      <span className="text-faint">Coins</span>
                      <span>
                        {int(totals?.coins ?? 0)} · {int(totals?.graduated ?? 0)} graduated
                      </span>
                    </span>
                    <span className="flex flex-col">
                      <span className="text-faint">Volume</span>
                      <span>{moneyText(totals?.volumeQuote ?? "0")}</span>
                    </span>
                    <span className="flex flex-col">
                      <span className="text-faint">Platform fees</span>
                      <span>{moneyText(totals?.platformFees ?? "0")}</span>
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-[12px]">
                    <span className="text-faint">Waiting in vault</span>
                    <span className="tabular">{moneyText(inVault)}</span>
                    {inVault > 0n && wallet && (
                      <button disabled={busy !== null} onClick={() => void withdraw(slot.mint)} className="ml-auto text-[12px] text-amber hover:text-amber-pale disabled:opacity-50">
                        Send to treasury
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </section>

          <section className={card}>
            <div className="flex items-baseline justify-between">
              <h2 className="m-0 text-[15px] font-medium">Launches and graduations</h2>
              <span className="text-[12px] text-faint">Last 14 days</span>
            </div>
            <div className="tabular grid grid-cols-[96px_minmax(0,1fr)_44px] items-end gap-2.5 text-[12px] text-dim">
              <span>Launched</span>
              <div className="flex h-10 items-end gap-1">
                {daily.map((d) => (
                  <span key={d.day} title={`${d.launched} launched`} className="flex-1 rounded-[2px_2px_0_0] bg-[rgba(245,241,232,0.35)]" style={{ height: `${(d.launched / maxLaunched) * 100}%`, minHeight: 1 }} />
                ))}
              </div>
              <span className="text-right text-text">{daily[daily.length - 1]!.launched}</span>
              <span>Graduated</span>
              <div className="flex h-10 items-end gap-1">
                {daily.map((d) => (
                  <span key={d.day} title={`${d.graduated} graduated`} className="flex-1 rounded-[2px_2px_0_0] bg-orange" style={{ height: `${(d.graduated / maxGraduated) * 100}%`, minHeight: 1 }} />
                ))}
              </div>
              <span className="text-right text-text">{daily[daily.length - 1]!.graduated}</span>
            </div>
            <div className="grid grid-cols-2 gap-2 pt-1">
              {[
                [stats.data ? int(stats.data.coins) : "…", "Coins launched, all time"],
                [stats.data ? int(stats.data.graduated) : "…", "Coins graduated, all time"],
                [stats.data ? int(stats.data.trades) : "…", "Trades, all time"],
                [stats.data ? int(stats.data.traders) : "…", "Wallets that traded, all time"],
              ].map(([value, label]) => (
                <div key={label} className="flex flex-col gap-[3px] rounded-[10px] bg-deep px-3 py-2.5">
                  <span className="tabular text-[18px] font-medium">{value}</span>
                  <span className="text-[12px] leading-[1.4] text-dim">{label}</span>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </>,
  );
}
