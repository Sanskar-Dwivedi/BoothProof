import { createDevnetRpc } from '../server/solana.js';

try {
  const rpc = createDevnetRpc(process.env.SOLANA_RPC_URL);
  const [slot] = await Promise.all([rpc.slot(), rpc.mint()]);
  console.log(`Devnet and the 6-decimal SPL USDC mint verified. Finalized slot: ${slot}.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
