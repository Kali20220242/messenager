import * as base64 from 'base64-js';

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  return base64.fromByteArray(bytes);
};

export function base64ToArrayBuffer(base64String: string): ArrayBuffer {
  const bytes = base64.toByteArray(base64String);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};