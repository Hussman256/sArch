import {
  type Address,
  ArchpadClient,
  ArchRpc,
} from "@archpad/sdk";
import { resolve } from "path";
import { readFileSync, writeFileSync } from "fs";
import { loadSigner } from "./network.ts";
import { proposeConfig } from "./operations.ts";

async function main() {
  const rpc = new ArchRpc("https://rpc.testnet.arch.network");
  const client = new ArchpadClient(rpc);
  const authority = loadSigner(resolve("../../keys/testnet/authority.key"));
  const mint: Address = "56XbX9kGbZgRnfSZSZAErZsTGra1UtJunjUhzPX2rwbd";

  console.log("Checking platform vault for sUSD...");
  const vault = client.addresses.platformVault(mint);
  const existingVault = await rpc.getAccount(vault);
  if (!existingVault) {
    console.log("Initializing platform fee vault for sUSD at", vault);
    const tx = await client.sendAndConfirm(
      [client.instructions.initPlatformVault(authority.address, mint)],
      [authority],
    );
    console.log("Platform vault initialized! Tx:", tx);
  } else {
    console.log("Platform vault already exists at", vault);
  }

  // Update deploy/quotes.testnet.json
  const quotesPath = resolve("../../deploy/quotes.testnet.json");
  const quotesData = JSON.parse(readFileSync(quotesPath, "utf-8"));
  const exists = quotesData.quotes.find((q: any) => q.mint === mint);
  if (!exists) {
    quotesData.quotes.push({
      symbol: "sUSD",
      name: "sArch USD (Test)",
      mint: mint,
      decimals: 6,
      virtualQuoteReserves: "4500000000",
    });
    writeFileSync(quotesPath, JSON.stringify(quotesData, null, 2) + "\n");
    console.log("Updated quotes.testnet.json with sUSD!");
  } else {
    console.log("sUSD already in quotes.testnet.json");
  }

  // Also update deploy/testnet.json so indexer and frontend immediately see it
  const testnetPath = resolve("../../deploy/testnet.json");
  const testnetData = JSON.parse(readFileSync(testnetPath, "utf-8"));
  const tExists = testnetData.quotes.find((q: any) => q.mint === mint);
  if (!tExists) {
    testnetData.quotes.push({
      symbol: "sUSD",
      name: "sArch USD (Test)",
      mint: mint,
      decimals: 6,
    });
    writeFileSync(testnetPath, JSON.stringify(testnetData, null, 2) + "\n");
    console.log("Updated testnet.json with sUSD!");
  }

  // Now propose config update
  console.log("Proposing config update with new quote asset...");
  const target = {
    network: {
      name: "testnet",
      rpcUrl: "https://rpc.testnet.arch.network",
      bitcoinNetwork: "testnet",
      hasFaucet: false,
    },
    rpc,
    keys: {
      authority,
      programs: client.addresses.programs,
    },
  };

  const propId = await proposeConfig(target as any, authority, { allowUnconfirmed: true }, console.log);
  console.log("Config Proposal ID:", propId.toString());
}

main().catch(console.error);
