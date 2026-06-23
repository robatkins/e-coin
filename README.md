# E-Coin

E-Coin is an original, account-based cryptocurrency experiment with a browser wallet. It is not Bitcoin and does not reuse Bitcoin's code, transaction model, address format, mining, or protocol.

## Current build (protocol 8)

- Ed25519 wallet identities and `ec1…` addresses
- Integer micro-coin accounting (`1 EC = 1,000,000 µEC`)
- Signed transfers with sequential account nonces
- Fee burning and deterministic state roots
- Hash-linked blocks persisted to `data/ledger.json`
- Browser-local, non-custodial wallet with backup/import
- Development faucet and live chain explorer
- One faucet claim per address, derived from committed history
- Live chain-integrity verification and wallet-aware activity rows
- Maximum-spend calculation and cryptographic backup keypair validation
- Replay-based integrity checks for balances, nonces, signatures, fees, and state roots
- Wallet intelligence for received, sent, fee, counterparty, and activity totals
- Pre-signing transfer analysis with recipient history, fee ratio, large-transfer warnings, and projected balance
- Browser-local address book with reusable destinations and removal controls
- Clickable ledger activity with settlement receipts and copyable receipt identifiers
- Block lookup by height/hash and transaction lookup by ID
- Persistent nonce-aware mempool with reserved spendable balances
- Six-second timed block production with multi-transaction batching
- Visible pending transfers and a live next-block countdown
- Mempool signature/state revalidation after node restarts
- Constant-time indexes for blocks, transactions, faucet claims, account activity, and pending balances
- Fee-priority block scheduling that preserves per-sender nonce order
- Adaptive economy, standard, and priority fee guidance
- Idempotent transaction resubmission and paginated block history
- Fast health checks, scheduled deep audits, and throughput/batch metrics
- Bounded 10,000-entry mempool with ten-minute expiry
- Adaptive 250–2,000 transaction block capacity
- Safe replace-by-fee with payment-intent preservation
- Live server-sent block/mempool events with polling fallback
- Instant wallet settlement updates and connection-state visibility
- Versioned SHA-256-checksummed ledger snapshots
- Verified one-generation backup recovery with fail-closed startup
- Automatic migration from legacy raw snapshots
- Incremental explorer pagination with deduplicated live updates
- Browser-local multi-wallet creation, naming, switching, import, and per-wallet backup
- Signed deterministic time-lock contract deployments through the mempool
- Separate committed contract-state roots in every new block
- Automatic beneficiary release after the programmed unlock time
- Wallet-scoped contract portfolio and locked-value views
- Fixed 20,000,000 EC genesis supply held by the local Genesis Treasury wallet
- Faucet distributions that move treasury funds instead of minting coins
- Adaptive 250-2,000 transaction blocks with per-sender fairness limits
- Scheduled vesting contracts with 2-52 deterministic installments
- Encrypted multi-wallet vault and loopback-only treasury bootstrap
- Write rate limiting, browser security headers, and no-store key delivery
- Interactive Learn tab with protocol lessons, safety guidance, and a knowledge quiz
- Treasury-backed internal USD quotes and idempotent devnet purchases
- Protocol fees recycled into the Genesis Treasury instead of burned
- Data dashboard with price, market cap, volume, liquidity, and network charts
- Contract schedule, active-count, and execution-batch safety limits
- Hash-locked escrow with public preimage claims and automatic expiry refunds
- Per-sender pending-transaction caps and secret-clearing wallet controls
- Wallet intelligence with safe-spend guidance, fee recommendations, and upcoming-event summaries
- Ledger explorer search across blocks, transactions, accounts, and contracts
- Data-tab health scoring, price momentum, and recommendation summaries
- Local address watchlist with seeded counterparties and live balance snapshots
- Watchlist delta alerts that compare the latest refresh against the previous snapshot
- Smart wallet actions that surface the best next step for the current balance, fee pressure, and contract state
- Smart transfer drafts that remember recent outgoing payments per wallet for one-click reuse
- Live alert center for upcoming contract deadlines and watched-account timelines
- Reusable transfer templates for routine payments and fast draft restoration
- Signed internal order book with limit buy/sell orders, partial fills, open orders, and trade tape

The current node seals nonce-ordered, fee-prioritized transaction batches every six seconds. It is deliberately a **single-node devnet**, not yet a decentralized or production-safe network.

## Run

Requires Node.js 20 or newer; there are no third-party runtime dependencies.

```powershell
npm start
```

Open <http://localhost:8787>. Run tests with `npm test`.

## Protocol direction

The next milestones are a mempool with timed block production, validator identities, a BFT-style proof-of-stake consensus layer, peer synchronization, encrypted wallet storage, and protocol versioning. Do not attach real monetary value to this devnet.
