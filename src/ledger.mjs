import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";

export const SCALE = 1_000_000;
export const DEFAULT_FEE = 1_000;
export const MAX_MEMO_LENGTH = 96;
export const MAX_MEMPOOL_SIZE = 10_000;
export const MEMPOOL_TTL_MS = 10 * 60_000;
export const MAX_SUPPLY = 20_000_000 * SCALE;
export const TREASURY_PUBLIC_KEY = { crv:"Ed25519", x:"afQ_bAa2GCtWQhaUtbVw2ZK6T6DFCAjBoZpsYLp7K9E", kty:"OKP" };
export const TREASURY_ADDRESS = "ec115b2a5fc28d679f47450d4ea9c3cb8e118a31d";
export const MAX_BLOCK_TRANSACTIONS = 2_000;
export const MAX_SENDER_TRANSACTIONS_PER_BLOCK = 64;
export const BASE_MARKET_PRICE_MICRO_USD = 250_000;
export const MAX_MARKET_BUY_USD_CENTS = 100_000;
export const MAX_MARKET_ORDER_EC = 10_000 * SCALE;
export const MAX_ACTIVE_CONTRACTS_PER_CREATOR = 100;
export const MAX_CONTRACT_EXECUTIONS_PER_BLOCK = 500;
export const MAX_PENDING_PER_SENDER = 256;
export const MAX_BATCH_TRANSFERS = 32;

function marketPriceMicroUsd(volumeUsdCents) {
  return BASE_MARKET_PRICE_MICRO_USD + Math.floor(volumeUsdCents / 10_000) * 1_000;
}

function marketSideLabel(side) {
  return side === "sell" ? "sell" : "buy";
}

function orderStatusLabel(status) {
  return status === "canceled" ? "canceled" : status === "filled" ? "filled" : status === "partial" ? "partial" : "open";
}

export function canonicalTransaction(tx) {
  return JSON.stringify({
    from: tx.from,
    to: tx.to,
    amount: tx.amount,
    fee: tx.fee,
    nonce: tx.nonce,
    memo: tx.memo ?? "",
    timestamp: tx.timestamp,
    publicKey: tx.publicKey,
  });
}

export function canonicalContractDeployment(tx) {
  return JSON.stringify({
    contractType:tx.contractType,
    from:tx.from,
    beneficiary:tx.beneficiary,
    amount:tx.amount,
    fee:tx.fee,
    nonce:tx.nonce,
    unlockTime:tx.unlockTime,
    installments:tx.installments??1,
    intervalMs:tx.intervalMs??0,
    secretHash:tx.secretHash??"",
    refundTime:tx.refundTime??0,
    memo:tx.memo??"",
    timestamp:tx.timestamp,
    publicKey:tx.publicKey,
  });
}

export function canonicalContractApproval(tx) {
  return JSON.stringify({
    contractAddress: tx.contractAddress,
    from: tx.from,
    milestone: tx.milestone,
    fee: tx.fee,
    nonce: tx.nonce,
    timestamp: tx.timestamp,
    publicKey: tx.publicKey,
  });
}

export function canonicalMarketOrder(order) {
  return JSON.stringify({
    address: order.address,
    side: order.side,
    amount: order.amount,
    limitPriceMicroUsd: order.limitPriceMicroUsd,
    orderId: order.orderId,
    timestamp: order.timestamp,
    publicKey: order.publicKey,
  });
}

