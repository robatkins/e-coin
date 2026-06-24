import { decryptRecoveryBundle, decryptWalletVault, encryptRecoveryBundle, encryptWalletVault, stripWalletSecretsFromCollection } from "./vault.js";
import { planRebalance } from "./rebalance.js";
import { simulateContractDraft } from "./contract-simulator.js";
import { createSignedTransferEnvelope, createUnsignedTransferEnvelope, validateSignedTransferEnvelope, validateUnsignedTransferEnvelope } from "./offline-transfer.js";
import { verifySettlementReceipt } from "./receipt-verifier.js";

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
const activityRulesKey = "ecoin.activityRules.v1";
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
const securityJournalKey = "ecoin.securityJournal.v1";
const stressScenarioKey = "ecoin.stressScenario.v1";
const rebalanceConfigKey = "ecoin.rebalanceConfig.v1";
const learnProgressKey = "ecoin.learnProgress.v1";
const dataSignalKey = "ecoin.dataSignals.v1";
const stressScenarioTemplatesKey = "ecoin.stressScenarioTemplates.v1";
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
let walletActivitySignals = [];
let walletCounterpartyInsights = [];
let walletActivityRulesByWallet = {};
let walletActivityRules = { largeTransferEc: 10, burstCount: 4, burstWindowHours: 24, watchNewCounterparties: true, watchTopCounterparties: true };
let walletActivityFilter = "all";
let walletActivityQuery = "";
let walletActivityFrom = "";
let walletActivityTo = "";
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
let portfolioActivityByAddress = {};
let portfolioActivityUpdatedAt = 0;
let batchDraft = [];
let currentContracts = [];
let contractFlowFilter = "all";
let pendingRecoveryEnvelope = null;
let sessionSecurity = { timeoutMinutes:15, lockWhenHidden:true };
let lastSensitiveActivity = Date.now();
let recoveryAudit = {};
let securityJournalByWallet = {};
let securityJournal = [];
let stressScenariosByWallet = {};
let stressScenario = { horizonDays:30, priceShockPct:-35, extraSpendEc:0, includeHistory:true };
let stressRecommendedReserve = 0;
let rebalanceConfig = { strategy:"equal", floorEc:25, bufferEc:5, minimumEc:.01, includeTreasury:false };
let rebalancePlan = [];
let dataSignalByWallet = {};
let dataSignalFeed = [];
let dataSignalSeen = {};
let dataSignalConfig = { sensitivity:"balanced", forecastHorizon:12, feedLimit:8 };
let stressScenarioTemplatesByWallet = {};
let stressScenarioTemplates = [];
let learnProgressByWallet = {};
let learnProgress = { visits: 0, bestQuiz: 0, topicCounts: {}, lastTopic: "overview" };
let contractSimulationVersion = 0;
let offlineSigningStage = "idle";
let receiptVerificationReport = "";

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

async function createWallet(name="Wallet", options = {}) {
  if (!crypto.subtle) throw new Error("Secure browser cryptography is unavailable");
  const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const [publicKey, privateKey] = await Promise.all([
    crypto.subtle.exportKey("jwk", keys.publicKey),
    crypto.subtle.exportKey("jwk", keys.privateKey),
  ]);
  const address=await addressFromKey(publicKey);
  const parentAddress = options.parentAddress ?? null;
  const rootAddress = options.rootAddress ?? parentAddress ?? address;
  const kind = options.kind === "subwallet" || parentAddress ? "subwallet" : "wallet";
  return {
    version:1,
    id:address,
    name,
    kind,
    parentAddress,
    rootAddress,
    publicKey,
    privateKey,
    address,
    createdAt:new Date().toISOString(),
  };
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
    wallets = Array.isArray(vaultEnvelope.index) ? vaultEnvelope.index.filter(isWalletMeta).map((candidate) => ({
      kind: candidate.kind === "subwallet" ? "subwallet" : "wallet",
      parentAddress: candidate.parentAddress ?? null,
      rootAddress: candidate.rootAddress ?? candidate.parentAddress ?? candidate.address,
      ...candidate,
    })) : [];
    vaultState = "locked";
    selectActiveWallet();
    if (!wallets.length) throw new Error("Encrypted wallet vault is empty");
    return;
  }
  wallets=(JSON.parse(localStorage.getItem(walletsKey))||[]).filter((candidate)=>candidate?.privateKey&&candidate?.publicKey&&/^ec1[0-9a-f]{38}$/.test(candidate.address)).map((candidate)=>({
    kind: candidate.kind === "subwallet" ? "subwallet" : "wallet",
    parentAddress: candidate.parentAddress ?? null,
    rootAddress: candidate.rootAddress ?? candidate.parentAddress ?? candidate.address,
    ...candidate,
  }));
  if (!wallets.length) {
    const legacy=JSON.parse(localStorage.getItem(walletKey));
    wallets=[legacy?{...legacy,id:legacy.address,name:legacy.name||"Primary",kind:"wallet",parentAddress:null,rootAddress:legacy.address}:await createWallet("Primary")];
    localStorage.removeItem(walletKey);
  }
  vaultEnvelope = null;
  vaultPassword = null;
  vaultState = "none";
  selectActiveWallet();
  loadSecurityJournal();
  await saveWallets();
}

function walletDisplayKind(candidate) {
  return candidate.parentAddress ? "SUBWALLET" : "WALLET";
}

