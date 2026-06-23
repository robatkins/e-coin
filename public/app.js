import { decryptWalletVault, encryptWalletVault, stripWalletSecretsFromCollection } from "./vault.js";

const SCALE = 1_000_000;
let activeFee = 1_000;
let feeQuote = { economy:1_000, standard:1_000, priority:2_000 };
const walletKey = "ecoin.wallet.v1";
const walletsKey = "ecoin.wallets.v1";
const walletVaultKey = "ecoin.wallet-vault.v1";
const activeWalletKey = "ecoin.activeWallet.v1";
const contactsKey = "ecoin.contacts.v1";
const watchlistKey = "ecoin.watchlist.v1";
const watchlistSnapshotKey = "ecoin.watchlist.snapshot.v1";
const marketAlertsKey = "ecoin.marketAlerts.v1";
const walletHistoryKey = "ecoin.walletHistory.v1";
const paymentPlansKey = "ecoin.paymentPlans.v1";
const recentTransfersKey = "ecoin.recentTransfers.v1";
const transferTemplatesKey = "ecoin.transferTemplates.v1";
let wallet;
let wallets = [];
let vaultEnvelope = null;
let vaultPassword = null;
let vaultState = "none";
let currentAccount = { balance:0, nonce:0, faucetClaimed:false };
let pendingDraft = null;
let contacts = [];
let receiptCopyValue = "";
let nextBlockAt = 0;
let mempoolSize = 0;
let maxMempoolSize = 10_000;
let refreshTimer = null;
let loadedBlocks = [];
let currentPending = [];
let marketData = null;
let currentStatus = null;
let buyQuoteTimer = null;
let dataSearchTimer = null;
let watchlist = [];
let watchlistCache = [];
let watchlistSnapshot = {};
let marketAlerts = [];
let marketAlertState = {};
let walletHistoryByWallet = {};
let walletHistory = [];
let paymentPlansByWallet = {};
let paymentPlans = [];
let recentTransfersByWallet = {};
let recentTransfers = [];
let transferTemplatesByWallet = {};
let transferTemplates = [];

const $ = (selector) => document.querySelector(selector);
const format = (micro) => (micro / SCALE).toLocaleString(undefined, { minimumFractionDigits: 6, maximumFractionDigits: 6 });
const short = (value, size = 9) => value ? `${value.slice(0, size)}…${value.slice(-6)}` : "—";

function networkPressureLabel(pressure) {
  if (pressure > 0.75) return "HIGH";
  if (pressure > 0.25) return "MODERATE";
  return "LOW";
}

function recommendedFeeTier(pressure) {
  if (pressure > 0.75) return "priority";
  if (pressure > 0.25) return "standard";
  return "economy";
}

function smartReserveAmount() {
  const balance = currentAccount.balance ?? currentAccount.availableBalance ?? 0;
  const available = currentAccount.availableBalance ?? 0;
  const pressureBuffer = feeQuote.pressure > 0.75 ? 2 * SCALE : feeQuote.pressure > 0.25 ? SCALE : 0;
  const baseReserve = Math.max(SCALE, Math.floor(balance * 0.1), pressureBuffer);
  return Math.max(0, available - activeFee - baseReserve);
}

const isWalletMeta = (candidate) => candidate && typeof candidate.address === "string" && typeof candidate.name === "string" && /^ec1[0-9a-f]{38}$/.test(candidate.address);

async function api(path, options) {
  const response = await fetch(`/api${path}`, options && { ...options, headers: { "Content-Type": "application/json", ...options.headers } });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || "Node request failed");
  return value;
}

async function createWallet(name="Wallet") {
  if (!crypto.subtle) throw new Error("Secure browser cryptography is unavailable");
  const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const [publicKey, privateKey] = await Promise.all([
    crypto.subtle.exportKey("jwk", keys.publicKey),
    crypto.subtle.exportKey("jwk", keys.privateKey),
  ]);
  const address=await addressFromKey(publicKey);
  return { version:1,id:address,name,publicKey,privateKey,address,createdAt:new Date().toISOString() };
}

async function saveWallets() {
  localStorage.setItem(activeWalletKey, wallet?.address || "");
  if (vaultEnvelope) {
    if (vaultPassword) vaultEnvelope = await encryptWalletVault(wallets, vaultPassword);
    vaultEnvelope.index = stripWalletSecretsFromCollection(wallets);
    localStorage.setItem(walletVaultKey, JSON.stringify(vaultEnvelope));
    localStorage.removeItem(walletsKey);
    return;
  }
  localStorage.removeItem(walletVaultKey);
  localStorage.setItem(walletsKey, JSON.stringify(wallets));
}

function selectActiveWallet() {
  const active = localStorage.getItem(activeWalletKey);
  wallet = wallets.find((candidate) => candidate.address === active) ?? wallets[0];
}

async function loadWallets() {
  const storedVault = localStorage.getItem(walletVaultKey);
  if (storedVault) {
    vaultEnvelope = JSON.parse(storedVault);
    wallets = Array.isArray(vaultEnvelope.index) ? vaultEnvelope.index.filter(isWalletMeta) : [];
    vaultState = "locked";
    selectActiveWallet();
    if (!wallets.length) throw new Error("Encrypted wallet vault is empty");
    return;
  }
  wallets=(JSON.parse(localStorage.getItem(walletsKey))||[]).filter((candidate)=>candidate?.privateKey&&candidate?.publicKey&&/^ec1[0-9a-f]{38}$/.test(candidate.address));
  if (!wallets.length) {
    const legacy=JSON.parse(localStorage.getItem(walletKey));
    wallets=[legacy?{...legacy,id:legacy.address,name:legacy.name||"Primary"}:await createWallet("Primary")];
    localStorage.removeItem(walletKey);
  }
  vaultEnvelope = null;
  vaultPassword = null;
  vaultState = "none";
  selectActiveWallet();
  await saveWallets();
}

async function addressFromKey(jwk) {
  const bytes = fromBase64Url(jwk.x);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `ec1${[...digest].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 38)}`;
}

function paymentRequestUri(address, amount = "", memo = "") {
  const params = new URLSearchParams();
  if (amount) params.set("amount", String(amount));
  if (memo) params.set("memo", memo);
  const query = params.toString();
  return query ? `ecoin:${address}?${query}` : `ecoin:${address}`;
}

function parsePaymentRequest(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  if (text.startsWith("ecoin:")) {
    const parsed = new URL(text.replace(/^ecoin:/, "https://local/"));
    const address = parsed.pathname.replace(/^\//, "").trim();
    if (!/^ec1[0-9a-f]{38}$/.test(address)) return null;
    return {
      address,
      amount: parsed.searchParams.get("amount"),
      memo: parsed.searchParams.get("memo") ?? "",
    };
  }
  if (/^ec1[0-9a-f]{38}$/.test(text)) return { address: text, amount: "", memo: "" };
  return null;
}

function seededReceiveMatrix(seed, size = 21) {
  const bytes = [...seed].map((char) => char.charCodeAt(0));
  let state = bytes.reduce((sum, value, index) => (sum + (value << (index % 8))) >>> 0, 0x9e3779b9);
  const next = () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17; state >>>= 0;
    state ^= state << 5; state >>>= 0;
    return state / 0xffffffff;
  };
  const matrix = Array.from({ length: size }, () => Array(size).fill(false));
  const paintFinder = (row, col) => {
    for (let y = 0; y < 7; y++) {
      for (let x = 0; x < 7; x++) {
        const onEdge = x === 0 || x === 6 || y === 0 || y === 6;
        const onCore = x >= 2 && x <= 4 && y >= 2 && y <= 4;
        matrix[row + y][col + x] = onEdge || onCore;
      }
    }
  };
  paintFinder(0, 0);
  paintFinder(0, size - 7);
  paintFinder(size - 7, 0);
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (matrix[row][col] !== false) continue;
      if (row < 7 && col < 7) continue;
      if (row < 7 && col >= size - 7) continue;
      if (row >= size - 7 && col < 7) continue;
      matrix[row][col] = next() > 0.58;
    }
  }
  return matrix;
}

function canonicalTransaction(tx) {
  return JSON.stringify({ from:tx.from, to:tx.to, amount:tx.amount, fee:tx.fee, nonce:tx.nonce, memo:tx.memo ?? "", timestamp:tx.timestamp, publicKey:tx.publicKey });
}

function canonicalContractDeployment(tx) {
  return JSON.stringify({contractType:tx.contractType,from:tx.from,beneficiary:tx.beneficiary,amount:tx.amount,fee:tx.fee,nonce:tx.nonce,unlockTime:tx.unlockTime,installments:tx.installments??1,intervalMs:tx.intervalMs??0,secretHash:tx.secretHash??"",refundTime:tx.refundTime??0,memo:tx.memo??"",timestamp:tx.timestamp,publicKey:tx.publicKey});
}

function canonicalMarketOrder(order) {
  return JSON.stringify({ address:order.address, side:order.side, amount:order.amount, limitPriceMicroUsd:order.limitPriceMicroUsd, orderId:order.orderId, timestamp:order.timestamp, publicKey:order.publicKey });
}

function canonicalMarketCancel(order) {
  return JSON.stringify({ address:order.address, orderId:order.orderId, timestamp:order.timestamp, publicKey:order.publicKey });
}

async function ensureTreasuryWallet() {
  const treasury=await api("/treasury-wallet");
  if (wallets.some((candidate)=>candidate.address===treasury.address)) return;
  if (vaultState==="locked") {
    const {privateKey:_privateKey,...publicTreasury}=treasury;
    wallets.push(publicTreasury);
    return;
  }
  wallets.push({...treasury,version:1,createdAt:new Date().toISOString()});
  wallet=wallets.at(-1);
  await saveWallets();
}

