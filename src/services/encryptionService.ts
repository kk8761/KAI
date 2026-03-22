/**
 * End-to-End Encryption Service using Web Crypto API
 */

export class EncryptionService {
  private static PRIVATE_KEY_STORAGE_KEY = 'kai_private_key';
  private static PUBLIC_KEY_STORAGE_KEY = 'kai_public_key';

  /**
   * Generates a new RSA-OAEP key pair for the user
   */
  static async generateUserKeyPair(): Promise<{ publicKey: string; privateKey: string }> {
    const keyPair = await window.crypto.subtle.generateKey(
      {
        name: "RSA-OAEP",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["encrypt", "decrypt"]
    );

    const publicKeyJwk = await window.crypto.subtle.exportKey("jwk", keyPair.publicKey);
    const privateKeyJwk = await window.crypto.subtle.exportKey("jwk", keyPair.privateKey);

    const publicKeyStr = JSON.stringify(publicKeyJwk);
    const privateKeyStr = JSON.stringify(privateKeyJwk);

    localStorage.setItem(this.PRIVATE_KEY_STORAGE_KEY, privateKeyStr);
    localStorage.setItem(this.PUBLIC_KEY_STORAGE_KEY, publicKeyStr);

    return { publicKey: publicKeyStr, privateKey: privateKeyStr };
  }

  static getStoredPublicKey(): string | null {
    return localStorage.getItem(this.PUBLIC_KEY_STORAGE_KEY);
  }

  static getStoredPrivateKey(): string | null {
    return localStorage.getItem(this.PRIVATE_KEY_STORAGE_KEY);
  }

  /**
   * Imports a JWK public key
   */
  private static async importPublicKey(jwkStr: string): Promise<CryptoKey> {
    const jwk = JSON.parse(jwkStr);
    return await window.crypto.subtle.importKey(
      "jwk",
      jwk,
      {
        name: "RSA-OAEP",
        hash: "SHA-256",
      },
      true,
      ["encrypt"]
    );
  }

  /**
   * Imports a JWK private key
   */
  private static async importPrivateKey(jwkStr: string): Promise<CryptoKey> {
    const jwk = JSON.parse(jwkStr);
    return await window.crypto.subtle.importKey(
      "jwk",
      jwk,
      {
        name: "RSA-OAEP",
        hash: "SHA-256",
      },
      true,
      ["decrypt"]
    );
  }

  /**
   * Generates a random AES-GCM key
   */
  static async generateSymmetricKey(): Promise<CryptoKey> {
    return await window.crypto.subtle.generateKey(
      {
        name: "AES-GCM",
        length: 256,
      },
      true,
      ["encrypt", "decrypt"]
    );
  }

  /**
   * Encrypts a symmetric key with an RSA public key
   */
  static async encryptSymmetricKey(symmetricKey: CryptoKey, publicKeyStr: string): Promise<string> {
    const publicKey = await this.importPublicKey(publicKeyStr);
    const exportedSymmetricKey = await window.crypto.subtle.exportKey("raw", symmetricKey);
    const encryptedKey = await window.crypto.subtle.encrypt(
      { name: "RSA-OAEP" },
      publicKey,
      exportedSymmetricKey
    );
    return btoa(String.fromCharCode(...new Uint8Array(encryptedKey)));
  }

  /**
   * Decrypts a symmetric key with an RSA private key
   */
  static async decryptSymmetricKey(encryptedKeyBase64: string, privateKeyStr: string): Promise<CryptoKey> {
    const privateKey = await this.importPrivateKey(privateKeyStr);
    const encryptedKey = new Uint8Array(atob(encryptedKeyBase64).split("").map(c => c.charCodeAt(0)));
    const decryptedKeyRaw = await window.crypto.subtle.decrypt(
      { name: "RSA-OAEP" },
      privateKey,
      encryptedKey
    );
    return await window.crypto.subtle.importKey(
      "raw",
      decryptedKeyRaw,
      "AES-GCM",
      true,
      ["encrypt", "decrypt"]
    );
  }

  /**
   * Encrypts data with a symmetric key
   */
  static async encryptData(data: string | ArrayBuffer, symmetricKey: CryptoKey): Promise<{ encryptedData: string; iv: string }> {
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const encodedData = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    
    const encryptedBuffer = await window.crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: iv,
      },
      symmetricKey,
      encodedData
    );

    return {
      encryptedData: btoa(String.fromCharCode(...new Uint8Array(encryptedBuffer))),
      iv: btoa(String.fromCharCode(...iv))
    };
  }

  /**
   * Decrypts data with a symmetric key
   */
  static async decryptData(encryptedDataBase64: string, ivBase64: string, symmetricKey: CryptoKey): Promise<ArrayBuffer> {
    const encryptedData = new Uint8Array(atob(encryptedDataBase64).split("").map(c => c.charCodeAt(0)));
    const iv = new Uint8Array(atob(ivBase64).split("").map(c => c.charCodeAt(0)));

    return await window.crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: iv,
      },
      symmetricKey,
      encryptedData
    );
  }

  static async decryptBuffer(encryptedBuffer: ArrayBuffer, ivBase64: string, symmetricKey: CryptoKey): Promise<ArrayBuffer> {
    const iv = new Uint8Array(atob(ivBase64).split("").map(c => c.charCodeAt(0)));

    return await window.crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: iv,
      },
      symmetricKey,
      encryptedBuffer
    );
  }

  static async decryptText(encryptedDataBase64: string, ivBase64: string, symmetricKey: CryptoKey): Promise<string> {
    const decryptedBuffer = await this.decryptData(encryptedDataBase64, ivBase64, symmetricKey);
    return new TextDecoder().decode(decryptedBuffer);
  }
}
