import {
  SessionBuilder,
  SessionCipher,
  SignalProtocolAddress,
  type DeviceType,
} from "@privacyresearch/libsignal-protocol-typescript";

import {
  ackE2EEPendingMessage,
  fetchE2EEDeviceBundles,
  fetchE2EEPendingMessages,
  sendE2EEPendingMessage,
  uploadE2EEDeviceKeys,
  type E2EEDeviceBundle,
  type E2EEPendingMessage,
} from "./api";
import { DB, type LocalDeviceState, type LocalE2EEMessage } from "../database";
import { signalStore } from "../store/SignalStore";
import {
  arrayBufferToBase64,
  arrayBufferToUtf8,
  base64ToArrayBuffer,
  createUuid,
  utf8ToArrayBuffer,
} from "../utils/CryptoHelpers";
import { supabase } from "../supabase";

const INITIAL_PREKEY_BATCH = 100;
const PREKEY_REPLENISH_THRESHOLD = 20;
const PREKEY_REPLENISH_BATCH = 100;

export type PeerBundle = {
  userId: string;
  deviceId: string;
  signalDeviceId: number;
  registrationId: number;
  bundle: DeviceType<ArrayBuffer>;
};

export type SendEncryptedMessageInput = {
  peerUserId: string;
  plaintext: string;
  chatId?: string | null;
  clientMessageId?: string;
  targetDeviceIds?: string[];
};

export type DecryptedPendingMessage = {
  pendingMessageId: string;
  peerUserId: string;
  plaintext: string;
  createdAt: number;
  messageType: number;
};

export class E2EEChatService {
  async uploadMyKeys(): Promise<LocalDeviceState> {
    const userId = await this.getCurrentUserId();
    const localDeviceState = await this.ensureLocalDeviceState(userId);
    const isFirstUpload = localDeviceState.signalDeviceId == null;

    const accountState = await signalStore.initializeAccountState();
    const preKeys = isFirstUpload
      ? (await signalStore.initializeProtocolState({
        preKeyStartId: 1,
        preKeyCount: INITIAL_PREKEY_BATCH,
      })).preKeys
      : await signalStore.replenishPreKeys(
        PREKEY_REPLENISH_THRESHOLD,
        PREKEY_REPLENISH_BATCH,
      );

    const response = await uploadE2EEDeviceKeys({
      device_id: localDeviceState.deviceId,
      registration_id: accountState.registrationId,
      identity_key: arrayBufferToBase64(accountState.identityKeyPair.pubKey),
      signed_prekey: {
        key_id: accountState.signedPreKey.keyId,
        public_key: arrayBufferToBase64(accountState.signedPreKey.keyPair.pubKey),
        signature: arrayBufferToBase64(accountState.signedPreKey.signature),
      },
      one_time_prekeys: preKeys.map((preKey) => ({
        key_id: preKey.keyId,
        public_key: arrayBufferToBase64(preKey.keyPair.pubKey),
      })),
    });

    await DB.saveLocalDeviceState(userId, response.device_id, response.signal_device_id);
    return {
      userId,
      deviceId: response.device_id,
      signalDeviceId: response.signal_device_id,
      updatedAt: Date.now(),
    };
  }

  async fetchPeerBundles(peerUserId: string): Promise<PeerBundle[]> {
    const bundles = await fetchE2EEDeviceBundles(peerUserId);
    return bundles.map((bundle) => this.mapPeerBundle(peerUserId, bundle));
  }

