import { ArchRpc, ArchpadClient } from "@archpad/sdk";

async function main() {
  const rpc = new ArchRpc("https://rpc.testnet.arch.network");
  const client = new ArchpadClient(rpc, {
    programIds: {
      config: "4imFV6b3eScgkb8bEY4SZcFjuZXNcgjaWC8egoNSxaJu",
      launch: "4ELFjrDZk8q1c2VyJ1RRKAryBCqmU1gTP2of329xz8wQ",
      fees: "5ZbAqMMUGzjD7KGLYEiC8aoaixcqNBFQRRrF5MnLUojW",
      pool: "Ez7DfUYH7tr1DskR585fV7NKkA8HbL9nfhdHthV4X1s8"
    }
  });

  const mints = [
    "AiUNL95dfsVG8pozNUQ5mMHsYh3oD9mtGkuey1YWgmf9",
    "JD26RJ1sd6yexjuLBsaTWvCN4Ea88tHsZXGRf73mpwxW",
    "8wYMr72kKBejLA58pWyfcK7H9639PjudQTsz8VwqStU5",
    "3amFQSPiuGLarsSWpCeSmU9CXaXkgZ5yhVsYRvjXu7Kd",
    "4CbZAkwe6Z4E22wwbxoUKLshF3aLN8RK4wNEvFCY1tS9"
  ];

  for (const mint of mints) {
    const coin = await client.getCoin(mint);
    console.log("=== MINT:", mint, "===");
    if (coin) {
      console.log("Metadata:", coin.metadata);
      console.log("Curve:", {
        creator: coin.curve.creator,
        status: coin.curve.status,
        virtualQuote: coin.curve.virtualQuote.toString(),
        virtualToken: coin.curve.virtualToken.toString(),
        realQuote: coin.curve.realQuote.toString(),
        realToken: coin.curve.realToken.toString(),
      });
    } else {
      console.log("Coin not found");
    }
  }
}

main().catch(console.error);
