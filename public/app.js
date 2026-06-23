import { decryptRecoveryBundle, decryptWalletVault, encryptRecoveryBundle, encryptWalletVault, stripWalletSecretsFromCollection } from "./vault.js";

const SCALE = 1_000_000;
const PENDING_TTL_MS = 10 * 60_000;
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
const paymentRequestsKey = "ecoin.paymentRequests.v1";
const recentTransfersKey = "ecoin.recentTransfers.v1";
const transferTemplatesKey = "ecoin.transferTemplates.v1";
const transactionGuardKey = "ecoin.transactionGuard.v1";
const spendJournalKey = "ecoin.spendJournal.v1";
const sessionSecurityKey = "ecoin.sessionSecurity.v1";
const recoveryAuditKey = "ecoin.recoveryAudit.v1";
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
let paymentRequestsByWallet = {};
let paymentRequests = [];
let walletActivity = [];
let walletActivitySummary = { inflow:0, outflow:0, fees:0, net:0, counterparties:0, txCount:0, firstSeen:null, lastSeen:null, anomalies:[] };
let recentTransfersByWallet = {};
let recentTransfers = [];
let transferTemplatesByWallet = {};
let transferTemplates = [];
let guardPolicies = {};
let guardPolicy = { dailyLimit:0, reserve:5 * SCALE, knownOnly:false };
let spendJournalByWallet = {};
let spendJournal = [];
let portfolioEntries = [];
let portfolioUpdatedAt = 0;
let batchDraft = [];
let currentContracts = [];
let contractFlowFilter = "all";
let pendingRecoveryEnvelope = null;
let sessionSecurity = { timeoutMinutes:15, lockWhenHidden:true };
let lastSensitiveActivity = Date.now();
let recoveryAudit = {};

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
  loadTransactionGuard();
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
  const [status, account, blocks, mempool, fees, contracts, market, activityResponse] = await Promise.all([
    api("/status"),
    api(`/accounts/${wallet.address}`),
    api(`/blocks?limit=10`),
    api("/mempool"),
    api("/fees"),
    api(`/contracts?address=${wallet.address}`),
    api(`/market?address=${wallet.address}`),
    api(`/accounts/${wallet.address}/activity?limit=120`),
  ]);
  currentStatus=status; marketData=market;
  currentAccount = account;
  walletActivity = Array.isArray(activityResponse?.activity) ? activityResponse.activity : [];
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
  renderBatchComposer();
  loadedBlocks=[...new Map([...blocks,...loadedBlocks].map((block)=>[block.hash,block])).values()].sort((a,b)=>b.height-a.height);
  currentPending=mempool.transactions;
  renderBlocks(loadedBlocks,currentPending); updateLoadMore();
  renderPendingControl();
  renderContracts(contracts);
  renderWalletIntel(status, account, contracts, market);
  recordWalletHistory(account, market, status);
  renderWalletHistory();
  renderWalletDiagnostics();
  renderPaymentPlans();
  renderPaymentRequests();
  renderWalletActivity(walletActivity, account);
  renderData(market,status,blocks);
  await refreshPortfolio(market, status);
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

function renderPendingControl() {
  if (!$("#pending-list") || !wallet) return;
  const outgoing = currentPending.filter((tx) => tx.from === wallet.address && tx.type === "transfer").sort((a, b) => a.nonce - b.nonce);
  const reserved = outgoing.reduce((sum, tx) => sum + tx.amount + tx.fee, 0);
  const capacity = Math.max(1, currentStatus?.metrics?.blockCapacity || 1);
  const nextEta = outgoing.length ? Math.max(0, nextBlockAt - Date.now()) : 0;
  $("#pending-own-count").textContent = `${outgoing.length} TRANSFER${outgoing.length === 1 ? "" : "S"}`;
  $("#pending-own-value").textContent = `${format(reserved)} EC`;
  $("#pending-own-eta").textContent = outgoing.length ? `${formatDuration(nextEta)} / ~${Math.max(1, Math.ceil(outgoing.length / capacity))} BLOCKS` : "—";
  if (!outgoing.length) {
    $("#pending-guidance").textContent = "No outgoing transfers are waiting for settlement.";
    $("#pending-list").innerHTML = '<p class="empty">Queued transfers will appear here with fee and expiry intelligence.</p>';
    return;
  }
  const urgentCount = outgoing.filter((tx) => PENDING_TTL_MS - (Date.now() - (tx.queuedAt ?? tx.timestamp)) < 2 * 60_000 || tx.fee < feeQuote.standard).length;
  $("#pending-guidance").textContent = urgentCount
    ? `${urgentCount} transfer${urgentCount === 1 ? " needs" : "s need"} attention because its fee is below the current standard or its queue lifetime is running low.`
    : "The queue looks healthy. Fee replacement is available if network conditions change before settlement.";
  $("#pending-list").innerHTML = outgoing.map((tx) => {
    const position = currentPending.findIndex((candidate) => candidate.id === tx.id) + 1;
    const age = Math.max(0, Date.now() - (tx.queuedAt ?? tx.timestamp));
    const expiresIn = Math.max(0, PENDING_TTL_MS - age);
    const recommendedFee = Math.max(Math.ceil(tx.fee * 1.1), feeQuote.priority);
    const extraFee = recommendedFee - tx.fee;
    const lowFee = tx.fee < feeQuote.standard;
    const urgent = expiresIn < 2 * 60_000 || lowFee;
    const canBump = vaultState !== "locked" && currentAccount.availableBalance >= extraFee;
    const contact = contacts.find((entry) => entry.address === tx.to);
    return `<article class="pending-item ${urgent ? "urgent" : ""}">
      <div><b>${escapeHtml(contact?.name || short(tx.to, 11))} · ${escapeHtml(format(tx.amount))} EC</b><p>Nonce ${tx.nonce} · queue position ${position} · fee ${escapeHtml(format(tx.fee))} EC · expires in ${escapeHtml(formatDuration(expiresIn))}</p><div class="pending-tags"><span class="pending-tag ${lowFee ? "warning" : ""}">${lowFee ? "BELOW STANDARD" : "FEE HEALTHY"}</span><span class="pending-tag">${Math.max(1, Math.ceil(position / capacity))} BLOCK EST.</span><span class="pending-tag">${escapeHtml(relativeTime(tx.queuedAt ?? tx.timestamp))}</span></div></div>
      <div class="pending-speed"><span>+${escapeHtml(format(extraFee))} EC</span><button type="button" data-speed-up="${escapeHtml(tx.id)}" ${canBump ? "" : "disabled"}>SPEED UP</button></div>
    </article>`;
  }).join("");
}

function renderContracts(contracts) {
  currentContracts = contracts;
  $("#contract-count").textContent=contracts.length;
  const locked=contracts.filter((contract)=>contract.creator===wallet.address&&["locked","vesting"].includes(contract.status)).reduce((sum,contract)=>sum+contract.amount-(contract.releasedAmount??0),0);
  $("#contract-locked").textContent=`${format(locked)} EC`;
  $("#contract-list").innerHTML=contracts.length ? contracts.map((contract)=>`<div class="contract-row"><span class="contract-status ${contract.status}">${contract.contractType.toUpperCase()} / ${contract.status.toUpperCase()}</span><span>${escapeHtml(format(contract.amount-(contract.releasedAmount??0)))} EC remaining → ${escapeHtml(short(contract.beneficiary,10))}</span><code title="${contract.address}">${escapeHtml(short(contract.address,12))}</code>${contract.contractType==="hashlock"&&contract.status==="locked"?`<button class="contract-claim" type="button" data-claim="${contract.address}">CLAIM</button>`:`<time>${contract.status==="released"?"RELEASED":contract.status==="refunded"?"REFUNDED":contract.contractType==="vesting"?`${contract.releasedInstallments}/${contract.installments} PAID`:new Date(contract.unlockTime).toLocaleDateString()}</time>`}</div>`).join("") : '<p class="empty">No contracts for this wallet yet.</p>';
  renderContractIntelligence(contracts);
}