async function signTransaction(tx) {
  if (!wallet?.privateKey) throw new Error("Unlock the wallet vault to sign transfers");
  const key = await crypto.subtle.importKey("jwk", wallet.privateKey, { name:"Ed25519" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(canonicalTransaction(tx)));
  return toBase64Url(new Uint8Array(signature));
}

async function signContract(tx) {
  if (!wallet?.privateKey) throw new Error("Unlock the wallet vault to deploy contracts");
  const key=await crypto.subtle.importKey("jwk",wallet.privateKey,{name:"Ed25519"},false,["sign"]);
  const signature=await crypto.subtle.sign("Ed25519",key,new TextEncoder().encode(canonicalContractDeployment(tx)));
  return toBase64Url(new Uint8Array(signature));
}

async function signMarketOrder(order) {
  if (!wallet?.privateKey) throw new Error("Unlock the wallet vault to place market orders");
  const key=await crypto.subtle.importKey("jwk",wallet.privateKey,{name:"Ed25519"},false,["sign"]);
  const signature=await crypto.subtle.sign("Ed25519",key,new TextEncoder().encode(canonicalMarketOrder(order)));
  return toBase64Url(new Uint8Array(signature));
}

async function signMarketCancel(order) {
  if (!wallet?.privateKey) throw new Error("Unlock the wallet vault to cancel market orders");
  const key=await crypto.subtle.importKey("jwk",wallet.privateKey,{name:"Ed25519"},false,["sign"]);
  const signature=await crypto.subtle.sign("Ed25519",key,new TextEncoder().encode(canonicalMarketCancel(order)));
  return toBase64Url(new Uint8Array(signature));
}

async function refresh() {
  if (!wallet) return;
  const [status, account, blocks, mempool, fees, contracts, market] = await Promise.all([api("/status"), api(`/accounts/${wallet.address}`), api("/blocks?limit=10"), api("/mempool"), api("/fees"), api(`/contracts?address=${wallet.address}`),api(`/market?address=${wallet.address}`)]);
  currentStatus=status; marketData=market;
  currentAccount = account;
  feeQuote=fees; applyFeeTier();
  nextBlockAt = status.nextBlockAt; mempoolSize = mempool.size; maxMempoolSize=status.maxMempoolSize;
  $("#balance").textContent = format(account.availableBalance);
  $("#height").textContent = mempool.size ? `BLOCK ${status.height} · ${mempool.size} PENDING` : `BLOCK ${status.height}`;
  $("#supply").textContent = `${format(status.totalSupply)} / ${format(status.maxSupply)} EC`;
  $("#burned").textContent = `${format(status.feesRecycled)} EC`;
  $("#accounts").textContent = status.accounts;
  updateBlockClock();
  $("#wallet-received").textContent = `${format(account.insights.received)} EC`;
  $("#wallet-sent").textContent = `${format(account.insights.sent)} EC`;
  $("#wallet-transactions").textContent = `${account.insights.transactionCount} TX`;
  $("#integrity").textContent = status.chainValid ? "VERIFIED" : "FAILED";
  $("#integrity").style.color = status.chainValid ? "var(--acid)" : "var(--orange)";
  $("#settled-count").textContent=status.metrics.confirmedTransactions;
  $("#average-batch").textContent=status.metrics.averageTransactionsPerBlock.toFixed(2);
  $("#block-capacity").textContent=`${status.metrics.blockCapacity} TX`;
  $("#storage-health").textContent=status.storageProtected ? "PROTECTED" : "CHECK";
  $("#transfer-rate").textContent=`${status.metrics.lifetimeTransfersPerSecond.toFixed(3)} TX/S`;
  const faucet = $("#faucet");
  const isTreasury=wallet.address===status.treasuryAddress;
  faucet.disabled = account.faucetClaimed || isTreasury;
  faucet.dataset.label = isTreasury ? "GENESIS SUPPLY" : account.faucetClaimed ? "FAUCET CLAIMED" : "GET 25 TEST EC";
  faucet.textContent = faucet.dataset.label;
  updateComposer();
  loadedBlocks=[...new Map([...blocks,...loadedBlocks].map((block)=>[block.hash,block])).values()].sort((a,b)=>b.height-a.height);
  currentPending=mempool.transactions;
  renderBlocks(loadedBlocks,currentPending); updateLoadMore();
  renderContracts(contracts);
  renderWalletIntel(status, account, contracts, market);
  recordWalletHistory(account, market, status);
  renderWalletHistory();
  renderWalletDiagnostics();
  renderPaymentPlans();
  renderData(market,status,blocks);
  await refreshWatchlist(account, contracts);
  renderEventCenter(account, contracts);
}

function renderBlocks(blocks,pending = []) {
  const pendingRows=pending.map((tx,index) => {
    const incoming=tx.to===wallet.address; const outgoing=tx.from===wallet.address;
    const label=tx.type==="contract_deploy" ? `Pending timelock ${format(tx.amount)} EC` : `Pending ${outgoing ? "send" : incoming ? "receive" : "transfer"} ${format(tx.amount)} EC`;
    return `<div class="block pending-row"><span class="pending-dot">●</span><span class="tx-type ${outgoing ? "sent" : incoming ? "mine" : ""}">${escapeHtml(label)}</span><code>${escapeHtml(short(tx.id,13))}</code><time>QUEUE ${index+1}</time></div>`;
  }).join("");
  const confirmedRows=blocks.map((block) => {
    const tx = block.transactions[0];
    const incoming = tx.to === wallet.address;
    const outgoing = tx.from === wallet.address;
    const label = tx.type === "genesis" ? "Network genesis" : tx.type === "faucet" ? `${incoming ? "Received" : "Faucet"} +${format(tx.amount)} EC` : tx.type==="market_buy" ? `Market buy +${format(tx.amount)} EC` : tx.type==="contract_deploy" ? `${tx.contractType} ${format(tx.amount)} EC` : tx.type==="contract_execute" ? `Contract release +${format(tx.amount)} EC` : tx.type==="contract_claim" ? `Hashlock claim +${format(tx.amount)} EC` : tx.type==="contract_refund" ? `Hashlock refund +${format(tx.amount)} EC` : `${outgoing ? "Sent" : incoming ? "Received" : "Transfer"} ${outgoing ? "−" : incoming ? "+" : ""}${format(tx.amount)} EC`;
    const tone = incoming ? "mine" : outgoing ? "sent" : "";
    const peer = tx.type === "transfer" ? (outgoing ? `to ${short(tx.to)}` : incoming ? `from ${short(tx.from)}` : short(block.hash, 13)) : short(block.hash, 13);
    return `<button class="block" type="button" data-height="${block.height}" aria-label="Open block ${block.height} receipt"><span class="number">#${block.height}</span><span class="tx-type ${tone}">${escapeHtml(label)}</span><code title="${block.hash}">${escapeHtml(peer)}</code><time>${relativeTime(block.timestamp)}</time></button>`;
  }).join("");
  $("#blocks").innerHTML = pendingRows + confirmedRows || '<p class="empty">No activity yet.</p>';
}

function renderContracts(contracts) {
  $("#contract-count").textContent=contracts.length;
  const locked=contracts.filter((contract)=>contract.creator===wallet.address&&["locked","vesting"].includes(contract.status)).reduce((sum,contract)=>sum+contract.amount-(contract.releasedAmount??0),0);
  $("#contract-locked").textContent=`${format(locked)} EC`;
  $("#contract-list").innerHTML=contracts.length ? contracts.map((contract)=>`<div class="contract-row"><span class="contract-status ${contract.status}">${contract.contractType.toUpperCase()} / ${contract.status.toUpperCase()}</span><span>${escapeHtml(format(contract.amount-(contract.releasedAmount??0)))} EC remaining → ${escapeHtml(short(contract.beneficiary,10))}</span><code title="${contract.address}">${escapeHtml(short(contract.address,12))}</code>${contract.contractType==="hashlock"&&contract.status==="locked"?`<button class="contract-claim" type="button" data-claim="${contract.address}">CLAIM</button>`:`<time>${contract.status==="released"?"RELEASED":contract.status==="refunded"?"REFUNDED":contract.contractType==="vesting"?`${contract.releasedInstallments}/${contract.installments} PAID`:new Date(contract.unlockTime).toLocaleDateString()}</time>`}</div>`).join("") : '<p class="empty">No contracts for this wallet yet.</p>';
}

function renderData(market,status,blocks) {
  const usd=(value,maximumFractionDigits=2)=>value.toLocaleString(undefined,{style:"currency",currency:"USD",minimumFractionDigits:maximumFractionDigits,maximumFractionDigits});
  $("#data-price").textContent=usd(market.priceUsd,6);
  $("#data-market-cap").textContent=usd(market.marketCapUsd,0);
  $("#data-volume").textContent=usd(market.volumeUsdCents/100,2);
  $("#data-circulating").textContent=`${format(market.circulating)} EC`;
  $("#data-treasury").textContent=`${format(market.treasuryBalance)} EC`;
  $("#data-purchases").textContent=market.purchases;
  $("#data-capacity").textContent=`${status.metrics.blockCapacity} TX`;
  $("#best-bid").textContent = market.bestBid ? usd(market.bestBid.limitPriceMicroUsd / 1_000_000, 6) : "—";
  $("#best-ask").textContent = market.bestAsk ? usd(market.bestAsk.limitPriceMicroUsd / 1_000_000, 6) : "—";
  $("#book-spread").textContent = market.spreadMicroUsd == null ? "—" : usd(market.spreadMicroUsd / 1_000_000, 6);
  $("#open-orders").textContent = `${market.openOrders ?? 0} OPEN`;
  renderOrderBook(market);
  const priceValues=(market.history.length?market.history:[{priceMicroUsd:market.priceMicroUsd}]).map((entry)=>entry.priceMicroUsd/1_000_000);
  const points=chartPoints(priceValues,720,260,24); $("#price-chart polyline").setAttribute("points",points.line); $("#price-chart .area").setAttribute("d",`${points.path} L 696 236 L 24 236 Z`);
  $("#price-min").textContent=usd(Math.min(...priceValues),6); $("#price-max").textContent=usd(Math.max(...priceValues),6);
  const change=priceValues.at(-1)-priceValues[0]; $("#price-change").textContent=`${change>=0?"+":""}${usd(change,6)} SINCE FIRST TRADE`;
  const blockValues=[...blocks].reverse().map((block)=>block.transactions.length); const max=Math.max(1,...blockValues);
  $("#load-chart .bars").innerHTML=blockValues.map((value,index)=>{const width=620/Math.max(1,blockValues.length); const height=value/max*200; return `<rect x="${40+index*width}" y="${230-height}" width="${Math.max(3,width-5)}" height="${height}" rx="2"></rect>`;}).join("");
  for (const svg of [$("#price-chart"),$("#load-chart")]) svg.querySelector(".chart-gridlines").innerHTML=[55,115,175,235].map((y)=>`<line x1="24" y1="${y}" x2="696" y2="${y}"></line>`).join("");
  $("#market-history").innerHTML=market.history.length?market.history.slice().reverse().map((entry)=>`<div class="market-row"><span>${usd(entry.priceMicroUsd/1_000_000,6)}</span><b>${escapeHtml(format(entry.amount))} EC / ${usd(entry.usdCents/100,2)}</b><code>${entry.kind === "order_trade" ? "ORDER TRADE" : `BLOCK #${entry.blockHeight}`}</code><time>${relativeTime(entry.timestamp)}</time></div>`).join(""):'<p class="empty">No market purchases yet.</p>';
  renderDataIntelligence(market, status, blocks, priceValues);
}

function renderOrderBook(market) {
  const usd = (value, maximumFractionDigits = 6) => value.toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: maximumFractionDigits, maximumFractionDigits });
  const renderLevel = (level, side) => `<article class="book-row ${side}"><div><b>${side === "buy" ? "BID" : "ASK"} ${usd(level.priceMicroUsd / 1_000_000, 6)}</b><p>${escapeHtml(format(level.amount))} EC · ${level.orders} order${level.orders === 1 ? "" : "s"}</p></div></article>`;
  $("#bid-book").innerHTML = market.orderBook?.bids?.length ? market.orderBook.bids.map((level) => renderLevel(level, "buy")).join("") : '<p class="empty">No bids yet.</p>';
  $("#ask-book").innerHTML = market.orderBook?.asks?.length ? market.orderBook.asks.map((level) => renderLevel(level, "sell")).join("") : '<p class="empty">No asks yet.</p>';
  $("#your-orders").innerHTML = market.yourOrders?.length ? market.yourOrders.map((order) => `
    <article class="book-row ${order.side}">
      <div>
        <b>${escapeHtml(order.side.toUpperCase())} ${usd(order.limitPriceMicroUsd / 1_000_000, 6)}</b>
        <p>${escapeHtml(format(order.remaining))} EC remaining · ${escapeHtml(order.status.toUpperCase())}</p>
      </div>
      <button type="button" data-order-cancel="${escapeHtml(order.orderId || order.id)}">CANCEL</button>
    </article>`).join("") : '<p class="empty">No open orders yet.</p>';
  $("#trade-tape").innerHTML = market.trades?.length ? market.trades.map((trade) => `
    <article class="book-row trade">
      <div>
        <b>${escapeHtml(usd(trade.priceMicroUsd / 1_000_000, 6))} · ${escapeHtml(format(trade.amount))} EC</b>
        <p>Buyer ${escapeHtml(short(trade.buyAddress, 8))} · Seller ${escapeHtml(short(trade.sellAddress, 8))} · ${escapeHtml(usd(trade.usdCents / 100, 2))}</p>
      </div>
    </article>`).join("") : '<p class="empty">No trades yet.</p>';
}

function renderWalletIntel(status, account, contracts, market) {
  const pressureLabel = networkPressureLabel(feeQuote.pressure);
  const recommendedTier = recommendedFeeTier(feeQuote.pressure);
  const safeSpend = smartReserveAmount();
  const lockedContracts = contracts.filter((contract) => contract.creator === wallet.address && ["locked", "vesting", "hashlock"].includes(contract.status)).length;
  const suggestions = buildWalletSuggestions(status, account, contracts, market, safeSpend, pressureLabel, recommendedTier, lockedContracts);
  const topCounterparties = (account.insights.topCounterparties ?? []).slice(0, 3).map((entry) => short(entry.address, 8)).join(" · ") || "NONE";
  const nextEvent = summarizeNextEvent(contracts);
  const readiness = vaultState === "locked"
    ? "UNLOCK VAULT"
    : safeSpend > 0
      ? "READY TO SEND"
      : "TOP UP FIRST";
  const guidance = vaultState === "locked"
    ? "Unlock the encrypted vault to sign transfers, deploy contracts, and send claims."
    : safeSpend > 0
      ? `Keep ${format(Math.max(SCALE, Math.floor((account.balance ?? 0) * 0.1)))} EC in reserve. ${account.pendingOutgoing || 0} pending outgoing, ${lockedContracts} active contracts, and ${pressureLabel.toLowerCase()} network pressure shape the safest path.`
      : "This wallet is too close to zero for a comfortable send. Add funds or wait for incoming settlement before moving value.";
  $("#wallet-safe-spend").textContent = `${format(safeSpend)} EC`;
  $("#wallet-fee-advice").textContent = `${recommendedTier.toUpperCase()} / ${format(feeQuote[recommendedTier] ?? feeQuote.standard)} EC`;
  $("#wallet-pressure").textContent = `${pressureLabel} / ${(feeQuote.pressure * 100).toFixed(0)}%`;
  $("#wallet-readiness").textContent = readiness;
  $("#wallet-counterparties").textContent = topCounterparties;
  $("#wallet-next-event").textContent = nextEvent;
  $("#wallet-guidance").textContent = guidance;
  renderWalletActions(suggestions);
  $("#fee-advice").textContent = `RECOMMENDED ${recommendedTier.toUpperCase()}`;
  $("#fee-advice").className = recommendedTier === $("#fee-tier").value ? "match" : "notice";
  $("#fee-tier").title = `Suggested tier: ${recommendedTier.toUpperCase()} based on current network pressure and block capacity.`;
  $("#wallet-guidance").title = `Market price: ${market.priceUsd.toFixed(6)} USD per EC`;
  $("#wallet-safe-spend").title = "Balance that keeps a reserve after the current fee and a network buffer";
}

function buildWalletSuggestions(status, account, contracts, market, safeSpend, pressureLabel, recommendedTier, lockedContracts) {
  const suggestions = [];
  const topCounterparty = account.insights.topCounterparties?.[0];
  const topIsWatched = topCounterparty ? watchlist.includes(topCounterparty.address) : false;
  if (vaultState !== "locked" && wallets.some((candidate) => !candidate.privateKey)) {
    suggestions.push({
      title: "Protect the keys",
      text: "Enable the encrypted vault so local private keys are protected before the next send.",
      action: { label: "ENABLE VAULT", type: "vault" },
    });
  }
  if (vaultState === "locked") {
    suggestions.push({
      title: "Unlock to act",
      text: "The vault is locked, so signing, claims, and contract deployment are paused.",
      action: { label: "UNLOCK", type: "vault" },
    });
  }
  if (safeSpend > 0) {
    suggestions.push({
      title: "Use a safe amount",
      text: `You can send ${format(safeSpend)} EC while keeping a reserve for fees and volatility.`,
      action: { label: "SAFE MAX", type: "smart-max" },
    });
  }
  if (feeQuote.pressure > 0.75) {
    suggestions.push({
      title: "Network pressure",
      text: "Pressure is high, so the economy tier may be the cheaper choice if speed is not urgent.",
      action: { label: "SET ECONOMY", type: "fee", value: "economy" },
    });
  } else if (recommendedTier !== $("#fee-tier").value) {
    suggestions.push({
      title: "Fee alignment",
      text: `The wallet recommends the ${recommendedTier} fee tier for the current network state.`,
      action: { label: `USE ${recommendedTier.toUpperCase()}`, type: "fee", value: recommendedTier },
    });
  }
  if (topCounterparty && !topIsWatched) {
    suggestions.push({
      title: "Watch a counterparty",
      text: `${short(topCounterparty.address, 10)} is your most active peer. Track it for balance changes.`,
      action: { label: "WATCH", type: "watch", address: topCounterparty.address },
    });
  } else if (topCounterparty) {
    suggestions.push({
      title: "Peer already tracked",
      text: `${short(topCounterparty.address, 10)} is already on your watchlist, so changes are easier to notice.`,
      action: { label: "SEE WATCHLIST", type: "scroll-watchlist" },
    });
  }
  if (lockedContracts > 0) {
    suggestions.push({
      title: "Upcoming contract flow",
      text: `You have ${lockedContracts} active contract${lockedContracts === 1 ? "" : "s"} that will settle automatically.`,
      action: { label: "VIEW CONTRACTS", type: "scroll-contracts" },
    });
  }
  if (account.availableBalance < 5 * SCALE) {
    suggestions.push({
      title: "Low balance",
      text: "Consider a faucet claim or a treasury purchase before you send again.",
      action: { label: "BUY EC", type: "buy" },
    });
  }
  if (!suggestions.length) {
    suggestions.push({
      title: "All clear",
      text: `The wallet looks healthy. Market price is ${market.priceUsd.toFixed(6)} USD per EC and the current setup is stable.`,
      action: { label: "REFRESH", type: "refresh" },
    });
  }
  return suggestions.slice(0, 4);
}

