const ADDRESS_RE = /^ec1[0-9a-f]{38}$/;
const SIGNATURE_RE = /^[A-Za-z0-9_-]{80,100}$/;

function validateTransaction(tx, { minFee = 1_000 } = {}) {
  const errors = [];
  if (!tx || typeof tx !== "object") return ["Transfer payload is missing."];
  if (!ADDRESS_RE.test(tx.from || "")) errors.push("Sender address is invalid.");
  if (!ADDRESS_RE.test(tx.to || "")) errors.push("Recipient address is invalid.");
  if (tx.from && tx.from === tx.to) errors.push("Sender and recipient must be different.");
  if (!Number.isSafeInteger(tx.amount) || tx.amount <= 0) errors.push("Amount must be a positive integer in micro-EC.");
  if (!Number.isSafeInteger(tx.fee) || tx.fee < minFee) errors.push("Fee is below the protocol minimum.");
  if (!Number.isSafeInteger(tx.nonce) || tx.nonce <= 0) errors.push("Nonce is invalid.");
  if (!Number.isSafeInteger(tx.timestamp) || tx.timestamp <= 0) errors.push("Timestamp is invalid.");
  if (typeof tx.memo !== "string" || tx.memo.length > 96) errors.push("Memo exceeds 96 characters.");
  if (!tx.publicKey || tx.publicKey.kty !== "OKP" || tx.publicKey.crv !== "Ed25519" || typeof tx.publicKey.x !== "string") errors.push("Ed25519 public key is invalid.");
  return errors;
}

export function createUnsignedTransferEnvelope(tx, now = Date.now()) {
  const errors = validateTransaction(tx);
  if (errors.length) throw new Error(errors[0]);
  return { kind:"ecoin-unsigned-transfer", version:1, network:"E-Coin Aurora Devnet", createdAt:now, expiresAt:now + 30 * 60_000, transaction:{ ...tx } };
}

export function validateUnsignedTransferEnvelope(envelope, options = {}) {
  const now = Number(options.now) || Date.now();
  const errors = [];
  const warnings = [];
  if (!envelope || envelope.kind !== "ecoin-unsigned-transfer" || envelope.version !== 1 || envelope.network !== "E-Coin Aurora Devnet") errors.push("This is not a supported E-Coin unsigned transfer.");
  const tx = envelope?.transaction;
  errors.push(...validateTransaction(tx, options));
  if (!Number.isSafeInteger(envelope?.createdAt) || !Number.isSafeInteger(envelope?.expiresAt) || envelope.expiresAt <= envelope.createdAt) errors.push("Envelope timing metadata is invalid.");
  else if (envelope.expiresAt < now) errors.push("Unsigned transfer has expired.");
  if (options.expectedFrom && tx?.from !== options.expectedFrom) errors.push("Draft belongs to a different signing wallet.");
  if (options.expectedPublicKey && tx?.publicKey?.x !== options.expectedPublicKey.x) errors.push("Draft public key does not match the signing wallet.");
  if (Number.isSafeInteger(options.expectedNonce) && tx?.nonce !== options.expectedNonce) errors.push("Draft nonce no longer matches the account.");
  if (Number.isSafeInteger(options.availableBalance) && Number.isSafeInteger(tx?.amount) && Number.isSafeInteger(tx?.fee) && tx.amount + tx.fee > options.availableBalance) errors.push("Account balance cannot cover the draft.");
  if (envelope?.expiresAt && envelope.expiresAt - now < 5 * 60_000) warnings.push("Draft expires in less than five minutes.");
  return { valid:errors.length === 0, errors, warnings, transaction:tx };
}

export function createSignedTransferEnvelope(unsignedEnvelope, signature, now = Date.now()) {
  const validation = validateUnsignedTransferEnvelope(unsignedEnvelope, { now });
  if (!validation.valid) throw new Error(validation.errors[0]);
  if (!SIGNATURE_RE.test(signature || "")) throw new Error("Ed25519 signature encoding is invalid.");
  return { kind:"ecoin-signed-transfer", version:1, network:unsignedEnvelope.network, createdAt:unsignedEnvelope.createdAt, signedAt:now, expiresAt:unsignedEnvelope.expiresAt, transaction:{ ...validation.transaction, signature } };
}

export function validateSignedTransferEnvelope(envelope, options = {}) {
  const unsigned = envelope ? { kind:"ecoin-unsigned-transfer", version:envelope.version, network:envelope.network, createdAt:envelope.createdAt, expiresAt:envelope.expiresAt, transaction:envelope.transaction ? (({ signature:_signature, ...tx }) => tx)(envelope.transaction) : null } : null;
  const validation = validateUnsignedTransferEnvelope(unsigned, options);
  if (!envelope || envelope.kind !== "ecoin-signed-transfer") validation.errors.unshift("This is not a supported E-Coin signed transfer.");
  if (!SIGNATURE_RE.test(envelope?.transaction?.signature || "")) validation.errors.push("Ed25519 signature encoding is invalid.");
  return { ...validation, valid:validation.errors.length === 0, transaction:envelope?.transaction };
}
