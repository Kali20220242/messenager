import {
  FingerprintGenerator,
  KeyHelper,
  type KeyPairType,
  type PreKeyPairType,
  type SignedPreKeyPairType,
  Direction,
  setWebCrypto,
} from "@privacyresearch/libsignal-protocol-typescript";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import QuickCrypto, { install as installQuickCrypto } from "react-native-quick-crypto";

import { DB } from "../database";
import { arrayBufferToBase64, base64ToArrayBuffer } from "../utils/CryptoHelpers";

type SerializedKeyPair = {
  pubKey: string;
  privKey: string;
};

type StoredSignedPreKeyBundle = {
  keyPair: SerializedKeyPair;
  signature: string;
};

type ProtocolBootstrapOptions = {
  signedPreKeyId?: number;
  preKeyStartId?: number;
  preKeyCount?: number;
};

type AccountBootstrapOptions = {
  signedPreKeyId?: number;
};

type PublishedPreKeyBundle = {
  registrationId: number;
  identityKey: ArrayBuffer;
  signedPreKey: {
    keyId: number;
    publicKey: ArrayBuffer;
    signature: ArrayBuffer;
  };
  preKeys: Array<{
    keyId: number;
    publicKey: ArrayBuffer;
  }>;
};

export type SafetyNumberState = {
  address: string;
  safetyNumber: string;
  verified: boolean;
  verifiedAt?: number | null;
  identityChanged: boolean;
};

const IDENTITY_KEY = "signal:identity-key";
const REGISTRATION_ID_KEY = "signal:registration-id";
const SAFETY_NUMBER_ITERATIONS = 5200;
const SIGNED_PREKEY_ROTATION_AGE_MS = 1000 * 60 * 60 * 24 * 14;

let runtimeInstalled = false;

function arrayBufferEquals(left: ArrayBuffer, right: ArrayBuffer): boolean {
  const leftBytes = new Uint8Array(left);
  const rightBytes = new Uint8Array(right);

  if (leftBytes.length !== rightBytes.length) {
    return false;
  }

  for (let index = 0; index < leftBytes.length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) {
      return false;
    }
  }

  return true;
}

function serializeKeyPair(keyPair: KeyPairType): string {
  return JSON.stringify({
    pubKey: arrayBufferToBase64(keyPair.pubKey),
    privKey: arrayBufferToBase64(keyPair.privKey),
  } satisfies SerializedKeyPair);
}

function deserializeKeyPair(raw: string): KeyPairType {
  const parsed = JSON.parse(raw) as SerializedKeyPair;

  return {
    pubKey: base64ToArrayBuffer(parsed.pubKey),
    privKey: base64ToArrayBuffer(parsed.privKey),
  };
}

function parseAddress(address: string): { name: string; exact: string } {
  const lastDot = address.lastIndexOf(".");

  if (lastDot === -1) {
    return { name: address, exact: address };
  }

  const maybeDeviceId = address.slice(lastDot + 1);
  if (!/^\d+$/.test(maybeDeviceId)) {
    return { name: address, exact: address };
  }

  return {
    name: address.slice(0, lastDot),
    exact: address,
  };
}

export function installSignalRuntime(): void {
  if (runtimeInstalled || Platform.OS === "web") {
    return;
  }

  installQuickCrypto();
  setWebCrypto((globalThis.crypto as Crypto | undefined) ?? (QuickCrypto as unknown as Crypto));
  runtimeInstalled = true;
}

export class SignalProtocolStore {
  constructor() {
    installSignalRuntime();
  }

  async initializeAccountState(options: AccountBootstrapOptions = {}): Promise<{
    identityKeyPair: KeyPairType;
    registrationId: number;
    signedPreKey: SignedPreKeyPairType;
  }> {
    installSignalRuntime();
    await DB.init();

    const identityKeyPair = await this.ensureIdentityKeyPair();
    const registrationId = await this.ensureRegistrationId();
    const signedPreKey = await this.ensureActiveSignedPreKey(
      identityKeyPair,
      options.signedPreKeyId,
    );

    return {
      identityKeyPair,
      registrationId,
      signedPreKey,
    };
  }