export function canonicalMarketCancel(order) {
  return JSON.stringify({
    address: order.address,
    orderId: order.orderId,
    timestamp: order.timestamp,
    publicKey: order.publicKey,
  });
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function addressFromPublicJwk(jwk) {
  if (!jwk || jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.x) {
    throw new Error("Public key must be an Ed25519 JWK");
  }
  return `ec1${sha256(Buffer.from(jwk.x, "base64url")).slice(0, 38)}`;
}

function stateRoot(accounts) {
  const snapshot = [...accounts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([address, account]) => [address, account.balance, account.nonce]);
  return sha256(JSON.stringify(snapshot));
}

function contractRoot(contracts) {
  const snapshot=[...contracts.values()].sort((a,b)=>a.address.localeCompare(b.address)).map((contract)=>[contract.address,contract.contractType,contract.creator,contract.beneficiary,contract.amount,contract.unlockTime,contract.installments??1,contract.intervalMs??0,contract.secretHash??"",contract.refundTime??0,contract.releasedInstallments??0,contract.releasedAmount??0,contract.status,contract.releasedAt??null,contract.approvalRound??0,contract.creatorApprovedRound??0,contract.beneficiaryApprovedRound??0]);
  return sha256(JSON.stringify(snapshot));
}

function transactionId(tx) {
  const payload=tx.type==="contract_deploy" || tx.contractType ? canonicalContractDeployment(tx) : tx.type==="contract_approve" ? canonicalContractApproval(tx) : canonicalTransaction(tx);
  return sha256(`${payload}:${tx.signature}`);
}

function shortAddress(address) {
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}

function transactionMatches(tx, needle) {
  const haystack = [
    tx.id,
    tx.type,
    tx.from,
    tx.to,
    tx.memo,
    tx.contractAddress,
    tx.purchaseId,
    tx.secretHash,
    tx.usdCents,
    tx.amount,
    tx.fee,
  ].filter((value) => value != null).map((value) => String(value).toLowerCase());
  return haystack.some((value) => value.includes(needle));
}

function txDetail(tx, block) {
  const parts = [];
  if (tx.from) parts.push(`from ${shortAddress(tx.from)}`);
  if (tx.to) parts.push(`to ${shortAddress(tx.to)}`);
  if (tx.amount != null) parts.push(`amount ${tx.amount}`);
  if (tx.contractAddress) parts.push(`contract ${shortAddress(tx.contractAddress)}`);
  parts.push(`block #${block.height}`);
  return parts.join(" · ");
}

export class Ledger {
  constructor(snapshot) {
    this.accounts = new Map();
    this.blocks = [];
    this.pending = [];
    this.contracts = new Map();
    this.totalSupply = 0;
    this.feesRecycled = 0;
    this.marketVolumeUsdCents = 0;
    this.marketPurchases = 0;
    this.marketOrders = [];
    this.marketTrades = [];
    this.marketOrderSequence = 0;
    this.marketLockedEc = new Map();
    this.marketPositionEc = new Map();
    this.blockByHash = new Map();
    this.transactionIndex = new Map();
    this.activityByAddress = new Map();
    this.faucetClaims = new Set();
    this.pendingIds = new Set();
    this.pendingBySender = new Map();
    this.pendingByRecipient = new Map();
    this.confirmedTransactionCount = 0;
    this.transferCount = 0;
    this.integrityCache = true;

    if (snapshot) {
      for (const [address, account] of Object.entries(snapshot.accounts ?? {})) {
        this.accounts.set(address, { balance: account.balance, nonce: account.nonce });
      }
      this.blocks = snapshot.blocks ?? [];
      this.pending = snapshot.pending ?? [];
      for (const [address,contract] of Object.entries(snapshot.contracts??{})) this.contracts.set(address,contract);
      this.totalSupply = snapshot.totalSupply ?? 0;
      this.feesRecycled = snapshot.feesRecycled ?? 0;
      this.marketVolumeUsdCents = snapshot.marketVolumeUsdCents ?? 0;
      this.marketPurchases = snapshot.marketPurchases ?? 0;
      this.marketOrders = snapshot.marketOrders ?? [];
      this.marketTrades = snapshot.marketTrades ?? [];
      this.marketOrderSequence = snapshot.marketOrderSequence ?? this.marketOrders.length;
      this.marketLockedEc = new Map(Object.entries(snapshot.marketLockedEc ?? {}).map(([address, value]) => [address, Number(value) || 0]));
      this.marketPositionEc = new Map(Object.entries(snapshot.marketPositionEc ?? {}).map(([address, value]) => [address, Number(value) || 0]));
      this.#rebuildIndexes();
    } else {
      this.accounts.set(TREASURY_ADDRESS,{balance:MAX_SUPPLY,nonce:0});
      this.totalSupply=MAX_SUPPLY;
      this.#sealBlock([{ id:sha256(`genesis:${TREASURY_ADDRESS}:${MAX_SUPPLY}`), type:"genesis", network:"E-Coin Aurora Devnet", to:TREASURY_ADDRESS, amount:MAX_SUPPLY, maxSupply:MAX_SUPPLY }]);
    }
    this.integrityCache = this.verifyIntegrity();
  }

  getAccount(address) {
    return this.accounts.get(address) ?? { balance: 0, nonce: 0 };
  }

  getMarketLocked(address) {
    return this.marketLockedEc.get(address) ?? 0;
  }

  getMarketPosition(address) {
    return this.marketPositionEc.get(address) ?? 0;
  }

  get status() {
    const mempoolValid=this.verifyPending();
    return {
      network: "E-Coin Aurora Devnet",
      protocolVersion: 8,
      consensus: "single-node-devnet",
      height: this.blocks.length - 1,
      accounts: this.accounts.size,
      totalSupply: this.totalSupply,
      maxSupply:MAX_SUPPLY,
      treasuryAddress:TREASURY_ADDRESS,
      burned:0,
      feesRecycled:this.feesRecycled,
      latestBlock: this.blocks.at(-1)?.hash,
      chainValid: this.integrityCache && mempoolValid,
      mempoolSize: this.pending.length,
      mempoolValid,
      metrics: this.getMetrics(),
      maxMempoolSize:MAX_MEMPOOL_SIZE,
      maxBlockTransactions:MAX_BLOCK_TRANSACTIONS,
      maxSenderTransactionsPerBlock:MAX_SENDER_TRANSACTIONS_PER_BLOCK,
      maxPendingPerSender:MAX_PENDING_PER_SENDER,
      mempoolTtlMs:MEMPOOL_TTL_MS,
      contracts:this.contracts.size,
      lockedValue:[...this.contracts.values()].filter((contract)=>["locked","vesting","milestone"].includes(contract.status)).reduce((sum,contract)=>sum+contract.amount-(contract.releasedAmount??0),0),
      market:this.getMarket(),
    };
  }

  verifyIntegrity() {
    try {
      const replay = new Map();
      const replayContracts = new Map();
      const faucetClaims = new Set();
      let supply = 0;
      let feesRecycled = 0;
      let marketVolumeUsdCents=0;
      let marketPurchases=0;

      for (const [index, block] of this.blocks.entries()) {
        const { hash, ...body } = block;
        const expectedPrevious = index === 0 ? "0".repeat(64) : this.blocks[index - 1].hash;
        if (block.height !== index || block.previousHash !== expectedPrevious || hash !== sha256(JSON.stringify(body))) return false;

        for (const tx of block.transactions) {
          if (tx.type === "genesis") {
            if (index !== 0 || block.transactions.length !== 1 || tx.to!==TREASURY_ADDRESS || tx.amount!==MAX_SUPPLY || tx.maxSupply!==MAX_SUPPLY) return false;
            replay.set(TREASURY_ADDRESS,{balance:MAX_SUPPLY,nonce:0});
            supply=MAX_SUPPLY;
          } else if (tx.type === "faucet") {
            assertAddress(tx.to);
            assertInteger(tx.amount, "amount");
            if (tx.amount <= 0 || faucetClaims.has(tx.to)) return false;
            const treasury=replay.get(TREASURY_ADDRESS);
            if (!treasury || treasury.balance<tx.amount || tx.from!==TREASURY_ADDRESS) return false;
            const account = replay.get(tx.to) ?? { balance:0, nonce:0 };
            replay.set(TREASURY_ADDRESS,{...treasury,balance:treasury.balance-tx.amount});
            replay.set(tx.to, { ...account, balance:account.balance + tx.amount });
            faucetClaims.add(tx.to);
          } else if (tx.type === "market_buy") {
            assertAddress(tx.to); assertInteger(tx.amount,"amount"); assertInteger(tx.usdCents,"usdCents"); assertInteger(tx.priceMicroUsd,"priceMicroUsd");
            const price=marketPriceMicroUsd(marketVolumeUsdCents);
            const expectedAmount=Math.floor(tx.usdCents*10_000*SCALE/price);
            const treasury=replay.get(TREASURY_ADDRESS);
            if (tx.from!==TREASURY_ADDRESS || tx.to===TREASURY_ADDRESS || tx.usdCents<100 || tx.usdCents>MAX_MARKET_BUY_USD_CENTS || tx.priceMicroUsd!==price || tx.amount!==expectedAmount || tx.id!==sha256(`market:${tx.purchaseId}`) || !/^[A-Za-z0-9-]{8,64}$/.test(tx.purchaseId??"") || !treasury || treasury.balance<tx.amount) return false;
            const recipient=replay.get(tx.to)??{balance:0,nonce:0};
            replay.set(TREASURY_ADDRESS,{...treasury,balance:treasury.balance-tx.amount});
            replay.set(tx.to,{...recipient,balance:recipient.balance+tx.amount});
            marketVolumeUsdCents+=tx.usdCents; marketPurchases++;
          } else if (tx.type === "transfer") {
            assertAddress(tx.from); assertAddress(tx.to);
            assertInteger(tx.amount, "amount"); assertInteger(tx.fee, "fee"); assertInteger(tx.nonce, "nonce");
            if (tx.amount <= 0 || tx.fee < DEFAULT_FEE || addressFromPublicJwk(tx.publicKey) !== tx.from) return false;
            const sender = replay.get(tx.from) ?? { balance:0, nonce:0 };
            if (tx.nonce !== sender.nonce + 1 || sender.balance < tx.amount + tx.fee) return false;
            const key = createPublicKey({ key:tx.publicKey, format:"jwk" });
            if (!verifySignature(null, Buffer.from(canonicalTransaction(tx)), key, Buffer.from(tx.signature, "base64url"))) return false;
            if (tx.id !== transactionId(tx)) return false;
            const recipient = replay.get(tx.to) ?? { balance:0, nonce:0 };
            replay.set(tx.from, { balance:sender.balance - tx.amount - tx.fee, nonce:tx.nonce });
            replay.set(tx.to, { ...recipient, balance:recipient.balance + tx.amount });
            const treasury=replay.get(TREASURY_ADDRESS)??{balance:0,nonce:0};
            replay.set(TREASURY_ADDRESS,{...treasury,balance:treasury.balance+tx.fee});
            feesRecycled += tx.fee;
          } else if (tx.type === "contract_deploy") {
            assertAddress(tx.from); assertAddress(tx.beneficiary);
            assertInteger(tx.amount,"amount"); assertInteger(tx.fee,"fee"); assertInteger(tx.nonce,"nonce"); assertInteger(tx.unlockTime,"unlockTime");
            if (!["timelock","vesting","milestone","hashlock"].includes(tx.contractType) || tx.amount<=0 || tx.fee<DEFAULT_FEE || tx.contractAddress!==`ect${tx.id.slice(0,38)}` || replayContracts.has(tx.contractAddress)) return false;
            if (!validContractSchedule(tx,tx.timestamp)) return false;
            if (addressFromPublicJwk(tx.publicKey)!==tx.from || tx.id!==transactionId(tx)) return false;
            const key=createPublicKey({key:tx.publicKey,format:"jwk"});
            if (!verifySignature(null,Buffer.from(canonicalContractDeployment(tx)),key,Buffer.from(tx.signature,"base64url"))) return false;
            const sender=replay.get(tx.from)??{balance:0,nonce:0};
            if (tx.nonce!==sender.nonce+1 || sender.balance<tx.amount+tx.fee) return false;
            replay.set(tx.from,{balance:sender.balance-tx.amount-tx.fee,nonce:tx.nonce});
            replayContracts.set(tx.contractAddress,contractFromDeployment(tx,block.timestamp,block.height));
            const treasury=replay.get(TREASURY_ADDRESS)??{balance:0,nonce:0};
            replay.set(TREASURY_ADDRESS,{...treasury,balance:treasury.balance+tx.fee});
            feesRecycled+=tx.fee;
          } else if (tx.type === "contract_approve") {
            const contract=replayContracts.get(tx.contractAddress);
            if (!contract || contract.contractType!=="milestone" || contract.status!=="locked") return false;
            assertAddress(tx.from); assertInteger(tx.fee,"fee"); assertInteger(tx.nonce,"nonce"); assertInteger(tx.milestone,"milestone");
            if (tx.fee<DEFAULT_FEE || tx.milestone!==contract.approvalRound || ![contract.creator, contract.beneficiary].includes(tx.from)) return false;
            if (tx.id!==transactionId(tx)) return false;
            if (addressFromPublicJwk(tx.publicKey)!==tx.from) return false;
            const key=createPublicKey({key:tx.publicKey,format:"jwk"});
            if (!verifySignature(null,Buffer.from(canonicalContractApproval(tx)),key,Buffer.from(tx.signature,"base64url"))) return false;
            const sender=replay.get(tx.from)??{balance:0,nonce:0};
            if (tx.nonce!==sender.nonce+1 || sender.balance<tx.fee) return false;
            replay.set(tx.from,{balance:sender.balance-tx.fee,nonce:tx.nonce});
            const treasury=replay.get(TREASURY_ADDRESS)??{balance:0,nonce:0};
            replay.set(TREASURY_ADDRESS,{...treasury,balance:treasury.balance+tx.fee});
            feesRecycled+=tx.fee;
            replayContracts.set(tx.contractAddress,applyContractApproval(contract,tx.from,tx.milestone,block.timestamp,block.height));
          } else if (tx.type === "contract_execute") {
            const contract=replayContracts.get(tx.contractAddress);
            if (!contract || !["locked","vesting","milestone"].includes(contract.status) || block.timestamp<contract.unlockTime || tx.to!==contract.beneficiary || tx.id!==sha256(`execute:${tx.contractAddress}:${block.height}:${tx.installment}`)) return false;
            const expected=nextContractRelease(contract,block.timestamp);
            if (!expected || tx.amount!==expected.amount || tx.installment!==expected.installment) return false;
            const recipient=replay.get(tx.to)??{balance:0,nonce:0};
            replay.set(tx.to,{...recipient,balance:recipient.balance+tx.amount});
            replayContracts.set(tx.contractAddress,applyContractRelease(contract,expected,block.timestamp,block.height));
          } else if (tx.type === "contract_claim") {
            const contract=replayContracts.get(tx.contractAddress);
            if (!contract || contract.contractType!=="hashlock" || contract.status!=="locked" || block.timestamp>=contract.refundTime || typeof tx.secret!=="string" || tx.secret.length>128 || sha256(tx.secret)!==contract.secretHash || tx.to!==contract.beneficiary || tx.amount!==contract.amount || tx.id!==sha256(`claim:${tx.contractAddress}:${contract.secretHash}`)) return false;
            const recipient=replay.get(tx.to)??{balance:0,nonce:0}; replay.set(tx.to,{...recipient,balance:recipient.balance+tx.amount});
            replayContracts.set(tx.contractAddress,{...contract,status:"released",releasedAmount:contract.amount,releasedAt:block.timestamp,releaseHeight:block.height});
          } else if (tx.type === "contract_refund") {
            const contract=replayContracts.get(tx.contractAddress);
            if (!contract || contract.contractType!=="hashlock" || contract.status!=="locked" || block.timestamp<contract.refundTime || tx.to!==contract.creator || tx.amount!==contract.amount || tx.id!==sha256(`refund:${tx.contractAddress}:${block.height}`)) return false;
            const recipient=replay.get(tx.to)??{balance:0,nonce:0}; replay.set(tx.to,{...recipient,balance:recipient.balance+tx.amount});
            replayContracts.set(tx.contractAddress,{...contract,status:"refunded",releasedAmount:contract.amount,releasedAt:block.timestamp,releaseHeight:block.height});
          } else return false;
        }
        if (block.stateRoot !== stateRoot(replay)) return false;
        if (block.contractRoot!==undefined && block.contractRoot!==contractRoot(replayContracts)) return false;
      }
      return stateRoot(replay) === stateRoot(this.accounts) && contractRoot(replayContracts)===contractRoot(this.contracts) && supply === this.totalSupply && feesRecycled === this.feesRecycled && marketVolumeUsdCents===this.marketVolumeUsdCents && marketPurchases===this.marketPurchases;
    } catch {
      return false;
    }
  }

  auditIntegrity() {
    this.integrityCache=this.verifyIntegrity();
    return this.integrityCache;
  }

  verifyPending() {
    try {
      const projected = new Map([...this.accounts].map(([address,account]) => [address,{...account}]));
      const projectedContracts=new Set(this.contracts.keys());
      const ids = new Set();
      for (const tx of this.pending) {
          if (!['transfer','contract_deploy','contract_approve'].includes(tx.type) || ids.has(tx.id)) return false;
          assertAddress(tx.from);
          assertInteger(tx.amount,"amount"); assertInteger(tx.fee,"fee"); assertInteger(tx.nonce,"nonce");
          if (tx.type === "contract_approve") {
            assertAddress(tx.contractAddress);
            assertInteger(tx.milestone,"milestone");
            if (tx.fee < DEFAULT_FEE || tx.amount !== 0 || addressFromPublicJwk(tx.publicKey) !== tx.from) return false;
          } else if (tx.amount <= 0 || tx.fee < DEFAULT_FEE || addressFromPublicJwk(tx.publicKey) !== tx.from) return false;
          const sender=projected.get(tx.from) ?? {balance:0,nonce:0};
          if (tx.nonce !== sender.nonce+1 || sender.balance < tx.amount+tx.fee) return false;
          const key=createPublicKey({key:tx.publicKey,format:"jwk"});
          const payload=tx.type==="contract_deploy"?canonicalContractDeployment(tx):tx.type==="contract_approve"?canonicalContractApproval(tx):canonicalTransaction(tx);
          if (!verifySignature(null,Buffer.from(payload),key,Buffer.from(tx.signature,"base64url"))) return false;
          if (tx.id !== transactionId(tx)) return false;
          projected.set(tx.from,{balance:sender.balance-tx.amount-tx.fee,nonce:tx.nonce});
          if (tx.type==="transfer") {
            assertAddress(tx.to); const recipient=projected.get(tx.to)??{balance:0,nonce:0}; projected.set(tx.to,{...recipient,balance:recipient.balance+tx.amount});
          } else {
            if (tx.type==="contract_deploy") {
              assertAddress(tx.beneficiary); assertInteger(tx.unlockTime,"unlockTime");
              if (!["timelock","vesting","milestone","hashlock"].includes(tx.contractType) || tx.contractAddress!==`ect${tx.id.slice(0,38)}` || projectedContracts.has(tx.contractAddress)) return false;
              if (!validContractSchedule(tx,tx.timestamp)) return false;
              projectedContracts.add(tx.contractAddress);
            } else if (tx.type==="contract_approve") {
              const contract=this.contracts.get(tx.contractAddress);
              if (!contract || contract.contractType!=="milestone" || ![contract.creator, contract.beneficiary].includes(tx.from)) return false;
              if (tx.milestone !== (contract.approvalRound ?? (contract.releasedInstallments ?? 0) + 1)) return false;
            }
          }
          ids.add(tx.id);
        }
      return true;
    } catch { return false; }
  }

  getInsights(address) {
    const activity = this.activityByAddress.get(address) ?? [];
    const received = activity.filter((tx) => tx.to === address).reduce((sum, tx) => sum + (tx.amount ?? 0), 0);
    const sent = activity.filter((tx) => tx.from === address).reduce((sum, tx) => sum + (tx.amount ?? 0), 0);
    const feesPaid = activity.filter((tx) => tx.from === address).reduce((sum, tx) => sum + (tx.fee ?? 0), 0);
    const counterpartyStats = new Map();
    for (const tx of activity) {
      for (const [counterparty, direction] of [[tx.from,"sent"],[tx.to,"received"]]) {
        if (!counterparty || counterparty === address) continue;
        const entry=counterpartyStats.get(counterparty) ?? { address:counterparty, count:0, received:0, sent:0, lastActive:null };
        entry.count++;
        if (direction==="received") entry.received += tx.amount ?? 0;
        if (direction==="sent") entry.sent += tx.amount ?? 0;
        entry.lastActive = tx.settledAt ?? entry.lastActive;
        counterpartyStats.set(counterparty, entry);
      }
    }
    return {
      transactionCount: activity.length,
      received,
      sent,
      feesPaid,
      counterparties: counterpartyStats.size,
      topCounterparties:[...counterpartyStats.values()].sort((a,b)=>
        b.count-a.count
        || (b.received+b.sent)-(a.received+a.sent)
        || b.lastActive-a.lastActive
        || a.address.localeCompare(b.address)
      ).slice(0,3),
      firstSeen: activity[0]?.settledAt ?? null,
      lastActive: activity.at(-1)?.settledAt ?? null,
    };
  }

  getActivity(address, limit = 50) {
    return [...(this.activityByAddress.get(address) ?? [])].slice(-Math.max(1, limit)).reverse();
  }

  getBlock(identifier) {
    const block = /^\d+$/.test(String(identifier))
      ? this.blocks[Number(identifier)]
      : this.blockByHash.get(identifier);
    if (!block) throw new Error("Block not found");
    return block;
  }

  getTransaction(id) {
    const indexed=this.transactionIndex.get(id);
    if (indexed) return { transaction:indexed.transaction, block:{height:indexed.block.height,hash:indexed.block.hash,timestamp:indexed.block.timestamp,stateRoot:indexed.block.stateRoot} };
    throw new Error("Transaction not found");
  }

  hasFaucetClaim(address) {
    return this.faucetClaims.has(address);
  }

  getAvailableAccount(address) {
    const confirmed = this.getAccount(address);
    const outgoing = this.pendingBySender.get(address) ?? [];
    const reserved = outgoing.reduce((sum, tx) => sum + tx.amount + tx.fee, 0);
    const marketLocked = this.getMarketLocked(address);
    const marketPosition = this.getMarketPosition(address);
    return {
      ...confirmed,
      availableBalance: confirmed.balance - reserved - marketLocked + marketPosition,
      nextNonce: confirmed.nonce + outgoing.length + 1,
      pendingOutgoing: outgoing.length,
      pendingIncoming: (this.pendingByRecipient.get(address) ?? []).length,
      marketLocked,
      marketPosition,
    };
  }

  getFeeQuote(blockIntervalMs=6_000) {
    const capacity=this.getBlockCapacity();
    const pendingFees=this.pending.map((tx)=>tx.fee).filter(Number.isSafeInteger).sort((a,b)=>a-b);
    const recentFees=this.blocks.slice(-20).flatMap((block)=>block.transactions.map((tx)=>tx.fee).filter(Number.isSafeInteger)).sort((a,b)=>a-b);
    const percentile=(values,ratio,fallback=DEFAULT_FEE)=>values.length?values[Math.min(values.length-1,Math.max(0,Math.floor((values.length-1)*ratio)))]:fallback;
    const combined=[...pendingFees,...recentFees].sort((a,b)=>a-b);
    const p25=percentile(combined,.25);
    const p50=percentile(combined,.5);
    const p75=percentile(combined,.75);
    const economy=Math.max(DEFAULT_FEE,p25);
    const standard=Math.max(DEFAULT_FEE,p50);
    const priority=Math.max(DEFAULT_FEE*2,p75,Math.ceil(standard*1.25));
    const averageBlockTimeMs=Math.max(1_000,Math.min(60_000,Math.round(Number(blockIntervalMs)||6_000)));
    const tier=(fee)=>{
      const queueAhead=this.pending.filter((tx)=>tx.fee>=fee).length;
      const estimatedBlocks=Math.max(1,Math.ceil((queueAhead+1)/capacity));
      const estimatedMs=estimatedBlocks*averageBlockTimeMs;
      return {fee,queueAhead,estimatedBlocks,estimatedMs,expiryRisk:estimatedMs>=MEMPOOL_TTL_MS*.75};
    };
    const tiers={economy:tier(economy),standard:tier(standard),priority:tier(priority)};
    const pendingMedian=percentile(pendingFees,.5,standard);
    const recentMedian=percentile(recentFees,.5,standard);
    const trend=pendingFees.length&&recentFees.length?(pendingMedian>recentMedian*1.2?"rising":pendingMedian<recentMedian*.8?"falling":"stable"):"stable";
    const sampleSize=combined.length;
    const confidence=sampleSize>=30?"high":sampleSize>=8?"medium":"low";
    const pressure=Math.min(1,this.pending.length/Math.max(100,capacity));
    return { economy,standard,priority,pressure,estimatedBlocks:tiers.standard.estimatedBlocks,averageBlockTimeMs,capacity,percentiles:{p25,p50,p75},trend,confidence,sampleSize,tiers };
  }

  getBlockCapacity() {
    return Math.min(MAX_BLOCK_TRANSACTIONS,Math.max(250,Math.ceil(Math.max(1,this.pending.length)/250)*250));
  }

  getMetrics() {
    const produced=Math.max(0,this.blocks.length-1);
    const elapsed=Math.max(0,(this.blocks.at(-1)?.timestamp??0)-(this.blocks[0]?.timestamp??0));
    return {
      confirmedTransactions:this.confirmedTransactionCount,
      transfers:this.transferCount,
      averageTransactionsPerBlock:produced ? this.confirmedTransactionCount/produced : 0,
      averageBlockTimeMs:produced ? elapsed/produced : 0,
      lifetimeTransfersPerSecond:elapsed ? this.transferCount/(elapsed/1000) : 0,
      blockCapacity:this.getBlockCapacity(),
      marketPurchases:this.marketPurchases,
    };
  }

  getMarket() {
    const priceMicroUsd=this.getMarketPrice();
    const treasuryBalance=this.getAccount(TREASURY_ADDRESS).balance;
    const circulating=MAX_SUPPLY-treasuryBalance;
    const history=[
      ...this.blocks.flatMap((block)=>block.transactions.filter((tx)=>tx.type==="market_buy").map((tx)=>({timestamp:block.timestamp,priceMicroUsd:tx.priceMicroUsd,amount:tx.amount,usdCents:tx.usdCents,blockHeight:block.height,kind:"treasury_buy"}))),
      ...this.marketTrades.map((trade)=>({timestamp:trade.timestamp,priceMicroUsd:trade.priceMicroUsd,amount:trade.amount,usdCents:trade.usdCents,blockHeight:trade.blockHeight ?? null,kind:"order_trade"})),
    ].sort((a,b)=>a.timestamp-b.timestamp).slice(-60);
    return {
      priceMicroUsd,
      priceUsd:priceMicroUsd/1_000_000,
      marketCapUsd:priceMicroUsd/1_000_000*(MAX_SUPPLY/SCALE),
      treasuryBalance,
      circulating,
      volumeUsdCents:this.marketVolumeUsdCents + this.marketTrades.reduce((sum, trade) => sum + trade.usdCents, 0),
      purchases:this.marketPurchases,
      openOrders:this.marketOrders.filter((order)=>order.status==="open" || order.status==="partial").length,
      orderBook:this.getOrderBook(12),
      trades:this.marketTrades.slice(-30).reverse(),
      history,
      bestBid:this.getBestBid(),
      bestAsk:this.getBestAsk(),
      spreadMicroUsd:this.getSpreadMicroUsd(),
      mode:"devnet_sandbox",
    };
  }

  getBestBid() {
    return this.marketOrders.filter((order)=>order.side==="buy" && ["open","partial"].includes(order.status)).sort((a,b)=>b.limitPriceMicroUsd-a.limitPriceMicroUsd || a.sequence-b.sequence)[0] ?? null;
  }

  getBestAsk() {
    return this.marketOrders.filter((order)=>order.side==="sell" && ["open","partial"].includes(order.status)).sort((a,b)=>a.limitPriceMicroUsd-b.limitPriceMicroUsd || a.sequence-b.sequence)[0] ?? null;
  }

  getSpreadMicroUsd() {
    const bid = this.getBestBid();
    const ask = this.getBestAsk();
    if (!bid || !ask) return null;
    return Math.max(0, ask.limitPriceMicroUsd - bid.limitPriceMicroUsd);
  }

  getMarketPrice() {
    const ask = this.getBestAsk();
    const bid = this.getBestBid();
    if (ask && bid) return Math.round((ask.limitPriceMicroUsd + bid.limitPriceMicroUsd) / 2);
    if (ask) return ask.limitPriceMicroUsd;
    if (bid) return bid.limitPriceMicroUsd;
    return marketPriceMicroUsd(this.marketVolumeUsdCents);
  }

  getOrderBook(depth = 10) {
    const bids = this.#aggregateMarketOrders("buy", depth);
    const asks = this.#aggregateMarketOrders("sell", depth);
    return { bids, asks };
  }

  #aggregateMarketOrders(side, depth = 10) {
    const levels = new Map();
    for (const order of this.marketOrders) {
      if (order.side !== side || !["open", "partial"].includes(order.status)) continue;
      const level = levels.get(order.limitPriceMicroUsd) ?? { priceMicroUsd: order.limitPriceMicroUsd, amount: 0, orders: 0, side };
      level.amount += order.remaining;
      level.orders++;
      levels.set(order.limitPriceMicroUsd, level);
    }
    return [...levels.values()].sort((a, b) => side === "buy" ? b.priceMicroUsd - a.priceMicroUsd : a.priceMicroUsd - b.priceMicroUsd).slice(0, depth);
  }

  listMarketOrders(address) {
    return this.marketOrders.filter((order) => !address || order.address === address).sort((a,b)=>b.sequence-a.sequence);
  }

  listMarketTrades(limit = 30) {
    return this.marketTrades.slice(-limit).reverse();
  }

  placeMarketOrder(address, side, amount, limitPriceMicroUsd, orderId, signed = {}) {
    assertAddress(address);
    const normalizedSide = marketSideLabel(side);
    assertInteger(amount, "amount");
    assertInteger(limitPriceMicroUsd, "limitPriceMicroUsd");
    if (amount <= 0 || amount > MAX_MARKET_ORDER_EC) throw new Error("Order size is out of range");
    if (limitPriceMicroUsd <= 0) throw new Error("Limit price must be greater than zero");
    if (typeof orderId !== "string" || !/^[A-Za-z0-9-]{8,64}$/.test(orderId)) throw new Error("A valid order id is required");
    const id = sha256(`order:${orderId}`);
    const existing = this.marketOrders.find((order) => order.id === id);
    if (existing) return { order: existing, duplicate: true, book: this.getOrderBook(), trades: this.listMarketTrades() };

    const available = this.getAvailableAccount(address).availableBalance;
    if (normalizedSide === "sell" && available < amount) throw new Error("Insufficient available balance for this sell order");
    assertInteger(signed.timestamp, "timestamp");
    const payload = { address, side: normalizedSide, amount, limitPriceMicroUsd, orderId, timestamp: signed.timestamp, publicKey: signed.publicKey };
    if (typeof signed.signature !== "string") throw new Error("A signed market order is required");
    if (addressFromPublicJwk(signed.publicKey) !== address) throw new Error("Public key does not match order address");
    const key = createPublicKey({ key: signed.publicKey, format: "jwk" });
    if (!verifySignature(null, Buffer.from(canonicalMarketOrder({ ...payload, orderId })), key, Buffer.from(signed.signature, "base64url"))) throw new Error("Invalid market order signature");

    const order = {
      id,
      orderId,
      sequence: ++this.marketOrderSequence,
      address,
      side: normalizedSide,
      amount,
      remaining: amount,
      limitPriceMicroUsd,
      createdAt: signed.timestamp,
      status: "open",
    };
    this.marketOrders.push(order);
    if (normalizedSide === "sell") this.marketLockedEc.set(address, this.getMarketLocked(address) + amount);
    const fills = this.#matchMarketOrder(order);
    const response = { order, fills, duplicate: false, book: this.getOrderBook(), trades: this.listMarketTrades() };
    return response;
  }

  cancelMarketOrder(orderId, address, signed = {}) {
    const id = sha256(`order:${orderId}`);
    const order = this.marketOrders.find((candidate) => candidate.id === id);
    if (!order) throw new Error("Order not found");
    if (order.address !== address) throw new Error("You can only cancel your own order");
    if (!["open", "partial"].includes(order.status)) return { order, canceled: false, book: this.getOrderBook(), trades: this.listMarketTrades() };
    assertInteger(signed.timestamp, "timestamp");
    if (typeof signed.signature !== "string") throw new Error("A signed market cancel is required");
    if (addressFromPublicJwk(signed.publicKey) !== address) throw new Error("Public key does not match order address");
    const key = createPublicKey({ key: signed.publicKey, format: "jwk" });
    if (!verifySignature(null, Buffer.from(canonicalMarketCancel({ address, orderId, timestamp: signed.timestamp, publicKey: signed.publicKey })), key, Buffer.from(signed.signature, "base64url"))) throw new Error("Invalid market cancel signature");
    if (order.side === "sell") this.marketLockedEc.set(address, Math.max(0, this.getMarketLocked(address) - order.remaining));
    order.status = "canceled";
    order.canceledAt = Date.now();
    order.remaining = 0;
    return { order, canceled: true, book: this.getOrderBook(), trades: this.listMarketTrades() };
  }

  #adjustMarketPosition(address, delta) {
    const next = this.getMarketPosition(address) + delta;
    if (next === 0) this.marketPositionEc.delete(address);
    else this.marketPositionEc.set(address, next);
  }

  #matchMarketOrder(order) {
    const fills = [];
    const isBuy = order.side === "buy";
    const candidates = this.marketOrders
      .filter((candidate) => candidate.id !== order.id && candidate.side !== order.side && ["open", "partial"].includes(candidate.status))
      .sort((a, b) => isBuy ? a.limitPriceMicroUsd - b.limitPriceMicroUsd || a.sequence - b.sequence : b.limitPriceMicroUsd - a.limitPriceMicroUsd || a.sequence - b.sequence);
    for (const counterparty of candidates) {
      if (order.remaining <= 0) break;
      const crosses = isBuy ? counterparty.limitPriceMicroUsd <= order.limitPriceMicroUsd : counterparty.limitPriceMicroUsd >= order.limitPriceMicroUsd;
      if (!crosses) break;
      const amount = Math.min(order.remaining, counterparty.remaining);
      const tradePriceMicroUsd = counterparty.limitPriceMicroUsd;
      const usdCents = Math.floor((amount * tradePriceMicroUsd) / (SCALE * 10_000));
      const buyer = isBuy ? order : counterparty;
      const seller = isBuy ? counterparty : order;
      const trade = {
        id: sha256(`trade:${order.id}:${counterparty.id}:${this.marketTrades.length}`),
        buyOrderId: buyer.id,
        sellOrderId: seller.id,
        buyAddress: buyer.address,
        sellAddress: seller.address,
        amount,
        usdCents,
        priceMicroUsd: tradePriceMicroUsd,
        timestamp: Date.now(),
      };
      order.remaining -= amount;
      counterparty.remaining -= amount;
      if (seller.side === "sell") this.marketLockedEc.set(seller.address, Math.max(0, this.getMarketLocked(seller.address) - amount));
      this.#adjustMarketPosition(buyer.address, amount);
      this.#adjustMarketPosition(seller.address, -amount);
      counterparty.status = counterparty.remaining <= 0 ? "filled" : "partial";
      if (counterparty.status === "filled") counterparty.filledAt = trade.timestamp;
      this.marketTrades.push(trade);
      fills.push(trade);
    }
    order.status = order.remaining <= 0 ? "filled" : order.remaining < order.amount ? "partial" : "open";
    if (order.status === "filled") order.filledAt = Date.now();
    return fills;
  }

  quoteMarketBuy(usdCents) {
    assertInteger(usdCents,"usdCents");
    if (usdCents<100 || usdCents>MAX_MARKET_BUY_USD_CENTS) throw new Error("Purchase must be between $1 and $1,000");
    const priceMicroUsd=this.getMarketPrice();
    const amount=Math.floor(usdCents*10_000*SCALE/priceMicroUsd);
    if (amount<=0 || this.getAccount(TREASURY_ADDRESS).balance<amount) throw new Error("Treasury liquidity is insufficient");
    return {usdCents,amount,priceMicroUsd,priceUsd:priceMicroUsd/1_000_000,expiresAt:Date.now()+30_000,mode:"devnet_sandbox"};
  }

  quoteMarketSell(amount) {
    assertInteger(amount, "amount");
    if (amount <= 0 || amount > MAX_MARKET_ORDER_EC) throw new Error("Sell size is out of range");
    const priceMicroUsd=this.getMarketPrice();
    const usdCents=Math.floor((amount * priceMicroUsd) / (SCALE * 10_000));
    return { amount, usdCents, priceMicroUsd, priceUsd: priceMicroUsd / 1_000_000, expiresAt: Date.now() + 30_000, mode: "devnet_sandbox" };
  }

  buyFromTreasury(address,usdCents,purchaseId) {
    assertAddress(address);
    if (address===TREASURY_ADDRESS) throw new Error("Select a non-treasury wallet to buy E-Coin");
    if (typeof purchaseId!=="string" || !/^[A-Za-z0-9-]{8,64}$/.test(purchaseId)) throw new Error("A valid purchase id is required");
    const id=sha256(`market:${purchaseId}`); const existing=this.transactionIndex.get(id);
    if (existing) return {transaction:existing.transaction,block:existing.block,duplicate:true,quote:{usdCents:existing.transaction.usdCents,amount:existing.transaction.amount,priceMicroUsd:existing.transaction.priceMicroUsd,priceUsd:existing.transaction.priceMicroUsd/1_000_000,mode:"devnet_sandbox"}};
    const quote=this.quoteMarketBuy(usdCents);
    const treasury=this.getAccount(TREASURY_ADDRESS); const recipient=this.getAccount(address);
    this.accounts.set(TREASURY_ADDRESS,{...treasury,balance:treasury.balance-quote.amount});
    this.accounts.set(address,{...recipient,balance:recipient.balance+quote.amount});
    const tx={id,type:"market_buy",purchaseId,from:TREASURY_ADDRESS,to:address,amount:quote.amount,usdCents,priceMicroUsd:quote.priceMicroUsd,timestamp:Date.now()};
    this.marketVolumeUsdCents+=usdCents; this.marketPurchases++;
    return {quote,transaction:tx,block:this.#sealBlock([tx])};
  }

  getContract(address) {
    const contract=this.contracts.get(address);
    if (!contract) throw new Error("Contract not found");
    return contract;
  }

  listContracts(address) {
    return [...this.contracts.values()].filter((contract)=>!address || contract.creator===address || contract.beneficiary===address).sort((a,b)=>b.createdAt-a.createdAt);
  }

  getUpcomingEvents(address, limit = 5) {
    const events = [...this.contracts.values()]
      .filter((contract) => !address || contract.creator === address || contract.beneficiary === address)
      .map((contract) => {
        const dueAt = contract.contractType === "hashlock"
          ? contract.refundTime
          : contract.status === "vesting"
            ? (contract.nextReleaseAt ?? contract.unlockTime)
            : contract.unlockTime;
        const kind = contract.contractType === "hashlock"
          ? (contract.status === "locked" ? "Claim or refund" : "Resolved")
          : contract.status === "vesting"
            ? "Next vesting release"
            : "Timelock release";
        return {
          address: contract.address,
          contractType: contract.contractType,
          kind,
          status: contract.status,
          dueAt,
          creator: contract.creator,
          beneficiary: contract.beneficiary,
          amount: contract.amount,
          remaining: contract.amount - (contract.releasedAmount ?? 0),
          releasedInstallments: contract.releasedInstallments ?? 0,
          installments: contract.installments ?? 1,
          memo: contract.memo ?? "",
        };
      })
      .filter((event) => Number.isFinite(event.dueAt) && event.status !== "released" && event.status !== "refunded")
      .sort((a, b) => a.dueAt - b.dueAt)
      .slice(0, limit);
    return events;
  }

  search(query, limit = 20) {
    const needle = String(query ?? "").trim().toLowerCase();
    if (!needle) return { query: "", total: 0, results: [] };
    const results = [];
    const seen = new Set();
    const add = (kind, key, title, detail, meta = {}) => {
      const fingerprint = `${kind}:${key}`;
      if (seen.has(fingerprint) || results.length >= limit) return;
      seen.add(fingerprint);
      results.push({ kind, key, title, detail, ...meta });
    };
    for (const block of this.blocks) {
      const matches = String(block.height) === needle || block.hash.toLowerCase().includes(needle) || block.transactions.some((tx) => transactionMatches(tx, needle));
      if (!matches) continue;
      add("block", block.hash, `Block #${block.height}`, `${block.transactions.length} tx · ${new Date(block.timestamp).toLocaleString()}`, { height:block.height, hash:block.hash, timestamp:block.timestamp });
    }
    for (const [address, account] of this.accounts) {
      if (!address.toLowerCase().includes(needle)) continue;
      add("account", address, `Account ${shortAddress(address)}`, `${account.balance} micro-EC · nonce ${account.nonce}`, { address, balance:account.balance, nonce:account.nonce });
    }
    for (const contract of this.contracts.values()) {
      const matches = [contract.address, contract.creator, contract.beneficiary, contract.contractType, contract.status, contract.memo ?? ""].some((value) => String(value).toLowerCase().includes(needle));
      if (!matches) continue;
      const remaining = contract.amount - (contract.releasedAmount ?? 0);
      add("contract", contract.address, `${contract.contractType} contract`, `${contract.status} · ${remaining} micro-EC remaining`, {
        contractAddress: contract.address,
        creator: contract.creator,
        beneficiary: contract.beneficiary,
        status: contract.status,
        dueAt: contract.contractType === "hashlock" ? contract.refundTime : contract.nextReleaseAt ?? contract.unlockTime,
        amount: contract.amount,
        remaining,
      });
    }
    for (const block of this.blocks) {
      for (const tx of block.transactions) {
        if (!transactionMatches(tx, needle)) continue;
        add("transaction", tx.id, `${tx.type} transaction`, txDetail(tx, block), {
          id: tx.id,
          blockHeight: block.height,
          timestamp: block.timestamp,
          from: tx.from ?? null,
          to: tx.to ?? null,
          amount: tx.amount ?? null,
          contractAddress: tx.contractAddress ?? null,
          type: tx.type,
        });
      }
    }
    return { query, total: results.length, results };
  }

  fund(address, amount = 25 * SCALE) {
    assertAddress(address);
    if (address===TREASURY_ADDRESS) throw new Error("The genesis treasury already holds the supply");
    if (this.hasFaucetClaim(address)) throw new Error("This address has already claimed test E-Coin");
    assertInteger(amount, "amount");
    if (amount <= 0 || amount > 100 * SCALE) throw new Error("Faucet amount must be between 0 and 100 EC");
    const account = this.getAccount(address);
    const treasury=this.getAccount(TREASURY_ADDRESS);
    if (treasury.balance<amount) throw new Error("Treasury reserve is exhausted");
    this.accounts.set(TREASURY_ADDRESS,{...treasury,balance:treasury.balance-amount});
    this.accounts.set(address, { ...account, balance: account.balance + amount });
    const tx = {
      id: sha256(`faucet:${address}:${amount}:${Date.now()}:${this.blocks.length}`),
      type: "faucet",
      from:TREASURY_ADDRESS,
      to: address,
      amount,
      timestamp: Date.now(),
    };
    return { transaction: tx, block: this.#sealBlock([tx]) };
  }

  queue(input) {
    this.prunePending();
    const tx = normalizeTransaction(input);
    assertAddress(tx.from);
    assertAddress(tx.to);
    if (tx.from === tx.to) throw new Error("Sender and recipient must be different");
    if (addressFromPublicJwk(tx.publicKey) !== tx.from) throw new Error("Public key does not match sender address");

    const publicKey = createPublicKey({ key: tx.publicKey, format: "jwk" });
    const valid = verifySignature(null, Buffer.from(canonicalTransaction(tx)), publicKey, Buffer.from(tx.signature, "base64url"));
    if (!valid) throw new Error("Invalid transaction signature");

    tx.id = transactionId(tx);
    tx.type = "transfer";
    if (this.pendingIds.has(tx.id)) return { transaction:this.pending.find((candidate)=>candidate.id===tx.id), position:this.pending.findIndex((candidate)=>candidate.id===tx.id)+1, status:"pending", duplicate:true };
    const confirmed=this.transactionIndex.get(tx.id);
    if (confirmed) return { transaction:confirmed.transaction, block:confirmed.block, status:"confirmed", duplicate:true };

    const replacement=(this.pendingBySender.get(tx.from)??[]).find((candidate)=>candidate.nonce===tx.nonce);
    if (replacement) {
      if (tx.to!==replacement.to || tx.amount!==replacement.amount || tx.memo!==replacement.memo) throw new Error("Fee replacement must preserve recipient, amount, and memo");
      if (tx.fee<Math.ceil(replacement.fee*1.1)) throw new Error("Replacement fee must increase by at least 10%");
      const account=this.getAvailableAccount(tx.from);
      if (account.availableBalance+replacement.amount+replacement.fee<tx.amount+tx.fee) throw new Error("Insufficient available balance for fee replacement");
      const position=this.pending.indexOf(replacement);
      tx.queuedAt=Date.now(); this.pending[position]=tx; this.#rebuildPendingIndexes();
      return {transaction:tx,position:position+1,status:"pending",duplicate:false,replaced:replacement.id};
    }

    if (this.pending.length>=MAX_MEMPOOL_SIZE) throw new Error("Mempool is at capacity");
    if ((this.pendingBySender.get(tx.from)??[]).length>=MAX_PENDING_PER_SENDER) throw new Error("Sender pending-transaction limit reached");

    const account = this.getAvailableAccount(tx.from);
    if (tx.nonce !== account.nextNonce) throw new Error(`Expected nonce ${account.nextNonce}`);
    if (account.availableBalance < tx.amount + tx.fee) throw new Error("Insufficient available balance");

    tx.queuedAt = Date.now();
    this.pending.push(tx);
    this.#indexPending(tx);
    return { transaction:tx, position:this.pending.length, status:"pending", duplicate:false };
  }

  queueBatch(inputs) {
    this.prunePending();
    if (!Array.isArray(inputs) || inputs.length < 2 || inputs.length > MAX_BATCH_TRANSFERS) throw new Error(`Batch must contain 2-${MAX_BATCH_TRANSFERS} transfers`);
    const sender = inputs[0]?.from;
    if (!sender || inputs.some((input) => input?.from !== sender)) throw new Error("Every batch transfer must use the same sender");
    const before = this.pending.map((tx) => ({ ...tx }));
    try {
      const results = inputs.map((input) => this.queue(input));
      const positions = results.map((result) => result.position).filter(Number.isSafeInteger);
      return {
        results,
        queued:results.filter((result) => !result.duplicate).length,
        duplicates:results.filter((result) => result.duplicate).length,
        firstPosition:positions.length ? Math.min(...positions) : null,
        lastPosition:positions.length ? Math.max(...positions) : null,
      };
    } catch (error) {
      this.pending = before;
      this.#rebuildPendingIndexes();
      throw error;
    }
  }

  queueContract(input) {
    this.prunePending();
    const tx=normalizeContractDeployment(input);
    assertAddress(tx.from); assertAddress(tx.beneficiary);
    if (addressFromPublicJwk(tx.publicKey)!==tx.from) throw new Error("Public key does not match creator address");
    const key=createPublicKey({key:tx.publicKey,format:"jwk"});
    if (!verifySignature(null,Buffer.from(canonicalContractDeployment(tx)),key,Buffer.from(tx.signature,"base64url"))) throw new Error("Invalid contract signature");
    tx.id=transactionId(tx); tx.type="contract_deploy"; tx.contractAddress=`ect${tx.id.slice(0,38)}`; tx.to=tx.contractAddress;
    if (this.pendingIds.has(tx.id)) return {transaction:this.pending.find((candidate)=>candidate.id===tx.id),position:this.pending.findIndex((candidate)=>candidate.id===tx.id)+1,status:"pending",duplicate:true};
    const confirmed=this.transactionIndex.get(tx.id);
    if (confirmed) return {transaction:confirmed.transaction,block:confirmed.block,status:"confirmed",duplicate:true};
    if (this.contracts.has(tx.contractAddress)) throw new Error("Contract already exists");
    const activeContracts=[...this.contracts.values()].filter((contract)=>contract.creator===tx.from&&["locked","vesting","milestone"].includes(contract.status)).length+this.pending.filter((pending)=>pending.type==="contract_deploy"&&pending.from===tx.from).length;
    if (activeContracts>=MAX_ACTIVE_CONTRACTS_PER_CREATOR) throw new Error("Active contract limit reached for this creator");
    if (this.pending.length>=MAX_MEMPOOL_SIZE) throw new Error("Mempool is at capacity");
    if ((this.pendingBySender.get(tx.from)??[]).length>=MAX_PENDING_PER_SENDER) throw new Error("Sender pending-transaction limit reached");
    const account=this.getAvailableAccount(tx.from);
    if (tx.nonce!==account.nextNonce) throw new Error(`Expected nonce ${account.nextNonce}`);
    if (account.availableBalance<tx.amount+tx.fee) throw new Error("Insufficient available balance");
    tx.queuedAt=Date.now(); this.pending.push(tx); this.#indexPending(tx);
    return {transaction:tx,position:this.pending.length,status:"pending",duplicate:false};
  }

  prunePending(now=Date.now()) {
    const removed=this.pending.filter((tx)=>now-(tx.queuedAt??tx.timestamp)>MEMPOOL_TTL_MS);
    if (removed.length) { const ids=new Set(removed.map((tx)=>tx.id)); this.pending=this.pending.filter((tx)=>!ids.has(tx.id)); this.#rebuildPendingIndexes(); }
    return removed;
  }

  produceBlock(limit) {
    this.prunePending();
    if (!this.pending.length) return null;
    if (!this.verifyPending()) throw new Error("Mempool integrity check failed");
    const blockLimit=Math.min(MAX_BLOCK_TRANSACTIONS,Math.max(1,limit??this.getBlockCapacity()));
    const groups=new Map([...this.pendingBySender].map(([address,items])=>[address,[...items]]));
    const transactions=[];
    const senderSelections=new Map();
    while (transactions.length<blockLimit && groups.size) {
      const eligible=[...groups.values()].map((items)=>items[0]).filter((tx)=>(senderSelections.get(tx.from)??0)<MAX_SENDER_TRANSACTIONS_PER_BLOCK).sort((a,b)=>b.fee-a.fee || a.queuedAt-b.queuedAt);
      if (!eligible.length) break;
      const selected=eligible[0]; transactions.push(selected);
      senderSelections.set(selected.from,(senderSelections.get(selected.from)??0)+1);
      const senderQueue=groups.get(selected.from); senderQueue.shift(); if (!senderQueue.length) groups.delete(selected.from);
    }
    const selectedIds=new Set(transactions.map((tx)=>tx.id));
    this.pending=this.pending.filter((tx)=>!selectedIds.has(tx.id));
    this.#rebuildPendingIndexes();
    for (const tx of transactions) this.#applyTransaction(tx);
    return this.#sealBlock(transactions);
  }

  executeMatureContracts(now=Date.now()) {
    const mature=[...this.contracts.values()].filter((contract)=>contract.status==="locked"&&contract.contractType==="hashlock"?now>=contract.refundTime:["locked","vesting","milestone"].includes(contract.status)&&nextContractRelease(contract,now)).sort((a,b)=>(a.contractType==="hashlock"?a.refundTime:a.nextReleaseAt??a.unlockTime)-(b.contractType==="hashlock"?b.refundTime:b.nextReleaseAt??b.unlockTime)).slice(0,MAX_CONTRACT_EXECUTIONS_PER_BLOCK);
    if (!mature.length) return null;
    const height=this.blocks.length;
    const transactions=[];
    for (const contract of mature) {
      if (contract.contractType==="hashlock") {
        const recipient=this.getAccount(contract.creator); this.accounts.set(contract.creator,{...recipient,balance:recipient.balance+contract.amount});
        this.contracts.set(contract.address,{...contract,status:"refunded",releasedAmount:contract.amount,releasedAt:now,releaseHeight:height});
        transactions.push({id:sha256(`refund:${contract.address}:${height}`),type:"contract_refund",contractAddress:contract.address,to:contract.creator,amount:contract.amount,timestamp:now});
        continue;
      }
      const release=nextContractRelease(contract,now);
      const recipient=this.getAccount(contract.beneficiary);
      this.accounts.set(contract.beneficiary,{...recipient,balance:recipient.balance+release.amount});
      this.contracts.set(contract.address,applyContractRelease(contract,release,now,height));
      transactions.push({id:sha256(`execute:${contract.address}:${height}:${release.installment}`),type:"contract_execute",contractAddress:contract.address,to:contract.beneficiary,amount:release.amount,installment:release.installment,timestamp:now});
    }
    return this.#sealBlock(transactions,now);
  }

  approveMilestoneContract(input) {
    const tx={contractAddress:input?.contractAddress,from:input?.from,milestone:Number(input?.milestone),fee:Number(input?.fee),nonce:Number(input?.nonce),timestamp:Number(input?.timestamp),publicKey:input?.publicKey,signature:input?.signature};
    if (typeof tx.contractAddress !== "string" || !/^ect[0-9a-f]{38}$/.test(tx.contractAddress)) throw new Error("Invalid contract address");
    assertAddress(tx.from); assertInteger(tx.milestone,"milestone"); assertInteger(tx.fee,"fee"); assertInteger(tx.nonce,"nonce"); assertInteger(tx.timestamp,"timestamp");
    if (tx.fee<DEFAULT_FEE) throw new Error(`Minimum fee is ${DEFAULT_FEE} µEC`);
    if (Math.abs(Date.now()-tx.timestamp)>5*60_000) throw new Error("Milestone approval timestamp is outside the five-minute window");
    const contract=this.getContract(tx.contractAddress);
    if (contract.contractType!=="milestone" || contract.status!=="locked") throw new Error("Milestone contract is not ready for approval");
    if (![contract.creator, contract.beneficiary].includes(tx.from)) throw new Error("Only the creator or beneficiary can approve this milestone");
    const milestone=contract.approvalRound ?? (contract.releasedInstallments ?? 0) + 1;
    if (tx.milestone!==milestone) throw new Error("Approval is for the wrong milestone");
    if (tx.id && tx.id!==sha256(`approve:${tx.contractAddress}:${tx.from}:${tx.milestone}`)) throw new Error("Approval id is invalid");
    if (!tx.publicKey || addressFromPublicJwk(tx.publicKey)!==tx.from) throw new Error("Public key does not match approver address");
    const key=createPublicKey({key:tx.publicKey,format:"jwk"});
    if (!verifySignature(null,Buffer.from(canonicalContractApproval(tx)),key,Buffer.from(tx.signature,"base64url"))) throw new Error("Invalid contract approval signature");
    const sender=this.getAccount(tx.from);
    if (tx.nonce!==sender.nonce+1 || sender.balance<tx.fee) throw new Error("Insufficient available balance");
    tx.id=sha256(`${canonicalContractApproval(tx)}:${tx.signature}`); tx.type="contract_approve"; tx.to=tx.contractAddress;
    const updatedContract = applyContractApproval(contract, tx.from, milestone, tx.timestamp, this.blocks.length);
    this.accounts.set(tx.from,{balance:sender.balance-tx.fee,nonce:tx.nonce});
    const treasury=this.getAccount(TREASURY_ADDRESS);
    this.accounts.set(TREASURY_ADDRESS,{...treasury,balance:treasury.balance+tx.fee});
    this.feesRecycled += tx.fee;
    this.contracts.set(tx.contractAddress, updatedContract);
    const block = this.#sealBlock([tx], tx.timestamp);
    return { transaction: tx, block };
  }

  claimHashlock(address,secret,now=Date.now()) {
    const contract=this.getContract(address);
    if (contract.contractType!=="hashlock" || contract.status!=="locked") throw new Error("Hashlock is not claimable");
    if (now>=contract.refundTime) throw new Error("Hashlock refund deadline has passed");
    if (typeof secret!=="string" || !secret.length || secret.length>128) throw new Error("Secret must contain 1-128 characters");
    if (sha256(secret)!==contract.secretHash) throw new Error("Secret does not match this hashlock");
    const recipient=this.getAccount(contract.beneficiary); this.accounts.set(contract.beneficiary,{...recipient,balance:recipient.balance+contract.amount});
    this.contracts.set(address,{...contract,status:"released",releasedAmount:contract.amount,releasedAt:now,releaseHeight:this.blocks.length});
    const tx={id:sha256(`claim:${address}:${contract.secretHash}`),type:"contract_claim",contractAddress:address,to:contract.beneficiary,amount:contract.amount,secret,timestamp:now};
    return {transaction:tx,block:this.#sealBlock([tx],now)};
  }

  submit(input) {
    const result = this.queue(input);
    if (result.status === "confirmed") return { transaction:result.transaction, block:result.block, duplicate:true };
    return { transaction:result.transaction, block:this.produceBlock(), duplicate:result.duplicate };
  }

  #applyTransaction(tx) {
    const account = this.getAccount(tx.from);
    this.accounts.set(tx.from, { balance: account.balance - tx.amount - tx.fee, nonce: tx.nonce });
    if (tx.type==="transfer") {
      const recipient = this.getAccount(tx.to);
      this.accounts.set(tx.to, { ...recipient, balance: recipient.balance + tx.amount });
    } else if (tx.type==="contract_deploy") {
      this.contracts.set(tx.contractAddress,contractFromDeployment(tx,Date.now(),this.blocks.length));
    } else throw new Error("Unsupported pending transaction type");
    const treasury=this.getAccount(TREASURY_ADDRESS);
    this.accounts.set(TREASURY_ADDRESS,{...treasury,balance:treasury.balance+tx.fee});
    this.feesRecycled += tx.fee;
  }

  toJSON() {
    return {
      accounts: Object.fromEntries(this.accounts),
      blocks: this.blocks,
      pending: this.pending,
      contracts:Object.fromEntries(this.contracts),
      totalSupply: this.totalSupply,
      feesRecycled:this.feesRecycled,
      marketVolumeUsdCents:this.marketVolumeUsdCents,
      marketPurchases:this.marketPurchases,
      marketOrders:this.marketOrders,
      marketTrades:this.marketTrades,
      marketOrderSequence:this.marketOrderSequence,
      marketLockedEc:Object.fromEntries(this.marketLockedEc),
      marketPositionEc:Object.fromEntries(this.marketPositionEc),
    };
  }

  #sealBlock(transactions,timestamp=Date.now()) {
    const body = {
      height: this.blocks.length,
      previousHash: this.blocks.at(-1)?.hash ?? "0".repeat(64),
      timestamp,
      transactions,
      stateRoot: stateRoot(this.accounts),
      contractRoot:contractRoot(this.contracts),
    };
    const block = { ...body, hash: sha256(JSON.stringify(body)) };
    this.blocks.push(block);
    this.#indexBlock(block);
    return block;
  }

  #indexPending(tx) {
    this.pendingIds.add(tx.id);
    if (!this.pendingBySender.has(tx.from)) this.pendingBySender.set(tx.from,[]);
    if (!this.pendingByRecipient.has(tx.to)) this.pendingByRecipient.set(tx.to,[]);
    this.pendingBySender.get(tx.from).push(tx);
    this.pendingByRecipient.get(tx.to).push(tx);
  }

  #rebuildPendingIndexes() {
    this.pendingIds.clear(); this.pendingBySender.clear(); this.pendingByRecipient.clear();
    for (const tx of this.pending) this.#indexPending(tx);
  }

  #indexBlock(block) {
    this.blockByHash.set(block.hash,block);
    for (const tx of block.transactions) {
      if (tx.type!=="genesis") this.confirmedTransactionCount++;
      if (tx.type==="transfer") this.transferCount++;
      if (tx.id) this.transactionIndex.set(tx.id,{transaction:tx,block});
      if (tx.type==="faucet") this.faucetClaims.add(tx.to);
      for (const address of new Set([tx.from,tx.to,tx.beneficiary].filter(Boolean))) {
        if (!this.activityByAddress.has(address)) this.activityByAddress.set(address,[]);
        this.activityByAddress.get(address).push({...tx,blockHeight:block.height,settledAt:block.timestamp});
      }
    }
  }

  #rebuildIndexes() {
    this.blockByHash.clear(); this.transactionIndex.clear(); this.activityByAddress.clear(); this.faucetClaims.clear();
    this.confirmedTransactionCount=0; this.transferCount=0;
    for (const block of this.blocks) this.#indexBlock(block);
    this.#rebuildPendingIndexes();
  }
}