function renderWalletActions(suggestions) {
  const panel = $("#wallet-actions");
  if (!panel) return;
  if (!suggestions.length) {
    panel.innerHTML = '<p class="empty">No suggestions yet.</p>';
    return;
  }
  panel.innerHTML = suggestions.map((item, index) => `
    <article class="wallet-action">
      <div>
        <b>${escapeHtml(item.title)}</b>
        <p>${escapeHtml(item.text)}</p>
      </div>
      <button type="button" data-wallet-action="${escapeHtml(item.action.type)}" data-wallet-action-value="${escapeHtml(item.action.value ?? "")}" data-wallet-action-address="${escapeHtml(item.action.address ?? "")}" data-wallet-action-index="${index}">${escapeHtml(item.action.label)}</button>
    </article>`).join("");
}

function loadWatchlist() {
  watchlist = [...new Set((JSON.parse(localStorage.getItem(watchlistKey)) || []))]
    .filter((address) => /^ec1[0-9a-f]{38}$/.test(address));
}

function loadWatchlistSnapshot() {
  try {
    watchlistSnapshot = JSON.parse(localStorage.getItem(watchlistSnapshotKey) || "{}") || {};
  } catch {
    watchlistSnapshot = {};
  }
}

function loadRecentTransfers() {
  try {
    recentTransfersByWallet = JSON.parse(localStorage.getItem(recentTransfersKey) || "{}") || {};
  } catch {
    recentTransfersByWallet = {};
  }
  recentTransfers = Array.isArray(recentTransfersByWallet[wallet?.address]) ? recentTransfersByWallet[wallet.address] : [];
}

function loadTransferTemplates() {
  try {
    transferTemplatesByWallet = JSON.parse(localStorage.getItem(transferTemplatesKey) || "{}") || {};
  } catch {
    transferTemplatesByWallet = {};
  }
  transferTemplates = Array.isArray(transferTemplatesByWallet[wallet?.address]) ? transferTemplatesByWallet[wallet.address] : [];
}

function loadMarketAlerts() {
  try {
    marketAlerts = (JSON.parse(localStorage.getItem(marketAlertsKey) || "[]") || [])
      .filter((alert) => alert && typeof alert.priceUsd === "number" && alert.priceUsd > 0 && ["above", "below"].includes(alert.direction))
      .map((alert) => ({
        id: typeof alert.id === "string" ? alert.id : crypto.randomUUID(),
        name: typeof alert.name === "string" ? alert.name : "",
        direction: alert.direction,
        priceUsd: Number(alert.priceUsd),
        createdAt: Number(alert.createdAt) || Date.now(),
        triggered: Boolean(alert.triggered),
        lastTriggeredAt: Number(alert.lastTriggeredAt) || null,
      }));
  } catch {
    marketAlerts = [];
  }
  marketAlertState = Object.fromEntries(marketAlerts.map((alert) => [alert.id, Boolean(alert.triggered)]));
}

function loadWalletHistory() {
  try {
    walletHistoryByWallet = JSON.parse(localStorage.getItem(walletHistoryKey) || "{}") || {};
  } catch {
    walletHistoryByWallet = {};
  }
  walletHistory = Array.isArray(walletHistoryByWallet[wallet?.address]) ? walletHistoryByWallet[wallet.address] : [];
}

function loadPaymentPlans() {
  try {
    paymentPlansByWallet = JSON.parse(localStorage.getItem(paymentPlansKey) || "{}") || {};
  } catch {
    paymentPlansByWallet = {};
  }
  paymentPlans = Array.isArray(paymentPlansByWallet[wallet?.address]) ? paymentPlansByWallet[wallet.address] : [];
}

function saveWatchlist() {
  localStorage.setItem(watchlistKey, JSON.stringify(watchlist));
}

function saveWatchlistSnapshot() {
  const snapshot = {};
  for (const entry of watchlistCache) {
    snapshot[entry.address] = {
      balance: entry.account?.availableBalance ?? null,
      contracts: entry.contracts?.length ?? 0,
      txCount: entry.account?.insights?.transactionCount ?? 0,
      nonce: entry.account?.nonce ?? 0,
    };
  }
  watchlistSnapshot = snapshot;
  localStorage.setItem(watchlistSnapshotKey, JSON.stringify(snapshot));
}

function saveRecentTransfers() {
  if (!wallet?.address) return;
  recentTransfersByWallet[wallet.address] = recentTransfers.slice(0, 8);
  localStorage.setItem(recentTransfersKey, JSON.stringify(recentTransfersByWallet));
}

function saveTransferTemplates() {
  if (!wallet?.address) return;
  transferTemplatesByWallet[wallet.address] = transferTemplates.slice(0, 12);
  localStorage.setItem(transferTemplatesKey, JSON.stringify(transferTemplatesByWallet));
}

function saveMarketAlerts() {
  localStorage.setItem(marketAlertsKey, JSON.stringify(marketAlerts.slice(0, 12)));
}

function saveWalletHistory() {
  if (!wallet?.address) return;
  walletHistoryByWallet[wallet.address] = walletHistory.slice(0, 60);
  localStorage.setItem(walletHistoryKey, JSON.stringify(walletHistoryByWallet));
}

function savePaymentPlans() {
  if (!wallet?.address) return;
  paymentPlansByWallet[wallet.address] = paymentPlans.slice(0, 24);
  localStorage.setItem(paymentPlansKey, JSON.stringify(paymentPlansByWallet));
}

function recordWalletHistory(account, market, status) {
  if (!wallet?.address || !account || !market || !status) return;
  const snapshot = {
    timestamp: Date.now(),
    balance: Number(account.availableBalance ?? 0),
    sent: Number(account.insights?.sent ?? 0),
    received: Number(account.insights?.received ?? 0),
    transactions: Number(account.insights?.transactionCount ?? 0),
    pressure: Number(feeQuote.pressure ?? 0),
    marketPriceUsd: Number(market.priceUsd ?? 0),
    health: status.chainValid ? 1 : 0,
  };
  const previous = walletHistory[0];
  if (previous && previous.balance === snapshot.balance && previous.marketPriceUsd === snapshot.marketPriceUsd && previous.sent === snapshot.sent && previous.received === snapshot.received) return;
  walletHistory = [snapshot, ...walletHistory.filter((entry) => entry.timestamp !== snapshot.timestamp)].slice(0, 60);
  saveWalletHistory();
}

function renderWalletHistory() {
  const points = walletHistory.slice().reverse();
  const chart = $("#wallet-history-chart");
  const count = $("#wallet-history-count");
  const delta = $("#wallet-history-delta");
  const range = $("#wallet-history-range");
  const minLabel = $("#wallet-history-min");
  const maxLabel = $("#wallet-history-max");
  if (!chart || !count || !delta || !range || !minLabel || !maxLabel) return;
  count.textContent = String(walletHistory.length);
  if (points.length < 2) {
    delta.textContent = "—";
    range.textContent = "—";
    minLabel.textContent = "—";
    maxLabel.textContent = "—";
    chart.querySelector("polyline").setAttribute("points", "");
    chart.querySelector(".area").setAttribute("d", "");
    chart.querySelector(".chart-gridlines").innerHTML = "";
    return;
  }
  const balances = points.map((entry) => entry.balance / SCALE);
  const min = Math.min(...balances);
  const max = Math.max(...balances);
  const first = balances[0];
  const last = balances.at(-1);
  const deltaPct = first ? ((last - first) / first) * 100 : 0;
  delta.textContent = `${deltaPct >= 0 ? "+" : ""}${deltaPct.toFixed(1)}%`;
  range.textContent = `${format(Math.round(max * SCALE))} / ${format(Math.round(min * SCALE))} EC`;
  minLabel.textContent = `${format(Math.round(min * SCALE))} EC`;
  maxLabel.textContent = `${format(Math.round(max * SCALE))} EC`;
  const width = 720;
  const height = 200;
  const padding = 18;
  const span = Math.max(max - min, 0.000001);
  const coordinates = balances.map((value, index) => {
    const x = padding + (balances.length === 1 ? (width - padding * 2) / 2 : index * (width - padding * 2) / Math.max(balances.length - 1, 1));
    const y = height - padding - ((value - min) / span) * (height - padding * 2);
    return [x, y];
  });
  const line = coordinates.map(([x, y]) => `${x},${y}`).join(" ");
  const area = `M ${coordinates[0][0]} ${height - padding} ${coordinates.map(([x, y]) => `L ${x} ${y}`).join(" ")} L ${coordinates.at(-1)[0]} ${height - padding} Z`;
  chart.querySelector("polyline").setAttribute("points", line);
  chart.querySelector(".area").setAttribute("d", area);
  chart.querySelector(".chart-gridlines").innerHTML = [0.25, 0.5, 0.75].map((fraction) => `<line x1="18" y1="${18 + (height - 36) * fraction}" x2="${width - 18}" y2="${18 + (height - 36) * fraction}"></line>`).join("");
}

function cadenceToMs(cadence) {
  if (cadence === "daily") return 24 * 60 * 60 * 1000;
  if (cadence === "weekly") return 7 * 24 * 60 * 60 * 1000;
  if (cadence === "monthly") return 30 * 24 * 60 * 60 * 1000;
  return 0;
}

function formatPlanTime(timestamp) {
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : "—";
}

function fillPlanDraft(plan) {
  $("#recipient").value = plan.recipient;
  $("#amount").value = (plan.amount / SCALE).toFixed(6);
  $("#memo").value = plan.memo ?? "";
  updateComposer();
  toast(`Loaded plan ${plan.name}`);
}

function createPaymentPlan() {
  const name = $("#plan-name").value.trim();
  const recipient = $("#plan-recipient").value.trim();
  const amount = Math.round(Number($("#plan-amount").value) * SCALE);
  const cadence = $("#plan-cadence").value || "weekly";
  const nextRunAt = new Date($("#plan-next-run").value || Date.now()).getTime();
  const memo = $("#plan-memo").value.trim();
  if (!name) throw new Error("Plan name cannot be blank");
  if (!/^ec1[0-9a-f]{38}$/.test(recipient)) throw new Error("Enter a valid recipient address");
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("Enter a valid amount");
  const plan = {
    id: crypto.randomUUID(),
    name,
    recipient,
    amount,
    cadence,
    memo,
    nextRunAt: Number.isFinite(nextRunAt) ? nextRunAt : Date.now(),
    createdAt: Date.now(),
    lastReminderAt: 0,
    lastCompletedAt: null,
    paused: false,
  };
  paymentPlans = [plan, ...paymentPlans];
  savePaymentPlans();
  renderPaymentPlans();
  return plan;
}

function renderPaymentPlans() {
  const summary = $("#plan-summary");
  const list = $("#plan-list");
  if (!summary || !list) return;
  if (!paymentPlans.length) {
    summary.textContent = "Create a reminder for future transfers or repeatable payments.";
    list.innerHTML = '<p class="empty">No payment plans yet.</p>';
    return;
  }
  const now = Date.now();
  const nextDue = [...paymentPlans].filter((plan) => !plan.paused).sort((a, b) => a.nextRunAt - b.nextRunAt)[0];
  summary.textContent = `${paymentPlans.length} plan${paymentPlans.length === 1 ? "" : "s"} · next due ${nextDue ? formatPlanTime(nextDue.nextRunAt) : "none"}`;
  list.innerHTML = paymentPlans.map((plan) => {
    const contact = contacts.find((item) => item.address === plan.recipient);
    const label = contact?.name ?? short(plan.recipient, 10);
    const overdue = !plan.paused && plan.nextRunAt <= now;
    return `<article class="plan-item ${overdue ? "overdue" : ""}"><div><b>${escapeHtml(plan.name)}</b><p>${escapeHtml(label)} · ${escapeHtml(format(plan.amount))} EC · ${escapeHtml(plan.cadence.toUpperCase())}${plan.memo ? ` · ${escapeHtml(plan.memo)}` : ""}</p><div class="plan-meta"><span>NEXT ${escapeHtml(formatPlanTime(plan.nextRunAt))}</span><span>${plan.paused ? "PAUSED" : overdue ? "DUE NOW" : "SCHEDULED"}</span></div></div><div><button type="button" data-plan-fill="${escapeHtml(plan.id)}">FILL</button> <button type="button" data-plan-complete="${escapeHtml(plan.id)}">${plan.cadence === "once" ? "DONE" : "COMPLETE"}</button> <button type="button" data-plan-toggle="${escapeHtml(plan.id)}">${plan.paused ? "RESUME" : "PAUSE"}</button> <button type="button" data-plan-remove="${escapeHtml(plan.id)}">REMOVE</button></div></article>`;
  }).join("");
  for (const plan of paymentPlans) {
    if (!plan.paused && plan.nextRunAt <= now && plan.lastReminderAt !== plan.nextRunAt) {
      plan.lastReminderAt = plan.nextRunAt;
      toast(`Plan due: ${plan.name}`);
    }
  }
  savePaymentPlans();
}

