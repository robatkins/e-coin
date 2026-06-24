import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { canonicalReceiptTransaction, sha256Hex, verifySettlementReceipt } from "../public/receipt-verifier.js";

function b64(bytes){return Buffer.from(bytes).toString("base64url")}

test("receipt verifier independently validates a signed transaction and linked block",async()=>{
  const {publicKey,privateKey}=generateKeyPairSync("ed25519");
  const publicJwk=publicKey.export({format:"jwk"});
  const address=`ec1${createHash("sha256").update(Buffer.from(publicJwk.x,"base64url")).digest("hex").slice(0,38)}`;
  const tx={type:"transfer",from:address,to:`ec1${"b".repeat(38)}`,amount:1_000_000,fee:1_000,nonce:1,memo:"verified",timestamp:1_800_000_000_000,publicKey:publicJwk};
  tx.signature=b64(sign(null,Buffer.from(canonicalReceiptTransaction(tx)),privateKey));
  tx.id=await sha256Hex(`${canonicalReceiptTransaction(tx)}:${tx.signature}`);
  const previous={height:0,hash:"1".repeat(64)};
  const body={height:1,previousHash:previous.hash,timestamp:tx.timestamp,transactions:[tx],stateRoot:"2".repeat(64),contractRoot:"3".repeat(64)};
  const block={...body,hash:await sha256Hex(JSON.stringify(body))};
  const result=await verifySettlementReceipt(block,previous);
  assert.equal(result.verified,true);
  block.transactions[0].amount++;
  assert.equal((await verifySettlementReceipt(block,previous)).verified,false);
});
