import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { Ledger, SCALE, TREASURY_ADDRESS, TREASURY_PUBLIC_KEY } from "./ledger.mjs";
import { loadSnapshot, saveSnapshot } from "./storage.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = join(root, "public");
const dataFile = join(root, "data", "ledger-v7.json");
const backupFile = join(root, "data", "ledger-v7.backup.json");
const treasuryWallet={id:TREASURY_ADDRESS,name:"E-Coin Genesis Treasury",address:TREASURY_ADDRESS,publicKey:TREASURY_PUBLIC_KEY,privateKey:{crv:"Ed25519",d:"5aSuR4-xYm7s1pH6v8q94k5pKHWebPuxO20A5xa2zys",x:TREASURY_PUBLIC_KEY.x,kty:"OKP"},genesis:true};
const port = Number(process.env.PORT || 8787);
const blockIntervalMs = Number(process.env.BLOCK_INTERVAL_MS || 6_000);
let nextBlockAt = Date.now() + blockIntervalMs;
let producingBlock = false;
const eventClients = new Set();
const writeLimits=new Map();

const loaded=await loadSnapshot(dataFile,backupFile,(snapshot)=>{
  const candidate=new Ledger(snapshot);
  return candidate.auditIntegrity() && candidate.verifyPending();
});
let ledger=loaded.snapshot ? new Ledger(loaded.snapshot) : new Ledger();
if (loaded.source==="backup") console.warn("Recovered ledger from verified backup snapshot");

let saveQueue = Promise.resolve();
function persist(options) {
  const snapshot = ledger.toJSON();
  saveQueue = saveQueue.then(() => saveSnapshot(dataFile,backupFile,snapshot,options));
  return saveQueue;
}

if (loaded.source==="backup" || loaded.legacy) { await persist({rotate:false}); await persist(); }

const server = createServer(async (request, response) => {
  try {
    response.setHeader("X-Content-Type-Options","nosniff");
    response.setHeader("Referrer-Policy","no-referrer");
    response.setHeader("Content-Security-Policy","default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname.startsWith("/api/")) {
      try {
        if (["POST","PUT","PATCH","DELETE"].includes(request.method)) enforceWriteLimit(request);
        return await handleApi(request, response, url);
      } catch (error) {
        return sendJson(response, 400, { error: error.message || "Invalid request" });
      }
    }
    return await serveStatic(response, url.pathname);
  } catch (error) {
    sendJson(response, 500, { error: "Internal node error" });
    console.error(error);
  }
});

