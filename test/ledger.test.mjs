import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { Ledger, SCALE, DEFAULT_FEE, MEMPOOL_TTL_MS, MAX_SUPPLY, TREASURY_ADDRESS, addressFromPublicJwk, canonicalTransaction, canonicalContractDeployment, sha256 } from "../src/ledger.mjs";

function wallet() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicJwk = publicKey.export({ format:"jwk" });
  return { publicKey:publicJwk, privateKey, address:addressFromPublicJwk(publicJwk) };
}

function signedTransfer(sender, recipient, overrides = {}) {
  const tx = { from:sender.address, to:recipient.address, amount:2*SCALE, fee:DEFAULT_FEE, nonce:1, memo:"test", timestamp:Date.now(), publicKey:sender.publicKey, ...overrides };
  tx.signature = sign(null, Buffer.from(canonicalTransaction(tx)), sender.privateKey).toString("base64url");
  return tx;
}

function signedTimelock(creator,beneficiary,overrides={}) {
  const tx={contractType:"timelock",from:creator.address,beneficiary:beneficiary.address,amount:SCALE,fee:DEFAULT_FEE,nonce:1,unlockTime:Date.now()+10_000,memo:"locked",timestamp:Date.now(),publicKey:creator.publicKey,...overrides};
  tx.signature=sign(null,Buffer.from(canonicalContractDeployment(tx)),creator.privateKey).toString("base64url");
  return tx;
}

function signedVesting(creator,beneficiary,overrides={}) {
  const tx={contractType:"vesting",from:creator.address,beneficiary:beneficiary.address,amount:3*SCALE,fee:DEFAULT_FEE,nonce:1,unlockTime:Date.now()+10_000,installments:3,intervalMs:60_000,memo:"salary",timestamp:Date.now(),publicKey:creator.publicKey,...overrides};
  tx.signature=sign(null,Buffer.from(canonicalContractDeployment(tx)),creator.privateKey).toString("base64url");
  return tx;
}

function signedHashlock(creator,beneficiary,secret="open-sesame",overrides={}) {
  const tx={contractType:"hashlock",from:creator.address,beneficiary:beneficiary.address,amount:SCALE,fee:DEFAULT_FEE,nonce:1,unlockTime:0,installments:1,intervalMs:0,secretHash:sha256(secret),refundTime:Date.now()+120_000,memo:"atomic escrow",timestamp:Date.now(),publicKey:creator.publicKey,...overrides};
  tx.signature=sign(null,Buffer.from(canonicalContractDeployment(tx)),creator.privateKey).toString("base64url"); return tx;
}

test("genesis fixes supply at twenty million and faucet distributes treasury coins",()=>{
  const ledger=new Ledger(); const alice=wallet();
  assert.equal(ledger.totalSupply,MAX_SUPPLY);
  assert.equal(ledger.getAccount(TREASURY_ADDRESS).balance,MAX_SUPPLY);
  ledger.fund(alice.address,25*SCALE);
  assert.equal(ledger.totalSupply,MAX_SUPPLY);
  assert.equal(ledger.getAccount(TREASURY_ADDRESS).balance,MAX_SUPPLY-25*SCALE);
  assert.equal(ledger.verifyIntegrity(),true);
});

test("funding and signed transfer update balances, nonce, and recycled fees", () => {
  const ledger = new Ledger(); const alice=wallet(); const bob=wallet();
  ledger.fund(alice.address, 10*SCALE);
  const { block } = ledger.submit(signedTransfer(alice,bob));
  assert.equal(ledger.getAccount(alice.address).balance, 8*SCALE-DEFAULT_FEE);
  assert.equal(ledger.getAccount(alice.address).nonce, 1);
  assert.equal(ledger.getAccount(bob.address).balance, 2*SCALE);
  assert.equal(ledger.feesRecycled, DEFAULT_FEE);
  assert.equal(ledger.getAccount(TREASURY_ADDRESS).balance,MAX_SUPPLY-10*SCALE+DEFAULT_FEE);
  assert.equal(block.previousHash, ledger.blocks.at(-2).hash);
});

