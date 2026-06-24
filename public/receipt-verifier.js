const encoder = new TextEncoder();

function base64UrlBytes(value) {
  const base64=String(value||"").replace(/-/g,"+").replace(/_/g,"/").padEnd(Math.ceil(String(value||"").length/4)*4,"=");
  return Uint8Array.from(atob(base64),(character)=>character.charCodeAt(0));
}

export async function sha256Hex(value) {
  const digest=new Uint8Array(await crypto.subtle.digest("SHA-256",encoder.encode(value)));
  return [...digest].map((byte)=>byte.toString(16).padStart(2,"0")).join("");
}

export function canonicalReceiptTransaction(tx) {
  return JSON.stringify({ from:tx.from,to:tx.to,amount:tx.amount,fee:tx.fee,nonce:tx.nonce,memo:tx.memo??"",timestamp:tx.timestamp,publicKey:tx.publicKey });
}

export function canonicalReceiptContract(tx) {
  return JSON.stringify({ contractType:tx.contractType,from:tx.from,beneficiary:tx.beneficiary,amount:tx.amount,fee:tx.fee,nonce:tx.nonce,unlockTime:tx.unlockTime,installments:tx.installments??1,intervalMs:tx.intervalMs??0,secretHash:tx.secretHash??"",refundTime:tx.refundTime??0,memo:tx.memo??"",timestamp:tx.timestamp,publicKey:tx.publicKey });
}

async function addressFromPublicKey(jwk) {
  const digest=new Uint8Array(await crypto.subtle.digest("SHA-256",base64UrlBytes(jwk.x)));
  return `ec1${[...digest].map((byte)=>byte.toString(16).padStart(2,"0")).join("").slice(0,38)}`;
}

async function verifySignedTransaction(tx) {
  const checks=[];
  const canonical=tx.type==="contract_deploy"?canonicalReceiptContract(tx):canonicalReceiptTransaction(tx);
  try {
    const derived=await addressFromPublicKey(tx.publicKey);
    checks.push({label:"Sender binding",status:derived===tx.from?"pass":"fail",detail:derived===tx.from?"Public key derives to the sender address.":"Public key does not derive to the recorded sender."});
    const key=await crypto.subtle.importKey("jwk",tx.publicKey,{name:"Ed25519"},false,["verify"]);
    const valid=await crypto.subtle.verify("Ed25519",key,base64UrlBytes(tx.signature),encoder.encode(canonical));
    checks.push({label:"Ed25519 signature",status:valid?"pass":"fail",detail:valid?"Signature authorizes the exact recorded intent.":"Signature verification failed."});
    const expectedId=await sha256Hex(`${canonical}:${tx.signature}`);
    checks.push({label:"Transaction identity",status:expectedId===tx.id?"pass":"fail",detail:expectedId===tx.id?"Transaction ID matches canonical intent and signature.":"Transaction ID does not match the signed payload."});
  } catch {
    checks.push({label:"Transaction authorization",status:"fail",detail:"Public-key or signature data could not be verified."});
  }
  return checks;
}

async function verifySystemTransaction(tx,block) {
  let expected=null;
  if(tx.type==="genesis") expected=await sha256Hex(`genesis:${tx.to}:${tx.amount}`);
  else if(tx.type==="market_buy") expected=await sha256Hex(`market:${tx.purchaseId}`);
  else if(tx.type==="contract_execute") expected=await sha256Hex(`execute:${tx.contractAddress}:${block.height}:${tx.installment}`);
  else if(tx.type==="contract_claim") expected=await sha256Hex(`claim:${tx.contractAddress}:${await sha256Hex(tx.secret||"")}`);
  else if(tx.type==="contract_refund") expected=await sha256Hex(`refund:${tx.contractAddress}:${block.height}`);
  if(expected) return [{label:"Protocol transition ID",status:expected===tx.id?"pass":"fail",detail:expected===tx.id?"Deterministic protocol transition ID matches.":"Protocol transition ID mismatch."}];
  return [{label:"Protocol-authored transition",status:/^[0-9a-f]{64}$/.test(tx.id||"")?"pass":"fail",detail:"This transition has no user signature; its full contents are committed by the verified block hash."}];
}

export async function verifySettlementReceipt(block,previousBlock=null,transactionIndex=0) {
  const checks=[];
  if(!block||!Array.isArray(block.transactions)||!block.transactions[transactionIndex]) return {verified:false,checks:[{label:"Receipt structure",status:"fail",detail:"Block or transaction data is missing."}]};
  const {hash,...body}=block;
  const expectedHash=await sha256Hex(JSON.stringify(body));
  checks.push({label:"Block hash",status:expectedHash===hash?"pass":"fail",detail:expectedHash===hash?"Block body recomputes to the recorded hash.":"Block body does not match its hash."});
  const genesis=block.height===0;
  const parentValid=genesis?block.previousHash==="0".repeat(64):Boolean(previousBlock&&previousBlock.hash===block.previousHash&&previousBlock.height===block.height-1);
  checks.push({label:"Chain linkage",status:parentValid?"pass":"fail",detail:parentValid?(genesis?"Genesis correctly anchors to the zero hash.":`Parent block #${previousBlock.height} matches previousHash.`):"Previous-block linkage could not be verified."});
  const rootsValid=/^[0-9a-f]{64}$/.test(block.stateRoot||"")&&/^[0-9a-f]{64}$/.test(block.contractRoot||"");
  checks.push({label:"State commitments",status:rootsValid?"pass":"fail",detail:rootsValid?"Account and contract state roots are committed in the block.":"State-root encoding is invalid."});
  const tx=block.transactions[transactionIndex];
  checks.push(...(tx.signature&&["transfer","contract_deploy"].includes(tx.type)?await verifySignedTransaction(tx):await verifySystemTransaction(tx,block)));
  return {verified:checks.every((check)=>check.status==="pass"),checks,blockHash:hash,transactionId:tx.id};
}