async function handleApi(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/events") return openEventStream(request,response);
  if (request.method === "GET" && url.pathname === "/api/status") return sendJson(response, 200, { ...ledger.status, blockIntervalMs, nextBlockAt, eventSubscribers:eventClients.size, storageProtected:true });
  if (request.method === "GET" && url.pathname === "/api/treasury-wallet") {
    if (!isLoopback(request.socket.remoteAddress)) throw new Error("Treasury bootstrap is available only on this computer");
    response.setHeader("Cache-Control","no-store"); return sendJson(response,200,treasuryWallet);
  }
  if (request.method === "GET" && url.pathname === "/api/mempool") return sendJson(response, 200, { size:ledger.pending.length, transactions:ledger.pending });
  if (request.method === "GET" && url.pathname === "/api/fees") return sendJson(response, 200, ledger.getFeeQuote());
  if (request.method === "GET" && url.pathname === "/api/market") {
    const address = url.searchParams.get("address") || undefined;
    return sendJson(response,200,{ ...ledger.getMarket(), yourOrders: address ? ledger.listMarketOrders(address).filter((order)=>order.status==="open" || order.status==="partial") : [] });
  }
  if (request.method === "GET" && url.pathname === "/api/market/orders") {
    const address = url.searchParams.get("address") || undefined;
    return sendJson(response,200,ledger.listMarketOrders(address));
  }
  if (request.method === "GET" && url.pathname === "/api/market/trades") {
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 30, 1), 100);
    return sendJson(response,200,ledger.listMarketTrades(limit));
  }
  if (request.method === "GET" && url.pathname === "/api/search") {
    const query = url.searchParams.get("q") ?? "";
    return sendJson(response, 200, ledger.search(query));
  }
  if (request.method === "POST" && url.pathname === "/api/market/quote") {
    const body=await readBody(request); return sendJson(response,200,ledger.quoteMarketBuy(Number(body.usdCents)));
  }
  if (request.method === "POST" && url.pathname === "/api/market/buy") {
    const body=await readBody(request); const result=ledger.buyFromTreasury(body.address,Number(body.usdCents),body.purchaseId);
    await persist(); if (!result.duplicate) broadcast("block",{height:result.block.height,hash:result.block.hash,transactions:1,reason:"market_buy"});
    return sendJson(response,result.duplicate?200:201,result);
  }
  if (request.method === "POST" && url.pathname === "/api/market/order") {
    const body = await readBody(request);
    const result = ledger.placeMarketOrder(body.address, body.side, Number(body.amount), Number(body.limitPriceMicroUsd), body.orderId, body);
    await persist();
    broadcast("market",{reason:"order",address:body.address,openOrders:ledger.getMarket().openOrders});
    return sendJson(response, result.duplicate ? 200 : 201, result);
  }
  if (request.method === "POST" && url.pathname === "/api/market/order/cancel") {
    const body = await readBody(request);
    const result = ledger.cancelMarketOrder(body.orderId, body.address, body);
    await persist();
    broadcast("market",{reason:"cancel",address:body.address,openOrders:ledger.getMarket().openOrders});
    return sendJson(response, 200, result);
  }
  if (request.method === "GET" && url.pathname === "/api/contracts") return sendJson(response,200,ledger.listContracts(url.searchParams.get("address")||undefined));
  if (request.method === "GET" && url.pathname.startsWith("/api/contracts/")) return sendJson(response,200,ledger.getContract(decodeURIComponent(url.pathname.slice("/api/contracts/".length))));
  if (request.method === "GET" && url.pathname === "/api/health") {
    const status=ledger.status;
    return sendJson(response,status.chainValid?200:503,{ status:status.chainValid?"healthy":"degraded", uptimeSeconds:Math.floor(process.uptime()), chainValid:status.chainValid, mempoolValid:status.mempoolValid, storage:{formatVersion:1,loadedFrom:loaded.source,checksummed:true,backupGenerations:1}, metrics:status.metrics });
  }
  if (request.method === "GET" && url.pathname === "/api/blocks") {
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 12, 1), 100);
    const before=Math.min(Math.max(Number(url.searchParams.get("before")) || ledger.blocks.length,0),ledger.blocks.length);
    return sendJson(response, 200, ledger.blocks.slice(Math.max(0,before-limit),before).reverse());
  }
  if (request.method === "GET" && url.pathname.startsWith("/api/blocks/")) {
    return sendJson(response, 200, ledger.getBlock(decodeURIComponent(url.pathname.slice("/api/blocks/".length))));
  }
  if (request.method === "GET" && url.pathname.startsWith("/api/transactions/")) {
    return sendJson(response, 200, ledger.getTransaction(decodeURIComponent(url.pathname.slice("/api/transactions/".length))));
  }
  if (request.method === "GET" && url.pathname.startsWith("/api/accounts/")) {
    const address = decodeURIComponent(url.pathname.slice("/api/accounts/".length));
    if (address.includes("/activity")) {
      const target = decodeURIComponent(address.slice(0, -"/activity".length));
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 60, 1), 250);
      return sendJson(response, 200, { address: target, activity: ledger.getActivity(target, limit), insights: ledger.getInsights(target) });
    }
    return sendJson(response, 200, { address, ...ledger.getAvailableAccount(address), faucetClaimed: ledger.hasFaucetClaim(address), insights:ledger.getInsights(address) });
  }
  if (request.method === "POST" && url.pathname === "/api/faucet") {
    const body = await readBody(request);
    const result = ledger.fund(body.address, body.amount == null ? 25 * SCALE : Number(body.amount));
    await persist();
    broadcast("block",{height:result.block.height,hash:result.block.hash,transactions:1,reason:"faucet"});
    return sendJson(response, 201, result);
  }
  if (request.method === "POST" && url.pathname === "/api/transactions") {
    const result = ledger.queue(await readBody(request));
    await persist();
    if (!result.duplicate) broadcast("mempool",{size:ledger.pending.length,transactionId:result.transaction.id,replaced:result.replaced??null});
    return sendJson(response, result.duplicate?200:202, { ...result, expectedBy:result.status==="pending"?nextBlockAt:null });
  }
  if (request.method === "POST" && url.pathname === "/api/transactions/batch") {
    const body = await readBody(request);
    const result = ledger.queueBatch(body.transactions);
    await persist();
    if (result.queued) broadcast("mempool",{size:ledger.pending.length,batchSize:result.queued,firstPosition:result.firstPosition,lastPosition:result.lastPosition});
    return sendJson(response, result.queued?202:200, { ...result, expectedBy:result.queued?nextBlockAt:null });
  }
  if (request.method === "POST" && url.pathname === "/api/contracts") {
    const result=ledger.queueContract(await readBody(request));
    await persist();
    if (!result.duplicate) broadcast("mempool",{size:ledger.pending.length,transactionId:result.transaction.id,contractAddress:result.transaction.contractAddress});
    return sendJson(response,result.duplicate?200:202,{...result,expectedBy:result.status==="pending"?nextBlockAt:null});
  }
  if (request.method === "POST" && /^\/api\/contracts\/[^/]+\/claim$/.test(url.pathname)) {
    const address=decodeURIComponent(url.pathname.slice("/api/contracts/".length,-"/claim".length)); const body=await readBody(request);
    const result=ledger.claimHashlock(address,body.secret); await persist(); broadcast("block",{height:result.block.height,hash:result.block.hash,transactions:1,reason:"hashlock_claim"});
    return sendJson(response,201,result);
  }
  sendJson(response, 404, { error: "API route not found" });
}