test("USD market buys quote and transfer existing treasury coins idempotently",()=>{
  const ledger=new Ledger(); const alice=wallet();
  const quote=ledger.quoteMarketBuy(2500);
  assert.equal(quote.priceUsd,0.25);
  assert.equal(quote.amount,100*SCALE);
  const first=ledger.buyFromTreasury(alice.address,2500,"purchase-demo-001");
  assert.equal(ledger.getAccount(alice.address).balance,100*SCALE);
  assert.equal(ledger.totalSupply,MAX_SUPPLY);
  assert.equal(ledger.getMarket().volumeUsdCents,2500);
  const duplicate=ledger.buyFromTreasury(alice.address,2500,"purchase-demo-001");
  assert.equal(duplicate.duplicate,true);
  assert.equal(ledger.getAccount(alice.address).balance,100*SCALE);
  assert.equal(ledger.verifyIntegrity(),true);
});

test("rejects tampering, replayed nonces, and overspending", () => {
  const ledger=new Ledger(); const alice=wallet(); const bob=wallet(); ledger.fund(alice.address, 3*SCALE);
  const tampered=signedTransfer(alice,bob); tampered.amount=1*SCALE;
  assert.throws(()=>ledger.submit(tampered), /signature/i);
  const original=signedTransfer(alice,bob); ledger.submit(original);
  const replay=ledger.submit(original);
  assert.equal(replay.duplicate,true);
  assert.equal(ledger.getAccount(bob.address).balance,2*SCALE);
  assert.throws(()=>ledger.submit(signedTransfer(alice,bob,{nonce:2,amount:2*SCALE})), /balance/i);
});

test("snapshot round-trip preserves chain state", () => {
  const ledger=new Ledger(); const alice=wallet(); ledger.fund(alice.address,SCALE);
  const restored=new Ledger(JSON.parse(JSON.stringify(ledger.toJSON())));
  assert.deepEqual(restored.status,ledger.status);
  assert.deepEqual(restored.getAccount(alice.address),ledger.getAccount(alice.address));
  assert.equal(restored.verifyIntegrity(),true);
});

test("faucet funds each address once and integrity detects altered history", () => {
  const ledger=new Ledger(); const alice=wallet(); ledger.fund(alice.address,SCALE);
  assert.throws(()=>ledger.fund(alice.address,SCALE),/already claimed/i);
  assert.equal(ledger.status.chainValid,true);
  ledger.blocks[0].timestamp += 1;
  assert.equal(ledger.auditIntegrity(),false);
  assert.equal(ledger.status.chainValid,false);
});

test("insights summarize activity and replay verification catches state corruption", () => {
  const ledger=new Ledger(); const alice=wallet(); const bob=wallet(); ledger.fund(alice.address,5*SCALE);
  ledger.submit(signedTransfer(alice,bob,{amount:SCALE}));
  const insights = ledger.getInsights(alice.address);
  assert.equal(insights.transactionCount, 2);
  assert.equal(insights.received, 5*SCALE);
  assert.equal(insights.sent, SCALE);
  assert.equal(insights.feesPaid, DEFAULT_FEE);
  assert.equal(insights.counterparties, 2);
  assert.equal(insights.firstSeen, ledger.blocks[1].timestamp);
  assert.equal(insights.lastActive, ledger.blocks[2].timestamp);
  assert.equal(insights.topCounterparties[0].address, TREASURY_ADDRESS);
  assert.equal(insights.topCounterparties[1].address, bob.address);
  ledger.accounts.get(bob.address).balance += 1;
  assert.equal(ledger.verifyIntegrity(),false);
});

test("ledger search indexes blocks, accounts, and transactions", () => {
  const ledger = new Ledger(); const alice=wallet(); const bob=wallet(); ledger.fund(alice.address,5*SCALE);
  const { transaction, block } = ledger.submit(signedTransfer(alice,bob,{amount:SCALE}));
  const blockResults = ledger.search(String(block.height));
  assert.ok(blockResults.results.some((entry) => entry.kind === "block" && entry.height === block.height));
  const addressResults = ledger.search(bob.address);
  assert.ok(addressResults.results.some((entry) => entry.kind === "account" && entry.address === bob.address));
  assert.ok(addressResults.results.some((entry) => entry.kind === "transaction" && entry.id === transaction.id));
});

