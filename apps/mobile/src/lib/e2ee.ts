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

type E2EEEventKind = "message" | "edit" | "delete" | "receipt";
type E2EEReceiptStatus = "delivered" | "seen";

type E2EEMessageEnvelope = {
  event_id: string;
  kind: E2EEEventKind;
  sent_at: string;
  chat_id?: string | null;
  body?: string;
  target_client_message_id?: string | null;
  reply_to_client_message_id?: string | null;
  reply_to_preview?: string | null;
  forwarded_from_client_message_id?: string | null;
  forwarded_from_preview?: string | null;
  receipt_status?: E2EEReceiptStatus;
};

type E2EEEventSummary = {
  event_type: E2EEEventKind;
  preview_text?: string | null;
  target_client_message_id?: string | null;
};

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
  replyToMessage?: {
    clientMessageId: string;
    preview: string;
  } | null;
  forwardedFromMessage?: {
    clientMessageId: string;
    preview: string;
  } | null;
};

export type DecryptedPendingMessage = {
  pendingMessageId: string;
  chatId?: string | null;
  peerUserId: string;
  plaintext: string;
  createdAt: number;
  messageType: number;
  kind: E2EEEventKind;
  targetClientMessageId?: string | null;
};

export type SafetyNumber = {
  address: string;
  safetyNumber: string;
  verified: boolean;
  verifiedAt?: number | null;
  identityChanged: boolean;
};

export type SendE2EEEditInput = {
  peerUserId: string;
  chatId: string;
  targetClientMessageId: string;
  plaintext: string;
};

