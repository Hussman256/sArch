"use client";

/**
 * Launching a coin: name, ticker, picture, description and links, the asset
 * it is priced in, and the creator's own first buy, all in one signed
 * transaction. The cost is worked out with the same math the program runs.
 */
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import {
  MAX_DESCRIPTION_LEN,
  MAX_IMAGE_LEN,
  MAX_NAME_LEN,
  MAX_SYMBOL_LEN,
  bpsCeil,
  bpsFloor,
  initialReserves,
  quoteBuy,
  quoteInForTokensOut,
} from "@archpad/sdk";
import { type QuoteAsset, api } from "@/lib/api.ts";
import { explain, useApp } from "@/lib/app.tsx";
import { getCoinGlyph } from "@/lib/design-system.ts";
import { formatBps, formatDuration, formatQuote, formatTokens, shortAddress } from "@/lib/format.ts";
import { useBalances } from "@/lib/hooks.ts";
import { assetKind, btcText } from "@/lib/money.ts";
import { Icon, type IconName } from "./icons.tsx";
import { useWalletPicker } from "./Shell.tsx";
import { Modal, Notice, useCopy } from "./ui.tsx";

const encoder = new TextEncoder();
const byteLength = (text: string) => encoder.encode(text).length;
const MAX_IMAGE_FILE_BYTES = 1_000_000;
const MAX_DESCRIPTION_CHARS = 200;

/** The longest prefix of `text` that fits in `max` bytes without cutting a character in half. */
function truncateBytes(text: string, max: number): string {
  let out = "";
  let used = 0;
  for (const char of text) {
    const size = byteLength(char);
    if (used + size > max) break;
    out += char;
    used += size;
  }
  return out;
}

const curveTokensPct = (tokens: bigint, curveSupply: bigint) => (curveSupply === 0n ? 0 : Number((tokens * 10_000n) / curveSupply) / 100);

type LinkKey ="x" | "telegram" | "website";
const LINK_FIELDS: { key: LinkKey; placeholder: string; icon: IconName; hosts?: string[]; label: string }[] = [
  { key: "x", placeholder: "X profile", icon: "x", hosts: ["x.com", "twitter.com"], label: "X" },
  { key: "telegram", placeholder: "Telegram", icon: "telegram", hosts: ["t.me", "telegram.me"], label: "Telegram" },
  { key: "website", placeholder: "Website", icon: "globe", label: "website" },
];

/** A link as the API will store it, or an explanation of why it will not. */
function checkLink(raw: string, field: (typeof LINK_FIELDS)[number]): { url?: string; error?: string } {
  const value = raw.trim();
  if (!value) return {};
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { error: `The ${field.label} link is not a valid address.` };
  }
  if (url.protocol !== "https:") return { error: `The ${field.label} link must start with https://.` };
  if (field.hosts && !field.hosts.includes(url.hostname.replace(/^www\./, ""))) {
    return { error: `The ${field.label} link must be on ${field.hosts.join(" or ")}.` };
  }
  if (url.toString().length > 200) return { error: `The ${field.label} link is too long.` };
  return { url: url.toString() };
}

interface Picked {
  file: File;
  url: string;
  width: number | null;
  height: number | null;
}