function walletParentName(candidate) {
  if (!candidate.parentAddress) return null;
  return wallets.find((entry) => entry.address === candidate.parentAddress)?.name || short(candidate.parentAddress, 10);
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

function canonicalContractApproval(tx) {
  return JSON.stringify({contractAddress:tx.contractAddress,from:tx.from,milestone:tx.milestone,fee:tx.fee,nonce:tx.nonce,timestamp:tx.timestamp,publicKey:tx.publicKey});
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

async function signContractApproval(tx) {
  if (!wallet?.privateKey) throw new Error("Unlock the wallet vault to approve milestone contracts");
  const key=await crypto.subtle.importKey("jwk",wallet.privateKey,{name:"Ed25519"},false,["sign"]);
  const signature=await crypto.subtle.sign("Ed25519",key,new TextEncoder().encode(canonicalContractApproval(tx)));
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

async function approveMilestoneContract(contractAddress, milestone) {
  if (vaultState === "locked") throw new Error("Unlock the vault before approving milestone contracts");
  const contract = currentContracts.find((item) => item.address === contractAddress) || (await api(`/contracts/${contractAddress}`));
  const tx = {
    contractAddress,
    from: wallet.address,
    milestone: Number(milestone),
    fee: activeFee,
    nonce: currentAccount.nextNonce,
    timestamp: Date.now(),
    publicKey: wallet.publicKey,
  };
  tx.signature = await signContractApproval(tx);
  const result = await api(`/contracts/${contractAddress}/approve`, { method:"POST", body:JSON.stringify(tx) });
  await refresh();
  recordSecurityEvent("milestone_approved", "Milestone approved", `Milestone ${tx.milestone} on ${short(contractAddress, 10)} was approved by ${wallet.name}.`, "good");
  toast(`${contract.contractType === "milestone" ? "Milestone" : "Contract"} approval queued`);
  return result;
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
  renderFeeIntelligence();
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

function renderFeeIntelligence() {
  if (!$("#fee-tier-cards")) return;
  const blockMs = Math.max(1_000, Number(feeQuote.averageBlockTimeMs) || 6_000);
  const capacity = Math.max(1, Number(feeQuote.capacity) || currentStatus?.metrics?.blockCapacity || 250);
  const fallbackTier = (fee) => {
    const queueAhead = currentPending.filter((tx) => Number(tx.fee || 0) >= fee).length;
    const estimatedBlocks = Math.max(1, Math.ceil((queueAhead + 1) / capacity));
    return { fee, queueAhead, estimatedBlocks, estimatedMs:estimatedBlocks * blockMs, expiryRisk:false };
  };
  const tiers = feeQuote.tiers || { economy:fallbackTier(feeQuote.economy), standard:fallbackTier(feeQuote.standard), priority:fallbackTier(feeQuote.priority) };
  const recommended = recommendedFeeTier(Number(feeQuote.pressure) || 0);
  const pressure = Math.max(0, Math.min(1, Number(feeQuote.pressure) || 0));
  const outgoing = currentPending.filter((tx) => tx.from === wallet.address && tx.type === "transfer");
  const urgent = outgoing.filter((tx) => PENDING_TTL_MS - (Date.now() - (tx.queuedAt ?? tx.timestamp)) < 2 * 60_000).length;
  const underpriced = outgoing.filter((tx) => tx.fee < feeQuote.standard).length;
  const walletRisk = urgent ? "EXPIRY RISK" : underpriced ? "FEE LAG" : outgoing.length ? "ON TRACK" : "CLEAR";
  $("#fee-pressure").textContent = `${Math.round(pressure * 100)}%`;
  $("#fee-pressure-note").textContent = `${currentPending.length} queued · ${capacity} tx capacity`;
  $("#fee-median").textContent = `${format(feeQuote.percentiles?.p50 ?? feeQuote.standard)} EC`;
  $("#fee-trend").textContent = `${String(feeQuote.trend || "stable").toUpperCase()} fee trend`;
  $("#fee-cadence").textContent = formatDuration(blockMs);
  $("#fee-confidence").textContent = `${String(feeQuote.confidence || "low").toUpperCase()} confidence · ${feeQuote.sampleSize ?? 0} samples`;
  $("#fee-wallet-risk").textContent = walletRisk;
  $("#fee-wallet-note").textContent = outgoing.length ? `${outgoing.length} pending · ${underpriced} below standard · ${urgent} near expiry` : "No pending transfers";
  $("#fee-tier-cards").innerHTML = ["economy", "standard", "priority"].map((name) => {
    const tier = tiers[name] || fallbackTier(feeQuote[name]);
    return `<article class="fee-tier-card ${name === recommended ? "recommended" : ""} ${tier.expiryRisk ? "warning" : ""}">
      <div><span>${escapeHtml(name.toUpperCase())}</span>${name === recommended ? "<small>RECOMMENDED</small>" : ""}</div>
      <b>${escapeHtml(format(tier.fee))} EC</b>
      <p>~ ${escapeHtml(String(tier.estimatedBlocks))} block${tier.estimatedBlocks === 1 ? "" : "s"} · ${escapeHtml(formatDuration(tier.estimatedMs))}</p>
      <small>${escapeHtml(String(tier.queueAhead))} queued at this fee or higher${tier.expiryRisk ? " · expiry risk" : ""}</small>
    </article>`;
  }).join("");
  const values = [feeQuote.percentiles?.p25 ?? feeQuote.economy, feeQuote.percentiles?.p50 ?? feeQuote.standard, feeQuote.percentiles?.p75 ?? feeQuote.priority, feeQuote.economy, feeQuote.standard, feeQuote.priority].map((value) => Math.max(0, Number(value) || 0));
  const max = Math.max(1, ...values);
  const labels = ["P25", "P50", "P75", "ECO", "STD", "PRI"];
  $("#fee-distribution-chart .bars").innerHTML = values.map((value, index) => {
    const height = 86 * value / max;
    const x = 52 + index * 112;
    return `<rect x="${x}" y="${108-height}" width="72" height="${height}" rx="2" class="${index >= 3 ? "tier" : "percentile"}"></rect><text x="${x+36}" y="128" text-anchor="middle">${labels[index]}</text><text x="${x+36}" y="${Math.max(12,101-height)}" text-anchor="middle">${(value/SCALE).toFixed(3)}</text>`;
  }).join("");
  $("#fee-sample-size").textContent = `${feeQuote.sampleSize ?? 0} recent fee samples`;
  $("#fee-intelligence-guidance").textContent = urgent ? `${urgent} pending transfer${urgent === 1 ? " is" : "s are"} approaching expiry. Use Pending Control to replace the fee before the envelope is pruned.` : underpriced ? `${underpriced} pending transfer${underpriced === 1 ? " is" : "s are"} below the current standard quote. A fee replacement may improve inclusion.` : pressure > .75 ? "Queue pressure is elevated. Priority pricing reduces queue-ahead exposure, while batching reduces repeated signing overhead." : `The ${recommended} tier currently balances settlement time and cost. Predictions use recent blocks plus the live mempool.`;
  $("#fee-apply-recommended").textContent = `APPLY ${recommended.toUpperCase()}`;
}

function renderContracts(contracts) {
  currentContracts = contracts;
  $("#contract-count").textContent=contracts.length;
  const locked=contracts.filter((contract)=>contract.creator===wallet.address&&["locked","vesting","milestone"].includes(contract.status)).reduce((sum,contract)=>sum+contract.amount-(contract.releasedAmount??0),0);
  $("#contract-locked").textContent=`${format(locked)} EC`;
  $("#contract-list").innerHTML=contracts.length ? contracts.map((contract)=>{
    const currentRound = contract.approvalRound ?? (contract.releasedInstallments ?? 0) + 1;
    const creatorApproved = (contract.creatorApprovedRound ?? 0) >= currentRound;
    const beneficiaryApproved = (contract.beneficiaryApprovedRound ?? 0) >= currentRound;
    const approvalLabel = contract.contractType === "milestone" && contract.status === "locked"
      ? `${creatorApproved ? "CREATOR" : "AWAITING CREATOR"} / ${beneficiaryApproved ? "BENEFICIARY" : "AWAITING BENEFICIARY"}`
      : "";
    const action = contract.contractType==="hashlock"&&contract.status==="locked"
      ? `<button class="contract-claim" type="button" data-claim="${contract.address}">CLAIM</button>`
      : contract.contractType==="milestone"&&contract.status==="locked"&&(contract.creator===wallet.address||contract.beneficiary===wallet.address)
        ? `<button class="contract-claim" type="button" data-approve="${contract.address}" data-milestone="${currentRound}">${contract.creator===wallet.address&&!creatorApproved ? "APPROVE AS CREATOR" : contract.beneficiary===wallet.address&&!beneficiaryApproved ? "APPROVE AS BENEFICIARY" : "APPROVED"}</button>`
        : `<time>${contract.status==="released"?"RELEASED":contract.status==="refunded"?"REFUNDED":contract.contractType==="vesting"||contract.contractType==="milestone"?`${contract.releasedInstallments}/${contract.installments} PAID`:new Date(contract.unlockTime).toLocaleDateString()}</time>`;
    return `<div class="contract-row"><span class="contract-status ${contract.status}">${contract.contractType.toUpperCase()} / ${contract.status.toUpperCase()}</span><span>${escapeHtml(format(contract.amount-(contract.releasedAmount??0)))} EC remaining → ${escapeHtml(short(contract.beneficiary,10))}${approvalLabel ? ` · ${escapeHtml(approvalLabel)}` : ""}</span><code title="${contract.address}">${escapeHtml(short(contract.address,12))}</code>${action}</div>`;
  }).join("") : '<p class="empty">No contracts for this wallet yet.</p>';
  renderContractIntelligence(contracts);
}

function contractTimelineRows(contracts = currentContracts) {
  const rows = [];
  for (const contract of contracts) {
    if (!["locked", "vesting", "milestone"].includes(contract.status)) continue;
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
      const milestoneRound = index + 1;
      const creatorApproved = (contract.creatorApprovedRound ?? 0) >= milestoneRound;
      const beneficiaryApproved = (contract.beneficiaryApprovedRound ?? 0) >= milestoneRound;
      rows.push({
        contract,
        dueAt:contract.unlockTime + index * (contract.intervalMs ?? 0),
        amount:index === installments - 1 ? contract.amount - baseAmount * (installments - 1) : baseAmount,
        direction:contract.beneficiary === wallet.address ? "incoming" : "outgoing",
        kind:contract.contractType === "vesting" ? `INSTALLMENT ${index + 1}/${installments}` : contract.contractType === "milestone" ? `MILESTONE ${index + 1}/${installments}` : "TIMELOCK RELEASE",
        detail:contract.contractType === "milestone" ? `${creatorApproved ? "creator approved" : "awaiting creator"} · ${beneficiaryApproved ? "beneficiary approved" : "awaiting beneficiary"}` : contract.memo || `${contract.contractType} contract ${short(contract.address, 9)}`,
        installment:index + 1,
        creatorApproved,
        beneficiaryApproved,
      });
    }
  }
  return rows.sort((a, b) => a.dueAt - b.dueAt || a.contract.address.localeCompare(b.contract.address));
}

function renderContractIntelligence(contracts = currentContracts) {
  if (!$("#contract-timeline")) return;
  const active = contracts.filter((contract) => ["locked", "vesting", "milestone"].includes(contract.status));
  const outbound = active.filter((contract) => contract.creator === wallet.address).reduce((sum, contract) => sum + contract.amount - (contract.releasedAmount ?? 0), 0);
  const inbound = active.filter((contract) => contract.beneficiary === wallet.address).reduce((sum, contract) => sum + contract.amount - (contract.releasedAmount ?? 0), 0);
  const allRows = contractTimelineRows(contracts);
  const now = Date.now();
  const soonThreshold = now + 7 * 24 * 60 * 60_000;
  const urgent = allRows.filter((row) => row.dueAt <= now + 60 * 60_000).length;
  const hashlocks = active.filter((contract) => contract.contractType === "hashlock").length;
  const milestones = active.filter((contract) => contract.contractType === "milestone").length;
  const capitalBase = Math.max(1, outbound + (currentAccount.availableBalance ?? 0));
  const concentration = outbound / capitalBase;
  const longHorizon = allRows.some((row) => row.dueAt > now + 180 * 24 * 60 * 60_000);
  const approvalLag = allRows.filter((row) => row.contract.contractType === "milestone" && row.contract.status === "locked" && (!(row.creatorApproved) || !(row.beneficiaryApproved))).length;
  const risk = Math.min(100, urgent * 20 + hashlocks * 8 + milestones * 5 + approvalLag * 6 + (concentration > .75 ? 20 : concentration > .4 ? 10 : 0) + (longHorizon ? 10 : 0));
  $("#contract-outbound").textContent = `${format(outbound)} EC`;
  $("#contract-inbound").textContent = `${format(inbound)} EC`;
  $("#contract-next-flow").textContent = allRows.length ? (allRows[0].dueAt <= now ? "READY NOW" : formatDuration(allRows[0].dueAt - now)) : "—";
  $("#contract-risk").textContent = `${risk} / 100`;
  $("#contract-intel-guidance").textContent = !active.length
    ? "No active programmable payments. New contracts will appear here with a deterministic release forecast."
    : urgent
      ? `${urgent} cash-flow event${urgent === 1 ? " is" : "s are"} due within one hour. Verify hashlock secrets, milestone approvals, and beneficiary addresses now.`
      : concentration > .75
        ? "Most deployable value is committed to contracts. Keep enough liquid EC available for fees and unexpected operating needs."
        : `${active.length} active contract${active.length === 1 ? "" : "s"} produce ${allRows.length} forecast cash-flow event${allRows.length === 1 ? "" : "s"}. ${milestones ? `${milestones} milestone contract${milestones === 1 ? "" : "s"} need joint approval before release.` : "No immediate deadline pressure is detected."}`;
  const filtered = allRows.filter((row) => contractFlowFilter === "all" || row.direction === contractFlowFilter || (contractFlowFilter === "soon" && row.dueAt <= soonThreshold)).slice(0, 40);
  $("#contract-timeline").innerHTML = filtered.length ? filtered.map((row) => {
    const due = row.dueAt <= now;
    const counterparty = row.contract.contractType === "hashlock" && row.kind === "REFUND FALLBACK" ? row.contract.beneficiary : row.direction === "incoming" ? row.contract.creator : row.contract.beneficiary;
    const contact = contacts.find((entry) => entry.address === counterparty);
    const canClaim = row.contract.contractType === "hashlock" && row.contract.status === "locked" && row.contract.beneficiary === wallet.address;
    const canApprove = row.contract.contractType === "milestone" && row.contract.status === "locked" && (
      (row.contract.creator === wallet.address && !row.creatorApproved) ||
      (row.contract.beneficiary === wallet.address && !row.beneficiaryApproved)
    );
    return `<article class="contract-flow ${row.direction} ${due ? "due" : ""}">
      <time>${due ? "READY NOW" : escapeHtml(formatDuration(row.dueAt - now))}<br>${escapeHtml(new Date(row.dueAt).toLocaleDateString())}</time>
      <div><b>${escapeHtml(row.kind)} · ${escapeHtml(contact?.name || short(counterparty, 9))}</b><p>${escapeHtml(row.detail)} · ${escapeHtml(short(row.contract.address, 10))}</p></div>
      <strong>${row.direction === "incoming" ? "+" : "−"}${escapeHtml(format(row.amount))} EC</strong>
      ${canClaim ? `<button type="button" data-contract-flow-claim="${escapeHtml(row.contract.address)}">CLAIM</button>` : canApprove ? `<button type="button" data-contract-flow-approve="${escapeHtml(row.contract.address)}" data-contract-flow-milestone="${escapeHtml(String(row.installment))}">APPROVE</button>` : ""}
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
  renderOrderAssistant(market);
  const priceValues=(market.history.length?market.history:[{priceMicroUsd:market.priceMicroUsd}]).map((entry)=>entry.priceMicroUsd/1_000_000);
  const points=chartPoints(priceValues,720,260,24); $("#price-chart polyline").setAttribute("points",points.line); $("#price-chart .area").setAttribute("d",`${points.path} L 696 236 L 24 236 Z`);
  $("#price-min").textContent=usd(Math.min(...priceValues),6); $("#price-max").textContent=usd(Math.max(...priceValues),6);
  const change=priceValues.at(-1)-priceValues[0]; $("#price-change").textContent=`${change>=0?"+":""}${usd(change,6)} SINCE FIRST TRADE`;
  const blockValues=[...blocks].reverse().map((block)=>block.transactions.length); const max=Math.max(1,...blockValues);
  $("#load-chart .bars").innerHTML=blockValues.map((value,index)=>{const width=620/Math.max(1,blockValues.length); const height=value/max*200; return `<rect x="${40+index*width}" y="${230-height}" width="${Math.max(3,width-5)}" height="${height}" rx="2"></rect>`;}).join("");
  for (const svg of [$("#price-chart"),$("#load-chart")]) svg.querySelector(".chart-gridlines").innerHTML=[55,115,175,235].map((y)=>`<line x1="24" y1="${y}" x2="696" y2="${y}"></line>`).join("");
  $("#market-history").innerHTML=market.history.length?market.history.slice().reverse().map((entry)=>`<div class="market-row"><span>${usd(entry.priceMicroUsd/1_000_000,6)}</span><b>${escapeHtml(format(entry.amount))} EC / ${usd(entry.usdCents/100,2)}</b><code>${entry.kind === "order_trade" ? "ORDER TRADE" : `BLOCK #${entry.blockHeight}`}</code><time>${relativeTime(entry.timestamp)}</time></div>`).join(""):'<p class="empty">No market purchases yet.</p>';
  renderDataIntelligence(market, status, blocks, priceValues);
  renderStressLab();
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
      const activity = candidate.address === wallet.address ? walletActivity : await api(`/accounts/${candidate.address}/activity?limit=40`);
      return { wallet:candidate, account, activity:Array.isArray(activity?.activity) ? activity.activity : [], available:true };
    } catch (error) {
      return { wallet:candidate, account:{ balance:0, availableBalance:0, marketPosition:0, marketLocked:0, pendingOutgoing:0, pendingIncoming:0, insights:{ transactionCount:0 } }, activity:[], available:false, error:error.message };
    }
  }));
  portfolioEntries = results;
  portfolioUpdatedAt = Date.now();
  portfolioActivityByAddress = Object.fromEntries(results.map((entry) => [entry.wallet.address, entry.activity || []]));
  portfolioActivityUpdatedAt = Date.now();
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
  const availableRatio = total ? available / total : 0;
  const liquidWeight = total ? enriched.filter((entry) => entry.availableBalance > 0).reduce((sum, entry) => sum + entry.availableBalance, 0) / total : 0;
  const concentrated = largestShare > .75 || treasuryShare > .9;
  const riskBand = concentrated ? "CONCENTRATED" : availableRatio < .25 ? "TIGHT" : treasuryShare > .65 ? "TREASURY-HEAVY" : "BALANCED";
  const liquidityBand = availableRatio < .2 ? "LOW LIQUIDITY" : availableRatio < .45 ? "MODERATE" : "HEALTHY";
  const nextMove = concentrated
    ? "Consider isolating operating funds into a separate wallet or subwallet."
    : availableRatio < .25
      ? "Top up the most active branch before taking on new transfers."
      : treasuryShare > .65
        ? "Distribute a little more into operating wallets if you expect regular activity."
        : "The current mix looks usable; keep monitoring reserve levels.";
  $("#portfolio-outlook-note").textContent = concentrated
    ? "Allocation is concentrated enough to deserve a structural review."
    : availableRatio < .25
      ? "The portfolio is liquid enough for only cautious new activity."
      : "The portfolio mix is reasonably balanced right now.";
  $("#portfolio-risk-band").textContent = riskBand;
  $("#portfolio-risk-band-note").textContent = concentrated
    ? `Largest wallet controls ${(largestShare * 100).toFixed(1)}% of holdings.`
    : treasuryShare > .65
      ? `Treasury share is ${(treasuryShare * 100).toFixed(1)}%, so the portfolio is still treasury-led.`
      : "No single branch dominates the local set.";
  $("#portfolio-liquidity-band").textContent = liquidityBand;
  $("#portfolio-liquidity-note").textContent = `${(availableRatio * 100).toFixed(1)}% of holdings are immediately available, with ${(liquidWeight * 100).toFixed(1)}% of total holdings in explicitly liquid balances.`;
  $("#portfolio-next-move").textContent = concentrated ? "SEPARATE FUNDS" : availableRatio < .25 ? "TOP UP BRANCH" : treasuryShare > .65 ? "DISTRIBUTE MORE" : "MONITOR";
  $("#portfolio-next-move-note").textContent = nextMove;
  $(".portfolio-outlook")?.classList.toggle("warning", concentrated || availableRatio < .25);
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
  renderRebalancePlanner();
  renderSubwalletIntelligence(market, status, enriched);
}

function renderSubwalletIntelligence(market, status, enrichedPortfolio = []) {
  const entries = enrichedPortfolio.length ? enrichedPortfolio : portfolioEntries.map((entry) => ({
    ...entry,
    holdings: Math.max(0, Number(entry.account?.balance || 0) + Number(entry.account?.marketPosition || 0)),
    availableBalance: Math.max(0, Number(entry.account?.availableBalance || 0)),
  }));
  const roots = wallets.filter((candidate) => !candidate.parentAddress);
  const children = wallets.filter((candidate) => candidate.parentAddress);
  const groups = new Map();
  for (const root of roots) {
    groups.set(root.address, { root, children: [] });
  }
  for (const child of children) {
    const parentKey = child.parentAddress || child.rootAddress;
    if (!groups.has(parentKey)) groups.set(parentKey, { root: wallets.find((candidate) => candidate.address === parentKey) || child, children: [] });
    groups.get(parentKey).children.push(child);
  }
  const groupStats = [...groups.values()].map((group) => {
    const rollupAddresses = new Set([group.root.address, ...collectDescendantAddresses(group.root.address, wallets)]);
    const rollupHoldings = entries.filter((entry) => rollupAddresses.has(entry.wallet.address)).reduce((sum, entry) => sum + entry.holdings, 0);
    const rollupAvailable = entries.filter((entry) => rollupAddresses.has(entry.wallet.address)).reduce((sum, entry) => sum + entry.availableBalance, 0);
    return { ...group, rollupAddresses, rollupHoldings, rollupAvailable };
  }).sort((a, b) => b.rollupHoldings - a.rollupHoldings);
  const totalHoldings = groupStats.reduce((sum, group) => sum + group.rollupHoldings, 0);
  const largestGroup = groupStats[0];
  const rootCount = roots.length;
  const childCount = children.length;
  const diversity = totalHoldings ? 1 / groupStats.reduce((sum, group) => sum + (group.rollupHoldings / totalHoldings) ** 2, 0) : 0;
  const concentration = totalHoldings && largestGroup ? largestGroup.rollupHoldings / totalHoldings : 0;
  const health = !wallets.length ? "EMPTY" : childCount === 0 ? "FLAT" : concentration > 0.8 ? "CONCENTRATED" : concentration > 0.55 ? "BALANCED" : "DISTRIBUTED";
  const branchForecasts = groupStats.map((group) => {
    const seen = group.root.address === wallet?.address ? currentAccount?.insights : portfolioEntries.find((entry) => entry.wallet.address === group.root.address)?.account?.insights;
    const firstSeen = Number(seen?.firstSeen || 0);
    const lastActive = Number(seen?.lastActive || 0);
    const observationDays = firstSeen && lastActive ? Math.max(1, (lastActive - firstSeen) / (24 * 60 * 60_000)) : 7;
    const sent = Number(seen?.sent || 0);
    const spendPerDay = sent > 0 ? sent / observationDays : 0;
    const runwayDays = spendPerDay > 0 ? group.rollupAvailable / spendPerDay : Infinity;
    return { ...group, spendPerDay, runwayDays, observationDays };
  }).sort((a, b) => a.runwayDays - b.runwayDays || b.rollupHoldings - a.rollupHoldings);
  $("#subwallet-roots").textContent = String(rootCount);
  $("#subwallet-roots-note").textContent = rootCount ? `${groupStats.length} hierarchy group${groupStats.length === 1 ? "" : "s"} detected.` : "Create a root wallet to begin.";
  $("#subwallet-children").textContent = String(childCount);
  $("#subwallet-children-note").textContent = childCount ? `${childCount} child wallet${childCount === 1 ? "" : "s"} visible in the tree.` : "No subwallets yet.";
  $("#subwallet-share").textContent = totalHoldings ? `${(concentration * 100).toFixed(1)}%` : "—";
  $("#subwallet-share-note").textContent = totalHoldings && largestGroup ? `${largestGroup.root.name} controls the largest rollup.` : "Rollups will appear once wallets are funded.";
  $("#subwallet-health").textContent = health;
  $("#subwallet-health-note").textContent = !wallets.length ? "Add or import wallets to unlock hierarchy intelligence." : health === "CONCENTRATED" ? "Funds are tightly clustered in one branch." : health === "BALANCED" ? "Value is split across several branches." : "Multiple branches are carrying value.";
  $("#subwallet-summary").textContent = totalHoldings
    ? `${groupStats.length} branch${groupStats.length === 1 ? "" : "es"} hold ${format(totalHoldings)} EC in aggregate. The largest branch carries ${(concentration * 100).toFixed(1)}% of hierarchical holdings, and the hierarchy averages ${diversity.toFixed(2)} effective branches.`
    : "Subwallet analytics will summarize how value is distributed across roots and descendants.";
  const activeChildren = wallets.filter((candidate) => candidate.parentAddress === wallet?.address);
  $("#subwallet-next-action").textContent = activeChildren.length
    ? `${activeChildren.length} immediate child wallet${activeChildren.length === 1 ? "" : "s"} available. Use the tree to load a transfer to one of them in a single click.`
    : "Create a subwallet under the active wallet to start a managed branch.";
  const shortestRunway = branchForecasts[0];
  $("#subwallet-chart-summary").textContent = shortestRunway
    ? shortestRunway.runwayDays === Infinity
      ? `${shortestRunway.root.name} has no measurable spend pattern yet, so its runway is effectively open-ended for now.`
      : `${shortestRunway.root.name} has the shortest estimated runway at ${shortestRunway.runwayDays.toFixed(1)} days.`
    : "Projected operating runway by wallet branch.";
  renderSubwalletRunwayChart(branchForecasts);
  renderSubwalletAllocator(entries);
  renderSubwalletTrends(branchForecasts, entries);
}

function renderSubwalletRunwayChart(branchForecasts) {
  const svg = $("#subwallet-chart");
  if (!svg) return;
  const values = branchForecasts.slice(0, 8).map((branch) => Number.isFinite(branch.runwayDays) ? Math.max(0.5, branch.runwayDays) : 24);
  if (!values.length) {
    svg.querySelector(".chart-gridlines").innerHTML = "";
    svg.querySelector("polyline").setAttribute("points", "");
    svg.querySelector(".area").setAttribute("d", "");
    return;
  }
  const max = Math.max(...values, 1);
  const min = Math.min(...values, max);
  const points = chartPoints(values, 760, 220, 28);
  svg.querySelector(".chart-gridlines").innerHTML = [48, 92, 136, 180].map((y) => `<line x1="28" y1="${y}" x2="732" y2="${y}"></line>`).join("");
  svg.querySelector("polyline").setAttribute("points", points.line);
  svg.querySelector(".area").setAttribute("d", `${points.path} L 732 192 L 28 192 Z`);
  const labels = branchForecasts.slice(0, 8).map((branch, index) => `${short(branch.root.name, 12)} · ${Number.isFinite(branch.runwayDays) ? branch.runwayDays.toFixed(1) + "d" : "∞"}`);
  svg.setAttribute("aria-label", `Branch runway: ${labels.join(", ")}`);
}

function estimateSubwalletReserve(entry) {
  const txCount = Math.max(1, Number(entry.account?.insights?.transactionCount || 0));
  const sent = Number(entry.account?.insights?.sent || 0);
  const outgoingAverage = sent > 0 ? sent / txCount : 0;
  const activityFloor = outgoingAverage > 0 ? Math.max(3 * SCALE, Math.round(outgoingAverage * 2.5)) : 5 * SCALE;
  return Math.max(3 * SCALE, Math.min(50 * SCALE, activityFloor));
}

function renderSubwalletAllocator(entries = []) {
  const list = $("#subwallet-allocator-list");
  const summary = $("#subwallet-allocator-summary");
  if (!list || !summary) return;
  const enriched = entries.length ? entries : portfolioEntries.map((entry) => ({
    ...entry,
    holdings: Math.max(0, Number(entry.account?.balance || 0) + Number(entry.account?.marketPosition || 0)),
    availableBalance: Math.max(0, Number(entry.account?.availableBalance || 0)),
  }));
  const rows = [];
  for (const child of wallets.filter((candidate) => candidate.parentAddress)) {
    const parent = wallets.find((candidate) => candidate.address === child.parentAddress) || wallets.find((candidate) => candidate.address === child.rootAddress);
    if (!parent) continue;
    const parentEntry = enriched.find((entry) => entry.wallet.address === parent.address);
    const childEntry = enriched.find((entry) => entry.wallet.address === child.address);
    if (!parentEntry || !childEntry) continue;
    const targetReserve = estimateSubwalletReserve(childEntry);
    const currentAvailable = Number(childEntry.availableBalance || 0);
    const deficit = Math.max(0, targetReserve - currentAvailable);
    const parentAvailable = Number(parentEntry.availableBalance || 0);
    if (deficit < SCALE || parentAvailable <= deficit + activeFee) continue;
    const urgency = Math.min(100, Math.round((deficit / targetReserve) * 100));
    rows.push({
      child,
      parent,
      amount: deficit,
      targetReserve,
      urgency,
      note: currentAvailable === 0
        ? "No available balance. This branch should be replenished before it is used again."
        : `Available balance is ${(currentAvailable / SCALE).toFixed(2)} EC against a ${ (targetReserve / SCALE).toFixed(2)} EC reserve target.`,
    });
  }
  rows.sort((a, b) => b.urgency - a.urgency);
  summary.textContent = rows.length
    ? `${rows.length} child wallet${rows.length === 1 ? "" : "s"} are below their suggested reserve target.`
    : "No branch top-ups are currently recommended.";
  list.innerHTML = rows.length ? rows.map((plan) => `
    <article class="subwallet-plan ${plan.urgency >= 80 ? "urgent" : plan.urgency >= 50 ? "warning" : ""}">
      <div>
        <b>${escapeHtml(plan.parent.name)} → ${escapeHtml(plan.child.name)}</b>
        <p>${escapeHtml((plan.amount / SCALE).toFixed(6))} EC suggested top-up · reserve target ${(plan.targetReserve / SCALE).toFixed(2)} EC</p>
        <small>${escapeHtml(plan.note)} · urgency ${plan.urgency}/100</small>
      </div>
      <button type="button" data-subwallet-topup-parent="${escapeHtml(plan.parent.address)}" data-subwallet-topup-child="${escapeHtml(plan.child.address)}" data-subwallet-topup-amount="${escapeHtml(String(plan.amount / SCALE))}">PREPARE</button>
    </article>
  `).join("") : '<div class="subwallet-plan empty">Every child wallet is already at or above its reserve target.</div>';
}

function summarizeBranchTrend(branch, entriesByAddress = new Map()) {
  const windowMs = 7 * 24 * 60 * 60_000;
  const addressSet = branch.rollupAddresses instanceof Set ? branch.rollupAddresses : new Set(branch.rollupAddresses || []);
  const seenTx = new Set();
  const activity = [];
  for (const address of addressSet) {
    for (const tx of portfolioActivityByAddress[address] || []) {
      const key = tx?.id || `${tx?.from || ""}:${tx?.to || ""}:${tx?.amount || 0}:${tx?.settledAt || tx?.timestamp || 0}`;
      if (seenTx.has(key)) continue;
      seenTx.add(key);
      activity.push(tx);
    }
  }
  let recentOutflow = 0;
  let previousOutflow = 0;
  let recentInflow = 0;
  let previousInflow = 0;
  let recentCount = 0;
  let previousCount = 0;
  for (const tx of activity) {
    const settledAt = Number(tx.settledAt || tx.timestamp || 0);
    if (!settledAt) continue;
    const age = Date.now() - settledAt;
    const amount = Math.max(0, Number(tx.amount || 0));
    const fromInside = addressSet.has(tx.from);
    const toInside = addressSet.has(tx.to);
    const externalOutflow = fromInside && !toInside;
    const externalInflow = !fromInside && toInside;
    if (!externalOutflow && !externalInflow) continue;
    if (age <= windowMs) {
      recentCount++;
      if (externalOutflow) recentOutflow += amount;
      if (externalInflow) recentInflow += amount;
    } else if (age <= 2 * windowMs) {
      previousCount++;
      if (externalOutflow) previousOutflow += amount;
      if (externalInflow) previousInflow += amount;
    }
  }
  const recentBurnRate = recentOutflow / 7;
  const previousBurnRate = previousOutflow / 7;
  const runwayDays = recentBurnRate > 0 ? branch.rollupAvailable / recentBurnRate : Infinity;
  const burnAcceleration = previousBurnRate > 0 ? recentBurnRate / previousBurnRate : recentBurnRate > 0 ? Infinity : 1;
  const outflowDelta = recentOutflow - previousOutflow;
  const trend = recentBurnRate === 0 && previousBurnRate === 0
    ? "idle"
    : burnAcceleration > 1.25 || outflowDelta > SCALE
      ? "rising"
      : burnAcceleration < 0.8
        ? "cooling"
        : "stable";
  const directChildren = branch.children
    .map((child) => entriesByAddress.get(child.address))
    .filter(Boolean)
    .map((entry) => {
      const targetReserve = estimateSubwalletReserve(entry);
      const deficit = Math.max(0, targetReserve - Number(entry.availableBalance || 0));
      return { entry, targetReserve, deficit };
    })
    .filter((candidate) => candidate.deficit >= SCALE)
    .sort((a, b) => b.deficit - a.deficit || a.entry.wallet.name.localeCompare(b.entry.wallet.name));
  let action = null;
  if (directChildren.length) {
    const candidate = directChildren[0];
    action = {
      parentAddress: branch.root.address,
      childAddress: candidate.entry.wallet.address,
      amountEc: candidate.deficit / SCALE,
      label: `Top up ${candidate.entry.wallet.name}`,
    };
  } else if (branch.root.parentAddress) {
    const rootEntry = entriesByAddress.get(branch.root.address);
    if (rootEntry) {
      const targetReserve = estimateSubwalletReserve(rootEntry);
      const deficit = Math.max(0, targetReserve - Number(rootEntry.availableBalance || 0));
      if (deficit >= SCALE) {
        action = {
          parentAddress: branch.root.parentAddress,
          childAddress: branch.root.address,
          amountEc: deficit / SCALE,
          label: `Top up ${branch.root.name}`,
        };
      }
    }
  }
  const urgency = !Number.isFinite(runwayDays)
    ? 5
    : runwayDays < 3
      ? 100
      : runwayDays < 7
        ? 82
        : runwayDays < 14
          ? 64
          : 35;
  return {
    ...branch,
    recentOutflow,
    previousOutflow,
    recentInflow,
    previousInflow,
    recentCount,
    previousCount,
    recentBurnRate,
    previousBurnRate,
    runwayDays,
    burnAcceleration,
    trend,
    outflowDelta,
    action,
    urgency,
  };
}

function renderSubwalletTrends(branchForecasts = [], entries = []) {
  const list = $("#subwallet-trend-list");
  const summary = $("#subwallet-trend-summary");
  if (!list || !summary) return;
  const entriesByAddress = new Map(entries.map((entry) => [entry.wallet.address, entry]));
  const rows = branchForecasts
    .map((branch) => summarizeBranchTrend(branch, entriesByAddress))
    .sort((a, b) => b.urgency - a.urgency || a.root.name.localeCompare(b.root.name));
  const actionable = rows.filter((branch) => branch.action);
  const warningCount = rows.filter((branch) => branch.trend === "rising" || (Number.isFinite(branch.runwayDays) && branch.runwayDays < 7)).length;
  summary.textContent = rows.length
    ? `${warningCount} branch${warningCount === 1 ? "" : "es"} need attention. ${actionable.length} top-up${actionable.length === 1 ? "" : "s"} can be prepared directly from the trend view.`
    : "Branch outflow trend over the last 14 days.";
  list.innerHTML = rows.length ? rows.slice(0, 6).map((branch) => {
    const trendLabel = branch.trend === "rising"
      ? "RISING SPEND"
      : branch.trend === "cooling"
        ? "COOLING"
        : branch.trend === "idle"
          ? "IDLE"
          : "STABLE";
    const tone = branch.trend === "rising" || (Number.isFinite(branch.runwayDays) && branch.runwayDays < 7) ? "warning" : "good";
    const runwayText = branch.runwayDays === Infinity ? "open runway" : `${branch.runwayDays.toFixed(1)} day runway`;
    const activityText = `${format(branch.recentOutflow)} EC outflow · ${format(branch.previousOutflow)} EC prior window · ${branch.recentCount} / ${branch.previousCount} tx`;
    const actionButton = branch.action
      ? `<button type="button" data-subwallet-topup-parent="${escapeHtml(branch.action.parentAddress)}" data-subwallet-topup-child="${escapeHtml(branch.action.childAddress)}" data-subwallet-topup-amount="${escapeHtml(String(branch.action.amountEc))}">${escapeHtml(branch.action.label)}</button>`
      : `<button type="button" data-wallet-open="${escapeHtml(branch.root.address)}">OPEN BRANCH</button>`;
    return `<article class="subwallet-trend ${tone}">
      <div>
        <b>${escapeHtml(branch.root.name)}</b>
        <p>${escapeHtml(trendLabel)} · ${escapeHtml(runwayText)} · ${escapeHtml(activityText)}</p>
        <small>${escapeHtml(branch.children.length)} child wallet${branch.children.length === 1 ? "" : "s"} · burn acceleration ${Number.isFinite(branch.burnAcceleration) ? branch.burnAcceleration.toFixed(2) + "x" : "∞"}</small>
      </div>
      ${actionButton}
    </article>`;
  }).join("") : '<div class="subwallet-trend empty">No branch activity has been recorded yet.</div>';
}

function collectDescendantAddresses(rootAddress, allWallets) {
  const directChildren = allWallets.filter((walletEntry) => walletEntry.parentAddress === rootAddress);
  const descendants = [];
  for (const child of directChildren) {
    descendants.push(child.address, ...collectDescendantAddresses(child.address, allWallets));
  }
  return descendants;
}

function buildRebalancePlan() {
  const treasuryAddress = currentStatus?.treasuryAddress;
  const fee = Math.max(1_000, Number(feeQuote.standard) || activeFee);
  const minimum = Math.max(1, Math.round(rebalanceConfig.minimumEc * SCALE));
  const floor = Math.max(0, Math.round(rebalanceConfig.floorEc * SCALE));
  const buffer = Math.max(0, Math.round(rebalanceConfig.bufferEc * SCALE));
  const walletsToModel = portfolioEntries.filter((entry) => entry.available && (rebalanceConfig.includeTreasury || entry.wallet.address !== treasuryAddress)).map((entry) => ({
    address:entry.wallet.address,
    name:entry.wallet.name,
    balance:Math.max(0, Number(entry.account.availableBalance || 0)),
  }));
  return planRebalance({ wallets:walletsToModel, strategy:rebalanceConfig.strategy, floor, buffer, minimum, fee });
}

function renderRebalancePlanner() {
  if (!$("#rebalance-list")) return;
  $("#rebalance-strategy").value = rebalanceConfig.strategy;
  $("#rebalance-floor").value = String(rebalanceConfig.floorEc);
  $("#rebalance-buffer").value = String(rebalanceConfig.bufferEc);
  $("#rebalance-minimum").value = String(rebalanceConfig.minimumEc);
  $("#rebalance-treasury").checked = rebalanceConfig.includeTreasury;
  const result = buildRebalancePlan();
  rebalancePlan = result.moves;
  const insufficient = result.wallets.length < 2;
  const status = insufficient ? "NEED 2 WALLETS" : result.moves.length ? "READY" : result.belowFloor ? "UNDERFUNDED" : "BALANCED";
  const bestMove = result.moves[0] || null;
  const feeEfficiency = result.fees > 0 ? result.volume / result.fees : Infinity;
  const concentrationDelta = result.total ? ((result.beforeLargest - result.afterLargest) * 100) : 0;
  const posture = insufficient ? "INCOMPLETE" : result.moves.length ? (result.belowFloor ? "UNDERFUNDED" : concentrationDelta > 0 ? "IMPROVING" : "STABLE") : result.belowFloor ? "UNDERFUNDED" : "BALANCED";
  $("#rebalance-count").textContent = String(result.moves.length);
  $("#rebalance-fees").textContent = `${format(result.fees)} EC estimated fees`;
  $("#rebalance-volume").textContent = `${format(result.volume)} EC`;
  $("#rebalance-wallet-count").textContent = `${result.wallets.length} wallet${result.wallets.length === 1 ? "" : "s"} modeled`;
  $("#rebalance-before").textContent = result.total ? `${(result.beforeLargest * 100).toFixed(1)}%` : "—";
  $("#rebalance-after").textContent = result.total ? `${(result.afterLargest * 100).toFixed(1)}% after plan` : "—";
  $("#rebalance-status").textContent = status;
  $("#rebalance-outlook-note").textContent = insufficient
    ? "At least two wallets are required before the planner can build a useful reallocation."
    : result.moves.length
      ? `${result.moves.length} move${result.moves.length === 1 ? "" : "s"} would improve allocation if you approve them manually.`
      : result.belowFloor
        ? "The planner sees a reserve shortfall, but the current wallet set cannot fund it safely."
        : "The allocation is already in a reasonable range.";
  $("#rebalance-posture").textContent = posture;
  $("#rebalance-posture-note").textContent = insufficient
    ? "Not enough eligible wallets."
    : result.belowFloor
      ? "One or more wallets remain below the reserve floor."
      : concentrationDelta > 0
        ? `Largest-share concentration improves by ${concentrationDelta.toFixed(1)} points after the plan.`
        : "The plan keeps allocation stable while minimizing churn.";
  $("#rebalance-efficiency").textContent = Number.isFinite(feeEfficiency) ? `${feeEfficiency.toFixed(1)}x` : "∞";
  $("#rebalance-efficiency-note").textContent = result.fees > 0
    ? `Each fee EC is moving about ${feeEfficiency.toFixed(1)} EC of reallocated value.`
    : "No fee load is required for this configuration.";
  $("#rebalance-next-move").textContent = bestMove ? `${short(bestMove.fromName, 10)} → ${short(bestMove.toName, 10)}` : "REVIEW";
  $("#rebalance-next-move-note").textContent = bestMove
    ? `Next draft: ${format(bestMove.amount)} EC from ${short(bestMove.from, 9)} to ${short(bestMove.to, 9)}.`
    : insufficient
      ? "Add another eligible wallet to unlock the planner."
      : "No transfer is needed until the balances move again.";
  $("#rebalance-guidance").textContent = insufficient
    ? `At least two eligible wallets are needed. The genesis treasury is ${rebalanceConfig.includeTreasury ? "included" : "excluded by default for safety"}.`
    : result.moves.length
      ? `${result.moves.length} transfer${result.moves.length === 1 ? "" : "s"} moves ${format(result.volume)} EC with ${format(result.fees)} EC in estimated fees. Recommendations are drafts and still pass through Transaction Guard.`
      : result.belowFloor
        ? `${result.belowFloor} wallet${result.belowFloor === 1 ? " remains" : "s remain"} below the reserve floor, but eligible sources cannot fund them without violating the source buffer.`
        : rebalanceConfig.strategy === "equal" ? "Eligible wallets are already within the configured minimum-move tolerance." : "Every eligible wallet meets the configured reserve floor.";
  $("#rebalance-list").innerHTML = result.moves.length ? result.moves.map((move, index) => `<article class="rebalance-move">
    <span>${index + 1}</span>
    <div><b>${escapeHtml(move.fromName)} → ${escapeHtml(move.toName)}</b><p>${escapeHtml(short(move.from, 9))} → ${escapeHtml(short(move.to, 9))} · fee ${escapeHtml(format(move.fee))} EC</p></div>
    <strong>${escapeHtml(format(move.amount))} EC</strong>
    <button type="button" data-rebalance-load="${index}">LOAD</button>
  </article>`).join("") : '<p class="empty">No rebalancing moves proposed.</p>';
  $("#rebalance-copy").disabled = !result.moves.length;
  $("#rebalance-load-next").disabled = !result.moves.length;
  $(".rebalance-panel").classList.toggle("warning", status === "UNDERFUNDED");
  $(".rebalance-outlook")?.classList.toggle("warning", posture === "UNDERFUNDED");
}

async function loadRebalanceMove(move) {
  if (!move) return;
  await activateWallet(move.from);
  $("#recipient").value = move.to;
  $("#amount").value = (move.amount / SCALE).toFixed(6);
  $("#memo").value = `Portfolio rebalance to ${move.toName}`.slice(0, 96);
  updateComposer();
  document.querySelector('[data-view="wallet"]').click();
  $("#send-form").scrollIntoView({ behavior:"smooth", block:"start" });
  toast(`Loaded ${format(move.amount)} EC from ${move.fromName} to ${move.toName}`);
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
  const lockedContracts = contracts.filter((contract) => contract.creator === wallet.address && ["locked", "vesting", "milestone", "hashlock"].includes(contract.status)).length;
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

function analyzeMarketRegime(market, status, priceValues) {
  const momentum = summarizeMomentum(priceValues);
  const price = Number(market.priceUsd || 0);
  const spreadUsd = Number(market.spreadMicroUsd || 0) / 1_000_000;
  const spreadRatio = price > 0 ? spreadUsd / price : 0;
  const openOrders = Number(market.openOrders || 0);
  const pressure = Number(feeQuote.pressure || 0);
  if (!status?.chainValid) {
    return { label: "DEGRADED", note: "Chain validation is failing, so quotes should be treated as provisional until the ledger is healthy again.", tactic: "Pause trading", confidence: "Low confidence" };
  }
  if (spreadRatio > 0.03) {
    return { label: "WIDE SPREAD", note: "Liquidity is thin enough that passive limit orders usually beat urgency.", tactic: "Join the book", confidence: "Medium confidence" };
  }
  if (momentum.delta > 3 && openOrders > 8) {
    return { label: "UPTREND", note: "Momentum is positive and the book has enough depth to support staged entries.", tactic: "Buy in slices", confidence: "High confidence" };
  }
  if (momentum.delta < -3 && openOrders > 8) {
    return { label: "SOFTENING", note: "Price action is weaker, so tighter limits and patience help protect execution quality.", tactic: "Sell with limits", confidence: "High confidence" };
  }
  if (pressure > 0.75) {
    return { label: "FEE PRESSURE", note: "The network queue is busy, so conservative sizing and patience reduce execution surprises.", tactic: "Use smaller orders", confidence: "Medium confidence" };
  }
  if (openOrders > 12) {
    return { label: "ACTIVE BOOK", note: "Depth is healthy enough to improve fills by joining the best bid or ask.", tactic: "Match best prices", confidence: "High confidence" };
  }
  return { label: "BALANCED", note: "Price, depth, and queue pressure are all in a middle ground that favors clean limit orders.", tactic: "Use mid-market limits", confidence: "Medium confidence" };
}

function buildExecutionForecast(market, side, amountEc, limitPrice = null) {
  const price = Number(market?.priceUsd || 0);
  const book = side === "buy" ? (market?.orderBook?.asks || []) : (market?.orderBook?.bids || []);
  const amount = Math.max(0, Number(amountEc) || 0);
  if (!amount || !book.length || !price) {
    return {
      fillable: 0,
      avgPrice: price || 0,
      impactPct: 0,
      route: "NO LIQUIDITY",
      steps: [],
      fillPct: 0,
      partial: true,
    };
  }
  let remaining = amount;
  let notional = 0;
  let fillable = 0;
  const steps = [];
  for (const level of book) {
    const levelPrice = Number(level.limitPriceMicroUsd || level.priceMicroUsd || 0) / 1_000_000;
    const levelAmount = Math.max(0, Number(level.amount || 0));
    if (!levelPrice || !levelAmount) continue;
    if (limitPrice != null) {
      if (side === "buy" && levelPrice > limitPrice) break;
      if (side === "sell" && levelPrice < limitPrice) break;
    }
    const take = Math.min(remaining, levelAmount);
    if (take <= 0) continue;
    steps.push({ price: levelPrice, amount: take, orders: Number(level.orders || 0) });
    fillable += take;
    notional += take * levelPrice;
    remaining -= take;
    if (remaining <= 0) break;
  }
  const avgPrice = fillable > 0 ? notional / fillable : price;
  const impactPct = price > 0 ? Math.max(0, ((side === "buy" ? avgPrice - price : price - avgPrice) / price) * 100) : 0;
  const fillPct = amount > 0 ? (fillable / amount) * 100 : 0;
  const route = fillPct >= 99 ? "FULL FILL" : fillPct >= 50 ? "PARTIAL FILL" : "THIN BOOK";
  return {
    fillable,
    avgPrice,
    impactPct,
    route,
    steps,
    fillPct,
    partial: fillable < amount,
  };
}

function renderOrderAssistant(market) {
  const mode = $("#order-assistant-mode");
  if (!mode) return;
  const usd = (value) => value.toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 6, maximumFractionDigits: 6 });
  const side = $("#order-side")?.value === "sell" ? "sell" : "buy";
  const price = Number(market?.priceUsd || 0);
  const bestBid = Number(market?.bestBid?.limitPriceMicroUsd || 0) / 1_000_000 || price;
  const bestAsk = Number(market?.bestAsk?.limitPriceMicroUsd || 0) / 1_000_000 || price;
  const spread = Number(market?.spreadMicroUsd || 0) / 1_000_000;
  const spreadRatio = price > 0 ? spread / price : 0;
  const openOrders = Number(market?.openOrders || 0);
  const available = Math.max(0, Number(currentAccount?.availableBalance || 0));
  const aggressive = spreadRatio <= 0.01 || openOrders > 12;
  const recommendedPrice = side === "buy"
    ? (aggressive ? bestAsk || price : Math.min(bestAsk || price, bestBid + Math.max(spread * 0.35, price * 0.001)))
    : (aggressive ? bestBid || price : Math.max(bestBid || price, bestAsk - Math.max(spread * 0.35, price * 0.001)));
  const recommendedAmount = side === "sell"
    ? Math.max(0, Math.min(available, Math.max(SCALE, Math.round(available * 0.1))))
    : Math.max(SCALE, Math.min(5 * SCALE, Math.round(Math.max(SCALE, ((openOrders || 1) * SCALE) / 2))));
  const execution = buildExecutionForecast(market, side, recommendedAmount / SCALE, recommendedPrice || price);
  const tactic = side === "buy"
    ? aggressive ? "BUY AT ASK" : "POST NEAR BID"
    : aggressive ? "SELL AT BID" : "POST NEAR ASK";
  const fillConfidence = recommendedAmount > 0 ? (execution.fillPct >= 95 ? "HIGH" : execution.fillPct >= 60 ? "MEDIUM" : "LOW") : "NONE";
  const priceNote = side === "buy"
    ? aggressive ? "This should prioritize execution." : "This leaves room for a better entry if price moves down."
    : aggressive ? "This should improve fill speed." : "This preserves more price control on the exit.";
  const sizeNote = side === "sell"
    ? available > 0 ? `About 10% of ${format(available)} EC available, leaving reserve balance untouched.` : "No available balance to sell right now."
    : "A small staged entry keeps the order readable and easy to manage.";
  const routeNote = execution.partial
    ? `${execution.route.toLowerCase()} across ${execution.steps.length} price level${execution.steps.length === 1 ? "" : "s"}.`
    : `Projected full fill across ${execution.steps.length} level${execution.steps.length === 1 ? "" : "s"}.`;
  mode.textContent = `${side.toUpperCase()} · ${aggressive ? "AGGRESSIVE" : "CAUTIOUS"}`;
  $("#order-assistant-tactic").textContent = tactic;
  $("#order-assistant-tactic-note").textContent = aggressive ? "Priority on speed and match likelihood." : "Priority on price control and flexibility.";
  $("#order-assistant-price").textContent = recommendedPrice > 0 ? usd(recommendedPrice) : "—";
  $("#order-assistant-price-note").textContent = priceNote;
  $("#order-assistant-size").textContent = recommendedAmount > 0 ? `${format(recommendedAmount)} EC` : "—";
  $("#order-assistant-size-note").textContent = sizeNote;
  $("#order-assistant-fill").textContent = fillConfidence;
  $("#order-assistant-fill-note").textContent = `${execution.fillPct.toFixed(0)}% of the recommended size appears fillable from visible depth.`;
  $("#order-execution-note").textContent = `${side.toUpperCase()} ${execution.partial ? "likely needs a ladder" : "can likely clear the visible book"} · ${routeNote}`;
  $("#order-execution-fill").textContent = `${execution.fillPct.toFixed(0)}%`;
  $("#order-execution-fill-note").textContent = `${format(execution.fillable)} EC of ${format(recommendedAmount / SCALE)} EC visible in current depth.`;
  $("#order-execution-impact").textContent = execution.impactPct > 0 ? `${execution.impactPct.toFixed(2)}%` : "—";
  $("#order-execution-impact-note").textContent = execution.impactPct > 0 ? `Estimated avg fill at ${usd(execution.avgPrice, 6)}.` : "No measurable impact because the recommended size is not crossing visible levels.";
  $("#order-execution-route").textContent = execution.route;
  $("#order-execution-route-note").textContent = `${execution.steps.length} level${execution.steps.length === 1 ? "" : "s"} mapped from the visible book.`;
  $("#order-execution-ladder").innerHTML = execution.steps.length ? execution.steps.map((step, index) => `
    <article class="order-execution-step ${index === 0 ? "good" : ""}">
      <strong>#${index + 1}</strong>
      <div>
        <p>${escapeHtml(format(step.amount))} EC @ ${escapeHtml(usd(step.price, 6))}</p>
        <small>${escapeHtml(String(step.orders || 0))} order${step.orders === 1 ? "" : "s"} at this level</small>
      </div>
      <small>${escapeHtml(((step.amount / Math.max(recommendedAmount / SCALE, 1)) * 100).toFixed(0))}% of plan</small>
    </article>
  `).join("") : '<p class="empty">No visible depth to build a ladder.</p>';
  $("#order-assistant-apply").onclick = () => {
    $("#order-side").value = side;
    if (recommendedPrice > 0) $("#order-price").value = recommendedPrice.toFixed(6);
    if (recommendedAmount > 0) $("#order-amount").value = (recommendedAmount / SCALE).toFixed(6);
    toast("Order recommendation applied");
  };
  $("#order-assistant-mid").onclick = () => {
    if (price > 0) $("#order-price").value = price.toFixed(6);
    $("#order-side").value = side;
    toast("Mid price loaded");
  };
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

function loadSecurityJournal() {
  try {
    securityJournalByWallet = JSON.parse(localStorage.getItem(securityJournalKey) || "{}") || {};
  } catch {
    securityJournalByWallet = {};
  }
  securityJournal = Array.isArray(securityJournalByWallet[wallet?.address])
    ? securityJournalByWallet[wallet.address].filter((entry) => entry && typeof entry.type === "string" && typeof entry.title === "string" && Number.isFinite(Number(entry.timestamp))).slice(0, 24)
    : [];
}

function saveSecurityJournal() {
  if (!wallet?.address) return;
  securityJournalByWallet[wallet.address] = securityJournal.slice(0, 24);
  localStorage.setItem(securityJournalKey, JSON.stringify(securityJournalByWallet));
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

function loadStressScenario() {
  try {
    stressScenariosByWallet = JSON.parse(localStorage.getItem(stressScenarioKey) || "{}") || {};
  } catch {
    stressScenariosByWallet = {};
  }
  const stored = stressScenariosByWallet[wallet?.address] || {};
  stressScenario = {
    horizonDays: [7, 30, 90, 180].includes(Number(stored.horizonDays)) ? Number(stored.horizonDays) : 30,
    priceShockPct: Number.isFinite(Number(stored.priceShockPct)) ? Math.max(-95, Math.min(300, Number(stored.priceShockPct))) : -35,
    extraSpendEc: Math.max(0, Number(stored.extraSpendEc) || 0),
    includeHistory: stored.includeHistory !== false,
  };
}

function loadStressScenarioTemplates() {
  try {
    stressScenarioTemplatesByWallet = JSON.parse(localStorage.getItem(stressScenarioTemplatesKey) || "{}") || {};
  } catch {
    stressScenarioTemplatesByWallet = {};
  }
  stressScenarioTemplates = Array.isArray(stressScenarioTemplatesByWallet[wallet?.address])
    ? stressScenarioTemplatesByWallet[wallet.address]
        .filter((item) => item && typeof item.name === "string")
        .map((item) => ({
          id: typeof item.id === "string" ? item.id : crypto.randomUUID(),
          name: item.name,
          scenario: {
            horizonDays: [7, 30, 90, 180].includes(Number(item.scenario?.horizonDays)) ? Number(item.scenario.horizonDays) : 30,
            priceShockPct: Number.isFinite(Number(item.scenario?.priceShockPct)) ? Math.max(-95, Math.min(300, Number(item.scenario.priceShockPct))) : -35,
            extraSpendEc: Math.max(0, Number(item.scenario?.extraSpendEc) || 0),
            includeHistory: item.scenario?.includeHistory !== false,
          },
          createdAt: Number(item.createdAt) || Date.now(),
          uses: Number(item.uses) || 0,
        }))
        .sort((a, b) => b.createdAt - a.createdAt)
    : [];
}

function loadDataSignals() {
  try {
    dataSignalByWallet = JSON.parse(localStorage.getItem(dataSignalKey) || "{}") || {};
  } catch {
    dataSignalByWallet = {};
  }
  const stored = dataSignalByWallet[wallet?.address] || {};
  dataSignalConfig = {
    sensitivity: ["broad", "balanced", "tight"].includes(stored.sensitivity) ? stored.sensitivity : "balanced",
    forecastHorizon: [6, 12, 24].includes(Number(stored.forecastHorizon)) ? Number(stored.forecastHorizon) : 12,
    feedLimit: [5, 8, 12].includes(Number(stored.feedLimit)) ? Number(stored.feedLimit) : 8,
  };
  dataSignalFeed = Array.isArray(stored.feed) ? stored.feed.filter((item) => item && typeof item.label === "string").slice(0, dataSignalConfig.feedLimit) : [];
  dataSignalSeen = stored.seen && typeof stored.seen === "object" ? stored.seen : {};
}

function loadRebalanceConfig() {
  try {
    const stored = JSON.parse(localStorage.getItem(rebalanceConfigKey) || "{}") || {};
    const storedFloor = Number(stored.floorEc);
    const storedBuffer = Number(stored.bufferEc);
    const storedMinimum = Number(stored.minimumEc);
    rebalanceConfig = {
      strategy:["equal", "floor"].includes(stored.strategy) ? stored.strategy : "equal",
      floorEc:Number.isFinite(storedFloor) ? Math.max(0, storedFloor) : 25,
      bufferEc:Number.isFinite(storedBuffer) ? Math.max(0, storedBuffer) : 5,
      minimumEc:Number.isFinite(storedMinimum) ? Math.max(.000001, storedMinimum) : .01,
      includeTreasury:Boolean(stored.includeTreasury),
    };
  } catch {
    rebalanceConfig = { strategy:"equal", floorEc:25, bufferEc:5, minimumEc:.01, includeTreasury:false };
  }
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

function loadActivityRules() {
  try {
    walletActivityRulesByWallet = JSON.parse(localStorage.getItem(activityRulesKey) || "{}") || {};
  } catch {
    walletActivityRulesByWallet = {};
  }
  const stored = walletActivityRulesByWallet[wallet?.address] || {};
  walletActivityRules = {
    largeTransferEc: Number.isFinite(Number(stored.largeTransferEc)) && Number(stored.largeTransferEc) > 0 ? Number(stored.largeTransferEc) : 10,
    burstCount: Number.isFinite(Number(stored.burstCount)) && Number(stored.burstCount) >= 2 ? Math.round(Number(stored.burstCount)) : 4,
    burstWindowHours: Number.isFinite(Number(stored.burstWindowHours)) && Number(stored.burstWindowHours) > 0 ? Math.min(168, Number(stored.burstWindowHours)) : 24,
    watchNewCounterparties: stored.watchNewCounterparties !== false,
    watchTopCounterparties: stored.watchTopCounterparties !== false,
  };
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

function saveStressScenario() {
  if (!wallet?.address) return;
  stressScenariosByWallet[wallet.address] = { ...stressScenario };
  localStorage.setItem(stressScenarioKey, JSON.stringify(stressScenariosByWallet));
}

function saveStressScenarioTemplates() {
  if (!wallet?.address) return;
  stressScenarioTemplatesByWallet[wallet.address] = stressScenarioTemplates.slice(0, 12);
  localStorage.setItem(stressScenarioTemplatesKey, JSON.stringify(stressScenarioTemplatesByWallet));
}

function saveDataSignals() {
  if (!wallet?.address) return;
  dataSignalByWallet[wallet.address] = {
    ...dataSignalConfig,
    feed: dataSignalFeed.slice(0, dataSignalConfig.feedLimit),
    seen: dataSignalSeen,
  };
  localStorage.setItem(dataSignalKey, JSON.stringify(dataSignalByWallet));
}

function saveRebalanceConfig() {
  localStorage.setItem(rebalanceConfigKey, JSON.stringify(rebalanceConfig));
}

function savePaymentRequests() {
  if (!wallet?.address) return;
  paymentRequestsByWallet[wallet.address] = paymentRequests.slice(0, 24);
  localStorage.setItem(paymentRequestsKey, JSON.stringify(paymentRequestsByWallet));
}

function saveActivityRules() {
  if (!wallet?.address) return;
  walletActivityRulesByWallet[wallet.address] = {
    largeTransferEc: Number(walletActivityRules.largeTransferEc) || 10,
    burstCount: Math.round(Number(walletActivityRules.burstCount) || 4),
    burstWindowHours: Math.min(168, Math.max(1, Number(walletActivityRules.burstWindowHours) || 24)),
    watchNewCounterparties: Boolean(walletActivityRules.watchNewCounterparties),
    watchTopCounterparties: Boolean(walletActivityRules.watchTopCounterparties),
  };
  localStorage.setItem(activityRulesKey, JSON.stringify(walletActivityRulesByWallet));
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

function summarizeActivityTrend(entries = []) {
  const windowMs = 7 * 24 * 60 * 60_000;
  const now = Date.now();
  const recentStart = now - windowMs;
  const priorStart = now - (2 * windowMs);
  const bucket = (start, end) => entries.filter((tx) => tx.settledAt >= start && tx.settledAt < end);
  const recent = bucket(recentStart, now);
  const previous = bucket(priorStart, recentStart);
  const recentOutflow = recent.filter((tx) => tx.from === wallet.address).reduce((sum, tx) => sum + Number(tx.amount || 0), 0);
  const previousOutflow = previous.filter((tx) => tx.from === wallet.address).reduce((sum, tx) => sum + Number(tx.amount || 0), 0);
  const recentTx = recent.filter((tx) => tx.from === wallet.address).length;
  const previousTx = previous.filter((tx) => tx.from === wallet.address).length;
  const recentInflow = recent.filter((tx) => tx.to === wallet.address).reduce((sum, tx) => sum + Number(tx.amount || 0), 0);
  const previousInflow = previous.filter((tx) => tx.to === wallet.address).reduce((sum, tx) => sum + Number(tx.amount || 0), 0);
  const outflowDelta = previousOutflow > 0 ? (recentOutflow - previousOutflow) / previousOutflow : recentOutflow > 0 ? 1 : 0;
  const txDelta = previousTx > 0 ? (recentTx - previousTx) / previousTx : recentTx > 0 ? 1 : 0;
  const movementDelta = recent.length ? (recentInflow + recentOutflow) - (previousInflow + previousOutflow) : 0;
  const label = recentOutflow === 0 && recentInflow === 0 && previousOutflow === 0 && previousInflow === 0
    ? "IDLE"
    : outflowDelta > 0.25 || txDelta > 0.25 || movementDelta > SCALE * 5
      ? "ACCELERATING"
      : outflowDelta < -0.2 && txDelta < -0.2
        ? "COOLING"
        : "STABLE";
  const tone = label === "ACCELERATING" ? "warning" : label === "COOLING" ? "good" : "";
  const note = label === "IDLE"
    ? "No settled activity yet in the last two weekly windows."
    : label === "ACCELERATING"
      ? `Outgoing value is up ${(Math.max(0, outflowDelta) * 100).toFixed(0)}% versus the prior week, and transaction count is rising too.`
      : label === "COOLING"
        ? `Outgoing value is down ${Math.abs(outflowDelta * 100).toFixed(0)}% versus the prior week, so the wallet is settling into a quieter rhythm.`
        : `Activity is holding near the prior weekly pace.`;
  return {
    label,
    tone,
    note,
    recentOutflow,
    previousOutflow,
    recentTx,
    previousTx,
    outflowDelta,
    txDelta,
  };
}

function summarizeActivityForecast(entries = []) {
  const windowMs = 7 * 24 * 60 * 60_000;
  const now = Date.now();
  const recent = entries.filter((tx) => tx.settledAt >= now - windowMs);
  const previous = entries.filter((tx) => tx.settledAt >= now - (2 * windowMs) && tx.settledAt < now - windowMs);
  const recentOutflow = recent.filter((tx) => tx.from === wallet.address).reduce((sum, tx) => sum + Number(tx.amount || 0), 0);
  const previousOutflow = previous.filter((tx) => tx.from === wallet.address).reduce((sum, tx) => sum + Number(tx.amount || 0), 0);
  const recentFees = recent.filter((tx) => tx.from === wallet.address).reduce((sum, tx) => sum + Number(tx.fee || 0), 0);
  const previousFees = previous.filter((tx) => tx.from === wallet.address).reduce((sum, tx) => sum + Number(tx.fee || 0), 0);
  const recentTx = recent.filter((tx) => tx.from === wallet.address).length;
  const previousTx = previous.filter((tx) => tx.from === wallet.address).length;
  const recentDailyOutflow = recentOutflow / 7;
  const previousDailyOutflow = previousOutflow / 7;
  const acceleration = previousDailyOutflow > 0 ? recentDailyOutflow / previousDailyOutflow : recentDailyOutflow > 0 ? 1.25 : 1;
  const projectedDailyOutflow = recentDailyOutflow * Math.min(1.6, Math.max(0.7, acceleration));
  const projectedWeeklyOutflow = projectedDailyOutflow * 7;
  const projectedWeeklyFees = recentTx > 0 ? (recentFees / recentTx) * Math.max(1, Math.round((recentTx + previousTx) / 2)) : previousFees;
  const projectedBalance = Math.max(0, Number(currentAccount.availableBalance || 0) - projectedWeeklyOutflow - projectedWeeklyFees);
  const pressure = currentAccount.availableBalance > 0 ? (projectedWeeklyOutflow + projectedWeeklyFees) / currentAccount.availableBalance : 1;
  const tone = pressure >= 0.75 ? "warning" : pressure >= 0.4 ? "good" : "";
  const riskLabel = pressure >= 0.75 ? "HIGH PRESSURE" : pressure >= 0.4 ? "ACTIVE BUT MANAGEABLE" : "LOW PRESSURE";
  const weeklyChange = previousOutflow > 0 ? ((recentOutflow - previousOutflow) / previousOutflow) * 100 : recentOutflow > 0 ? 100 : 0;
  return {
    tone,
    riskLabel,
    projectedWeeklyOutflow,
    projectedWeeklyFees,
    projectedBalance,
    pressure,
    weeklyChange,
    recentTx,
    previousTx,
    acceleration,
  };
}

function analyzeActivitySignals(entries = []) {
  const rules = walletActivityRules;
  const byCounterparty = new Map();
  const counterparties = new Set();
  for (const tx of entries) {
    const participants = [tx.from, tx.to].filter((address) => address && address !== wallet.address);
    for (const address of participants) {
      counterparties.add(address);
      byCounterparty.set(address, (byCounterparty.get(address) ?? 0) + 1);
    }
  }
  const topCounterparties = [...byCounterparty.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([address, count]) => ({ address, count, contactName: contacts.find((entry) => entry.address === address)?.name ?? null }));
  const findings = [];
  const largeTransfers = entries.filter((tx) => tx.from === wallet.address && Number(tx.amount || 0) >= rules.largeTransferEc * SCALE);
  for (const tx of largeTransfers.slice(0, 5)) {
    findings.push({
      tone: "warning",
      title: "Large outbound transfer",
      text: `${format(tx.amount)} EC moved to ${contacts.find((entry) => entry.address === tx.to)?.name ?? short(tx.to, 10)}.`,
      action: { label: "WATCH SENDER", type: "watch-address", value: tx.to },
    });
  }
  const burstWindowMs = rules.burstWindowHours * 60 * 60_000;
  const burstEntries = [...entries].sort((a, b) => b.settledAt - a.settledAt);
  for (let i = 0; i < burstEntries.length; i++) {
    const anchor = burstEntries[i];
    const windowStart = anchor.settledAt - burstWindowMs;
    const windowEntries = burstEntries.filter((tx) => tx.settledAt >= windowStart && tx.settledAt <= anchor.settledAt && tx.from === wallet.address);
    if (windowEntries.length >= rules.burstCount) {
      findings.push({
        tone: "warning",
        title: "Burst spending pattern",
        text: `${windowEntries.length} outgoing transfers settled within ${rules.burstWindowHours}h.`,
        action: { label: "SEE WATCHLIST", type: "scroll-watchlist" },
      });
      break;
    }
  }
  if (rules.watchNewCounterparties) {
    const watched = new Set(watchlist);
    const knownContacts = new Set(contacts.map((entry) => entry.address));
    const firstTimers = topCounterparties.filter((entry) => !watched.has(entry.address) && !knownContacts.has(entry.address)).slice(0, 3);
    for (const entry of firstTimers) {
      findings.push({
        tone: "good",
        title: "New counterparty worth tracking",
        text: `${short(entry.address, 10)} appeared in ${entry.count} committed event${entry.count === 1 ? "" : "s"}.`,
        action: { label: "ADD TO WATCHLIST", type: "watch-address", value: entry.address },
      });
    }
  }
  if (rules.watchTopCounterparties && topCounterparties.length) {
    const seeded = topCounterparties.filter((entry) => !watchlist.includes(entry.address)).slice(0, 5);
    if (seeded.length) {
      findings.push({
        tone: "neutral",
        title: "Top counterparties available to seed",
        text: `${seeded.length} of your busiest counterparts are not yet on the watchlist.`,
        action: { label: "SEED TOP COUNTERPARTIES", type: "seed-counterparties" },
      });
    }
  }
  if (!findings.length) {
    findings.push({
      tone: "neutral",
      title: "No rule hits yet",
      text: "Current activity stays within the local intelligence thresholds.",
      action: { label: "SEED FROM COUNTERPARTIES", type: "seed-counterparties" },
    });
  }
  return { findings, topCounterparties, counterparties: counterparties.size };
}

function analyzeCounterpartyIntelligence(entries = []) {
  const grouped = new Map();
  const seen = new Set();
  for (const tx of entries) {
    for (const address of [tx.from, tx.to].filter((value) => value && value !== wallet.address)) {
      seen.add(address);
      if (!grouped.has(address)) {
        grouped.set(address, {
          address,
          txCount: 0,
          sent: 0,
          received: 0,
          firstSeen: tx.settledAt,
          lastSeen: tx.settledAt,
          largeMoves: 0,
        });
      }
      const item = grouped.get(address);
      item.txCount++;
      item.firstSeen = Math.min(item.firstSeen, tx.settledAt);
      item.lastSeen = Math.max(item.lastSeen, tx.settledAt);
      if (tx.from === address) item.sent += Number(tx.amount || 0);
      if (tx.to === address) item.received += Number(tx.amount || 0);
      if (Number(tx.amount || 0) >= walletActivityRules.largeTransferEc * SCALE) item.largeMoves++;
    }
  }
  const spanMs = Math.max(1, (walletActivitySummary.lastSeen ?? Date.now()) - (walletActivitySummary.firstSeen ?? Date.now()));
  const totalVolume = Math.max(1, walletActivitySummary.inflow + walletActivitySummary.outflow);
  const items = [...grouped.values()].map((item) => {
    const balance = item.received - item.sent;
    const isContact = contacts.some((entry) => entry.address === item.address);
    const isWatched = watchlist.includes(item.address);
    const ageDays = Math.max(1, (item.lastSeen - item.firstSeen) / 86_400_000);
    const cadence = item.txCount / ageDays;
    const share = ((item.sent + item.received) / totalVolume) * 100;
    let risk = 0;
    if (!isContact) risk += 15;
    if (!isWatched) risk += 8;
    if (item.largeMoves) risk += Math.min(25, item.largeMoves * 8);
    if (item.txCount >= 4 && cadence > 2) risk += 15;
    if (balance < 0 && item.sent > item.received * 1.5) risk += 10;
    if (item.txCount === 1) risk += 8;
    if (share > 20) risk += 10;
    if (Date.now() - item.lastSeen < 24 * 60 * 60_000 && item.txCount > 2) risk += 7;
    risk = Math.max(0, Math.min(100, Math.round(risk)));
    const posture = risk >= 55 ? "risky" : risk >= 28 ? "watch" : "trusted";
    return {
      ...item,
      balance,
      share,
      cadence,
      risk,
      posture,
      isContact,
      isWatched,
      contactName: contacts.find((entry) => entry.address === item.address)?.name ?? null,
    };
  }).sort((a, b) => b.risk - a.risk || b.txCount - a.txCount || b.lastSeen - a.lastSeen);
  return { items, seen: seen.size, spanMs };
}

function upsertContact(address, name) {
  const normalizedAddress = String(address || "").trim();
  if (!/^ec1[0-9a-f]{38}$/.test(normalizedAddress)) throw new Error("Enter a valid address");
  const normalizedName = String(name || "").trim() || short(normalizedAddress, 10);
  contacts = contacts.filter((contact) => contact.address !== normalizedAddress);
  contacts.push({ name: normalizedName, address: normalizedAddress });
  contacts.sort((a, b) => a.name.localeCompare(b.name));
  localStorage.setItem(contactsKey, JSON.stringify(contacts));
  renderContacts();
  return normalizedName;
}

function renderCounterpartyIntelligence(entries = walletActivity) {
  const summary = $("#counterparty-summary");
  const list = $("#counterparty-list");
  const top = $("#counterparty-top");
  if (!summary || !list || !top) return;
  const intelligence = analyzeCounterpartyIntelligence(entries);
  walletCounterpartyInsights = intelligence.items;
  const risky = intelligence.items.filter((item) => item.posture === "risky").length;
  const watched = intelligence.items.filter((item) => item.isWatched).length;
  const trusted = intelligence.items.filter((item) => item.posture === "trusted").length;
  summary.textContent = intelligence.items.length
    ? `${intelligence.items.length} counterparties analyzed · ${watched} watched · ${trusted} trusted · ${risky} flagged`
    : "No counterparties yet for this activity window.";
  top.innerHTML = intelligence.items.slice(0, 3).length
    ? intelligence.items.slice(0, 3).map((item) => `
      <span>
        <b>${escapeHtml(item.contactName ?? short(item.address, 10))}</b>
        <small>${escapeHtml(item.posture.toUpperCase())} · ${escapeHtml(String(item.txCount))} TX</small>
      </span>`).join("")
    : '<span><b>No counterparty data</b><small>Add activity to populate this panel</small></span>';
  list.innerHTML = intelligence.items.length ? intelligence.items.slice(0, 8).map((item) => {
    const primaryTone = item.posture === "risky" ? "warning" : item.posture === "trusted" ? "good" : "neutral";
    const name = item.contactName ?? short(item.address, 10);
    const netLabel = item.balance > 0 ? `+${format(item.balance)} EC` : item.balance < 0 ? `-${format(Math.abs(item.balance))} EC` : "0.000000 EC";
    return `<article class="counterparty-row ${primaryTone}">
      <div>
        <b>${escapeHtml(name)}</b>
        <p>${escapeHtml(item.address)} · ${escapeHtml(netLabel)} net · ${escapeHtml(format(item.share))}% of volume</p>
        <div class="counterparty-tags">
          <span>${escapeHtml(item.posture.toUpperCase())}</span>
          <span>${escapeHtml(item.isContact ? "CONTACT" : "NEW")}</span>
          <span>${escapeHtml(item.isWatched ? "WATCHED" : "UNWATCHED")}</span>
          <span>${escapeHtml(String(item.txCount))} TX</span>
        </div>
      </div>
      <div class="counterparty-score">
        <strong>${escapeHtml(String(item.risk))}</strong>
        <small>RISK</small>
      </div>
      <div class="counterparty-actions">
        <button type="button" data-counterparty-action="watch" data-counterparty-address="${escapeHtml(item.address)}">WATCH</button>
        <button type="button" data-counterparty-action="contact" data-counterparty-address="${escapeHtml(item.address)}" data-counterparty-name="${escapeHtml(item.contactName ?? name)}">SAVE CONTACT</button>
        <button type="button" data-counterparty-action="copy" data-counterparty-address="${escapeHtml(item.address)}">COPY</button>
      </div>
    </article>`;
  }).join("") : '<p class="empty">No counterparties in this activity set.</p>';
  renderWatchlistOutlook(intelligence.items);
  renderCounterpartyOutlook(intelligence.items, intelligence);
}

function renderCounterpartyOutlook(items = [], intelligence = { seen: 0, spanMs: 1 }) {
  const note = $("#counterparty-outlook-note");
  const riskMix = $("#counterparty-risk-mix");
  const riskMixNote = $("#counterparty-risk-mix-note");
  const trustMix = $("#counterparty-trust-mix");
  const trustMixNote = $("#counterparty-trust-mix-note");
  const nextStep = $("#counterparty-next-step");
  const nextStepNote = $("#counterparty-next-step-note");
  const panel = $(".counterparty-outlook");
  if (!note || !riskMix || !riskMixNote || !trustMix || !trustMixNote || !nextStep || !nextStepNote || !panel) return;
  if (!items.length) {
    note.textContent = "Add activity to build a relationship outlook.";
    riskMix.textContent = "EMPTY";
    riskMixNote.textContent = "No counterparties have been discovered yet.";
    trustMix.textContent = "EMPTY";
    trustMixNote.textContent = "No trusted relationships can be inferred yet.";
    nextStep.textContent = "ADD ACTIVITY";
    nextStepNote.textContent = "Once transfers settle, the scorecard will populate automatically.";
    panel.classList.remove("warning");
    return;
  }
  const risky = items.filter((item) => item.posture === "risky");
  const trusted = items.filter((item) => item.posture === "trusted");
  const watched = items.filter((item) => item.isWatched);
  const contactsCount = items.filter((item) => item.isContact).length;
  const riskShare = items.reduce((sum, item) => sum + (item.risk / 100) * (item.share / 100), 0);
  const trustShare = items.reduce((sum, item) => sum + ((100 - item.risk) / 100) * (item.share / 100), 0);
  const volumeLeader = items[0];
  const recentWindowDays = Math.max(1, intelligence.spanMs / (24 * 60 * 60_000));
  const networkAgeLabel = recentWindowDays < 3 ? "VERY RECENT" : recentWindowDays < 14 ? "RECENT" : "ESTABLISHED";
  note.textContent = `${items.length} counterparties across a ${networkAgeLabel.toLowerCase()} activity window · ${contactsCount} contacts · ${watched.length} watched.`;
  riskMix.textContent = riskShare >= 0.35 ? "ELEVATED" : riskShare >= 0.18 ? "WATCHFUL" : "CALM";
  riskMixNote.textContent = risky.length
    ? `${risky.length} counterparty${risky.length === 1 ? "" : "ies"} look high risk or unusually active.`
    : `Risk is dispersed across the current graph (${(riskShare * 100).toFixed(1)}% weighted risk).`;
  trustMix.textContent = trustShare >= 0.55 ? "STRONG" : trustShare >= 0.3 ? "MIXED" : "FRAGILE";
  trustMixNote.textContent = trusted.length
    ? `${trusted.length} counterparty${trusted.length === 1 ? "" : "ies"} appear routine and lower risk.`
    : "No low-risk peers dominate the graph yet.";
  nextStep.textContent = risky.length ? "WATCH TOP RISKS" : watched.length < Math.min(3, items.length) ? "SEED WATCHLIST" : "REVIEW TRUSTED PEERS";
  nextStepNote.textContent = risky.length
    ? `Focus on ${short(risky[0].address, 10)} first; it has the highest risk score in the current set.`
    : watched.length < Math.min(3, items.length)
      ? "Add the busiest peers to the watchlist so the next refresh is more informative."
      : `The largest relationship is ${volumeLeader.contactName ?? short(volumeLeader.address, 10)} with ${format(volumeLeader.share)}% of activity volume.`;
  panel.classList.toggle("warning", risky.length > 0);
}

function renderWatchlistOutlook(counterparties = walletCounterpartyInsights) {
  const note = $("#watchlist-outlook-note");
  const riskBand = $("#watchlist-risk-band");
  const riskNote = $("#watchlist-risk-note");
  const movementBand = $("#watchlist-movement-band");
  const movementNote = $("#watchlist-movement-note");
  const nextStep = $("#watchlist-next-step");
  const nextStepNote = $("#watchlist-next-step-note");
  const panel = $(".watchlist-outlook");
  if (!note || !riskBand || !riskNote || !movementBand || !movementNote || !nextStep || !nextStepNote || !panel) return;
  if (!watchlist.length) {
    note.textContent = "Add or seed watched addresses to unlock the outlook.";
    riskBand.textContent = "EMPTY";
    riskNote.textContent = "No addresses are currently under watch.";
    movementBand.textContent = "NONE";
    movementNote.textContent = "No snapshot comparison is available yet.";
    nextStep.textContent = "SEED WATCHLIST";
    nextStepNote.textContent = "Use counterparties or manually add an address.";
    panel.classList.remove("warning");
    return;
  }
  const watchedInsights = counterparties.filter((item) => watchlist.includes(item.address));
  const watchedSnapshots = watchlist.map((address) => {
    const cached = watchlistCache.find((entry) => entry.address === address);
    const balance = address === wallet.address ? (currentAccount?.availableBalance ?? null) : cached?.account?.availableBalance ?? null;
    const priorBalance = watchlistSnapshot[address]?.balance ?? null;
    const delta = Number.isFinite(balance) && Number.isFinite(priorBalance) ? balance - priorBalance : null;
    return { address, balance, delta, risk: watchedInsights.find((item) => item.address === address)?.risk ?? 0, posture: watchedInsights.find((item) => item.address === address)?.posture ?? "neutral" };
  });
  const risky = watchedSnapshots.filter((entry) => entry.risk >= 55);
  const changing = watchedSnapshots.filter((entry) => entry.delta != null && entry.delta !== 0);
  const zeroBalance = watchedSnapshots.filter((entry) => entry.balance != null && entry.balance <= 0);
  const avgRisk = watchedSnapshots.length ? watchedSnapshots.reduce((sum, entry) => sum + entry.risk, 0) / watchedSnapshots.length : 0;
  const riskLabel = avgRisk >= 65 ? "ELEVATED" : avgRisk >= 35 ? "WATCHFUL" : "CALM";
  const movementLabel = changing.length ? `${changing.length} CHANGED` : "STABLE";
  const noteText = watchedInsights.length
    ? `${watchedInsights.length} watched address${watchedInsights.length === 1 ? "" : "es"} overlap with counterparty intelligence.`
    : "No watched addresses have active counterparty history yet.";
  note.textContent = noteText;
  riskBand.textContent = riskLabel;
  riskNote.textContent = risky.length
    ? `${risky.length} watched address${risky.length === 1 ? "" : "es"} are high risk or actively monitored.`
    : `Average watchlist risk is ${avgRisk.toFixed(0)} / 100.`;
  movementBand.textContent = movementLabel;
  movementNote.textContent = changing.length
    ? `${changing.slice(0, 3).map((entry) => `${entry.delta > 0 ? "+" : "−"}${format(Math.abs(entry.delta))} EC`).join(" · ")} since the last snapshot.`
    : "No watched balances changed since the last snapshot.";
  nextStep.textContent = risky.length ? "REVIEW HIGH-RISK" : zeroBalance.length ? "TOP UP OR PRUNE" : "SEED TOP PEERS";
  nextStepNote.textContent = risky.length
    ? `Inspect ${short(risky[0].address, 10)} first; it has the highest risk in the current watch set.`
    : zeroBalance.length
      ? "Some watched accounts are empty, so consider whether they still need to remain on the watchlist."
      : "The watchlist is calm; add your busiest counterparties to improve coverage.";
  panel.classList.toggle("warning", risky.length > 0 || zeroBalance.length > 0);
}

function renderRelationshipMap(insights = walletCounterpartyInsights) {
  const svg = $("#relationship-map");
  const summary = $("#relationship-summary");
  if (!svg || !summary) return;
  const nodes = insights.slice(0, 6);
  const width = 760;
  const height = 360;
  const cx = width / 2;
  const cy = height / 2;
  const radius = 122;
  if (!nodes.length) {
    summary.textContent = "No relationship graph yet. Activity will populate the network automatically.";
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.innerHTML = `<defs><linearGradient id="graphGlow" x1="0" x2="1"><stop offset="0%" stop-color="#c7f36b" stop-opacity=".85"></stop><stop offset="100%" stop-color="#70c7b8" stop-opacity=".55"></stop></linearGradient></defs><rect width="${width}" height="${height}" fill="#0b0f0d"></rect><circle cx="${cx}" cy="${cy}" r="44" fill="#101512" stroke="#c7f36b" stroke-width="2"></circle><text x="${cx}" y="${cy - 4}" text-anchor="middle" fill="#c7f36b" font-size="13" font-family="DM Mono">E-COIN</text><text x="${cx}" y="${cy + 16}" text-anchor="middle" fill="#657067" font-size="8" font-family="DM Mono">NO EDGES YET</text>`;
    return;
  }
  const strongest = nodes[0];
  const graphNodes = nodes.map((node, index) => {
    const angle = (-Math.PI / 2) + ((Math.PI * 2) / Math.max(1, nodes.length)) * index;
    const x = Math.round(cx + Math.cos(angle) * radius);
    const y = Math.round(cy + Math.sin(angle) * radius);
    return { ...node, x, y, angle };
  });
  summary.textContent = `${graphNodes.length} visible relationships · strongest link ${strongest.contactName ?? short(strongest.address, 10)} · ${String(strongest.txCount)} TX`;
  const maxCount = Math.max(...graphNodes.map((node) => node.txCount), 1);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.innerHTML = `
    <defs>
      <linearGradient id="graphGlow" x1="0" x2="1">
        <stop offset="0%" stop-color="#c7f36b" stop-opacity=".95"></stop>
        <stop offset="100%" stop-color="#70c7b8" stop-opacity=".6"></stop>
      </linearGradient>
    </defs>
    <rect width="${width}" height="${height}" rx="18" fill="#0b0f0d"></rect>
    <circle cx="${cx}" cy="${cy}" r="48" fill="#111712" stroke="url(#graphGlow)" stroke-width="3"></circle>
    <text x="${cx}" y="${cy - 6}" text-anchor="middle" fill="#c7f36b" font-size="14" font-family="DM Mono">WALLET</text>
    <text x="${cx}" y="${cy + 15}" text-anchor="middle" fill="#657067" font-size="8" font-family="DM Mono">${escapeHtml(wallet.name)}</text>
    ${graphNodes.map((node) => {
      const stroke = node.posture === "risky" ? "#ffa46b" : node.posture === "trusted" ? "#c7f36b" : "#70c7b8";
      const strokeWidth = 1.4 + (node.txCount / maxCount) * 3;
      const linkOpacity = 0.35 + (node.txCount / maxCount) * 0.45;
      return `
        <line x1="${cx}" y1="${cy}" x2="${node.x}" y2="${node.y}" stroke="${stroke}" stroke-opacity="${linkOpacity.toFixed(2)}" stroke-width="${strokeWidth.toFixed(2)}"></line>
        <g transform="translate(${node.x} ${node.y})">
          <circle r="${13 + Math.min(10, node.txCount * 1.5)}" fill="#0d1210" stroke="${stroke}" stroke-width="${node.isWatched ? 3 : 2}"></circle>
          <text y="-18" text-anchor="middle" fill="#f2f5ee" font-size="9" font-family="DM Mono">${escapeHtml(node.contactName ?? short(node.address, 8))}</text>
          <text y="2" text-anchor="middle" fill="#657067" font-size="8" font-family="DM Mono">${escapeHtml(String(node.txCount))} TX</text>
          <text y="17" text-anchor="middle" fill="${stroke}" font-size="8" font-family="DM Mono">${escapeHtml(node.posture.toUpperCase())}</text>
        </g>`;
    }).join("")}
  `;
}

function renderActivityHeatmap(entries = walletActivity) {
  const svg = $("#activity-heatmap");
  const summary = $("#heatmap-summary");
  const peak = $("#heatmap-peak");
  if (!svg || !summary || !peak) return;
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const width = 760;
  const height = 260;
  const left = 52;
  const top = 34;
  const cellW = (width - left - 20) / 24;
  const cellH = (height - top - 26) / 7;
  const heat = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const tx of entries) {
    const stamp = new Date(tx.settledAt);
    if (Number.isNaN(stamp.getTime())) continue;
    heat[stamp.getDay()][stamp.getHours()]++;
  }
  const flat = heat.flat();
  const total = flat.reduce((sum, value) => sum + value, 0);
  const max = Math.max(...flat, 1);
  const peakIndex = flat.indexOf(max);
  const peakDay = days[Math.floor(peakIndex / 24)] ?? "—";
  const peakHour = peakIndex % 24;
  summary.textContent = total ? `${total} settled events analyzed across ${days.length} days and 24 hourly buckets.` : "No settled events yet, so the timing heatmap is empty.";
  peak.textContent = total ? `Busiest bucket: ${peakDay} at ${String(peakHour).padStart(2, "0")}:00 with ${max} event${max === 1 ? "" : "s"}.` : "Add activity to reveal active hours and spikes.";
  const gradient = (value) => {
    const intensity = value / max;
    const light = 10 + intensity * 28;
    const alpha = 0.15 + intensity * 0.78;
    return `hsla(79, 85%, ${light}%, ${alpha.toFixed(3)})`;
  };
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.innerHTML = `
    <rect x="0" y="0" width="${width}" height="${height}" fill="#0b0f0d"></rect>
    <g font-family="DM Mono" fill="#657067" font-size="8">
      ${days.map((day, index) => `<text x="10" y="${top + index * cellH + 12}">${day}</text>`).join("")}
      ${Array.from({ length: 24 }, (_, hour) => `<text x="${left + hour * cellW + 2}" y="18">${String(hour).padStart(2, "0")}</text>`).join("")}
    </g>
    ${heat.map((row, dayIndex) => row.map((value, hourIndex) => {
      const x = left + hourIndex * cellW;
      const y = top + dayIndex * cellH;
      return `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${(cellW - 2).toFixed(2)}" height="${(cellH - 2).toFixed(2)}" fill="${gradient(value)}" stroke="#1f2a24" stroke-width="1"></rect>`;
    }).join("")).join("")}
  `;
}

function renderActivityIntelligence(entries = walletActivity) {
  const summary = $("#activity-intel-summary");
  const list = $("#activity-intel-list");
  const top = $("#activity-intel-top");
  const seed = $("#activity-intel-seed");
  const largeTransfer = $("#activity-rule-large-transfer");
  const burstCount = $("#activity-rule-burst-count");
  const burstWindow = $("#activity-rule-burst-window");
  const watchNew = $("#activity-rule-watch-new");
  const watchTop = $("#activity-rule-watch-top");
  if (!summary || !list || !top || !seed || !largeTransfer || !burstCount || !burstWindow || !watchNew || !watchTop) return;
  largeTransfer.value = String(walletActivityRules.largeTransferEc);
  burstCount.value = String(walletActivityRules.burstCount);
  burstWindow.value = String(walletActivityRules.burstWindowHours);
  watchNew.checked = walletActivityRules.watchNewCounterparties;
  watchTop.checked = walletActivityRules.watchTopCounterparties;
  const intelligence = analyzeActivitySignals(entries);
  walletActivitySignals = intelligence.findings;
  $(".activity-signal-card")?.classList.toggle("has-warning", intelligence.findings.some((item) => item.tone === "warning"));
  renderCounterpartyIntelligence(entries);
  renderRelationshipMap(walletCounterpartyInsights);
  renderActivityHeatmap(entries);
  const watchable = intelligence.topCounterparties.slice(0, 6);
  const warningCount = intelligence.findings.filter((item) => item.tone === "warning").length;
  const strongest = intelligence.topCounterparties[0];
  const strongestLabel = strongest ? `${strongest.contactName ?? short(strongest.address, 10)} (${strongest.count} hits)` : "No active counterparties";
  summary.textContent = `${intelligence.counterparties} counterparties tracked · ${warningCount} warning${warningCount === 1 ? "" : "s"} · busiest relationship ${strongestLabel}.`;
  top.innerHTML = watchable.length ? watchable.map((entry) => `<span><b>${escapeHtml(entry.contactName ?? short(entry.address, 10))}</b><small>${escapeHtml(String(entry.count))} hits</small></span>`).join("") : '<span><b>None yet</b><small>No counterparties discovered</small></span>';
  list.innerHTML = intelligence.findings.length ? intelligence.findings.map((item) => `
    <article class="activity-finding ${item.tone}">
      <div>
        <b>${escapeHtml(item.title)}</b>
        <p>${escapeHtml(item.text)}</p>
      </div>
      <button type="button" data-activity-action="${escapeHtml(item.action.type)}" data-activity-action-value="${escapeHtml(item.action.value ?? "")}">${escapeHtml(item.action.label)}</button>
    </article>`).join("") : '<div class="activity-clear-state"><span>✓</span><div><b>No active signals</b><p>Current activity is inside the saved policy thresholds.</p></div></div>';
  seed.textContent = intelligence.topCounterparties.length ? `Seed ${Math.min(5, intelligence.topCounterparties.length)} top counterparties` : "Seed from counterparties";
}

function renderWalletActivity(activity = walletActivity, account = currentAccount) {
  const summaryNode = $("#activity-summary");
  const list = $("#activity-list");
  const note = $("#activity-note");
  if (!summaryNode || !list || !note) return;
  const filtered = activity.filter((tx) => {
    if (walletActivityFilter === "all") return true;
    if (walletActivityFilter === "incoming") return tx.to === wallet.address;
    if (walletActivityFilter === "outgoing") return tx.from === wallet.address;
    if (walletActivityFilter === "contract") return String(tx.type || "").startsWith("contract_");
    return true;
  }).filter((tx) => {
    if (walletActivityFrom && tx.settledAt < new Date(walletActivityFrom).getTime()) return false;
    if (walletActivityTo && tx.settledAt > new Date(`${walletActivityTo}T23:59:59.999`).getTime()) return false;
    if (!walletActivityQuery) return true;
    const needle = walletActivityQuery.toLowerCase();
    const fields = [
      tx.id,
      tx.type,
      tx.from,
      tx.to,
      tx.memo,
      tx.contractAddress,
      tx.blockHeight,
      tx.amount,
      tx.fee,
      contacts.find((entry) => entry.address === tx.from)?.name,
      contacts.find((entry) => entry.address === tx.to)?.name,
    ].filter((value) => value != null).map((value) => String(value).toLowerCase());
    return fields.some((value) => value.includes(needle));
  });
  const summary = walletActivitySummary = summarizeWalletActivity(filtered);
  const trend = summarizeActivityTrend(filtered);
  const forecast = summarizeActivityForecast(filtered);
  renderActivityIntelligence(filtered);
  $("#activity-inflow").textContent = `${format(summary.inflow)} EC`;
  $("#activity-outflow").textContent = `${format(summary.outflow)} EC`;
  $("#activity-fees").textContent = `${format(summary.fees)} EC`;
  $("#activity-net").textContent = `${summary.net >= 0 ? "+" : ""}${format(Math.abs(summary.net))} EC`;
  $("#activity-count").textContent = `${summary.txCount} TX`;
  $("#activity-counterparties").textContent = `${summary.counterparties} peers`;
  const windowNode = $("#activity-window");
  if (windowNode) windowNode.textContent = summary.firstSeen && summary.lastSeen ? `${relativeTime(summary.firstSeen)} → ${relativeTime(summary.lastSeen)}` : "No history yet";
  const newest = filtered[0];
  const stateLabel = newest ? `${activityKindLabel(newest)} · ${relativeTime(newest.settledAt)}` : "No confirmed activity yet";
  summaryNode.textContent = `${summary.txCount} confirmed event${summary.txCount === 1 ? "" : "s"} · ${summary.counterparties} ${summary.counterparties === 1 ? "counterparty" : "counterparties"} · ${summary.net >= 0 ? "net positive" : "net negative"}`;
  note.textContent = summary.anomalies.length ? summary.anomalies[0].text : newest ? `Latest activity: ${stateLabel}` : "No on-chain activity has settled for this wallet yet.";
  const trendNode = $("#activity-trend");
  if (trendNode) {
    trendNode.className = `activity-summary-trend ${trend.tone}`.trim();
    trendNode.textContent = `Trend: ${trend.label} · ${trend.note}`;
  }
  const forecastTone = $("#activity-forecast");
  if (forecastTone) forecastTone.className = `activity-forecast ${forecast.tone}`.trim();
  $("#activity-forecast-outflow").textContent = `${format(forecast.projectedWeeklyOutflow)} EC`;
  $("#activity-forecast-outflow-note").textContent = `${forecast.weeklyChange >= 0 ? "+" : ""}${forecast.weeklyChange.toFixed(0)}% vs prior week · ${forecast.recentTx} recent send${forecast.recentTx === 1 ? "" : "s"}`;
  $("#activity-forecast-balance").textContent = `${format(forecast.projectedBalance)} EC`;
  $("#activity-forecast-balance-note").textContent = forecast.projectedBalance <= 0 ? "Projected balance would be exhausted under current pacing." : `At current pacing, about ${format(forecast.projectedWeeklyFees)} EC in fees is also expected.`;
  $("#activity-forecast-pressure").textContent = `${Math.round(forecast.pressure * 100)}%`;
  $("#activity-forecast-pressure-note").textContent = forecast.riskLabel;
  list.innerHTML = filtered.length ? filtered.map((tx) => {
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
  }).join("") : '<p class="empty">No confirmed activity matches this filter.</p>';
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
  const entries = walletActivity.filter((tx) => {
    if (walletActivityFilter !== "all") {
      if (walletActivityFilter === "incoming" && tx.to !== wallet.address) return false;
      if (walletActivityFilter === "outgoing" && tx.from !== wallet.address) return false;
      if (walletActivityFilter === "contract" && !String(tx.type || "").startsWith("contract_")) return false;
    }
    if (walletActivityFrom && tx.settledAt < new Date(walletActivityFrom).getTime()) return false;
    if (walletActivityTo && tx.settledAt > new Date(`${walletActivityTo}T23:59:59.999`).getTime()) return false;
    if (!walletActivityQuery) return true;
    const needle = walletActivityQuery.toLowerCase();
    return [tx.id, tx.type, tx.from, tx.to, tx.memo, tx.contractAddress, tx.blockHeight, tx.amount, tx.fee]
      .filter((value) => value != null)
      .map((value) => String(value).toLowerCase())
      .some((value) => value.includes(needle));
  });
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
    if (marketData) renderStressLab();
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
  if (marketData) renderStressLab();
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
  renderSecurityCenter();
}

function buildSecurityPosture() {
  const now = Date.now();
  const backupAt = Number(recoveryAudit[wallet?.address] || 0);
  const backupAge = backupAt ? now - backupAt : null;
  const backupRecent = backupAge != null && backupAge <= 7 * 24 * 60 * 60_000;
  const recentWarnings = securityJournal.filter((entry) => entry.severity === "warning").length;
  const recentCritical = securityJournal.filter((entry) => entry.severity === "critical").length;
  const guardReserve = Number(guardPolicy.reserve || 0);
  const events = securityJournal.slice(0, 6);
  const recommendations = [];
  const attackVectors = [];
  let score = 100;

  if (vaultState === "none") {
    score -= 40;
    recommendations.push({ tone:"warning", title:"Enable the vault", text:"Encrypt the local keys before moving more value." });
    attackVectors.push("Private keys are stored in browser storage.");
  } else if (vaultState === "locked") {
    score -= 12;
    recommendations.push({ tone:"good", title:"Keys are sealed", text:"Unlock only when you are ready to sign something intentionally." });
  } else {
    recommendations.push({ tone:"good", title:"Signing is available", text:"Keep the active session short and lock the vault when you pause." });
  }

  if (!sessionSecurity.timeoutMinutes) {
    score -= 14;
    recommendations.push({ tone:"warning", title:"Auto-lock is off", text:"Turn on inactivity locking so the signing session cannot sit open forever." });
    attackVectors.push("Session can remain open indefinitely.");
  } else if (sessionSecurity.timeoutMinutes <= 5) {
    score += 4;
    recommendations.push({ tone:"good", title:"Short session timer", text:"The current inactivity timer is aggressive enough for a shared machine." });
  } else if (sessionSecurity.timeoutMinutes <= 15) {
    score += 2;
  } else {
    score -= 4;
  }

  if (!sessionSecurity.lockWhenHidden) {
    score -= 8;
    recommendations.push({ tone:"warning", title:"Hidden app stays unlocked", text:"Lock on hide closes an easy attack path if you step away." });
    attackVectors.push("Hidden-tab exposure remains enabled.");
  }

  if (backupAt === 0) {
    score -= 18;
    recommendations.push({ tone:"warning", title:"No fresh recovery bundle", text:"Create an encrypted recovery backup after unlocking the vault." });
    attackVectors.push("No encrypted recovery copy is recorded.");
  } else if (!backupRecent) {
    score -= 10;
    recommendations.push({ tone:"warning", title:"Recovery bundle is stale", text:`Last encrypted backup was ${relativeTime(backupAt)}.` });
    attackVectors.push("Recovery backup may not match the latest wallet state.");
  } else {
    score += 4;
    recommendations.push({ tone:"good", title:"Recovery is recent", text:"The latest encrypted backup is still reasonably fresh." });
  }

  if (!guardReserve) {
    score -= 5;
    recommendations.push({ tone:"warning", title:"No reserve floor", text:"Set a minimum reserve so one large send cannot empty the wallet." });
    attackVectors.push("No reserve floor protects against oversized sends.");
  } else if ((currentAccount.availableBalance ?? 0) < guardReserve) {
    score -= 6;
    recommendations.push({ tone:"warning", title:"Reserve is tight", text:`The configured reserve of ${format(guardReserve)} EC is above the current available balance.` });
    attackVectors.push("Configured reserve exceeds liquid balance.");
  }

  if (guardPolicy.knownOnly) score += 4;
  if (guardPolicy.dailyLimit) score += 2;
  const activeWarnings = walletActivitySignals.filter((signal) => signal.tone === "warning");
  if (activeWarnings.length) {
    score -= 6;
    attackVectors.push(`${activeWarnings.length} active activity warning${activeWarnings.length === 1 ? "" : "s"} detected.`);
  }
  score -= Math.min(16, recentWarnings * 4 + recentCritical * 8);
  score = Math.max(0, Math.min(100, Math.round(score)));

  const grade = score >= 90 ? "HARDENED" : score >= 75 ? "READY" : score >= 55 ? "CAUTION" : "EXPOSED";
  const sessionLabel = vaultState === "locked"
    ? "LOCKED"
    : vaultState === "unlocked"
      ? (sessionSecurity.timeoutMinutes ? `${sessionSecurity.timeoutMinutes} MIN TIMER` : "AUTO-LOCK OFF")
      : "NOT ENABLED";
  const backupLabel = backupAt ? (backupAge < 60_000 ? "JUST NOW" : relativeTime(backupAt).toUpperCase()) : "NO BACKUP";
  const eventSummary = `${securityJournal.length} event${securityJournal.length === 1 ? "" : "s"} recorded`;
  const attackSurface = attackVectors.length;
  const attackSurfaceLabel = attackSurface === 0 ? "MINIMAL" : attackSurface <= 2 ? "LOW" : attackSurface <= 4 ? "MODERATE" : "EXPANDED";
  const nearTermRisk = score >= 90 ? "LOW" : score >= 75 ? "LOW-MEDIUM" : score >= 55 ? "MEDIUM" : "HIGH";
  const nextAction = recommendations[0] || { title: "Review posture", text: "Check the security center for the next step." };

  if (!recommendations.length) {
    recommendations.push({ tone:"good", title:"Good baseline", text:"Nothing obvious is out of policy right now." });
  }

  return { score, grade, backupLabel, eventSummary, sessionLabel, recommendations:recommendations.slice(0, 4), events, attackSurface, attackSurfaceLabel, nearTermRisk, nextAction, attackVectors:attackVectors.slice(0, 4) };
}

function renderSecurityCenter() {
  if (!$("#security-center")) return;
  const posture = buildSecurityPosture();
  $("#security-score").textContent = `${posture.score}/100`;
  $("#security-grade").textContent = posture.grade;
  $("#security-session-state").textContent = posture.sessionLabel;
  $("#security-backup-state").textContent = posture.backupLabel;
  $("#security-event-state").textContent = posture.eventSummary;
  $("#security-session-note").textContent = vaultState === "locked"
    ? "Signing keys are sealed right now."
    : vaultState === "unlocked"
      ? "A live session is available for signing."
      : "Vault is not enabled yet.";
  $("#security-backup-note").textContent = posture.backupLabel === "NO BACKUP"
    ? "No encrypted recovery bundle has been created."
    : posture.backupLabel === "JUST NOW"
      ? "You just created a fresh encrypted backup."
      : `Last backup recorded ${posture.backupLabel.toLowerCase()}.`;
  $("#security-event-note").textContent = posture.events.length
    ? `${posture.events[0].title} is the latest event.`
    : "No security events have been recorded for this wallet.";
  $("#security-attack-surface").textContent = posture.attackSurfaceLabel;
  $("#security-attack-note").textContent = posture.attackVectors.length
    ? posture.attackVectors.join(" ")
    : "No obvious local attack vectors were detected.";
  $("#security-near-term-risk").textContent = posture.nearTermRisk;
  $("#security-near-term-note").textContent = posture.grade === "HARDENED"
    ? "The next signing session should be low risk if the vault stays locked when idle."
    : posture.grade === "READY"
      ? "The wallet is usable, but keep an eye on session and backup discipline."
      : posture.grade === "CAUTION"
        ? "One or two soft spots remain; tighten them before moving larger balances."
        : "The wallet is exposed enough that a hardening pass should happen first.";
  $("#security-next-action").textContent = posture.nextAction.title;
  $("#security-next-action-note").textContent = posture.nextAction.text;
  $("#security-summary").textContent = posture.grade === "HARDENED"
    ? "The wallet is configured for short sessions, recent recovery, and clear local guardrails."
    : posture.grade === "READY"
      ? "The wallet is in good shape, but the latest recommendations still deserve a quick review."
      : posture.grade === "CAUTION"
        ? "A few protective settings are soft or stale. Tighten them before moving larger balances."
        : "This wallet needs attention before it should be treated as safe for larger transfers.";
  $("#security-recommendations").innerHTML = posture.recommendations.map((item, index) => `
    <article class="security-recommendation ${item.tone}">
      <span>${index + 1}</span>
      <div><b>${escapeHtml(item.title)}</b><p>${escapeHtml(item.text)}</p></div>
    </article>`).join("");
  $("#security-timeline").innerHTML = posture.events.length ? posture.events.map((event) => `
    <article class="security-event ${escapeHtml(event.severity || "info")}">
      <time>${escapeHtml(relativeTime(Number(event.timestamp)))}</time>
      <div><b>${escapeHtml(event.title)}</b><p>${escapeHtml(event.detail)}</p></div>
      <i>${escapeHtml(String(event.type).replaceAll("_", " ").toUpperCase())}</i>
    </article>`).join("") : '<p class="empty">No wallet security events yet. We will build this timeline as you use the wallet.</p>';
  $(".security-center").classList.toggle("warn", posture.grade === "CAUTION" || posture.grade === "EXPOSED");
  $(".security-outlook")?.classList.toggle("warning", posture.grade === "CAUTION" || posture.grade === "EXPOSED");
  renderLearnLab();
}

function buildSecurityReport() {
  const posture = buildSecurityPosture();
  return {
    exportedAt: Date.now(),
    wallet: { name: wallet?.name, address: wallet?.address, vaultState, wallets: wallets.length },
    posture,
    sessionSecurity,
    guardPolicy,
    recoveryAuditAt: Number(recoveryAudit[wallet?.address] || 0) || null,
    securityJournal,
    walletHistory,
    recentTransfers,
    spendJournal,
  };
}

function recordSecurityEvent(type, title, detail, severity = "info") {
  if (!wallet?.address) return;
  securityJournal = [{
    id: crypto.randomUUID(),
    type,
    title,
    detail,
    severity,
    timestamp: Date.now(),
  }, ...securityJournal].slice(0, 24);
  saveSecurityJournal();
  renderSecurityCenter();
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
  renderWatchlistOutlook(walletCounterpartyInsights);
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
      if (contract.contractType === "milestone" && contract.status === "locked") {
        const milestone = (contract.approvalRound ?? (contract.releasedInstallments ?? 0) + 1);
        const creatorApproved = (contract.creatorApprovedRound ?? 0) >= milestone;
        const beneficiaryApproved = (contract.beneficiaryApprovedRound ?? 0) >= milestone;
        const approvalLabel = creatorApproved && beneficiaryApproved ? "Ready for release" : creatorApproved || beneficiaryApproved ? "One approval missing" : "Awaiting both approvals";
        return { label: `Milestone ${milestone}/${contract.installments} · ${approvalLabel}`, at: contract.nextReleaseAt ?? contract.unlockTime };
      }
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

function renderDataBrief(market, status, blocks, priceValues) {
  const note = $("#data-brief-note");
  const network = $("#data-brief-network");
  const networkNote = $("#data-brief-network-note");
  const portfolio = $("#data-brief-portfolio");
  const portfolioNote = $("#data-brief-portfolio-note");
  const watchlistNode = $("#data-brief-watchlist");
  const watchlistNote = $("#data-brief-watchlist-note");
  const next = $("#data-brief-next");
  const nextNote = $("#data-brief-next-note");
  const panel = $(".data-brief");
  if (!note || !network || !networkNote || !portfolio || !portfolioNote || !watchlistNode || !watchlistNote || !next || !nextNote || !panel) return;
  const healthScore = computeSystemHealth(status, market, blocks);
  const momentum = summarizeMomentum(priceValues);
  const regime = analyzeMarketRegime(market, status, priceValues);
  const pressure = Number(feeQuote.pressure || 0);
  const treasuryRatio = Number(market.treasuryBalance || 0) / Math.max(Number(status.maxSupply || 0), 1);
  const holdings = portfolioEntries.reduce((sum, entry) => sum + Math.max(0, Number(entry.holdings || 0)), 0);
  const available = portfolioEntries.reduce((sum, entry) => sum + Math.max(0, Number(entry.availableBalance || 0)), 0);
  const concentration = holdings && portfolioEntries.length ? Math.max(...portfolioEntries.map((entry) => Math.max(0, Number(entry.holdings || 0)))) / holdings : 0;
  const liquidShare = holdings ? available / holdings : 0;
  const watchedPeers = walletCounterpartyInsights.filter((item) => item.isWatched).length;
  const riskyPeers = walletCounterpartyInsights.filter((item) => item.posture === "risky").length;
  const watchCoverage = watchlist.length ? watchedPeers / watchlist.length : 0;
  const eta = formatDuration(Math.max(0, nextBlockAt - Date.now()));
  const etaLabel = eta === "—" || eta === "â€”" ? "awaiting next seal" : eta;
  const networkLabel = !status.chainValid
    ? "DEGRADED"
    : pressure > 0.75
      ? "FEE PRESSURE"
      : momentum.delta > 2
        ? "UPTREND"
        : momentum.delta < -2
          ? "SOFTENING"
          : treasuryRatio < 0.25
            ? "TIGHT SUPPLY"
            : "BALANCED";
  const networkDetail = !status.chainValid
    ? "Ledger validation is failing, so treat all market and wallet data as provisional."
    : `~ ${etaLabel} · ${Math.round(pressure * 100)}% fee pressure · ${Number(market.openOrders || 0)} open orders.`;
  const portfolioLabel = !portfolioEntries.length
    ? "EMPTY"
    : concentration > 0.6
      ? "CONCENTRATED"
      : liquidShare < 0.25
        ? "LOCKED UP"
        : liquidShare > 0.65
          ? "LIQUID"
          : "BALANCED";
  const portfolioDetail = !portfolioEntries.length
    ? "No local wallets are loaded yet."
    : `${format(holdings)} EC total · ${format(available)} EC ready · ${(concentration * 100).toFixed(1)}% top wallet share.`;
  const watchlistLabel = !watchlist.length
    ? "EMPTY"
    : riskyPeers > 0
      ? "WATCHFUL"
      : watchCoverage >= 0.75
        ? "COVERED"
        : "PARTIAL";
  const watchlistDetail = !watchlist.length
    ? "Seed watched addresses to unlock counterparty coverage."
    : `${watchedPeers} watched peers · ${riskyPeers} flagged · ${(watchCoverage * 100).toFixed(0)}% of the watchlist covered.`;
  let nextLabel = "OPEN ORDER BOOK";
  let nextDetail = "Passive limit orders are the cleanest default when the market is quiet.";
  if (!status.chainValid) {
    nextLabel = "OPEN SECURITY";
    nextDetail = "Stabilize the wallet first so the market view can be trusted.";
  } else if (pressure > 0.75) {
    nextLabel = "CHECK FEES";
    nextDetail = "Network pressure is high, so signing with more patience will usually save cost.";
  } else if (concentration > 0.6) {
    nextLabel = "REVIEW PORTFOLIO";
    nextDetail = "One wallet holds most of the balance, so a quick allocation pass can lower risk.";
  } else if (riskyPeers > 0) {
    nextLabel = "REVIEW WATCHLIST";
    nextDetail = "A flagged counterparty is active, so a quick relationship review is worthwhile.";
  } else if (momentum.delta > 2) {
    nextLabel = "PLAN BUY IN SLICES";
    nextDetail = "Momentum is positive enough that staged entries are more resilient than a single aggressive fill.";
  } else if (healthScore >= 85) {
    nextDetail = "The control surface is healthy, so staying selective is the highest-quality move.";
  }
  note.textContent = `${regime.label} · ${momentum.label} · ${healthScore >= 85 ? "healthy" : healthScore >= 65 ? "watchful" : "degraded"} control surface.`;
  network.textContent = networkLabel;
  networkNote.textContent = networkDetail;
  portfolio.textContent = portfolioLabel;
  portfolioNote.textContent = portfolioDetail;
  watchlistNode.textContent = watchlistLabel;
  watchlistNote.textContent = watchlistDetail;
  next.textContent = nextLabel;
  nextNote.textContent = nextDetail;
  panel.classList.toggle("warning", !status.chainValid || pressure > 0.75 || concentration > 0.6 || riskyPeers > 0);
}

function renderDataForecast(market, status, priceValues) {
  const note = $("#data-forecast-note");
  const priceNode = $("#data-forecast-price");
  const priceNote = $("#data-forecast-price-note");
  const execNode = $("#data-forecast-exec");
  const execNote = $("#data-forecast-exec-note");
  const pressureNode = $("#data-forecast-pressure");
  const pressureNote = $("#data-forecast-pressure-note");
  const panel = $("#data-forecast-panel");
  const chart = $("#data-forecast-chart");
  if (!note || !priceNode || !priceNote || !execNode || !execNote || !pressureNode || !pressureNote || !panel || !chart) return;
  const recent = priceValues.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0).slice(-12);
  const pressure = Number(feeQuote.pressure || 0);
  const spreadUsd = (Number(market.spreadMicroUsd || 0) / 1_000_000);
  const price = Number(market.priceUsd || recent.at(-1) || 0);
  const spreadPct = price > 0 ? spreadUsd / price : 0;
  if (recent.length < 2 || !price) {
    note.textContent = "Waiting for enough price history to project the next move.";
    priceNode.textContent = "INSUFFICIENT DATA";
    priceNote.textContent = "Collect a few more trades and the forecast will become directional.";
    execNode.textContent = "HOLD";
    execNote.textContent = "No depth signal yet.";
    pressureNode.textContent = `${Math.round(pressure * 100)}%`;
    pressureNote.textContent = pressure > 0.7 ? "Queue pressure is already elevated." : "Queue pressure is still manageable.";
    chart.querySelector("polyline").setAttribute("points", "");
    chart.querySelector(".area").setAttribute("d", "");
    chart.querySelector(".chart-gridlines").innerHTML = "";
    panel.classList.toggle("warning", pressure > 0.7);
    return;
  }
  const first = recent[0];
  const last = recent[recent.length - 1];
  const changePct = first ? ((last - first) / first) * 100 : 0;
  const avgStep = recent.length > 1 ? recent.slice(1).reduce((sum, value, index) => sum + (value - recent[index]), 0) / (recent.length - 1) : 0;
  const volatility = recent.length > 1
    ? recent.slice(1).reduce((sum, value, index) => sum + Math.abs(value - recent[index]), 0) / (recent.length - 1)
    : 0;
  const slope = recent.length > 1 ? avgStep / Math.max(last, 1) : 0;
  const drift = slope + (status.chainValid ? 0.0025 : -0.01) - pressure * 0.012 - spreadPct * 0.08;
  const projected = recent.slice();
  let point = last;
  for (let i = 0; i < 6; i++) {
    point = Math.max(1e-9, point * (1 + drift));
    projected.push(point);
  }
  const points = chartPoints(projected, 720, 220, 24);
  chart.querySelector("polyline").setAttribute("points", points.line);
  chart.querySelector(".area").setAttribute("d", `${points.path} L 696 196 L 24 196 Z`);
  chart.querySelector(".chart-gridlines").innerHTML = [44, 90, 136, 182].map((y) => `<line x1="24" y1="${y}" x2="696" y2="${y}"></line>`).join("");
  const projectedPrice = projected.at(-1);
  const direction = projectedPrice > last * 1.01 ? "BULLISH" : projectedPrice < last * 0.99 ? "BEARISH" : "SIDEWAYS";
  const confidence = Math.max(35, Math.min(96, Math.round((recent.length / 12) * 50 + (status.chainValid ? 15 : 0) + (pressure < 0.45 ? 12 : -10) + (spreadPct < 0.02 ? 10 : -8) - Math.min(20, volatility / Math.max(last, 1) * 1200))));
  const executionLabel = pressure > 0.75 || spreadPct > 0.03
    ? "LIMIT-ONLY"
    : pressure > 0.5 || spreadPct > 0.015
      ? "PATIENT"
      : "EFFICIENT";
  const pressureLabel = pressure > 0.75
    ? "HIGH"
    : pressure > 0.5
      ? "ELEVATED"
      : pressure > 0.25
        ? "MODERATE"
        : "LOW";
  note.textContent = `${direction} · ${confidence}% confidence · ${recent.length} sample points.`;
  priceNode.textContent = direction;
  priceNote.textContent = `${usd(projectedPrice, 6)} projected from ${usd(last, 6)} with ${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}% recent change.`;
  execNode.textContent = executionLabel;
  execNote.textContent = executionLabel === "LIMIT-ONLY"
    ? "Spread or congestion is high enough that passive sizing is safer."
    : executionLabel === "PATIENT"
      ? "Execution is workable, but waits and staged orders should improve fill quality."
      : "Depth and pressure look cooperative for cleaner fills.";
  pressureNode.textContent = `${Math.round(pressure * 100)}%`;
  pressureNote.textContent = `${pressureLabel} fee pressure · ${spreadPct > 0.02 ? "spread is wide" : "spread is orderly"}.`;
  panel.classList.toggle("warning", executionLabel !== "EFFICIENT" || confidence < 55);
  if (confidence >= 70 || executionLabel !== "EFFICIENT") {
    pushDataSignal({
      kind: "forecast",
      severity: executionLabel === "LIMIT-ONLY" ? "warning" : direction === "BEARISH" ? "warning" : "good",
      label: `Forecast ${direction.toLowerCase()}`,
      text: `${direction} setup with ${confidence}% confidence and ${executionLabel.toLowerCase()} execution.`,
      detail: `${usd(projectedPrice, 6)} projected in the current ${dataSignalConfig.forecastHorizon}-point window.`,
      action: "REVIEW FORECAST",
      target: "data-forecast-panel",
    });
  }
}

function signalProfile() {
  if (dataSignalConfig.sensitivity === "tight") return { pressure: 0.65, spread: 0.02, concentration: 0.52, drift: 6, label: "TIGHT" };
  if (dataSignalConfig.sensitivity === "broad") return { pressure: 0.82, spread: 0.03, concentration: 0.66, drift: 10, label: "BROAD" };
  return { pressure: 0.75, spread: 0.025, concentration: 0.6, drift: 8, label: "BALANCED" };
}

function pushDataSignal(entry) {
  const signature = `${entry.kind}:${entry.label}:${entry.detail}`;
  if (dataSignalSeen[signature]) return false;
  dataSignalSeen[signature] = Date.now();
  dataSignalFeed = [{ ...entry, id: crypto.randomUUID(), createdAt: Date.now() }, ...dataSignalFeed]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, dataSignalConfig.feedLimit);
  saveDataSignals();
  return true;
}

function renderDataSignals() {
  const modeNode = $("#data-signal-mode");
  const modeNote = $("#data-signal-mode-note");
  const windowNode = $("#data-signal-window");
  const windowNote = $("#data-signal-window-note");
  const feedCountNode = $("#data-signal-feed-count");
  const feedCountNote = $("#data-signal-feed-count-note");
  const feed = $("#data-signal-feed");
  const panel = $("#data-signal-panel");
  const sensitivity = $("#data-signal-sensitivity");
  const forecast = $("#data-signal-forecast");
  const limit = $("#data-signal-limit");
  if (!modeNode || !modeNote || !windowNode || !windowNote || !feedCountNode || !feedCountNote || !feed || !panel || !sensitivity || !forecast || !limit) return;
  sensitivity.value = dataSignalConfig.sensitivity;
  forecast.value = String(dataSignalConfig.forecastHorizon);
  limit.value = String(dataSignalConfig.feedLimit);
  const profile = signalProfile();
  modeNode.textContent = profile.label;
  modeNote.textContent = profile.label === "TIGHT"
    ? "Lower noise tolerance and faster escalation."
    : profile.label === "BROAD"
      ? "More tolerant of noise and better for exploratory monitoring."
      : "Balanced sensitivity for everyday monitoring.";
  windowNode.textContent = `${dataSignalConfig.forecastHorizon} POINTS`;
  windowNote.textContent = `Forecast and anomaly logic use the latest ${dataSignalConfig.forecastHorizon} sample points.`;
  feedCountNode.textContent = String(dataSignalFeed.length);
  feedCountNote.textContent = dataSignalFeed.length ? "Recent notable events are retained locally." : "Signals will appear here as the detector learns.";
  feed.innerHTML = dataSignalFeed.length ? dataSignalFeed.slice(0, dataSignalConfig.feedLimit).map((item) => `
    <article class="data-signal-item ${item.severity}">
      <span>${escapeHtml(item.kind === "forecast" ? "F" : "A")}</span>
      <div>
        <b>${escapeHtml(item.label)}</b>
        <p>${escapeHtml(item.text)}</p>
        <small>${escapeHtml(item.detail)}</small>
      </div>
      <button type="button" data-data-signal-target="${escapeHtml(item.target)}">${escapeHtml(item.action)}</button>
    </article>
  `).join("") : '<p class="empty">No notable signals have been recorded yet.</p>';
  panel.classList.toggle("warning", dataSignalFeed.some((item) => item.severity === "warning" || item.severity === "critical"));
}

function renderDataAnomalies(market, status, blocks, priceValues) {
  const note = $("#data-anomaly-note");
  const countNode = $("#data-anomaly-count");
  const countNote = $("#data-anomaly-count-note");
  const gradeNode = $("#data-anomaly-grade");
  const gradeNote = $("#data-anomaly-grade-note");
  const confidenceNode = $("#data-anomaly-confidence");
  const confidenceNote = $("#data-anomaly-confidence-note");
  const list = $("#data-anomaly-list");
  const panel = $("#data-anomaly-panel");
  if (!note || !countNode || !countNote || !gradeNode || !gradeNote || !confidenceNode || !confidenceNote || !list || !panel) return;
  const profile = signalProfile();
  const recent = priceValues.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0).slice(-dataSignalConfig.forecastHorizon);
  const pressure = Number(feeQuote.pressure || 0);
  const price = Number(market.priceUsd || recent.at(-1) || 0);
  const spreadUsd = Number(market.spreadMicroUsd || 0) / 1_000_000;
  const spreadPct = price > 0 ? spreadUsd / price : 0;
  const thresholds = {
    pressure: profile.pressure,
    spread: profile.spread,
    concentration: profile.concentration,
    drift: profile.drift,
  };
  const totalHoldings = portfolioEntries.reduce((sum, entry) => sum + Math.max(0, Number(entry.holdings || 0)), 0);
  const availableHoldings = portfolioEntries.reduce((sum, entry) => sum + Math.max(0, Number(entry.availableBalance || 0)), 0);
  const concentration = totalHoldings && portfolioEntries.length ? Math.max(...portfolioEntries.map((entry) => Math.max(0, Number(entry.holdings || 0)))) / totalHoldings : 0;
  const liquidShare = totalHoldings ? availableHoldings / totalHoldings : 0;
  const treasuryRatio = Number(market.treasuryBalance || 0) / Math.max(Number(status.maxSupply || 0), 1);
  const riskyPeers = walletCounterpartyInsights.filter((item) => item.posture === "risky");
  const watchedPeers = walletCounterpartyInsights.filter((item) => item.isWatched);
  const anomalies = [];
  if (!status.chainValid) {
    anomalies.push({
      severity: "critical",
      label: "Ledger validation failure",
      text: "The chain is not validating cleanly, so treat all downstream market and wallet signals as provisional.",
      detail: "Open Security and resolve the integrity issue before trusting execution or balance forecasts.",
      action: "OPEN SECURITY",
      target: "security-center",
    });
  }
  if (pressure > thresholds.pressure) {
    anomalies.push({
      severity: "warning",
      label: "Elevated fee pressure",
      text: "Queue congestion is high enough to distort timing and increase cost for urgent sends.",
      detail: `${Math.round(pressure * 100)}% network pressure is above the safe default range.`,
      action: "CHECK FEES",
      target: "orderbook-panel",
    });
  }
  if (spreadPct > thresholds.spread) {
    anomalies.push({
      severity: "warning",
      label: "Wide market spread",
      text: "The order book is thin enough that market orders are more likely to pay a liquidity penalty.",
      detail: `Spread is ${usd(spreadUsd, 6)} or ${(spreadPct * 100).toFixed(2)}% of spot.`,
      action: "REVIEW BOOK",
      target: "orderbook-panel",
    });
  }
  if (concentration > thresholds.concentration) {
    anomalies.push({
      severity: "warning",
      label: "Wallet concentration",
      text: "One local wallet holds most of the balance, which increases single-wallet exposure.",
      detail: `${(concentration * 100).toFixed(1)}% of holdings sit in one branch.`,
      action: "REVIEW PORTFOLIO",
      target: "portfolio-panel",
    });
  }
  if (liquidShare < 0.25 && totalHoldings > 0) {
    anomalies.push({
      severity: "warning",
      label: "Low available liquidity",
      text: "Most of the portfolio is reserved or committed, so large moves will require planning.",
      detail: `${(liquidShare * 100).toFixed(1)}% of holdings are immediately available.`,
      action: "TOP UP",
      target: "subwallet-panel",
    });
  }
  if (treasuryRatio < 0.2) {
    anomalies.push({
      severity: "warning",
      label: "Thin treasury buffer",
      text: "The treasury share of supply is low enough that big purchases should be staged carefully.",
      detail: `${(treasuryRatio * 100).toFixed(1)}% of max supply remains in treasury.`,
      action: "OPEN MARKET",
      target: "data-forecast-panel",
    });
  }
  if (riskyPeers.length) {
    anomalies.push({
      severity: "warning",
      label: "Risky counterparties active",
      text: "A flagged counterparty is present in the current relationship graph.",
      detail: `${riskyPeers.length} risky peer${riskyPeers.length === 1 ? "" : "s"} · ${watchedPeers.length} watched.`,
      action: "REVIEW WATCHLIST",
      target: "watchlist-panel",
    });
  }
  if (recent.length >= Math.min(8, dataSignalConfig.forecastHorizon)) {
    const first = recent[0];
    const last = recent[recent.length - 1];
    const drift = first ? ((last - first) / first) * 100 : 0;
    if (Math.abs(drift) > thresholds.drift) {
      anomalies.push({
        severity: drift > 0 ? "good" : "warning",
        label: drift > 0 ? "Rapid price expansion" : "Rapid price compression",
        text: "Recent pricing moved fast enough that execution assumptions should be rechecked.",
        detail: `${Math.abs(drift).toFixed(1)}% move across the latest sample window.`,
        action: "REVIEW FORECAST",
        target: "data-forecast-panel",
      });
    }
  }
  const severityScore = anomalies.reduce((score, item) => score + (item.severity === "critical" ? 3 : item.severity === "warning" ? 2 : 1), 0);
  const grade = !anomalies.length ? "CLEAR" : severityScore >= 8 ? "ELEVATED" : severityScore >= 4 ? "WATCH" : "NOTICE";
  const confidence = Math.max(25, Math.min(98, Math.round(anomalies.length * 14 + (status.chainValid ? 10 : 0) + (pressure > 0.75 ? 12 : 0) + (spreadPct > 0.03 ? 8 : 0) + (concentration > 0.6 ? 8 : 0))));
  note.textContent = anomalies.length
    ? `${anomalies.length} unusual signal${anomalies.length === 1 ? "" : "s"} need a second look.`
    : "No unusual signals are currently visible across the market, wallet, or counterparty graph.";
  countNode.textContent = String(anomalies.length);
  countNote.textContent = anomalies.length ? "Detected in the current live window." : "Nothing material stands out right now.";
  gradeNode.textContent = grade;
  gradeNote.textContent = anomalies.length ? "Severity is weighted by operational impact." : "The review is clean.";
  confidenceNode.textContent = `${confidence}%`;
  confidenceNote.textContent = anomalies.length ? "Confidence increases as more independent signals agree." : "Confidence is low because there is nothing to confirm.";
  list.innerHTML = anomalies.length ? anomalies.slice(0, 6).map((item, index) => `
    <article class="data-anomaly-item ${item.severity}">
      <span>${escapeHtml(String(index + 1))}</span>
      <div>
        <b>${escapeHtml(item.label)}</b>
        <p>${escapeHtml(item.text)}</p>
        <small>${escapeHtml(item.detail)}</small>
      </div>
      <button type="button" data-data-anomaly-target="${escapeHtml(item.target)}">${escapeHtml(item.action)}</button>
    </article>
  `).join("") : '<p class="empty">No anomalies have been identified yet.</p>';
  panel.classList.toggle("warning", anomalies.some((item) => item.severity === "critical" || item.severity === "warning"));
  for (const anomaly of anomalies.slice(0, 4)) {
    pushDataSignal({
      kind: "anomaly",
      severity: anomaly.severity,
      label: anomaly.label,
      text: anomaly.text,
      detail: anomaly.detail,
      action: anomaly.action,
      target: anomaly.target,
    });
  }
}

function renderDataIntelligence(market, status, blocks, priceValues) {
  const healthScore = computeSystemHealth(status, market, blocks);
  const momentum = summarizeMomentum(priceValues);
  const regime = analyzeMarketRegime(market, status, priceValues);
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
  $("#data-mode").textContent = `${regime.label} · ${regime.confidence}`;
  $("#data-block-eta").textContent = eta === "—" ? "—" : `~ ${eta}`;
  $("#data-block-note").textContent = eta === "—" ? "Awaiting the next seal." : `Estimated next seal in ${eta}.`;
  $("#data-recommendation").textContent = `${regime.note} ${recommendation}`;
  renderDataBrief(market, status, blocks, priceValues);
  renderDataForecast(market, status, priceValues);
  renderDataAnomalies(market, status, blocks, priceValues);
  renderDataSignals();
  renderDataActions(market, status, momentum, regime, pressure, healthScore);
  renderMarketAlerts(market);
}

function renderDataActions(market, status, momentum, regime, pressure, healthScore) {
  const list = $("#data-actions");
  if (!list) return;
  const actions = [];
  const branchEntries = portfolioEntries.length ? portfolioEntries : [];
  const childBranches = branchEntries.filter((entry) => entry.wallet.parentAddress);
  const rootBranches = branchEntries.filter((entry) => !entry.wallet.parentAddress);
  const totalHoldings = branchEntries.reduce((sum, entry) => sum + Math.max(0, Number(entry.holdings || 0)), 0);
  const treasuryShare = totalHoldings ? Number(market.treasuryBalance || 0) / totalHoldings : 0;
  const availableShare = totalHoldings ? branchEntries.reduce((sum, entry) => sum + Math.max(0, Number(entry.availableBalance || 0)), 0) / totalHoldings : 0;
  const concentration = totalHoldings && branchEntries.length ? Math.max(...branchEntries.map((entry) => Math.max(0, Number(entry.holdings || 0)))) / totalHoldings : 0;
  const latestTrend = summarizeActivityTrend(walletActivity);
  const latestForecast = summarizeActivityForecast(walletActivity);
  const urgentBranch = [...childBranches].sort((a, b) => {
    const aDeficit = Math.max(0, estimateSubwalletReserve(a) - Number(a.availableBalance || 0));
    const bDeficit = Math.max(0, estimateSubwalletReserve(b) - Number(b.availableBalance || 0));
    return bDeficit - aDeficit || a.wallet.name.localeCompare(b.wallet.name);
  })[0];

  if (pressure > 0.75) {
    actions.push({
      tone: "warning",
      title: "Tight network conditions",
      text: "Use the wallet fee tools before signing urgent transfers so the queue does not punish the draft.",
      detail: `${Math.round(pressure * 100)}% mempool pressure is elevated right now.`,
      label: "OPEN WALLET",
      action: () => document.querySelector('[data-view="wallet"]')?.click(),
    });
  }

  if (momentum.delta > 2 || regime.label === "BULLISH") {
    actions.push({
      tone: "good",
      title: "Positive market momentum",
      text: "Stagger any new buys or use limits instead of crossing the spread aggressively.",
      detail: `${momentum.label} price movement with ${regime.confidence.toLowerCase()} confidence.`,
      label: "OPEN ORDER BOOK",
      action: () => {
        document.querySelector('[data-view="data"]')?.click();
        $("#orderbook-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
      },
    });
  } else if ((market.spreadMicroUsd ?? 0) / 1_000_000 > 0.02) {
    actions.push({
      tone: "warning",
      title: "Wide spread detected",
      text: "The book is thin enough that a limit order is the safer default.",
      detail: `Current spread is ${usd((market.spreadMicroUsd || 0) / 1_000_000, 6)}.`,
      label: "REVIEW BOOK",
      action: () => $("#orderbook-panel")?.scrollIntoView({ behavior: "smooth", block: "start" }),
    });
  }

  if (latestForecast.pressure >= 0.4) {
    actions.push({
      tone: latestForecast.tone || "good",
      title: "Forward liquidity pressure",
      text: "Your recent activity suggests a week-ahead balance check before the next large send.",
      detail: `Projected balance ${format(latestForecast.projectedBalance)} EC under current pacing.`,
      label: "REVIEW ACTIVITY",
      action: () => $("#activity-panel")?.scrollIntoView({ behavior: "smooth", block: "start" }),
    });
  }

  if (concentration > 0.6 || latestTrend.label === "ACCELERATING") {
    actions.push({
      tone: concentration > 0.6 ? "warning" : latestTrend.tone || "good",
      title: "Branch concentration or acceleration",
      text: "The hierarchy would benefit from a quick allocation review or branch top-up check.",
      detail: concentration > 0.6
        ? `${(concentration * 100).toFixed(1)}% of holdings sit in one wallet.`
        : latestTrend.note,
      label: "REVIEW SUBWALLETS",
      action: () => $("#subwallet-panel")?.scrollIntoView({ behavior: "smooth", block: "start" }),
    });
  }

  if (healthScore < 65) {
    actions.push({
      tone: "warning",
      title: "System health needs attention",
      text: "The ledger, treasury, or activity mix could use a sanity check before the next bigger move.",
      detail: `Health score is ${healthScore}/100 and available share is ${(availableShare * 100).toFixed(1)}%.`,
      label: "OPEN PORTFOLIO",
      action: () => $("#portfolio-panel")?.scrollIntoView({ behavior: "smooth", block: "start" }),
    });
  }

  if (!actions.length) {
    actions.push({
      tone: "good",
      title: "No urgent actions",
      text: "The system looks balanced, so the best move is usually to stay disciplined and keep monitoring.",
      detail: `Treasury share ${(treasuryShare * 100).toFixed(1)}% · ${rootBranches.length} roots · ${childBranches.length} subwallets.`,
      label: "OPEN MARKET",
      action: () => $("#orderbook-panel")?.scrollIntoView({ behavior: "smooth", block: "start" }),
    });
  }

  list.innerHTML = actions.slice(0, 4).map((item, index) => `
    <article class="data-action ${item.tone}">
      <div>
        <b>${escapeHtml(item.title)}</b>
        <p>${escapeHtml(item.text)}</p>
        <small>${escapeHtml(item.detail)}</small>
      </div>
      <button type="button" data-data-action="${index}">${escapeHtml(item.label)}</button>
    </article>
  `).join("");
  list.dataset.actions = JSON.stringify(actions.map((item) => item.label));
  list._actions = actions;
}

function forecastPlanCommitments(now, endAt) {
  const events = [];
  for (const plan of paymentPlans) {
    if (plan.paused) continue;
    let dueAt = Math.max(now, Number(plan.nextRunAt) || now);
    let occurrence = 0;
    while (dueAt <= endAt && occurrence < 366) {
      events.push({ dueAt, amount:Number(plan.amount) || 0, name:plan.name || "Payment plan" });
      occurrence++;
      if (plan.cadence === "once") break;
      dueAt += cadenceToMs(plan.cadence);
    }
  }
  return events.sort((a, b) => a.dueAt - b.dueAt);
}

function historicalDailyOutflow(now = Date.now()) {
  const cutoff = now - 30 * 24 * 60 * 60_000;
  const outgoing = walletActivity.filter((tx) => tx.from === wallet.address && tx.settledAt >= cutoff && tx.type === "transfer");
  if (!outgoing.length) return { daily:0, count:0, total:0 };
  const total = outgoing.reduce((sum, tx) => sum + Number(tx.amount || 0) + Number(tx.fee || 0), 0);
  const oldest = Math.min(...outgoing.map((tx) => tx.settledAt));
  const observedDays = Math.max(7, Math.min(30, (now - oldest) / (24 * 60 * 60_000)));
  return { daily:total / observedDays, count:outgoing.length, total };
}

function buildStressProjection() {
  return buildStressProjectionFromScenario(stressScenario);
}

function buildStressProjectionFromScenario(scenario = stressScenario) {
  const now = Date.now();
  const horizonMs = scenario.horizonDays * 24 * 60 * 60_000;
  const endAt = now + horizonMs;
  const available = Number(currentAccount.availableBalance || 0);
  const planEvents = forecastPlanCommitments(now, endAt);
  const planAmount = planEvents.reduce((sum, event) => sum + event.amount, 0);
  const planFees = planEvents.length * Math.max(1_000, Number(feeQuote.standard) || activeFee);
  const history = historicalDailyOutflow(now);
  const behaviorSpend = scenario.includeHistory ? history.daily * scenario.horizonDays : 0;
  const extraSpend = scenario.extraSpendEc * SCALE;
  const contractEvents = contractTimelineRows(currentContracts).filter((row) => row.direction === "incoming" && row.dueAt >= now && row.dueAt <= endAt && row.contract.contractType !== "hashlock");
  const contractInflow = contractEvents.reduce((sum, row) => sum + row.amount, 0);
  const conditionalInflow = contractTimelineRows(currentContracts).filter((row) => row.direction === "incoming" && row.dueAt >= now && row.dueAt <= endAt && row.contract.contractType === "hashlock").reduce((sum, row) => sum + row.amount, 0);
  const commitments = planAmount + planFees + behaviorSpend + extraSpend;
  const projected = available + contractInflow - commitments;
  const coverage = commitments > 0 ? (available + contractInflow) / commitments : Infinity;
  const dailyBurn = (planAmount + planFees + behaviorSpend + extraSpend) / Math.max(1, scenario.horizonDays);
  const runwayDays = dailyBurn > 0 ? (available + contractInflow) / dailyBurn : Infinity;
  const stressedPrice = Math.max(0, Number(marketData?.priceUsd || 0) * (1 + scenario.priceShockPct / 100));
  let score = 100;
  if (projected < 0) score -= Math.min(70, 45 + Math.abs(projected) / Math.max(available, SCALE) * 25);
  else if (coverage < 1.25) score -= 35;
  else if (coverage < 2) score -= 18;
  if (scenario.priceShockPct <= -50) score -= 10;
  if (conditionalInflow > available * .25) score -= 8;
  if (planEvents.length > 12) score -= 5;
  score = Math.max(0, Math.min(100, Math.round(score)));
  const recommendedReserve = Math.max(5 * SCALE, history.daily * 7, planEvents.filter((event) => event.dueAt <= now + 30 * 24 * 60 * 60_000).reduce((sum, event) => sum + event.amount, 0) + Math.min(planFees, 30 * Math.max(1_000, Number(feeQuote.standard) || activeFee)));
  const steps = Array.from({ length:13 }, (_, index) => {
    const ratio = index / 12;
    const at = now + horizonMs * ratio;
    const plansDue = planEvents.filter((event) => event.dueAt <= at).reduce((sum, event) => sum + event.amount + Math.max(1_000, Number(feeQuote.standard) || activeFee), 0);
    const inflowDue = contractEvents.filter((event) => event.dueAt <= at).reduce((sum, event) => sum + event.amount, 0);
    return available + inflowDue - plansDue - behaviorSpend * ratio - extraSpend * ratio;
  });
  return { available, planEvents, planAmount, planFees, history, behaviorSpend, extraSpend, contractEvents, contractInflow, conditionalInflow, commitments, projected, coverage, runwayDays, stressedPrice, score, recommendedReserve, steps };
}

function applyStressPreset(name) {
  const presets = {
    calm: { horizonDays: 30, priceShockPct: -10, extraSpendEc: 0, includeHistory: false },
    selloff: { horizonDays: 30, priceShockPct: -45, extraSpendEc: 0, includeHistory: true },
    "fee-spike": { horizonDays: 14, priceShockPct: -20, extraSpendEc: 0, includeHistory: true, sensitivity: "tight" },
    "treasury-drain": { horizonDays: 90, priceShockPct: -25, extraSpendEc: 15, includeHistory: true },
  };
  const preset = presets[name];
  if (!preset) return;
  stressScenario = {
    horizonDays: preset.horizonDays,
    priceShockPct: preset.priceShockPct,
    extraSpendEc: preset.extraSpendEc,
    includeHistory: preset.includeHistory,
  };
  if (preset.sensitivity) dataSignalConfig.sensitivity = preset.sensitivity;
  saveStressScenario();
  renderStressLab();
  renderDataSignals();
}

function saveStressScenarioTemplate(name) {
  const normalized = name.trim();
  if (!normalized) throw new Error("Template name cannot be blank");
  const existing = stressScenarioTemplates.find((item) => item.name.toLowerCase() === normalized.toLowerCase());
  const template = {
    id: existing?.id ?? crypto.randomUUID(),
    name: normalized,
    scenario: { ...stressScenario },
    createdAt: existing?.createdAt ?? Date.now(),
    uses: existing?.uses ?? 0,
  };
  stressScenarioTemplates = existing
    ? stressScenarioTemplates.map((item) => item.id === existing.id ? template : item)
    : [template, ...stressScenarioTemplates];
  saveStressScenarioTemplates();
  renderStressLab();
}

function applyStressScenarioTemplate(templateId) {
  const template = stressScenarioTemplates.find((item) => item.id === templateId);
  if (!template) return;
  stressScenario = { ...template.scenario };
  template.uses = (template.uses || 0) + 1;
  stressScenarioTemplates = stressScenarioTemplates.map((item) => item.id === template.id ? template : item);
  saveStressScenarioTemplates();
  saveStressScenario();
  renderStressLab();
  renderDataSignals();
}

function deleteStressScenarioTemplate(templateId) {
  stressScenarioTemplates = stressScenarioTemplates.filter((item) => item.id !== templateId);
  saveStressScenarioTemplates();
  renderStressLab();
}

function renderStressLab() {
  if (!$("#stress-chart") || !wallet || !marketData) return;
  $("#stress-horizon").value = String(stressScenario.horizonDays);
  $("#stress-price-shock").value = String(stressScenario.priceShockPct);
  $("#stress-extra-spend").value = String(stressScenario.extraSpendEc);
  $("#stress-use-history").checked = stressScenario.includeHistory;
  const templateName = $("#stress-template-name");
  const templateList = $("#stress-template-list");
  const result = buildStressProjection();
  const baseline = buildStressProjectionFromScenario({ ...stressScenario, priceShockPct: 0 });
  stressRecommendedReserve = result.recommendedReserve;
  const grade = result.score >= 85 ? "RESILIENT" : result.score >= 65 ? "STABLE" : result.score >= 40 ? "EXPOSED" : "AT RISK";
  const usd = (value) => value.toLocaleString(undefined, { style:"currency", currency:"USD", maximumFractionDigits:2 });
  $("#stress-projected").textContent = `${result.projected < 0 ? "−" : ""}${format(Math.abs(result.projected))} EC`;
  $("#stress-projected-usd").textContent = `${usd(Math.max(0, result.projected / SCALE) * result.stressedPrice)} at stressed price`;
  $("#stress-commitments").textContent = `${format(result.commitments)} EC`;
  $("#stress-commitment-count").textContent = `${result.planEvents.length} planned payment${result.planEvents.length === 1 ? "" : "s"} · ${result.contractEvents.length} expected inflow${result.contractEvents.length === 1 ? "" : "s"}`;
  $("#stress-coverage").textContent = Number.isFinite(result.coverage) ? `${result.coverage.toFixed(2)}×` : "NO OUTFLOW";
  $("#stress-runway").textContent = Number.isFinite(result.runwayDays) ? `${Math.floor(result.runwayDays)} day runway` : "No modeled burn";
  $("#stress-score").textContent = `${result.score}/100`;
  $("#stress-grade").textContent = `${grade} · ${stressScenario.priceShockPct >= 0 ? "+" : ""}${stressScenario.priceShockPct}% price case`;
  const scenarioName = stressScenario.priceShockPct <= -40
    ? "SEVERE SELLOFF"
    : stressScenario.priceShockPct <= -20
      ? "DOWNTURN"
      : stressScenario.priceShockPct >= 20
        ? "RALLY"
        : "BASELINE";
  const response = result.score >= 85
    ? "Maintain discipline and keep the reserve floor intact."
    : result.score >= 65
      ? "Trim optional outflows and preserve slack."
      : result.score >= 40
        ? "Pause discretionary sends and rebalance locally."
        : "Reduce commitments or add liquidity before signing new moves.";
  $("#stress-scenario-name").textContent = scenarioName;
  $("#stress-scenario-note").textContent = stressScenario.includeHistory ? "Includes recent spending pace and live commitments." : "Excludes recent spending pace to isolate the shock.";
  $("#stress-scenario-move").textContent = result.projected < 0 ? "DEFICIT" : "SURPLUS";
  $("#stress-scenario-move-note").textContent = `${result.projected < 0 ? "Short by" : "Leaves"} ${format(Math.abs(result.projected))} EC after modeled obligations.`;
  $("#stress-scenario-response").textContent = result.score >= 65 ? "STAY DISCIPLINED" : "REDUCE EXPOSURE";
  $("#stress-scenario-response-note").textContent = response;
  const liquidDelta = result.projected - baseline.projected;
  const resilienceDelta = result.score - baseline.score;
  const runwayDelta = Number.isFinite(result.runwayDays) && Number.isFinite(baseline.runwayDays) ? result.runwayDays - baseline.runwayDays : 0;
  $("#stress-compare-liquid").textContent = `${liquidDelta >= 0 ? "+" : ""}${format(liquidDelta)} EC`;
  $("#stress-compare-liquid-note").textContent = `Baseline: ${format(baseline.projected)} EC · scenario: ${format(result.projected)} EC.`;
  $("#stress-compare-resilience").textContent = `${resilienceDelta >= 0 ? "+" : ""}${resilienceDelta}/100`;
  $("#stress-compare-resilience-note").textContent = `Baseline score ${baseline.score}/100 → scenario ${result.score}/100.`;
  $("#stress-compare-runway").textContent = Number.isFinite(runwayDelta) ? `${runwayDelta >= 0 ? "+" : ""}${Math.floor(runwayDelta)} days` : "—";
  $("#stress-compare-runway-note").textContent = Number.isFinite(baseline.runwayDays) && Number.isFinite(result.runwayDays)
    ? `Baseline ${Math.floor(baseline.runwayDays)} days vs scenario ${Math.floor(result.runwayDays)} days.`
    : "Runway comparison unavailable for this scenario.";
  if (templateList) {
    templateList.innerHTML = stressScenarioTemplates.length ? stressScenarioTemplates.map((item) => {
      const scenarioLabel = item.scenario.priceShockPct <= -40 ? "SEVERE SELLOFF" : item.scenario.priceShockPct <= -20 ? "DOWNTURN" : item.scenario.priceShockPct >= 20 ? "RALLY" : "BASELINE";
      return `<article class="stress-template-item">
        <div>
          <b>${escapeHtml(item.name)}</b>
          <p>${escapeHtml(`${scenarioLabel} · ${item.scenario.horizonDays}d horizon · ${item.scenario.priceShockPct >= 0 ? "+" : ""}${item.scenario.priceShockPct}% shock`)}</p>
          <small>${escapeHtml(item.scenario.includeHistory ? "Includes recent spending pace." : "Excludes recent spending pace.")} · ${escapeHtml(String(item.uses || 0))} uses</small>
        </div>
        <div class="stress-template-actions">
          <button type="button" data-stress-template-apply="${escapeHtml(item.id)}">APPLY</button>
          <button type="button" data-stress-template-delete="${escapeHtml(item.id)}">DELETE</button>
        </div>
      </article>`;
    }).join("") : '<p class="empty">No templates saved yet.</p>';
  }
  const min = Math.min(0, ...result.steps);
  const max = Math.max(SCALE, ...result.steps);
  const range = max - min || SCALE;
  const coords = result.steps.map((value, index) => [28 + index * 704 / 12, 190 - (value - min) / range * 150]);
  const line = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const path = coords.map(([x, y], index) => `${index ? "L" : "M"} ${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const zeroY = 190 - (0 - min) / range * 150;
  $("#stress-chart polyline").setAttribute("points", line);
  $("#stress-chart .area").setAttribute("d", `${path} L 732 190 L 28 190 Z`);
  $("#stress-chart .chart-gridlines").innerHTML = `<line x1="28" y1="40" x2="732" y2="40"></line><line x1="28" y1="115" x2="732" y2="115"></line><line class="zero" x1="28" y1="${zeroY.toFixed(1)}" x2="732" y2="${zeroY.toFixed(1)}"></line>`;
  $("#stress-chart .stress-markers").innerHTML = `<text x="28" y="210">TODAY</text><text x="732" y="210" text-anchor="end">${stressScenario.horizonDays} DAYS</text><text x="36" y="34">${escapeHtml(format(max))} EC</text>`;
  const findings = [];
  findings.push({ tone:result.projected < 0 ? "warning" : "good", title:result.projected < 0 ? "Liquidity deficit" : "Liquidity survives", text:result.projected < 0 ? `The scenario is short by ${format(Math.abs(result.projected))} EC.` : `${format(result.projected)} EC remains liquid after modeled obligations.` });
  if (result.planEvents.length) findings.push({ tone:result.planAmount > result.available * .5 ? "warning" : "neutral", title:"Scheduled commitments", text:`${result.planEvents.length} payment occurrence${result.planEvents.length === 1 ? "" : "s"} require ${format(result.planAmount + result.planFees)} EC including forecast fees.` });
  if (stressScenario.includeHistory) findings.push({ tone:result.history.daily * 30 > result.available ? "warning" : "neutral", title:"Behavioral baseline", text:`Recent transfer behavior implies about ${format(result.history.daily)} EC of daily outflow from ${result.history.count} settled send${result.history.count === 1 ? "" : "s"}.` });
  if (result.contractInflow) findings.push({ tone:"good", title:"Deterministic inflows", text:`${format(result.contractInflow)} EC is expected from timelock or vesting releases inside the horizon.` });
  if (result.conditionalInflow) findings.push({ tone:"warning", title:"Conditional value excluded", text:`${format(result.conditionalInflow)} EC in hashlock value is not counted because a secret claim or refund can change the outcome.` });
  $("#stress-findings").innerHTML = findings.map((item) => `<article class="stress-finding ${item.tone}"><b>${escapeHtml(item.title)}</b><p>${escapeHtml(item.text)}</p></article>`).join("");
  $("#stress-guidance").textContent = result.score >= 85 ? `This wallet can absorb the selected scenario. A ${format(result.recommendedReserve)} EC guard reserve would protect near-term obligations.` : result.score >= 55 ? `The wallet remains usable, but coverage is thin. Preserve at least ${format(result.recommendedReserve)} EC and review upcoming plans.` : `The scenario produces material liquidity risk. Reduce commitments, add funding, or shorten the forecast before signing new transfers.`;
  $("#stress-apply-reserve").disabled = !Number.isFinite(result.recommendedReserve) || result.recommendedReserve <= 0;
  $(".stress-lab-panel").classList.toggle("warning", result.score < 55);
  if (result.score < 55) {
    pushDataSignal({
      kind: "scenario",
      severity: "warning",
      label: `${scenarioName} risk`,
      text: `Stress score dropped to ${result.score}/100 under the selected scenario.`,
      detail: response,
      action: "REVIEW STRESS LAB",
      target: "stress-lab-panel",
    });
  }
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
  recordSecurityEvent("session_policy", "Session timer updated", `Auto-lock is now set to ${sessionSecurity.timeoutMinutes ? `${sessionSecurity.timeoutMinutes} minutes` : "off"}.`, sessionSecurity.timeoutMinutes ? "good" : "warning");
});
$("#lock-when-hidden").addEventListener("change", (event) => {
  sessionSecurity.lockWhenHidden = event.target.checked;
  saveSessionSecurity(); renderSessionSecurity(); toast(event.target.checked ? "Hidden-app locking enabled" : "Hidden-app locking disabled");
  recordSecurityEvent("session_policy", "Hidden lock preference changed", event.target.checked ? "The vault will lock when the app is hidden." : "The vault will stay unlocked when the app is hidden.", event.target.checked ? "good" : "warning");
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
  loadLearnProgress();
  loadDataSignals();
  loadStressScenarioTemplates();
  loadSecurityJournal();
  loadRecentTransfers(); loadTransferTemplates(); loadWalletHistory(); loadPaymentPlans(); loadPaymentRequests(); loadTransactionGuard(); loadActivityRules(); loadStressScenario();
  showWallet();
  $("#send-form").reset();
  $("#batch-input").value=""; batchDraft=[];
  renderRecentTransfers(); renderTransferTemplates(); renderWalletHistory(); renderWalletDiagnostics(); renderPaymentPlans(); renderPaymentRequests(); renderTransactionGuardSettings();
  portfolioUpdatedAt = 0;
  recordSecurityEvent("wallet_switched", "Wallet opened", `Switched to ${wallet.name}.`, "info");
  await refresh();
}

$("#wallet-picker").addEventListener("change",async(event)=>{
  await activateWallet(event.target.value); toast(`Switched to ${wallet.name}`);
});
$("#wallet-list").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-wallet-send]");
  if (!button) return;
  try {
    await loadWalletRecipient(button.dataset.walletSend);
  } catch (error) {
    toast(error.message, true);
  }
});
$("#wallet-tree").addEventListener("click", async (event) => {
  const openButton = event.target.closest("[data-wallet-open]");
  const sendButton = event.target.closest("[data-wallet-send]");
  const transferButton = event.target.closest("[data-wallet-transfer]");
  try {
    if (openButton) {
      await activateWallet(openButton.dataset.walletOpen);
      renderWallets();
      toast(`Opened ${wallet.name}`);
      return;
    }
    if (sendButton) {
      await loadWalletRecipient(sendButton.dataset.walletSend);
      return;
    }
    if (transferButton) {
      await loadWalletTransfer(transferButton.dataset.walletTransfer, Number(transferButton.dataset.walletTransferAmount || 0));
    }
  } catch (error) {
    toast(error.message, true);
  }
});
$("#subwallet-allocator-list").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-subwallet-topup-parent]");
  if (!button) return;
  try {
    await prepareSubwalletTopUp(button.dataset.subwalletTopupParent, button.dataset.subwalletTopupChild, Number(button.dataset.subwalletTopupAmount || 0));
  } catch (error) {
    toast(error.message, true);
  }
});
$("#subwallet-trend-list").addEventListener("click", async (event) => {
  const topUpButton = event.target.closest("[data-subwallet-topup-parent]");
  const openButton = event.target.closest("[data-wallet-open]");
  try {
    if (topUpButton) {
      await prepareSubwalletTopUp(topUpButton.dataset.subwalletTopupParent, topUpButton.dataset.subwalletTopupChild, Number(topUpButton.dataset.subwalletTopupAmount || 0));
      return;
    }
    if (openButton) {
      await activateWallet(openButton.dataset.walletOpen);
      renderWallets();
      toast(`Opened ${wallet.name}`);
    }
  } catch (error) {
    toast(error.message, true);
  }
});
$("#open-wallet-manager").addEventListener("click",()=>{
  $("#wallet-name").value="";
  $("#wallet-is-subwallet").checked = wallets.length > 0;
  renderWallets();
  $("#wallet-overlay").hidden=false;
  $("#wallet-name").focus();
});
$("#close-wallet-manager").addEventListener("click",closeWalletManager);
$("#wallet-form").addEventListener("submit",async(event)=>{
  event.preventDefault(); const button=event.currentTarget.querySelector("button"); const name=$("#wallet-name").value.trim();
  if (!name) return toast("Wallet name cannot be blank",true);
  if (vaultState === "locked") return toast("Unlock the vault before creating another wallet", true);
  setBusy(button,true);
  try {
    const parentAddress = $("#wallet-is-subwallet").checked ? wallet?.address ?? null : null;
    const rootAddress = parentAddress ? (wallet?.rootAddress ?? wallet?.address) : null;
    wallet=await createWallet(name, { kind: parentAddress ? "subwallet" : "wallet", parentAddress, rootAddress });
    wallets.push(wallet);
    portfolioUpdatedAt=0;
    await saveWallets();
    renderWallets();
    loadSecurityJournal();
    loadRecentTransfers();
    loadTransferTemplates();
    loadWalletHistory();
    loadPaymentPlans();
    loadPaymentRequests();
    loadTransactionGuard();
    loadActivityRules();
    loadStressScenario();
    showWallet();
    renderRecentTransfers();
    renderTransferTemplates();
    renderWalletHistory();
    renderWalletDiagnostics();
    renderPaymentPlans();
    renderPaymentRequests();
    renderTransactionGuardSettings();
    closeWalletManager();
    recordSecurityEvent(parentAddress ? "subwallet_created" : "wallet_created", parentAddress ? "Subwallet created" : "Wallet created", `${name} was generated locally with a new Ed25519 keypair.${parentAddress ? ` It is a child of ${walletParentName(wallet) || "the active wallet"}.` : ""}`, "good");
    await refresh();
    toast(`${name} created locally${parentAddress ? " as a subwallet" : ""}`);
  }
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
      loadActivityRules();
      loadStressScenario();
      showWallet();
      recordSecurityEvent("vault_enabled", "Vault enabled", "Local private keys are now encrypted in this browser.", "good");
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
    loadActivityRules();
    loadStressScenario();
    showWallet();
    closeVaultDialog();
    await refresh();
    recordSecurityEvent("vault_unlocked", "Vault unlocked", "Signing access was restored in this browser session.", "good");
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
  try { await api("/faucet", { method:"POST", body:JSON.stringify({ address:wallet.address }) }); setBusy(button, false); await refresh(); recordSecurityEvent("faucet_claimed", "Faucet received", "Test funds were credited from the treasury faucet.", "good"); toast("25 test EC received"); }
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
    $("#buy-overlay").hidden=true; await refresh(); recordSecurityEvent("market_purchase", "Treasury purchase settled", `${format(result.transaction.amount)} EC was bought from the genesis treasury for $${(usdCents/100).toFixed(2)}.`, "good"); toast(`Treasury purchase settled: ${format(result.transaction.amount)} EC`);
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
$("#activity-rule-large-transfer")?.addEventListener("change", (event) => {
  walletActivityRules.largeTransferEc = Math.max(0.1, Number(event.target.value) || 10);
  saveActivityRules();
  renderWalletActivity();
});
$("#activity-rule-burst-count")?.addEventListener("change", (event) => {
  walletActivityRules.burstCount = Math.max(2, Math.round(Number(event.target.value) || 4));
  saveActivityRules();
  renderWalletActivity();
});
$("#activity-rule-burst-window")?.addEventListener("change", (event) => {
  walletActivityRules.burstWindowHours = Math.min(168, Math.max(1, Number(event.target.value) || 24));
  saveActivityRules();
  renderWalletActivity();
});
$("#activity-rule-watch-new")?.addEventListener("change", (event) => {
  walletActivityRules.watchNewCounterparties = event.target.checked;
  saveActivityRules();
  renderWalletActivity();
});
$("#activity-rule-watch-top")?.addEventListener("change", (event) => {
  walletActivityRules.watchTopCounterparties = event.target.checked;
  saveActivityRules();
  renderWalletActivity();
});
$("#activity-filter")?.addEventListener("change", (event) => {
  walletActivityFilter = event.target.value || "all";
  renderWalletActivity();
  toast(`Activity filter set to ${walletActivityFilter}`);
});
$("#activity-search")?.addEventListener("input", (event) => {
  walletActivityQuery = event.target.value.trim();
  renderWalletActivity();
});
$("#activity-from")?.addEventListener("change", (event) => {
  walletActivityFrom = event.target.value;
  renderWalletActivity();
});
$("#activity-to")?.addEventListener("change", (event) => {
  walletActivityTo = event.target.value;
  renderWalletActivity();
});
$("#activity-intel-seed")?.addEventListener("click", async () => {
  try {
    const added = seedWatchlistFromCounterparties(currentAccount);
    renderWatchlist(currentAccount);
    await refreshWatchlist(currentAccount);
    toast(added ? `${added} counterparties added to watchlist` : "No new counterparties to seed");
  } catch (error) {
    toast(error.message, true);
  }
});
$("#activity-intel-list")?.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-activity-action]");
  if (!button) return;
  const action = button.dataset.activityAction;
  const value = button.dataset.activityActionValue || "";
  if (action === "watch-address" && value) {
    try {
      const added = addWatchAddress(value);
      renderWatchlist(currentAccount);
      await refreshWatchlist(currentAccount);
      toast(added ? "Address added to watchlist" : "Address is already on the watchlist");
    } catch (error) {
      toast(error.message, true);
    }
    return;
  }
  if (action === "seed-counterparties") {
    try {
      const added = seedWatchlistFromCounterparties(currentAccount);
      renderWatchlist(currentAccount);
      await refreshWatchlist(currentAccount);
      toast(added ? `${added} counterparties added to watchlist` : "No new counterparties to seed");
    } catch (error) {
      toast(error.message, true);
    }
    return;
  }
  if (action === "scroll-watchlist") {
    document.querySelector('[data-view="data"]').click();
    setTimeout(() => $("#watchlist-address")?.scrollIntoView({ behavior: "smooth", block: "center" }), 150);
    toast("Jumped to watchlist");
  }
});
$("#counterparty-list")?.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-counterparty-action]");
  if (!button) return;
  const address = button.dataset.counterpartyAddress || "";
  try {
    if (button.dataset.counterpartyAction === "watch") {
      const added = addWatchAddress(address);
      renderWatchlist(currentAccount);
      await refreshWatchlist(currentAccount);
      toast(added ? "Address added to watchlist" : "Address is already on the watchlist");
      return;
    }
    if (button.dataset.counterpartyAction === "contact") {
      const name = button.dataset.counterpartyName || short(address, 10);
      upsertContact(address, name);
      toast("Contact saved");
      return;
    }
    if (button.dataset.counterpartyAction === "copy") {
      await navigator.clipboard.writeText(address);
      toast("Address copied");
    }
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
for (const id of ["rebalance-strategy", "rebalance-floor", "rebalance-buffer", "rebalance-minimum", "rebalance-treasury"]) {
  $("#" + id)?.addEventListener(id === "rebalance-strategy" || id === "rebalance-treasury" ? "change" : "input", () => {
    rebalanceConfig = {
      strategy:$("#rebalance-strategy").value === "floor" ? "floor" : "equal",
      floorEc:Math.max(0, Number($("#rebalance-floor").value) || 0),
      bufferEc:Math.max(0, Number($("#rebalance-buffer").value) || 0),
      minimumEc:Math.max(.000001, Number($("#rebalance-minimum").value) || .000001),
      includeTreasury:$("#rebalance-treasury").checked,
    };
    saveRebalanceConfig();
    renderRebalancePlanner();
  });
}
$("#rebalance-list")?.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-rebalance-load]");
  if (!button) return;
  try { await loadRebalanceMove(rebalancePlan[Number(button.dataset.rebalanceLoad)]); }
  catch (error) { toast(error.message, true); }
});
$("#rebalance-load-next")?.addEventListener("click", async () => {
  try { await loadRebalanceMove(rebalancePlan[0]); }
  catch (error) { toast(error.message, true); }
});
$("#rebalance-copy")?.addEventListener("click", async () => {
  if (!rebalancePlan.length) return;
  const lines = ["E-Coin portfolio rebalance plan", ...rebalancePlan.map((move, index) => `${index + 1}. ${move.fromName} (${move.from}) -> ${move.toName} (${move.to}): ${(move.amount / SCALE).toFixed(6)} EC + ${(move.fee / SCALE).toFixed(6)} EC fee`)];
  await navigator.clipboard.writeText(lines.join("\n"));
  toast("Rebalance plan copied");
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
$("#data-actions").addEventListener("click", (event) => {
  const button = event.target.closest("[data-data-action]");
  if (!button) return;
  const actions = $("#data-actions")._actions || [];
  const action = actions[Number(button.dataset.dataAction)];
  if (!action) return;
  action.action?.();
  toast(action.title);
});
$("#data-brief").addEventListener("click", (event) => {
  const button = event.target.closest("[data-data-brief-target]");
  if (!button) return;
  const targetId = button.dataset.dataBriefTarget;
  const target = document.getElementById(targetId);
  if (!target) return;
  if (targetId === "portfolio-panel" || targetId === "watchlist-panel" || targetId === "security-center") {
    document.querySelector('[data-view="wallet"]')?.click();
  } else {
    document.querySelector('[data-view="data"]')?.click();
  }
  requestAnimationFrame(() => target.scrollIntoView({ behavior: "smooth", block: "start" }));
});
["#data-signal-sensitivity", "#data-signal-forecast", "#data-signal-limit"].forEach((selector) => {
  $(selector)?.addEventListener("change", () => {
    dataSignalConfig.sensitivity = $("#data-signal-sensitivity")?.value || "balanced";
    dataSignalConfig.forecastHorizon = Number($("#data-signal-forecast")?.value || 12);
    dataSignalConfig.feedLimit = Number($("#data-signal-limit")?.value || 8);
    dataSignalFeed = dataSignalFeed.slice(0, dataSignalConfig.feedLimit);
    saveDataSignals();
    renderDataSignals();
    const priceValues = marketData ? (marketData.history?.length ? marketData.history : [{ priceMicroUsd: marketData.priceMicroUsd || 0 }]).map((entry) => Number(entry.priceMicroUsd || 0) / 1_000_000) : [];
    renderDataIntelligence(marketData, currentStatus, loadedBlocks, priceValues);
  });
});
$("#data-signal-feed").addEventListener("click", (event) => {
  const button = event.target.closest("[data-data-signal-target]");
  if (!button) return;
  const target = document.getElementById(button.dataset.dataSignalTarget || "");
  if (!target) return;
  const view = target.closest(".data-view") ? "data" : "wallet";
  document.querySelector(`[data-view="${view}"]`)?.click();
  requestAnimationFrame(() => target.scrollIntoView({ behavior: "smooth", block: "start" }));
});
$("#data-anomaly-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-data-anomaly-target]");
  if (!button) return;
  const target = document.getElementById(button.dataset.dataAnomalyTarget || "");
  if (!target) return;
  const view = target.closest(".data-view") ? "data" : "wallet";
  document.querySelector(`[data-view="${view}"]`)?.click();
  requestAnimationFrame(() => target.scrollIntoView({ behavior: "smooth", block: "start" }));
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
$("#order-side").addEventListener("change", () => renderOrderAssistant(marketData));
$("#order-amount").addEventListener("input", () => renderOrderAssistant(marketData));
$("#order-price").addEventListener("input", () => renderOrderAssistant(marketData));
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
for (const id of ["stress-horizon", "stress-price-shock", "stress-extra-spend", "stress-use-history"]) {
  $("#" + id)?.addEventListener(id === "stress-use-history" ? "change" : "input", () => {
    stressScenario = {
      horizonDays:Number($("#stress-horizon").value) || 30,
      priceShockPct:Math.max(-95, Math.min(300, Number($("#stress-price-shock").value) || 0)),
      extraSpendEc:Math.max(0, Number($("#stress-extra-spend").value) || 0),
      includeHistory:$("#stress-use-history").checked,
    };
    saveStressScenario();
    renderStressLab();
  });
}
$("#stress-lab-panel")?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-stress-preset]");
  if (!button) return;
  applyStressPreset(button.dataset.stressPreset || "");
});
$("#stress-template-save")?.addEventListener("click", () => {
  try {
    saveStressScenarioTemplate($("#stress-template-name")?.value || "");
    if ($("#stress-template-name")) $("#stress-template-name").value = "";
    toast("Scenario template saved");
  } catch (error) {
    toast(error.message, true);
  }
});
$("#stress-template-list")?.addEventListener("click", (event) => {
  const applyButton = event.target.closest("[data-stress-template-apply]");
  const deleteButton = event.target.closest("[data-stress-template-delete]");
  if (applyButton) {
    applyStressScenarioTemplate(applyButton.dataset.stressTemplateApply || "");
    toast("Scenario template applied");
  }
  if (deleteButton) {
    deleteStressScenarioTemplate(deleteButton.dataset.stressTemplateDelete || "");
    toast("Scenario template removed");
  }
});
$("#stress-apply-reserve")?.addEventListener("click", () => {
  if (!Number.isFinite(stressRecommendedReserve) || stressRecommendedReserve <= 0) return;
  guardPolicy.reserve = Math.round(stressRecommendedReserve);
  saveTransactionGuard();
  renderTransactionGuardSettings();
  renderTransactionGuard();
  toast(`Transaction Guard reserve set to ${format(guardPolicy.reserve)} EC`);
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
$("#fee-apply-recommended")?.addEventListener("click", () => {
  const tier = recommendedFeeTier(Number(feeQuote.pressure) || 0);
  $("#fee-tier").value = tier;
  applyFeeTier();
  updateComposer();
  renderBatchComposer();
  renderFeeIntelligence();
  toast(`${tier.toUpperCase()} fee tier applied to new transfers`);
});
$("#save-guard").addEventListener("click", () => {
  const dailyLimit = Math.round(Number($("#guard-daily-limit").value) * SCALE);
  const reserve = Math.round(Number($("#guard-reserve").value) * SCALE);
  if (!Number.isSafeInteger(dailyLimit) || dailyLimit < 0 || !Number.isSafeInteger(reserve) || reserve < 0) return toast("Enter valid guard amounts", true);
  guardPolicy = { dailyLimit, reserve, knownOnly:$("#guard-known-only").checked };
  saveTransactionGuard();
  renderTransactionGuardSettings();
  updateComposer();
  recordSecurityEvent("guard_policy", "Transaction Guard saved", `Daily limit ${guardPolicy.dailyLimit ? format(guardPolicy.dailyLimit) : "off"} EC, reserve ${format(guardPolicy.reserve)} EC, known contacts only ${guardPolicy.knownOnly ? "on" : "off"}.`, "good");
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
    recordSecurityEvent("batch_signed", "Batch queued", `${result.queued} transfers were signed and queued together.`, "good");
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
function downloadJsonFile(value, filename) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type:"application/json" });
  const link = Object.assign(document.createElement("a"), { href:URL.createObjectURL(blob), download:filename });
  link.click();
  URL.revokeObjectURL(link.href);
}

function renderOfflineSigningStatus(stage, guidance, fingerprint = "") {
  offlineSigningStage = stage;
  const labels = { idle:"READY FOR A DRAFT", exported:"UNSIGNED DRAFT EXPORTED", signed:"SIGNED ENVELOPE EXPORTED", broadcast:"TRANSFER BROADCAST", error:"CHECK REQUIRED" };
  $("#offline-signing-status").textContent = labels[stage] || labels.idle;
  $("#offline-signing-guidance").textContent = guidance;
  $("#offline-signing-fingerprint").textContent = fingerprint ? `INTENT ${fingerprint.slice(0, 20).toUpperCase()}` : "NO ENVELOPE LOADED";
  $(".offline-signing-panel").classList.toggle("warning", stage === "error");
}

async function offlineIntentFingerprint(tx) {
  return sha256Text(canonicalTransaction(tx));
}

function buildRecoveryBundle() {
  return {
    version: 3,
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
    securityJournal,
    stressScenario,
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
    if (Array.isArray(imported.securityJournal)) {
      securityJournal = imported.securityJournal
        .filter((entry) => entry && typeof entry.type === "string" && typeof entry.title === "string" && Number.isFinite(Number(entry.timestamp)))
        .slice(0, 24);
    }
    if (imported.stressScenario && typeof imported.stressScenario === "object") {
      stressScenario = {
        horizonDays:[7,30,90,180].includes(Number(imported.stressScenario.horizonDays)) ? Number(imported.stressScenario.horizonDays) : 30,
        priceShockPct:Number.isFinite(Number(imported.stressScenario.priceShockPct)) ? Math.max(-95, Math.min(300, Number(imported.stressScenario.priceShockPct))) : -35,
        extraSpendEc:Math.max(0, Number(imported.stressScenario.extraSpendEc) || 0),
        includeHistory:imported.stressScenario.includeHistory !== false,
      };
    }
    await saveWallets(); localStorage.setItem(contactsKey,JSON.stringify(contacts)); saveRecentTransfers(); saveTransferTemplates(); savePaymentPlans(); savePaymentRequests(); saveWalletHistory(); saveTransactionGuard(); saveSpendJournal(); saveStressScenario(); saveStressScenarioTemplates(); saveDataSignals(); saveSecurityJournal();
    portfolioUpdatedAt=0; renderContacts(); renderRecentTransfers(); renderTransferTemplates(); renderPaymentPlans(); renderPaymentRequests(); renderWalletHistory(); renderWalletDiagnostics(); renderTransactionGuardSettings(); loadActivityRules(); loadStressScenario(); loadStressScenarioTemplates(); loadDataSignals(); renderSecurityCenter(); showWallet(); recordSecurityEvent("backup_imported", "Recovery imported", "An encrypted recovery bundle was opened and verified locally.", "good"); await refresh(); toast("Wallet imported");
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
      link.click(); URL.revokeObjectURL(link.href); recoveryAudit[wallet.address] = Date.now(); localStorage.setItem(recoveryAuditKey, JSON.stringify(recoveryAudit)); closeRecoveryDialog(); renderSessionSecurity(); recordSecurityEvent("backup_created", "Recovery bundle created", "An encrypted recovery file was exported for this wallet.", "good"); toast("Encrypted recovery bundle created");
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
$("#security-drill").addEventListener("click", () => {
  if (vaultState !== "unlocked") return toast("Unlock the vault before running a recovery drill", true);
  pendingRecoveryEnvelope = null;
  openRecoveryDialog("export");
  recordSecurityEvent("recovery_drill", "Recovery drill started", "Opened the encrypted backup workflow for this wallet.", "good");
  toast("Recovery drill opened");
});
$("#security-export").addEventListener("click", () => {
  downloadJsonFile(buildSecurityReport(), `ecoin-security-${wallet.address.slice(0, 10)}.json`);
  recordSecurityEvent("security_report", "Security report exported", "A local security posture report was downloaded from this wallet.", "good");
  toast("Security report exported");
});
$("#offline-export-draft").addEventListener("click", async () => {
  try {
    const amount = Math.round(Number($("#amount").value) * SCALE);
    const recipient = $("#recipient").value.trim();
    const tx = { from:wallet.address, to:recipient, amount, fee:activeFee, nonce:currentAccount.nextNonce, memo:$("#memo").value.trim(), timestamp:Date.now(), publicKey:wallet.publicKey };
    const guard = evaluateTransactionGuard(tx);
    if (guard.blocked) throw new Error("Transaction Guard blocked this offline draft");
    const envelope = createUnsignedTransferEnvelope(tx);
    const fingerprint = await offlineIntentFingerprint(tx);
    downloadJsonFile(envelope, `ecoin-unsigned-${wallet.address.slice(0, 10)}-${tx.nonce}.json`);
    renderOfflineSigningStatus("exported", `Unsigned intent exported for ${format(tx.amount)} EC to ${short(tx.to, 11)}. It expires in 30 minutes.`, fingerprint);
    toast("Unsigned transfer exported");
  } catch (error) {
    renderOfflineSigningStatus("error", error.message);
    toast(error.message, true);
  }
});
$("#offline-import-draft").addEventListener("change", async (event) => {
  try {
    if (vaultState === "locked") throw new Error("Unlock the vault before signing an offline draft");
    const envelope = JSON.parse(await event.target.files[0].text());
    const validation = validateUnsignedTransferEnvelope(envelope, { expectedFrom:wallet.address, expectedPublicKey:wallet.publicKey, expectedNonce:currentAccount.nextNonce, availableBalance:currentAccount.availableBalance, minFee:1_000 });
    if (!validation.valid) throw new Error(validation.errors[0]);
    const guard = evaluateTransactionGuard(validation.transaction);
    if (guard.blocked) throw new Error("Transaction Guard blocked this imported draft");
    const signature = await signTransaction(validation.transaction);
    const signed = createSignedTransferEnvelope(envelope, signature);
    const fingerprint = await offlineIntentFingerprint(validation.transaction);
    downloadJsonFile(signed, `ecoin-signed-${wallet.address.slice(0, 10)}-${validation.transaction.nonce}.json`);
    renderOfflineSigningStatus("signed", `Signature created locally for ${format(validation.transaction.amount)} EC. Move the signed envelope to an online E-Coin wallet for broadcast.`, fingerprint);
    toast("Offline transfer signed and exported");
  } catch (error) {
    renderOfflineSigningStatus("error", error.message);
    toast(error.message, true);
  }
  event.target.value = "";
});
$("#offline-import-signed").addEventListener("change", async (event) => {
  try {
    const envelope = JSON.parse(await event.target.files[0].text());
    const tx = envelope?.transaction;
    const account = tx?.from ? await api(`/accounts/${tx.from}`) : null;
    const validation = validateSignedTransferEnvelope(envelope, { expectedNonce:account?.nextNonce, availableBalance:account?.availableBalance, minFee:1_000 });
    if (!validation.valid) throw new Error(validation.errors[0]);
    const fingerprint = await offlineIntentFingerprint((({ signature:_signature, ...intent }) => intent)(validation.transaction));
    const result = await api("/transactions", { method:"POST", body:JSON.stringify(validation.transaction) });
    await refresh();
    renderOfflineSigningStatus("broadcast", `Signature accepted by the node and queued at position ${result.position}.`, fingerprint);
    toast(`Signed envelope queued at position ${result.position}`);
  } catch (error) {
    renderOfflineSigningStatus("error", error.message);
    toast(error.message, true);
  }
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
$("#contract-type").addEventListener("change",(event)=>{$("#vesting-fields").hidden=!["vesting","milestone"].includes(event.target.value);$("#hashlock-fields").hidden=event.target.value!=="hashlock";$("#unlock-field").hidden=event.target.value==="hashlock";updateContractPreview();});
for (const selector of ["#contract-beneficiary","#contract-amount","#contract-unlock","#contract-installments","#contract-interval","#contract-memo"]) $(selector).addEventListener("input",updateContractPreview);
$("#contract-secret").addEventListener("input",updateContractPreview);
$("#contract-refund").addEventListener("input",updateContractPreview);
async function updateContractPreview() {
  const version = ++contractSimulationVersion;
  const type=$("#contract-type").value;
  const amountEc=Number($("#contract-amount").value)||0;
  const amount=Math.round(amountEc*SCALE);
  const beneficiary=$("#contract-beneficiary").value.trim();
  const unlockTime=new Date($("#contract-unlock").value).getTime();
  const refundTime=new Date($("#contract-refund").value).getTime();
  const installments=["vesting","milestone"].includes(type)?Number($("#contract-installments").value)||0:1;
  const intervalMs=["vesting","milestone"].includes(type)?Number($("#contract-interval").value)||0:0;
  const secret=$("#contract-secret").value;
  const secretHash=secret?await sha256Text(secret):"";
  if (version !== contractSimulationVersion) return;
  $("#contract-secret-hash").textContent=secretHash||"ENTER A SECRET";
  const simulation=simulateContractDraft({ type,creator:wallet.address,beneficiary,amount,fee:activeFee,availableBalance:currentAccount.availableBalance,guardReserve:guardPolicy.reserve,unlockTime,installments,intervalMs,refundTime,hasSecret:Boolean(secret),secretLength:secret.length,knownBeneficiary:contacts.some((entry)=>entry.address===beneficiary),now:Date.now() });
  const perRelease=installments?amountEc/installments:0;
  const finalDate=Number.isFinite(simulation.effectiveEnd)&&simulation.effectiveEnd>0?new Date(simulation.effectiveEnd):null;
  $("#contract-preview").innerHTML=`<span>RELEASE PLAN</span><div><b>${type==="vesting"?`${installments} INSTALLMENTS`:type==="milestone"?`${installments} MILESTONES`:type==="hashlock"?"SECRET CLAIM / REFUND":"ONE RELEASE"}</b><strong>${perRelease>0?`${perRelease.toLocaleString(undefined,{maximumFractionDigits:6})} EC`:"ENTER AN AMOUNT"}</strong></div><small>${finalDate&&!Number.isNaN(finalDate.getTime())?(type==="hashlock"?`Beneficiary may claim before ${finalDate.toLocaleString()}; otherwise funds refund automatically.`:type==="milestone"?`Both creator and beneficiary must approve each milestone before ${finalDate.toLocaleString()}.`:`First release ${new Date(unlockTime).toLocaleString()} · final release ${finalDate.toLocaleString()}`):"Choose a valid release time."}</small>`;
  const state=simulation.blocked.length?"BLOCKED":simulation.risk>=60?"HIGH REVIEW":simulation.risk>=30?"REVIEW":"READY";
  $("#contract-simulation-state").textContent=state;
  $("#contract-simulation-risk").textContent=`${simulation.risk}/100`;
  $("#contract-simulation-after").textContent=simulation.afterBalance>=0?`${format(simulation.afterBalance)} EC`:"INSUFFICIENT";
  $("#contract-simulation-share").textContent=Number.isFinite(simulation.lockedShare)?`${(simulation.lockedShare*100).toFixed(1)}%`:"—";
  $("#contract-simulation-final").textContent=finalDate&&!Number.isNaN(finalDate.getTime())?formatPlanTime(simulation.effectiveEnd):"—";
  $("#contract-simulation-guidance").textContent=simulation.blocked.length?`${simulation.blocked.length} protocol or funding issue${simulation.blocked.length===1?"":"s"} must be resolved before signing.`:simulation.warnings.length?`The draft is deployable with ${simulation.warnings.length} attention item${simulation.warnings.length===1?"":"s"}. Review every cash flow and beneficiary detail.`:"The draft matches protocol limits and preserves the configured wallet reserve.";
  const signals=[...simulation.blocked.map((text)=>({tone:"warning",text})),...simulation.warnings.map((text)=>({tone:"warning",text}))];
  $("#contract-simulation-signals").innerHTML=signals.length?signals.map((item)=>`<div class="signal ${item.tone}">${escapeHtml(item.text)}</div>`).join(""):'<div class="signal">Protocol schedule, available balance, and reserve policy all pass.</div>';
  $("#contract-schedule-count").textContent=`${simulation.events.length} EVENT${simulation.events.length===1?"":"S"}`;
  $("#contract-schedule-preview").innerHTML=simulation.events.length?simulation.events.slice(0,8).map((event,index)=>`<div class="contract-schedule-row"><span>${index+1}</span><div><b>${escapeHtml(event.label)}</b><small>${escapeHtml(new Date(event.at).toLocaleString())}${event.conditional?" · CONDITIONAL":""}</small></div><strong>${escapeHtml(format(event.amount))} EC</strong></div>`).join("")+(simulation.events.length>8?`<p class="contract-schedule-more">+ ${simulation.events.length-8} additional events</p>`:""):'<p class="empty">No valid cash-flow schedule yet.</p>';
  $("#deploy-contract").disabled=!simulation.valid;
  $(".contract-simulation").classList.toggle("blocked",Boolean(simulation.blocked.length));
  $(".contract-simulation").classList.toggle("caution",!simulation.blocked.length&&simulation.warnings.length>0);
  $("#contract-warning").textContent=type==="hashlock"?"The claim secret becomes public when used. If it is not revealed before the deadline, funds return automatically to the creator.":type==="milestone"?"Each release needs both creator and beneficiary approval. If the schedule is delayed, funds remain locked until the next milestone is approved.":"Funds cannot be recovered early. The protocol releases them automatically according to the signed schedule.";
  if (simulation.valid) {
    const fingerprint=await sha256Text(JSON.stringify({type,creator:wallet.address,beneficiary,amount,fee:activeFee,unlockTime,installments,intervalMs,secretHash,refundTime,memo:$("#contract-memo").value.trim()}));
    if (version === contractSimulationVersion) $("#contract-simulation-id").textContent=`DRAFT ${fingerprint.slice(0,16).toUpperCase()}`;
  } else $("#contract-simulation-id").textContent="DRAFT NOT READY";
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
  const installments=["vesting","milestone"].includes(contractType)?Number($("#contract-installments").value):1;
  const intervalMs=["vesting","milestone"].includes(contractType)?Number($("#contract-interval").value):0;
    const secret=contractType==="hashlock"?$("#contract-secret").value:""; if(contractType==="hashlock"&&!secret) throw new Error("Enter a claim secret");
    const secretHash=secret?await sha256Text(secret):""; const refundTime=contractType==="hashlock"?new Date($("#contract-refund").value).getTime():0;
    const deployment={contractType,from:wallet.address,beneficiary:$("#contract-beneficiary").value.trim(),amount,fee:activeFee,nonce:currentAccount.nextNonce,unlockTime,installments,intervalMs,secretHash,refundTime,memo:$("#contract-memo").value.trim(),timestamp:Date.now(),publicKey:wallet.publicKey};
    deployment.signature=await signContract(deployment);
    const result=await api("/contracts",{method:"POST",body:JSON.stringify(deployment)});
    closeContract(); await refresh(); recordSecurityEvent("contract_deployed", "Contract deployed", `${contractType} contract queued at position ${result.position}.`, "good"); toast(`${contractType==="vesting"?"Vesting contract":contractType==="hashlock"?"Hashlock":"Timelock"} queued at position ${result.position}`);
  } catch(error){toast(error.message,true);} finally{setBusy(button,false);}
});
$("#contract-list").addEventListener("click",async(event)=>{
  const claimButton=event.target.closest("[data-claim]");
  if (claimButton) {
    $("#claim-form").reset(); $("#claim-address").value=claimButton.dataset.claim; $("#claim-overlay").hidden=false; $("#claim-secret").focus();
    return;
  }
  const approveButton=event.target.closest("[data-approve]");
  if (!approveButton) return;
  try {
    setBusy(approveButton, true);
    await approveMilestoneContract(approveButton.dataset.approve, approveButton.dataset.milestone);
  } catch (error) {
    toast(error.message, true);
  } finally {
    setBusy(approveButton, false);
  }
});
$("#contract-flow-filter").addEventListener("change", (event) => {
  contractFlowFilter = event.target.value;
  renderContractIntelligence();
});
$("#contract-timeline").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-contract-flow-claim]");
  if (button) {
    $("#claim-form").reset();
    $("#claim-address").value = button.dataset.contractFlowClaim;
    $("#claim-overlay").hidden = false;
    $("#claim-secret").focus();
    return;
  }
  const approve = event.target.closest("[data-contract-flow-approve]");
  if (!approve) return;
  try {
    setBusy(approve, true);
    await approveMilestoneContract(approve.dataset.contractFlowApprove, approve.dataset.contractFlowMilestone);
  } catch (error) {
    toast(error.message, true);
  } finally {
    setBusy(approve, false);
  }
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
  try { const address=$("#claim-address").value; await api(`/contracts/${address}/claim`,{method:"POST",body:JSON.stringify({secret:$("#claim-secret").value})}); closeClaim(); await refresh(); recordSecurityEvent("contract_claimed", "Hashlock claimed", `Secret escrow ${short(address, 10)} was settled to the beneficiary.`, "good"); toast("Hashlock claimed to its beneficiary"); }
  catch(error){toast(error.message,true);} finally{setBusy(button,false);}
});