  async initializeProtocolState(options: ProtocolBootstrapOptions = {}): Promise<{
    identityKeyPair: KeyPairType;
    registrationId: number;
    signedPreKey: SignedPreKeyPairType;
    preKeys: PreKeyPairType[];
  }> {
    const { identityKeyPair, registrationId, signedPreKey } = await this.initializeAccountState({
      signedPreKeyId: options.signedPreKeyId,
    });

    const preKeyStartId = options.preKeyStartId ?? 1;
    const preKeyCount = options.preKeyCount ?? 100;
    const preKeys = await this.ensurePreKeys(preKeyStartId, preKeyCount);

    return {
      identityKeyPair,
      registrationId,
      signedPreKey,
      preKeys,
    };
  }

  async getPublishedPreKeyBundle(options: ProtocolBootstrapOptions = {}): Promise<PublishedPreKeyBundle> {
    const { registrationId, identityKeyPair, signedPreKey, preKeys } = await this.initializeProtocolState(options);

    return {
      registrationId,
      identityKey: identityKeyPair.pubKey,
      signedPreKey: {
        keyId: signedPreKey.keyId,
        publicKey: signedPreKey.keyPair.pubKey,
        signature: signedPreKey.signature,
      },
      preKeys: preKeys.map((preKey) => ({
        keyId: preKey.keyId,
        publicKey: preKey.keyPair.pubKey,
      })),
    };
  }

  async getRemainingPreKeyCount(): Promise<number> {
    await DB.init();
    return DB.countPreKeys();
  }

  async generatePreKeys(count: number): Promise<PreKeyPairType[]> {
    if (count <= 0) {
      return [];
    }

    await DB.init();
    const startId = (await DB.getMaxPreKeyId()) + 1;
    return this.ensurePreKeys(startId, count);
  }

  async replenishPreKeys(minimumRemaining: number, replenishCount: number): Promise<PreKeyPairType[]> {
    const remaining = await this.getRemainingPreKeyCount();
    if (remaining >= minimumRemaining) {
      return [];
    }

    return this.generatePreKeys(replenishCount);
  }

  async getIdentityKeyPair(): Promise<KeyPairType | undefined> {
    const keyPairBase64 = await SecureStore.getItemAsync(IDENTITY_KEY);
    if (!keyPairBase64) {
      return undefined;
    }

    return deserializeKeyPair(keyPairBase64);
  }

  async getLocalRegistrationId(): Promise<number | undefined> {
    const registrationId = await SecureStore.getItemAsync(REGISTRATION_ID_KEY);
    return registrationId ? Number.parseInt(registrationId, 10) : undefined;
  }

  async saveLocalRegistrationId(registrationId: number): Promise<void> {
    await SecureStore.setItemAsync(REGISTRATION_ID_KEY, registrationId.toString());
  }

  async saveIdentityKeyPair(keyPair: KeyPairType): Promise<void> {
    await SecureStore.setItemAsync(IDENTITY_KEY, serializeKeyPair(keyPair));
  }

  async loadPreKey(keyId: number | string): Promise<KeyPairType | undefined> {
    await DB.init();
    const keyPairBase64 = await DB.getPreKey(Number(keyId));
    return keyPairBase64 ? deserializeKeyPair(keyPairBase64) : undefined;
  }

  async storePreKey(keyId: number | string, keyPair: KeyPairType): Promise<void> {
    await DB.init();
    await DB.savePreKey(Number(keyId), serializeKeyPair(keyPair));
  }

  async removePreKey(keyId: number | string): Promise<void> {
    await DB.init();
    await DB.deletePreKey(Number(keyId));
  }