function openEventStream(request,response) {
  response.writeHead(200,{"Content-Type":"text/event-stream; charset=utf-8","Cache-Control":"no-cache, no-transform","Connection":"keep-alive"});
  response.write(`retry: 3000\nevent: ready\ndata: ${JSON.stringify({height:ledger.status.height,mempoolSize:ledger.pending.length})}\n\n`);
  const client={response,heartbeat:setInterval(()=>response.write(": heartbeat\n\n"),15_000)};
  eventClients.add(client);
  request.on("close",()=>{clearInterval(client.heartbeat);eventClients.delete(client);});
}

function broadcast(event,data) {
  const message=`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of eventClients) {
    try { client.response.write(message); }
    catch { clearInterval(client.heartbeat); eventClients.delete(client); }
  }
}

async function readBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 64 * 1024) throw new Error("Request body too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new Error("Invalid JSON body");
  }
}

async function serveStatic(response, path) {
  const requested = path === "/" ? "index.html" : path.slice(1);
  const safePath = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, "");
  const file = join(publicDir, safePath);
  if (!file.startsWith(publicDir)) return sendJson(response, 403, { error: "Forbidden" });
  try {
    const content = await readFile(file);
    const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };
    response.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
    response.end(content);
  } catch (error) {
    if (error.code === "ENOENT") return sendJson(response, 404, { error: "Not found" });
    throw error;
  }
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  response.end(body);
}

function enforceWriteLimit(request) {
  const key=request.socket.remoteAddress??"local"; const now=Date.now();
  const current=writeLimits.get(key);
  const bucket=!current || now-current.startedAt>=60_000 ? {startedAt:now,count:0} : current;
  bucket.count++; writeLimits.set(key,bucket);
  if (bucket.count>120) throw new Error("Write rate limit exceeded; retry in one minute");
}

function isLoopback(address) { return address==="127.0.0.1" || address==="::1" || address==="::ffff:127.0.0.1"; }

server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));
server.listen(port,"::", () => console.log(`E-Coin Aurora Devnet running at http://localhost:${port}`));

setInterval(async () => {
  if (producingBlock) return;
  producingBlock = true;
  try {
    const contractBlock=ledger.executeMatureContracts();
    const removed=ledger.prunePending();
    const block=ledger.produceBlock();
    nextBlockAt=Date.now()+blockIntervalMs;
    if (contractBlock || block || removed.length) await persist();
    if (contractBlock) broadcast("block",{height:contractBlock.height,hash:contractBlock.hash,transactions:contractBlock.transactions.length,reason:"contract_execution"});
    if (removed.length) broadcast("mempool",{size:ledger.pending.length,expired:removed.map((tx)=>tx.id)});
    if (block) { broadcast("block",{height:block.height,hash:block.hash,transactions:block.transactions.length}); broadcast("mempool",{size:ledger.pending.length}); console.log(`Sealed block #${block.height} with ${block.transactions.length} transaction(s)`); }
  } catch (error) { console.error("Block production failed:",error); }
  finally { producingBlock = false; }
},blockIntervalMs);

setInterval(() => {
  if (!ledger.auditIntegrity()) console.error("Deep chain audit failed");
},60_000);