$("#cancel-review").addEventListener("click", closeReview);
$("#edit-transfer").addEventListener("click", closeReview);
$("#close-receipt").addEventListener("click", closeReceipt);
$("#copy-receipt").addEventListener("click", async () => { await navigator.clipboard.writeText(receiptCopyValue); toast("Receipt ID copied"); });
$("#copy-verification").addEventListener("click", async () => { await navigator.clipboard.writeText(receiptVerificationReport || "No verification report is available"); toast("Verification report copied"); });
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
    recordSecurityEvent("transfer_signed", "Transfer queued", `${format(pendingDraft.amount)} EC was signed for ${short(pendingDraft.to, 10)}.`, "good");
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
  recordSecurityEvent("vault_locked", "Vault locked", "Private keys were sealed in the encrypted local vault.", "good");
}

function renderWallets() {
  const picker=$("#wallet-picker"); picker.innerHTML="";
  for (const candidate of wallets) { const option=document.createElement("option"); option.value=candidate.address; option.textContent=candidate.name; option.selected=candidate.address===wallet?.address; picker.append(option); }
  const subwalletCount = wallets.filter((candidate) => candidate.parentAddress).length;
  const rootCount = wallets.filter((candidate) => !candidate.parentAddress).length;
  const activeRoots = new Set(wallets.map((candidate) => candidate.rootAddress || candidate.address));
  $("#wallet-manager-summary").textContent = `${wallets.length} wallets total · ${rootCount} roots · ${subwalletCount} subwallets · ${activeRoots.size} lineage group${activeRoots.size === 1 ? "" : "s"}.`;
  renderWalletTree();
  $("#wallet-list").innerHTML=wallets.map((candidate)=>`<div class="contact-entry ${candidate.parentAddress ? "subwallet-entry" : ""}"><div><b>${escapeHtml(candidate.name)}</b><code>${escapeHtml(short(candidate.address,12))}</code><small>${escapeHtml(walletDisplayKind(candidate))}${candidate.parentAddress ? ` · child of ${escapeHtml(walletParentName(candidate) || "unknown")}` : ""}</small></div><span class="local-badge">${candidate.address===wallet?.address ? "ACTIVE" : vaultState === "locked" ? "LOCKED" : candidate.privateKey ? "LOCAL" : "ROSTER"}</span></div>`).join("");
  $("#vault-state").textContent = vaultState === "locked" ? "ENCRYPTED VAULT LOCKED" : vaultState === "unlocked" ? "ENCRYPTED VAULT UNLOCKED" : "LOCAL STORAGE";
  $("#vault-action").textContent = vaultState === "none" ? "ENABLE VAULT" : vaultState === "locked" ? "UNLOCK VAULT" : "LOCK VAULT";
}

