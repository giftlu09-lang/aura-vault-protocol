/**
 * Tests for src/lib/multichain.ts — Issue #489
 *
 * Covers every exported symbol with at least one happy-path test and one
 * edge / error case, following the pattern used by gasService.test.ts and
 * yieldService.test.ts.
 *
 * No live network calls — the ChainTransport interface is fulfilled by simple
 * in-test mock objects.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  broadcastTransaction,
  ChainInactiveError,
  ChainNotFoundError,
  DuplicateChainError,
  explorerTxUrl,
  getChain,
  InvalidTxHashError,
  isValidTxHash,
  listActiveChains,
  listChains,
  normalizeEvmTxHash,
  registerChain,
  type BroadcastPayload,
  type ChainDescriptor,
  type ChainTransport,
  unregisterChain,
  updateChain,
} from "../lib/multichain.js";

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

/** A well-formed lowercase EVM tx hash (non-zero). */
const VALID_EVM_HASH =
  "0xaabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344";

/** A well-formed Stellar tx hash (uppercase, no prefix). */
const VALID_STELLAR_HASH =
  "AABBCCDD11223344AABBCCDD11223344AABBCCDD11223344AABBCCDD11223344";

/** The all-zeros EVM sentinel (fabricated / missing result). */
const ZERO_EVM_HASH = `0x${"0".repeat(64)}`;

/** Minimal valid chain descriptor for use in registry tests. */
function makeTestChain(chainId: number, overrides: Partial<ChainDescriptor> = {}): ChainDescriptor {
  return {
    chainId,
    name: `Test Chain ${chainId}`,
    family: "evm",
    explorerBaseUrl: "https://example.com",
    explorerTxPath: "/tx/{hash}",
    active: true,
    ...overrides,
  };
}

/** Transport that always resolves with the provided hash. */
function makeTransport(txHash: string, blockNumber?: number): ChainTransport {
  return {
    broadcast: vi.fn().mockResolvedValue({ txHash, blockNumber }),
  };
}

// IDs we use only in registry mutation tests — cleaned up in afterEach
const TEST_CHAIN_ID = 99_999;
const TEST_CHAIN_ID_2 = 99_998;

