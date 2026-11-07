import { randomBytes } from 'node:crypto';

export const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const DEVNET_RPC = 'https://api.devnet.solana.com';
const DEVNET_CHAIN_ID = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function encodeBase58(bytes) {
  let number = 0n;
  for (const byte of bytes) number = number * 256n + BigInt(byte);
  let result = '';
  while (number > 0n) {
    result = alphabet[Number(number % 58n)] + result;
    number /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    result = '1' + result;
  }
  return result;
}

export function decodeBase58(value) {
  if (typeof value !== 'string' || !value.length || value.length > 96) return null;
  let number = 0n;
  for (const character of value) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) return null;
    number = number * 58n + BigInt(digit);
  }
  const bytes = [];
  while (number > 0n) {
    bytes.push(Number(number & 255n));
    number >>= 8n;
  }
  for (const character of value) {
    if (character !== '1') break;
    bytes.push(0);
  }
  return Buffer.from(bytes.reverse());
}

export const isAddress = value => decodeBase58(value)?.length === 32;
export const isSignature = value => decodeBase58(value)?.length === 64;
export const newReference = () => encodeBase58(randomBytes(32));

export function parseAmount(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,3})(?:\.\d{1,2})?$/.test(value)) {
    return null;
  }
  const [whole, fraction = ''] = value.split('.');
  const units = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  return units > 0n ? Number(units) : null; // Legacy numeric field, bounded below 10 billion units.
}

export function formatUnits(value) {
  const units = BigInt(value);
  const fraction = (units % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '').padEnd(2, '0');
  return `${units / 1_000_000n}.${fraction}`;
}

export function paymentUrl(order) {
  const query = new URLSearchParams({
    amount: formatUnits(order.amount_units),
    'spl-token': MINT,
    reference: order.reference,
    label: 'Boothproof',
    message: order.title
  });
  return `solana:${order.recipient}?${query.toString().replaceAll('+', '%20')}`;
}

export const evidenceLabels = {
  exact: 'Exact payment',
  amount: 'Wrong amount',
  mint: 'Wrong token',
  recipient: 'Wrong recipient',
  balance: 'Unexpected balance change'
};

function readBalance(balance) {
  const raw = balance?.uiTokenAmount?.amount;
  return typeof raw === 'string' && /^(0|[1-9]\d{0,19})$/.test(raw) && BigInt(raw)<=0xffffffffffffffffn ? BigInt(raw) : null;
}

export const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const companionPrograms = new Set([SYSTEM_PROGRAM,ASSOCIATED_TOKEN_PROGRAM,
  'ComputeBudget111111111111111111111111111111','MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
  'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo']);

