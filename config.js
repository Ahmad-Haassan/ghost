const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const cryptoManager = require('./cryptoManager');

const CONFIG_PATH = path.join(__dirname, 'config.json');

function generateId(prefix = 'PKT') {
  const randomStr = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `${prefix}-${randomStr.slice(0, 4)}-${randomStr.slice(4)}`;
}

function generateToken() {
  return crypto.randomBytes(16).toString('hex');
}

function generatePin() {
  return crypto.randomInt(100000, 999999).toString();
}

function generateEncryptionKey() {
  return crypto.randomBytes(32).toString('base64url');
}

function getDefaultConfig() {
  return {
    deviceId: generateId('PKT'),
    token: generateToken(),
    encryptionKey: generateEncryptionKey(),
    deviceName: os.hostname() || 'My Windows PC',
    port: 48765,
    autoStart: true,
    allowControl: true,
    requireApproval: true,
    pin: generatePin(),
    pairedDevices: [],
    createdAt: new Date().toISOString()
  };
}

let currentConfig = null;

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const data = fs.readFileSync(CONFIG_PATH, 'utf8');
      currentConfig = { ...getDefaultConfig(), ...JSON.parse(data) };
      if (!currentConfig.encryptionKey) {
        currentConfig.encryptionKey = generateEncryptionKey();
        saveConfig();
      }
      if (!currentConfig.pin || currentConfig.pin === '1234') {
        currentConfig.pin = generatePin();
        saveConfig();
      }
    } else {
      currentConfig = getDefaultConfig();
      saveConfig();
    }
  } catch (err) {
    console.error('Failed to read config.json, using defaults:', err);
    currentConfig = getDefaultConfig();
  }

  // Initialize E2EE crypto manager with the master key
  cryptoManager.setKey(Buffer.from(currentConfig.encryptionKey, 'base64url'));
  return currentConfig;
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(currentConfig, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save config.json:', err);
  }
}

function getConfig() {
  if (!currentConfig) {
    loadConfig();
  }
  return currentConfig;
}

function getPublicConfig() {
  const cfg = getConfig();
  return {
    deviceId: cfg.deviceId,
    deviceName: cfg.deviceName,
    port: cfg.port,
    autoStart: cfg.autoStart,
    allowControl: cfg.allowControl,
    requireApproval: cfg.requireApproval
  };
}

function updateConfig(newFields) {
  // Prevent overriding critical secret keys via settings API
  delete newFields.token;
  delete newFields.encryptionKey;

  currentConfig = { ...getConfig(), ...newFields };
  saveConfig();
  return currentConfig;
}

function addOrUpdatePairedDevice(deviceInfo) {
  const cfg = getConfig();
  const existingIdx = cfg.pairedDevices.findIndex(d => d.id === deviceInfo.id);
  const now = new Date().toISOString();
  
  if (existingIdx >= 0) {
    cfg.pairedDevices[existingIdx] = {
      ...cfg.pairedDevices[existingIdx],
      ...deviceInfo,
      lastSeen: now
    };
  } else {
    cfg.pairedDevices.push({
      id: deviceInfo.id || crypto.randomUUID(),
      name: deviceInfo.name || 'Mobile Phone',
      pairedAt: now,
      lastSeen: now,
      ip: deviceInfo.ip || 'Unknown',
      userAgent: deviceInfo.userAgent || 'Unknown'
    });
  }
  saveConfig();
  return cfg.pairedDevices;
}

function removePairedDevice(deviceId) {
  const cfg = getConfig();
  cfg.pairedDevices = cfg.pairedDevices.filter(d => d.id !== deviceId);
  saveConfig();
  return cfg.pairedDevices;
}

function verifyToken(token) {
  const cfg = getConfig();
  return cfg.token === token;
}

module.exports = {
  loadConfig,
  saveConfig,
  getConfig,
  getPublicConfig,
  updateConfig,
  addOrUpdatePairedDevice,
  removePairedDevice,
  verifyToken
};