function renderWalletTree() {
  const tree = $("#wallet-tree");
  const summary = $("#wallet-tree-summary");
  if (!tree || !summary) return;
  if (!wallets.length) {
    summary.textContent = "No wallets yet.";
    tree.innerHTML = '<div class="wallet-tree-empty">Create a wallet to begin the hierarchy.</div>';
    return;
  }
  const roots = wallets.filter((candidate) => !candidate.parentAddress);
  const childrenByParent = new Map();
  for (const candidate of wallets.filter((entry) => entry.parentAddress)) {
    const parentKey = candidate.parentAddress || candidate.rootAddress || "unlinked";
    const list = childrenByParent.get(parentKey) || [];
    list.push(candidate);
    childrenByParent.set(parentKey, list);
  }
  const groupCount = new Set(wallets.map((candidate) => candidate.rootAddress || candidate.address)).size;
  const accountFor = (address) => portfolioEntries.find((entry) => entry.wallet.address === address)?.account ?? (address === wallet?.address ? currentAccount : null);
  const sumDescendants = (node) => {
    const account = accountFor(node.address);
    const ownBalance = Number(account?.balance || 0);
    const ownAvailable = Number(account?.availableBalance || 0);
    const descendants = childrenByParent.get(node.address) || [];
    const childTotals = descendants.reduce((acc, child) => {
      const next = sumDescendants(child);
      acc.holdings += next.holdings;
      acc.available += next.available;
      acc.count += 1 + next.count;
      return acc;
    }, { holdings: 0, available: 0, count: 0 });
    return { holdings: ownBalance + childTotals.holdings, available: ownAvailable + childTotals.available, count: childTotals.count, account };
  };
  const renderBranch = (node, depth = 0) => {
    const totals = sumDescendants(node);
    const descendants = childrenByParent.get(node.address) || [];
    return `<article class="wallet-branch ${node.address === wallet?.address ? "active" : ""}" data-depth="${depth}" style="margin-left:${depth * 14}px">
      <div class="wallet-branch-head">
        <div>
          <b>${escapeHtml(node.name)}</b>
          <code>${escapeHtml(short(node.address, 12))}</code>
          <small>${escapeHtml(walletDisplayKind(node))}${node.parentAddress ? ` · child of ${escapeHtml(walletParentName(node) || "unknown")}` : ""} · ${escapeHtml(format(totals.holdings))} EC rollup${totals.count ? ` · ${totals.count} descendant${totals.count === 1 ? "" : "s"}` : ""}</small>
        </div>
        <div class="wallet-branch-actions">
          <button type="button" data-wallet-open="${escapeHtml(node.address)}">OPEN</button>
          <button type="button" data-wallet-send="${escapeHtml(node.address)}">LOAD SEND</button>
        </div>
      </div>
      ${descendants.length ? `<div class="wallet-branch-children">${descendants.map((child) => {
        const childAccount = accountFor(child.address);
        const childDefaultAmount = childAccount ? Math.max(SCALE, Math.floor(Math.max(0, Number(childAccount.availableBalance || 0)) * 0.1)) : SCALE;
        return `<div class="wallet-child">
          <div>
            <b>${escapeHtml(child.name)}</b>
            <code>${escapeHtml(short(child.address, 12))}</code>
            <small>${escapeHtml(walletDisplayKind(child))} · child of ${escapeHtml(node.name)}</small>
          </div>
          <button type="button" data-wallet-transfer="${escapeHtml(child.address)}" data-wallet-transfer-amount="${escapeHtml(String(childDefaultAmount / SCALE))}">MOVE 10%</button>
        </div>`;
      }).join("")}</div>` : `<div class="wallet-tree-empty">No subwallets yet.</div>`}
    </article>`;
  };
  summary.textContent = `${roots.length} root wallet${roots.length === 1 ? "" : "s"} across ${groupCount} group${groupCount === 1 ? "" : "s"} · ${format(wallets.reduce((sum, candidate) => sum + Number(accountFor(candidate.address)?.balance || 0), 0))} EC tracked.`;
  tree.innerHTML = roots.length ? roots.map((root) => renderBranch(root)).join("") : '<div class="wallet-tree-empty">Create a wallet to begin the hierarchy.</div>';
}

