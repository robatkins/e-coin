# E-Coin Protocol 08

Protocol 08 defines the Aurora development network. Values are encoded as safe JSON integers unless stated otherwise.

## Identity

A wallet is an Ed25519 keypair. Its address is:

```text
"ec1" + first_38_hex_characters(SHA-256(raw_public_key))
```

The private key is never sent to the node.

## Units and accounts

One E-Coin is 1,000,000 micro-coins (µEC). Each account stores a balance and its last accepted nonce. A transfer must use exactly `last_nonce + 1`, which gives deterministic ordering and prevents replay.

Genesis creates exactly 20,000,000 EC in the Genesis Treasury. Faucets and USD-market purchases distribute existing treasury funds; neither path issues new coins. Protocol fees recycle into the Genesis Treasury, so total supply remains exactly the genesis cap.

## Transfer envelope

The signing payload is compact JSON with keys in this exact order:

```text
from, to, amount, fee, nonce, memo, timestamp, publicKey
```

The signature is Ed25519 over the UTF-8 payload. Transaction IDs are SHA-256 of the signing payload, a colon, and the base64url signature. The minimum fee is 1,000 µEC and is destroyed on settlement.

## Blocks

Each block commits to its height, previous block hash, timestamp, transaction list, account state root, and contract state root. The account root hashes sorted `[address, balance, nonce]` tuples; the contract root hashes deterministic contract state. Aurora produces a block every six seconds when work is available. Capacity adapts from 250 up to 2,000 transactions, with at most 64 selections from one sender per block.

Node integrity checks replay the chain from genesis, re-verifying transfer signatures, transaction IDs, nonces, balances, burned fees, one-time faucet claims, and every committed state root against the persisted account snapshot.

## Mempool

Valid signed transfers enter a persistent ordered mempool before settlement. Pending outgoing amounts and fees are reserved from the sender's available balance, and later transfers must continue the pending nonce sequence. Before producing a block, the node re-verifies every pending signature, transaction ID, nonce, and projected balance so a modified persisted queue cannot bypass admission rules.

Block selection compares the first eligible transaction from each sender and chooses the highest fee, breaking ties by arrival time. A sender's higher nonces never jump ahead of its next eligible nonce. Exact transaction resubmissions are idempotent whether pending or confirmed.

The mempool is bounded at 10,000 transactions and entries expire after ten minutes. A sender may replace a pending transaction at the same nonce by increasing its fee at least 10%, but the recipient, amount, and memo must remain identical. This permits safe acceleration without silently changing payment intent.

## Smart contracts

Protocol 08 provides constrained, replayable templates instead of arbitrary runtime code. `timelock` releases once after its deadline. `vesting` splits funds into 2-52 deterministic installments. `hashlock` releases to its beneficiary when anyone supplies the committed SHA-256 preimage before expiry; otherwise the full balance refunds automatically to the creator. Revealed secrets are public transaction data. Schedules are capped at two years, creators may hold at most 100 active contracts, and automatic execution is bounded to 500 contracts per block.

## Treasury market

The internal market quotes EC in integer micro-USD units and settles purchases by transferring existing coins from the Genesis Treasury. Purchase requests accept $1-$1,000 in devnet USD, use client-generated idempotency keys, and are committed as `market_buy` transactions. The reference price begins at $0.25 and advances deterministically with committed USD volume. This sandbox does not collect or process real payment credentials.

## Security status

Protocol 08 has no peer network, validator quorum, fork-choice rule, regulated fiat processor, hardware-wallet integration, or third-party audit. The browser vault is encrypted, API writes are rate-limited, each sender is capped at 256 pending transactions, and owner-treasury bootstrap is restricted to loopback clients. It remains suitable for local experimentation only.
