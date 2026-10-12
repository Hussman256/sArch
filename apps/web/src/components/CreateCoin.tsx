"use client";

/**
 * Launching a coin: name, ticker, picture and description, the asset it is
 * priced in, and the creator's own first buy, all in one signed transaction.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
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
import { formatBps, formatDuration, formatQuote, formatTokens } from "@/lib/format.ts";
import { useBalances } from "@/lib/hooks.ts";
import { Notice } from "./ui.tsx";

const encoder = new TextEncoder();
const byteLength = (text: string) => encoder.encode(text).length;

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

const MAX_IMAGE_FILE_BYTES = 1_000_000;

function Counter({ value, max }: { value: string; max: number }) {
  const used = byteLength(value);
  return (
    <span className={`tabular text-[11px] ${used > max ? "text-down" : "text-dim"}`}>
      {used}/{max}
    </span>
  );
}

export function CreateCoin() {
  const { network, wallet, client, send, notify } = useApp();
  const router = useRouter();
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [description, setDescription] = useState("");
  const [website, setWebsite] = useState("");
  const [x, setX] = useState("");
  const [telegram, setTelegram] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [quoteMint, setQuoteMint] = useState("");
  const [buyBps, setBuyBps] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

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

  // Show the picture the creator picked, and let go of it when they pick another.
  useEffect(() => {
    if (!file) return setPreview(null);
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

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
      return quoteBuy(reserves, rates, quoteInForTokensOut(reserves, rates, tokens));
    } catch {
      return null;
    }
  }, [launch, quote, buyBps]);

  if (!network) return <Notice>Loading…</Notice>;
  if (!network.initialised || !launch) return <Notice>The launchpad is not set up on this network yet.</Notice>;
  if (network.launchesPaused) return <Notice>New launches are paused. Coins that already exist trade as usual.</Notice>;
  if (!quote) return <Notice>No asset is open for new launches right now.</Notice>;

  const problems: string[] = [];
  if (name.trim() === "") problems.push("Give the coin a name.");
  else if (byteLength(name.trim()) > MAX_NAME_LEN) problems.push("The name is too long.");
  if (symbol.trim() === "") problems.push("Give the coin a ticker.");
  else if (byteLength(symbol.trim()) > MAX_SYMBOL_LEN) problems.push("The ticker is too long.");
  if (!file) problems.push("Choose a picture.");
  else if (file.size > MAX_IMAGE_FILE_BYTES) problems.push("The picture is larger than 1 MB.");
  if (description.length > 2_000) problems.push("The description is longer than 2,000 characters.");
  const balance = balances.get(quote.mint) ?? 0n;
  if (wallet && creatorBuy && balance < creatorBuy.quoteCharged) {
    problems.push(`Your first buy costs ${formatQuote(creatorBuy.quoteCharged, quote)}, more than your ${quote.symbol} balance.`);
  }

  const submit = async () => {
    if (!wallet || !client || !file || buyBps === null) return;
    try {
      setBusy("Uploading the picture…");
      const image = await api.uploadImage(file);
      if (byteLength(image.url) > MAX_IMAGE_LEN) throw new Error("The picture's link is too long to store on chain.");

      setBusy("Saving the description…");
      const cleaned = { name: name.trim(), symbol: symbol.trim(), description: description.trim() };
      const { hash } = await api.uploadMetadata({
        ...cleaned,
        image: image.url,
        links: {
          ...(website.trim() && { website: website.trim() }),
          ...(x.trim() && { x: x.trim() }),
          ...(telegram.trim() && { telegram: telegram.trim() }),
        },
      });

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
      const processed = await send(plan.instructions, {
        doing: `Launching ${cleaned.symbol}.`,
        done: `${cleaned.symbol} is live.`,
      });
      if (processed) router.push(`/coin/${plan.mint}`);
    } catch (error) {
      notify("error", explain(error));
    } finally {
      setBusy(null);
    }
  };

  const minBps = launch.minCreatorBuyBps;
  const maxBps = launch.earlyWalletCapBps;

  return (
    <div className="mx-auto grid max-w-5xl gap-6 lg:grid-cols-[1fr_20rem]">
      <form
        className="panel space-y-5 p-5"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <h1 className="text-xl font-bold">Launch a coin</h1>

        <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
          <div>
            <div className="flex items-baseline justify-between">
              <label className="label" htmlFor="coin-name">
                Name
              </label>
              <Counter value={name.trim()} max={MAX_NAME_LEN} />
            </div>
            <input id="coin-name" className="field" value={name} onChange={(event) => setName(event.target.value)} placeholder="Arch Cat" autoComplete="off" />
          </div>
          <div>
            <div className="flex items-baseline justify-between">
              <label className="label" htmlFor="coin-symbol">
                Ticker
              </label>
              <Counter value={symbol.trim()} max={MAX_SYMBOL_LEN} />
            </div>
            <input
              id="coin-symbol"
              className="field uppercase"
              value={symbol}
              onChange={(event) => setSymbol(event.target.value.toUpperCase())}
              placeholder="ACAT"
              autoComplete="off"
            />
          </div>
        </div>

        <div>
          <label className="label" htmlFor="coin-image">
            Picture
          </label>
          <div className="flex items-center gap-4">
            {preview ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={preview} alt="" className="h-20 w-20 rounded-lg bg-raised object-cover" />
            ) : (
              <div className="flex h-20 w-20 items-center justify-center rounded-lg border border-dashed border-line text-xs text-dim">
                None yet
              </div>
            )}
            <div>
              <input
                id="coin-image"
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                className="block text-sm text-dim file:mr-3 file:rounded-lg file:border-0 file:bg-raised file:px-3 file:py-2 file:text-sm file:font-semibold file:text-text"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
              <p className="mt-1 text-xs text-dim">PNG, JPEG, GIF or WebP, up to 1 MB.</p>
            </div>
          </div>
        </div>

        <div>
          <div className="flex items-baseline justify-between">
            <label className="label" htmlFor="coin-description">
              Description
            </label>
            <span className={`tabular text-[11px] ${description.length > 2_000 ? "text-down" : "text-dim"}`}>
              {description.length}/2000
            </span>
          </div>
          <textarea
            id="coin-description"
            className="field min-h-24"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="What is this coin about?"
          />
        </div>

        <fieldset className="grid gap-4 sm:grid-cols-3">
          <legend className="label">Links (optional)</legend>
          <input className="field" aria-label="Website" value={website} onChange={(event) => setWebsite(event.target.value)} placeholder="https://your.site" inputMode="url" />
          <input className="field" aria-label="X" value={x} onChange={(event) => setX(event.target.value)} placeholder="https://x.com/…" inputMode="url" />
          <input className="field" aria-label="Telegram" value={telegram} onChange={(event) => setTelegram(event.target.value)} placeholder="https://t.me/…" inputMode="url" />
        </fieldset>

        {quotes.length > 1 && (
          <fieldset>
            <legend className="label">Priced in</legend>
            <div className="flex gap-2">
              {quotes.map((option) => (
                <button
                  key={option.mint}
                  type="button"
                  aria-pressed={quote.mint === option.mint}
                  onClick={() => setQuoteMint(option.mint)}
                  className={`button flex-1 border ${
                    quote.mint === option.mint ? "border-accent bg-accent/10 text-accent" : "border-line bg-raised text-dim"
                  }`}
                >
                  {option.symbol}
                </button>
              ))}
            </div>
            <p className="mt-1 text-xs text-dim">
              Buyers pay in this asset, and your fees are paid in it. It cannot be changed after launch. The coin graduates
              after raising {formatQuote(quote.graduationQuote, quote)}.
            </p>
          </fieldset>
        )}

        <div>
          <div className="flex items-baseline justify-between">
            <label className="label" htmlFor="creator-buy">
              Your first buy
            </label>
            <span className="tabular text-sm font-semibold">{buyBps === null ? "" : `${formatBps(buyBps)} of the curve`}</span>
          </div>
          <input
            id="creator-buy"
            type="range"
            className="w-full accent-[var(--color-accent)]"
            min={minBps}
            max={maxBps}
            step={5}
            value={buyBps ?? minBps}
            onChange={(event) => setBuyBps(Number(event.target.value))}
          />
          <p className="mt-1 text-xs text-dim">
            Every creator buys at least {formatBps(minBps)} of their coin's curve in the launch transaction, at the same
            price and fee as anyone else. The most any wallet can buy in the first{" "}
            {formatDuration(launch.earlyWindowSecs)} is {formatBps(maxBps)}, and that includes you.
          </p>
        </div>

        {problems.length > 0 && (name || symbol || file) && (
          <ul className="space-y-1 text-sm text-accent">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        )}

        <button type="submit" className="button-primary w-full py-3 text-base" disabled={!wallet || busy !== null || problems.length > 0}>
          {busy ?? (wallet ? "Launch coin" : "Connect a wallet to launch")}
        </button>
      </form>

      <aside className="space-y-4">
        <section className="panel space-y-2 p-4 text-sm">
          <h2 className="font-semibold">What it costs</h2>
          <dl className="space-y-1.5">
            <div className="flex justify-between">
              <dt className="text-dim">Platform launch fee</dt>
              <dd className="font-semibold text-up">Free</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-dim">Your first buy</dt>
              <dd className="tabular text-right">{creatorBuy ? formatQuote(creatorBuy.quoteCharged, quote) : "…"}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-dim">You receive</dt>
              <dd className="tabular text-right">
                {creatorBuy ? `${formatTokens(creatorBuy.tokensOut, launch.tokenDecimals)} ${symbol.trim() || "tokens"}` : "…"}
              </dd>
            </div>
          </dl>
          <p className="text-xs text-dim">
            Plus a small network fee in ARCH, paid to the network, not to this platform.
          </p>
        </section>

        <section className="panel space-y-2 p-4 text-xs text-dim">
          <h2 className="text-sm font-semibold text-text">What every coin gets</h2>
          <p>A fixed supply of {formatTokens(launch.totalSupply, launch.tokenDecimals)} tokens. Nobody can mint more, and no account can be frozen.</p>
          <p>
            A {formatBps(launch.platformFeeBps + launch.creatorFeeBps)} fee on each curve trade: {formatBps(launch.creatorFeeBps)} to
            you, {formatBps(launch.platformFeeBps)} to the platform. Claim your share whenever you like from{" "}
            {wallet ? (
              <Link href={`/profile/${wallet.address}`} className="text-accent hover:underline">
                your profile
              </Link>
            ) : (
              "your profile"
            )}
            .
          </p>
          <p>
            When the curve sells out the coin graduates automatically: everything raised becomes locked pool liquidity,
            with no graduation fee.
          </p>
          <p>The name, ticker and picture cannot be changed after launch.</p>
        </section>
      </aside>
    </div>
  );
}