test("block and transaction receipts are addressable", () => {
  const ledger=new Ledger(); const alice=wallet(); const bob=wallet(); ledger.fund(alice.address,4*SCALE);
  const { transaction,block }=ledger.submit(signedTransfer(alice,bob,{amount:SCALE}));
  assert.equal(ledger.getBlock(block.height).hash,block.hash);
  assert.equal(ledger.getBlock(block.hash).height,block.height);
  assert.deepEqual(ledger.getTransaction(transaction.id),{
    transaction, block:{height:block.height,hash:block.hash,timestamp:block.timestamp,stateRoot:block.stateRoot},
  });
  assert.throws(()=>ledger.getTransaction("missing"),/not found/i);
});

test("mempool reserves balances and batches nonce-ordered transfers", () => {
  const ledger=new Ledger(); const alice=wallet(); const bob=wallet(); ledger.fund(alice.address,5*SCALE);
  const first=signedTransfer(alice,bob,{amount:SCALE,nonce:1});
  const second=signedTransfer(alice,bob,{amount:SCALE,nonce:2,timestamp:Date.now()+1});
  ledger.queue(first); ledger.queue(second);
  assert.equal(ledger.getAccount(alice.address).balance,5*SCALE);
  assert.equal(ledger.getAvailableAccount(alice.address).availableBalance,3*SCALE-2*DEFAULT_FEE);
  assert.equal(ledger.getAvailableAccount(alice.address).nextNonce,3);
  const block=ledger.produceBlock();
  assert.equal(block.transactions.length,2);
  assert.equal(ledger.pending.length,0);
  assert.equal(ledger.getAccount(alice.address).nonce,2);
  assert.equal(ledger.verifyIntegrity(),true);
});

test("mempool integrity rejects persisted transaction tampering", () => {
  const ledger=new Ledger(); const alice=wallet(); const bob=wallet(); ledger.fund(alice.address,3*SCALE);
  ledger.queue(signedTransfer(alice,bob,{amount:SCALE}));
  assert.equal(ledger.verifyPending(),true);
  ledger.pending[0].amount+=1;
  assert.equal(ledger.verifyPending(),false);
  assert.throws(()=>ledger.produceBlock(),/integrity/i);
});

test("fee priority schedules eligible senders without breaking nonce order", () => {
  const ledger=new Ledger(); const alice=wallet(); const carol=wallet(); const bob=wallet();
  ledger.fund(alice.address,5*SCALE); ledger.fund(carol.address,5*SCALE);
  ledger.queue(signedTransfer(alice,bob,{amount:SCALE,fee:DEFAULT_FEE,nonce:1}));
  const queued=ledger.queue(signedTransfer(carol,bob,{amount:SCALE,fee:5*DEFAULT_FEE,nonce:1})).transaction;
  const block=ledger.produceBlock(1);
  assert.equal(block.transactions[0].id,queued.id);
  assert.equal(block.transactions[0].from,carol.address);
  assert.equal(ledger.pending[0].from,alice.address);
  assert.equal(ledger.verifyPending(),true);
});

test("replace-by-fee preserves payment intent and expires stale entries", () => {
  const ledger=new Ledger(); const alice=wallet(); const bob=wallet(); ledger.fund(alice.address,3*SCALE);
  const original=ledger.queue(signedTransfer(alice,bob,{amount:SCALE,fee:DEFAULT_FEE})).transaction;
  assert.throws(()=>ledger.queue(signedTransfer(alice,bob,{amount:SCALE,fee:DEFAULT_FEE+50})),/10%/i);
  const replacement=ledger.queue(signedTransfer(alice,bob,{amount:SCALE,fee:2*DEFAULT_FEE}));
  assert.equal(replacement.replaced,original.id);
  assert.equal(ledger.pending.length,1);
  assert.equal(ledger.pending[0].fee,2*DEFAULT_FEE);
  ledger.pending[0].queuedAt=Date.now()-MEMPOOL_TTL_MS-1;
  assert.equal(ledger.prunePending().length,1);
  assert.equal(ledger.getAvailableAccount(alice.address).availableBalance,3*SCALE);
});