function renderWalletDiagnostics() {
  const samples = walletHistory.slice().reverse().map((entry) => entry.balance / SCALE);
  const mean = samples.length ? samples.reduce((sum, value) => sum + value, 0) / samples.length : currentAccount.availableBalance / SCALE;
  const volatility = samples.length > 1
    ? Math.sqrt(samples.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / samples.length)
    : 0;
  const netShift = samples.length > 1 ? samples.at(-1) - samples[0] : 0;
  const avgBalance = mean;
  const historyDepth = walletHistory.length;
  const vaultPenalty = vaultState === "locked" ? 0 : 20;
  const concentrationPenalty = Math.min(20, (currentAccount.insights?.topCounterparties?.length ?? 0) * 3);
  const balancePenalty = avgBalance < 1 ? 20 : avgBalance < 25 ? 10 : 0;
  const riskScore = Math.max(0, Math.min(100, Math.round(100 - vaultPenalty - concentrationPenalty - balancePenalty - Math.min(15, volatility / Math.max(avgBalance, 1) * 100))));
  const volatilityLabel = !samples.length ? "NO DATA" : volatility < 1 ? "CALM" : volatility < 5 ? "ACTIVE" : "VOLATILE";
  $("#wallet-volatility").textContent = `${volatilityLabel}${samples.length > 1 ? ` / ${volatility.toFixed(2)} EC` : ""}`;
  $("#wallet-net-shift").textContent = samples.length > 1 ? `${netShift >= 0 ? "+" : ""}${netShift.toFixed(2)} EC` : "—";
  $("#wallet-avg-balance").textContent = `${avgBalance.toFixed(2)} EC`;
  $("#wallet-risk-score").textContent = `${riskScore}/100`;
  const advice = riskScore >= 80
    ? "This wallet looks healthy: enough history, moderate usage, and a reasonable local security posture."
    : riskScore >= 50
      ? "This wallet is usable, but the posture is still improving. Keep backups offline and avoid large unsignaled transfers."
      : "This wallet needs more care. Lock the vault, verify backups, and avoid moving large amounts until the profile is steadier.";
  $("#wallet-diagnostics-copy").textContent = `${advice} ${historyDepth ? `We have ${historyDepth} local snapshot${historyDepth === 1 ? "" : "s"} to analyze.` : "Take a few actions and the diagnostics will become more useful."}`;
}

function renderReceivePanel() {
  const code = $("#receive-code");
  const uriNode = $("#receive-uri");
  const addressNode = $("#receive-address");
  if (!code || !uriNode || !addressNode || !wallet?.address) return;
  const uri = paymentRequestUri(wallet.address);
  uriNode.textContent = uri;
  uriNode.title = uri;
  addressNode.textContent = wallet.address;
  addressNode.title = wallet.address;
  const matrix = seededReceiveMatrix(wallet.address);
  const size = 21;
  const cell = 9;
  const margin = 15;
  const white = "#ffffff";
  const dark = "#0b0f0d";
  code.setAttribute("viewBox", `0 0 ${size * cell + margin * 2} ${size * cell + margin * 2}`);
  code.innerHTML = `<rect width="100%" height="100%" fill="${white}"></rect>${matrix.map((row, y) => row.map((on, x) => on ? `<rect x="${margin + x * cell}" y="${margin + y * cell}" width="${cell}" height="${cell}" rx="1" fill="${dark}"></rect>` : "").join("")).join("")}`;
}

function recordRecentTransfer(tx) {
  if (!tx || tx.from !== wallet.address || tx.type !== "transfer") return;
  const entry = {
    to: tx.to,
    amount: tx.amount,
    memo: tx.memo ?? "",
    fee: tx.fee ?? activeFee,
    tier: $("#fee-tier")?.value ?? "standard",
    timestamp: Date.now(),
  };
  recentTransfers = [entry, ...recentTransfers.filter((item) => !(item.to === entry.to && item.amount === entry.amount && item.memo === entry.memo))].slice(0, 8);
  saveRecentTransfers();
  renderRecentTransfers();
}

function fillTransferDraft(entry) {
  $("#recipient").value = entry.to;
  $("#amount").value = (entry.amount / SCALE).toFixed(6);
  $("#memo").value = entry.memo ?? "";
  if (entry.tier) {
    $("#fee-tier").value = entry.tier;
    applyFeeTier();
  }
  updateComposer();
  toast("Transfer draft restored");
}

function renderRecentTransfers() {
  const summary = $("#transfer-summary");
  const list = $("#transfer-list");
  if (!summary || !list) return;
  if (!recentTransfers.length) {
    summary.textContent = "No recent transfers yet.";
    list.innerHTML = '<p class="empty">Recent outgoing transfers will appear here for one-click reuse.</p>';
    return;
  }
  summary.textContent = `${recentTransfers.length} recent transfer${recentTransfers.length === 1 ? "" : "s"} ready to reuse`;
  list.innerHTML = recentTransfers.map((entry) => {
    const contact = contacts.find((item) => item.address === entry.to);
    const label = contact?.name ?? short(entry.to, 10);
    return `<article class="transfer-item"><div><b>${escapeHtml(label)}</b><p>${escapeHtml(format(entry.amount))} EC · fee ${escapeHtml(format(entry.fee ?? activeFee))} · ${escapeHtml(entry.memo ? entry.memo : "No memo")}</p></div><button type="button" data-transfer-fill="${escapeHtml(entry.to)}" data-transfer-amount="${escapeHtml(String(entry.amount))}" data-transfer-memo="${escapeHtml(entry.memo ?? "")}" data-transfer-tier="${escapeHtml(entry.tier ?? "standard")}">FILL</button></article>`;
  }).join("");
}

function renderMarketAlerts(market) {
  const summary = $("#market-alert-summary");
  const list = $("#market-alert-list");
  if (!summary || !list) return;
  const price = Number(market?.priceUsd ?? 0);
  if (!marketAlerts.length) {
    summary.textContent = "Create a trigger for the current market quote.";
    list.innerHTML = '<p class="empty">No market alerts yet.</p>';
    return;
  }
  let triggeredCount = 0;
  const rows = marketAlerts.map((alert) => {
    const crossed = alert.direction === "above" ? price >= alert.priceUsd : price <= alert.priceUsd;
    const wasCrossed = Boolean(marketAlertState[alert.id]);
    if (crossed) {
      triggeredCount++;
      if (!wasCrossed) {
        marketAlertState[alert.id] = true;
        alert.triggered = true;
        alert.lastTriggeredAt = Date.now();
        toast(`${alert.name ? `${alert.name}: ` : ""}${alert.direction === "above" ? "Price rose above" : "Price fell below"} ${usd(alert.priceUsd, 6)}`);
      }
    } else {
      marketAlertState[alert.id] = false;
    }
    const status = crossed ? "TRIGGERED" : alert.direction === "above" ? "WAITING TO RISE" : "WAITING TO FALL";
    const detail = alert.name ? `${alert.name} · ` : "";
    return `<article class="alert-item ${crossed ? "soon" : ""}"><div><b>${escapeHtml(detail + status)}</b><p>${escapeHtml(alert.direction === "above" ? `Alert when EC rises above ${usd(alert.priceUsd, 6)}` : `Alert when EC falls below ${usd(alert.priceUsd, 6)}`)}</p></div><div><span>${escapeHtml(relativeTime(alert.createdAt))}</span></div><button type="button" data-market-alert-remove="${escapeHtml(alert.id)}">REMOVE</button></article>`;
  }).join("");
  summary.textContent = `${marketAlerts.length} alert${marketAlerts.length === 1 ? "" : "s"} · ${triggeredCount} triggered at ${usd(price, 6)}`;
  list.innerHTML = rows || '<p class="empty">No market alerts yet.</p>';
}

function createTransferTemplate(name) {
  const recipient = $("#recipient").value.trim();
  const amount = Math.round(Number($("#amount").value) * SCALE);
  const memo = $("#memo").value.trim();
  const tier = $("#fee-tier").value || "standard";
  if (!name.trim()) throw new Error("Template name cannot be blank");
  if (!/^ec1[0-9a-f]{38}$/.test(recipient)) throw new Error("Enter a valid recipient before saving a template");
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("Enter a valid amount before saving a template");
  const normalizedName = name.trim();
  const existing = transferTemplates.find((item) => item.name.toLowerCase() === normalizedName.toLowerCase());
  const template = {
    id: existing?.id ?? crypto.randomUUID(),
    name: normalizedName,
    recipient,
    amount,
    memo,
    tier,
    createdAt: existing?.createdAt ?? Date.now(),
    uses: existing?.uses ?? 0,
  };
  transferTemplates = existing
    ? transferTemplates.map((item) => item.id === existing.id ? template : item)
    : [template, ...transferTemplates];
  saveTransferTemplates();
  renderTransferTemplates();
  return template;
}

function renderTransferTemplates() {
  const summary = $("#template-summary");
  const list = $("#template-list");
  if (!summary || !list) return;
  if (!transferTemplates.length) {
    summary.textContent = "Save a filled transfer to reuse it later.";
    list.innerHTML = '<p class="empty">No templates yet.</p>';
    return;
  }
  summary.textContent = `${transferTemplates.length} template${transferTemplates.length === 1 ? "" : "s"} available`;
  list.innerHTML = transferTemplates.map((template) => {
    const contact = contacts.find((item) => item.address === template.recipient);
    const label = contact?.name ?? short(template.recipient, 10);
    return `<article class="template-item"><div><b>${escapeHtml(template.name)}</b><p>${escapeHtml(label)} · ${escapeHtml(format(template.amount))} EC · ${escapeHtml(template.memo || "No memo")} · ${escapeHtml(String(template.uses ?? 0))} uses</p></div><button type="button" data-template-fill="${escapeHtml(template.id)}">FILL</button><button type="button" data-template-remove="${escapeHtml(template.id)}">REMOVE</button></article>`;
  }).join("");
}

function applyTransferTemplate(templateId) {
  const template = transferTemplates.find((item) => item.id === templateId);
  if (!template) throw new Error("Template not found");
  $("#recipient").value = template.recipient;
  $("#amount").value = (template.amount / SCALE).toFixed(6);
  $("#memo").value = template.memo ?? "";
  $("#fee-tier").value = template.tier ?? "standard";
  applyFeeTier();
  updateComposer();
  template.uses = (template.uses ?? 0) + 1;
  saveTransferTemplates();
  renderTransferTemplates();
  toast(`Loaded template ${template.name}`);
}

function addWatchAddress(address) {
  const normalized = address.trim();
  if (!/^ec1[0-9a-f]{38}$/.test(normalized)) throw new Error("Enter a valid E-Coin address");
  if (watchlist.includes(normalized)) return false;
  watchlist.unshift(normalized);
  watchlist = watchlist.slice(0, 20);
  saveWatchlist();
  return true;
}

async function refreshWatchlist(account, walletContracts = []) {
  if (!watchlist.length) {
    watchlistCache = [];
    renderWatchlist(account);
    saveWatchlistSnapshot();
    return;
  }
  const addresses = watchlist.filter((address) => address !== wallet.address);
  const details = await Promise.all(addresses.map(async (address) => {
    const [acct, contracts] = await Promise.all([
      api(`/accounts/${address}`),
      api(`/contracts?address=${address}`),
    ]);
    return { address, account: acct, contracts };
  }));
  watchlistCache = [{ address: wallet.address, account, contracts: walletContracts }, ...details];
  renderWatchlist(account);
  saveWatchlistSnapshot();
}

function renderWatchlist(account) {
  const summary = $("#watchlist-summary");
  const alerts = $("#watchlist-alerts");
  const list = $("#watchlist-list");
  if (!watchlist.length) {
    summary.textContent = "Add addresses you want to track across the ledger.";
    alerts.innerHTML = "";
    list.innerHTML = '<p class="empty">No watched addresses yet.</p>';
    return;
  }
  const totalBalance = watchlistCache.reduce((sum, entry) => sum + (entry.account?.availableBalance ?? 0), 0);
  const activeContracts = watchlistCache.reduce((sum, entry) => sum + (entry.contracts?.length ?? 0), 0);
  const movedAddresses = watchlist
    .map((address) => {
      const cached = watchlistCache.find((entry) => entry.address === address);
      const balance = address === wallet.address ? (account?.availableBalance ?? null) : cached?.account?.availableBalance ?? null;
      const priorBalance = watchlistSnapshot[address]?.balance ?? null;
      if (!Number.isFinite(balance) || !Number.isFinite(priorBalance)) return null;
      return balance - priorBalance;
    })
    .filter((delta) => delta && Math.abs(delta) > 0);
  const movedCount = movedAddresses.length;
  summary.textContent = `${watchlistCache.length} watched address${watchlistCache.length === 1 ? "" : "es"} · ${format(totalBalance)} EC tracked · ${activeContracts} visible contracts${movedCount ? ` · ${movedCount} changed` : ""}`;
  const alertsList = [];
  if ((account?.pendingOutgoing ?? 0) > 0) alertsList.push({ tone: "warning", label: "Your wallet", text: `${account.pendingOutgoing} pending outgoing transfer${account.pendingOutgoing === 1 ? "" : "s"} still reserve balance.` });
  if ((account?.availableBalance ?? 0) > 0 && (account?.availableBalance ?? 0) < 5 * SCALE) alertsList.push({ tone: "warning", label: "Low balance", text: "Your available balance is below 5 EC. Consider topping up before sending again." });
  if (movedCount) {
    const movedText = movedAddresses.slice(0, 3).map((delta) => `${delta > 0 ? "+" : ""}${format(Math.abs(delta))} EC`).join(" · ");
    alertsList.push({ tone: "good", label: "Watchlist movement", text: `${movedCount} tracked address${movedCount === 1 ? "" : "es"} changed since the previous refresh: ${movedText}` });
  } else {
    alertsList.push({ tone: "good", label: "Stable snapshot", text: "No watched balances changed since the previous refresh." });
  }
  alerts.innerHTML = alertsList.map((alert) => `<div class="watch-alert ${alert.tone}"><span>${escapeHtml(alert.label)}</span><b>${escapeHtml(alert.text)}</b></div>`).join("");
  const rows = watchlist.map((address) => {
    const cached = watchlistCache.find((entry) => entry.address === address);
    const balance = address === wallet.address ? (account?.availableBalance ?? null) : cached?.account?.availableBalance ?? null;
    const txCount = address === wallet.address ? (account?.insights?.transactionCount ?? null) : cached?.account?.insights?.transactionCount ?? null;
    const nonce = address === wallet.address ? (account?.nonce ?? null) : cached?.account?.nonce ?? null;
    const contractCount = address === wallet.address ? (cacheContractsCount() ?? 0) : cached?.contracts?.length ?? 0;
    const label = address === wallet.address ? "ACTIVE WALLET" : balance == null ? "PENDING" : balance > 0 ? "HEALTHY" : "EMPTY";
    const history = txCount == null ? "loading..." : `${txCount} tx · nonce ${nonce}`;
    const priorBalance = watchlistSnapshot[address]?.balance ?? null;
    const delta = Number.isFinite(balance) && Number.isFinite(priorBalance) ? balance - priorBalance : null;
    const deltaText = delta == null ? "No prior snapshot" : delta === 0 ? "Unchanged since last refresh" : `${delta > 0 ? "+" : "−"}${format(Math.abs(delta))} EC since last refresh`;
    return `<article class="watch-item"><div><span>${address === wallet.address ? "YOU" : "WATCHED"}</span><b title="${escapeHtml(address)}">${escapeHtml(short(address, 10))}</b><p>${escapeHtml(balance == null ? "Loading balance..." : `${format(balance)} EC available`)} · ${escapeHtml(history)} · ${contractCount} contracts · ${escapeHtml(deltaText)}</p></div><div><span>STATUS</span><p>${escapeHtml(label)}</p></div><button type="button" data-watch-remove="${escapeHtml(address)}">REMOVE</button></article>`;
  }).join("");
  list.innerHTML = rows;
}

