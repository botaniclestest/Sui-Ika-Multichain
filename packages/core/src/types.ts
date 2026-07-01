/**
 * Shared domain types for the Mythos policy wallet.
 *
 * Chain keys are stable byte-string identifiers stored on-chain, e.g.
 *   "btc:mainnet", "btc:testnet", "eip155:1", "eip155:8453",
 *   "solana:mainnet", "sui:vault".
 */

export const ChainKind = {
  Btc: 0,
  Evm: 1,
  Solana: 2,
  SuiVault: 3,
  Generic: 4,
} as const;
export type ChainKindValue = (typeof ChainKind)[keyof typeof ChainKind];

export const RequestStatus = {
  Pending: 0,
  Executed: 1,
  Rejected: 2,
  Cancelled: 3,
  Expired: 4,
} as const;
export type RequestStatusValue = (typeof RequestStatus)[keyof typeof RequestStatus];

export const ProposalAction = {
  AddSigner: 1,
  RemoveSigner: 2,
  SetThresholds: 3,
  SetTimelocks: 4,
  SetExpiry: 5,
  SetChainLimits: 6,
  AllowlistAdd: 7,
  AllowlistRemove: 8,
  BlocklistAdd: 9,
  BlocklistRemove: 10,
  Unpause: 11,
  SetAddressBook: 12,
  SetChainEnabled: 13,
  SetAllowlistEnabled: 14,
  SetAllowUnverified: 15,
  WithdrawReserves: 16,
  SetAssetLimits: 17,
  RemoveAssetLimits: 18,
} as const;
export type ProposalActionValue = (typeof ProposalAction)[keyof typeof ProposalAction];

/** Ika curve / algorithm / hash identifiers used by the contract. */
export const IkaCurve = { Secp256k1: 0, Secp256r1: 1, Ed25519: 2 } as const;
export const IkaSigAlg = { Ecdsa: 0, Taproot: 1, Eddsa: 0 } as const;
export const IkaHash = {
  Keccak256: 0,
  Sha256: 1,
  DoubleSha256: 2,
  Sha512: 0,
} as const;

export interface ChainPolicyState {
  chainKey: string;
  kind: ChainKindValue;
  enabled: boolean;
  evmChainId: bigint;
  curve: number;
  signatureAlgorithm: number;
  hashScheme: number;
  fastPathLimit: bigint;
  perTxLimit: bigint;
  windowLimit: bigint;
  windowMs: bigint;
  spentInWindow: bigint;
  windowStartedAtMs: bigint;
  feeLimit: bigint;
  allowlistEnabled: boolean;
  allowlist: string[]; // hex destinations
  blocklist: string[];
  allowUnverified: boolean;
}

/**
 * Per-asset limit override (dynamic field on the wallet object).
 * Non-native assets (ERC-20 / SPL / non-SUI vault coins) with NO override
 * are UNLIMITED by design: token base units are incomparable to native
 * chain units, so they always require the full threshold + spend timelock
 * until governance sets token-denominated limits.
 */
export interface AssetPolicyState {
  chainKey: string;
  /** hex of the asset bytes (ERC-20 address / SPL mint / Sui coin type). */
  assetHex: string;
  fastPathLimit: bigint;
  perTxLimit: bigint;
  windowLimit: bigint;
  windowMs: bigint;
  spentInWindow: bigint;
  windowStartedAtMs: bigint;
}

export interface SpendRequestState {
  id: bigint;
  creator: string;
  chainKey: string;
  asset: Uint8Array;
  destination: Uint8Array;
  amount: bigint;
  verifiedIntent: boolean;
  messages: Uint8Array[];
  aux: Uint8Array[];
  /** PartialUserSignature ids locked into the request (network-verified
   *  asynchronously after creation; must be Completed before execution). */
  partialSigIds: string[];
  curve: number;
  signatureAlgorithm: number;
  hashScheme: number;
  approvals: string[];
  rejections: string[];
  createdAtMs: bigint;
  thresholdReachedAtMs: bigint;
  status: RequestStatusValue;
  signIds: string[];
}

export interface AdminProposalState {
  id: bigint;
  creator: string;
  action: ProposalActionValue;
  chainKey: string;
  addrParam: string | null;
  bytesParam: Uint8Array;
  uParams: bigint[];
  boolParam: boolean;
  approvals: string[];
  rejections: string[];
  createdAtMs: bigint;
  thresholdReachedAtMs: bigint;
  status: RequestStatusValue;
}

export interface PresignPoolEntry {
  /** UnverifiedPresignCap object id (pinned by create_spend_request). */
  capId: string;
  /** Inner presign session id (poll Ika for Completed to get bytes). */
  presignId: string;
}

export interface DWalletInfo {
  curve: number;
  dwalletId: string;
  /** Raw public key bytes recovered from the Ika DWallet public output. */
  publicKey: Uint8Array;
}

export interface PolicyWalletState {
  walletId: string;
  creator: string;
  signers: string[];
  threshold: bigint;
  adminThreshold: bigint;
  timelockSpendMs: bigint;
  timelockAdminMs: bigint;
  requestExpiryMs: bigint;
  paused: boolean;
  setupComplete: boolean;
  networkEncryptionKeyId: string;
  ikaBalance: bigint;
  suiBalance: bigint;
  requestCounter: bigint;
  proposalCounter: bigint;
  /** curve -> dwallet id (caps live inside the wallet, never leave). */
  dwallets: Map<number, string>;
  /** chainKey -> recorded identity bytes (BTC scriptPubKey / EVM addr / SOL pubkey). */
  addressBook: Map<string, Uint8Array>;
  chains: Map<string, ChainPolicyState>;
  /** presign pools: `${curve}:${alg}` -> caps in pool order. */
  presignPools: Map<string, PresignPoolEntry[]>;
  /** per-asset limit overrides: `${chainKey}:${assetHex}` -> policy. */
  assetPolicies: Map<string, AssetPolicyState>;
}

/** A spend the user wants to make, before tx construction. */
export interface SpendIntent {
  chainKey: string;
  /** empty = native asset; ERC-20 contract address bytes otherwise. */
  asset: Uint8Array;
  destination: Uint8Array;
  amount: bigint;
}

/** Everything needed to submit `create_spend_request` for an Ika chain. */
export interface PreparedSpend {
  intent: SpendIntent;
  /** Exact bytes Ika will sign (1 per BTC input; exactly 1 for EVM/Solana). */
  messages: Uint8Array[];
  /** Chain-specific context: BTC = [outputsBytes, prevoutsBytes]. */
  aux: Uint8Array[];
  /** Whether this payload is on-chain verifiable (false => unverified path). */
  verifiable: boolean;
  /** Opaque adapter context needed later to assemble the final transaction. */
  assembly: unknown;
}