function contractTimelineRows(contracts = currentContracts) {
  const rows = [];
  for (const contract of contracts) {
    if (!["locked", "vesting"].includes(contract.status)) continue;
    const remaining = contract.amount - (contract.releasedAmount ?? 0);
    if (contract.contractType === "hashlock") {
      const isBeneficiary = contract.beneficiary === wallet.address;
      rows.push({ contract, dueAt:contract.refundTime, amount:remaining, direction:"incoming", kind:isBeneficiary ? "CLAIM DEADLINE" : "REFUND FALLBACK", detail:isBeneficiary ? "Reveal the correct secret before expiry" : "Returns only if the beneficiary does not claim", installment:1 });
      continue;
    }
    const installments = contract.installments ?? 1;
    const released = contract.releasedInstallments ?? 0;
    const baseAmount = Math.floor(contract.amount / installments);
    for (let index = released; index < installments; index++) {
      rows.push({
        contract,
        dueAt:contract.unlockTime + index * (contract.intervalMs ?? 0),
        amount:index === installments - 1 ? contract.amount - baseAmount * (installments - 1) : baseAmount,
        direction:contract.beneficiary === wallet.address ? "incoming" : "outgoing",
        kind:contract.contractType === "vesting" ? `INSTALLMENT ${index + 1}/${installments}` : "TIMELOCK RELEASE",
        detail:contract.memo || `${contract.contractType} contract ${short(contract.address, 9)}`,
        installment:index + 1,
      });
    }
  }
  return rows.sort((a, b) => a.dueAt - b.dueAt || a.contract.address.localeCompare(b.contract.address));
}

