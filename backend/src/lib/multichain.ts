/**
 * multichain.ts — Multi-chain registry and broadcast module
 *
 * Provides:
 *   - A type-safe chain registry (EVM-compatible chains + Stellar)
 *   - Transaction-hash validation helpers (addresses the companion bug where
 *     fabricated / zero EVM tx hashes were returned without verification)
 *   - A `broadcastTransaction` abstraction that dispatches to the correct
 *     chain-specific transport and returns a validated, canonical tx hash
 *   - Explorer-URL generation per chain
 *
 * Design principles:
 *   - No live network calls in the core logic — transports are injected so
 *     callers (and tests) can supply their own implementation.
 *   - All public functions are pure with respect to the chain registry;
 *     mutation is only allowed through `registerChain` / `unregisterChain`.
 *   - Invalid tx hashes are never returned — `broadcastTransaction` throws
 *     `InvalidTxHashError` if the transport returns a value that doesn't
 *     match the expected format for that chain family.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Chain families
// ─────────────────────────────────────────────────────────────────────────────

export type ChainFamily = "evm" | "stellar";

// ─────────────────────────────────────────────────────────────────────────────
// Chain descriptor
// ─────────────────────────────────────────────────────────────────────────────

export interface ChainDescriptor {
  /** Unique numeric identifier (EIP-155 chain id for EVM; 0 for Stellar mainnet, 1 for Stellar testnet). */
  chainId: number;
  /** Human-readable name, e.g. "Ethereum", "Stellar Testnet". */
  name: string;
  /** Chain family — determines hash validation rules and transport shape. */
  family: ChainFamily;
  /** Base URL used by `explorerTxUrl`. */
  explorerBaseUrl: string;
  /** Path template for a transaction URL.  Use "{hash}" as the placeholder. */
  explorerTxPath: string;
  /** Whether this chain is currently active / reachable. */
  active: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

export class ChainNotFoundError extends Error {
  constructor(chainId: number) {
    super(`Chain with id ${chainId} is not registered`);
    this.name = "ChainNotFoundError";
  }
}

export class ChainInactiveError extends Error {
  constructor(chainId: number) {
    super(`Chain ${chainId} is registered but currently inactive`);
    this.name = "ChainInactiveError";
  }
}

/**
 * Thrown when a transport returns a tx hash that doesn't match the expected
 * format for its chain family.  This is the fix for the "fabricated EVM tx
 * hashes" companion bug — callers can no longer silently receive garbage.
 */
export class InvalidTxHashError extends Error {
  constructor(
    public readonly chainId: number,
    public readonly family: ChainFamily,
    public readonly received: string,
  ) {
    super(
      `Tx hash "${received}" returned for chain ${chainId} (family: ${family}) ` +
        `does not match the expected format`,
    );
    this.name = "InvalidTxHashError";
  }
}