function normalizeTransaction(input) {
  const tx = {
    from: input?.from,
    to: input?.to,
    amount: Number(input?.amount),
    fee: Number(input?.fee),
    nonce: Number(input?.nonce),
    memo: input?.memo ?? "",
    timestamp: Number(input?.timestamp),
    publicKey: input?.publicKey,
    signature: input?.signature,
  };
  assertInteger(tx.amount, "amount");
  assertInteger(tx.fee, "fee");
  assertInteger(tx.nonce, "nonce");
  assertInteger(tx.timestamp, "timestamp");
  if (tx.amount <= 0) throw new Error("Amount must be positive");
  if (tx.fee < DEFAULT_FEE) throw new Error(`Minimum fee is ${DEFAULT_FEE} µEC`);
  if (tx.nonce <= 0) throw new Error("Nonce must be positive");
  if (Math.abs(Date.now() - tx.timestamp) > 5 * 60_000) throw new Error("Transaction timestamp is outside the five-minute window");
  if (typeof tx.memo !== "string" || tx.memo.length > MAX_MEMO_LENGTH) throw new Error(`Memo cannot exceed ${MAX_MEMO_LENGTH} characters`);
  if (typeof tx.signature !== "string" || !tx.signature) throw new Error("Signature is required");
  return tx;
}

