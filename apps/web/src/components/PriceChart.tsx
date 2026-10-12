"use client";

/** A coin's price as candles, at a width the viewer chooses. */
import { CandlestickSeries, type IChartApi, type ISeriesApi, type UTCTimestamp, createChart } from "lightweight-charts";
import { useEffect, useRef, useState } from "react";
import { type Candle, type CoinView, type QuoteAsset, api } from "@/lib/api.ts";
import { priceUnit, significant } from "@/lib/format.ts";

const INTERVALS = [
  { seconds: 5, label: "5s" },
  { seconds: 60, label: "1m" },
  { seconds: 300, label: "5m" },
  { seconds: 900, label: "15m" },
  { seconds: 3_600, label: "1h" },
  { seconds: 86_400, label: "1d" },
];

export function PriceChart({
  coin,
  quote,
  version,
}: {
  coin: Pick<CoinView, "mint" | "tokenDecimals">;
  quote: QuoteAsset;
  /** Changes whenever a trade lands, so the chart knows to refresh. */
  version: number;
}) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const [width, setWidth] = useState(60);
  const [state, setState] = useState<"loading" | "empty" | "ready" | "error">("loading");
  // A new interval or coin should re-fit the view; a refresh should leave it where the viewer put it.
  const fitted = useRef("");

  useEffect(() => {
    if (!container.current) return;
    const created = createChart(container.current, {
      autoSize: true,
      layout: { background: { color: "transparent" }, textColor: "#8b95a3", attributionLogo: false },
      grid: { vertLines: { color: "#1a2027" }, horzLines: { color: "#1a2027" } },
      rightPriceScale: { borderColor: "#252c35" },
      timeScale: { borderColor: "#252c35", timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
    });
    chart.current = created;
    series.current = created.addSeries(CandlestickSeries, {
      upColor: "#2fbf71",
      downColor: "#f0524f",
      wickUpColor: "#2fbf71",
      wickDownColor: "#f0524f",
      borderVisible: false,
      // Prices here can be a hundred-millionth of a bitcoin; show the digits that matter.
      priceFormat: { type: "custom", minMove: 1e-14, formatter: (price: number) => significant(price) },
    });
    return () => {
      created.remove();
      chart.current = null;
      series.current = null;
    };
  }, []);

  useEffect(() => {
    let current = true;
    // The API's price is per base unit; the chart shows it per whole token.
    const { scale } = priceUnit(coin.tokenDecimals, quote);
    api.candles(coin.mint, width).then(
      (candles: Candle[]) => {
        if (!current || !series.current || !chart.current) return;
        series.current.setData(
          candles.map((candle) => ({
            time: candle.time as UTCTimestamp,
            open: candle.open * scale,
            high: candle.high * scale,
            low: candle.low * scale,
            close: candle.close * scale,
          })),
        );
        chart.current.applyOptions({ timeScale: { secondsVisible: width < 60 } });
        const view = `${coin.mint}:${width}`;
        if (fitted.current !== view && candles.length > 0) {
          chart.current.timeScale().fitContent();
          fitted.current = view;
        }
        setState(candles.length === 0 ? "empty" : "ready");
      },
      () => current && setState("error"),
    );
    return () => {
      current = false;
    };
  }, [coin.mint, coin.tokenDecimals, quote, width, version]);

  return (
    <section className="panel p-4" aria-label="Price chart">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Price ({priceUnit(coin.tokenDecimals, quote).label} per token)</h2>
        <div className="flex gap-1">
          {INTERVALS.map((option) => (
            <button
              key={option.seconds}
              aria-pressed={width === option.seconds}
              onClick={() => {
                setState("loading");
                setWidth(option.seconds);
              }}
              className={`rounded-md px-2 py-1 text-xs ${
                width === option.seconds ? "bg-raised text-text" : "text-dim hover:text-text"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <div className="relative h-80">
        <div ref={container} className="absolute inset-0" />
        {state !== "ready" && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-dim">
            {state === "loading" ? "Loading chart…" : state === "empty" ? "No trades yet." : "Could not load the chart."}
          </div>
        )}
      </div>
    </section>
  );
}
