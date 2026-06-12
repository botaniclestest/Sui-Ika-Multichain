/**
 * Ika network service: dWallet DKG preparation (shared / public-user-share
 * mode), presign inspection, centralized signature computation and signing
 * result polling.
 *
 * Design note - why "shared mode" dWallets:
 * The policy contract creates the dWallet itself and keeps the DWalletCap
 * forever. The user share is made PUBLIC, so there is no per-user secret to
 * back up, cache or leak; authority reduces entirely to the Sui policy
 * object (threshold/timelocks/limits) plus the Ika network's enforcement of
 * MessageApprovals. This is what makes the wallet recoverable from nothing
 * but a Sui keypair. The tradeoff (vs zero-trust mode) is that you trust
 * the Ika validator threshold not to sign without an approval - acceptable
 * here because that same threshold is what executes ANY signature.
 */

import type { SuiJsonRpcClient as SuiClient } from '@mysten/sui/jsonRpc';
import {
  Curve,
  Hash,
  IkaClient,
  SignatureAlgorithm,
  UserShareEncryptionKeys,
  createRandomSessionIdentifier,
  createUserSignMessageWithPublicOutput,
  getNetworkConfig,
  prepareDKG,
  publicKeyFromDWalletOutput,
} from '@ika.xyz/sdk';
import type { SuiNetwork } from '../config.js';
import { toBytes } from '../codec.js';

export { Curve, Hash, SignatureAlgorithm };

/**
 * Numeric ids used by the Move contracts <-> SDK string enums.
 * (Mirrors the SDK's internal hash-signature-validation tables, which are
 * not re-exported from its index.)
 */
export function curveFromNumber(curve: number): Curve {
  switch (curve) {
    case 0:
      return Curve.SECP256K1;
    case 1:
      return Curve.SECP256R1;
    case 2:
      return Curve.ED25519;
    case 3:
      return Curve.RISTRETTO;
    default:
      throw new Error(`unknown curve number ${curve}`);
  }
}

export function sigAlgFromNumbers(curve: number, alg: number): SignatureAlgorithm {
  if (curve === 0) return alg === 1 ? SignatureAlgorithm.Taproot : SignatureAlgorithm.ECDSASecp256k1;
  if (curve === 1) return SignatureAlgorithm.ECDSASecp256r1;
  if (curve === 2) return SignatureAlgorithm.EdDSA;
  if (curve === 3) return SignatureAlgorithm.SchnorrkelSubstrate;
  throw new Error(`unknown curve/alg ${curve}/${alg}`);
}

export function hashFromNumbers(curve: number, alg: number, hash: number): Hash {
  if (curve === 0 && alg === 0) {
    return ([Hash.KECCAK256, Hash.SHA256, Hash.DoubleSHA256] as Hash[])[hash];
  }
  if (curve === 0 && alg === 1) return Hash.SHA256;
  if (curve === 1) return ([Hash.SHA256, Hash.DoubleSHA256] as Hash[])[hash];
  if (curve === 2) return Hash.SHA512;
  if (curve === 3) return Hash.Merlin;
  throw new Error(`unknown hash ${curve}/${alg}/${hash}`);
}

export interface DkgPreparation {
  centralizedPublicKeyShareAndProof: Uint8Array;
  userPublicOutput: Uint8Array;
  publicUserSecretKeyShare: Uint8Array;
  sessionIdentifier: Uint8Array;
}

export interface ActiveDWallet {
  dwalletId: string;
  publicOutput: Uint8Array;
  publicUserSecretKeyShare: Uint8Array;
  publicKey: Uint8Array;
}

export class IkaService {
  readonly ikaClient: IkaClient;
  readonly network: SuiNetwork;
  #initialized = false;

  constructor(suiClient: SuiClient, network: SuiNetwork) {
    this.network = network;
    this.ikaClient = new IkaClient({
      suiClient: suiClient as never,
      config: getNetworkConfig(network),
    });
  }

  async init(): Promise<void> {
    if (!this.#initialized) {
      await this.ikaClient.initialize();
      this.#initialized = true;
    }
  }

  get coordinatorObjectId(): string {
    const cfg = getNetworkConfig(this.network);
    return cfg.objects.ikaDWalletCoordinator.objectID;
  }

  get ikaCoinType(): string {
    const cfg = getNetworkConfig(this.network);
    return `${cfg.packages.ikaPackage}::ika::IKA`;
  }

  async latestNetworkEncryptionKeyId(): Promise<string> {
    await this.init();
    const key = await this.ikaClient.getLatestNetworkEncryptionKey();
    return key.id;
  }