test("signed timelock contracts reserve, commit, and release funds deterministically",()=>{
  const ledger=new Ledger(); const alice=wallet(); const bob=wallet(); ledger.fund(alice.address,3*SCALE);
  const deployment=signedTimelock(alice,bob);
  const queued=ledger.queueContract(deployment).transaction;
  assert.match(queued.contractAddress,/^ect[0-9a-f]{38}$/);
  assert.equal(ledger.getAvailableAccount(alice.address).availableBalance,2*SCALE-DEFAULT_FEE);
  ledger.produceBlock();
  assert.equal(ledger.getContract(queued.contractAddress).status,"locked");
  assert.equal(ledger.getAccount(bob.address).balance,0);
  const execution=ledger.executeMatureContracts(deployment.unlockTime+1);
  assert.equal(execution.transactions[0].type,"contract_execute");
  assert.equal(ledger.getContract(queued.contractAddress).status,"released");
  assert.equal(ledger.getAccount(bob.address).balance,SCALE);
  assert.equal(ledger.auditIntegrity(),true);
});

test("vesting contracts release deterministic installments",()=>{
  const ledger=new Ledger(); const alice=wallet(); const bob=wallet(); ledger.fund(alice.address,4*SCALE);
  const deployment=signedVesting(alice,bob); const queued=ledger.queueContract(deployment).transaction; ledger.produceBlock();
  ledger.executeMatureContracts(deployment.unlockTime+1);
  assert.equal(ledger.getAccount(bob.address).balance,SCALE);
  assert.equal(ledger.getContract(queued.contractAddress).status,"vesting");
  ledger.executeMatureContracts(deployment.unlockTime+deployment.intervalMs+1);
  ledger.executeMatureContracts(deployment.unlockTime+2*deployment.intervalMs+1);
  assert.equal(ledger.getAccount(bob.address).balance,3*SCALE);
  assert.equal(ledger.getContract(queued.contractAddress).status,"released");
  assert.equal(ledger.verifyIntegrity(),true);
});

test("hashlocks claim by preimage and fail closed on incorrect secrets",()=>{
  const ledger=new Ledger(); const alice=wallet(); const bob=wallet(); ledger.fund(alice.address,3*SCALE);
  const deployment=signedHashlock(alice,bob); const queued=ledger.queueContract(deployment).transaction; ledger.produceBlock();
  assert.throws(()=>ledger.claimHashlock(queued.contractAddress,"wrong",deployment.timestamp+10_000),/does not match/i);
  const result=ledger.claimHashlock(queued.contractAddress,"open-sesame",deployment.timestamp+20_000);
  assert.equal(result.transaction.type,"contract_claim"); assert.equal(ledger.getAccount(bob.address).balance,SCALE);
  assert.equal(ledger.getContract(queued.contractAddress).status,"released"); assert.equal(ledger.verifyIntegrity(),true);
});

test("expired hashlocks refund the creator deterministically",()=>{
  const ledger=new Ledger(); const alice=wallet(); const bob=wallet(); ledger.fund(alice.address,3*SCALE);
  const deployment=signedHashlock(alice,bob,"late"); const queued=ledger.queueContract(deployment).transaction; ledger.produceBlock();
  const block=ledger.executeMatureContracts(deployment.refundTime+1);
  assert.equal(block.transactions[0].type,"contract_refund"); assert.equal(ledger.getContract(queued.contractAddress).status,"refunded");
  assert.equal(ledger.getAccount(alice.address).balance,3*SCALE-DEFAULT_FEE); assert.equal(ledger.verifyIntegrity(),true);
});
