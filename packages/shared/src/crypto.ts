import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { getEnv } from './env.js';

const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

const getEncryptionKey = (): Buffer => {
  return createHash('sha256').update(getEnv().CONNECTOR_ENCRYPTION_KEY).digest();
};

export const encryptJson = (value: unknown): string => {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf-8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
};

export const decryptJson = <T>(value: string | null | undefined): T | null => {
  if (!value) return null;
  const payload = Buffer.from(value, 'base64');
  if (payload.length <= IV_LENGTH + AUTH_TAG_LENGTH) return null;

  const iv = payload.subarray(0, IV_LENGTH);
  const authTag = payload.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = payload.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', getEncryptionKey(), iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8');
  return JSON.parse(decrypted) as T;
};