function collectAlerts(account, walletContracts = []) {
  const allEntries = [{ address: wallet.address, account, contracts: walletContracts }, ...watchlistCache.filter((entry) => entry.address !== wallet.address)];
  const now = Date.now();
  const alerts = [];
  for (const entry of allEntries) {
    for (const contract of entry.contracts ?? []) {
      const dueAt = contract.contractType === "hashlock"
        ? contract.refundTime
        : contract.status === "vesting"
          ? (contract.nextReleaseAt ?? contract.unlockTime)
          : contract.unlockTime;
      if (!Number.isFinite(dueAt) || contract.status === "released" || contract.status === "refunded") continue;
      const timeLeft = dueAt - now;
      const tone = timeLeft <= 60 * 60_000 ? "urgent" : timeLeft <= 24 * 60 * 60_000 ? "soon" : "calm";
      const label = contract.contractType === "hashlock"
        ? (contract.status === "locked" ? "Hashlock deadline" : "Hashlock complete")
        : contract.contractType === "vesting"
          ? "Vesting release"
          : "Timelock release";
      const detail = contract.contractType === "hashlock"
        ? (contract.status === "locked" ? "Claim or refund before the deadline." : "Already resolved.")
        : contract.contractType === "vesting"
          ? `${contract.releasedInstallments ?? 0}/${contract.installments ?? 1} installments released.`
          : "Funds unlock automatically when the timer expires.";
      alerts.push({
        address: entry.address,
        title: label,
        text: `${detail} ${short(contract.address, 10)}`,
        dueAt,
        tone,
        contractAddress: contract.address,
      });
    }
  }
  return alerts.sort((a, b) => a.dueAt - b.dueAt).slice(0, 8);
}

function renderEventCenter(account, walletContracts = []) {
  const summary = $("#alerts-summary");
  const list = $("#alerts-list");
  if (!summary || !list) return;
  const alerts = collectAlerts(account, walletContracts);
  if (!alerts.length) {
    summary.textContent = "No active contract deadlines across this wallet or watched accounts.";
    list.innerHTML = '<p class="empty">No upcoming events yet.</p>';
    return;
  }
  const soonest = alerts[0];
  summary.textContent = `${alerts.length} upcoming event${alerts.length === 1 ? "" : "s"} · next due ${formatDuration(Math.max(0, soonest.dueAt - Date.now()))}`;
  list.innerHTML = alerts.map((alert) => `
    <article class="alert-item ${alert.tone}">
      <div>
        <b>${escapeHtml(alert.title)}</b>
        <p>${escapeHtml(alert.text)}</p>
      </div>
      <time>${escapeHtml(formatDuration(Math.max(0, alert.dueAt - Date.now())))} left</time>
      <button type="button" data-alert-contract="${escapeHtml(alert.contractAddress)}">OPEN</button>
    </article>`).join("");
}

function cacheContractsCount() {
  return watchlistCache.find((entry) => entry.address === wallet.address)?.contracts?.length ?? 0;
}

function seedWatchlistFromCounterparties(account) {
  const seeded = (account?.insights?.topCounterparties ?? []).map((entry) => entry.address);
  let added = 0;
  for (const address of seeded) if (addWatchAddress(address)) added++;
  return added;
}

