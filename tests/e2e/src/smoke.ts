/**
 * A quick walk through one coin's life on the local chain, printing what the
 * chain reports at each step. Useful when a test fails and you want to see the
 * logs:  pnpm --filter @archpad/e2e smoke
 */
import { type ProcessedTransaction, eventsOf } from "@archpad/sdk";
import { coinText, connect, newWallet, waitUntil } from "./harness.ts";

const chain = await connect();
const { client } = chain;
const verbose = process.argv.includes("--logs");

const show = (title: string, processed: ProcessedTransaction) => {
  const bytes = processed.logs.reduce((total, line) => total + line.length, 0);
  console.log(`\n=== ${title}: ${processed.logs.length} log lines, ${bytes} bytes`);
  if (verbose) for (const line of processed.logs) console.log(`  ${line}`);
  for (const line of processed.logs) {
    if (/consumed \d+ of \d+ compute units/.test(line) && !line.includes("TokenT4") && !line.includes("1111111")) {
      console.log(`  ${line}`);
    }
  }
  for (const event of eventsOf(processed)) console.log("  event:", event.type);
};

const creator = await newWallet(chain, { btc: 100_000_000n });
const whale = await newWallet(chain, { btc: 5_000_000_000n });

const launch = await client.planLaunch(creator.address, chain.btc, { ...coinText("Smoke"), creatorBuyBps: 100 });
show("launch", await client.sendAndConfirm(launch.instructions, [creator]));

let curve = (await client.getCurve(launch.mint))!;
await waitUntil(chain, curve.earlyWindowEnd);

show("buy", await client.sendAndConfirm(client.planCurveBuy(whale.address, curve, 5_000_000n, 100).instructions, [whale]));
curve = (await client.getCurve(launch.mint))!;
const held = await client.getTokenBalance(whale.address, launch.mint);
show("sell", await client.sendAndConfirm(client.planCurveSell(whale.address, curve, held / 2n, 100).instructions, [whale]));

curve = (await client.getCurve(launch.mint))!;
show(
  "graduating buy",
  await client.sendAndConfirm(client.planCurveBuy(whale.address, curve, 2_000_000_000n, 100).instructions, [whale]),
);

let pool = (await client.getPool(launch.mint))!;
show("pool buy", await client.sendAndConfirm(client.planPoolSwap(whale.address, pool, true, 1_000_000n, 100).instructions, [whale]));
pool = (await client.getPool(launch.mint))!;
show("pool sell", await client.sendAndConfirm(client.planPoolSwap(whale.address, pool, false, held / 4n, 100).instructions, [whale]));

show("claim", await client.sendAndConfirm(client.planClaimCreatorFees(creator.address, curve), [creator]));