export class DuplicateChainError extends Error {
  constructor(chainId: number) {
    super(`Chain ${chainId} is already registered; use updateChain to modify it`);
    this.name = "DuplicateChainError";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tx-hash validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * EVM transaction hash: "0x" followed by exactly 64 lowercase hex characters.
 * The companion bug manifested as fabricated hashes that were all-zeros or
 * random non-hex strings — this regex rejects both.
 */
const EVM_TX_HASH_RE = /^0x[0-9a-f]{64}$/;

/**
 * Stellar transaction hash: exactly 64 uppercase hex characters (no "0x" prefix).
 */
const STELLAR_TX_HASH_RE = /^[0-9A-F]{64}$/;

/**
 * Returns `true` if `hash` is a well-formed transaction hash for the given
 * chain family.
 *
 * This is intentionally strict:
 *   - EVM: must be lowercase hex with "0x" prefix
 *   - Stellar: must be uppercase hex without any prefix
 *   - An all-zeros EVM hash ("0x000…000") is treated as invalid because it
 *     is the canonical "no result" sentinel used by some buggy transports.
 */
export function isValidTxHash(family: ChainFamily, hash: string): boolean {
  if (family === "evm") {
    if (!EVM_TX_HASH_RE.test(hash)) return false;
    // Reject the all-zeros sentinel
    if (hash === `0x${"0".repeat(64)}`) return false;
    return true;
  }
  if (family === "stellar") {
    return STELLAR_TX_HASH_RE.test(hash);
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────────────────────────────────

const registry = new Map<number, ChainDescriptor>();

// Seed with well-known chains
const BUILTIN_CHAINS: ChainDescriptor[] = [
  {
    chainId: 1,
    name: "Ethereum Mainnet",
    family: "evm",
    explorerBaseUrl: "https://etherscan.io",
    explorerTxPath: "/tx/{hash}",
    active: true,
  },
  {
    chainId: 137,
    name: "Polygon",
    family: "evm",
    explorerBaseUrl: "https://polygonscan.com",
    explorerTxPath: "/tx/{hash}",
    active: true,
  },
  {
    chainId: 42161,
    name: "Arbitrum One",
    family: "evm",
    explorerBaseUrl: "https://arbiscan.io",
    explorerTxPath: "/tx/{hash}",
    active: true,
  },
  {
    chainId: 8453,
    name: "Base",
    family: "evm",
    explorerBaseUrl: "https://basescan.org",
    explorerTxPath: "/tx/{hash}",
    active: true,
  },
  {
    chainId: 11155111,
    name: "Sepolia Testnet",
    family: "evm",
    explorerBaseUrl: "https://sepolia.etherscan.io",
    explorerTxPath: "/tx/{hash}",
    active: true,
  },
  {
    // Stellar uses 0 for mainnet by convention in this registry
    chainId: 0,
    name: "Stellar Mainnet",
    family: "stellar",
    explorerBaseUrl: "https://stellar.expert/explorer/public",
    explorerTxPath: "/tx/{hash}",
    active: true,
  },
  {
    chainId: 100,
    name: "Stellar Testnet",
    family: "stellar",
    explorerBaseUrl: "https://stellar.expert/explorer/testnet",
    explorerTxPath: "/tx/{hash}",
    active: true,
  },
];

for (const chain of BUILTIN_CHAINS) {
  registry.set(chain.chainId, chain);
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry accessors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns a copy of the registered chain, or `undefined` if not found.
 */
export function getChain(chainId: number): ChainDescriptor | undefined {
  const chain = registry.get(chainId);
  return chain ? { ...chain } : undefined;
}

/**
 * Returns all registered chains (copies).
 */
export function listChains(): ChainDescriptor[] {
  return [...registry.values()].map((c) => ({ ...c }));
}

/**
 * Returns all active registered chains.
 */
export function listActiveChains(): ChainDescriptor[] {
  return listChains().filter((c) => c.active);
}

/**
 * Registers a new chain.  Throws `DuplicateChainError` if the chainId already
 * exists — use `updateChain` to modify an existing entry.
 */
export function registerChain(descriptor: ChainDescriptor): void {
  if (registry.has(descriptor.chainId)) {
    throw new DuplicateChainError(descriptor.chainId);
  }
  registry.set(descriptor.chainId, { ...descriptor });
}

/**
 * Updates an existing chain descriptor (partial update — only provided fields
 * are changed).  Throws `ChainNotFoundError` if the chain isn't registered.
 */
export function updateChain(
  chainId: number,
  patch: Partial<Omit<ChainDescriptor, "chainId">>,
): void {
  const existing = registry.get(chainId);
  if (!existing) throw new ChainNotFoundError(chainId);
  registry.set(chainId, { ...existing, ...patch });
}

/**
 * Removes a chain from the registry.  Throws `ChainNotFoundError` if not found.
 */
export function unregisterChain(chainId: number): void {
  if (!registry.has(chainId)) throw new ChainNotFoundError(chainId);
  registry.delete(chainId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Explorer URL helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the explorer URL for a given chain and transaction hash.
 * Throws `ChainNotFoundError` if the chain isn't registered.
 */
export function explorerTxUrl(chainId: number, txHash: string): string {
  const chain = registry.get(chainId);
  if (!chain) throw new ChainNotFoundError(chainId);
  const path = chain.explorerTxPath.replace("{hash}", txHash);
  return `${chain.explorerBaseUrl}${path}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Broadcast transport interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The raw payload sent to a chain's broadcast endpoint.
 * For EVM this is the RLP-encoded hex transaction; for Stellar it's the
 * base64-encoded XDR envelope.
 */
export interface BroadcastPayload {
  /** Encoded transaction ready for submission. */
  encodedTx: string;
  /** Optional metadata (gas limit, fee, etc.) passed through to the transport. */
  meta?: Record<string, unknown>;
}

/**
 * The validated result of a broadcast operation.
 */
export interface BroadcastResult {
  chainId: number;
  txHash: string;
  /** Block number / ledger sequence at which the tx was included, if known. */
  blockNumber?: number;
  /** ISO timestamp from the transport, if available. */
  confirmedAt?: string;
}

/**
 * Injectable transport interface.  Implement this to provide real network
 * connectivity; pass a mock in tests.
 */
export interface ChainTransport {
  broadcast(
    chain: ChainDescriptor,
    payload: BroadcastPayload,
  ): Promise<{ txHash: string; blockNumber?: number; confirmedAt?: string }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// broadcastTransaction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Broadcasts a transaction to the specified chain.
 *
 * Steps:
 *   1. Look up the chain in the registry — throws `ChainNotFoundError` if absent.
 *   2. Verify the chain is active — throws `ChainInactiveError` if not.
 *   3. Delegate to `transport.broadcast`.
 *   4. Validate the returned tx hash — throws `InvalidTxHashError` if the
 *      transport returns a malformed / fabricated hash (companion bug fix).
 *   5. Return a `BroadcastResult` with the validated hash.
 */
export async function broadcastTransaction(
  chainId: number,
  payload: BroadcastPayload,
  transport: ChainTransport,
): Promise<BroadcastResult> {
  const chain = registry.get(chainId);
  if (!chain) throw new ChainNotFoundError(chainId);
  if (!chain.active) throw new ChainInactiveError(chainId);

  const raw = await transport.broadcast(chain, payload);

  if (!isValidTxHash(chain.family, raw.txHash)) {
    throw new InvalidTxHashError(chainId, chain.family, raw.txHash);
  }

  return {
    chainId,
    txHash: raw.txHash,
    blockNumber: raw.blockNumber,
    confirmedAt: raw.confirmedAt,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility: normalize EVM hash to lowercase
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalizes an EVM tx hash to the canonical lowercase form expected by
 * `isValidTxHash`.  Returns `null` if the input cannot be normalized.
 */
export function normalizeEvmTxHash(raw: string): string | null {
  const lower = raw.toLowerCase();
  if (EVM_TX_HASH_RE.test(lower) && lower !== `0x${"0".repeat(64)}`) {
    return lower;
  }
  return null;
}
