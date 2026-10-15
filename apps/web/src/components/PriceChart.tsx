"use client";

/** A coin's price as candles with volume, its graduation line, and the last price. */
import { useEffect, useMemo, useState } from "react";
import { type Candle, type CoinView, type QuoteAsset, api } from "@/lib/api.ts";
import { useApp } from "@/lib/app.tsx";
import { graduationPrice } from "@/lib/coin.ts";
import { DOWN_COLOR, UP_COLOR } from "@/lib/design-system.ts";
import { pct } from "@/lib/format.ts";
import { Icon } from "./icons.tsx";

const FRAMES = [
  { label: "15s", seconds: 15 },
  { label: "1m", seconds: 60 },
  { label: "5m", seconds: 300 },
  { label: "15m", seconds: 900 },
] as const;

const W = 1000;
const H = 400;
const VH = 56;
const TOP = 16;
const BOTTOM = H - VH - 18;

function nice(raw: number): number {
  const power = 10 ** Math.floor(Math.log10(raw));
  const f = raw / power;
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * power;
}

function build(candles: Candle[], include: number[]) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const c of candles) {
    lo = Math.min(lo, c.low);
    hi = Math.max(hi, c.high);
  }
  for (const v of include) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  if (hi === lo) {
    hi *= 1.05;
    lo *= 0.95;
  }
  const pad = (hi - lo) * 0.05;
  lo = Math.max(0, lo - pad);
  hi += pad;
  const Y = (v: number) => TOP + (1 - (v - lo) / (hi - lo)) * (BOTTOM - TOP);
  const n = candles.length;
  // Few candles should not be drawn as huge blocks.
  const slots = Math.max(n, 40);
  const step = W / slots;
  const offset = (slots - n) * step;
  const bw = Math.max(1.2, step * 0.62);
  const volumes = candles.map((c) => Number(c.volume));
  const vmax = Math.max(1, ...volumes);
  const f = (x: number) => x.toFixed(1);
  let up = "";
  let dn = "";
  let wu = "";
  let wd = "";
  let vu = "";
  let vd = "";
  candles.forEach((c, i) => {
    const x = offset + i * step + (step - bw) / 2;
    const cx = offset + i * step + step / 2;
    const t = Y(Math.max(c.open, c.close));
    const bh = Math.max(1, Y(Math.min(c.open, c.close)) - t);
    const vh = Math.max(1.5, (volumes[i]! / vmax) * VH);
    const body = `M${f(x)} ${f(t)}h${f(bw)}v${f(bh)}h-${f(bw)}z`;
    const wick = `M${f(cx)} ${f(Y(c.high))}V${f(Y(c.low))}`;
    const vol = `M${f(x)} ${H}v-${f(vh)}h${f(bw)}v${f(vh)}z`;
    if (c.close >= c.open) {
      up += body;
      wu += wick;
      vu += vol;
    } else {
      dn += body;
      wd += wick;
      vd += vol;
    }
  });
  const s = nice((hi - lo) / 5);
  const ticks: { v: number; top: string }[] = [];
  for (let k = Math.ceil(lo / s); k * s <= hi; k++) ticks.push({ v: k * s, top: `${((Y(k * s) / H) * 100).toFixed(2)}%` });
  return {
    up,
    dn,
    wu,
    wd,
    vu,
    vd,
    ticks,
    y: (v: number) => `${((Y(v) / H) * 100).toFixed(2)}%`,
    x: (i: number) => `${(((offset + i * step + step / 2) / W) * 100).toFixed(2)}%`,
  };
}