function summarizeNextEvent(contracts) {
  const events = contracts
    .filter((contract) => contract.creator === wallet.address || contract.beneficiary === wallet.address)
    .map((contract) => {
      if (contract.contractType === "hashlock" && contract.status === "locked") return { label: "Hashlock deadline", at: contract.refundTime };
      if (contract.contractType === "vesting" && contract.status === "vesting") return { label: `Vesting ${contract.releasedInstallments + 1}/${contract.installments}`, at: contract.nextReleaseAt ?? contract.unlockTime };
      if (contract.contractType === "timelock" && contract.status === "locked") return { label: "Timelock release", at: contract.unlockTime };
      return null;
    })
    .filter(Boolean)
    .sort((a, b) => a.at - b.at);
  if (!events.length) return "NO UPCOMING EVENTS";
  const soonest = events[0];
  const remaining = Math.max(0, soonest.at - Date.now());
  return `${soonest.label} in ${formatDuration(remaining)}`;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m ${totalSeconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function summarizeMomentum(priceValues) {
  const sample = priceValues.slice(-12);
  if (sample.length < 2) return { label: "FLAT", note: "Not enough trades yet for a trend.", delta: 0 };
  const first = sample[0];
  const last = sample.at(-1);
  const delta = ((last - first) / Math.max(first, 1)) * 100;
  if (Math.abs(delta) < 0.5) return { label: "FLAT", note: "Recent market trades are clustered near the same price.", delta };
  return delta > 0
    ? { label: `UP ${delta.toFixed(1)}%`, note: "The internal market price has been drifting higher.", delta }
    : { label: `DOWN ${Math.abs(delta).toFixed(1)}%`, note: "The internal market price has softened recently.", delta };
}

function computeSystemHealth(status, market, blocks) {
  const mempoolPressure = status.maxMempoolSize ? status.mempoolSize / status.maxMempoolSize : 0;
  const cadencePenalty = Math.min(25, Math.abs((status.metrics?.averageBlockTimeMs ?? 6000) - 6000) / 6000 * 20);
  const throughputBonus = Math.min(12, (status.metrics?.averageTransactionsPerBlock ?? 0) / 100);
  const treasuryRatio = market.treasuryBalance / Math.max(status.maxSupply ?? 1, 1);
  let score = 100 - Math.min(45, mempoolPressure * 45) - cadencePenalty + throughputBonus;
  if (!status.chainValid) score = 0;
  else if (treasuryRatio < 0.2) score -= 10;
  else if (treasuryRatio > 0.7) score += 3;
  if (status.storageProtected) score += 2;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function renderDataIntelligence(market, status, blocks, priceValues) {
  const healthScore = computeSystemHealth(status, market, blocks);
  const momentum = summarizeMomentum(priceValues);
  const eta = formatDuration(Math.max(0, nextBlockAt - Date.now()));
  const pressure = feeQuote.pressure;
  let recommendation = "The network is stable, the treasury is healthy, and the market is calm.";
  if (!status.chainValid) recommendation = "Chain integrity needs attention before treating the ledger as trustworthy.";
  else if (pressure > 0.75) recommendation = "Network pressure is elevated, so smaller transfers and priority fees are the safer default.";
  else if (momentum.delta > 2) recommendation = "Price momentum is positive. If you are buying, consider smaller staged entries instead of one large purchase.";
  else if (momentum.delta < -2) recommendation = "Price momentum is weaker. If you are sending, the network is calm enough to wait for a standard fee.";
  else if ((market.treasuryBalance / Math.max(status.maxSupply, 1)) < 0.25) recommendation = "Treasury supply is thinning, so large market purchases may move the quote more than usual.";
  else if ((market.spreadMicroUsd ?? 0) / 1_000_000 > 0.02) recommendation = "The order-book spread is wide, so limit orders are safer than aggressive market orders.";
  else if ((market.openOrders ?? 0) > 12) recommendation = "The book has healthy depth. You can usually get a cleaner fill by joining the best bid or ask.";
  $("#data-health-score").textContent = `${healthScore}/100`;
  $("#data-health-note").textContent = healthScore >= 85 ? "Excellent" : healthScore >= 65 ? "Good" : healthScore >= 40 ? "Watch closely" : "Degraded";
  $("#data-price-momentum").textContent = momentum.label;
  $("#data-price-note").textContent = momentum.note;
  $("#data-block-eta").textContent = eta === "—" ? "—" : `~ ${eta}`;
  $("#data-block-note").textContent = eta === "—" ? "Awaiting the next seal." : `Estimated next seal in ${eta}.`;
  $("#data-recommendation").textContent = recommendation;
  renderMarketAlerts(market);
}

async function runDataSearch(query) {
  const trimmed = query.trim();
  if (!trimmed) {
    $("#search-summary").textContent = "Try a block height, address, or transaction id.";
    $("#search-results").innerHTML = '<p class="empty">No search query yet.</p>';
    return;
  }
  $("#search-summary").textContent = `Searching for "${trimmed}"...`;
  try {
    const result = await api(`/search?q=${encodeURIComponent(trimmed)}`);
    renderSearchResults(result);
  } catch (error) {
    $("#search-summary").textContent = "Search unavailable right now.";
    $("#search-results").innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`;
  }
}

function renderSearchResults(result) {
  const results = result.results ?? [];
  const counts = results.reduce((map, entry) => (map[entry.kind] = (map[entry.kind] ?? 0) + 1, map), {});
  $("#search-summary").textContent = `${result.total} match${result.total === 1 ? "" : "es"} · ${counts.block ?? 0} blocks · ${counts.transaction ?? 0} transactions · ${counts.account ?? 0} accounts · ${counts.contract ?? 0} contracts`;
  $("#search-results").innerHTML = results.length ? results.map((entry) => `
    <article class="search-result">
      <div><span>${escapeHtml(entry.kind.toUpperCase())}</span><b>${escapeHtml(entry.title)}</b><p>${escapeHtml(entry.detail)}</p></div>
      <div><span>${escapeHtml(entry.key)}</span></div>
      <button type="button" data-open-kind="${escapeHtml(entry.kind)}" data-open-key="${escapeHtml(entry.key)}" data-open-height="${escapeHtml(String(entry.height ?? entry.blockHeight ?? ""))}">OPEN</button>
    </article>`).join("") : '<p class="empty">No matches found.</p>';
}

function chartPoints(values,width,height,padding) {
  const min=Math.min(...values),max=Math.max(...values),range=max-min||1;
  const coordinates=values.map((value,index)=>[padding+(values.length===1?(width-2*padding)/2:index*(width-2*padding)/(values.length-1)),height-padding-(value-min)/range*(height-2*padding)]);
  return {line:coordinates.map(([x,y])=>`${x},${y}`).join(" "),path:coordinates.map(([x,y],index)=>`${index?"L":"M"} ${x} ${y}`).join(" ")};
}

function updateLoadMore() {
  $("#load-more").hidden=!loadedBlocks.length || loadedBlocks.at(-1).height===0;
}

function relativeTime(timestamp) {
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 5) return "now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function updateBlockClock() {
  const seconds=Math.max(0,Math.ceil((nextBlockAt-Date.now())/1000));
  $("#mempool").textContent=`${mempoolSize}/${maxMempoolSize/1000}K · ${seconds ? `${seconds}S` : "SEALING"}`;
}

function scheduleRefresh() {
  clearTimeout(refreshTimer); refreshTimer=setTimeout(()=>refresh().catch(()=>{}),100);
}

function connectEventStream() {
  if (!("EventSource" in window)) { $("#network-state").textContent="POLLING"; return; }
  const stream=new EventSource("/api/events");
  stream.onopen=()=>{$("#network-state").textContent="LIVE STREAM";};
  stream.onerror=()=>{$("#network-state").textContent="RECONNECTING";};
  for (const event of ["ready","mempool","block","market"]) stream.addEventListener(event,scheduleRefresh);
}

function toast(message, error = false) {
  const node = $("#toast"); node.textContent = message; node.className = `toast show${error ? " error" : ""}`;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => node.className = "toast", 3200);
}

function setBusy(button, busy) { button.disabled = busy; button.dataset.label ||= button.textContent; button.textContent = busy ? "WORKING…" : button.dataset.label; }

$("#copy-address").addEventListener("click", async () => { await navigator.clipboard.writeText(wallet.address); toast("Address copied"); });
$("#copy-request").addEventListener("click", async () => {
  const uri = paymentRequestUri(wallet.address);
  await navigator.clipboard.writeText(uri);
  toast("Payment request copied");
});
$("#share-request").addEventListener("click", async () => {
  const uri = paymentRequestUri(wallet.address);
  const text = `Send E-Coin to ${wallet.name}: ${uri}`;
  if (navigator.share) {
    try {
      await navigator.share({ title: "E-Coin payment request", text, url: uri });
      toast("Share sheet opened");
      return;
    } catch {
      // Fall back to clipboard below.
    }
  }
  await navigator.clipboard.writeText(uri);
  toast("Share not available, request copied");
});
$("#vault-action").addEventListener("click", () => {
  if (vaultState === "none") return openVaultDialog("create");
  if (vaultState === "locked") return openVaultDialog("unlock");
  lockVault();
  toast("Vault locked");
});
$("#wallet-picker").addEventListener("change",async(event)=>{
  wallet=wallets.find((candidate)=>candidate.address===event.target.value)??wallet; await saveWallets(); showWallet(); loadRecentTransfers(); loadTransferTemplates(); loadWalletHistory(); loadPaymentPlans(); renderRecentTransfers(); renderTransferTemplates(); renderWalletHistory(); renderWalletDiagnostics(); renderPaymentPlans(); $("#send-form").reset(); await refresh(); toast(`Switched to ${wallet.name}`);
});
$("#open-wallet-manager").addEventListener("click",()=>{$("#wallet-name").value="";renderWallets();$("#wallet-overlay").hidden=false;$("#wallet-name").focus();});
$("#close-wallet-manager").addEventListener("click",closeWalletManager);
$("#wallet-form").addEventListener("submit",async(event)=>{
  event.preventDefault(); const button=event.currentTarget.querySelector("button"); const name=$("#wallet-name").value.trim();
  if (!name) return toast("Wallet name cannot be blank",true);
  if (vaultState === "locked") return toast("Unlock the vault before creating another wallet", true);
  setBusy(button,true);
  try { wallet=await createWallet(name); wallets.push(wallet); await saveWallets(); renderWallets(); showWallet(); loadRecentTransfers(); loadTransferTemplates(); loadWalletHistory(); loadPaymentPlans(); renderRecentTransfers(); renderTransferTemplates(); renderWalletHistory(); renderWalletDiagnostics(); renderPaymentPlans(); closeWalletManager(); await refresh(); toast(`${name} created locally`); }
  catch(error){toast(error.message,true);} finally{setBusy(button,false);}
});
$("#close-vault").addEventListener("click", closeVaultDialog);
$("#vault-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button[type='submit']");
  const mode = $("#vault-overlay").dataset.mode || "create";
  const password = $("#vault-password").value;
  setBusy(button, true);
  try {
    if (mode === "create") {
      if (password.length < 8) throw new Error("Choose a password with at least 8 characters");
      if (password !== $("#vault-confirm").value) throw new Error("Passwords do not match");
      vaultEnvelope = await encryptWalletVault(wallets, password);
      vaultPassword = password;
      vaultState = "unlocked";
      localStorage.setItem(walletVaultKey, JSON.stringify(vaultEnvelope));
      localStorage.removeItem(walletsKey);
      closeVaultDialog();
      await saveWallets();
      renderWallets();
      showWallet();
      toast("Vault enabled and encrypted locally");
      return;
    }
    if (!vaultEnvelope) throw new Error("No encrypted vault is available");
    const decrypted = await decryptWalletVault(vaultEnvelope, password);
    wallets = decrypted;
    vaultPassword = password;
    vaultState = "unlocked";
    await ensureTreasuryWallet();
    await saveWallets();
    renderWallets();
    showWallet();
    closeVaultDialog();
    await refresh();
    toast("Vault unlocked");
  } catch (error) {
    toast(error.message, true);
  } finally {
    setBusy(button, false);
  }
});
$("#refresh").addEventListener("click", () => refresh().catch((e) => toast(e.message, true)));
$("#load-more").addEventListener("click", async (event) => {
  const button=event.currentTarget; const oldest=loadedBlocks.at(-1)?.height;
  if (!oldest) return;
  setBusy(button,true);
  try {
    const older=await api(`/blocks?limit=10&before=${oldest}`);
    loadedBlocks=[...new Map([...loadedBlocks,...older].map((block)=>[block.hash,block])).values()].sort((a,b)=>b.height-a.height);
    renderBlocks(loadedBlocks,currentPending); updateLoadMore();
  } catch(error) { toast(error.message,true); }
  finally { setBusy(button,false); }
});
$("#faucet").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  setBusy(button, true);
  try { await api("/faucet", { method:"POST", body:JSON.stringify({ address:wallet.address }) }); setBusy(button, false); await refresh(); toast("25 test EC received"); }
  catch (error) { setBusy(button, false); toast(error.message, true); }
});
$("#open-buy").addEventListener("click",async()=>{
  if (wallet.address===currentStatus?.treasuryAddress) return toast("Switch to a non-treasury wallet to buy E-Coin",true);
  $("#buy-form").reset(); $("#buy-usd").value="25.00"; $("#buy-wallet").textContent=`TO ${wallet.name} / ${short(wallet.address,12)}`; $("#buy-overlay").hidden=false; await updateBuyQuote(); $("#buy-usd").focus();
});
$("#close-buy").addEventListener("click",()=>{$("#buy-overlay").hidden=true;});
$("#buy-usd").addEventListener("input",()=>{clearTimeout(buyQuoteTimer);buyQuoteTimer=setTimeout(()=>updateBuyQuote().catch((error)=>toast(error.message,true)),250);});
$("#buy-form").addEventListener("submit",async(event)=>{
  event.preventDefault(); const button=$("#buy-submit"); setBusy(button,true);
  try {
    if (wallet.address===currentStatus?.treasuryAddress) throw new Error("Select a non-treasury wallet");
    const usdCents=Math.round(Number($("#buy-usd").value)*100); if (!Number.isSafeInteger(usdCents)) throw new Error("Enter a valid USD amount");
    const purchaseId=crypto.randomUUID(); const result=await api("/market/buy",{method:"POST",body:JSON.stringify({address:wallet.address,usdCents,purchaseId})});
    $("#buy-overlay").hidden=true; await refresh(); toast(`Treasury purchase settled: ${format(result.transaction.amount)} EC`);
  } catch(error){toast(error.message,true);} finally{setBusy(button,false);}
});
async function updateBuyQuote() {
  const usdCents=Math.round(Number($("#buy-usd").value)*100); if (!Number.isSafeInteger(usdCents)||usdCents<100) { $("#buy-receive").textContent="ENTER $1 OR MORE"; return; }
  const quote=await api("/market/quote",{method:"POST",body:JSON.stringify({usdCents})});
  $("#buy-price").textContent=quote.priceUsd.toLocaleString(undefined,{style:"currency",currency:"USD",minimumFractionDigits:6,maximumFractionDigits:6}); $("#buy-receive").textContent=`${format(quote.amount)} EC`;
}
$("#refresh-data").addEventListener("click",()=>refresh().catch((error)=>toast(error.message,true)));
$("#watchlist-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("#watchlist-address");
  try {
    const added = addWatchAddress(input.value);
    input.value = "";
    renderWatchlist(currentAccount);
    if (added) {
      toast("Address added to watchlist");
      await refreshWatchlist(currentAccount);
    } else {
      toast("Address is already on the watchlist");
    }
  } catch (error) {
    toast(error.message, true);
  }
});
$("#watchlist-seed").addEventListener("click", async () => {
  try {
    const added = seedWatchlistFromCounterparties(currentAccount);
    renderWatchlist(currentAccount);
    toast(added ? `${added} counterparties added to watchlist` : "No new counterparties to seed");
    await refreshWatchlist(currentAccount);
  } catch (error) {
    toast(error.message, true);
  }
});
$("#watchlist-list").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-watch-remove]");
  if (!button) return;
  watchlist = watchlist.filter((address) => address !== button.dataset.watchRemove);
  saveWatchlist();
  renderWatchlist(currentAccount);
  await refreshWatchlist(currentAccount);
  toast("Watchlist entry removed");
});
$("#transfer-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-transfer-fill]");
  if (!button) return;
  fillTransferDraft({
    to: button.dataset.transferFill,
    amount: Number(button.dataset.transferAmount || 0),
    memo: button.dataset.transferMemo || "",
    tier: button.dataset.transferTier || "standard",
  });
});
$("#template-list").addEventListener("click", (event) => {
  const fillButton = event.target.closest("[data-template-fill]");
  const removeButton = event.target.closest("[data-template-remove]");
  if (fillButton) {
    try { applyTransferTemplate(fillButton.dataset.templateFill); }
    catch (error) { toast(error.message, true); }
    return;
  }
  if (removeButton) {
    transferTemplates = transferTemplates.filter((template) => template.id !== removeButton.dataset.templateRemove);
    saveTransferTemplates();
    renderTransferTemplates();
    toast("Template removed");
  }
});
$("#alerts-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-alert-contract]");
  if (!button) return;
  document.querySelector(".contracts-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
  toast(`Contract ${short(button.dataset.alertContract, 12)} highlighted`);
});
$("#market-alert-current").addEventListener("click", () => {
  const price = marketData?.priceUsd ?? 0;
  if (!price) return toast("No market price available yet", true);
  $("#market-alert-price").value = price.toFixed(6);
  toast("Current market price inserted");
});
$("#market-alert-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const priceUsd = Number($("#market-alert-price").value);
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return toast("Enter a valid alert price", true);
  const alert = {
    id: crypto.randomUUID(),
    name: $("#market-alert-name").value.trim(),
    direction: $("#market-alert-direction").value,
    priceUsd,
    createdAt: Date.now(),
    triggered: false,
    lastTriggeredAt: null,
  };
  marketAlerts = [alert, ...marketAlerts].slice(0, 12);
  saveMarketAlerts();
  renderMarketAlerts(marketData);
  $("#market-alert-form").reset();
  $("#market-alert-direction").value = alert.direction;
  toast("Market alert added");
});
$("#market-alert-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-market-alert-remove]");
  if (!button) return;
  marketAlerts = marketAlerts.filter((alert) => alert.id !== button.dataset.marketAlertRemove);
  saveMarketAlerts();
  renderMarketAlerts(marketData);
  toast("Market alert removed");
});
$("#your-orders").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-order-cancel]");
  if (!button) return;
  try {
    const orderId = button.dataset.orderCancel;
    const signed = { address: wallet.address, orderId, timestamp: Date.now(), publicKey: wallet.publicKey };
    signed.signature = await signMarketCancel(signed);
    await api("/market/order/cancel", { method: "POST", body: JSON.stringify(signed) });
    await refresh();
    toast("Order canceled");
  } catch (error) {
    toast(error.message, true);
  }
});
$("#market-quote-fill").addEventListener("click", () => {
  const price = marketData?.priceUsd ?? 0;
  if (!price) return toast("No market price available yet", true);
  $("#order-price").value = price.toFixed(6);
  toast("Mid price selected");
});
$("#order-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const side = $("#order-side").value;
  const amount = Math.round(Number($("#order-amount").value) * SCALE);
  const limitPriceMicroUsd = Math.round(Number($("#order-price").value) * 1_000_000);
  const button = $("#place-order");
  setBusy(button, true);
  try {
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("Enter a valid amount");
    if (!Number.isSafeInteger(limitPriceMicroUsd) || limitPriceMicroUsd <= 0) throw new Error("Enter a valid limit price");
    const orderId = crypto.randomUUID();
    const signed = { address: wallet.address, side, amount, limitPriceMicroUsd, orderId, timestamp: Date.now(), publicKey: wallet.publicKey };
    signed.signature = await signMarketOrder(signed);
    const result = await api("/market/order", { method: "POST", body: JSON.stringify(signed) });
    await refresh();
    $("#order-form").reset();
    $("#order-side").value = side;
    if (result.fills?.length) toast(`${result.fills.length} fill${result.fills.length === 1 ? "" : "s"} matched`);
    else toast("Order placed on the book");
  } catch (error) {
    toast(error.message, true);
  } finally {
    setBusy(button, false);
  }
});
$("#wallet-actions").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-wallet-action]");
  if (!button) return;
  const action = button.dataset.walletAction;
  const value = button.dataset.walletActionValue;
  const address = button.dataset.walletActionAddress;
  try {
    if (action === "vault") {
      $("#vault-action").click();
      return;
    }
    if (action === "smart-max") {
      $("#smart-max").click();
      return;
    }
    if (action === "buy") {
      $("#open-buy").click();
      return;
    }
    if (action === "fee") {
      $("#fee-tier").value = value || recommendedFeeTier(feeQuote.pressure);
      applyFeeTier();
      updateComposer();
      toast(`Fee tier set to ${$("#fee-tier").value}`);
      return;
    }
    if (action === "watch") {
      if (address && addWatchAddress(address)) {
        renderWatchlist(currentAccount);
        await refreshWatchlist(currentAccount);
        toast("Counterparty added to watchlist");
      } else {
        toast("That address is already being watched");
      }
      return;
    }
    if (action === "scroll-contracts") {
      document.querySelector(".contracts-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
      toast("Jumped to contracts");
      return;
    }
    if (action === "scroll-watchlist") {
      document.querySelector('[data-view="data"]').click();
      setTimeout(() => $("#watchlist-address")?.scrollIntoView({ behavior: "smooth", block: "center" }), 150);
      toast("Jumped to watchlist");
      return;
    }
    if (action === "refresh") {
      await refresh();
      toast("Wallet refreshed");
    }
  } catch (error) {
    toast(error.message, true);
  }
});
$("#save-template").addEventListener("click", () => {
  try {
    const name = $("#template-name").value || `${contacts.find((item) => item.address === $("#recipient").value.trim())?.name ?? short($("#recipient").value.trim(), 10)} template`;
    const template = createTransferTemplate(name);
    $("#template-name").value = "";
    toast(`Template saved: ${template.name}`);
  } catch (error) {
    toast(error.message, true);
  }
});
$("#plan-fill-current").addEventListener("click", () => {
  $("#plan-recipient").value = $("#recipient").value.trim();
  $("#plan-amount").value = $("#amount").value;
  $("#plan-memo").value = $("#memo").value;
  toast("Plan fields filled from current draft");
});
$("#save-plan").addEventListener("click", () => {
  try {
    const plan = createPaymentPlan();
    $("#plan-name").value = "";
    toast(`Plan saved: ${plan.name}`);
  } catch (error) {
    toast(error.message, true);
  }
});
$("#plan-list").addEventListener("click", (event) => {
  const fill = event.target.closest("[data-plan-fill]");
  const complete = event.target.closest("[data-plan-complete]");
  const toggle = event.target.closest("[data-plan-toggle]");
  const remove = event.target.closest("[data-plan-remove]");
  const plan = paymentPlans.find((item) => item.id === (fill?.dataset.planFill || complete?.dataset.planComplete || toggle?.dataset.planToggle || remove?.dataset.planRemove));
  if (!plan) return;
  if (fill) {
    fillPlanDraft(plan);
    return;
  }
  if (complete) {
    if (plan.cadence === "once") {
      paymentPlans = paymentPlans.filter((item) => item.id !== plan.id);
      savePaymentPlans();
      renderPaymentPlans();
      toast(`Plan completed: ${plan.name}`);
      return;
    }
    const interval = cadenceToMs(plan.cadence);
    plan.nextRunAt = Date.now() + interval;
    plan.lastReminderAt = 0;
    savePaymentPlans();
    renderPaymentPlans();
    toast(`Plan advanced: ${plan.name}`);
    return;
  }
  if (toggle) {
    plan.paused = !plan.paused;
    savePaymentPlans();
    renderPaymentPlans();
    toast(plan.paused ? `Paused ${plan.name}` : `Resumed ${plan.name}`);
    return;
  }
  if (remove) {
    paymentPlans = paymentPlans.filter((item) => item.id !== plan.id);
    savePaymentPlans();
    renderPaymentPlans();
    toast(`Removed ${plan.name}`);
  }
});
$("#data-search").addEventListener("input", (event) => {
  clearTimeout(dataSearchTimer);
  dataSearchTimer = setTimeout(() => runDataSearch(event.target.value).catch((error) => toast(error.message, true)), 250);
});
$("#clear-search").addEventListener("click", () => {
  $("#data-search").value = "";
  runDataSearch("").catch((error) => toast(error.message, true));
});
$("#search-results").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-open-kind]");
  if (!button) return;
  const kind = button.dataset.openKind;
  const key = button.dataset.openKey;
  try {
    if (kind === "block" || kind === "transaction") {
      const height = Number(button.dataset.openHeight);
      if (!Number.isFinite(height)) throw new Error("No block height available for this result");
      await showReceipt(height);
    } else if (kind === "contract") {
      document.querySelector('[data-view="wallet"]').click();
      toast("Contract located in wallet view");
    } else if (kind === "account") {
      navigator.clipboard?.writeText(key).catch(() => {});
      toast("Account address copied");
    }
  } catch (error) {
    toast(error.message, true);
  }
});
$("#max-amount").addEventListener("click", () => {
  const spendable = Math.max(0, currentAccount.availableBalance - activeFee);
  $("#amount").value = (spendable / SCALE).toFixed(6);
  toast(spendable ? "Maximum spendable amount selected" : "No spendable balance", !spendable);
  updateComposer();
});
$("#smart-max").addEventListener("click", () => {
  const spendable = smartReserveAmount();
  $("#amount").value = (spendable / SCALE).toFixed(6);
  toast(spendable ? "Safe spend amount selected" : "No safe spend amount available", !spendable);
  updateComposer();
});
$("#amount").addEventListener("input", updateComposer);
$("#recipient").addEventListener("input", (event) => {
  const parsed = parsePaymentRequest(event.currentTarget.value);
  if (parsed) {
    event.currentTarget.value = parsed.address;
    if (parsed.amount && !Number.isNaN(Number(parsed.amount))) $("#amount").value = Number(parsed.amount).toFixed(6);
    if (parsed.memo) $("#memo").value = parsed.memo;
  }
  updateComposer();
});
$("#fee-tier").addEventListener("change", () => { applyFeeTier(); updateComposer(); });
$("#contact-picker").addEventListener("change", (event) => {
  if (!event.target.value) return;
  $("#recipient").value = event.target.value; updateComposer(); toast("Contact selected");
});
$("#open-contact").addEventListener("click", () => {
  $("#contact-name").value = "";
  $("#contact-address").value = /^ec1[0-9a-f]{38}$/.test($("#recipient").value.trim()) ? $("#recipient").value.trim() : "";
  renderContacts(); $("#contact-overlay").hidden = false; $("#contact-name").focus();
});
$("#close-contact").addEventListener("click", closeContact);
$("#contact-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const entry = { name:$("#contact-name").value.trim(), address:$("#contact-address").value.trim() };
  if (!entry.name) return toast("Contact name cannot be blank",true);
  contacts = contacts.filter((contact) => contact.address !== entry.address);
  contacts.push(entry); contacts.sort((a,b) => a.name.localeCompare(b.name));
  localStorage.setItem(contactsKey,JSON.stringify(contacts)); renderContacts();
  $("#recipient").value=entry.address; updateComposer(); closeContact(); toast(`${entry.name} saved locally`);
});
$("#contact-list").addEventListener("click", (event) => {
  const button=event.target.closest("button[data-address]");
  if (!button) return;
  const removed=contacts.find((contact)=>contact.address===button.dataset.address);
  contacts=contacts.filter((contact)=>contact.address!==button.dataset.address);
  localStorage.setItem(contactsKey,JSON.stringify(contacts)); renderContacts(); toast(`${removed?.name ?? "Contact"} removed`);
});
function buildRecoveryBundle() {
  return {
    version: 2,
    exportedAt: Date.now(),
    wallet,
    walletHistory,
    recentTransfers,
    transferTemplates,
    paymentPlans,
    contacts,
  };
}
function restoreRecoveryBundle(bundle) {
  const source = bundle?.wallet ?? bundle;
  if (!source || !source.privateKey || !source.publicKey || !source.address) throw new Error("This file does not contain a valid E-Coin wallet");
  return source;
}
$("#backup").addEventListener("click", () => {
  if (vaultState === "locked") return toast("Unlock the vault before creating a backup", true);
  const blob = new Blob([JSON.stringify(buildRecoveryBundle(), null, 2)], { type:"application/json" });
  const link = Object.assign(document.createElement("a"), { href:URL.createObjectURL(blob), download:`ecoin-wallet-${wallet.address.slice(0, 10)}.json` });
  link.click(); URL.revokeObjectURL(link.href); toast("Wallet backup created—keep it private");
});
$("#import-key").addEventListener("change", async (event) => {
  try {
    if (vaultState === "locked") throw new Error("Unlock the vault before importing a wallet");
    const imported = JSON.parse(await event.target.files[0].text());
    const source = restoreRecoveryBundle(imported);
    if (!source.privateKey || !source.publicKey || await addressFromKey(source.publicKey) !== source.address) throw new Error("This is not a valid E-Coin wallet backup");
    const [privateKey, publicKey] = await Promise.all([
      crypto.subtle.importKey("jwk", source.privateKey, { name:"Ed25519" }, false, ["sign"]),
      crypto.subtle.importKey("jwk", source.publicKey, { name:"Ed25519" }, false, ["verify"]),
    ]);
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const proof = await crypto.subtle.sign("Ed25519", privateKey, challenge);
    if (!await crypto.subtle.verify("Ed25519", publicKey, proof, challenge)) throw new Error("Wallet backup contains mismatched keys");
    const normalized={...source,id:source.address,name:source.name||`Imported ${wallets.length+1}`};
    wallets=wallets.filter((candidate)=>candidate.address!==normalized.address); wallets.push(normalized); wallet=normalized;
    if (Array.isArray(imported.contacts)) contacts=[...imported.contacts].filter((contact)=>contact && typeof contact.name==="string" && /^ec1[0-9a-f]{38}$/.test(contact.address));
    if (Array.isArray(imported.recentTransfers)) recentTransfers=imported.recentTransfers.slice(0,8);
    if (Array.isArray(imported.transferTemplates)) transferTemplates=imported.transferTemplates.slice(0,12);
    if (Array.isArray(imported.paymentPlans)) paymentPlans=imported.paymentPlans.slice(0,24);
    if (Array.isArray(imported.walletHistory)) walletHistory=imported.walletHistory.slice(0,60);
    await saveWallets(); localStorage.setItem(contactsKey,JSON.stringify(contacts)); saveRecentTransfers(); saveTransferTemplates(); savePaymentPlans(); saveWalletHistory();
    renderContacts(); renderRecentTransfers(); renderTransferTemplates(); renderPaymentPlans(); renderWalletHistory(); renderWalletDiagnostics(); showWallet(); await refresh(); toast("Wallet imported");
  } catch (error) { toast(error.message, true); }
  event.target.value = "";
});
$("#send-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const button = event.currentTarget.querySelector("button[type='submit']"); setBusy(button, true);
  try {
    if (vaultState === "locked") throw new Error("Unlock the vault before sending funds");
    const amount = Math.round(Number($("#amount").value) * SCALE);
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("Enter a valid amount");
    const recipient = $("#recipient").value.trim();
    if (recipient === wallet.address) throw new Error("Choose a recipient other than this wallet");
    if (amount + activeFee > currentAccount.availableBalance) throw new Error("Amount plus fee exceeds your available balance");
    const recipientProfile = await api(`/accounts/${recipient}`);
    pendingDraft = { from:wallet.address, to:recipient, amount, fee:activeFee, nonce:currentAccount.nextNonce, memo:$("#memo").value.trim(), timestamp:Date.now(), publicKey:wallet.publicKey };
    showReview(pendingDraft, recipientProfile);
  } catch (error) { toast(error.message, true); } finally { setBusy(button, false); }
});

$("#open-contract").addEventListener("click",()=>{
  $("#contract-form").reset();
  $("#contract-type").value="timelock"; $("#vesting-fields").hidden=true; $("#hashlock-fields").hidden=true; $("#unlock-field").hidden=false;
  const local=new Date(Date.now()+10*60_000-new Date().getTimezoneOffset()*60_000);
  $("#contract-unlock").value=local.toISOString().slice(0,16);
  const refundLocal=new Date(Date.now()+60*60_000-new Date().getTimezoneOffset()*60_000); $("#contract-refund").value=refundLocal.toISOString().slice(0,16);
  updateContractPreview();
  $("#contract-overlay").hidden=false; $("#contract-beneficiary").focus();
});
$("#contract-type").addEventListener("change",(event)=>{$("#vesting-fields").hidden=event.target.value!=="vesting";$("#hashlock-fields").hidden=event.target.value!=="hashlock";$("#unlock-field").hidden=event.target.value==="hashlock";updateContractPreview();});
for (const selector of ["#contract-amount","#contract-unlock","#contract-installments","#contract-interval"]) $(selector).addEventListener("input",updateContractPreview);
$("#contract-secret").addEventListener("input",async(event)=>{$("#contract-secret-hash").textContent=event.target.value?await sha256Text(event.target.value):"ENTER A SECRET";updateContractPreview();});
$("#contract-refund").addEventListener("input",updateContractPreview);
function updateContractPreview() {
  const type=$("#contract-type").value; const amount=Number($("#contract-amount").value)||0; const unlock=new Date(type==="hashlock"?$("#contract-refund").value:$("#contract-unlock").value).getTime(); const installments=type==="vesting"?Number($("#contract-installments").value)||0:1; const interval=type==="vesting"?Number($("#contract-interval").value)||0:0;
  const perRelease=installments?amount/installments:0; const finalDate=Number.isFinite(unlock)?new Date(unlock+(installments-1)*interval):null;
  $("#contract-preview").innerHTML=`<span>RELEASE PLAN</span><div><b>${type==="vesting"?`${installments} INSTALLMENTS`:type==="hashlock"?"SECRET CLAIM / REFUND":"ONE RELEASE"}</b><strong>${perRelease>0?`${perRelease.toLocaleString(undefined,{maximumFractionDigits:6})} EC`:"ENTER AN AMOUNT"}</strong></div><small>${finalDate&&!Number.isNaN(finalDate.getTime())?(type==="hashlock"?`Beneficiary may claim before ${finalDate.toLocaleString()}; otherwise funds refund automatically.`:`First release ${new Date(unlock).toLocaleString()} · final release ${finalDate.toLocaleString()}`):"Choose a valid release time."}</small>`;
}
$("#close-contract").addEventListener("click",closeContract);
$("#contract-form").addEventListener("submit",async(event)=>{
  event.preventDefault(); const button=event.currentTarget.querySelector("button[type='submit']"); setBusy(button,true);
  try {
    if (vaultState === "locked") throw new Error("Unlock the vault before deploying contracts");
    const amount=Math.round(Number($("#contract-amount").value)*SCALE);
    const contractType=$("#contract-type").value;
    const unlockTime=contractType==="hashlock"?0:new Date($("#contract-unlock").value).getTime();
    if (!Number.isSafeInteger(amount)||amount<=0) throw new Error("Enter a valid contract amount");
    if (amount+activeFee>currentAccount.availableBalance) throw new Error("Contract amount plus fee exceeds available balance");
    const installments=contractType==="vesting"?Number($("#contract-installments").value):1;
    const intervalMs=contractType==="vesting"?Number($("#contract-interval").value):0;
    const secret=contractType==="hashlock"?$("#contract-secret").value:""; if(contractType==="hashlock"&&!secret) throw new Error("Enter a claim secret");
    const secretHash=secret?await sha256Text(secret):""; const refundTime=contractType==="hashlock"?new Date($("#contract-refund").value).getTime():0;
    const deployment={contractType,from:wallet.address,beneficiary:$("#contract-beneficiary").value.trim(),amount,fee:activeFee,nonce:currentAccount.nextNonce,unlockTime,installments,intervalMs,secretHash,refundTime,memo:$("#contract-memo").value.trim(),timestamp:Date.now(),publicKey:wallet.publicKey};
    deployment.signature=await signContract(deployment);
    const result=await api("/contracts",{method:"POST",body:JSON.stringify(deployment)});
    closeContract(); await refresh(); toast(`${contractType==="vesting"?"Vesting contract":contractType==="hashlock"?"Hashlock":"Timelock"} queued at position ${result.position}`);
  } catch(error){toast(error.message,true);} finally{setBusy(button,false);}
});
$("#contract-list").addEventListener("click",(event)=>{const button=event.target.closest("[data-claim]");if(!button)return;$("#claim-form").reset();$("#claim-address").value=button.dataset.claim;$("#claim-overlay").hidden=false;$("#claim-secret").focus();});
$("#close-claim").addEventListener("click",closeClaim);
$("#claim-form").addEventListener("submit",async(event)=>{
  event.preventDefault(); const button=event.currentTarget.querySelector("button[type='submit']"); setBusy(button,true);
  try { const address=$("#claim-address").value; await api(`/contracts/${address}/claim`,{method:"POST",body:JSON.stringify({secret:$("#claim-secret").value})}); closeClaim(); await refresh(); toast("Hashlock claimed to its beneficiary"); }
  catch(error){toast(error.message,true);} finally{setBusy(button,false);}
});

$("#cancel-review").addEventListener("click", closeReview);
$("#edit-transfer").addEventListener("click", closeReview);
$("#close-receipt").addEventListener("click", closeReceipt);
$("#copy-receipt").addEventListener("click", async () => { await navigator.clipboard.writeText(receiptCopyValue); toast("Receipt ID copied"); });
$("#blocks").addEventListener("click", (event) => {
  const row = event.target.closest("button.block");
  if (row) showReceipt(row.dataset.height).catch((error) => toast(error.message,true));
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!$("#review-overlay").hidden) closeReview();
  if (!$("#contact-overlay").hidden) closeContact();
  if (!$("#receipt-overlay").hidden) closeReceipt();
  if (!$("#wallet-overlay").hidden) closeWalletManager();
  if (!$("#vault-overlay").hidden) closeVaultDialog();
  if (!$("#contract-overlay").hidden) closeContract();
  if (!$("#buy-overlay").hidden) $("#buy-overlay").hidden=true;
  if (!$("#claim-overlay").hidden) closeClaim();
});
$("#confirm-send").addEventListener("click", async (event) => {
  if (!pendingDraft) return;
  const button = event.currentTarget; setBusy(button,true);
  try {
    pendingDraft.timestamp = Date.now();
    pendingDraft.signature = await signTransaction(pendingDraft);
    const result = await api("/transactions", { method:"POST", body:JSON.stringify(pendingDraft) });
    recordRecentTransfer(pendingDraft);
    pendingDraft = null; closeReview(); $("#send-form").reset(); updateComposer(); await refresh(); toast(`Signed and queued at position ${result.position}`); setTimeout(()=>refresh().catch(()=>{}),6500);
  } catch (error) { closeReview(); toast(`${error.message} — review the transfer again`,true); await refresh(); }
  finally { setBusy(button,false); }
});

function updateComposer() {
  const amount = Math.round(Number($("#amount").value) * SCALE);
  const recipient = $("#recipient").value.trim();
  const status = $("#composer-status");
  const projected = currentAccount.availableBalance - (Number.isSafeInteger(amount) && amount > 0 ? amount + activeFee : 0);
  $("#projected-balance").textContent = amount > 0 ? `BALANCE AFTER ${format(Math.max(0,projected))} EC` : "BALANCE AFTER —";
  status.className = "";
  if (vaultState === "locked") {
    status.textContent = "UNLOCK THE VAULT TO SIGN";
    status.className = "warning";
    return;
  }
  if (!amount && !recipient) status.textContent = "ENTER A TRANSFER TO ANALYZE";
  else if (!/^ec1[0-9a-f]{38}$/.test(recipient)) { status.textContent = "RECIPIENT INCOMPLETE"; status.className="warning"; }
  else if (!Number.isSafeInteger(amount) || amount <= 0) { status.textContent = "AMOUNT REQUIRED"; status.className="warning"; }
  else if (projected < 0) { status.textContent = "INSUFFICIENT BALANCE"; status.className="warning"; }
  else { status.textContent = "READY FOR SAFETY REVIEW"; status.className="ready"; }
}

function showReview(tx, profile) {
  $("#review-amount").textContent = format(tx.amount);
  $("#review-recipient").textContent = short(tx.to,13);
  $("#review-recipient").title = tx.to;
  $("#review-fee").textContent = `${format(tx.fee)} EC (${(tx.fee / tx.amount * 100).toFixed(2)}%)`;
  $("#review-balance").textContent = `${format(currentAccount.availableBalance - tx.amount - tx.fee)} EC`;
  $("#review-history").textContent = profile.insights.transactionCount ? `${profile.insights.transactionCount} prior transaction${profile.insights.transactionCount === 1 ? "" : "s"}` : "No prior activity";
  const signals = [];
  if (!profile.insights.transactionCount) signals.push(["warning","New destination: this address has no committed E-Coin history."]);
  else signals.push(["","Known destination: activity exists on the committed ledger."]);
  if (watchlist.includes(tx.to)) signals.push(["","Watched destination: this address is already on your local monitor list."]);
  if (tx.amount + tx.fee > currentAccount.availableBalance / 2) signals.push(["warning","Large transfer: this spends more than half of the available balance."]);
  if (tx.fee / tx.amount > .05) signals.push(["warning","Fee ratio is high because the transfer amount is very small."]);
  if (tx.memo) signals.push(["",`Memo attached: “${tx.memo}”`]);
  $("#review-signals").innerHTML = signals.map(([tone,text]) => `<div class="signal ${tone}">${escapeHtml(text)}</div>`).join("");
  $("#review-overlay").hidden = false;
  $("#confirm-send").focus();
}

function applyFeeTier() {
  const tier=$("#fee-tier").value;
  activeFee=feeQuote[tier] ?? feeQuote.standard;
  $("#fee-display").textContent=`${format(activeFee)} EC`;
  $("#fee-advice").textContent=`RECOMMENDED ${recommendedFeeTier(feeQuote.pressure).toUpperCase()}`;
  $("#fee-advice").className = tier === recommendedFeeTier(feeQuote.pressure) ? "match" : "notice";
}

function closeReview() { $("#review-overlay").hidden=true; pendingDraft=null; }
function closeContact() { $("#contact-overlay").hidden=true; }
function closeReceipt() { $("#receipt-overlay").hidden=true; }
function closeWalletManager() { $("#wallet-overlay").hidden=true; }
function closeContract() { $("#contract-overlay").hidden=true; $("#contract-secret").value=""; $("#contract-secret-hash").textContent="ENTER A SECRET"; }
function closeClaim() { $("#claim-overlay").hidden=true; $("#claim-form").reset(); }

function openVaultDialog(mode) {
  $("#vault-form").reset();
  $("#vault-confirm-row").hidden = mode !== "create";
  $("#vault-submit").textContent = mode === "create" ? "ENABLE VAULT" : "UNLOCK VAULT";
  $("#vault-eyebrow").textContent = mode === "create" ? "ENCRYPT LOCAL KEYS" : "UNLOCK YOUR KEYS";
  $("#vault-title").textContent = mode === "create" ? "Protect this browser wallet." : "Unlock the encrypted vault.";
  $("#vault-copy").textContent = mode === "create"
    ? "This password encrypts every local private key before it is written to storage."
    : "Unlocking restores signing access in this browser session only.";
  $("#vault-overlay").dataset.mode = mode;
  $("#vault-overlay").hidden = false;
  $("#vault-password").focus();
}

function closeVaultDialog() { $("#vault-overlay").hidden = true; }

function lockVault() {
  if (!vaultEnvelope) throw new Error("No encrypted vault is enabled");
  wallets = stripWalletSecretsFromCollection(wallets);
  vaultPassword = null;
  vaultState = "locked";
  selectActiveWallet();
  saveWallets();
  renderWallets();
  showWallet();
  updateComposer();
}

function renderWallets() {
  const picker=$("#wallet-picker"); picker.innerHTML="";
  for (const candidate of wallets) { const option=document.createElement("option"); option.value=candidate.address; option.textContent=candidate.name; option.selected=candidate.address===wallet?.address; picker.append(option); }
  $("#wallet-list").innerHTML=wallets.map((candidate)=>`<div class="contact-entry"><div><b>${escapeHtml(candidate.name)}</b><code>${escapeHtml(short(candidate.address,12))}</code></div><span class="local-badge">${candidate.address===wallet?.address ? "ACTIVE" : vaultState === "locked" ? "LOCKED" : candidate.privateKey ? "LOCAL" : "ROSTER"}</span></div>`).join("");
  $("#vault-state").textContent = vaultState === "locked" ? "ENCRYPTED VAULT LOCKED" : vaultState === "unlocked" ? "ENCRYPTED VAULT UNLOCKED" : "LOCAL STORAGE";
  $("#vault-action").textContent = vaultState === "none" ? "ENABLE VAULT" : vaultState === "locked" ? "UNLOCK VAULT" : "LOCK VAULT";
}

function renderContacts() {
  const picker = $("#contact-picker");
  picker.innerHTML = '<option value="">SAVED CONTACTS</option>';
  for (const contact of contacts) {
    const option = document.createElement("option"); option.value=contact.address; option.textContent=contact.name; picker.append(option);
  }
  picker.disabled = contacts.length === 0;
  $("#contact-list").innerHTML = contacts.length
    ? contacts.map((contact)=>`<div class="contact-entry"><div><b>${escapeHtml(contact.name)}</b><code>${escapeHtml(short(contact.address,12))}</code></div><button type="button" data-address="${contact.address}" aria-label="Remove ${escapeHtml(contact.name)}">REMOVE</button></div>`).join("")
    : '<div class="contact-empty">NO SAVED CONTACTS YET</div>';
  renderRecentTransfers();
}

async function showReceipt(height) {
  const block = await api(`/blocks/${height}`);
  const tx = block.transactions[0];
  receiptCopyValue = tx.id || block.hash;
  $("#receipt-height").textContent = `#${block.height}`;
  $("#receipt-time").textContent = new Date(block.timestamp).toLocaleString();
  const type = tx.type === "genesis" ? "Network genesis" : tx.type === "faucet" ? "Treasury faucet distribution" : tx.type==="market_buy" ? "USD market purchase" : tx.type==="contract_deploy" ? `${tx.contractType} deployment` : tx.type==="contract_execute" ? "Contract execution" : tx.type==="contract_claim" ? "Hashlock claim" : tx.type==="contract_refund" ? "Hashlock refund" : "E-Coin transfer";
  const fields = [
    ["TYPE",type],
    ...(tx.amount ? [["AMOUNT",`${format(tx.amount)} EC`]] : []),
    ...(tx.from ? [["FROM",tx.from]] : []),
    ...(tx.to ? [["TO",tx.to]] : []),
    ...(tx.fee != null ? [["FEE",`${format(tx.fee)} EC`]] : []),
    ...(tx.usdCents != null ? [["USD VALUE",`$${(tx.usdCents/100).toFixed(2)}`],["MARKET PRICE",`$${(tx.priceMicroUsd/1_000_000).toFixed(6)} / EC`]] : []),
    ...(tx.memo ? [["MEMO",tx.memo]] : []),
    ["RECEIPT ID",receiptCopyValue],
    ["BLOCK HASH",block.hash],
    ["STATE ROOT",block.stateRoot],
  ];
  $("#receipt-fields").innerHTML = fields.map(([label,value]) => `<div><dt>${escapeHtml(label)}</dt><dd title="${escapeHtml(value)}">${escapeHtml(value)}</dd></div>`).join("");
  $("#receipt-overlay").hidden=false; $("#close-receipt").focus();
}

function showWallet() { $("#address").textContent = wallet.address; $("#address").title = wallet.address; renderWallets(); renderRecentTransfers(); renderTransferTemplates(); renderPaymentPlans(); renderReceivePanel(); }
async function sha256Text(value) { const digest=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value))); return [...digest].map((byte)=>byte.toString(16).padStart(2,"0")).join(""); }
function fromBase64Url(value) { const base64=value.replace(/-/g,"+").replace(/_/g,"/").padEnd(Math.ceil(value.length/4)*4,"="); return Uint8Array.from(atob(base64), (c)=>c.charCodeAt(0)); }
function toBase64Url(bytes) { return btoa(String.fromCharCode(...bytes)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,""); }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]); }

