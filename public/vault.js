const encoder = new TextEncoder();
const decoder = new TextDecoder();
const VAULT_CONTEXT = encoder.encode("ecoin-wallet-vault:v1");
const RECOVERY_CONTEXT = encoder.encode("ecoin-recovery-bundle:v1");
const VAULT_ITERATIONS = 210000;

function toBase64Url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

function stripWalletSecrets(wallet) {
  const { privateKey: _privateKey, ...publicWallet } = wallet;
  return publicWallet;
}

function normalizeWallet(wallet) {
  return wallet
    && typeof wallet === "object"
    && typeof wallet.address === "string"
    && typeof wallet.name === "string"
    && typeof wallet.publicKey === "object"
    && typeof wallet.privateKey === "object"
    && /^ec1[0-9a-f]{38}$/.test(wallet.address)
    ? { ...wallet }
    : null;
}

async function deriveVaultKey(password, salt, iterations = VAULT_ITERATIONS) {
  const baseKey = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export function stripWalletSecretsFromCollection(wallets) {
  return wallets.map(stripWalletSecrets);
}

export async function encryptWalletVault(wallets, password) {
  if (typeof password !== "string" || !password.trim()) throw new Error("Vault password cannot be blank");
  const normalized = wallets.map(normalizeWallet).filter(Boolean);
  if (!normalized.length) throw new Error("No wallets available to protect");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveVaultKey(password.trim(), salt);
  const payload = encoder.encode(JSON.stringify({ version: 1, wallets: normalized }));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: VAULT_CONTEXT }, key, payload));
  return {
    version: 1,
    algorithm: "PBKDF2+A256GCM",
    iterations: VAULT_ITERATIONS,
    salt: toBase64Url(salt),
    iv: toBase64Url(iv),
    index: stripWalletSecretsFromCollection(normalized),
    ciphertext: toBase64Url(ciphertext),
  };
}

export async function decryptWalletVault(envelope, password) {
  if (!envelope || typeof envelope !== "object") throw new Error("Vault data is missing");
  if (typeof password !== "string" || !password.trim()) throw new Error("Vault password cannot be blank");
  const key = await deriveVaultKey(password.trim(), fromBase64Url(envelope.salt), envelope.iterations || VAULT_ITERATIONS);
  const plaintext = new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64Url(envelope.iv), additionalData: VAULT_CONTEXT },
    key,
    fromBase64Url(envelope.ciphertext),
  ));
  const parsed = JSON.parse(decoder.decode(plaintext));
  const wallets = Array.isArray(parsed.wallets) ? parsed.wallets.map(normalizeWallet).filter(Boolean) : [];
  if (!wallets.length) throw new Error("Vault did not contain any usable wallets");
  return wallets;
}

export async function encryptRecoveryBundle(bundle, password) {
  if (!bundle || typeof bundle !== "object") throw new Error("Recovery data is missing");
  if (typeof password !== "string" || password.trim().length < 10) throw new Error("Recovery password must contain at least 10 characters");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveVaultKey(password.trim(), salt);
  const payload = encoder.encode(JSON.stringify(bundle));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name:"AES-GCM", iv, additionalData:RECOVERY_CONTEXT }, key, payload));
  return {
    kind:"ecoin-encrypted-recovery",
    version:1,
    algorithm:"PBKDF2+A256GCM",
    iterations:VAULT_ITERATIONS,
    createdAt:Date.now(),
    salt:toBase64Url(salt),
    iv:toBase64Url(iv),
    ciphertext:toBase64Url(ciphertext),
  };
}

export async function decryptRecoveryBundle(envelope, password) {
  if (!envelope || envelope.kind !== "ecoin-encrypted-recovery" || envelope.version !== 1) throw new Error("This is not an encrypted E-Coin recovery bundle");
  if (envelope.algorithm !== "PBKDF2+A256GCM") throw new Error("Unsupported recovery encryption algorithm");
  if (!Number.isSafeInteger(envelope.iterations) || envelope.iterations < 100_000 || envelope.iterations > 1_000_000) throw new Error("Invalid recovery key-derivation settings");
  if (typeof password !== "string" || !password.trim()) throw new Error("Recovery password cannot be blank");
  try {
    const key = await deriveVaultKey(password.trim(), fromBase64Url(envelope.salt), envelope.iterations);
    const plaintext = new Uint8Array(await crypto.subtle.decrypt(
      { name:"AES-GCM", iv:fromBase64Url(envelope.iv), additionalData:RECOVERY_CONTEXT },
      key,
      fromBase64Url(envelope.ciphertext),
    ));
    const parsed = JSON.parse(decoder.decode(plaintext));
    if (!parsed || typeof parsed !== "object") throw new Error("Recovery payload is invalid");
    return parsed;
  } catch {
    throw new Error("Recovery password is incorrect or the backup was modified");
  }
}