  /**
   * Prepares the client-side DKG material for a SHARED (public user share)
   * dWallet. The encryption keys used here are ephemeral randomness: the
   * resulting share is public by design and nothing from this step needs to
   * be stored.
   */
  async prepareSharedDkg(curve: Curve, senderAddress: string): Promise<DkgPreparation> {
    await this.init();
    const sessionIdentifier = createRandomSessionIdentifier();
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const ephemeralKeys = await UserShareEncryptionKeys.fromRootSeedKey(seed, curve);
    // Protocol parameters are CURVE-SPECIFIC; omitting the curve silently
    // returns secp256k1 parameters and breaks ed25519 DKG preparation.
    const protocolPublicParameters = await this.ikaClient.getProtocolPublicParameters(
      undefined,
      curve,
    );
    const result = await prepareDKG(
      protocolPublicParameters,
      curve,
      ephemeralKeys.encryptionKey,
      sessionIdentifier,
      senderAddress,
    );
    return {
      centralizedPublicKeyShareAndProof: toBytes(result.userDKGMessage),
      userPublicOutput: toBytes(result.userPublicOutput),
      publicUserSecretKeyShare: toBytes(result.userSecretKeyShare),
      sessionIdentifier,
    };
  }

  /** Waits for a dWallet to be Active and returns its public material. */
  async getActiveDWallet(dwalletId: string): Promise<ActiveDWallet> {
    await this.init();
    const dwallet = await this.ikaClient.getDWalletInParticularState(dwalletId, 'Active', {
      timeout: 120_000,
      interval: 2_000,
    });
    const state = (dwallet as { state: { Active: { public_output: number[] | Uint8Array } } })
      .state;
    const publicOutput = toBytes(state.Active.public_output);
    const share = (dwallet as { public_user_secret_key_share?: number[] | Uint8Array | null })
      .public_user_secret_key_share;
    const publicKey = await publicKeyFromDWalletOutput(
      curveFromNumber((dwallet as { curve: number }).curve),
      publicOutput,
    );
    return {
      dwalletId,
      publicOutput,
      publicUserSecretKeyShare: share ? toBytes(share) : new Uint8Array(),
      publicKey: toBytes(publicKey),
    };
  }

  /** Resolves an UnverifiedPresignCap object id -> inner presign session id. */
  async presignIdFromCap(suiClient: SuiClient, presignCapId: string): Promise<string> {
    const obj = await suiClient.getObject({ id: presignCapId, options: { showContent: true } });
    const content = obj.data?.content;
    if (!content || content.dataType !== 'moveObject') {
      throw new Error(`presign cap ${presignCapId} not found`);
    }
    const fields = content.fields as { presign_id: string };
    return fields.presign_id;
  }

  /** Waits for a presign to complete and returns its bytes. */
  async getCompletedPresignBytes(presignId: string): Promise<Uint8Array> {
    await this.init();
    const presign = await this.ikaClient.getPresignInParticularState(presignId, 'Completed', {
      timeout: 120_000,
      interval: 2_000,
    });
    const state = (presign as { state: { Completed: { presign: number[] | Uint8Array } } }).state;
    return toBytes(state.Completed.presign);
  }

  /**
   * Computes the user-side (centralized) partial signature over `message`
   * for a shared dWallet. Pure computation - no secrets involved beyond the
   * already-public user share.
   */
  async computeCentralizedSignature(params: {
    dwallet: ActiveDWallet;
    presignBytes: Uint8Array;
    message: Uint8Array;
    hash: Hash;
    signatureAlgorithm: SignatureAlgorithm;
    curve: Curve;
  }): Promise<Uint8Array> {
    await this.init();
    const protocolPublicParameters = await this.ikaClient.getProtocolPublicParameters(
      undefined,
      params.curve,
    );
    const signature = await createUserSignMessageWithPublicOutput(
      protocolPublicParameters,
      params.dwallet.publicOutput,
      params.dwallet.publicUserSecretKeyShare,
      params.presignBytes,
      params.message,
      params.hash,
      params.signatureAlgorithm,
      params.curve,
    );
    return toBytes(signature);
  }

  /**
   * Waits until the network has verified a future-sign partial signature.
   * `execute_spend` aborts (EUnverifiedCap) until every partial signature
   * locked in the request reaches this state - typically a few seconds
   * after request creation.
   */
  async waitForPartialSignatureVerified(partialSigId: string): Promise<void> {
    await this.init();
    await this.ikaClient.getPartialUserSignatureInParticularState(
      partialSigId,
      'NetworkVerificationCompleted',
      { timeout: 120_000, interval: 2_000 },
    );
  }

  /** Polls a sign session until Completed; returns the 64-byte signature. */
  async waitForSignature(
    signId: string,
    curve: Curve,
    signatureAlgorithm: SignatureAlgorithm,
  ): Promise<Uint8Array> {
    await this.init();
    const sign = await this.ikaClient.getSignInParticularState(
      signId,
      curve,
      signatureAlgorithm,
      'Completed',
      { timeout: 120_000, interval: 2_000 },
    );
    const state = (sign as { state: { Completed: { signature: number[] | Uint8Array } } }).state;
    return toBytes(state.Completed.signature);
  }
}