function normalizeContractDeployment(input) {
  const tx={contractType:input?.contractType??"timelock",from:input?.from,beneficiary:input?.beneficiary,amount:Number(input?.amount),fee:Number(input?.fee),nonce:Number(input?.nonce),unlockTime:Number(input?.unlockTime),installments:Number(input?.installments??1),intervalMs:Number(input?.intervalMs??0),secretHash:input?.secretHash??"",refundTime:Number(input?.refundTime??0),memo:input?.memo??"",timestamp:Number(input?.timestamp),publicKey:input?.publicKey,signature:input?.signature};
  for (const [name,value] of [["amount",tx.amount],["fee",tx.fee],["nonce",tx.nonce],["unlockTime",tx.unlockTime],["installments",tx.installments],["intervalMs",tx.intervalMs],["refundTime",tx.refundTime],["timestamp",tx.timestamp]]) assertInteger(value,name);
  if (!["timelock","vesting","milestone","hashlock"].includes(tx.contractType)) throw new Error("Unsupported contract template");
  if (tx.amount<=0) throw new Error("Contract amount must be positive");
  if (tx.fee<DEFAULT_FEE) throw new Error(`Minimum fee is ${DEFAULT_FEE} µEC`);
  if (tx.nonce<=0) throw new Error("Nonce must be positive");
  if (Math.abs(Date.now()-tx.timestamp)>5*60_000) throw new Error("Contract timestamp is outside the five-minute window");
  if (tx.contractType!=="hashlock" && (tx.unlockTime<Date.now()+5_000 || tx.unlockTime>Date.now()+365*24*60*60_000)) throw new Error("Unlock time must be between five seconds and one year from now");
  if (tx.contractType==="timelock" && (tx.installments!==1 || tx.intervalMs!==0)) throw new Error("Timelocks use one release");
  if (["vesting","milestone"].includes(tx.contractType) && (tx.installments<2 || tx.installments>52 || tx.intervalMs<60_000 || tx.intervalMs>90*24*60*60_000)) throw new Error(`${tx.contractType === "milestone" ? "Milestone" : "Vesting"} requires 2-52 installments spaced between one minute and 90 days`);
  if (["vesting","milestone"].includes(tx.contractType) && tx.unlockTime+(tx.installments-1)*tx.intervalMs>Date.now()+2*365*24*60*60_000) throw new Error(`${tx.contractType === "milestone" ? "Milestone" : "Vesting"} schedule cannot extend beyond two years`);
  if (tx.contractType==="hashlock" && (tx.installments!==1 || tx.intervalMs!==0 || !/^[0-9a-f]{64}$/.test(tx.secretHash) || tx.refundTime<Date.now()+60_000 || tx.refundTime>Date.now()+30*24*60*60_000)) throw new Error("Hashlocks require a SHA-256 secret hash and a refund deadline between one minute and 30 days");
  if (typeof tx.memo!=="string" || tx.memo.length>MAX_MEMO_LENGTH) throw new Error(`Memo cannot exceed ${MAX_MEMO_LENGTH} characters`);
  if (typeof tx.signature!=="string" || !tx.signature) throw new Error("Signature is required");
  return tx;
}