async function loadWalletRecipient(address) {
  const target = wallets.find((candidate) => candidate.address === address);
  if (!target) throw new Error("Wallet not found");
  $("#recipient").value = target.address;
  updateComposer();
  document.querySelector('[data-view="wallet"]').click();
  closeWalletManager();
  $("#send-form").scrollIntoView({ behavior: "smooth", block: "start" });
  toast(`Loaded ${target.name} as the send recipient`);
}

async function loadWalletTransfer(address, amountEc = null) {
  const target = wallets.find((candidate) => candidate.address === address);
  if (!target) throw new Error("Wallet not found");
  const suggestedAmount = Number.isFinite(Number(amountEc)) ? Number(amountEc) : null;
  $("#recipient").value = target.address;
  if (suggestedAmount && suggestedAmount > 0) $("#amount").value = suggestedAmount.toFixed(6);
  updateComposer();
  document.querySelector('[data-view="wallet"]').click();
  closeWalletManager();
  $("#send-form").scrollIntoView({ behavior: "smooth", block: "start" });
  toast(`Prepared transfer to ${target.name}`);
}

async function prepareSubwalletTopUp(parentAddress, childAddress, amountEc) {
  const parent = wallets.find((candidate) => candidate.address === parentAddress);
  const child = wallets.find((candidate) => candidate.address === childAddress);
  if (!parent || !child) throw new Error("Subwallet route not found");
  await activateWallet(parent.address);
  $("#recipient").value = child.address;
  if (Number.isFinite(Number(amountEc)) && Number(amountEc) > 0) $("#amount").value = Number(amountEc).toFixed(6);
  $("#memo").value = `Top-up ${child.name}`.slice(0, 96);
  updateComposer();
  document.querySelector('[data-view="wallet"]').click();
  closeWalletManager();
  $("#send-form").scrollIntoView({ behavior: "smooth", block: "start" });
  toast(`Prepared top-up from ${parent.name} to ${child.name}`);
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
  const previousBlock = block.height > 0 ? await api(`/blocks/${block.height - 1}`) : null;
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
  try {
    const verification = await verifySettlementReceipt(block, previousBlock, 0);
    const passed = verification.checks.filter((check) => check.status === "pass").length;
    $("#receipt-verification-state").textContent = verification.verified ? "VERIFIED LOCALLY" : "CHECK FAILED";
    $("#receipt-verification-score").textContent = `${passed} / ${verification.checks.length} CHECKS`;
    $("#receipt-verification-list").innerHTML = verification.checks.map((check) => `<article class="receipt-check ${escapeHtml(check.status)}"><span>${check.status === "pass" ? "✓" : "!"}</span><div><b>${escapeHtml(check.label)}</b><p>${escapeHtml(check.detail)}</p></div></article>`).join("");
    $(".receipt-verification").classList.toggle("warning", !verification.verified);
    $(".receipt-status").classList.toggle("warning", !verification.verified);
    $(".receipt-status span").textContent = verification.verified ? "SETTLED / LOCALLY VERIFIED" : "SETTLED / VERIFICATION WARNING";
    receiptVerificationReport = [`E-Coin settlement verification`, `Block: #${block.height}`, `Block hash: ${block.hash}`, `Transaction: ${receiptCopyValue}`, `Result: ${verification.verified ? "VERIFIED" : "FAILED"}`, ...verification.checks.map((check) => `${check.status.toUpperCase()}: ${check.label} — ${check.detail}`)].join("\n");
  } catch (error) {
    $("#receipt-verification-state").textContent = "UNAVAILABLE";
    $("#receipt-verification-score").textContent = "0 / 0 CHECKS";
    $("#receipt-verification-list").innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`;
    $(".receipt-verification").classList.add("warning");
    $(".receipt-status").classList.add("warning");
    $(".receipt-status span").textContent = "SETTLED / VERIFICATION UNAVAILABLE";
    receiptVerificationReport = `E-Coin settlement verification unavailable: ${error.message}`;
  }
  $("#receipt-overlay").hidden=false; $("#close-receipt").focus();
}

function showWallet() { $("#address").textContent = wallet.address; $("#address").title = wallet.address; renderWallets(); renderRecentTransfers(); renderTransferTemplates(); renderPaymentPlans(); renderPaymentRequests(); renderReceivePanel(); renderSessionSecurity(); renderSecurityCenter(); renderActivityIntelligence(walletActivity); }
async function sha256Text(value) { const digest=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value))); return [...digest].map((byte)=>byte.toString(16).padStart(2,"0")).join(""); }
function fromBase64Url(value) { const base64=value.replace(/-/g,"+").replace(/_/g,"/").padEnd(Math.ceil(value.length/4)*4,"="); return Uint8Array.from(atob(base64), (c)=>c.charCodeAt(0)); }
function toBase64Url(bytes) { return btoa(String.fromCharCode(...bytes)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,""); }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]); }

const learnTopics = {
  overview: {
    focus: "Protocol",
    risk: "LOW",
    nextStep: "Read the summary and move to the quiz",
    summary: "E-Coin uses a fixed supply, committed ledger history, and deterministic settlement rules. The fastest way to get comfortable is to learn the flow from wallet creation to signed transfer to block confirmation.",
    checklist: [
      { tone: "good", title: "Trace one transaction end-to-end", text: "Follow a transfer from draft to signature to confirmed receipt so the lifecycle becomes familiar." },
      { tone: "", title: "Watch supply and treasury flow", text: "Remember that circulating coins come from the treasury, and fees recycle back into it." },
      { tone: "good", title: "Use the local Data tab", text: "The market, activity, and subwallet views are there to help you reason before you sign." },
    ],
  },
  wallet: {
    focus: "Safety",
    risk: "MEDIUM",
    nextStep: "Open Security Center and review the vault",
    summary: "Wallet safety is mostly operational discipline: encrypt the vault, use a long password, verify the recipient, and keep a recovery copy offline. Most losses come from urgency and mistakes, not protocol failure.",
    checklist: [
      { tone: "warning", title: "Keep the vault locked by default", text: "Only unlock long enough to sign, then relock before switching tasks." },
      { tone: "good", title: "Compare address prefixes and suffixes", text: "Human verification catches clipboard swaps and typo attacks quickly." },
      { tone: "warning", title: "Never share a seed phrase", text: "No legitimate workflow will ask you to reveal your private recovery material." },
    ],
  },
  contracts: {
    focus: "Smart contracts",
    risk: "MEDIUM",
    nextStep: "Experiment with a small test contract first",
    summary: "E-Coin contracts are deterministic cash-flow tools. Timelocks, vesting, milestone approvals, and hashlocks all have explicit settlement rules that replay the same way every time.",
    checklist: [
      { tone: "good", title: "Match contract type to the job", text: "Use timelocks for delayed release, vesting for schedules, milestone for approvals, and hashlocks for secrets." },
      { tone: "", title: "Model the unlock path", text: "Before signing, know exactly what must happen for funds to move or refund." },
      { tone: "warning", title: "Test with a smaller amount first", text: "A contract that behaves correctly with a tiny amount is easier to trust at scale." },
    ],
  },
  market: {
    focus: "Execution",
    risk: "MEDIUM",
    nextStep: "Review the order book and execution forecast",
    summary: "Market behavior depends on spread, depth, pressure, and your chosen side. Smart execution is usually about patience and sizing, not urgency.",
    checklist: [
      { tone: "good", title: "Prefer limit orders in thin books", text: "A tight limit protects you from paying too much spread." },
      { tone: "", title: "Use the execution forecast", text: "Check fill percentage and impact before placing a large trade." },
      { tone: "warning", title: "Stagger larger orders", text: "Breaking a big order into smaller pieces often improves average price and reduces slippage." },
    ],
  },
  regulation: {
    focus: "Compliance",
    risk: "HIGH",
    nextStep: "Read local rules before any real-world deployment",
    summary: "Real crypto products can invoke payments, custody, AML/KYC, sanctions, tax, consumer protection, and licensing rules depending on jurisdiction and how the product is marketed or operated. This devnet is educational, but production behavior needs legal review.",
    checklist: [
      { tone: "warning", title: "Treat jurisdiction as a design input", text: "The rules can change by country, state, and product structure." },
      { tone: "good", title: "Separate devnet from production", text: "A sandbox can teach the mechanics without handling real customer funds." },
      { tone: "warning", title: "Get counsel early", text: "If you plan to custody, exchange, or market value transfer, compliance should be part of the architecture." },
    ],
  },
  offline: {
    focus: "Operational security",
    risk: "HIGH",
    nextStep: "Try offline signing on a small transfer",
    summary: "Offline signing reduces exposure by separating intent creation, signing, and broadcast. It is one of the strongest ways to protect high-value wallets from a compromised online machine.",
    checklist: [
      { tone: "good", title: "Verify the fingerprint on both devices", text: "Recipient, amount, fee, and expiry must match before you sign." },
      { tone: "warning", title: "Keep private keys off the online device", text: "Only the unsigned intent and final signed envelope should cross that boundary." },
      { tone: "good", title: "Use short-lived envelopes", text: "Short expiries reduce the window where a leaked transfer could still be used." },
    ],
  },
};

function renderLearnLab() {
  const topicKey = $("#learn-topic")?.value || "overview";
  const topic = learnTopics[topicKey] || learnTopics.overview;
  const summaryNode = $("#learn-lab-summary");
  const checklistNode = $("#learn-lab-checklist");
  if (!summaryNode || !checklistNode) return;
  const walletRisk = vaultState === "locked" ? "MEDIUM" : vaultState === "none" ? "HIGH" : "LOW";
  const walletRiskNote = vaultState === "locked"
    ? "Your wallet is protected, but you still need to unlock intentionally when signing."
    : vaultState === "none"
      ? "The vault is not enabled yet, so the safest next step is to encrypt it."
      : "The vault is available, so keep your active session short and deliberate.";
  $("#learn-focus").textContent = topic.focus;
  $("#learn-focus-note").textContent = `${topicKey === "overview" ? "A quick orientation for new users." : "Topic-specific guidance with practical examples."}`;
  $("#learn-risk").textContent = topic.risk;
  $("#learn-risk-note").textContent = `${walletRisk} current wallet posture · ${walletRiskNote}`;
  $("#learn-next-step").textContent = topic.nextStep;
  $("#learn-next-step-note").textContent = topicKey === "market"
    ? `${marketData?.openOrders ?? 0} open orders and ${feeQuote.pressure ? `${Math.round((feeQuote.pressure || 0) * 100)}% mempool pressure` : "live fee data"} are already visible in the app.`
    : topicKey === "wallet"
      ? `${securityJournal.length} local security event${securityJournal.length === 1 ? "" : "s"} are currently recorded.`
      : "Use the quiz below to test the idea immediately.";
  summaryNode.textContent = topic.summary;
  checklistNode.innerHTML = topic.checklist.map((item, index) => `
    <article class="learn-lab-item ${item.tone}">
      <span>${index + 1}</span>
      <div>
        <b>${escapeHtml(item.title)}</b>
        <p>${escapeHtml(item.text)}</p>
      </div>
    </article>
  `).join("");
  recordLearnProgress(topicKey);
  renderLearnProgress();
  renderLearnScenario();
}

const learnScenarios = {
  wallet_locked: {
    risk: "HIGH",
    practice: "Unlock intentionally, sign the transfer, then relock immediately.",
    reason: "A locked vault protects keys, but signing should still be a deliberate, time-boxed action.",
    tip: "If the vault is locked and you need to send now, the right sequence is to unlock only after confirming the recipient and amount.",
  },
  wide_spread: {
    risk: "MEDIUM",
    practice: "Use a limit order near the best bid or ask and avoid crossing a wide spread unless speed matters.",
    reason: "Wide spreads usually mean thin liquidity, so patience preserves price quality.",
    tip: "The order book in this app already shows best bid, ask, spread, and an execution forecast to help you choose.",
  },
  stale_backup: {
    risk: "HIGH",
    practice: "Create a fresh encrypted recovery bundle before moving larger balances.",
    reason: "Backups age out just like passwords and session timers; fresh recovery copies reduce operational risk.",
    tip: "If the backup is older than 30 days, treat it like a warning light instead of a checkbox task.",
  },
  risky_counterparty: {
    risk: "MEDIUM",
    practice: "Watch the address first, then classify it after you have more settled history.",
    reason: "New counterparties are not automatically dangerous, but they deserve a slower trust ramp.",
    tip: "Use the watchlist to keep a low-friction record of behavior instead of relying on memory.",
  },
  rebalance_needed: {
    risk: "LOW-MEDIUM",
    practice: "Separate operating funds from reserve funds and top up the branch that actually spends.",
    reason: "A concentrated portfolio is harder to reason about and easier to drain by accident.",
    tip: "The portfolio outlook and rebalancer already show when the allocation is too concentrated.",
  },
};

function loadLearnProgress() {
  try {
    learnProgressByWallet = JSON.parse(localStorage.getItem(learnProgressKey) || "{}") || {};
  } catch {
    learnProgressByWallet = {};
  }
  const stored = learnProgressByWallet[wallet?.address] || {};
  learnProgress = {
    visits: Math.max(0, Number(stored.visits) || 0),
    bestQuiz: Math.max(0, Number(stored.bestQuiz) || 0),
    topicCounts: stored.topicCounts && typeof stored.topicCounts === "object" ? stored.topicCounts : {},
    lastTopic: typeof stored.lastTopic === "string" ? stored.lastTopic : "overview",
  };
}

function saveLearnProgress() {
  if (!wallet?.address) return;
  learnProgressByWallet[wallet.address] = learnProgress;
  localStorage.setItem(learnProgressKey, JSON.stringify(learnProgressByWallet));
}

function recordLearnProgress(topicKey) {
  if (!wallet?.address) return;
  learnProgress.visits += 1;
  learnProgress.lastTopic = topicKey;
  learnProgress.topicCounts[topicKey] = (learnProgress.topicCounts[topicKey] || 0) + 1;
  saveLearnProgress();
}

function renderLearnProgress() {
  const topicsCovered = $("#learn-topics-covered");
  const bestQuiz = $("#learn-best-quiz");
  const visits = $("#learn-visits");
  const currentPath = $("#learn-current-path");
  if (!topicsCovered || !bestQuiz || !visits || !currentPath) return;
  const mastered = Object.entries(learnProgress.topicCounts || {}).filter(([, count]) => count > 0).length;
  const best = learnProgress.bestQuiz || 0;
  const topicLabel = learnProgress.lastTopic ? String(learnProgress.lastTopic).replaceAll("_", " ").toUpperCase() : "OVERVIEW";
  topicsCovered.textContent = String(mastered);
  bestQuiz.textContent = `${best} / ${quiz.length}`;
  visits.textContent = String(learnProgress.visits);
  currentPath.textContent = topicLabel;
  $("#learn-progress-note").textContent = mastered
    ? `${mastered} topic${mastered === 1 ? "" : "s"} have been explored in this wallet.`
    : "Start with the overview and build from there.";
}

function renderLearnScenario() {
  const key = $("#learn-scenario")?.value || "wallet_locked";
  const scenario = learnScenarios[key] || learnScenarios.wallet_locked;
  const riskNode = $("#learn-sim-risk");
  const practiceNode = $("#learn-sim-practice");
  const reasonNode = $("#learn-sim-reason");
  const tipNode = $("#learn-simulator-tip");
  if (!riskNode || !practiceNode || !reasonNode || !tipNode) return;
  riskNode.textContent = scenario.risk;
  $("#learn-sim-risk-note").textContent = scenario.tip;
  practiceNode.textContent = scenario.practice;
  $("#learn-sim-practice-note").textContent = "A practical action you can take inside this wallet.";
  reasonNode.textContent = scenario.reason;
  $("#learn-sim-reason-note").textContent = key === "wide_spread"
    ? `${marketData?.openOrders ?? 0} open orders and current spread data support this advice.`
    : key === "rebalance_needed"
      ? `${portfolioEntries.length} local wallet${portfolioEntries.length === 1 ? "" : "s"} are available for allocation planning.`
      : "The lesson is grounded in the current app state and wallet controls.";
  tipNode.textContent = scenario.tip;
}

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
  learnProgress.bestQuiz = Math.max(learnProgress.bestQuiz || 0, quizScore);
  saveLearnProgress();
  renderLearnProgress();
  $("#quiz-score").textContent=`SCORE ${quizScore}`;
  setTimeout(()=>{ if (quizIndex===quiz.length-1) { toast(`Knowledge check complete: ${quizScore}/${quiz.length}`); quizIndex=0; quizScore=0; } else quizIndex++; renderQuiz(); },900);
});
$("#learn-topic")?.addEventListener("change", renderLearnLab);
$("#learn-scenario")?.addEventListener("change", renderLearnScenario);
document.querySelectorAll(".nav-link").forEach((button)=>button.addEventListener("click",()=>{
  const view=button.dataset.view; $("#wallet-view").hidden=view!=="wallet"; $("#learn-view").hidden=view!=="learn"; $("#data-view").hidden=view!=="data";
  document.querySelectorAll(".nav-link").forEach((item)=>item.classList.toggle("active",item===button));
  history.replaceState(null,"",`#${view}`); window.scrollTo({top:0,behavior:"smooth"});
}));
renderQuiz();
loadLearnProgress();
renderLearnLab();

