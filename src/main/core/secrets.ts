// Encryption at rest through Electron safeStorage: Windows DPAPI on Windows,
// Keychain on macOS, libsecret/kwallet on Linux.
import { safeStorage } from 'electron';

export interface EncryptionStatus {
  available: boolean;
  backend: string;
  /** False on Linux when only the hard-coded "basic_text" fallback key is available. */
  strong: boolean;
}

export function encryptionStatus(): EncryptionStatus {
  const available = safeStorage.isEncryptionAvailable();
  if (process.platform === 'win32') return { available, backend: 'Windows DPAPI', strong: available };
  if (process.platform === 'darwin') return { available, backend: 'macOS Keychain', strong: available };
  const backend = safeStorage.getSelectedStorageBackend();
  return { available, backend, strong: available && backend !== 'basic_text' && backend !== 'unknown' };
}

export function encryptText(plain: string): string {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS encryption is not available');
  return safeStorage.encryptString(plain).toString('base64');
}

export function decryptText(cipher: string): string {
  return safeStorage.decryptString(Buffer.from(cipher, 'base64'));
}