export type SendE2EEDeleteInput = {
  peerUserId: string;
  chatId: string;
  targetClientMessageId: string;
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
    const envelope: E2EEMessageEnvelope = {
      event_id: clientMessageId,
      kind: "message",
      chat_id: input.chatId ?? null,
      body: input.plaintext,
      sent_at: new Date().toISOString(),
      reply_to_client_message_id: input.replyToMessage?.clientMessageId ?? null,
      reply_to_preview: input.replyToMessage?.preview ?? null,
      forwarded_from_client_message_id: input.forwardedFromMessage?.clientMessageId ?? null,
      forwarded_from_preview: input.forwardedFromMessage?.preview ?? null,
    };
    const deliveries: Array<{ deviceId: string; signalDeviceId: number; messageType: number }> = [];
    let firstEnvelope: {
      messageType: number;
      ciphertext: string;
      receiverDeviceId: string;
      receiverSignalDeviceId: number;
    } | null = null;

    for (const bundle of targetBundles) {
      const encryptedMessage = await this.encryptEnvelopeForPeerBundle(bundle, envelope);

      if (!encryptedMessage.body) {
        throw new Error("libsignal returned an empty ciphertext body.");
      }

      await sendE2EEPendingMessage({
        sender_device_id: localDeviceState.deviceId,
        receiver_device_id: bundle.deviceId,
        chat_id: input.chatId ?? null,
        message_type: encryptedMessage.type,
        ciphertext: encryptedMessage.body,
        client_message_id: clientMessageId,
        event_summary: this.buildEventSummary(envelope),
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
        replyToClientMessageId: envelope.reply_to_client_message_id ?? null,
        replyToPreview: envelope.reply_to_preview ?? null,
        forwardedFromClientMessageId: envelope.forwarded_from_client_message_id ?? null,
        forwardedFromPreview: envelope.forwarded_from_preview ?? null,
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
      const existingEvent = await DB.getProcessedE2EEEventByPendingId(pendingMessage.id);
      if (existingEvent) {
        await ackE2EEPendingMessage(localDeviceState.deviceId, pendingMessage.id);
        continue;
      }

      const { envelope, plaintext } = await this.decryptPendingMessage(pendingMessage);
      const shouldSendDeliveredReceipt = envelope.kind === "message";

      await DB.withTransaction(async () => {
        await this.applyDecryptedEnvelope(pendingMessage, envelope, plaintext);
      });

      await ackE2EEPendingMessage(localDeviceState.deviceId, pendingMessage.id);

      decryptedMessages.push({
        pendingMessageId: pendingMessage.id,
        chatId: pendingMessage.chat_id ?? null,
        peerUserId: pendingMessage.sender_user_id,
        plaintext,
        createdAt: Date.parse(envelope.sent_at || pendingMessage.created_at),
        messageType: pendingMessage.message_type,
        kind: envelope.kind,
        targetClientMessageId: envelope.target_client_message_id ?? null,
      });

      if (shouldSendDeliveredReceipt && pendingMessage.chat_id) {
        await this.sendReceiptForInboundMessage(
          pendingMessage.sender_user_id,
          pendingMessage.chat_id,
          pendingMessage.client_message_id ?? envelope.event_id,
          "delivered",
          pendingMessage.sender_device_id,
          pendingMessage.sender_signal_device_id,
        );
      }
    }

    await this.maybeReplenishPreKeys();
    return decryptedMessages;
  }

  async getSafetyNumber(peerUserId: string, signalDeviceId: number): Promise<SafetyNumber> {
    const currentUserId = await this.getCurrentUserId();
    const address = new SignalProtocolAddress(peerUserId, signalDeviceId);
    return signalStore.getSafetyNumber(address.toString(), currentUserId);
  }

  async verifySafetyNumber(peerUserId: string, signalDeviceId: number): Promise<SafetyNumber> {
    const currentUserId = await this.getCurrentUserId();
    const address = new SignalProtocolAddress(peerUserId, signalDeviceId);
    return signalStore.markSafetyNumberVerified(address.toString(), currentUserId);
  }

  async clearSafetyNumberVerification(peerUserId: string, signalDeviceId: number): Promise<void> {
    const address = new SignalProtocolAddress(peerUserId, signalDeviceId);
    await signalStore.clearSafetyNumberVerification(address.toString());
  }

  async sendEditMessage(input: SendE2EEEditInput): Promise<void> {
    const targetMessage = await DB.getLocalE2EEMessageByClientMessageId(input.targetClientMessageId);
    if (!targetMessage) {
      throw new Error("Target message for edit was not found locally.");
    }

    const eventId = createUuid();
    const envelope: E2EEMessageEnvelope = {
      event_id: eventId,
      kind: "edit",
      chat_id: input.chatId,
      body: input.plaintext,
      target_client_message_id: input.targetClientMessageId,
      sent_at: new Date().toISOString(),
    };

    await this.sendEnvelopeToPeer(input.peerUserId, input.chatId, envelope);
    await DB.saveLocalE2EEMessage({
      ...targetMessage,
      plaintext: input.plaintext,
      editedAt: Date.now(),
    });
  }

  async sendDeleteMessage(input: SendE2EEDeleteInput): Promise<void> {
    const targetMessage = await DB.getLocalE2EEMessageByClientMessageId(input.targetClientMessageId);
    if (!targetMessage) {
      throw new Error("Target message for deletion was not found locally.");
    }

    const eventId = createUuid();
    const envelope: E2EEMessageEnvelope = {
      event_id: eventId,
      kind: "delete",
      chat_id: input.chatId,
      target_client_message_id: input.targetClientMessageId,
      sent_at: new Date().toISOString(),
    };

    await this.sendEnvelopeToPeer(input.peerUserId, input.chatId, envelope);
    await DB.saveLocalE2EEMessage({
      ...targetMessage,
      deletedAt: Date.now(),
      editedAt: null,
      plaintext: "",
    });
  }

  async markChatSeen(chatId: string, peerUserId: string): Promise<void> {
    const inboundMessages = await DB.listInboundMessagesPendingSeen(chatId, peerUserId);

    for (const message of inboundMessages) {
      if (!message.clientMessageId || !message.senderDeviceId || !message.senderSignalDeviceId) {
        continue;
      }

      await this.sendReceiptForInboundMessage(
        peerUserId,
        chatId,
        message.clientMessageId,
        "seen",
        message.senderDeviceId,
        message.senderSignalDeviceId,
      );

      await DB.saveLocalE2EEMessage({
        ...message,
        status: "seen",
      });
    }
  }

  private async decryptPendingMessage(message: E2EEPendingMessage): Promise<{
    envelope: E2EEMessageEnvelope;
    plaintext: string;
  }> {
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

    const plaintext = arrayBufferToUtf8(plaintextBuffer);
    return {
      envelope: this.parseEnvelope(
        plaintext,
        message.client_message_id ?? message.id,
        message.chat_id ?? null,
        message.created_at,
      ),
      plaintext,
    };
  }

  private async applyDecryptedEnvelope(
    pendingMessage: E2EEPendingMessage,
    envelope: E2EEMessageEnvelope,
    plaintext: string,
  ): Promise<void> {
    const createdAt = Date.parse(envelope.sent_at || pendingMessage.created_at);
    const processedEventId = envelope.event_id || pendingMessage.client_message_id || pendingMessage.id;

    if (envelope.kind === "message") {
      await DB.saveLocalE2EEMessage({
        id: envelope.event_id,
        pendingMessageId: pendingMessage.id,
        clientMessageId: envelope.event_id,
        chatId: pendingMessage.chat_id ?? envelope.chat_id ?? null,
        peerUserId: pendingMessage.sender_user_id,
        direction: "inbound",
        senderUserId: pendingMessage.sender_user_id,
        senderDeviceId: pendingMessage.sender_device_id,
        senderSignalDeviceId: pendingMessage.sender_signal_device_id,
        receiverDeviceId: pendingMessage.receiver_device_id,
        receiverSignalDeviceId: pendingMessage.receiver_signal_device_id,
        messageType: pendingMessage.message_type,
        ciphertext: pendingMessage.ciphertext,
        plaintext: envelope.body ?? plaintext,
        status: "received",
        replyToClientMessageId: envelope.reply_to_client_message_id ?? null,
        replyToPreview: envelope.reply_to_preview ?? null,
        forwardedFromClientMessageId: envelope.forwarded_from_client_message_id ?? null,
        forwardedFromPreview: envelope.forwarded_from_preview ?? null,
        createdAt,
        deliveredAt: pendingMessage.delivered_at ? Date.parse(pendingMessage.delivered_at) : null,
        ackedAt: Date.now(),
      });
    } else if (envelope.kind === "edit" && envelope.target_client_message_id) {
      const targetMessage = await DB.getLocalE2EEMessageByClientMessageId(envelope.target_client_message_id);
      if (targetMessage) {
        await DB.saveLocalE2EEMessage({
          ...targetMessage,
          plaintext: envelope.body ?? targetMessage.plaintext,
          editedAt: Date.now(),
        });
      }
    } else if (envelope.kind === "delete" && envelope.target_client_message_id) {
      const targetMessage = await DB.getLocalE2EEMessageByClientMessageId(envelope.target_client_message_id);
      if (targetMessage) {
        await DB.saveLocalE2EEMessage({
          ...targetMessage,
          deletedAt: Date.now(),
          editedAt: null,
          plaintext: "",
        });
      }
    } else if (
      envelope.kind === "receipt"
      && envelope.target_client_message_id
      && envelope.receipt_status
    ) {
      const targetMessage = await DB.getLocalE2EEMessageByClientMessageId(envelope.target_client_message_id);
      if (targetMessage) {
        await DB.saveLocalE2EEMessage({
          ...targetMessage,
          status: this.nextReceiptStatus(targetMessage.status, envelope.receipt_status),
          deliveredAt: envelope.receipt_status === "delivered" ? Date.now() : targetMessage.deliveredAt ?? Date.now(),
          ackedAt: envelope.receipt_status === "seen" ? Date.now() : targetMessage.ackedAt,
        });
      }
    }

    await DB.saveProcessedE2EEEvent({
      id: processedEventId,
      pendingMessageId: pendingMessage.id,
      chatId: pendingMessage.chat_id ?? envelope.chat_id ?? null,
      peerUserId: pendingMessage.sender_user_id,
      eventType: envelope.kind,
      createdAt,
    });
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

  private parseEnvelope(
    plaintext: string,
    fallbackEventId: string,
    fallbackChatId: string | null,
    fallbackCreatedAt: string,
  ): E2EEMessageEnvelope {
    try {
      const parsed = JSON.parse(plaintext) as Partial<E2EEMessageEnvelope>;
      if (parsed && typeof parsed.kind === "string" && typeof parsed.event_id === "string") {
        return {
          event_id: parsed.event_id,
          kind: parsed.kind,
          sent_at: parsed.sent_at ?? fallbackCreatedAt,
          chat_id: parsed.chat_id ?? fallbackChatId,
          body: parsed.body,
          target_client_message_id: parsed.target_client_message_id ?? null,
          reply_to_client_message_id: parsed.reply_to_client_message_id ?? null,
          reply_to_preview: parsed.reply_to_preview ?? null,
          forwarded_from_client_message_id: parsed.forwarded_from_client_message_id ?? null,
          forwarded_from_preview: parsed.forwarded_from_preview ?? null,
          receipt_status: parsed.receipt_status,
        };
      }
    } catch {
      // Backward-compatible fallback for older plaintext-only secure messages.
    }

    return {
      event_id: fallbackEventId,
      kind: "message",
      sent_at: fallbackCreatedAt,
      chat_id: fallbackChatId,
      body: plaintext,
    };
  }

  private buildEventSummary(envelope: E2EEMessageEnvelope): E2EEEventSummary {
    switch (envelope.kind) {
      case "message":
        return {
          event_type: "message",
          preview_text: envelope.body ?? null,
        };
      case "edit":
        return {
          event_type: "edit",
          preview_text: envelope.body ?? null,
          target_client_message_id: envelope.target_client_message_id ?? null,
        };
      case "delete":
        return {
          event_type: "delete",
          preview_text: "Message deleted",
          target_client_message_id: envelope.target_client_message_id ?? null,
        };
      case "receipt":
        return {
          event_type: "receipt",
          target_client_message_id: envelope.target_client_message_id ?? null,
        };
      default:
        return {
          event_type: "message",
          preview_text: envelope.body ?? null,
        };
    }
  }

  private async encryptEnvelopeForPeerBundle(bundle: PeerBundle, envelope: E2EEMessageEnvelope) {
    const address = new SignalProtocolAddress(bundle.userId, bundle.signalDeviceId);
    const sessionBuilder = new SessionBuilder(signalStore, address);
    await sessionBuilder.processPreKey(bundle.bundle);

    const sessionCipher = new SessionCipher(signalStore, address);
    return sessionCipher.encrypt(utf8ToArrayBuffer(JSON.stringify(envelope)));
  }

  private async sendEnvelopeToPeer(
    peerUserId: string,
    chatId: string,
    envelope: E2EEMessageEnvelope,
  ): Promise<void> {
    const localDeviceState = await this.ensureUploadedDeviceState();
    const peerBundles = await this.fetchPeerBundles(peerUserId);

    for (const bundle of peerBundles) {
      const encryptedMessage = await this.encryptEnvelopeForPeerBundle(bundle, envelope);
      if (!encryptedMessage.body) {
        throw new Error("libsignal returned an empty ciphertext body.");
      }

      await sendE2EEPendingMessage({
        sender_device_id: localDeviceState.deviceId,
        receiver_device_id: bundle.deviceId,
        chat_id: chatId,
        message_type: encryptedMessage.type,
        ciphertext: encryptedMessage.body,
        client_message_id: envelope.event_id,
        event_summary: this.buildEventSummary(envelope),
      });
    }
  }

  private async sendReceiptForInboundMessage(
    peerUserId: string,
    chatId: string,
    targetClientMessageId: string,
    receiptStatus: E2EEReceiptStatus,
    receiverDeviceId: string,
    receiverSignalDeviceId: number,
  ): Promise<void> {
    const localDeviceState = await this.ensureUploadedDeviceState();
    const currentUserId = await this.getCurrentUserId();
    const address = new SignalProtocolAddress(peerUserId, receiverSignalDeviceId);
    const sessionCipher = new SessionCipher(signalStore, address);
    const envelope: E2EEMessageEnvelope = {
      event_id: createUuid(),
      kind: "receipt",
      chat_id: chatId,
      target_client_message_id: targetClientMessageId,
      receipt_status: receiptStatus,
      sent_at: new Date().toISOString(),
    };
    const encryptedMessage = await sessionCipher.encrypt(
      utf8ToArrayBuffer(JSON.stringify(envelope)),
    );

    if (!encryptedMessage.body) {
      throw new Error("libsignal returned an empty ciphertext body.");
    }

    await sendE2EEPendingMessage({
      sender_device_id: localDeviceState.deviceId,
      receiver_device_id: receiverDeviceId,
      chat_id: chatId,
      message_type: encryptedMessage.type,
      ciphertext: encryptedMessage.body,
      client_message_id: envelope.event_id,
      event_summary: this.buildEventSummary(envelope),
    });

    await DB.saveProcessedE2EEEvent({
      id: envelope.event_id,
      chatId,
      peerUserId: currentUserId,
      eventType: "receipt",
      createdAt: Date.now(),
    });
  }

  private nextReceiptStatus(currentStatus: string, incomingStatus: E2EEReceiptStatus): string {
    const ranks: Record<string, number> = {
      sent: 0,
      received: 0,
      delivered: 1,
      seen: 2,
    };

    return (ranks[incomingStatus] >= (ranks[currentStatus] ?? 0)) ? incomingStatus : currentStatus;
  }
}

export const e2eeChatService = new E2EEChatService();