function contractFromDeployment(tx,createdAt,createdHeight) {
  return {address:tx.contractAddress,contractType:tx.contractType,creator:tx.from,beneficiary:tx.beneficiary,amount:tx.amount,unlockTime:tx.unlockTime,installments:tx.installments??1,intervalMs:tx.intervalMs??0,secretHash:tx.secretHash??"",refundTime:tx.refundTime??0,releasedInstallments:0,releasedAmount:0,status:"locked",memo:tx.memo,createdAt,createdHeight,approvalRound:1,creatorApprovedRound:0,beneficiaryApprovedRound:0};
}

function validContractSchedule(tx,referenceTime) {
  if (tx.contractType==="timelock") return tx.installments===1&&tx.intervalMs===0&&tx.unlockTime>=referenceTime+5_000&&tx.unlockTime<=referenceTime+365*24*60*60_000;
  if (tx.contractType==="vesting" || tx.contractType==="milestone") return tx.installments>=2&&tx.installments<=52&&tx.intervalMs>=60_000&&tx.intervalMs<=90*24*60*60_000&&tx.unlockTime>=referenceTime+5_000&&tx.unlockTime+(tx.installments-1)*tx.intervalMs<=referenceTime+2*365*24*60*60_000;
  if (tx.contractType==="hashlock") return tx.installments===1&&tx.intervalMs===0&&/^[0-9a-f]{64}$/.test(tx.secretHash??"")&&tx.refundTime>=referenceTime+60_000&&tx.refundTime<=referenceTime+30*24*60*60_000;
  return false;
}