try { contacts=(JSON.parse(localStorage.getItem(contactsKey)) || []).filter((contact)=>contact && typeof contact.name==="string" && /^ec1[0-9a-f]{38}$/.test(contact.address)); loadWatchlist(); loadWatchlistSnapshot(); loadMarketAlerts(); loadSessionSecurity(); loadRebalanceConfig(); renderContacts(); await loadWallets(); loadRecentTransfers(); loadTransferTemplates(); loadWalletHistory(); loadPaymentPlans(); loadPaymentRequests(); loadTransactionGuard(); loadActivityRules(); loadStressScenario(); loadStressScenarioTemplates(); loadDataSignals(); await ensureTreasuryWallet(); showWallet(); $("#send-form").reset(); renderWatchlist(currentAccount); renderRecentTransfers(); renderTransferTemplates(); renderWalletHistory(); renderWalletDiagnostics(); renderPaymentPlans(); renderPaymentRequests(); renderTransactionGuardSettings(); renderSessionSecurity(); renderActivityIntelligence(walletActivity); await refresh(); const initialView=["#learn","#data"].includes(location.hash)?location.hash.slice(1):"wallet"; document.querySelector(`[data-view="${initialView}"]`).click(); connectEventStream(); setInterval(updateBlockClock,250); setInterval(checkSessionSecurity,1_000); setInterval(() => refresh().catch(()=>{}), 15_000); }
catch (error) { $("#address").textContent = "Wallet unavailable"; toast(error.message, true); }