// Pure decoder shared by recovery, reference checks, monitoring and Demo fixtures.
export function verifyPayment(order, signature, response, { knownReferences = new Map([[order.reference,order.id]]), requireReference = false, now = new Date().toISOString() } = {}) {
  const reject = (code, reason, kind) => ({ outcome:'exception',code,reason,kind,signature });
  const unsupported = reason => reject('UNSUPPORTED_TRANSACTION',reason);
  if (response===null) return {outcome:'pending',signature};
  const { transaction, meta, slot, blockTime } = response ?? {};
  const message = transaction?.message;
  if (!isSignature(signature) || !Array.isArray(transaction?.signatures) || transaction.signatures[0] !== signature ||
      !Array.isArray(message?.accountKeys) || !Array.isArray(message?.instructions) ||
      !Number.isSafeInteger(slot) || slot < 0 || !meta || !Object.hasOwn(meta,'err')) return unsupported('The RPC transaction structure is incomplete or inconsistent.');
  if (meta.err!==null) return reject('TRANSACTION_FAILED','The transaction failed on chain.');
  if (response.version!==undefined && response.version!=='legacy' && response.version!==0) return unsupported('Only legacy and v0 transactions are supported.');
  const staticKeys = message.accountKeys;
  const writable = meta.loadedAddresses?.writable ?? [];
  const readonly = meta.loadedAddresses?.readonly ?? [];
  if (!Array.isArray(writable) || !Array.isArray(readonly)) return unsupported('Lookup-table addresses are unavailable.');
  if(message.addressTableLookups!==undefined) {
    if(!Array.isArray(message.addressTableLookups)||message.addressTableLookups.some(lookup=>!isAddress(lookup?.accountKey)||
        !Array.isArray(lookup.writableIndexes)||!Array.isArray(lookup.readonlyIndexes)||
        [...lookup.writableIndexes,...lookup.readonlyIndexes].some(index=>!Number.isInteger(index)||index<0||index>255))) return unsupported('Invalid address-table lookup structure.');
    if(message.addressTableLookups.reduce((count,lookup)=>count+lookup.writableIndexes.length,0)!==writable.length ||
        message.addressTableLookups.reduce((count,lookup)=>count+lookup.readonlyIndexes.length,0)!==readonly.length) return unsupported('Lookup-table address counts do not match resolved metadata.');
  }
  if(response.version==='legacy'&&(writable.length||readonly.length)) return unsupported('A legacy transaction cannot have loaded addresses.');
  const keys = [...staticKeys, ...writable, ...readonly];
  if (!keys.length || keys.length>256 || keys.some(key=>!isAddress(key)) || new Set(keys).size!==keys.length) return unsupported('Invalid or unresolved account addresses.');
  const { numRequiredSignatures, numReadonlyUnsignedAccounts, numReadonlySignedAccounts = 0 } = message.header ?? {};
  if (!Number.isInteger(numRequiredSignatures) || !Number.isInteger(numReadonlyUnsignedAccounts) ||
      numRequiredSignatures < 1 || numReadonlyUnsignedAccounts < 0 ||
      numRequiredSignatures + numReadonlyUnsignedAccounts > staticKeys.length ||
      !Number.isInteger(numReadonlySignedAccounts) || numReadonlySignedAccounts<0 || numReadonlySignedAccounts>numRequiredSignatures ||
      transaction.signatures.length!==numRequiredSignatures || transaction.signatures.some(s=>!isSignature(s))) return unsupported('Invalid message header or signer list.');
  const validIndex = index => Number.isInteger(index) && index>=0 && index<keys.length;
  const isReadonly = index => index<staticKeys.length
    ? index<numRequiredSignatures ? index>=numRequiredSignatures-numReadonlySignedAccounts : index>=staticKeys.length-numReadonlyUnsignedAccounts
    : index>=staticKeys.length+writable.length;
  for (const instruction of message.instructions) {
    if (!validIndex(instruction?.programIdIndex) || !Array.isArray(instruction.accounts) ||
        instruction.accounts.some(index=>!validIndex(index)) || typeof instruction.data!=='string') return unsupported('Invalid compiled instruction indices.');
  }
  const known = keys.filter(key=>knownReferences.has(key));
  if (known.some(key=>knownReferences.get(key)!==order.id)) return reject('REFERENCE_CONFLICT','This signature contains a reference to another payment request.');
  const transfers = message.instructions.map((instruction,index)=>({instruction,index,data:decodeBase58(instruction.data)}))
    .filter(({instruction,data})=>[TOKEN_PROGRAM,TOKEN_2022].includes(keys[instruction.programIdIndex]) && [3,12].includes(data?.[0]));
  if (transfers.length!==1) return unsupported('Expected one direct top-level token transfer; CPI-only and multiple transfers are unsupported.');
  const {instruction:transfer,index:instruction_index,data}=transfers[0];
  if (keys[transfer.programIdIndex]!==TOKEN_PROGRAM) return unsupported('Token-2022 payments are unsupported.');
  const checked = data.length===10 && data[0]===12;
  if (!checked && !(data.length===9 && data[0]===3)) return unsupported('Unsupported transfer encoding.');
  const indices=transfer.accounts;
  const required=checked?4:3;
  if (indices.length<required || indices.length>required+1 || indices[required-1]>=numRequiredSignatures) return unsupported('Delegated and multisig transfer forms are unsupported.');
  const bound = indices.length===required+1 && keys[indices[required]]===order.reference &&
    isReadonly(indices[required]) && indices[required]>=numRequiredSignatures && instruction_index===message.instructions.length-1;
  if ((known.length || requireReference) && !bound) return reject('INVALID_REFERENCE','The known reference is not a read-only account on the final transfer instruction.');
  if (indices.length!==required && !bound) return unsupported('Unknown extra transfer accounts are unsupported.');
  if(meta.innerInstructions!=null&&!Array.isArray(meta.innerInstructions)) return unsupported('Invalid inner instruction evidence.');
  for (const group of meta.innerInstructions ?? []) {
    if(!group||typeof group!=='object') return unsupported('Invalid inner instruction group.');
    const {instructions}=group;
    if (!Array.isArray(instructions)||!Number.isInteger(group.index)||group.index<0||group.index>=message.instructions.length) return unsupported('Invalid inner instructions.');
    for (const inner of instructions) {
      if (!validIndex(inner?.programIdIndex)||!Array.isArray(inner.accounts)||inner.accounts.some(index=>!validIndex(index))||typeof inner.data!=='string') return unsupported('Invalid inner instruction indices or data.');
      const innerData=decodeBase58(inner.data);
      if ([TOKEN_PROGRAM,TOKEN_2022].includes(keys[inner.programIdIndex]) && [3,12].includes(innerData?.[0])) return unsupported('Additional inner token transfers are unsupported.');
    }
  }
  if (message.instructions.some((instruction,index)=>index!==instruction_index &&
      !companionPrograms.has(keys[instruction.programIdIndex]) &&
      !(keys[instruction.programIdIndex]===TOKEN_PROGRAM && [1,16,18].includes(decodeBase58(instruction.data)?.[0])))) return unsupported('Unsupported companion program or token instruction.');
  const destinationIndex = indices[checked ? 2 : 1];
  const amount = data.readBigUInt64LE(1);
  if (amount===0n) return reject('ZERO_TRANSFER','A zero transfer cannot create credit.');
  if (indices[0]===destinationIndex) return reject('SELF_TRANSFER','Self-transfers cannot create incoming credit.');
  if (isReadonly(indices[0]) || isReadonly(destinationIndex)) return unsupported('Transfer token accounts must be writable.');
  if (!Array.isArray(meta.preTokenBalances) || !Array.isArray(meta.postTokenBalances)) return unsupported('Token balance evidence is unavailable.');
  for (const balances of [meta.preTokenBalances,meta.postTokenBalances]) {
    if (balances.some(balance=>!validIndex(balance?.accountIndex)) || new Set(balances.map(b=>b.accountIndex)).size!==balances.length) return unsupported('Invalid or ambiguous token balance indices.');
  }
  const post = meta.postTokenBalances.find(balance => balance.accountIndex === destinationIndex);
  const pre = meta.preTokenBalances.find(balance => balance.accountIndex === destinationIndex);
  const postAmount = readBalance(post);
  const preAmount = pre ? readBalance(pre) : 0n;
  const chain_time=Number.isSafeInteger(blockTime) && blockTime>=0 && blockTime<10_000_000_000 ? new Date(blockTime*1000).toISOString():null;
  const evidence = kind => ({ signature,kind,slot,amount:amount.toString(),decimals:post?.uiTokenAmount?.decimals ?? 6,observed_at:chain_time??now });
  const invalid = (code,reason,kind) => ({...reject(code,reason,kind),evidence:evidence(kind)});
  if (!isAddress(post?.owner) || !isAddress(post?.mint) || postAmount===null || preAmount===null ||
      (pre && !isAddress(pre.owner))) return unsupported('Destination ownership or raw balance evidence is missing.');
  if(!Number.isInteger(post.uiTokenAmount.decimals)||post.uiTokenAmount.decimals<0||post.uiTokenAmount.decimals>255) return unsupported('Invalid token decimal metadata.');
  if (post.programId===undefined || (pre && pre.programId===undefined)) return unsupported('Destination Token Program evidence is missing.');
  if (post.mint!==MINT || post.programId!==TOKEN_PROGRAM || post.uiTokenAmount.decimals!==6 ||
      (checked && (keys[indices[1]]!==MINT || data[9]!==6))) return invalid('WRONG_MINT','This is not standard Devnet USDC with six decimals.','mint');
  if (post.owner!==order.recipient || (pre && pre.owner!==post.owner)) return invalid('WRONG_RECIPIENT','The destination is not owned by this receiving wallet.','recipient');
  if ((pre && (pre.mint!==MINT || pre.programId!==TOKEN_PROGRAM || pre.uiTokenAmount.decimals!==6)) ||
      postAmount-preAmount!==amount) return invalid('BALANCE_MISMATCH','The destination net credit does not match the transfer amount.','balance');
  if (!pre) {
    const created=message.instructions.some(instruction=>keys[instruction.programIdIndex]===ASSOCIATED_TOKEN_PROGRAM && instruction.accounts[1]===destinationIndex) ||
      (message.instructions.some(instruction=>{const bytes=decodeBase58(instruction.data);return keys[instruction.programIdIndex]===SYSTEM_PROGRAM && instruction.accounts[1]===destinationIndex && bytes?.length>=4 && bytes.readUInt32LE(0)===0;}) &&
       message.instructions.some(instruction=>keys[instruction.programIdIndex]===TOKEN_PROGRAM && instruction.accounts[0]===destinationIndex && [1,16,18].includes(decodeBase58(instruction.data)?.[0])));
    if (!created) return unsupported('A newly created destination requires account-creation evidence.');
  }
  const sourcePre=meta.preTokenBalances.find(balance=>balance.accountIndex===indices[0]);
  const sourcePost=meta.postTokenBalances.find(balance=>balance.accountIndex===indices[0]);
  if (!isAddress(sourcePre?.owner) || !isAddress(sourcePost?.owner) || readBalance(sourcePre)===null || readBalance(sourcePost)===null ||
      sourcePre.programId===undefined || sourcePost.programId===undefined) return unsupported('Source ownership and corresponding debit evidence are required.');
  if (sourcePre.owner===order.recipient) return reject('SELF_TRANSFER','A transfer from the receiving wallet cannot create incoming credit.');
  if (sourcePre.owner!==keys[indices[required-1]]) return unsupported('Delegated transfers are unsupported.');
  if (sourcePre.owner!==sourcePost.owner || [sourcePre,sourcePost].some(b=>b.mint!==MINT || b.programId!==TOKEN_PROGRAM || b.uiTokenAmount.decimals!==6) ||
      readBalance(sourcePre)-readBalance(sourcePost)!==amount) return invalid('BALANCE_MISMATCH','The source debit is inconsistent with the incoming transfer.','balance');
  return { outcome:'payment',payment:{
    signature,mode:order.mode,recipient:order.recipient,mint:MINT,amount_units:amount.toString(),slot,chain_time,verified_at:now,
    provenance:order.mode==='demo'?'demo':'rpc',source_owner:sourcePre.owner,source_account:keys[indices[0]],
    destination_account:keys[destinationIndex],instruction_index,bound_order_id:bound?order.id:null,
    suggested_invoice_id:order.invoice_number?order.id:null
  },evidence:evidence(amount===BigInt(order.amount_units)?'exact':'amount') };
}