function nextContractRelease(contract,now) {
  if (contract.contractType==="hashlock") return null;
  const released=contract.releasedInstallments??0;
  const installments=contract.installments??1;
  if (released>=installments) return null;
  const dueAt=contract.unlockTime+released*(contract.intervalMs??0);
  if (now<dueAt) return null;
  if (contract.contractType==="milestone") {
    const round=released+1;
    if ((contract.creatorApprovedRound??0)!==round || (contract.beneficiaryApprovedRound??0)!==round) return null;
  }
  const remaining=contract.amount-(contract.releasedAmount??0);
  const amount=released===installments-1 ? remaining : Math.floor(contract.amount/installments);
  return {amount,installment:released+1,dueAt};
}

function applyContractRelease(contract,release,releasedAt,releaseHeight) {
  const releasedAmount=(contract.releasedAmount??0)+release.amount;
  const releasedInstallments=release.installment;
  const complete=releasedInstallments>=(contract.installments??1);
  return {...contract,releasedAmount,releasedInstallments,status:complete?"released":contract.contractType,releasedAt,releaseHeight,nextReleaseAt:complete?null:contract.unlockTime+releasedInstallments*(contract.intervalMs??0),approvalRound:complete?0:releasedInstallments+1,creatorApprovedRound:0,beneficiaryApprovedRound:0};
}

function applyContractApproval(contract,approver,milestone,releasedAt,releaseHeight) {
  const approvalRound=contract.approvalRound ?? (contract.releasedInstallments ?? 0) + 1;
  const updated = {
    ...contract,
    approvalRound,
    creatorApprovedRound: contract.creatorApprovedRound ?? 0,
    beneficiaryApprovedRound: contract.beneficiaryApprovedRound ?? 0,
  };
  if (approver === contract.creator) updated.creatorApprovedRound = milestone;
  if (approver === contract.beneficiary) updated.beneficiaryApprovedRound = milestone;
  return { ...updated, approvedAt: releasedAt, approvedHeight: releaseHeight };
}

function assertInteger(value, name) {
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be a safe integer`);
}

function assertAddress(address) {
  if (typeof address !== "string" || !/^ec1[0-9a-f]{38}$/.test(address)) throw new Error("Invalid E-Coin address");
}