export function CreateCoin() {
  const { network, wallet, client, send, notify, money } = useApp();
  const openPicker = useWalletPicker();
  const [picked, setPicked] = useState<Picked | null>(null);
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [description, setDescription] = useState("");
  const [links, setLinks] = useState<Record<LinkKey, string>>({ x: "", telegram: "", website: "" });
  const [quoteMint, setQuoteMint] = useState("");
  const [buyBps, setBuyBps] = useState<number | null>(null);
  const [step, setStep] = useState<"form" | "sign" | "done">("form");
  const [busy, setBusy] = useState<string | null>(null);
  const [created, setCreated] = useState<{ mint: string; tokens: bigint; symbol: string; buyBps: number } | null>(null);
  const [dupes, setDupes] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [copied, copy] = useCopy();
  const fileInput = useRef<HTMLInputElement>(null);

  const launch = network?.launch;
  const quotes = useMemo(() => (network?.quotes ?? []).filter((quote) => !quote.paused), [network]);
  const quote: QuoteAsset | undefined = quotes.find((entry) => entry.mint === quoteMint) ?? quotes[0];
  const { balances } = useBalances(quote ? [quote.mint] : []);

  useEffect(() => {
    if (!quoteMint && quotes[0]) setQuoteMint(quotes[0].mint);
  }, [quotes, quoteMint]);
  useEffect(() => {
    if (buyBps === null && launch) setBuyBps(launch.minCreatorBuyBps);
  }, [launch, buyBps]);

  // Let go of a picture's preview when another replaces it.
  const pickedUrl = picked?.url;
  useEffect(
    () => () => {
      if (pickedUrl) URL.revokeObjectURL(pickedUrl);
    },
    [pickedUrl],
  );

  // Another coin with the same ticker is allowed, but the creator should know.
  const ticker = symbol.trim();
  useEffect(() => {
    if (!ticker) return setDupes(0);
    let live = true;
    const timer = window.setTimeout(() => {
      api
        .coins({ q: ticker, limit: 100 })
        .then((coins) => live && setDupes(coins.filter((coin) => coin.symbol.toUpperCase() === ticker.toUpperCase()).length))
        .catch(() => undefined);
    }, 300);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [ticker]);

  // What the creator's own buy will cost and return, from the same math the program runs.
  const creatorBuy = useMemo(() => {
    if (!launch || !quote || buyBps === null) return null;
    try {
      const curveSupply = BigInt(launch.curveSupply);
      const reserves = initialReserves({
        totalSupply: BigInt(launch.totalSupply),
        curveSupply,
        virtualTokenReserves: BigInt(launch.virtualTokenReserves),
        virtualQuoteReserves: BigInt(quote.virtualQuoteReserves),
      });
      const rates = { platformBps: launch.platformFeeBps, creatorBps: launch.creatorFeeBps };
      const cap = bpsFloor(curveSupply, launch.earlyWalletCapBps);
      let tokens = bpsCeil(curveSupply, buyBps);
      if (tokens > cap) tokens = cap;
      const buy = quoteBuy(reserves, rates, quoteInForTokensOut(reserves, rates, tokens));
      const q0 = Number(reserves.virtualQuote);
      const k = q0 * Number(reserves.virtualToken);
      const target = Number(quote.graduationQuote);
      const priceAt = (p: number) => {
        const q = q0 + target * p;
        return q / (k / q);
      };
      return { buy, priceAt, start: Number(buy.quoteToCurve) / target };
    } catch {
      return null;
    }
  }, [launch, quote, buyBps]);

  const pick = (file: File | undefined) => {
    if (!file) return;
    if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) {
      notify("error", "Choose a PNG, JPG, GIF or WebP picture.");
      return;
    }
    const url = URL.createObjectURL(file);
    setPicked({ file, url, width: null, height: null });
    const image = new Image();
    image.onload = () => setPicked((current) => (current?.url === url ? { ...current, width: image.naturalWidth, height: image.naturalHeight } : current));
    image.src = url;
  };

  const shell = (content: React.ReactNode) => <div className="flex flex-1 flex-col px-12 pt-9 pb-12 max-lg:px-4">{content}</div>;
  if (!network) return shell(<Notice>Loading…</Notice>);
  if (!network.initialised || !launch) return shell(<Notice>The launchpad is not set up on this network yet.</Notice>);
  if (network.launchesPaused && step !== "done") return shell(<Notice>New launches are paused. Coins that already exist trade as usual.</Notice>);
  if (!quote || buyBps === null) return shell(<Notice>No asset is open for new launches right now.</Notice>);

  const checked = LINK_FIELDS.map((field) => ({ field, ...checkLink(links[field.key], field) }));
  const problems: string[] = [];
  if (name.trim() && byteLength(name.trim()) > MAX_NAME_LEN) problems.push("The name is too long.");
  if (ticker && byteLength(ticker) > MAX_SYMBOL_LEN) problems.push("The ticker is too long.");
  if (picked && picked.file.size > MAX_IMAGE_FILE_BYTES) problems.push("The picture is larger than 1 MB.");
  for (const entry of checked) if (entry.error) problems.push(entry.error);
  const balance = balances.get(quote.mint) ?? 0n;
  const short = wallet !== null && creatorBuy !== null && balance < creatorBuy.buy.quoteCharged;
  if (short && creatorBuy) problems.push(`Your first buy costs ${formatQuote(creatorBuy.buy.quoteCharged, quote)}, more than your ${quote.symbol} balance.`);
  const complete = Boolean(picked && name.trim() && ticker && description.trim());
  const ready = complete && problems.length === 0 && creatorBuy !== null;

  const kind = assetKind(quote);
  const S = (amount: bigint) => money.size(amount, quote);
  const tokensText = creatorBuy ? formatTokens(creatorBuy.buy.tokensOut, launch.tokenDecimals) : "…";
  const tkShown = created?.symbol ?? (ticker || "TICKER");
  const nameShown = name.trim() || "Your coin";
  const fee = creatorBuy ? creatorBuy.buy.fees.platform + creatorBuy.buy.fees.creator : 0n;
  const total = creatorBuy ? creatorBuy.buy.quoteCharged : 0n;
  const targetText = (asset: QuoteAsset) =>
    assetKind(asset) === "btc" ? btcText(Number(asset.graduationQuote), 2) : formatQuote(asset.graduationQuote, asset, { compact: true });
  const buyPctText = formatBps(created?.buyBps ?? buyBps);
  const { glyph, bg } = getCoinGlyph(ticker, name);

  const submit = async () => {
    if (!wallet || !client || !picked || !creatorBuy) return;
    try {
      setBusy("Uploading the picture…");
      const image = await api.uploadImage(picked.file);
      if (byteLength(image.url) > MAX_IMAGE_LEN) throw new Error("The picture's link is too long to store on chain.");

      setBusy("Saving the description…");
      const cleaned = { name: name.trim(), symbol: ticker, description: description.trim() };
      const linkSet: { website?: string; x?: string; telegram?: string } = {};
      for (const entry of checked) if (entry.url) linkSet[entry.field.key] = entry.url;
      const { hash } = await api.uploadMetadata({ ...cleaned, image: image.url, links: linkSet });

      setBusy("Waiting for your wallet…");
      const plan = await client.planLaunch(wallet.address, quote.mint, {
        name: cleaned.name,
        symbol: cleaned.symbol,
        image: image.url,
        // The chain holds a short description. The full text is in the
        // document whose hash the launch records.
        description: truncateBytes(cleaned.description, MAX_DESCRIPTION_LEN),
        metadataHash: hash,
        creatorBuyBps: buyBps,
      });
      setBusy("Submitting to Arch…");
      const processed = await send(plan.instructions, { doing: `Launching ${cleaned.symbol}.`, done: `${cleaned.symbol} is live.` });
      if (processed) {
        setCreated({ mint: plan.mint, tokens: plan.creatorBuy.tokensOut, symbol: cleaned.symbol, buyBps });
        setStep("done");
      } else {
        setStep("form");
      }
    } catch (error) {
      notify("error", explain(error));
      setStep("form");
    } finally {
      setBusy(null);
    }
  };

  const reset = () => {
    setStep("form");
    setPicked(null);
    setName("");
    setSymbol("");
    setDescription("");
    setLinks({ x: "", telegram: "", website: "" });
    setCreated(null);
  };

  // The curve preview: price against the share of the target raised.
  const W = 400;
  const H = 150;
  const curveView = creatorBuy
    ? (() => {
        const ymax = creatorBuy.priceAt(1) * 1.12;
        const X = (q: number) => 8 + q * 384;
        const Y = (price: number) => 136 - (price / ymax) * 124;
        let d = "";
        for (let i = 0; i <= 48; i++) d += `${i ? "L" : "M"}${X(i / 48).toFixed(1)} ${Y(creatorBuy.priceAt(i / 48)).toFixed(1)}`;
        const p0 = Math.min(1, creatorBuy.start);
        return {
          d,
          youX: `${((X(p0) / W) * 100).toFixed(2)}%`,
          youY: `${((Y(creatorBuy.priceAt(p0)) / H) * 100).toFixed(2)}%`,
          gradY: `${((Y(creatorBuy.priceAt(1)) / H) * 100).toFixed(2)}%`,
          // Discover shows the share of curve tokens sold, which at launch is the creator's buy.
          startPct: curveTokensPct(creatorBuy.buy.tokensOut, BigInt(launch.curveSupply)),
          startMc: creatorBuy.priceAt(p0) * Number(BigInt(launch.totalSupply)),
        };
      })()
    : null;

  const tile = (size: number, radius: number, glyphSize: number, extra?: React.CSSProperties) =>
    picked ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={picked.url} alt="" className="flex-none object-cover" style={{ width: size, height: size, borderRadius: radius, ...extra }} />
    ) : (
      <span className="grid flex-none place-items-center text-panel" style={{ width: size, height: size, borderRadius: radius, background: ticker || name ? bg : "rgba(245,241,232,0.08)", ...extra }}>
        {(ticker || name) && (
          <svg viewBox="0 0 256 256" width={glyphSize} height={glyphSize} fill="currentColor">
            <path d={glyph} />
          </svg>
        )}
      </span>
    );

  const label = "text-[12.5px] font-medium text-soft";
  const inputClass = "input h-[42px] px-3";

  return (
    <div className="grid flex-1 grid-cols-[minmax(0,640px)_420px] items-start gap-16 px-12 pt-9 pb-12 max-lg:grid-cols-1 max-lg:gap-10 max-lg:px-4" data-screen-label="Launch a coin">
      <main className="flex min-w-0 flex-col gap-[26px]">
        {step !== "done" ? (
          <>
            <div className="flex flex-col gap-2.5">
              <span className="text-[11px] font-medium tracking-[0.12em] text-orange uppercase">Launch a coin</span>
              <h1 className="m-0 text-[40px] leading-[1.05] font-medium tracking-[-0.035em]">One step, one signature.</h1>
              <p className="pretty m-0 max-w-[520px] text-[15px] leading-[1.55] text-mute">
                Creating a coin is free. Your only cost is your first buy, which goes into the same transaction and pays the same fee as everyone else.
              </p>
            </div>

            <div className="flex flex-col gap-2">
              <span className={label}>Image</span>
              <input
                ref={fileInput}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                className="sr-only"
                onChange={(event) => {
                  pick(event.target.files?.[0]);
                  event.target.value = "";
                }}
              />
              {picked ? (
                <div className="flex items-center gap-3.5 rounded-[10px] border border-[rgba(245,241,232,0.12)] bg-deep p-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={picked.url} alt="" className="h-16 w-16 rounded-[16px] object-cover" />
                  <span className="flex min-w-0 flex-col gap-[3px]">
                    <span className="truncate text-[13.5px] font-medium">{picked.file.name}</span>
                    <span className={`text-[12px] ${picked.file.size > MAX_IMAGE_FILE_BYTES ? "text-down" : "text-faint"}`}>
                      {picked.width && picked.height ? `${picked.width} × ${picked.height} · ` : ""}
                      {Math.round(picked.file.size / 1024)} KB
                    </span>
                  </span>
                  <span className="ml-auto flex gap-1.5">
                    <button className="btn-outline h-8 rounded-[8px] px-3 text-[12.5px]" onClick={() => fileInput.current?.click()}>
                      Replace
                    </button>
                    <button className="h-8 rounded-[8px] px-3 text-[12.5px] font-medium text-dim hover:bg-[rgba(245,241,232,0.06)] hover:text-text" onClick={() => setPicked(null)}>
                      Remove
                    </button>
                  </span>
                </div>
              ) : (
                <button
                  onClick={() => fileInput.current?.click()}
                  onDragOver={(event: DragEvent) => {
                    event.preventDefault();
                    setDragging(true);
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(event: DragEvent) => {
                    event.preventDefault();
                    setDragging(false);
                    pick(event.dataTransfer.files?.[0]);
                  }}
                  className={`flex h-32 flex-col items-center justify-center gap-1.5 rounded-[10px] border-[1.5px] border-dashed bg-deep hover:border-orange hover:text-text ${
                    dragging ? "border-orange text-text" : "border-[rgba(245,241,232,0.22)] text-mute"
                  }`}
                >
                  <Icon name="upload" size={22} />
                  <span className="text-[13.5px] font-medium">Drop an image, or click to upload</span>
                  <span className="text-[12px] text-faint">PNG, JPG, GIF or WebP · square works best · up to 1 MB</span>
                </button>
              )}
            </div>

            <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] gap-3.5">
              <label className="flex flex-col gap-2">
                <span className={label}>Name</span>
                <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Cactus Hands" maxLength={MAX_NAME_LEN} autoComplete="off" className={inputClass} />
              </label>
              <label className="flex flex-col gap-2">
                <span className={label}>Ticker</span>
                <input
                  value={symbol}
                  onChange={(event) => setSymbol(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, MAX_SYMBOL_LEN))}
                  placeholder="SPIKE"
                  autoComplete="off"
                  className={`${inputClass} font-medium tracking-[0.04em]`}
                />
              </label>
            </div>
            {dupes > 0 && (
              <div className="-mt-3.5 flex gap-2 rounded-[8px] bg-[rgba(245,241,232,0.06)] px-[11px] py-[9px] text-[12.5px] leading-[1.45] text-soft">
                <Icon name="info" size={15} color="#FFB257" className="mt-px flex-none" />
                <span>
                  {dupes === 1 ? "1 coin already uses" : `${dupes} coins already use`} {ticker}. Its mint address shows next to the ticker everywhere, so buyers can tell them apart.
                </span>
              </div>
            )}

            <label className="flex flex-col gap-2">
              <span className={`flex justify-between ${label}`}>
                Description <span className="tabular font-normal text-faint">{description.length} / {MAX_DESCRIPTION_CHARS}</span>
              </span>
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="What is this coin about?"
                maxLength={MAX_DESCRIPTION_CHARS}
                className="input min-h-[76px] resize-y px-3 py-2.5 leading-[1.5]"
              />
            </label>

            <div className="flex flex-col gap-2">
              <span className={label}>
                Links <span className="font-normal text-faint">optional</span>
              </span>
              <div className="grid grid-cols-3 gap-2 max-md:grid-cols-1">
                {checked.map(({ field, error }) => (
                  <label
                    key={field.key}
                    className={`flex h-10 cursor-text items-center gap-2 rounded-[8px] border bg-deep px-2.5 text-faint focus-within:border-orange ${
                      error ? "border-[rgba(255,107,122,0.6)]" : "border-[rgba(245,241,232,0.14)]"
                    }`}
                  >
                    <Icon name={field.icon} size={14} />
                    <input
                      value={links[field.key]}
                      onChange={(event) => setLinks((current) => ({ ...current, [field.key]: event.target.value }))}
                      placeholder={field.placeholder}
                      aria-label={field.placeholder}
                      inputMode="url"
                      className="min-w-0 flex-1 border-0 bg-transparent text-[13px] text-text outline-none"
                    />
                  </label>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <span className={label}>Price it in</span>
              <div className="grid grid-cols-2 gap-2.5 max-md:grid-cols-1">
                {quotes.map((option) => {
                  const on = option.mint === quote.mint;
                  const sub =
                    assetKind(option) === "btc"
                      ? `Priced in sats. Graduates at ${targetText(option)} raised.`
                      : assetKind(option) === "usd"
                        ? `Priced in dollars. Graduates at ${targetText(option)} raised.`
                        : `Graduates at ${targetText(option)} raised.`;
                  return (
                    <button
                      key={option.mint}
                      onClick={() => setQuoteMint(option.mint)}
                      aria-pressed={on}
                      className="grid grid-cols-[18px_minmax(0,1fr)] items-start gap-2.5 rounded-[10px] border p-3 text-left hover:border-[rgba(245,241,232,0.4)]"
                      style={{ background: on ? "rgba(245,241,232,0.06)" : "#08231C", borderColor: on ? "#F5F1E8" : "rgba(245,241,232,0.14)" }}
                    >
                      <span
                        className="mt-px h-4 w-4 rounded-full border-[1.5px] shadow-[inset_0_0_0_3px_#0B2B22]"
                        style={{ borderColor: on ? "#F5F1E8" : "rgba(245,241,232,0.14)", background: on ? "#F5F1E8" : "transparent" }}
                      />
                      <span className="flex flex-col gap-[3px]">
                        <span className="text-[14px] font-medium">{option.symbol}</span>
                        <span className="text-[12px] leading-[1.4] text-dim">{sub}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex flex-col gap-2.5">
              <div className="flex items-baseline justify-between">
                <span className={label}>Your first buy</span>
                <span className="tabular text-[14px] font-medium">{formatBps(buyBps)} of the curve</span>
              </div>
              <input
                type="range"
                min={launch.minCreatorBuyBps}
                max={launch.earlyWalletCapBps}
                step={10}
                value={buyBps}
                onChange={(event) => setBuyBps(Number(event.target.value))}
                aria-label="Your first buy, as a share of the curve"
                className="w-full"
              />
              <div className="flex justify-between text-[11.5px] text-faint">
                <span>{formatBps(launch.minCreatorBuyBps)} minimum</span>
                <span>
                  {formatBps(launch.earlyWalletCapBps)} is the per-wallet cap for the first {formatDuration(launch.earlyWindowSecs)}
                </span>
              </div>
              <div className="tabular text-[13px] text-mute">
                {creatorBuy ? `${tokensText} ${ticker || "tokens"} for ${S(total)}, fee included` : ""}
              </div>
            </div>

            <div className="flex flex-col gap-3 rounded-[12px] border border-[rgba(245,241,232,0.1)] bg-deep p-4">
              <span className="text-[11px] font-medium tracking-[0.1em] text-faint uppercase">In one transaction</span>
              {[
                [1, `Create ${ticker || "your coin"} with mint and freeze authority set to none`, "Free"],
                [2, `Buy ${tokensText} ${ticker || "tokens"}, ${formatBps(buyBps)} of the curve`, creatorBuy ? S(creatorBuy.buy.quoteToCurve) : "…"],
                [
                  3,
                  `Pay the ${formatBps(launch.platformFeeBps + launch.creatorFeeBps)} fee: ${formatBps(launch.creatorFeeBps)} comes back to you as creator, ${formatBps(launch.platformFeeBps)} to SARCH`,
                  creatorBuy ? S(fee) : "…",
                ],
              ].map(([n, text, value]) => (
                <div key={n} className="grid grid-cols-[22px_minmax(0,1fr)_auto] items-start gap-2.5 text-[13px] leading-[1.45]">
                  <span className="grid h-[22px] w-[22px] place-items-center rounded-full border border-[rgba(245,241,232,0.18)] text-[11px] text-mute">{n}</span>
                  <span className="pretty text-soft">{text}</span>
                  <span className="tabular whitespace-nowrap">{value}</span>
                </div>
              ))}
              <div className="rule-top tabular flex items-baseline justify-between pt-3">
                <span className="text-[13px] text-dim">You pay</span>
                <span className="flex items-baseline gap-2">
                  <span className="text-[20px] font-medium tracking-[-0.01em]">{creatorBuy ? S(total) : "…"}</span>
                  <span className="text-[12px] text-faint">
                    {creatorBuy && money.alt(total, quote) ? `${money.alt(total, quote)} + network fee` : "+ network fee"}
                  </span>
                </span>
              </div>
            </div>

            {problems.length > 0 && (
              <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[12.5px] text-down">
                {problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            )}

            <div className="flex flex-col gap-2.5">
              <button
                onClick={() => (!wallet ? openPicker() : ready && setStep("sign"))}
                disabled={wallet !== null && !ready}
                className="btn-primary h-[50px] text-[15px]"
              >
                {!wallet ? "Connect a wallet to launch" : `Launch ${ticker || "coin"} · ${creatorBuy ? S(total) : "…"}`}
              </button>
              <span className="text-center text-[12px] text-faint">
                {complete ? "You sign once in your wallet. Creating the coin is free." : "Add an image, name, ticker and description to launch."}
              </span>
            </div>
          </>
        ) : (
          created && (
            <div className="flex flex-col items-start gap-[22px] pt-3">
              {tile(104, 26, 62, { boxShadow: "0 0 0 6px rgba(247,147,26,0.16),0 0 70px rgba(247,147,26,0.3)" })}
              <div className="flex flex-col gap-2">
                <span className="text-[11px] font-medium tracking-[0.12em] text-orange uppercase">Launched</span>
                <h1 className="m-0 text-[44px] leading-[1.05] font-medium tracking-[-0.035em]">{created.symbol} is live.</h1>
                <p className="pretty m-0 max-w-[520px] text-[15px] leading-[1.55] text-mute">
                  You hold {formatTokens(created.tokens, launch.tokenDecimals)} {created.symbol}, {buyPctText} of the curve. Anyone can buy from this block on.
                </p>
              </div>
              <div className="tabular flex items-center gap-2.5 self-stretch rounded-[10px] border border-[rgba(245,241,232,0.12)] bg-deep py-2.5 pr-2.5 pl-3.5">
                <span className="text-[12px] text-faint">Mint</span>
                <span className="text-[13px]" title={created.mint}>
                  {shortAddress(created.mint)}
                </span>
                <span className="text-ghost">·</span>
                <span className="text-[13px] text-mute">Mint and freeze authority: none</span>
                <button
                  onClick={() => copy("link", `${window.location.origin}/coin/${created.mint}`)}
                  className="btn-outline ml-auto h-8 rounded-[8px] px-3 text-[12.5px]"
                >
                  {copied ? "Link copied" : "Copy share link"}
                </button>
              </div>
              <div className="flex flex-col gap-3 self-stretch">
                <span className="text-[11px] font-medium tracking-[0.1em] text-faint uppercase">What happens next</span>
                <div className="grid grid-cols-[22px_minmax(0,1fr)] gap-x-3 gap-y-2.5 text-[13.5px] leading-[1.5] text-soft">
                  {[
                    `For the next ${formatDuration(launch.earlyWindowSecs)}, each wallet can buy at most ${formatBps(launch.earlyWalletCapBps)} of the curve. Your first buy counts toward yours.`,
                    `You earn ${formatBps(launch.creatorFeeBps)} of every trade on the curve. Claim it from your profile at any time.`,
                    `At ${targetText(quote)} raised, ${created.symbol} graduates to an Arch Swap pool and its starting liquidity is locked.`,
                  ].map((text, i) => (
                    <div key={i} className="contents">
                      <span className="grid h-[22px] w-[22px] place-items-center rounded-full border border-[rgba(245,241,232,0.18)] text-[11px] text-mute">{i + 1}</span>
                      <span>{text}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="flex gap-2.5">
                <Link href={`/coin/${created.mint}`} className="btn-primary h-[46px] px-5 text-[14px]">
                  Go to {created.symbol}
                </Link>
                <button onClick={reset} className="btn-outline h-[46px] px-5 text-[14px]">
                  Launch another coin
                </button>
              </div>
            </div>
          )
        )}
      </main>

      <aside className="sticky top-[110px] flex min-w-0 flex-col gap-3.5 max-lg:static">
        <span className="text-[11px] font-medium tracking-[0.12em] text-faint uppercase">{step === "done" ? "On Discover now" : "Preview"}</span>
        <div className="grid grid-cols-[48px_minmax(0,1fr)_auto] items-center gap-3 rounded-[12px] border border-line bg-panel p-3">
          {tile(48, 12, 28)}
          <div className="flex min-w-0 flex-col gap-[5px]">
            <div className="flex min-w-0 items-baseline gap-1.5 whitespace-nowrap">
              <span className="truncate text-[14px] font-medium">{nameShown}</span>
              <span className="text-[12px] text-dim">{tkShown}</span>
              <span className="text-[12px] text-faint">now</span>
            </div>
            <div className="text-[12px] text-faint">{wallet ? shortAddress(wallet.address) : "You"} · 1 holder</div>
            <div className="flex items-center gap-2">
              <span className="h-1 flex-1 overflow-hidden rounded-[2px] bg-[rgba(245,241,232,0.08)]">
                <span className="block h-full rounded-[2px] bg-orange" style={{ width: `${curveView?.startPct ?? 0}%` }} />
              </span>
              <span className="tabular text-[11px] text-dim">{curveView ? `${curveView.startPct.toFixed(1)}%` : ""}</span>
            </div>
          </div>
          <div className="tabular flex flex-col items-end gap-[5px]">
            <span className="text-[13.5px] font-medium">{curveView ? money.big(curveView.startMc, quote) : "…"}</span>
            <span className="text-[12px] text-amber">New</span>
          </div>
        </div>

        <div className="flex flex-col gap-2.5 rounded-[12px] border border-line bg-panel p-3.5">
          <div className="flex justify-between text-[12px] text-dim">
            <span>Where you start on the curve</span>
            <span className="tabular">Graduates at {targetText(quote)}</span>
          </div>
          <div className="relative h-[150px]">
            {curveView && (
              <>
                <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible" aria-hidden="true">
                  <path d={curveView.d} fill="none" stroke="rgba(245,241,232,0.35)" strokeWidth="1.5" strokeDasharray="4 5" vectorEffect="non-scaling-stroke" />
                  <path d="M8 136H392" fill="none" stroke="rgba(245,241,232,0.12)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
                </svg>
                <span
                  className="absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-orange shadow-[0_0_0_5px_rgba(247,147,26,0.2)]"
                  style={{ left: curveView.youX, top: curveView.youY }}
                />
                <span className="absolute translate-x-2.5 -translate-y-[130%] text-[12px] font-medium whitespace-nowrap" style={{ left: curveView.youX, top: curveView.youY }}>
                  You · {buyPctText}
                </span>
                <span
                  className="absolute left-[98%] h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-text bg-panel"
                  style={{ top: curveView.gradY }}
                />
                <span className="absolute right-[4%] -translate-y-[170%] text-[12px] whitespace-nowrap text-soft" style={{ top: curveView.gradY }}>
                  Arch Swap pool
                </span>
              </>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-[9px] rounded-[12px] border border-line bg-panel p-3.5 text-[12.5px] whitespace-nowrap">
          <span className="mb-0.5 text-[13px] font-medium">What buyers will see</span>
          {[
            ["Mint authority", "None"],
            ["Freeze authority", "None"],
            ["Creator's launch buy", `${buyPctText}, full fee paid`],
            [`First ${formatDuration(launch.earlyWindowSecs)}`, `Max ${formatBps(launch.earlyWalletCapBps)} per wallet`],
            ["Pool liquidity", "Locked at graduation"],
          ].map(([key, value]) => (
            <div key={key} className="flex items-center gap-2">
              <Icon name="check" size={13} color="#66DE8E" />
              <span className="text-dim">{key}</span>
              <span className="ml-auto">{value}</span>
            </div>
          ))}
        </div>
        {kind === "other" && <p className="text-[12px] text-faint">Amounts are in {quote.symbol}.</p>}
      </aside>

      {step === "sign" && creatorBuy && (
        <Modal label="Confirm launch" onClose={busy ? undefined : () => setStep("form")} width={440} top={160}>
          <div className="flex flex-col gap-3.5 rounded-[14px] border border-[rgba(245,241,232,0.12)] bg-panel p-5 shadow-[0_24px_70px_rgba(0,0,0,0.55)]">
            <div className="flex items-center gap-3">
              {tile(40, 10, 24)}
              <div className="flex flex-col gap-0.5">
                <span className="text-[16px] font-medium">Launch {ticker}</span>
                <span className="text-[12px] text-dim">One transaction. Your wallet shows the same numbers.</span>
              </div>
            </div>
            <div className="tabular flex flex-col gap-2 rounded-[10px] bg-deep p-3 text-[12.5px]">
              <div className="flex justify-between gap-2.5">
                <span className="text-dim">Create {ticker}</span>
                <span>Mint and freeze: none</span>
              </div>
              <div className="flex justify-between gap-2.5">
                <span className="text-dim">Your first buy</span>
                <span>
                  {tokensText} {ticker}
                </span>
              </div>
              <div className="flex justify-between gap-2.5">
                <span className="text-dim">Fee {formatBps(launch.platformFeeBps + launch.creatorFeeBps)}</span>
                <span>{S(fee)}</span>
              </div>
              <div className="flex justify-between gap-2.5">
                <span className="text-dim">You pay</span>
                <span className="font-medium" title={formatQuote(total, quote)}>
                  {S(total)}
                </span>
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <span className="text-[12px] text-mute">{busy ?? "Check the numbers, then sign in your wallet"}</span>
              <div className="h-[3px] overflow-hidden rounded-[2px] bg-[rgba(245,241,232,0.08)]">
                <div className="h-full bg-orange transition-[width] duration-[900ms] ease-linear" style={{ width: busy ? "100%" : "0%" }} />
              </div>
            </div>
            <div className="grid grid-cols-[1fr_1.4fr] gap-2">
              <button className="btn-outline h-10 text-[13.5px]" onClick={() => setStep("form")} disabled={busy !== null}>
                Cancel
              </button>
              <button className="btn-primary h-10 text-[13.5px]" onClick={() => void submit()} disabled={busy !== null} style={{ opacity: busy ? 0.6 : undefined }}>
                {busy ? "Approve in wallet…" : "Sign in wallet"}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
