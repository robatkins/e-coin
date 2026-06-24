const DAY_MS = 24 * 60 * 60_000;
const ADDRESS_RE = /^ec1[0-9a-f]{38}$/;

export function simulateContractDraft(input) {
  const now = Number(input.now) || Date.now();
  const type = input.type;
  const amount = Math.floor(Number(input.amount) || 0);
  const fee = Math.max(0, Math.floor(Number(input.fee) || 0));
  const available = Math.max(0, Math.floor(Number(input.availableBalance) || 0));
  const reserve = Math.max(0, Math.floor(Number(input.guardReserve) || 0));
  const installments = ["vesting", "milestone"].includes(type) ? Math.floor(Number(input.installments) || 0) : 1;
  const intervalMs = ["vesting", "milestone"].includes(type) ? Math.floor(Number(input.intervalMs) || 0) : 0;
  const unlockTime = Number(input.unlockTime) || 0;
  const refundTime = Number(input.refundTime) || 0;
  const beneficiary = String(input.beneficiary || "");
  const blocked = [];
  const warnings = [];
  if (!["timelock", "vesting", "milestone", "hashlock"].includes(type)) blocked.push("Choose a supported contract template.");
  if (!ADDRESS_RE.test(beneficiary)) blocked.push("Enter a valid E-Coin beneficiary address.");
  if (beneficiary && beneficiary === input.creator) blocked.push("The beneficiary must be a different wallet.");
  if (!Number.isSafeInteger(amount) || amount <= 0) blocked.push("Enter a positive contract amount.");
  if (amount + fee > available) blocked.push("Amount plus fee exceeds available balance.");
  if (type === "timelock" && (unlockTime < now + 5_000 || unlockTime > now + 365 * DAY_MS)) blocked.push("Timelock release must be between five seconds and one year from now.");
  if (type === "vesting" || type === "milestone") {
    if (installments < 2 || installments > 52) blocked.push("Vesting requires 2 to 52 installments.");
    if (intervalMs < 60_000 || intervalMs > 90 * DAY_MS) blocked.push("Vesting intervals must be between one minute and 90 days.");
    if (unlockTime < now + 5_000 || unlockTime + Math.max(0, installments - 1) * intervalMs > now + 2 * 365 * DAY_MS) blocked.push("Vesting must start in the future and finish within two years.");
  }
  if (type === "hashlock") {
    if (!input.hasSecret) blocked.push("Enter a claim secret before deployment.");
    if (refundTime < now + 60_000 || refundTime > now + 30 * DAY_MS) blocked.push("Hashlock refund must be between one minute and 30 days from now.");
    if ((Number(input.secretLength) || 0) > 0 && Number(input.secretLength) < 16) warnings.push("Use a longer, randomly generated claim secret.");
  }
  const afterBalance = available - amount - fee;
  const lockedShare = available > 0 ? amount / available : 0;
  const effectiveEnd = type === "hashlock" ? refundTime : unlockTime + Math.max(0, installments - 1) * intervalMs;
  const durationMs = Math.max(0, effectiveEnd - now);
  if (!input.knownBeneficiary && ADDRESS_RE.test(beneficiary)) warnings.push("Beneficiary is not in the local address book.");
  if (lockedShare > .75) warnings.push("This draft commits more than 75% of available EC.");
  else if (lockedShare > .4) warnings.push("This draft commits more than 40% of available EC.");
  if (afterBalance >= 0 && afterBalance < reserve) warnings.push("Deployment would leave the wallet below its Transaction Guard reserve.");
  if (durationMs > 180 * DAY_MS) warnings.push("Capital remains committed for more than 180 days.");
  if (type === "hashlock") warnings.push("Hashlock settlement depends on safely sharing and retaining the secret.");
  if (type === "milestone") warnings.push("Milestone contracts require both creator and beneficiary approvals before each release.");
  if (type === "vesting" && installments > 24) warnings.push("A long installment schedule increases monitoring overhead.");
  const events = [];
  if (amount > 0 && Number.isFinite(effectiveEnd) && effectiveEnd > 0) {
    if (type === "vesting" || type === "milestone") {
      const base = Math.floor(amount / installments);
      for (let index = 0; index < Math.min(installments, 52); index++) events.push({ at:unlockTime + index * intervalMs, amount:index === installments - 1 ? amount - base * (installments - 1) : base, label:type === "milestone" ? `Milestone ${index + 1} of ${installments}` : `Installment ${index + 1} of ${installments}` });
    } else if (type === "hashlock") events.push({ at:refundTime, amount, label:"Claim deadline / refund fallback", conditional:true });
    else events.push({ at:unlockTime, amount, label:"Automatic timelock release" });
  }
  let risk = 0;
  risk += Math.min(45, lockedShare * 45);
  risk += Math.min(20, durationMs / (365 * DAY_MS) * 20);
  if (!input.knownBeneficiary && ADDRESS_RE.test(beneficiary)) risk += 12;
  if (type === "hashlock") risk += 15;
  if (type === "vesting" && installments > 24) risk += 8;
  if (type === "milestone") risk += 12;
  if (afterBalance >= 0 && afterBalance < reserve) risk += 18;
  if (blocked.length) risk = Math.max(risk, 90);
  return { blocked, warnings, valid:blocked.length === 0, risk:Math.min(100, Math.round(risk)), afterBalance, lockedShare, durationMs, effectiveEnd, events };
}