  async sendEncryptedMessage(input: SendEncryptedMessageInput): Promise<{
    clientMessageId: string;
    deliveries: Array<{ deviceId: string; signalDeviceId: number; messageType: number }>;
  }> {
    const currentUserId = await this.getCurrentUserId();
    const localDeviceState = await this.ensureUploadedDeviceState();
    const peerBundles = await this.fetchPeerBundles(input.peerUserId);
    const targetBundles = input.targetDeviceIds?.length
      ? peerBundles.filter((bundle) => input.targetDeviceIds?.includes(bundle.deviceId))
      : peerBundles;

    if (targetBundles.length === 0) {
      throw new Error("Peer has no registered E2EE device bundles.");
    }

    const clientMessageId = input.clientMessageId ?? createUuid();
    const deliveries: Array<{ deviceId: string; signalDeviceId: number; messageType: number }> = [];
    let firstEnvelope: {
      messageType: number;
      ciphertext: string;
      receiverDeviceId: string;
      receiverSignalDeviceId: number;
    } | null = null;

    for (const bundle of targetBundles) {
      const address = new SignalProtocolAddress(bundle.userId, bundle.signalDeviceId);
      const sessionBuilder = new SessionBuilder(signalStore, address);
      await sessionBuilder.processPreKey(bundle.bundle);

      const sessionCipher = new SessionCipher(signalStore, address);
      const encryptedMessage = await sessionCipher.encrypt(utf8ToArrayBuffer(input.plaintext));

      if (!encryptedMessage.body) {
        throw new Error("libsignal returned an empty ciphertext body.");
      }

      await sendE2EEPendingMessage({
        sender_device_id: localDeviceState.deviceId,
        receiver_device_id: bundle.deviceId,
        message_type: encryptedMessage.type,
        ciphertext: encryptedMessage.body,
        client_message_id: clientMessageId,
      });

      deliveries.push({
        deviceId: bundle.deviceId,
        signalDeviceId: bundle.signalDeviceId,
        messageType: encryptedMessage.type,
      });

      firstEnvelope ??= {
        messageType: encryptedMessage.type,
        ciphertext: encryptedMessage.body,
        receiverDeviceId: bundle.deviceId,
        receiverSignalDeviceId: bundle.signalDeviceId,
      };
    }

    if (firstEnvelope) {
      await DB.saveLocalE2EEMessage({
        id: clientMessageId,
        clientMessageId,
        chatId: input.chatId ?? null,
        peerUserId: input.peerUserId,
        direction: "outbound",
        senderUserId: currentUserId,
        senderDeviceId: localDeviceState.deviceId,
        senderSignalDeviceId: localDeviceState.signalDeviceId,
        receiverDeviceId: firstEnvelope.receiverDeviceId,
        receiverSignalDeviceId: firstEnvelope.receiverSignalDeviceId,
        messageType: firstEnvelope.messageType,
        ciphertext: firstEnvelope.ciphertext,
        plaintext: input.plaintext,
        status: "sent",
        createdAt: Date.now(),
      });
    }

    return {
      clientMessageId,
      deliveries,
    };
  }

  async pollAndDecryptPending(): Promise<DecryptedPendingMessage[]> {
    const localDeviceState = await this.ensureUploadedDeviceState();
    const pendingMessages = await fetchE2EEPendingMessages(localDeviceState.deviceId);
    const decryptedMessages: DecryptedPendingMessage[] = [];

    for (const pendingMessage of pendingMessages) {
      const existingMessage = await DB.getLocalE2EEMessageByPendingId(pendingMessage.id);
      if (existingMessage) {
        await ackE2EEPendingMessage(localDeviceState.deviceId, pendingMessage.id);
        const ackedAt = Date.now();
        await DB.saveLocalE2EEMessage({
          ...existingMessage,
          ackedAt,
          status: "received",
        });
        continue;
      }

      const decrypted = await this.decryptPendingMessage(pendingMessage);
      const storedMessage: LocalE2EEMessage = {
        id: pendingMessage.client_message_id ?? pendingMessage.id,
        pendingMessageId: pendingMessage.id,
        clientMessageId: pendingMessage.client_message_id ?? null,
        peerUserId: pendingMessage.sender_user_id,
        direction: "inbound",
        senderUserId: pendingMessage.sender_user_id,
        senderDeviceId: pendingMessage.sender_device_id,
        senderSignalDeviceId: pendingMessage.sender_signal_device_id,
        receiverDeviceId: pendingMessage.receiver_device_id,
        receiverSignalDeviceId: pendingMessage.receiver_signal_device_id,
        messageType: pendingMessage.message_type,
        ciphertext: pendingMessage.ciphertext,
        plaintext: decrypted,
        status: "received",
        createdAt: Date.parse(pendingMessage.created_at),
        deliveredAt: pendingMessage.delivered_at ? Date.parse(pendingMessage.delivered_at) : null,
      };

      await DB.withTransaction(async () => {
        await DB.saveLocalE2EEMessage(storedMessage);
      });

      await ackE2EEPendingMessage(localDeviceState.deviceId, pendingMessage.id);

      const ackedAt = Date.now();
      await DB.saveLocalE2EEMessage({
        ...storedMessage,
        ackedAt,
      });

      decryptedMessages.push({
        pendingMessageId: pendingMessage.id,
        peerUserId: pendingMessage.sender_user_id,
        plaintext: decrypted,
        createdAt: storedMessage.createdAt,
        messageType: pendingMessage.message_type,
      });
    }

    await this.maybeReplenishPreKeys();
    return decryptedMessages;
  }