function renderContractIntelligence(contracts = currentContracts) {
  if (!$("#contract-timeline")) return;
  const active = contracts.filter((contract) => ["locked", "vesting"].includes(contract.status));
  const outbound = active.filter((contract) => contract.creator === wallet.address).reduce((sum, contract) => sum + contract.amount - (contract.releasedAmount ?? 0), 0);
  const inbound = active.filter((contract) => contract.beneficiary === wallet.address).reduce((sum, contract) => sum + contract.amount - (contract.releasedAmount ?? 0), 0);
  const allRows = contractTimelineRows(contracts);
  const now = Date.now();
  const soonThreshold = now + 7 * 24 * 60 * 60_000;
  const urgent = allRows.filter((row) => row.dueAt <= now + 60 * 60_000).length;
  const hashlocks = active.filter((contract) => contract.contractType === "hashlock").length;
  const capitalBase = Math.max(1, outbound + (currentAccount.availableBalance ?? 0));
  const concentration = outbound / capitalBase;
  const longHorizon = allRows.some((row) => row.dueAt > now + 180 * 24 * 60 * 60_000);
  const risk = Math.min(100, urgent * 20 + hashlocks * 8 + (concentration > .75 ? 20 : concentration > .4 ? 10 : 0) + (longHorizon ? 10 : 0));
  $("#contract-outbound").textContent = `${format(outbound)} EC`;
  $("#contract-inbound").textContent = `${format(inbound)} EC`;
  $("#contract-next-flow").textContent = allRows.length ? (allRows[0].dueAt <= now ? "READY NOW" : formatDuration(allRows[0].dueAt - now)) : "—";
  $("#contract-risk").textContent = `${risk} / 100`;
  $("#contract-intel-guidance").textContent = !active.length
    ? "No active programmable payments. New contracts will appear here with a deterministic release forecast."
    : urgent
      ? `${urgent} cash-flow event${urgent === 1 ? " is" : "s are"} due within one hour. Verify hashlock secrets and beneficiary addresses now.`
      : concentration > .75
        ? "Most deployable value is committed to contracts. Keep enough liquid EC available for fees and unexpected operating needs."
        : `${active.length} active contract${active.length === 1 ? "" : "s"} produce ${allRows.length} forecast cash-flow event${allRows.length === 1 ? "" : "s"}. No immediate deadline pressure is detected.`;
  const filtered = allRows.filter((row) => contractFlowFilter === "all" || row.direction === contractFlowFilter || (contractFlowFilter === "soon" && row.dueAt <= soonThreshold)).slice(0, 40);
  $("#contract-timeline").innerHTML = filtered.length ? filtered.map((row) => {
    const due = row.dueAt <= now;
    const counterparty = row.contract.contractType === "hashlock" && row.kind === "REFUND FALLBACK" ? row.contract.beneficiary : row.direction === "incoming" ? row.contract.creator : row.contract.beneficiary;
    const contact = contacts.find((entry) => entry.address === counterparty);
    const canClaim = row.contract.contractType === "hashlock" && row.contract.status === "locked" && row.contract.beneficiary === wallet.address;
    return `<article class="contract-flow ${row.direction} ${due ? "due" : ""}">
      <time>${due ? "READY NOW" : escapeHtml(formatDuration(row.dueAt - now))}<br>${escapeHtml(new Date(row.dueAt).toLocaleDateString())}</time>
      <div><b>${escapeHtml(row.kind)} · ${escapeHtml(contact?.name || short(counterparty, 9))}</b><p>${escapeHtml(row.detail)} · ${escapeHtml(short(row.contract.address, 10))}</p></div>
      <strong>${row.direction === "incoming" ? "+" : "−"}${escapeHtml(format(row.amount))} EC</strong>
      ${canClaim ? `<button type="button" data-contract-flow-claim="${escapeHtml(row.contract.address)}">CLAIM</button>` : ""}
    </article>`;
  }).join("") : '<p class="empty">No contract cash flows match this filter.</p>';
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

async function refreshPortfolio(market = marketData, status = currentStatus, force = false) {
  if (!market || !status || !wallets.length || !$("#portfolio-list")) return;
  if (!force && portfolioEntries.length && Date.now() - portfolioUpdatedAt < 10_000) {
    portfolioEntries = portfolioEntries.map((entry) => entry.wallet.address === wallet.address ? { ...entry, account:currentAccount, available:true, error:null } : entry);
    renderPortfolio(market, status);
    return;
  }
  const results = await Promise.all(wallets.map(async (candidate) => {
    try {
      const account = candidate.address === wallet.address ? currentAccount : await api(`/accounts/${candidate.address}`);
      return { wallet:candidate, account, available:true };
    } catch (error) {
      return { wallet:candidate, account:{ balance:0, availableBalance:0, marketPosition:0, marketLocked:0, pendingOutgoing:0, pendingIncoming:0, insights:{ transactionCount:0 } }, available:false, error:error.message };
    }
  }));
  portfolioEntries = results;
  portfolioUpdatedAt = Date.now();
  renderPortfolio(market, status);
}

function renderPortfolio(market = marketData, status = currentStatus) {
  if (!market || !status || !$("#portfolio-list")) return;
  const colors = ["#c7f36b", "#ff9f6b", "#70c7b8", "#9d8cff", "#f0d264", "#e87b9e"];
  const enriched = portfolioEntries.map((entry, index) => {
    const marketPosition = Number(entry.account.marketPosition || 0);
    const holdings = Math.max(0, Number(entry.account.balance || 0) + marketPosition);
    const availableBalance = Math.max(0, Number(entry.account.availableBalance || 0));
    return { ...entry, holdings, availableBalance, reserved:Math.max(0, holdings - availableBalance), color:colors[index % colors.length] };
  }).sort((a, b) => b.holdings - a.holdings || a.wallet.name.localeCompare(b.wallet.name));
  const total = enriched.reduce((sum, entry) => sum + entry.holdings, 0);
  const available = enriched.reduce((sum, entry) => sum + entry.availableBalance, 0);
  const reserved = enriched.reduce((sum, entry) => sum + entry.reserved, 0);
  const largestShare = total ? enriched[0]?.holdings / total : 0;
  const diversity = total ? 1 / enriched.reduce((sum, entry) => sum + (entry.holdings / total) ** 2, 0) : 0;
  const pending = enriched.reduce((sum, entry) => sum + Number(entry.account.pendingOutgoing || 0) + Number(entry.account.pendingIncoming || 0), 0);
  const failed = enriched.filter((entry) => !entry.available).length;
  const treasury = enriched.find((entry) => entry.wallet.address === status.treasuryAddress);
  const operating = enriched.filter((entry) => entry.wallet.address !== status.treasuryAddress);
  const operatingTotal = operating.reduce((sum, entry) => sum + entry.holdings, 0);
  const operatingLargest = operatingTotal ? Math.max(...operating.map((entry) => entry.holdings)) / operatingTotal : 0;
  const health = failed ? "CHECK CONNECTION" : vaultState === "none" ? "PROTECT KEYS" : pending > 3 ? "QUEUE ACTIVE" : "HEALTHY";
  const healthNote = failed
    ? `${failed} wallet${failed === 1 ? "" : "s"} could not be read.`
    : vaultState === "none"
      ? "Enable the encrypted vault for stronger key protection."
      : `${pending} pending movement${pending === 1 ? "" : "s"} across ${enriched.length} wallets.`;
  $("#portfolio-total").textContent = `${format(total)} EC`;
  $("#portfolio-usd").textContent = `${(total / SCALE * market.priceUsd).toLocaleString(undefined, { style:"currency", currency:"USD", maximumFractionDigits:2 })} at the internal quote`;
  $("#portfolio-available").textContent = `${format(available)} EC`;
  $("#portfolio-reserved").textContent = `${format(reserved)} EC reserved or committed`;
  $("#portfolio-concentration").textContent = `${(largestShare * 100).toFixed(1)}%`;
  $("#portfolio-diversity").textContent = `${diversity.toFixed(2)} effective wallets`;
  $("#portfolio-health").textContent = health;
  $("#portfolio-health-note").textContent = healthNote;
  $("#portfolio-allocation-bar").innerHTML = enriched.filter((entry) => entry.holdings > 0).map((entry) => `<span class="portfolio-segment" title="${escapeHtml(entry.wallet.name)} ${(entry.holdings / total * 100).toFixed(2)}%" style="width:${entry.holdings / total * 100}%;background:${entry.color}"></span>`).join("");
  const treasuryShare = total && treasury ? treasury.holdings / total : 0;
  $("#portfolio-guidance").textContent = treasuryShare > .9
    ? `Genesis treasury represents ${(treasuryShare * 100).toFixed(1)}% of local holdings, which is expected before broader distribution. ${operating.length > 1 ? `Outside treasury, the largest wallet holds ${(operatingLargest * 100).toFixed(1)}% of operating funds.` : "Create or fund another wallet to build an operating allocation."}`
    : largestShare > .75
      ? "Holdings are highly concentrated in one wallet. Separate operating funds from long-term reserves and keep both vault-protected."
      : "Holdings are distributed across the local wallet set. Review pending and reserved balances before large transfers.";
  $("#portfolio-list").innerHTML = enriched.length ? enriched.map((entry) => {
    const share = total ? entry.holdings / total * 100 : 0;
    const badges = [entry.wallet.address === status.treasuryAddress ? "GENESIS" : "LOCAL", entry.wallet.address === wallet.address ? "ACTIVE" : null, entry.available ? null : "OFFLINE"].filter(Boolean).join(" · ");
    return `<article class="portfolio-row ${entry.wallet.address === wallet.address ? "active" : ""}">
      <div><b><span class="portfolio-swatch" style="background:${entry.color}"></span>${escapeHtml(entry.wallet.name)}</b><p title="${escapeHtml(entry.wallet.address)}">${escapeHtml(short(entry.wallet.address, 12))} · ${escapeHtml(badges)}</p></div>
      <div class="portfolio-cell"><span>HOLDINGS</span><strong>${escapeHtml(format(entry.holdings))} EC</strong></div>
      <div class="portfolio-cell"><span>AVAILABLE</span><strong>${escapeHtml(format(entry.availableBalance))} EC</strong></div>
      <div class="portfolio-cell"><span>ALLOCATION</span><strong>${share.toFixed(2)}%</strong></div>
      <button type="button" data-portfolio-wallet="${escapeHtml(entry.wallet.address)}" ${entry.wallet.address === wallet.address ? "disabled" : ""}>${entry.wallet.address === wallet.address ? "ACTIVE" : "OPEN"}</button>
    </article>`;
  }).join("") : '<p class="empty">No local wallets available.</p>';
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

function loadTransactionGuard() {
  try {
    guardPolicies = JSON.parse(localStorage.getItem(transactionGuardKey) || "{}") || {};
    spendJournalByWallet = JSON.parse(localStorage.getItem(spendJournalKey) || "{}") || {};
  } catch {
    guardPolicies = {};
    spendJournalByWallet = {};
  }
  const stored = guardPolicies[wallet?.address] || {};
  guardPolicy = {
    dailyLimit: Number.isSafeInteger(stored.dailyLimit) && stored.dailyLimit >= 0 ? stored.dailyLimit : 0,
    reserve: Number.isSafeInteger(stored.reserve) && stored.reserve >= 0 ? stored.reserve : 5 * SCALE,
    knownOnly: Boolean(stored.knownOnly),
  };
  spendJournal = Array.isArray(spendJournalByWallet[wallet?.address])
    ? spendJournalByWallet[wallet.address].filter((entry) => entry && Number.isSafeInteger(entry.amount) && Number.isFinite(entry.timestamp)).slice(0, 200)
    : [];
}

function loadSessionSecurity() {
  try {
    const stored = JSON.parse(localStorage.getItem(sessionSecurityKey) || "{}") || {};
    const timeoutMinutes = [0, 5, 15, 30, 60].includes(Number(stored.timeoutMinutes)) ? Number(stored.timeoutMinutes) : 15;
    sessionSecurity = { timeoutMinutes, lockWhenHidden:stored.lockWhenHidden !== false };
    recoveryAudit = JSON.parse(localStorage.getItem(recoveryAuditKey) || "{}") || {};
  } catch {
    sessionSecurity = { timeoutMinutes:15, lockWhenHidden:true };
    recoveryAudit = {};
  }
}

function saveSessionSecurity() {
  localStorage.setItem(sessionSecurityKey, JSON.stringify(sessionSecurity));
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

function loadPaymentRequests() {
  try {
    paymentRequestsByWallet = JSON.parse(localStorage.getItem(paymentRequestsKey) || "{}") || {};
  } catch {
    paymentRequestsByWallet = {};
  }
  paymentRequests = Array.isArray(paymentRequestsByWallet[wallet?.address])
    ? paymentRequestsByWallet[wallet.address].filter((request) => request && typeof request.label === "string" && typeof request.address === "string" && /^ec1[0-9a-f]{38}$/.test(request.address))
    : [];
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

function saveTransactionGuard() {
  if (!wallet?.address) return;
  guardPolicies[wallet.address] = guardPolicy;
  localStorage.setItem(transactionGuardKey, JSON.stringify(guardPolicies));
}

function saveSpendJournal() {
  if (!wallet?.address) return;
  spendJournalByWallet[wallet.address] = spendJournal.slice(0, 200);
  localStorage.setItem(spendJournalKey, JSON.stringify(spendJournalByWallet));
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

function savePaymentRequests() {
  if (!wallet?.address) return;
  paymentRequestsByWallet[wallet.address] = paymentRequests.slice(0, 24);
  localStorage.setItem(paymentRequestsKey, JSON.stringify(paymentRequestsByWallet));
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

function createPaymentRequest() {
  const label = $("#request-label").value.trim();
  const amountValue = $("#request-amount").value.trim();
  const memo = $("#request-memo").value.trim();
  const expiresHours = Number($("#request-expiry").value);
  const amount = amountValue ? Math.round(Number(amountValue) * SCALE) : 0;
  if (!label) throw new Error("Request label cannot be blank");
  if (amountValue && (!Number.isSafeInteger(amount) || amount < 0)) throw new Error("Enter a valid request amount");
  if (!Number.isFinite(expiresHours) || expiresHours < 0) throw new Error("Enter a valid expiry window");
  const request = {
    id: crypto.randomUUID(),
    label,
    address: wallet.address,
    amount,
    memo,
    createdAt: Date.now(),
    expiresAt: expiresHours ? Date.now() + expiresHours * 60 * 60_000 : null,
    fulfilledAt: null,
    archivedAt: null,
  };
  paymentRequests = [request, ...paymentRequests];
  savePaymentRequests();
  renderPaymentRequests();
  return request;
}

function requestState(request, now = Date.now()) {
  if (request.archivedAt) return "archived";
  if (request.fulfilledAt) return "fulfilled";
  if (request.expiresAt && request.expiresAt <= now) return "expired";
  return "open";
}

function requestUriFor(request) {
  return paymentRequestUri(request.address, request.amount ? (request.amount / SCALE).toFixed(6) : "", request.memo || "");
}

function fillPaymentRequest(request) {
  $("#recipient").value = request.address;
  if (request.amount) $("#amount").value = (request.amount / SCALE).toFixed(6);
  $("#memo").value = request.memo || request.label || "";
  updateComposer();
  toast("Payment request loaded into the send form");
}

function renderPaymentRequests() {
  const summary = $("#request-summary");
  const list = $("#request-list");
  if (!summary || !list) return;
  const now = Date.now();
  const active = paymentRequests.filter((request) => requestState(request, now) === "open");
  const completed = paymentRequests.filter((request) => requestState(request, now) === "fulfilled").length;
  const expired = paymentRequests.filter((request) => requestState(request, now) === "expired").length;
  const nextDue = active.filter((request) => request.expiresAt).sort((a, b) => a.expiresAt - b.expiresAt)[0];
  summary.textContent = paymentRequests.length
    ? `${active.length} active request${active.length === 1 ? "" : "s"} · ${completed} fulfilled · ${expired} expired${nextDue ? ` · next expiry ${formatDuration(Math.max(0, nextDue.expiresAt - now))}` : ""}`
    : "Create an invoice-style request that can be copied, shared, and filled back into the send form.";
  list.innerHTML = paymentRequests.length ? paymentRequests.map((request) => {
    const state = requestState(request, now);
    const expiresIn = request.expiresAt ? Math.max(0, request.expiresAt - now) : null;
    const label = request.label || "Untitled request";
    const amount = request.amount ? `${format(request.amount)} EC` : "OPEN AMOUNT";
    const uri = requestUriFor(request);
    return `<article class="request-item ${state}">
      <div>
        <b>${escapeHtml(label)}</b>
        <p>${escapeHtml(amount)} · ${escapeHtml(request.memo || "No memo")} · ${escapeHtml(state.toUpperCase())}</p>
        <div class="request-meta">
          <span>CREATED ${escapeHtml(relativeTime(request.createdAt))}</span>
          <span>${request.expiresAt ? `EXPIRES ${escapeHtml(expiresIn <= 0 ? "NOW" : formatDuration(expiresIn))}` : "NO EXPIRY"}</span>
        </div>
      </div>
      <div class="request-actions">
        <button type="button" data-request-fill="${escapeHtml(request.id)}">FILL</button>
        <button type="button" data-request-copy="${escapeHtml(uri)}">COPY</button>
        <button type="button" data-request-share="${escapeHtml(uri)}">SHARE</button>
        <button type="button" data-request-toggle="${escapeHtml(request.id)}">${state === "fulfilled" ? "REOPEN" : "MARK PAID"}</button>
        <button type="button" data-request-archive="${escapeHtml(request.id)}">${state === "archived" ? "RESTORE" : "ARCHIVE"}</button>
      </div>
    </article>`;
  }).join("") : '<p class="empty">No payment requests yet.</p>';
}

function activityKindLabel(tx) {
  if (tx.type === "market_buy") return "Treasury purchase";
  if (tx.type === "faucet") return "Faucet grant";
  if (tx.type === "contract_deploy") return `${tx.contractType || "contract"} deployment`;
  if (tx.type === "contract_execute") return "Contract release";
  if (tx.type === "contract_claim") return "Hashlock claim";
  if (tx.type === "contract_refund") return "Hashlock refund";
  return "Transfer";
}

function activityDirection(tx) {
  if (tx.from === wallet.address && tx.to === wallet.address) return "self";
  if (tx.to === wallet.address) return "in";
  if (tx.from === wallet.address) return "out";
  return "other";
}

function summarizeWalletActivity(entries = []) {
  const inflow = entries.filter((tx) => tx.to === wallet.address).reduce((sum, tx) => sum + Number(tx.amount || 0), 0);
  const outflow = entries.filter((tx) => tx.from === wallet.address).reduce((sum, tx) => sum + Number(tx.amount || 0), 0);
  const fees = entries.filter((tx) => tx.from === wallet.address).reduce((sum, tx) => sum + Number(tx.fee || 0), 0);
  const counterparties = new Set(entries.flatMap((tx) => [tx.from, tx.to]).filter((address) => address && address !== wallet.address));
  const ordered = [...entries].sort((a, b) => a.settledAt - b.settledAt);
  const firstSeen = ordered[0]?.settledAt ?? null;
  const lastSeen = ordered.at(-1)?.settledAt ?? null;
  const outgoing = entries.filter((tx) => tx.from === wallet.address && Number.isSafeInteger(tx.amount));
  const averageSend = outgoing.length ? outgoing.reduce((sum, tx) => sum + tx.amount, 0) / outgoing.length : 0;
  const anomalies = [];
  const largest = outgoing.sort((a, b) => b.amount - a.amount)[0];
  if (largest && averageSend > 0 && largest.amount >= averageSend * 3) {
    anomalies.push({ tone:"warning", text:`Largest outgoing transfer is ${(largest.amount / SCALE).toFixed(6)} EC, about ${(largest.amount / averageSend).toFixed(1)}x your average send.` });
  }
  if (outflow > 0 && inflow === 0) {
    anomalies.push({ tone:"warning", text:"This wallet has only spent funds so far. Consider rechecking the funding path and backups." });
  }
  if (entries.length >= 6 && lastSeen && firstSeen) {
    const spanDays = Math.max(1, (lastSeen - firstSeen) / (24 * 60 * 60_000));
    const cadence = entries.length / spanDays;
    if (cadence > 12) anomalies.push({ tone:"warning", text:"Transaction cadence is high. Review whether automation or a compromised key is expected here." });
  }
  return {
    inflow,
    outflow,
    fees,
    net: inflow - outflow - fees,
    counterparties: counterparties.size,
    txCount: entries.length,
    firstSeen,
    lastSeen,
    anomalies,
  };
}

function renderWalletActivity(activity = walletActivity, account = currentAccount) {
  const summaryNode = $("#activity-summary");
  const list = $("#activity-list");
  const note = $("#activity-note");
  if (!summaryNode || !list || !note) return;
  const summary = walletActivitySummary = summarizeWalletActivity(activity);
  $("#activity-inflow").textContent = `${format(summary.inflow)} EC`;
  $("#activity-outflow").textContent = `${format(summary.outflow)} EC`;
  $("#activity-fees").textContent = `${format(summary.fees)} EC`;
  $("#activity-net").textContent = `${summary.net >= 0 ? "+" : ""}${format(Math.abs(summary.net))} EC`;
  $("#activity-count").textContent = `${summary.txCount} TX`;
  $("#activity-counterparties").textContent = `${summary.counterparties} peers`;
  $("#activity-window").textContent = summary.firstSeen && summary.lastSeen ? `${relativeTime(summary.firstSeen)} → ${relativeTime(summary.lastSeen)}` : "No history yet";
  const newest = activity[0];
  const oldest = activity.at(-1);
  const stateLabel = newest ? `${activityKindLabel(newest)} · ${relativeTime(newest.settledAt)}` : "No confirmed activity yet";
  summaryNode.textContent = `${summary.txCount} confirmed event${summary.txCount === 1 ? "" : "s"} · ${summary.counterparties} ${summary.counterparties === 1 ? "counterparty" : "counterparties"} · ${summary.net >= 0 ? "net positive" : "net negative"}`;
  note.textContent = summary.anomalies.length ? summary.anomalies[0].text : newest ? `Latest activity: ${stateLabel}` : "No on-chain activity has settled for this wallet yet.";
  list.innerHTML = activity.length ? activity.map((tx) => {
    const direction = activityDirection(tx);
    const tone = direction === "in" ? "good" : direction === "out" ? "warning" : "neutral";
    const counterparty = direction === "in" ? tx.from : tx.to;
    const counterpartyLabel = counterparty && counterparty !== wallet.address ? (contacts.find((entry) => entry.address === counterparty)?.name ?? short(counterparty, 10)) : wallet.name;
    const value = tx.amount != null ? `${direction === "out" ? "−" : "+"}${format(tx.amount)} EC` : "—";
    const fee = tx.fee != null ? ` · fee ${format(tx.fee)} EC` : "";
    return `<article class="activity-item ${tone}">
      <div>
        <b>${escapeHtml(activityKindLabel(tx))}</b>
        <p>${escapeHtml(counterpartyLabel)} · block #${tx.blockHeight ?? "?"}${tx.memo ? ` · ${escapeHtml(tx.memo)}` : ""}</p>
        <div class="activity-meta">
          <span>${escapeHtml(direction.toUpperCase())}</span>
          <span>${escapeHtml(new Date(tx.settledAt).toLocaleString())}</span>
          <span>${escapeHtml(tx.id ? short(tx.id, 12) : "n/a")}</span>
        </div>
      </div>
      <strong>${escapeHtml(value)}${escapeHtml(fee)}</strong>
    </article>`;
  }).join("") : '<p class="empty">No confirmed activity yet.</p>';
  if (summary.anomalies.length) {
    summaryNode.classList.add("warning");
    note.title = summary.anomalies.map((item) => item.text).join(" ");
  } else {
    summaryNode.classList.remove("warning");
    note.title = newest ? `Latest activity timestamp: ${new Date(newest.settledAt).toISOString()}` : "";
  }
  return summary;
}

function exportWalletActivity(formatType = "csv") {
  const entries = walletActivity;
  if (!entries.length) throw new Error("No activity is available to export yet");
  const rows = entries.map((tx) => ({
    settledAt: new Date(tx.settledAt).toISOString(),
    blockHeight: tx.blockHeight,
    type: tx.type,
    direction: activityDirection(tx),
    from: tx.from ?? "",
    to: tx.to ?? "",
    amountEc: tx.amount != null ? (tx.amount / SCALE).toFixed(6) : "",
    feeEc: tx.fee != null ? (tx.fee / SCALE).toFixed(6) : "",
    memo: tx.memo ?? "",
    contractAddress: tx.contractAddress ?? "",
    id: tx.id ?? "",
  }));
  const suffix = formatType === "json" ? "json" : "csv";
  const blob = formatType === "json"
    ? new Blob([JSON.stringify({ wallet: wallet.address, exportedAt: new Date().toISOString(), summary: walletActivitySummary, entries: rows }, null, 2)], { type:"application/json;charset=utf-8" })
    : new Blob([[
      ["settled_at","block_height","type","direction","from","to","amount_ec","fee_ec","memo","contract_address","id"],
      ...rows.map((row) => [row.settledAt,row.blockHeight,row.type,row.direction,row.from,row.to,row.amountEc,row.feeEc,row.memo,row.contractAddress,row.id]),
    ].map((line) => line.map((value) => `"${String(value ?? "").replaceAll('"', '""')}"`).join(",")).join("\n")], { type:"text/csv;charset=utf-8" });
  const link = Object.assign(document.createElement("a"), { href:URL.createObjectURL(blob), download:`ecoin-activity-${wallet.address.slice(0, 10)}.${suffix}` });
  link.click();
  URL.revokeObjectURL(link.href);
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

function spentToday() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return spendJournal.reduce((sum, entry) => entry.timestamp >= start.getTime() ? sum + entry.amount + (entry.fee || 0) : sum, 0);
}

function evaluateTransactionGuard(tx, profile = null) {
  const validAmount = Number.isSafeInteger(tx?.amount) && tx.amount > 0;
  const isKnown = contacts.some((contact) => contact.address === tx?.to);
  const today = spentToday();
  const total = validAmount ? tx.amount + (tx.fee || 0) : 0;
  const after = (currentAccount.availableBalance ?? 0) - total;
  const signals = [];
  let risk = 0;
  let blocked = false;

  if (!validAmount || !/^ec1[0-9a-f]{38}$/.test(tx?.to || "")) {
    return { risk:0, blocked:false, today, room:guardPolicy.dailyLimit ? Math.max(0, guardPolicy.dailyLimit - today) : null, signals:[{ tone:"", text:"Fill a valid recipient and amount for a complete policy check." }] };
  }
  if (!isKnown) {
    risk += 25;
    signals.push({ tone:guardPolicy.knownOnly ? "warning" : "", text:guardPolicy.knownOnly ? "Blocked: the recipient is not a saved contact." : "Recipient is not in your local address book." });
    blocked ||= guardPolicy.knownOnly;
  } else {
    signals.push({ tone:"", text:"Saved contact: the local identity check passed." });
  }
  if (profile && !profile.insights?.transactionCount) {
    risk += 20;
    signals.push({ tone:"warning", text:"The destination has no committed ledger history." });
  }
  if (total > (currentAccount.availableBalance ?? 0) / 2) {
    risk += 30;
    signals.push({ tone:"warning", text:"This transfer spends more than half of the available balance." });
  }
  if (after < guardPolicy.reserve) {
    risk += 25;
    signals.push({ tone:"warning", text:`The balance would fall below your ${format(guardPolicy.reserve)} EC reserve.` });
  }
  if (guardPolicy.dailyLimit && today + total > guardPolicy.dailyLimit) {
    risk += 35;
    blocked = true;
    signals.push({ tone:"warning", text:`Blocked: this send exceeds the ${format(guardPolicy.dailyLimit)} EC daily limit.` });
  }
  if (tx.fee / tx.amount > .05) {
    risk += 10;
    signals.push({ tone:"warning", text:"The network fee is more than 5% of the transfer." });
  }
  if (!signals.some((signal) => signal.tone === "warning")) signals.push({ tone:"", text:"No elevated local policy signals were found." });
  return { risk:Math.min(100, risk), blocked, today, room:guardPolicy.dailyLimit ? Math.max(0, guardPolicy.dailyLimit - today) : null, signals };
}

function renderTransactionGuard(profile = null) {
  if (!$("#guard-risk")) return;
  const amount = Math.round(Number($("#amount").value) * SCALE);
  const result = evaluateTransactionGuard({ to:$("#recipient").value.trim(), amount, fee:activeFee }, profile);
  $("#guard-risk").textContent = `${result.risk} / 100`;
  $("#guard-spent").textContent = `${format(result.today)} EC`;
  $("#guard-room").textContent = result.room == null ? "NO LIMIT" : `${format(result.room)} EC`;
  $("#guard-state").textContent = result.blocked ? "POLICY BLOCK" : result.risk >= 50 ? "HIGH ATTENTION" : "MONITORING";
  $("#guard-guidance").textContent = result.blocked
    ? "This draft cannot be signed under the saved policy. Adjust the transfer or update the policy intentionally."
    : result.risk >= 50
      ? "Review every signal carefully before allowing the wallet to use your signing key."
      : "The guard evaluates each draft before your key is used.";
  $("#guard-signals").innerHTML = result.signals.map((signal) => `<div class="signal ${signal.tone}">${escapeHtml(signal.text)}</div>`).join("");
  $(".guard-panel").classList.toggle("blocked", result.blocked);
}

function renderTransactionGuardSettings() {
  if (!$("#guard-daily-limit")) return;
  $("#guard-daily-limit").value = guardPolicy.dailyLimit ? (guardPolicy.dailyLimit / SCALE).toFixed(6) : "0";
  $("#guard-reserve").value = (guardPolicy.reserve / SCALE).toFixed(6);
  $("#guard-known-only").checked = guardPolicy.knownOnly;
  renderTransactionGuard();
}

function noteSensitiveActivity() {
  if (vaultState !== "unlocked") return;
  lastSensitiveActivity = Date.now();
}

function renderSessionSecurity() {
  if (!$("#session-security-state")) return;
  const timeoutMs = sessionSecurity.timeoutMinutes * 60_000;
  const remaining = timeoutMs ? Math.max(0, timeoutMs - (Date.now() - lastSensitiveActivity)) : null;
  const backupAt = Number(recoveryAudit[wallet?.address] || 0);
  const backupAge = backupAt ? Date.now() - backupAt : null;
  const backupStale = backupAge == null || backupAge > 30 * 24 * 60 * 60_000;
  $("#session-timeout").value = String(sessionSecurity.timeoutMinutes);
  $("#lock-when-hidden").checked = sessionSecurity.lockWhenHidden;
  $("#lock-session-now").disabled = vaultState !== "unlocked";
  $("#recovery-age").textContent = backupAge == null ? "NO ENCRYPTED BACKUP" : backupAge < 60_000 ? "BACKED UP NOW" : `${relativeTime(backupAt).toUpperCase()}`;
  if (vaultState === "none") {
    $("#session-security-state").textContent = "VAULT NOT ENABLED";
    $("#session-countdown").textContent = "NOT PROTECTED";
    $("#session-security-guidance").textContent = "Enable the encrypted vault to use automatic session locking.";
  } else if (vaultState === "locked") {
    $("#session-security-state").textContent = "KEYS LOCKED";
    $("#session-countdown").textContent = "LOCKED";
    $("#session-security-guidance").textContent = backupStale ? "Signing keys are locked. Create a fresh encrypted recovery bundle after unlocking." : "Signing keys are locked and a recent encrypted recovery bundle is recorded locally.";
  } else {
    $("#session-security-state").textContent = "SIGNING ENABLED";
    $("#session-countdown").textContent = remaining == null ? "AUTO-LOCK OFF" : `${String(Math.floor(remaining / 60_000)).padStart(2, "0")}:${String(Math.floor((remaining % 60_000) / 1000)).padStart(2, "0")} TO LOCK`;
    $("#session-security-guidance").textContent = backupStale
      ? "The signing session is open, but no recent encrypted recovery bundle is recorded. Back up before moving significant value."
      : sessionSecurity.timeoutMinutes
        ? `The session locks ${sessionSecurity.lockWhenHidden ? "when hidden or " : ""}after ${sessionSecurity.timeoutMinutes} minutes of inactivity.`
        : sessionSecurity.lockWhenHidden ? "Inactivity locking is off, but the vault still locks whenever the app is hidden." : "Automatic locking is disabled; use Lock Now after signing.";
  }
  $(".session-security").classList.toggle("warn", vaultState === "none" || backupStale);
}

function checkSessionSecurity() {
  if (vaultState !== "unlocked" || !sessionSecurity.timeoutMinutes) return renderSessionSecurity();
  if (Date.now() - lastSensitiveActivity >= sessionSecurity.timeoutMinutes * 60_000) {
    lockVault();
    toast("Vault auto-locked after inactivity");
  }
  renderSessionSecurity();
}

function analyzeBatchPayments() {
  const lines = $("#batch-input")?.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) ?? [];
  const entries = [];
  const errors = [];
  if (lines.length > 32) errors.push("A batch can contain at most 32 transfers.");
  lines.slice(0, 32).forEach((line, index) => {
    const parts = line.split(",");
    const recipientInput = (parts.shift() || "").trim();
    const amountInput = (parts.shift() || "").trim();
    const memo = parts.join(",").trim();
    const contact = contacts.find((item) => item.name.toLowerCase() === recipientInput.toLowerCase());
    const to = contact?.address || recipientInput;
    const amount = Math.round(Number(amountInput) * SCALE);
    if (!/^ec1[0-9a-f]{38}$/.test(to)) errors.push(`Row ${index + 1}: use a valid address or exact contact name.`);
    else if (to === wallet?.address) errors.push(`Row ${index + 1}: the active wallet cannot pay itself.`);
    if (!Number.isSafeInteger(amount) || amount <= 0) errors.push(`Row ${index + 1}: enter a positive amount.`);
    if (memo.length > 96) errors.push(`Row ${index + 1}: memo exceeds 96 characters.`);
    if (/^ec1[0-9a-f]{38}$/.test(to) && to !== wallet?.address && Number.isSafeInteger(amount) && amount > 0 && memo.length <= 96) {
      entries.push({ to, amount, memo, contact:contact?.name || contacts.find((item) => item.address === to)?.name || "" });
    }
  });
  const total = entries.reduce((sum, entry) => sum + entry.amount, 0);
  const fees = entries.length * activeFee;
  const cost = total + fees;
  const after = (currentAccount.availableBalance ?? 0) - cost;
  const unknown = entries.filter((entry) => !contacts.some((contact) => contact.address === entry.to)).length;
  const duplicateRecipients = entries.length - new Set(entries.map((entry) => entry.to)).size;
  const policyReasons = [];
  if (entries.length > 0 && entries.length < 2) policyReasons.push("Add at least two valid payments.");
  if (vaultState === "locked") policyReasons.push("Unlock the vault before batch signing.");
  if (cost > (currentAccount.availableBalance ?? 0)) policyReasons.push("Batch total plus fees exceeds the available balance.");
  if (entries.length && after < guardPolicy.reserve) policyReasons.push(`Batch would cross the ${format(guardPolicy.reserve)} EC minimum reserve.`);
  if (guardPolicy.dailyLimit && spentToday() + cost > guardPolicy.dailyLimit) policyReasons.push(`Batch exceeds the ${format(guardPolicy.dailyLimit)} EC daily send limit.`);
  if (guardPolicy.knownOnly && unknown) policyReasons.push(`${unknown} recipient${unknown === 1 ? " is" : "s are"} not saved contacts.`);
  if ((currentAccount.pendingOutgoing ?? 0) + entries.length > 256) policyReasons.push("Sender pending-transaction limit would be exceeded.");
  const risk = Math.min(100,
    unknown * 10
    + (cost > (currentAccount.availableBalance ?? 0) / 2 ? 30 : 0)
    + (after < guardPolicy.reserve ? 25 : 0)
    + (duplicateRecipients ? 15 : 0)
    + (entries.length > 16 ? 10 : 0)
  );
  return { lines, entries, errors, total, fees, cost, after, unknown, duplicateRecipients, policyReasons, risk, blocked:Boolean(errors.length || policyReasons.length || entries.length < 2) };
}

function renderBatchComposer() {
  if (!$("#batch-input")) return;
  const analysis = analyzeBatchPayments();
  batchDraft = analysis.entries;
  $("#batch-count").textContent = String(analysis.entries.length);
  $("#batch-total").textContent = `${format(analysis.total)} EC`;
  $("#batch-fees").textContent = `${format(analysis.fees)} EC`;
  $("#batch-after").textContent = analysis.entries.length ? `${format(Math.max(0, analysis.after))} EC` : "—";
  const messages = [...analysis.errors, ...analysis.policyReasons];
  $("#batch-status").textContent = messages[0] || `${analysis.entries.length} payments ready · risk ${analysis.risk}/100 · ${analysis.unknown} unsaved recipients`;
  $("#batch-status").className = `search-summary${analysis.blocked ? " warning" : ""}`;
  $("#submit-batch").disabled = analysis.blocked;
  $(".batch-panel").classList.toggle("blocked", analysis.blocked && analysis.entries.length > 0);
  $("#batch-preview").innerHTML = analysis.entries.length ? analysis.entries.map((entry, index) => `<article class="batch-row">
    <span>${index + 1}</span>
    <div><b>${escapeHtml(entry.contact || short(entry.to, 11))}</b><p title="${escapeHtml(entry.to)}">${escapeHtml(short(entry.to, 13))}${entry.memo ? ` · ${escapeHtml(entry.memo)}` : ""}</p></div>
    <strong>${escapeHtml(format(entry.amount))} EC</strong>
  </article>`).join("") : '<p class="empty">The validated batch will appear here.</p>';
}

function recordRecentTransfer(tx) {
  recordRecentTransfers([tx]);
}

function recordRecentTransfers(transactions) {
  const entries = transactions.filter((tx) => tx && tx.from === wallet.address).map((tx) => ({
    to:tx.to,
    amount:tx.amount,
    memo:tx.memo ?? "",
    fee:tx.fee ?? activeFee,
    tier:$("#fee-tier")?.value ?? "standard",
    timestamp:Date.now(),
  }));
  if (!entries.length) return;
  for (const entry of entries.slice().reverse()) {
    recentTransfers = [entry, ...recentTransfers.filter((item) => !(item.to === entry.to && item.amount === entry.amount && item.memo === entry.memo))].slice(0, 8);
    spendJournal = [{ amount:entry.amount, fee:entry.fee, to:entry.to, timestamp:entry.timestamp }, ...spendJournal].slice(0, 200);
  }
  saveRecentTransfers();
  saveSpendJournal();
  renderRecentTransfers();
  renderTransactionGuard();
  renderBatchComposer();
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
$("#create-request").addEventListener("click", () => {
  try {
    const request = createPaymentRequest();
    $("#request-label").value = "";
    $("#request-amount").value = "";
    $("#request-memo").value = "";
    $("#request-expiry").value = "72";
    toast(`Request created: ${request.label}`);
  } catch (error) {
    toast(error.message, true);
  }
});
$("#vault-action").addEventListener("click", () => {
  if (vaultState === "none") return openVaultDialog("create");
  if (vaultState === "locked") return openVaultDialog("unlock");
  lockVault();
  toast("Vault locked");
});
$("#session-timeout").addEventListener("change", (event) => {
  sessionSecurity.timeoutMinutes = Number(event.target.value);
  lastSensitiveActivity = Date.now();
  saveSessionSecurity(); renderSessionSecurity(); toast("Auto-lock policy updated");
});
$("#lock-when-hidden").addEventListener("change", (event) => {
  sessionSecurity.lockWhenHidden = event.target.checked;
  saveSessionSecurity(); renderSessionSecurity(); toast(event.target.checked ? "Hidden-app locking enabled" : "Hidden-app locking disabled");
});
$("#lock-session-now").addEventListener("click", () => {
  if (vaultState !== "unlocked") return;
  lockVault(); toast("Signing session locked");
});
for (const activityEvent of ["pointerdown", "keydown"]) document.addEventListener(activityEvent, noteSensitiveActivity, { passive:true });
document.addEventListener("visibilitychange", () => {
  if (document.hidden && sessionSecurity.lockWhenHidden && vaultState === "unlocked") {
    lockVault(); toast("Vault locked when the app was hidden");
  }
});
async function activateWallet(address) {
  wallet=wallets.find((candidate)=>candidate.address===address)??wallet;
  await saveWallets();
  loadRecentTransfers(); loadTransferTemplates(); loadWalletHistory(); loadPaymentPlans(); loadPaymentRequests(); loadTransactionGuard();
  showWallet();
  $("#send-form").reset();
  $("#batch-input").value=""; batchDraft=[];
  renderRecentTransfers(); renderTransferTemplates(); renderWalletHistory(); renderWalletDiagnostics(); renderPaymentPlans(); renderPaymentRequests(); renderTransactionGuardSettings();
  portfolioUpdatedAt = 0;
  await refresh();
}

$("#wallet-picker").addEventListener("change",async(event)=>{
  await activateWallet(event.target.value); toast(`Switched to ${wallet.name}`);
});
$("#open-wallet-manager").addEventListener("click",()=>{$("#wallet-name").value="";renderWallets();$("#wallet-overlay").hidden=false;$("#wallet-name").focus();});
$("#close-wallet-manager").addEventListener("click",closeWalletManager);
$("#wallet-form").addEventListener("submit",async(event)=>{
  event.preventDefault(); const button=event.currentTarget.querySelector("button"); const name=$("#wallet-name").value.trim();
  if (!name) return toast("Wallet name cannot be blank",true);
  if (vaultState === "locked") return toast("Unlock the vault before creating another wallet", true);
  setBusy(button,true);
  try { wallet=await createWallet(name); wallets.push(wallet); portfolioUpdatedAt=0; await saveWallets(); renderWallets(); loadRecentTransfers(); loadTransferTemplates(); loadWalletHistory(); loadPaymentPlans(); loadPaymentRequests(); loadTransactionGuard(); showWallet(); renderRecentTransfers(); renderTransferTemplates(); renderWalletHistory(); renderWalletDiagnostics(); renderPaymentPlans(); renderPaymentRequests(); renderTransactionGuardSettings(); closeWalletManager(); await refresh(); toast(`${name} created locally`); }
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
      lastSensitiveActivity = Date.now();
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
    portfolioUpdatedAt = 0;
    vaultPassword = password;
    vaultState = "unlocked";
    lastSensitiveActivity = Date.now();
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
$("#export-activity-csv").addEventListener("click", () => {
  try {
    exportWalletActivity("csv");
    toast("Activity statement exported as CSV");
  } catch (error) {
    toast(error.message, true);
  }
});
$("#export-activity-json").addEventListener("click", () => {
  try {
    exportWalletActivity("json");
    toast("Activity statement exported as JSON");
  } catch (error) {
    toast(error.message, true);
  }
});
$("#refresh-portfolio").addEventListener("click", async (event) => {
  const button = event.currentTarget; setBusy(button, true);
  try { portfolioUpdatedAt = 0; await refreshPortfolio(marketData, currentStatus, true); toast("Portfolio refreshed"); }
  catch (error) { toast(error.message, true); }
  finally { setBusy(button, false); }
});
$("#portfolio-list").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-portfolio-wallet]");
  if (!button || button.disabled) return;
  try {
    await activateWallet(button.dataset.portfolioWallet);
    document.querySelector('[data-view="wallet"]').click();
    toast(`Opened ${wallet.name}`);
  } catch (error) { toast(error.message, true); }
});
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
$("#request-list").addEventListener("click", async (event) => {
  const fillButton = event.target.closest("[data-request-fill]");
  const copyButton = event.target.closest("[data-request-copy]");
  const shareButton = event.target.closest("[data-request-share]");
  const toggleButton = event.target.closest("[data-request-toggle]");
  const archiveButton = event.target.closest("[data-request-archive]");
  const request = paymentRequests.find((item) => item.id === (fillButton?.dataset.requestFill || copyButton?.dataset.requestCopy || shareButton?.dataset.requestShare || toggleButton?.dataset.requestToggle || archiveButton?.dataset.requestArchive));
  if (!request) return;
  if (fillButton) {
    fillPaymentRequest(request);
    return;
  }
  if (copyButton) {
    await navigator.clipboard.writeText(copyButton.dataset.requestCopy);
    toast("Payment request copied");
    return;
  }
  if (shareButton) {
    const uri = shareButton.dataset.requestShare;
    const text = `Send E-Coin to ${request.label}: ${uri}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: "E-Coin payment request", text, url: uri });
        toast("Share sheet opened");
        return;
      } catch {
        // Fall through to copy the request.
      }
    }
    await navigator.clipboard.writeText(uri);
    toast("Share not available, request copied");
    return;
  }
  if (toggleButton) {
    const state = requestState(request);
    if (state === "fulfilled") {
      request.fulfilledAt = null;
      request.archivedAt = null;
      toast("Request reopened");
    } else {
      request.fulfilledAt = Date.now();
      request.archivedAt = null;
      toast("Request marked paid");
    }
    savePaymentRequests();
    renderPaymentRequests();
    return;
  }
  if (archiveButton) {
    const state = requestState(request);
    if (state === "archived") {
      request.archivedAt = null;
      toast("Request restored");
    } else {
      request.archivedAt = Date.now();
      toast("Request archived");
    }
    savePaymentRequests();
    renderPaymentRequests();
  }
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
  const dailyRoom = guardPolicy.dailyLimit ? Math.max(0, guardPolicy.dailyLimit - spentToday() - activeFee) : Number.MAX_SAFE_INTEGER;
  const policyRoom = Math.max(0, currentAccount.availableBalance - activeFee - guardPolicy.reserve);
  const spendable = Math.min(smartReserveAmount(), dailyRoom, policyRoom);
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
$("#fee-tier").addEventListener("change", () => { applyFeeTier(); updateComposer(); renderBatchComposer(); });
$("#save-guard").addEventListener("click", () => {
  const dailyLimit = Math.round(Number($("#guard-daily-limit").value) * SCALE);
  const reserve = Math.round(Number($("#guard-reserve").value) * SCALE);
  if (!Number.isSafeInteger(dailyLimit) || dailyLimit < 0 || !Number.isSafeInteger(reserve) || reserve < 0) return toast("Enter valid guard amounts", true);
  guardPolicy = { dailyLimit, reserve, knownOnly:$("#guard-known-only").checked };
  saveTransactionGuard();
  renderTransactionGuardSettings();
  updateComposer();
  toast("Transaction Guard policy saved");
});
$("#batch-input").addEventListener("input", renderBatchComposer);
$("#batch-example").addEventListener("click", () => {
  if (contacts.length < 2) return toast("Save at least two contacts to build an example batch", true);
  $("#batch-input").value = contacts.slice(0, Math.min(6, contacts.length)).map((contact, index) => `${contact.name}, ${(index + 1).toFixed(6)}, Batch payment ${index + 1}`).join("\n");
  renderBatchComposer();
  toast("Batch populated from saved contacts");
});
$("#submit-batch").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const analysis = analyzeBatchPayments();
  if (analysis.blocked) return toast(analysis.errors[0] || analysis.policyReasons[0] || "Batch is not ready", true);
  setBusy(button, true);
  try {
    const timestamp = Date.now();
    const transactions = await Promise.all(analysis.entries.map(async (entry, index) => {
      const tx = { from:wallet.address, to:entry.to, amount:entry.amount, fee:activeFee, nonce:currentAccount.nextNonce + index, memo:entry.memo, timestamp:timestamp + index, publicKey:wallet.publicKey };
      tx.signature = await signTransaction(tx);
      return tx;
    }));
    const result = await api("/transactions/batch", { method:"POST", body:JSON.stringify({ transactions }) });
    recordRecentTransfers(transactions);
    $("#batch-input").value = "";
    batchDraft = [];
    await refresh();
    renderBatchComposer();
    toast(`${result.queued} signed transfers queued atomically`);
  } catch (error) {
    await refresh().catch(() => {});
    toast(`${error.message} — no partial batch was accepted`, true);
  } finally { setBusy(button, false); }
});
$("#pending-list").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-speed-up]");
  if (!button) return;
  const pending = currentPending.find((tx) => tx.id === button.dataset.speedUp && tx.from === wallet.address && tx.type === "transfer");
  if (!pending) return toast("That transfer is no longer pending", true);
  setBusy(button, true);
  try {
    if (vaultState === "locked") throw new Error("Unlock the vault before replacing a fee");
    const fee = Math.max(Math.ceil(pending.fee * 1.1), feeQuote.priority);
    if (fee - pending.fee > currentAccount.availableBalance) throw new Error("Available balance cannot cover the higher fee");
    const replacement = { from:pending.from, to:pending.to, amount:pending.amount, fee, nonce:pending.nonce, memo:pending.memo ?? "", timestamp:Date.now(), publicKey:wallet.publicKey };
    replacement.signature = await signTransaction(replacement);
    const result = await api("/transactions", { method:"POST", body:JSON.stringify(replacement) });
    await refresh();
    toast(`Fee raised to ${format(fee)} EC · queue position ${result.position}`);
  } catch (error) {
    await refresh().catch(() => {});
    toast(error.message, true);
  } finally { setBusy(button, false); }
});
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
  paymentRequests,
  contacts,
  transactionGuard: guardPolicy,
  spendJournal,
  };
}
function restoreRecoveryBundle(bundle) {
  const source = bundle?.wallet ?? bundle;
  if (!source || !source.privateKey || !source.publicKey || !source.address) throw new Error("This file does not contain a valid E-Coin wallet");
  return source;
}
async function importRecoveryData(imported) {
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
    if (Array.isArray(imported.paymentRequests)) paymentRequests=imported.paymentRequests.slice(0,24);
    if (Array.isArray(imported.walletHistory)) walletHistory=imported.walletHistory.slice(0,60);
    if (imported.transactionGuard && typeof imported.transactionGuard === "object") {
      guardPolicy = {
        dailyLimit:Number.isSafeInteger(imported.transactionGuard.dailyLimit) && imported.transactionGuard.dailyLimit >= 0 ? imported.transactionGuard.dailyLimit : 0,
        reserve:Number.isSafeInteger(imported.transactionGuard.reserve) && imported.transactionGuard.reserve >= 0 ? imported.transactionGuard.reserve : 5 * SCALE,
        knownOnly:Boolean(imported.transactionGuard.knownOnly),
      };
    }
    if (Array.isArray(imported.spendJournal)) spendJournal=imported.spendJournal.filter((entry)=>entry && Number.isSafeInteger(entry.amount) && Number.isFinite(entry.timestamp)).slice(0,200);
    await saveWallets(); localStorage.setItem(contactsKey,JSON.stringify(contacts)); saveRecentTransfers(); saveTransferTemplates(); savePaymentPlans(); savePaymentRequests(); saveWalletHistory(); saveTransactionGuard(); saveSpendJournal();
    portfolioUpdatedAt=0; renderContacts(); renderRecentTransfers(); renderTransferTemplates(); renderPaymentPlans(); renderPaymentRequests(); renderWalletHistory(); renderWalletDiagnostics(); renderTransactionGuardSettings(); showWallet(); await refresh(); toast("Wallet imported");
}

function openRecoveryDialog(mode) {
  $("#recovery-form").reset();
  $("#recovery-overlay").dataset.mode = mode;
  $("#recovery-confirm-row").hidden = mode !== "export";
  $("#recovery-eyebrow").textContent = mode === "export" ? "PROTECT THE BACKUP" : "UNLOCK THE BACKUP";
  $("#recovery-title").textContent = mode === "export" ? "Create an encrypted recovery bundle." : "Decrypt and verify this recovery bundle.";
  $("#recovery-submit").textContent = mode === "export" ? "ENCRYPT & DOWNLOAD" : "DECRYPT & IMPORT";
  $("#recovery-scope").textContent = mode === "export" ? "ACTIVE WALLET + LOCAL DATA" : "AUTHENTICATED BUNDLE";
  $("#recovery-copy").textContent = mode === "export"
    ? "This password is never stored. Without it, the recovery file cannot be opened."
    : "AES-GCM verifies the file before any signing key or local data is imported.";
  $("#recovery-overlay").hidden = false;
  $("#recovery-password").focus();
}

function closeRecoveryDialog() {
  $("#recovery-overlay").hidden = true;
  $("#recovery-form").reset();
  pendingRecoveryEnvelope = null;
}

$("#backup").addEventListener("click", () => {
  if (vaultState === "locked") return toast("Unlock the vault before creating a backup", true);
  pendingRecoveryEnvelope = null;
  openRecoveryDialog("export");
});
$("#close-recovery").addEventListener("click", closeRecoveryDialog);
$("#recovery-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("#recovery-submit"); setBusy(button, true);
  try {
    const password = $("#recovery-password").value;
    const mode = $("#recovery-overlay").dataset.mode;
    if (mode === "export") {
      if (password.length < 10) throw new Error("Backup password must contain at least 10 characters");
      if (password !== $("#recovery-confirm").value) throw new Error("Backup passwords do not match");
      const envelope = await encryptRecoveryBundle(buildRecoveryBundle(), password);
      const blob = new Blob([JSON.stringify(envelope, null, 2)], { type:"application/json" });
      const link = Object.assign(document.createElement("a"), { href:URL.createObjectURL(blob), download:`ecoin-recovery-${wallet.address.slice(0, 10)}.json` });
      link.click(); URL.revokeObjectURL(link.href); recoveryAudit[wallet.address] = Date.now(); localStorage.setItem(recoveryAuditKey, JSON.stringify(recoveryAudit)); closeRecoveryDialog(); renderSessionSecurity(); toast("Encrypted recovery bundle created");
      return;
    }
    if (!pendingRecoveryEnvelope) throw new Error("Encrypted recovery data is missing");
    const imported = await decryptRecoveryBundle(pendingRecoveryEnvelope, password);
    await importRecoveryData(imported);
    closeRecoveryDialog();
  } catch (error) { toast(error.message, true); }
  finally { setBusy(button, false); }
});
$("#import-key").addEventListener("change", async (event) => {
  try {
    if (vaultState === "locked") throw new Error("Unlock the vault before importing a wallet");
    const imported = JSON.parse(await event.target.files[0].text());
    if (imported?.kind === "ecoin-encrypted-recovery") {
      pendingRecoveryEnvelope = imported;
      openRecoveryDialog("import");
    } else {
      await importRecoveryData(imported);
    }
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
    const guard = evaluateTransactionGuard(pendingDraft, recipientProfile);
    renderTransactionGuard(recipientProfile);
    if (guard.blocked) {
      pendingDraft = null;
      throw new Error("Transaction Guard blocked this draft under your saved policy");
    }
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
$("#contract-flow-filter").addEventListener("change", (event) => {
  contractFlowFilter = event.target.value;
  renderContractIntelligence();
});
$("#contract-timeline").addEventListener("click", (event) => {
  const button = event.target.closest("[data-contract-flow-claim]");
  if (!button) return;
  $("#claim-form").reset();
  $("#claim-address").value = button.dataset.contractFlowClaim;
  $("#claim-overlay").hidden = false;
  $("#claim-secret").focus();
});
$("#export-contract-schedule").addEventListener("click", () => {
  const rows = contractTimelineRows();
  if (!rows.length) return toast("No active contract schedule to export", true);
  const csvCell = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const lines = [
    ["due_at", "direction", "amount_ec", "event", "contract_type", "contract_address", "creator", "beneficiary", "memo"],
    ...rows.map((row) => [new Date(row.dueAt).toISOString(), row.direction, (row.amount / SCALE).toFixed(6), row.kind, row.contract.contractType, row.contract.address, row.contract.creator, row.contract.beneficiary, row.contract.memo || ""]),
  ];
  const blob = new Blob([lines.map((line) => line.map(csvCell).join(",")).join("\n")], { type:"text/csv;charset=utf-8" });
  const link = Object.assign(document.createElement("a"), { href:URL.createObjectURL(blob), download:`ecoin-contract-schedule-${wallet.address.slice(0, 10)}.csv` });
  link.click(); URL.revokeObjectURL(link.href); toast("Contract schedule exported");
});
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
  if (!$("#recovery-overlay").hidden) closeRecoveryDialog();
  if (!$("#contract-overlay").hidden) closeContract();
  if (!$("#buy-overlay").hidden) $("#buy-overlay").hidden=true;
  if (!$("#claim-overlay").hidden) closeClaim();
});
$("#confirm-send").addEventListener("click", async (event) => {
  if (!pendingDraft) return;
  const button = event.currentTarget; setBusy(button,true);
  try {
    const guard = evaluateTransactionGuard(pendingDraft);
    if (guard.blocked) throw new Error("Transaction Guard policy changed or its daily limit was reached");
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
  renderTransactionGuard();
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
  const guard = evaluateTransactionGuard(tx, profile);
  const signals = guard.signals.map((signal) => [signal.tone, signal.text]);
  signals.unshift([guard.blocked ? "warning" : "", `Transaction Guard score: ${guard.risk}/100${guard.blocked ? " · policy blocked" : ""}.`]);
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
  renderTransactionGuard();
  renderBatchComposer();
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

function showWallet() { $("#address").textContent = wallet.address; $("#address").title = wallet.address; renderWallets(); renderRecentTransfers(); renderTransferTemplates(); renderPaymentPlans(); renderPaymentRequests(); renderReceivePanel(); renderSessionSecurity(); }
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

try { contacts=(JSON.parse(localStorage.getItem(contactsKey)) || []).filter((contact)=>contact && typeof contact.name==="string" && /^ec1[0-9a-f]{38}$/.test(contact.address)); loadWatchlist(); loadWatchlistSnapshot(); loadMarketAlerts(); loadSessionSecurity(); renderContacts(); await loadWallets(); loadRecentTransfers(); loadTransferTemplates(); loadWalletHistory(); loadPaymentPlans(); loadPaymentRequests(); loadTransactionGuard(); await ensureTreasuryWallet(); showWallet(); $("#send-form").reset(); renderWatchlist(currentAccount); renderRecentTransfers(); renderTransferTemplates(); renderWalletHistory(); renderWalletDiagnostics(); renderPaymentPlans(); renderPaymentRequests(); renderTransactionGuardSettings(); renderSessionSecurity(); await refresh(); const initialView=["#learn","#data"].includes(location.hash)?location.hash.slice(1):"wallet"; document.querySelector(`[data-view="${initialView}"]`).click(); connectEventStream(); setInterval(updateBlockClock,250); setInterval(checkSessionSecurity,1_000); setInterval(() => refresh().catch(()=>{}), 15_000); }
catch (error) { $("#address").textContent = "Wallet unavailable"; toast(error.message, true); }
