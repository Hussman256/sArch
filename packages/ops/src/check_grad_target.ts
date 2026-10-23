import { ArchRpc, ArchpadClient, curveParams, graduationQuote } from "@archpad/sdk";

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
    { name: "Cactus Hands", mint: "JD26RJ1sd6yexjuLBsaTWvCN4Ea88tHsZXGRf73mpwxW" },
    { name: "Rio", mint: "AiUNL95dfsVG8pozNUQ5mMHsYh3oD9mtGkuey1YWgmf9" },
    { name: "Archpad Genesis", mint: "3amFQSPiuGLarsSWpCeSmU9CXaXkgZ5yhVsYRvjXu7Kd" },
  ];

  for (const m of mints) {
    const coin = await client.getCoin(m.mint);
    if (!coin) continue;
    const params = curveParams(coin.curve);
    const gradTarget = graduationQuote(params);
    const raised = coin.curve.realQuote;
    const remaining = gradTarget - raised;
    const progressBps = (raised * 10000n) / gradTarget;
    console.log(`\n=== ${m.name} (${coin.metadata.symbol}) ===`);
    console.log(`Status: ${coin.curve.status === 0 ? "Trading" : "Graduated"}`);
    console.log(`Graduation Target: ${gradTarget.toString()} base units ($${(Number(gradTarget) / 1e6).toFixed(2)})`);
    console.log(`Already Raised: ${raised.toString()} base units ($${(Number(raised) / 1e6).toFixed(2)})`);
    console.log(`Remaining to Graduate: ${remaining.toString()} base units ($${(Number(remaining) / 1e6).toFixed(2)})`);
    console.log(`Progress: ${(Number(progressBps) / 100).toFixed(2)}%`);
  }
}

main().catch(console.error);