// Retained pure helper for legacy booth consumers and historical tests.
export function verifyTransfer(order, signature, response) {
  const result=verifyPayment(order,signature,response,{requireReference:true});
  return result.evidence ?? null;
}

export class RpcUnavailable extends Error {}
export class UnsupportedTransaction extends Error {}

export function createDevnetRpc(url = DEVNET_RPC, transport = fetch) {
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'https:') throw new Error('SOLANA_RPC_URL must use HTTPS.');
  let clusterCheck;
  let sequence = 0;

  async function call(method, params = [], signal = AbortSignal.timeout(5_000)) {
    const id = ++sequence;
    try {
      const response = await transport(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal, redirect: 'error'
      });
      if (!response.ok) throw new Error('HTTP response error');
      const payload = await response.json();
      // Agave's documented -32015 distinguishes unsupported versions from transport outages.
      // https://github.com/anza-xyz/agave/blob/master/rpc-client-api/src/custom_error.rs
      if(payload.id===id && method==='getTransaction' && payload.error?.code===-32015) {
        throw new UnsupportedTransaction('This transaction version is unsupported. Only legacy and v0 payments can be verified.');
      }
      if (payload.id !== id || payload.error || !Object.hasOwn(payload, 'result')) {
        throw new Error('JSON-RPC response error');
      }
      return payload.result;
    } catch(error) {
      if(error instanceof UnsupportedTransaction)throw error;
      throw new RpcUnavailable('Solana Devnet is unavailable. Your orders and receipts are saved. Try again shortly.');
    }
  }

  async function ready(signal) {
    clusterCheck ??= call('getGenesisHash', [], signal).then(hash => {
      // The Solana CAIP-2 identifier is the first 32 characters of the genesis hash.
      if (!isAddress(hash) || hash.slice(0, 32) !== DEVNET_CHAIN_ID) {
        throw new RpcUnavailable('The configured RPC does not report the Solana Devnet chain.');
      }
    }).catch(error => {
      clusterCheck = undefined;
      throw error;
    });
    return clusterCheck;
  }

  return {
    ready,
    async signatures(reference, signal, { before, limit = 50 } = {}) {
      await ready(signal);
      const signatures = await call('getSignaturesForAddress', [
        reference, { commitment: 'finalized', limit, ...(before ? { before } : {}) }
      ], signal);
      if (!Array.isArray(signatures)) throw new RpcUnavailable('The Devnet RPC returned an invalid history response.');
      return signatures;
    },
    async transaction(signature, signal) {
      await ready(signal);
      return call('getTransaction', [
        signature, { encoding: 'json', commitment: 'finalized', maxSupportedTransactionVersion: 0 }
      ], signal);
    },
    async slot() {
      await ready();
      return call('getSlot', [{ commitment: 'finalized' }]);
    },
    async latestBlockhash() {
      await ready();
      const { value } = await call('getLatestBlockhash', [{ commitment: 'confirmed' }]);
      if (!isAddress(value?.blockhash) || !Number.isSafeInteger(value.lastValidBlockHeight)) {
        throw new RpcUnavailable('Devnet did not provide a valid recent blockhash.');
      }
      return value;
    },
    async simulateUnsigned({ message, transaction }) {
      await ready();
      const [fee, simulation] = await Promise.all([
        call('getFeeForMessage', [message.toString('base64'), { commitment: 'confirmed' }]),
        call('simulateTransaction', [transaction.toString('base64'), {
          commitment: 'confirmed', encoding: 'base64', sigVerify: false, replaceRecentBlockhash: false
        }])
      ]);
      if (!Number.isSafeInteger(fee?.value) || fee.value < 0 || !Number.isSafeInteger(simulation?.context?.slot) ||
          !simulation?.value || !Object.hasOwn(simulation.value, 'err')) {
        throw new RpcUnavailable('Devnet did not provide a current fee and simulation result.');
      }
      return { fee_lamports: fee.value, simulation_slot: simulation.context.slot, error: simulation.value.err };
    },
    async mint() {
      await ready();
      const account = await call('getAccountInfo', [MINT, { encoding: 'jsonParsed', commitment: 'finalized' }]);
      const value = account?.value;
      if (value?.owner !== TOKEN_PROGRAM || value.data?.parsed?.type !== 'mint' ||
          value.data.parsed.info?.decimals !== 6) {
        throw new RpcUnavailable('The Devnet USDC mint could not be verified.');
      }
      return {address:MINT,program_id:TOKEN_PROGRAM,decimals:6};
    },
    async walletBalances(owner) {
      if(!isAddress(owner))throw new Error('Use a public Solana wallet address.');
      await ready();
      const [balance,accounts,account]=await Promise.all([
        call('getBalance',[owner,{commitment:'finalized'}]),
        call('getTokenAccountsByOwner',[owner,{mint:MINT},{encoding:'jsonParsed',commitment:'finalized'}]),
        call('getAccountInfo',[owner,{encoding:'base64',commitment:'finalized'}])
      ]);
      if(!Number.isSafeInteger(balance?.value)||balance.value<0||!Array.isArray(accounts?.value)||!account||!Object.hasOwn(account,'value')||
        (account.value!==null&&(!isAddress(account.value?.owner)||typeof account.value?.executable!=='boolean')))throw new RpcUnavailable('Wallet balance metadata is incomplete.');
      const known=new Set();let total=0n,spendable=0n;
      const token_accounts=accounts.value.map(entry=>{
        const info=entry?.account?.data?.parsed?.info,amount=readBalance({uiTokenAmount:info?.tokenAmount});
        if(!isAddress(entry?.pubkey)||known.has(entry.pubkey)||entry.account?.owner!==TOKEN_PROGRAM||entry.account?.data?.parsed?.type!=='account'||
            info?.owner!==owner||info?.mint!==MINT||info?.tokenAmount?.decimals!==6||amount===null||!['initialized','frozen'].includes(info.state)) {
          throw new RpcUnavailable('Wallet token ownership, mint, state or exact balance could not be verified.');
        }
        known.add(entry.pubkey);total+=amount;if(info.state==='initialized')spendable+=amount;
        return {address:entry.pubkey,owner,mint:MINT,amount_units:amount.toString(),state:info.state};
      });
      return {address:owner,sol_lamports:String(balance.value),usdc_units:total.toString(),spendable_usdc_units:spendable.toString(),
        account_program:account.value?.owner??null,account_executable:account.value?.executable??null,token_accounts};
    },
    async tokenAccountRent() {
      await ready();
      // Standard SPL Token accounts are 165 bytes; Token-2022 is outside this application.
      const value=await call('getMinimumBalanceForRentExemption',[165,{commitment:'finalized'}]);
      if(!Number.isSafeInteger(value)||value<0)throw new RpcUnavailable('Token-account rent could not be verified.');
      return String(value);
    }
  };
}
