import { ArchRpc, ArchpadClient } from "@archpad/sdk";
import { mintTestTokens } from "./funding.ts";
import { loadKeySet } from "./network.ts";

async function main() {
  const rpc = new ArchRpc("https://rpc.testnet.arch.network");
  const keys = loadKeySet("testnet");
  const authority = keys.authority;
  const client = new ArchpadClient(rpc, {
    programIds: {
      config: "4imFV6b3eScgkb8bEY4SZcFjuZXNcgjaWC8egoNSxaJu",
      launch: "4ELFjrDZk8q1c2VyJ1RRKAryBCqmU1gTP2of329xz8wQ",
      fees: "5ZbAqMMUGzjD7KGLYEiC8aoaixcqNBFQRRrF5MnLUojW",
      pool: "Ez7DfUYH7tr1DskR585fV7NKkA8HbL9nfhdHthV4X1s8"
    }
  });

  const susdMint = "56XbX9kGbZgRnfSZSZAErZsTGra1UtJunjUhzPX2rwbd";
  const user = "Et9QYuzx8r7NAwwtmfbMwsSLUWo1H68ZG4ZC52o41MLs";
  const amount = 20_000n * 1_000_000n; // 20,000 sUSD

  console.log(`Minting 20,000 sUSD to user ${user}...`);
  await mintTestTokens(client, authority, susdMint, user, amount);
  console.log("Successfully minted 20,000 sUSD to user!");
}

main().catch(console.error);
