import * as base64 from 'base64-js';

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  return base64.fromByteArray(bytes);
}

export function base64ToArrayBuffer(base64String: string): ArrayBuffer {
  const bytes = base64.toByteArray(base64String);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function utf8ToArrayBuffer(value: string): ArrayBuffer {
  const bytes = textEncoder.encode(value);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function arrayBufferToUtf8(buffer: ArrayBuffer): string {
  return textDecoder.decode(new Uint8Array(buffer));
}

export function createUuid(): string {
  const random = new Uint8Array(16);
  globalThis.crypto.getRandomValues(random);
  random[6] = (random[6] & 0x0f) | 0x40;
  random[8] = (random[8] & 0x3f) | 0x80;

  const hex = Array.from(random, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}