afterEach(() => {
  // Remove any chains registered during tests to keep the registry clean
  for (const id of [TEST_CHAIN_ID, TEST_CHAIN_ID_2]) {
    try {
      unregisterChain(id);
    } catch {
      // ignore — chain wasn't registered in this test
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// isValidTxHash
// ─────────────────────────────────────────────────────────────────────────────

describe("isValidTxHash — EVM", () => {
  it("accepts a valid 0x-prefixed lowercase 64-hex-char hash", () => {
    expect(isValidTxHash("evm", VALID_EVM_HASH)).toBe(true);
  });

  it("rejects the all-zeros EVM hash (companion bug: fabricated sentinel)", () => {
    expect(isValidTxHash("evm", ZERO_EVM_HASH)).toBe(false);
  });

  it("rejects uppercase hex (EVM hashes must be lowercase)", () => {
    const upper = VALID_EVM_HASH.toUpperCase();
    expect(isValidTxHash("evm", upper)).toBe(false);
  });

  it("rejects a hash that is too short", () => {
    expect(isValidTxHash("evm", "0xaabbcc")).toBe(false);
  });

  it("rejects a hash that is too long", () => {
    expect(isValidTxHash("evm", VALID_EVM_HASH + "aa")).toBe(false);
  });

  it("rejects a hash without 0x prefix", () => {
    expect(isValidTxHash("evm", VALID_EVM_HASH.slice(2))).toBe(false);
  });

  it("rejects non-hex characters", () => {
    const bad = "0x" + "g".repeat(64);
    expect(isValidTxHash("evm", bad)).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isValidTxHash("evm", "")).toBe(false);
  });
});

describe("isValidTxHash — Stellar", () => {
  it("accepts a valid 64-char uppercase hex hash", () => {
    expect(isValidTxHash("stellar", VALID_STELLAR_HASH)).toBe(true);
  });

  it("rejects lowercase Stellar hash", () => {
    expect(isValidTxHash("stellar", VALID_STELLAR_HASH.toLowerCase())).toBe(false);
  });

  it("rejects a hash with 0x prefix", () => {
    expect(isValidTxHash("stellar", "0x" + VALID_STELLAR_HASH)).toBe(false);
  });

  it("rejects a hash that is too short", () => {
    expect(isValidTxHash("stellar", VALID_STELLAR_HASH.slice(0, 32))).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isValidTxHash("stellar", "")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// normalizeEvmTxHash
// ─────────────────────────────────────────────────────────────────────────────

describe("normalizeEvmTxHash", () => {
  it("returns lowercase hash unchanged when already canonical", () => {
    expect(normalizeEvmTxHash(VALID_EVM_HASH)).toBe(VALID_EVM_HASH);
  });

  it("lowercases a mixed-case hash", () => {
    const mixed = VALID_EVM_HASH.replace("0x", "0x").toUpperCase().replace("0X", "0x");
    const result = normalizeEvmTxHash(mixed);
    expect(result).toBe(VALID_EVM_HASH);
  });

  it("returns null for the all-zeros sentinel", () => {
    expect(normalizeEvmTxHash(ZERO_EVM_HASH)).toBeNull();
  });

  it("returns null for a malformed hash", () => {
    expect(normalizeEvmTxHash("not-a-hash")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(normalizeEvmTxHash("")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getChain / listChains / listActiveChains
// ─────────────────────────────────────────────────────────────────────────────

describe("getChain", () => {
  it("returns the Ethereum Mainnet descriptor for chainId 1", () => {
    const chain = getChain(1);
    expect(chain).toBeDefined();
    expect(chain!.name).toBe("Ethereum Mainnet");
    expect(chain!.family).toBe("evm");
    expect(chain!.active).toBe(true);
  });

  it("returns Stellar Mainnet for chainId 0", () => {
    const chain = getChain(0);
    expect(chain).toBeDefined();
    expect(chain!.family).toBe("stellar");
  });

  it("returns undefined for an unregistered chainId", () => {
    expect(getChain(999_999_999)).toBeUndefined();
  });

  it("returns a copy — mutating the result does not affect the registry", () => {
    const chain = getChain(1)!;
    chain.name = "MUTATED";
    expect(getChain(1)!.name).toBe("Ethereum Mainnet");
  });
});

describe("listChains", () => {
  it("includes all built-in chains", () => {
    const ids = listChains().map((c) => c.chainId);
    expect(ids).toContain(1);   // Ethereum
    expect(ids).toContain(137); // Polygon
    expect(ids).toContain(0);   // Stellar Mainnet
    expect(ids).toContain(100); // Stellar Testnet
  });

  it("returns copies — mutations do not propagate", () => {
    const first = listChains();
    first[0].name = "HACKED";
    const second = listChains();
    expect(second.find((c) => c.name === "HACKED")).toBeUndefined();
  });
});

describe("listActiveChains", () => {
  it("returns only active chains", () => {
    const all = listActiveChains();
    expect(all.every((c) => c.active)).toBe(true);
  });

  it("excludes an inactive chain after updateChain", () => {
    registerChain(makeTestChain(TEST_CHAIN_ID, { active: false }));
    const active = listActiveChains();
    expect(active.find((c) => c.chainId === TEST_CHAIN_ID)).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// registerChain / updateChain / unregisterChain
// ─────────────────────────────────────────────────────────────────────────────

describe("registerChain", () => {
  it("adds a new chain to the registry", () => {
    registerChain(makeTestChain(TEST_CHAIN_ID));
    const chain = getChain(TEST_CHAIN_ID);
    expect(chain).toBeDefined();
    expect(chain!.name).toBe(`Test Chain ${TEST_CHAIN_ID}`);
  });

  it("stores a copy — mutating the descriptor after registration has no effect", () => {
    const desc = makeTestChain(TEST_CHAIN_ID);
    registerChain(desc);
    desc.name = "MUTATED AFTER REGISTRATION";
    expect(getChain(TEST_CHAIN_ID)!.name).toBe(`Test Chain ${TEST_CHAIN_ID}`);
  });

  it("throws DuplicateChainError when the chainId already exists", () => {
    registerChain(makeTestChain(TEST_CHAIN_ID));
    expect(() => registerChain(makeTestChain(TEST_CHAIN_ID))).toThrowError(
      DuplicateChainError,
    );
  });
});

describe("updateChain", () => {
  beforeEach(() => {
    registerChain(makeTestChain(TEST_CHAIN_ID));
  });

  it("updates the specified fields", () => {
    updateChain(TEST_CHAIN_ID, { name: "Updated", active: false });
    const chain = getChain(TEST_CHAIN_ID)!;
    expect(chain.name).toBe("Updated");
    expect(chain.active).toBe(false);
  });

  it("does not modify unspecified fields", () => {
    const before = getChain(TEST_CHAIN_ID)!;
    updateChain(TEST_CHAIN_ID, { name: "Renamed" });
    const after = getChain(TEST_CHAIN_ID)!;
    expect(after.explorerBaseUrl).toBe(before.explorerBaseUrl);
  });

  it("throws ChainNotFoundError for an unregistered chainId", () => {
    expect(() => updateChain(999_888_777, { name: "Ghost" })).toThrowError(
      ChainNotFoundError,
    );
  });
});

describe("unregisterChain", () => {
  it("removes the chain from the registry", () => {
    registerChain(makeTestChain(TEST_CHAIN_ID));
    unregisterChain(TEST_CHAIN_ID);
    expect(getChain(TEST_CHAIN_ID)).toBeUndefined();
  });

  it("throws ChainNotFoundError when the chain is not registered", () => {
    expect(() => unregisterChain(555_555_555)).toThrowError(ChainNotFoundError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// explorerTxUrl
// ─────────────────────────────────────────────────────────────────────────────

describe("explorerTxUrl", () => {
  it("generates the correct Etherscan URL for Ethereum Mainnet", () => {
    const url = explorerTxUrl(1, VALID_EVM_HASH);
    expect(url).toBe(`https://etherscan.io/tx/${VALID_EVM_HASH}`);
  });

  it("generates the correct Stellar Explorer URL for Stellar Testnet", () => {
    const url = explorerTxUrl(100, VALID_STELLAR_HASH);
    expect(url).toBe(
      `https://stellar.expert/explorer/testnet/tx/${VALID_STELLAR_HASH}`,
    );
  });

  it("generates the correct URL for a custom chain", () => {
    registerChain(
      makeTestChain(TEST_CHAIN_ID, {
        explorerBaseUrl: "https://custom-explorer.io",
        explorerTxPath: "/transaction/{hash}",
      }),
    );
    const url = explorerTxUrl(TEST_CHAIN_ID, VALID_EVM_HASH);
    expect(url).toBe(`https://custom-explorer.io/transaction/${VALID_EVM_HASH}`);
  });

  it("throws ChainNotFoundError for an unregistered chainId", () => {
    expect(() => explorerTxUrl(999_111_222, "anything")).toThrowError(
      ChainNotFoundError,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// broadcastTransaction — happy paths
// ─────────────────────────────────────────────────────────────────────────────

describe("broadcastTransaction — happy paths", () => {
  const payload: BroadcastPayload = { encodedTx: "0xdeadbeef" };

  it("returns a BroadcastResult with a valid EVM hash", async () => {
    const transport = makeTransport(VALID_EVM_HASH, 19_000_000);
    const result = await broadcastTransaction(1, payload, transport);
    expect(result.chainId).toBe(1);
    expect(result.txHash).toBe(VALID_EVM_HASH);
    expect(result.blockNumber).toBe(19_000_000);
  });

  it("returns a BroadcastResult with a valid Stellar hash", async () => {
    const transport = makeTransport(VALID_STELLAR_HASH);
    const result = await broadcastTransaction(0, payload, transport);
    expect(result.chainId).toBe(0);
    expect(result.txHash).toBe(VALID_STELLAR_HASH);
  });

  it("calls transport.broadcast with the correct chain descriptor", async () => {
    const transport = makeTransport(VALID_EVM_HASH);
    await broadcastTransaction(1, payload, transport);
    expect(transport.broadcast).toHaveBeenCalledOnce();
    const [calledChain, calledPayload] = (transport.broadcast as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(calledChain.chainId).toBe(1);
    expect(calledPayload).toBe(payload);
  });

  it("passes optional meta through to the transport", async () => {
    const transport = makeTransport(VALID_EVM_HASH);
    const richPayload: BroadcastPayload = {
      encodedTx: "0xdeadbeef",
      meta: { gasLimit: 21000 },
    };
    await broadcastTransaction(1, richPayload, transport);
    const [, calledPayload] = (transport.broadcast as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(calledPayload.meta).toEqual({ gasLimit: 21000 });
  });

  it("propagates confirmedAt from the transport when present", async () => {
    const ts = "2025-09-25T07:00:00.000Z";
    const transport: ChainTransport = {
      broadcast: vi.fn().mockResolvedValue({
        txHash: VALID_EVM_HASH,
        confirmedAt: ts,
      }),
    };
    const result = await broadcastTransaction(1, payload, transport);
    expect(result.confirmedAt).toBe(ts);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// broadcastTransaction — error / edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe("broadcastTransaction — edge cases and errors", () => {
  const payload: BroadcastPayload = { encodedTx: "0xdeadbeef" };

  it("throws ChainNotFoundError for an unregistered chainId", async () => {
    const transport = makeTransport(VALID_EVM_HASH);
    await expect(
      broadcastTransaction(999_999_888, payload, transport),
    ).rejects.toThrow(ChainNotFoundError);
    expect(transport.broadcast).not.toHaveBeenCalled();
  });

  it("throws ChainInactiveError for an inactive chain", async () => {
    registerChain(makeTestChain(TEST_CHAIN_ID, { active: false }));
    const transport = makeTransport(VALID_EVM_HASH);
    await expect(
      broadcastTransaction(TEST_CHAIN_ID, payload, transport),
    ).rejects.toThrow(ChainInactiveError);
    expect(transport.broadcast).not.toHaveBeenCalled();
  });

  it("throws InvalidTxHashError when transport returns the all-zeros EVM sentinel", async () => {
    // Companion bug fix: transports that return 0x000...000 must be rejected
    const transport = makeTransport(ZERO_EVM_HASH);
    await expect(broadcastTransaction(1, payload, transport)).rejects.toThrow(
      InvalidTxHashError,
    );
  });

  it("throws InvalidTxHashError when transport returns an empty string", async () => {
    const transport = makeTransport("");
    await expect(broadcastTransaction(1, payload, transport)).rejects.toThrow(
      InvalidTxHashError,
    );
  });

  it("throws InvalidTxHashError when transport returns a Stellar hash on an EVM chain", async () => {
    // Wrong format for the chain family
    const transport = makeTransport(VALID_STELLAR_HASH);
    await expect(broadcastTransaction(1, payload, transport)).rejects.toThrow(
      InvalidTxHashError,
    );
  });

  it("throws InvalidTxHashError when transport returns an EVM hash on a Stellar chain", async () => {
    const transport = makeTransport(VALID_EVM_HASH);
    await expect(broadcastTransaction(0, payload, transport)).rejects.toThrow(
      InvalidTxHashError,
    );
  });

  it("re-throws transport errors as-is", async () => {
    const transport: ChainTransport = {
      broadcast: vi.fn().mockRejectedValue(new Error("network timeout")),
    };
    await expect(broadcastTransaction(1, payload, transport)).rejects.toThrow(
      "network timeout",
    );
  });

  it("does not swallow unexpected transport error types", async () => {
    const transport: ChainTransport = {
      broadcast: vi.fn().mockRejectedValue("raw string error"),
    };
    await expect(broadcastTransaction(1, payload, transport)).rejects.toBe(
      "raw string error",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Error class properties
// ─────────────────────────────────────────────────────────────────────────────

describe("Error class shapes", () => {
  it("ChainNotFoundError has the correct name and message", () => {
    const err = new ChainNotFoundError(42);
    expect(err.name).toBe("ChainNotFoundError");
    expect(err.message).toContain("42");
    expect(err).toBeInstanceOf(Error);
  });

  it("ChainInactiveError has the correct name and message", () => {
    const err = new ChainInactiveError(42);
    expect(err.name).toBe("ChainInactiveError");
    expect(err.message).toContain("42");
  });

  it("InvalidTxHashError exposes chainId, family, and received", () => {
    const err = new InvalidTxHashError(1, "evm", "bad-hash");
    expect(err.name).toBe("InvalidTxHashError");
    expect(err.chainId).toBe(1);
    expect(err.family).toBe("evm");
    expect(err.received).toBe("bad-hash");
    expect(err.message).toContain("bad-hash");
  });

  it("DuplicateChainError has the correct name and message", () => {
    const err = new DuplicateChainError(1);
    expect(err.name).toBe("DuplicateChainError");
    expect(err.message).toContain("1");
  });
});
