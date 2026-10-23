import { ArchRpc, TOKEN_PROGRAM_ID, TOKEN_ACCOUNT_LEN, addressToBytes, decodeTokenAccount } from "@archpad/sdk";

async function main() {
  const rpc = new ArchRpc("https://rpc.testnet.arch.network");
  const ausdMint = "J6Kc9nCCAqfLeQPmm6TAXQ8mNNSt2qk8EwwZ2kLJC76i";
  const accounts = await rpc.getProgramAccounts(TOKEN_PROGRAM_ID, [
    { dataSize: TOKEN_ACCOUNT_LEN },
    { dataContent: { offset: 0, bytes: addressToBytes(ausdMint) } },
  ]);
  console.log("Total aUSD accounts found:", accounts.length);
  for (const { pubkey, account } of accounts.slice(0, 10)) {
    const token = decodeTokenAccount(account.data);
    console.log("Account:", pubkey, "Owner:", token.owner, "Amount:", token.amount.toString());
  }
}

main().catch(console.error);