  private async decryptPendingMessage(message: E2EEPendingMessage): Promise<string> {
    const remoteAddress = new SignalProtocolAddress(
      message.sender_user_id,
      message.sender_signal_device_id,
    );
    const sessionCipher = new SessionCipher(signalStore, remoteAddress);

    let plaintextBuffer: ArrayBuffer;
    if (message.message_type === 3) {
      plaintextBuffer = await sessionCipher.decryptPreKeyWhisperMessage(message.ciphertext, "binary");
    } else {
      plaintextBuffer = await sessionCipher.decryptWhisperMessage(message.ciphertext, "binary");
    }

    return arrayBufferToUtf8(plaintextBuffer);
  }

  private mapPeerBundle(userId: string, bundle: E2EEDeviceBundle): PeerBundle {
    return {
      userId,
      deviceId: bundle.device_id,
      signalDeviceId: bundle.signal_device_id,
      registrationId: bundle.registration_id,
      bundle: {
        registrationId: bundle.registration_id,
        identityKey: base64ToArrayBuffer(bundle.identity_key),
        signedPreKey: {
          keyId: bundle.signed_prekey.key_id,
          publicKey: base64ToArrayBuffer(bundle.signed_prekey.public_key),
          signature: base64ToArrayBuffer(bundle.signed_prekey.signature),
        },
        preKey: bundle.one_time_prekey
          ? {
            keyId: bundle.one_time_prekey.key_id,
            publicKey: base64ToArrayBuffer(bundle.one_time_prekey.public_key),
          }
          : undefined,
      },
    };
  }

  private async ensureUploadedDeviceState(): Promise<LocalDeviceState> {
    const userId = await this.getCurrentUserId();
    const localDeviceState = await DB.getLocalDeviceState(userId);
    if (localDeviceState?.signalDeviceId != null) {
      return localDeviceState;
    }

    return this.uploadMyKeys();
  }

  private async maybeReplenishPreKeys(): Promise<void> {
    const remainingPreKeys = await signalStore.getRemainingPreKeyCount();
    if (remainingPreKeys < PREKEY_REPLENISH_THRESHOLD) {
      await this.uploadMyKeys();
    }
  }

  private async ensureLocalDeviceState(userId: string): Promise<LocalDeviceState> {
    const existingState = await DB.getLocalDeviceState(userId);
    if (existingState) {
      return existingState;
    }

    const deviceId = createUuid();
    await DB.saveLocalDeviceState(userId, deviceId, null);

    return {
      userId,
      deviceId,
      signalDeviceId: null,
      updatedAt: Date.now(),
    };
  }

  private async getCurrentUserId(): Promise<string> {
    const {
      data: { session },
    } = await supabase.auth.getSession();

    const userId = session?.user?.id;
    if (!userId) {
      throw new Error("No authenticated user.");
    }

    return userId;
  }
}

export const e2eeChatService = new E2EEChatService();