  async loadSignedPreKey(keyId: number | string): Promise<KeyPairType | undefined> {
    await DB.init();
    const storedSignedPreKey = await DB.getSignedPreKey(Number(keyId));
    if (!storedSignedPreKey) {
      return undefined;
    }

    const parsed = JSON.parse(storedSignedPreKey) as StoredSignedPreKeyBundle;
    return {
      pubKey: base64ToArrayBuffer(parsed.keyPair.pubKey),
      privKey: base64ToArrayBuffer(parsed.keyPair.privKey),
    };
  }

  async storeSignedPreKey(keyId: number | string, keyPair: KeyPairType): Promise<void> {
    await DB.init();
    const existing = await DB.getSignedPreKeyBundle(Number(keyId));
    const payload = JSON.stringify({
      keyPair: {
        pubKey: arrayBufferToBase64(keyPair.pubKey),
        privKey: arrayBufferToBase64(keyPair.privKey),
      },
      signature: existing?.signature ?? "",
    } satisfies StoredSignedPreKeyBundle);

    await DB.saveSignedPreKey(Number(keyId), payload, existing?.signature ?? "");
  }

  async removeSignedPreKey(keyId: number | string): Promise<void> {
    await DB.init();
    await DB.deleteSignedPreKey(Number(keyId));
  }

  async loadSession(encodedAddress: string): Promise<string | undefined> {
    await DB.init();
    return (await DB.getSession(encodedAddress)) ?? undefined;
  }

  async storeSession(encodedAddress: string, record: string): Promise<void> {
    await DB.init();
    await DB.saveSession(encodedAddress, record);
  }

  async isTrustedIdentity(identifier: string, identityKey: ArrayBuffer, _direction: Direction): Promise<boolean> {
    await DB.init();
    const { name, exact } = parseAddress(identifier);
    const trustedIdentities = await DB.getTrustedIdentitiesForIdentifier(name, exact);

    if (trustedIdentities.length === 0) {
      return true;
    }

    return trustedIdentities.some((entry) => arrayBufferEquals(base64ToArrayBuffer(entry.identityKey), identityKey));
  }

  async saveIdentity(encodedAddress: string, publicKey: ArrayBuffer): Promise<boolean> {
    await DB.init();
    const { exact } = parseAddress(encodedAddress);
    const encodedIdentityKey = arrayBufferToBase64(publicKey);
    const existing = await DB.getTrustedIdentity(exact);

    if (existing && existing.identityKey === encodedIdentityKey) {
      return false;
    }

    await DB.saveTrustedIdentity(exact, encodedIdentityKey);
    await DB.clearIdentityVerification(exact);
    return Boolean(existing && existing.identityKey !== encodedIdentityKey);
  }

  async getSafetyNumber(encodedAddress: string, localIdentifier: string): Promise<SafetyNumberState> {
    await DB.init();
    const identityKeyPair = await this.ensureIdentityKeyPair();
    const { exact } = parseAddress(encodedAddress);
    const remoteIdentity = await DB.getTrustedIdentity(exact);

    if (!remoteIdentity) {
      throw new Error("No trusted identity found for this address.");
    }

    const generator = new FingerprintGenerator(SAFETY_NUMBER_ITERATIONS);
    const safetyNumber = await generator.createFor(
      localIdentifier,
      identityKeyPair.pubKey,
      exact,
      base64ToArrayBuffer(remoteIdentity.identityKey),
    );

    const verification = await DB.getIdentityVerification(exact);
    return {
      address: exact,
      safetyNumber,
      verified: verification?.verified === true && verification.safetyNumber === safetyNumber,
      verifiedAt: verification?.verifiedAt ?? null,
      identityChanged: verification != null && verification.safetyNumber !== safetyNumber,
    };
  }

  async markSafetyNumberVerified(encodedAddress: string, localIdentifier: string): Promise<SafetyNumberState> {
    const safetyNumberState = await this.getSafetyNumber(encodedAddress, localIdentifier);
    const verifiedAt = Date.now();
    await DB.saveIdentityVerification(
      safetyNumberState.address,
      safetyNumberState.safetyNumber,
      true,
      verifiedAt,
    );

    return {
      ...safetyNumberState,
      verified: true,
      verifiedAt,
      identityChanged: false,
    };
  }

