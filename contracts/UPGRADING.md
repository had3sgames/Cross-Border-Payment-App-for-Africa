# Soroban Contract Upgrade Process

## Overview

Every AfriPay Soroban contract (all 9) includes a `governance` module
(`src/governance.rs`) that adds **on-chain timelocked** WASM upgrades and
versioned migrations (SC-172 / SC-173). The fund-holding contracts also get an
emergency pause (SC-174).

## Upgrade Mechanism

### Entry points (every contract)

| Function | Auth | Description |
|---|---|---|
| `propose_upgrade(admin, new_wasm_hash) -> u64` | admin | Stores `(hash, eta)` with `eta = now + 48h`; emits `UpgradeProposed(hash, eta)`. Returns `eta`. A new proposal replaces the previous one. |
| `upgrade(admin, new_wasm_hash) -> u64` | admin | Alias of `propose_upgrade`. Upgrades are **never** applied instantly. |
| `cancel_upgrade(admin)` | admin | Removes the pending upgrade; emits `UpgradeCancelled(hash)`. |
| `execute_upgrade(admin)` | admin | Panics with `Upgrade timelock has not expired` before `eta`; afterwards swaps the WASM and emits `Upgraded(hash, CONTRACT_VERSION)`. |
| `get_pending_upgrade() -> Option<PendingUpgrade>` | — | The pending `{ new_wasm_hash, eta }`, if any. |
| `migrate(admin)` | admin | Idempotent; bumps the stored version to the new WASM's `CONTRACT_VERSION`; emits `Migrated(version)`. |
| `get_contract_version() -> u32` | — | Stored contract version (`0` before the first `migrate`). |

The timelock (`UPGRADE_TIMELOCK_SECS = 48h`) is enforced by the contract
itself, so a compromised admin key cannot replace contract code without giving
users a 48-hour on-chain window to exit. For extra safety, set the admin to the
`multisig-approval` contract.

## Upgrade Process

Use [`scripts/upgrade.sh`](scripts/upgrade.sh), which works for every contract
name. It needs `SOROBAN_ADMIN_KEYPAIR`, `ADMIN_ADDRESS` and the contract ID in
`<NAME>_CONTRACT_ID` (env or `contracts/.env`, as written by `deploy.sh`).

```bash
./scripts/upgrade.sh build    <contract>   # cargo build the WASM
./scripts/upgrade.sh propose  <contract>   # upload WASM + propose_upgrade (starts 48h timelock)
./scripts/upgrade.sh status   <contract>   # get_pending_upgrade + get_contract_version
./scripts/upgrade.sh execute  <contract>   # execute_upgrade + migrate (after eta)
./scripts/upgrade.sh cancel   <contract>   # cancel_upgrade
```

1. **Build & test** the new version on testnet; bump `CONTRACT_VERSION` in
   `src/governance.rs` and add any migration logic to `migrate`.
2. **Propose**: `upgrade.sh propose <contract>`. Announce the hash and `eta`
   publicly (indexed `UpgradeProposed` event).
3. **Wait 48 hours** for community review. Cancel with `upgrade.sh cancel` if a
   problem is found.
4. **Execute**: `upgrade.sh execute <contract>` (calls `execute_upgrade`, then
   `migrate`).
5. **Verify**: `upgrade.sh status <contract>` shows no pending upgrade and the
   new version.

## Emergency Pause (SC-174)

`escrow`, `agent-escrow`, `savings-vault`, `dispute-resolution` and
`loyalty-token` expose `pause(admin)`, `unpause(admin)` and `is_paused()`
(events `Paused` / `Unpaused`). `fee-distributor` and `recurring-payments`
keep their existing pause.

**Exit-path policy:** while paused, entry points that move funds *into* the
contract (or mint/transfer value) panic with `Contract is paused`. Exit paths
stay available so users can always recover funds:

| Contract | Blocked while paused | Still available |
|---|---|---|
| escrow | `create_escrow`, `batch_create_escrow`, `deposit` | release, partial release, cancel, expire, dispute (already-open escrows) |
| agent-escrow | `create_escrow` | confirm/partial payout, cancel, admin release |
| savings-vault | `deposit` | `withdraw`, emergency withdraw/return, `claim_yield` |
| dispute-resolution | `open_dispute`, `open_escrow_dispute` | evidence, voting, resolution, appeals, `claim_expired` |
| loyalty-token | `mint`, `transfer`, `transfer_from` | `burn`, `burn_from`, `redeem`, approvals |

## Per-contract Migration Notes

| Contract | `CONTRACT_VERSION` | Notes |
|---|---|---|
| escrow | 4 | Previously had an *instant* `upgrade`; now timelocked. `ContractVersion` storage key is unchanged (v3 deployments read correctly). Run `migrate` after upgrading to v4. |
| agent-escrow | 1 | First upgradeable version. Existing deployments must be redeployed once (no upgrade entry point before this release); funds migrated manually. |
| dispute-resolution | 1 | As above. Pause blocks escrow disputes too (escrow's `dispute_escrow` reverts atomically). |
| fee-distributor | 1 | As above. Uses its existing `pause`. |
| kyc-attestation | 1 | As above. Attestations must be re-issued on the new deployment. |
| loyalty-token | 1 | As above. Balances must be snapshotted and re-minted on the new deployment. |
| multisig-approval | 1 | As above. Admin is read from instance storage; governance keys live in persistent storage. |
| recurring-payments | 1 | As above. Uses its existing `pause`. |
| savings-vault | 1 | As above. |

Governance storage keys (`ContractVersion`, `PendingUpgrade`, `Paused`) are a
separate `GovKey` enum; they encode identically to same-named `DataKey`
variants, so never add a `DataKey` variant with one of those names for a
different purpose.

## Safety Considerations

1. **Always test first** on testnet before mainnet.
2. **Back up state** (export contract storage) before upgrading.
3. **Monitor** `UpgradeProposed` events — an unexpected proposal is a signal
   to pause and investigate; users have 48 h to exit.
4. Upgrades are **irreversible**; a rollback is a new proposal of the old
   WASM hash, subject to the same timelock.

## Further Reading

- [Soroban Contract Documentation](https://developers.stellar.org/docs/smart-contracts)
- [Contract Instance Upgrade](https://developers.stellar.org/docs/smart-contracts/upgrading)
- [Event Indexing](./../backend/docs/CONTRACT_EVENTS.md)