const quiz=[
  {question:"Where do faucet coins come from?",options:["New issuance each time","The existing Genesis Treasury","Transaction fees"],answer:1},
  {question:"What should you do before a large transfer?",options:["Disable the vault","Test the destination with a small amount","Reuse a weak password"],answer:1},
  {question:"Why does every account use a nonce?",options:["To preserve order and stop replay","To hide the recipient","To increase the supply"],answer:0},
  {question:"What is different about a vesting contract?",options:["It mints rewards","It releases scheduled installments","It can ignore signatures"],answer:1},
  {question:"What is the safest response to a surprise crypto opportunity?",options:["Act immediately","Treat it as a scam until verified","Share your seed phrase to confirm"],answer:1},
  {question:"What is the best home for a recovery backup?",options:["An offline location you control","A public chat thread","A screenshot in your cloud photo roll"],answer:0},
];
let quizIndex=0; let quizScore=0; let quizAnswered=false;
function renderQuiz() {
  const item=quiz[quizIndex]; quizAnswered=false;
  $("#quiz-question").textContent=item.question;
  $("#quiz-options").innerHTML=item.options.map((option,index)=>`<button class="quiz-option" type="button" data-option="${index}">${escapeHtml(option)}</button>`).join("");
  $("#quiz-progress").textContent=`QUESTION ${quizIndex+1} / ${quiz.length}`;
  $("#quiz-score").textContent=`SCORE ${quizScore}`;
}
$("#quiz-options").addEventListener("click",(event)=>{
  const option=event.target.closest(".quiz-option"); if (!option||quizAnswered) return;
  quizAnswered=true; const selected=Number(option.dataset.option); const correct=quiz[quizIndex].answer;
  option.classList.add(selected===correct?"correct":"wrong");
  $("#quiz-options").children[correct].classList.add("correct");
  if (selected===correct) quizScore++;
  $("#quiz-score").textContent=`SCORE ${quizScore}`;
  setTimeout(()=>{ if (quizIndex===quiz.length-1) { toast(`Knowledge check complete: ${quizScore}/${quiz.length}`); quizIndex=0; quizScore=0; } else quizIndex++; renderQuiz(); },900);
});
document.querySelectorAll(".nav-link").forEach((button)=>button.addEventListener("click",()=>{
  const view=button.dataset.view; $("#wallet-view").hidden=view!=="wallet"; $("#learn-view").hidden=view!=="learn"; $("#data-view").hidden=view!=="data";
  document.querySelectorAll(".nav-link").forEach((item)=>item.classList.toggle("active",item===button));
  history.replaceState(null,"",`#${view}`); window.scrollTo({top:0,behavior:"smooth"});
}));
renderQuiz();

try { contacts=(JSON.parse(localStorage.getItem(contactsKey)) || []).filter((contact)=>contact && typeof contact.name==="string" && /^ec1[0-9a-f]{38}$/.test(contact.address)); loadWatchlist(); loadWatchlistSnapshot(); loadMarketAlerts(); renderContacts(); await loadWallets(); loadRecentTransfers(); loadTransferTemplates(); loadWalletHistory(); loadPaymentPlans(); await ensureTreasuryWallet(); showWallet(); $("#send-form").reset(); renderWatchlist(currentAccount); renderRecentTransfers(); renderTransferTemplates(); renderWalletHistory(); renderWalletDiagnostics(); renderPaymentPlans(); await refresh(); const initialView=["#learn","#data"].includes(location.hash)?location.hash.slice(1):"wallet"; document.querySelector(`[data-view="${initialView}"]`).click(); connectEventStream(); setInterval(updateBlockClock,250); setInterval(() => refresh().catch(()=>{}), 15_000); }
catch (error) { $("#address").textContent = "Wallet unavailable"; toast(error.message, true); }