export function PriceChart({ coin, quote, version }: { coin: CoinView; quote: QuoteAsset; version: number }) {
  const { money } = useApp();
  const [frame, setFrame] = useState<(typeof FRAMES)[number]>(FRAMES[1]);
  const [mode, setMode] = useState<"price" | "mcap">("price");
  const [showGrad, setShowGrad] = useState(true);
  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    api.candles(coin.mint, frame.seconds).then(
      (list) => {
        if (!live) return;
        setCandles(list.slice(-120));
        setFailed(false);
      },
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [coin.mint, frame.seconds, version]);

  useEffect(() => setCandles(null), [coin.mint, frame.seconds]);

  const supply = Number(BigInt(coin.totalSupply));
  const gradPrice = graduationPrice(coin);
  const grad = showGrad && gradPrice !== null ? gradPrice : null;
  const chart = useMemo(() => (candles && candles.length > 0 ? build(candles, grad !== null ? [grad] : []) : null), [candles, grad]);

  const label = (v: number) => (mode === "mcap" ? money.big(v * supply, quote) : money.px(v, coin.tokenDecimals, quote, true));
  const last = candles && candles.length > 0 ? candles[candles.length - 1]! : null;
  const lastColor = last && last.close < last.open ? DOWN_COLOR : UP_COLOR;
  const btn = (on: boolean) => `h-[26px] rounded-[6px] px-[9px] text-[12.5px] font-medium hover:text-text ${on ? "bg-[rgba(245,241,232,0.08)] text-text" : "text-dim"}`;

  const xLabels: { left: string; text: string }[] = [];
  if (chart && candles) {
    const n = candles.length;
    const every = Math.max(1, Math.ceil(n / 6));
    for (let i = Math.floor(every / 2); i < n; i += every) {
      const date = new Date(candles[i]!.time * 1000);
      xLabels.push({ left: chart.x(i), text: date.toTimeString().slice(0, frame.seconds < 60 ? 8 : 5) });
    }
  }

  return (
    <section className="flex h-[470px] min-h-[360px] flex-col overflow-hidden rounded-[14px] border border-[rgba(245,241,232,0.07)] bg-panel" aria-label="Price chart">
      <div className="flex items-center gap-0.5 px-2.5 py-2 text-[12.5px] whitespace-nowrap">
        {FRAMES.map((option) => (
          <button key={option.label} onClick={() => setFrame(option)} className={`tabular ${btn(frame === option)}`} aria-pressed={frame === option}>
            {option.label}
          </button>
        ))}
        <span className="mx-2 h-4 w-px bg-[rgba(245,241,232,0.1)]" />
        <button onClick={() => setMode("price")} className={btn(mode === "price")} aria-pressed={mode === "price"}>
          Price
        </button>
        <button onClick={() => setMode("mcap")} className={btn(mode === "mcap")} aria-pressed={mode === "mcap"}>
          Market cap
        </button>
        {gradPrice !== null && (
          <button onClick={() => setShowGrad((value) => !value)} className="ml-auto flex h-[26px] items-center gap-[7px] rounded-[6px] px-[9px] text-[12px] text-dim hover:text-text" aria-pressed={showGrad}>
            <span className="h-0 w-4 border-t-[1.5px] border-dashed" style={{ borderColor: showGrad ? "#F7931A" : "#5E7068" }} />
            Graduation line
          </button>
        )}
      </div>
      <div className="tabular flex flex-wrap gap-x-3 gap-y-1 px-3.5 pb-1 text-[11.5px] whitespace-nowrap text-faint">
        <span className="font-medium text-soft">
          {coin.symbol} / {quote.symbol} · {frame.label}
        </span>
        {last && (
          <>
            <span>
              O <span style={{ color: lastColor }}>{label(last.open)}</span>
            </span>
            <span>
              H <span style={{ color: lastColor }}>{label(last.high)}</span>
            </span>
            <span>
              L <span style={{ color: lastColor }}>{label(last.low)}</span>
            </span>
            <span>
              C <span style={{ color: lastColor }}>{label(last.close)}</span>
            </span>
            {last.open > 0 && <span style={{ color: lastColor }}>{pct((last.close / last.open - 1) * 100, 2)}</span>}
          </>
        )}
      </div>
      <div className="relative mt-1 min-h-[240px] flex-1">
        {chart && (
          <>
            {chart.ticks.map((tick) => (
              <div key={tick.v} className="absolute right-0 left-0 h-0" style={{ top: tick.top }}>
                <div className="absolute top-0 right-[76px] left-3 h-px bg-[rgba(245,241,232,0.045)]" />
                <span className="tabular absolute right-2.5 top-0 -translate-y-1/2 text-[11px] text-faint">{label(tick.v)}</span>
              </div>
            ))}
            <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute top-0 left-3 h-full w-[calc(100%-88px)] overflow-visible" aria-hidden="true">
              <path d={chart.vu} fill="rgba(102,222,142,0.2)" />
              <path d={chart.vd} fill="rgba(255,107,122,0.2)" />
              <path d={chart.wu} fill="none" stroke={UP_COLOR} strokeWidth="1" vectorEffect="non-scaling-stroke" />
              <path d={chart.wd} fill="none" stroke={DOWN_COLOR} strokeWidth="1" vectorEffect="non-scaling-stroke" />
              <path d={chart.up} fill={UP_COLOR} />
              <path d={chart.dn} fill={DOWN_COLOR} />
            </svg>
            {grad !== null && (
              <div className="absolute right-0 left-0 h-0" style={{ top: chart.y(grad) }}>
                <div className="absolute top-0 right-[76px] left-3 border-t border-dashed border-[rgba(247,147,26,0.75)]" />
                <span className="absolute top-1.5 left-5 flex items-center gap-1.5 text-[11.5px] font-medium whitespace-nowrap text-amber">
                  <Icon name="grad" size={13} />
                  Graduates at {money.big(grad * supply, quote)} market cap
                </span>
                <span className="tabular absolute right-1.5 top-0 -translate-y-1/2 rounded-[4px] border border-[rgba(247,147,26,0.6)] bg-panel px-[5px] py-0.5 text-[11px] text-amber">
                  {label(grad)}
                </span>
              </div>
            )}
            {last && (
              <div className="absolute right-0 left-0 h-0" style={{ top: chart.y(last.close) }}>
                <div className="absolute top-0 right-[76px] left-3 border-t border-dotted opacity-70" style={{ borderColor: lastColor }} />
                <span className="tabular absolute right-1.5 top-0 -translate-y-1/2 rounded-[4px] px-[5px] py-0.5 text-[11px] font-medium text-bar" style={{ background: lastColor }}>
                  {label(last.close)}
                </span>
              </div>
            )}
          </>
        )}
        {!chart && (
          <div className="absolute inset-0 grid place-items-center text-[12.5px] text-faint">
            {failed ? "Could not load the chart." : candles === null ? "Loading the chart…" : "No trades yet. The chart starts with the first one."}
          </div>
        )}
      </div>
      <div className="relative mr-[76px] ml-3 h-[26px]">
        {xLabels.map((x) => (
          <span key={x.left} className="tabular absolute top-1.5 -translate-x-1/2 text-[11px] text-faint" style={{ left: x.left }}>
            {x.text}
          </span>
        ))}
      </div>
    </section>
  );
}
