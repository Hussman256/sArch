import { ArchRpc } from "@archpad/sdk";
import { loadSigner } from "./network.ts";
import { resolve } from "path";

async function main() {
  const rpc = new ArchRpc("https://rpc.testnet.arch.network");
  const auth = loadSigner(resolve("../../keys/testnet/authority.key"));
  console.log("Authority address:", auth.address);
  const acc = await rpc.getAccount(auth.address);
  console.log("Authority Lamports:", acc?.lamports);
}

main().catch(console.error);