  async clearSafetyNumberVerification(encodedAddress: string): Promise<void> {
    await DB.init();
    const { exact } = parseAddress(encodedAddress);
    await DB.clearIdentityVerification(exact);
  }

  async loadSignedPreKeyBundle(keyId: number): Promise<SignedPreKeyPairType | undefined> {
    await DB.init();
    const storedBundle = await DB.getSignedPreKeyBundle(keyId);
    if (!storedBundle) {
      return undefined;
    }

    return {
      keyId,
      keyPair: deserializeKeyPair(storedBundle.key_pair),
      signature: base64ToArrayBuffer(storedBundle.signature),
    };
  }

  async saveSignedPreKeyBundle(bundle: SignedPreKeyPairType): Promise<void> {
    await DB.init();
    const serializedBundle = JSON.stringify({
      keyPair: {
        pubKey: arrayBufferToBase64(bundle.keyPair.pubKey),
        privKey: arrayBufferToBase64(bundle.keyPair.privKey),
      },
      signature: arrayBufferToBase64(bundle.signature),
    } satisfies StoredSignedPreKeyBundle);

    await DB.saveSignedPreKey(bundle.keyId, serializedBundle, arrayBufferToBase64(bundle.signature));
  }

  private async ensureIdentityKeyPair(): Promise<KeyPairType> {
    const existing = await this.getIdentityKeyPair();
    if (existing) {
      return existing;
    }

    const generated = await KeyHelper.generateIdentityKeyPair();
    await this.saveIdentityKeyPair(generated);
    return generated;
  }

  private async ensureRegistrationId(): Promise<number> {
    const existing = await this.getLocalRegistrationId();
    if (typeof existing === "number") {
      return existing;
    }

    const generated = KeyHelper.generateRegistrationId();
    await this.saveLocalRegistrationId(generated);
    return generated;
  }

  private async ensureActiveSignedPreKey(
    identityKeyPair: KeyPairType,
    preferredSignedPreKeyId?: number,
  ): Promise<SignedPreKeyPairType> {
    await DB.init();

    if (preferredSignedPreKeyId != null) {
      const preferred = await this.loadSignedPreKeyBundle(preferredSignedPreKeyId);
      if (preferred) {
        return preferred;
      }

      const generated = await KeyHelper.generateSignedPreKey(identityKeyPair, preferredSignedPreKeyId);
      await this.saveSignedPreKeyBundle(generated);
      return generated;
    }

    const latest = await DB.getLatestSignedPreKey();
    if (latest) {
      const latestBundle = await this.loadSignedPreKeyBundle(latest.id);
      if (latestBundle && Date.now() - latest.createdAt < SIGNED_PREKEY_ROTATION_AGE_MS) {
        return latestBundle;
      }
    }

    const nextKeyId = (latest?.id ?? 0) + 1;
    const generated = await KeyHelper.generateSignedPreKey(identityKeyPair, nextKeyId);
    await this.saveSignedPreKeyBundle(generated);
    return generated;
  }

  private async ensurePreKeys(startId: number, count: number): Promise<PreKeyPairType[]> {
    const existingIds = new Set(await DB.listPreKeyIds());
    const preKeys: PreKeyPairType[] = [];

    for (let offset = 0; offset < count; offset += 1) {
      const keyId = startId + offset;
      const existing = existingIds.has(keyId) ? await this.loadPreKey(keyId) : undefined;

      if (existing) {
        preKeys.push({ keyId, keyPair: existing });
        continue;
      }

      const generated = await KeyHelper.generatePreKey(keyId);
      await this.storePreKey(generated.keyId, generated.keyPair);
      preKeys.push(generated);
    }

    return preKeys;
  }
}

export const signalStore = new SignalProtocolStore();
