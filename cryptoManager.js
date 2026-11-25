const crypto = require('crypto');

// Packet Type Indicators for Zero-Knowledge E2EE wire protocol
const PACKET_TYPE_FRAME = 0x01; // Encrypted Desktop Screen Frame (JPEG)
const PACKET_TYPE_JSON  = 0x02; // Encrypted Control JSON (mouse, touch, key, auth)

class CryptoManager {
  constructor() {
    this.key = null; // Buffer (32 bytes for AES-256)
  }

  setKey(keyHexOrBase64) {
    if (!keyHexOrBase64) return;
    if (typeof keyHexOrBase64 === 'string') {
      if (keyHexOrBase64.length === 64 && /^[0-9a-fA-F]+$/.test(keyHexOrBase64)) {
        this.key = Buffer.from(keyHexOrBase64, 'hex');
      } else {
        // Base64 or Base64URL string
        const base64 = keyHexOrBase64.replace(/-/g, '+').replace(/_/g, '/');
        this.key = Buffer.from(base64, 'base64');
      }
    } else if (Buffer.isBuffer(keyHexOrBase64)) {
      this.key = keyHexOrBase64;
    }
  }

  generateKey() {
    this.key = crypto.randomBytes(32);
    return this.key.toString('base64url');
  }

  getKeyBase64Url() {
    if (!this.key) this.generateKey();
    return this.key.toString('base64url');
  }

  /**
   * Encrypt buffer or string using AES-256-GCM
   * Output wire format matches Web Crypto API:
   * [12 bytes IV] + [Ciphertext] + [16 bytes Auth Tag]
   */
  encryptRaw(data) {
    if (!this.key) throw new Error('Encryption key not initialized');
    const inputBuffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');

    const iv = crypto.randomBytes(12); // Standard 96-bit IV for GCM
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);

    const ciphertext = Buffer.concat([cipher.update(inputBuffer), cipher.final()]);
    const tag = cipher.getAuthTag(); // 16 bytes

    // Pack into single buffer: IV (12) + Ciphertext (N) + Tag (16)
    return Buffer.concat([iv, ciphertext, tag]);
  }

  /**
   * Encrypt screen frame JPEG buffer with type 0x01
   * [Type (1 byte)] + [IV (12)] + [Ciphertext] + [Tag (16)]
   */
  encryptFrame(jpegBuffer) {
    const raw = this.encryptRaw(jpegBuffer);
    const packet = Buffer.allocUnsafe(1 + raw.length);
    packet[0] = PACKET_TYPE_FRAME;
    raw.copy(packet, 1);
    return packet;
  }

  /**
   * Encrypt JSON object or string with type 0x02
   * [Type (1 byte)] + [IV (12)] + [Ciphertext] + [Tag (16)]
   */
  encryptMessage(objOrStr) {
    const jsonStr = typeof objOrStr === 'string' ? objOrStr : JSON.stringify(objOrStr);
    const raw = this.encryptRaw(Buffer.from(jsonStr, 'utf8'));
    const packet = Buffer.allocUnsafe(1 + raw.length);
    packet[0] = PACKET_TYPE_JSON;
    raw.copy(packet, 1);
    return packet;
  }

  /**
   * Decrypt AES-256-GCM packet
   * Handles typed packets [Type (1)] + [IV (12)] + [Ciphertext] + [Tag (16)]
   * As well as untyped packets [IV (12)] + [Ciphertext] + [Tag (16)]
   */
  decrypt(packedBuffer) {
    if (!this.key) throw new Error('Encryption key not initialized');
    if (!Buffer.isBuffer(packedBuffer)) {
      packedBuffer = Buffer.from(packedBuffer);
    }

    if (packedBuffer.length < 28) {
      throw new Error('Encrypted buffer too short');
    }

    let offset = 0;
    let packetType = null;

    // Check for typed prefix (0x01 or 0x02)
    if (packedBuffer.length >= 29 && (packedBuffer[0] === PACKET_TYPE_FRAME || packedBuffer[0] === PACKET_TYPE_JSON)) {
      packetType = packedBuffer[0];
      offset = 1;
    }

    const iv = packedBuffer.subarray(offset, offset + 12);
    const tag = packedBuffer.subarray(packedBuffer.length - 16);
    const ciphertext = packedBuffer.subarray(offset + 12, packedBuffer.length - 16);

    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return { type: packetType, data: decrypted };
  }
}

module.exports = new CryptoManager();
module.exports.PACKET_TYPE_FRAME = PACKET_TYPE_FRAME;
module.exports.PACKET_TYPE_JSON = PACKET_TYPE_JSON;
