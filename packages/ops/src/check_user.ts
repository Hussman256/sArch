import { ArchRpc, associatedTokenAddress } from "@archpad/sdk";

async function main() {
  const rpc = new ArchRpc("https://rpc.testnet.arch.network");
  const user = "Et9QYuzx8r7NAwwtmfbMwsSLUWo1H68ZG4ZC52o41MLs";
  const acc = await rpc.getAccount(user);
  console.log("User Lamports:", acc ? acc.lamports.toString() : "none");

  const mints = [
    { name: "sUSD", mint: "56XbX9kGbZgRnfSZSZAErZsTGra1UtJunjUhzPX2rwbd", decimals: 6 },
    { name: "Cactus (SPIKE)", mint: "JD26RJ1sd6yexjuLBsaTWvCN4Ea88tHsZXGRf73mpwxW", decimals: 6 },
    { name: "Rio (RIO)", mint: "AiUNL95dfsVG8pozNUQ5mMHsYh3oD9mtGkuey1YWgmf9", decimals: 6 },
    { name: "ARCHG", mint: "3amFQSPiuGLarsSWpCeSmU9CXaXkgZ5yhVsYRvjXu7Kd", decimals: 6 },
  ];

  for (const m of mints) {
    const ata = associatedTokenAddress(user, m.mint);
    const tokenAcc = await rpc.getAccount(ata);
    if (tokenAcc && tokenAcc.data.length >= 72) {
      const dv = new DataView(tokenAcc.data.buffer, tokenAcc.data.byteOffset, tokenAcc.data.byteLength);
      const amount = dv.getBigUint64(64, true);
      const formatted = (Number(amount) / 10 ** m.decimals).toLocaleString();
      console.log(`${m.name}: ${amount.toString()} base units ($${formatted})`);
    } else {
      console.log(`${m.name}: 0 (no account)`);
    }
  }
}

main().catch(console.error);
