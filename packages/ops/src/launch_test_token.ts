import {
  type Address,
  ArchpadClient,
  ArchRpc,
  associatedTokenAddress,
  createAssociatedTokenAccountIdempotent,
  decodeTokenAccount,
  keypairSigner,
  tokenMintTo,
} from "@archpad/sdk";
import { sha256 } from "@noble/hashes/sha2.js";
import { resolve } from "path";
import { REPO_ROOT, loadSigner, readDeployment } from "./network.ts";

async function main() {
  const rpc = new ArchRpc("https://rpc.testnet.arch.network");
  const deployment = readDeployment("testnet");
  if (!deployment) throw new Error("testnet deployment not found");

  const client = new ArchpadClient(rpc, { programIds: deployment.programs });
  const authority = loadSigner(resolve(REPO_ROOT, "keys/testnet/authority.key"));
  console.log("Authority Address:", authority.address);

  // Check authority lamports
  const acc = await rpc.getAccount(authority.address);
  console.log("Authority lamports:", acc ? acc.lamports.toString() : "0 (not found)");

  // sUSD Mint
  const sUsdSigner = keypairSigner(sha256(new TextEncoder().encode("archpad testnet: sUSD quote mint v1")));
  const sUsdMint = sUsdSigner.address;
  console.log("sUSD Mint:", sUsdMint);

  // Ensure authority has sUSD
  const authAta = associatedTokenAddress(authority.address, sUsdMint);
  console.log("Authority sUSD ATA:", authAta);

  const authAtaAcc = await rpc.getAccount(authAta);
  let currentBalance = 0n;
  if (authAtaAcc) {
    const decoded = decodeTokenAccount(authAtaAcc.data);
    currentBalance = decoded.amount;
    console.log("Current authority sUSD balance:", (Number(currentBalance) / 1e6).toFixed(2), "sUSD");
  } else {
    console.log("Creating sUSD ATA for authority...");
  }

  // If balance < 500 sUSD, mint 2,000 sUSD to authority
  if (currentBalance < 500_000_000n) {
    console.log("Minting 2,000 sUSD to authority...");
    const mintAmount = 2_000_000_000n; // 2,000 sUSD
    const mintIxs = [
      createAssociatedTokenAccountIdempotent(authority.address, authority.address, sUsdMint),
      tokenMintTo(sUsdMint, authAta, authority.address, mintAmount),
    ];
    const tx = await client.sendAndConfirm(mintIxs, [authority]);
    console.log("Minted sUSD! Tx:", tx);
  }

  // Now plan launch
  console.log("\nPlanning launch of 'Archpad Genesis' ($ARCHG)...");
  const plan = await client.planLaunch(authority.address, sUsdMint, {
    name: "Archpad Genesis",
    symbol: "ARCHG",
    image: "https://archpad.network/logo.png",
    description: "Genesis test token on Arch Testnet via CLI",
    creatorBuyBps: 50, // 0.5%
  });

  console.log("Generated Mint:", plan.mint);
  console.log("Creator buy tokensOut:", plan.creatorBuy.tokensOut.toString());
  console.log("Creator buy quoteCharged:", (Number(plan.creatorBuy.quoteCharged) / 1e6).toFixed(4), "sUSD");

  console.log("\nExecuting launch transaction on Arch Testnet...");
  const txId = await client.sendAndConfirm(plan.instructions, [authority]);
  console.log("SUCCESS! Token launched on-chain!");
  console.log("Transaction ID:", txId);
  console.log("Token Mint Address:", plan.mint);
  console.log("Quote Asset (sUSD):", sUsdMint);
  console.log("\nView token on local frontend at: http://localhost:3210/coin/" + plan.mint);
}

main().catch((err) => {
  console.error("Launch failed:", err);
  process.exit(1);
});
