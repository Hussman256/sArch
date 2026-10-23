import {
  type Address,
  ArchpadClient,
  ArchRpc,
  MINT_LEN,
  TOKEN_PROGRAM_ID,
  associatedTokenAddress,
  createAssociatedTokenAccountIdempotent,
  keypairSigner,
  minimumRent,
  systemCreateAccount,
  tokenInitializeMint,
  tokenMintTo,
} from "@archpad/sdk";
import { sha256 } from "@noble/hashes/sha2.js";
import { resolve } from "path";
import { loadSigner } from "./network.ts";

async function main() {
  const rpc = new ArchRpc("https://rpc.testnet.arch.network");
  const client = new ArchpadClient(rpc);
  const authority = loadSigner(resolve("../../keys/testnet/authority.key"));
  console.log("Authority:", authority.address);

  // User's Arch address from Xverse
  const userAddress: Address = "Et9QYuzx8r7NAwwtmfbMwsSLUWo1H68ZG4ZC52o41MLs";

  // Deterministic or generated key for sUSD mint
  // Using a deterministic seed so it's repeatable and well-known
  const sUsdSigner = keypairSigner(sha256(new TextEncoder().encode("archpad testnet: sUSD quote mint v1")));
  console.log("sUSD Mint Address:", sUsdSigner.address);

  const decimals = 6;
  const existingMint = await rpc.getAccount(sUsdSigner.address);
  if (!existingMint) {
    console.log("Creating sUSD mint on testnet...");
    const instructions = [
      systemCreateAccount(
        authority.address,
        sUsdSigner.address,
        minimumRent(MINT_LEN),
        BigInt(MINT_LEN),
        TOKEN_PROGRAM_ID,
      ),
      tokenInitializeMint(sUsdSigner.address, authority.address, decimals),
    ];
    const txId = await client.sendAndConfirm(instructions, [authority, sUsdSigner]);
    console.log("Created sUSD mint! Tx:", txId);
  } else {
    console.log("sUSD mint already exists at", sUsdSigner.address);
  }

  // Mint 10,000 sUSD (10,000 * 10^6 base units = 10_000_000_000n) to user's wallet
  console.log(`Minting 10,000 sUSD to user wallet ${userAddress}...`);
  const userAta = associatedTokenAddress(userAddress, sUsdSigner.address);
  console.log("User ATA:", userAta);

  const amount = 10_000_000_000n; // 10,000 sUSD
  const mintInstructions = [
    createAssociatedTokenAccountIdempotent(authority.address, userAddress, sUsdSigner.address),
    tokenMintTo(sUsdSigner.address, userAta, authority.address, amount),
  ];

  const mintTxId = await client.sendAndConfirm(mintInstructions, [authority]);
  console.log("Minted 10,000 sUSD to user! Tx:", mintTxId);

  // Also mint 10,000 sUSD to authority for testing/reserves
  const authAta = associatedTokenAddress(authority.address, sUsdSigner.address);
  await client.sendAndConfirm(
    [
      createAssociatedTokenAccountIdempotent(authority.address, authority.address, sUsdSigner.address),
      tokenMintTo(sUsdSigner.address, authAta, authority.address, amount),
    ],
    [authority],
  );
  console.log("Minted 10,000 sUSD to authority as well!");

  // Check user balance
  const userAtaAccount = await rpc.getAccount(userAta);
  console.log("User ATA exists:", !!userAtaAccount);
}

main().catch(console.error);
