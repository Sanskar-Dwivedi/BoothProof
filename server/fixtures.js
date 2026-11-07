import { createHash } from 'node:crypto';
import { encodeBase58, MINT, TOKEN_PROGRAM } from './solana.js';

const address = label => encodeBase58(createHash('sha256').update(label).digest());
export const DEMO_RECIPIENT = address('boothproof:demo recipient');
const DEMO_PAYER = address('boothproof:demo payer');
const DEMO_SOURCE = address('boothproof:demo source');
const DEMO_DESTINATION = address('boothproof:demo destination');
const WRONG_MINT = address('boothproof:counterfeit mint');

export const demoScenarios = new Set(['exact', 'short', 'wrong-token', 'duplicate']);

export function demoTransfer(order, scenario, now = Date.now(), overrideAmount) {
  const signature = encodeBase58(createHash('sha512').update(`${order.id}:${scenario}`).digest());
  const mint = scenario === 'wrong-token' ? WRONG_MINT : MINT;
  const short=BigInt(order.amount_units)-250_000n;
  const amount = BigInt(overrideAmount ?? (scenario === 'short' ? short>0n?short:1n : order.amount_units));
  const data = Buffer.alloc(10);
  data[0] = 12;
  data.writeBigUInt64LE(BigInt(amount), 1);
  data[9] = 6;
  const balance = value => ({
    accountIndex: 2, mint, programId: TOKEN_PROGRAM, owner: order.recipient,
    uiTokenAmount: { amount: String(value), decimals: 6 }
  });
  const sourceBalance = value => ({...balance(value),accountIndex:1,owner:DEMO_PAYER});

  return {
    signature,
    transaction: {
      blockTime: Math.floor(now / 1_000), slot: now,
      transaction: {
        signatures: [signature],
        message: {
          accountKeys: [DEMO_PAYER, DEMO_SOURCE, DEMO_DESTINATION, mint, TOKEN_PROGRAM, order.reference],
          header: { numRequiredSignatures: 1, numReadonlyUnsignedAccounts: 3 },
          instructions: [{ programIdIndex: 4, accounts: [1, 3, 2, 0, 5], data: encodeBase58(data) }]
        }
      },
      meta: { err: null, preTokenBalances: [balance(0),sourceBalance(amount)], postTokenBalances: [balance(amount),sourceBalance(0)] }
    }
  };
}

export function demoRecovery(order, now=Date.now()) {
  const sample=demoTransfer(order,'recovery',now,30_000_000);
  sample.transaction.transaction.message.instructions[0].accounts.pop();
  sample.transaction.transaction.message.accountKeys.pop();
  sample.transaction.transaction.message.header.numReadonlyUnsignedAccounts=2;
  return sample;
}
