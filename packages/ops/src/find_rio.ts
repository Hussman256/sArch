import { ArchRpc, decodeCurve } from "@archpad/sdk";

async function main() {
  const rpc = new ArchRpc("https://rpc.testnet.arch.network");
  const launchProgram = "4ELFjrDZk8q1c2VyJ1RRKAryBCqmU1gTP2of329xz8wQ";
  console.log("Fetching program accounts for launch program:", launchProgram);
  
  const accounts = await rpc.getProgramAccounts(launchProgram);
  console.log(`Found ${accounts.length} accounts for launch program`);

  for (const acc of accounts) {
    try {
      const curve = decodeCurve(acc.account.data);
      console.log("Found curve:", {
        accountPubkey: acc.pubkey,
        mint: curve.mint,
        quoteMint: curve.quoteMint,
        creator: curve.creator,
        status: curve.status,
      });
    } catch (e: any) {
      console.log("Account", acc.pubkey, "dataLen:", acc.account.data.length, "decode error:", e?.message);
    }
  }
}

main().catch(console.error);
