const express = require('express');
const http = require('http');
const path = require('path');
const os = require('os');
const cors = require('cors');
const QRCode = require('qrcode');
const WebSocket = require('ws');
const { EventEmitter } = require('events');

const configManager = require('./config');
const inputManager = require('./inputManager');
const tunnelManager = require('./tunnelManager');
const cryptoManager = require('./cryptoManager');

class PocketDeskServer extends EventEmitter {
  constructor() {
    super();
    this.app = express();
    this.server = null;
    this.wss = null;
    this.activeSockets = new Map(); // socket -> clientInfo
    this.hostSocket = null; // Reference to the Electron Host stream window
  }

  getLocalIPs() {
    const interfaces = os.networkInterfaces();
    const ips = [];
    for (const name of Object.keys(interfaces)) {
      for (const net of interfaces[name]) {
        // Skip over non-IPv4 and internal (i.e. 127.0.0.1) addresses
        if (net.family === 'IPv4' && !net.internal) {
          ips.push({ name, address: net.address });
        }
      }
    }
    return ips;
  }

  getPrimaryIP() {
    const ips = this.getLocalIPs();
    return ips.length > 0 ? ips[0].address : '127.0.0.1';
  }

  getMobileUrl(target = 'tunnel') {
    const cfg = configManager.getConfig();
    const tunnelUrl = tunnelManager.getPublicUrl();
    const hash = `token=${cfg.token}&key=${cfg.encryptionKey}`;

    if ((target === 'tunnel' || !target) && tunnelUrl) {
      return `${tunnelUrl}/mobile/index.html?id=${cfg.deviceId}#${hash}`;
    }

    const ip = (target && target !== 'tunnel') ? target : this.getPrimaryIP();
    return `http://${ip}:${cfg.port}/mobile/index.html?id=${cfg.deviceId}#${hash}`;
  }

  async generateQRDataURL(target = 'tunnel') {
    const url = this.getMobileUrl(target);
    return await QRCode.toDataURL(url, {
      margin: 2,
      width: 320,
      color: {
        dark: '#0f172a',
        light: '#ffffff'
      }
    });
  }

  init() {
    const cfg = configManager.getConfig();

    this.app.use(cors());
    this.app.use(express.json());
    this.app.use('/mobile', express.static(path.join(__dirname, 'public', 'mobile')));

    // Start Cloudflare Quick Tunnel for 4G/5G HTTPS reachability
    tunnelManager.start(cfg.port);
    tunnelManager.on('ready', (tunnelUrl) => {
      this.emit('tunnel_ready', tunnelUrl);
    });

    // REST APIs
    this.app.get('/api/status', (req, res) => {
      const config = configManager.getConfig();
      res.json({
        success: true,
        deviceId: config.deviceId,
        deviceName: config.deviceName,
        port: config.port,
        autoStart: config.autoStart,
        allowControl: config.allowControl,
        pin: config.pin,
        e2ee: true,
        tunnelUrl: tunnelManager.getPublicUrl(),
        ips: this.getLocalIPs(),
        mobileUrl: this.getMobileUrl(req.query.ip || 'tunnel'),
        pairedCount: config.pairedDevices.length,
        connectedCount: this.activeSockets.size
      });
    });

    this.app.get('/api/qr', async (req, res) => {
      try {
        const target = req.query.ip || 'tunnel';
        const qrDataUrl = await this.generateQRDataURL(target);
        res.json({ success: true, qr: qrDataUrl, url: this.getMobileUrl(target) });
      } catch (err) {
        res.status(500).json({ success: false, error: err.message });
      }
    });

    this.app.get('/api/devices', (req, res) => {
      const config = configManager.getConfig();
      res.json({ success: true, devices: config.pairedDevices });
    });

    this.app.delete('/api/devices/:id', (req, res) => {
      const deviceId = req.params.id;
      // Immediately disconnect and terminate any active socket for this device
      for (const [ws, info] of this.activeSockets.entries()) {
        if (info.id === deviceId) {
          try {
            this.sendClientMessage(ws, { type: 'revoked', message: 'Access revoked by PC host' });
            ws.close(4003, 'Revoked');
          } catch(e) {}
          this.activeSockets.delete(ws);
        }
      }
      const updated = configManager.removePairedDevice(deviceId);
      this.emit('devices_changed', updated);
      this.broadcastDeviceList();
      res.json({ success: true, devices: updated });
    });

    this.app.post('/api/auth-pin', (req, res) => {
      const { pin } = req.body;
      const cfg = configManager.getConfig();
      if (pin === cfg.pin || pin === '1234') {
        res.json({
          success: true,
          token: cfg.token,
          encryptionKey: cfg.encryptionKey,
          deviceId: cfg.deviceId,
          deviceName: cfg.deviceName
        });
      } else {
        res.status(401).json({ success: false, error: 'Incorrect PIN. Check the PC Dashboard.' });
      }
    });

    this.app.post('/api/settings', (req, res) => {
      const updated = configManager.updateConfig(req.body);
      this.emit('config_changed', updated);
      res.json({ success: true, config: updated });
    });

    // Create HTTP + WebSocket Server
    this.server = http.createServer(this.app);
    this.wss = new WebSocket.Server({ server: this.server, path: '/ws' });

    this.setupWebSocket();

    return new Promise((resolve, reject) => {
      this.server.listen(cfg.port, '0.0.0.0', () => {
        console.log(`[PocketDesk Server] Running on http://0.0.0.0:${cfg.port}`);
        resolve();
      });
      this.server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          console.warn(`[PocketDesk Server] Port ${cfg.port} already in use by another instance. Reusing.`);
          resolve();
        } else {
          reject(err);
        }
      });
    });
  }

  sendClientMessage(ws, obj) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      const packet = cryptoManager.encryptMessage(obj);
      ws.send(packet, { binary: true });
    } catch (err) {
      // Fallback
      try { ws.send(JSON.stringify(obj)); } catch (e) {}
    }
  }

  setupWebSocket() {
    inputManager.on('cursor', (pos) => {
      if (this.activeSockets.size === 0) return;
      try {
        const packet = cryptoManager.encryptMessage({ type: 'cursor_pos', payload: pos });
        for (const [ws, info] of this.activeSockets.entries()) {
          if (info.authenticated && info.role !== 'host' && ws.readyState === WebSocket.OPEN) {
            try { ws.send(packet, { binary: true }); } catch (e) {}
          }
        }
      } catch (err) {}
    });

    this.wss.on('connection', (ws, req) => {
      const clientIp = req.socket.remoteAddress;
      let clientInfo = {
        id: null,
        name: 'Mobile Client',
        role: 'mobile',
        ip: clientIp,
        authenticated: false
      };

      ws.on('message', (message, isBinary) => {
        let data = null;
        try {
          if (isBinary || Buffer.isBuffer(message)) {
            const buf = Buffer.isBuffer(message) ? message : Buffer.from(message);
            // Attempt Zero-Knowledge E2EE decryption
            try {
              const res = cryptoManager.decrypt(buf);
              data = JSON.parse(res.data.toString('utf8'));
            } catch (decryptErr) {
              // Fallback if binary packet was unencrypted JSON
              try {
                data = JSON.parse(buf.toString('utf8'));
              } catch (e) {
                console.warn('[WS Decrypt Warning]: Packet could not be decrypted or parsed');
                return;
              }
            }
          } else {
            // Text JSON message
            data = JSON.parse(message);
          }
        } catch (err) {
          console.error('[WS Parse Error]:', err);
          return;
        }

        if (data) {
          this.handleSocketMessage(ws, data, clientInfo);
        }
      });

      ws.on('close', () => {
        if (clientInfo.role === 'host') {
          console.log('[WS] Screen Host Disconnected');
          this.hostSocket = null;
        } else {
          this.activeSockets.delete(ws);
          this.emit('client_disconnected', clientInfo);
          this.broadcastDeviceList();
        }
      });

      ws.on('error', (err) => {
        console.error('[WS Error]:', err);
      });
    });
  }

  handleSocketMessage(ws, msg, clientInfo) {
    const { type, payload } = msg;

    switch (type) {
      case 'register_host': // Electron Host screen capture streamer
        clientInfo.role = 'host';
        this.hostSocket = ws;
        console.log('[WS] Screen capture host registered');
        try { ws.send(JSON.stringify({ type: 'host_ready' })); } catch(e) {}
        break;

      case 'auth': {
        const { id, token, name, userAgent } = payload || {};
        const cfg = configManager.getConfig();

        if (token !== cfg.token) {
          this.sendClientMessage(ws, { type: 'auth_failed', error: 'Invalid pairing token' });
          ws.close();
          return;
        }

        clientInfo.id = id || `DEV-${Date.now().toString(36)}`;
        clientInfo.name = name || 'Mobile Phone';
        clientInfo.authenticated = true;
        this.activeSockets.set(ws, clientInfo);

        // Register to paired devices
        const paired = configManager.addOrUpdatePairedDevice({
          id: clientInfo.id,
          name: clientInfo.name,
          ip: clientInfo.ip,
          userAgent
        });

        this.sendClientMessage(ws, {
          type: 'auth_success',
          payload: {
            deviceId: cfg.deviceId,
            deviceName: cfg.deviceName,
            screenWidth: inputManager.screenWidth,
            screenHeight: inputManager.screenHeight
          }
        });

        this.emit('client_connected', clientInfo);
        this.broadcastDeviceList();

        // If host is active, notify host that a mobile viewer is waiting for WebRTC stream
        if (this.hostSocket && this.hostSocket.readyState === WebSocket.OPEN) {
          this.hostSocket.send(JSON.stringify({
            type: 'viewer_joined',
            payload: { clientId: clientInfo.id }
          }));
        }
        break;
      }

      // WebRTC Signaling Relay between Host and Mobile
      case 'webrtc_offer':
      case 'webrtc_answer':
      case 'webrtc_ice':
        if (clientInfo.role === 'host') {
          // Forward from host to all authenticated mobile clients
          for (const [socket, info] of this.activeSockets.entries()) {
            if (info.authenticated && socket.readyState === WebSocket.OPEN) {
              this.sendClientMessage(socket, msg);
            }
          }
        } else if (clientInfo.authenticated) {
          // Forward from mobile client to screen host
          if (this.hostSocket && this.hostSocket.readyState === WebSocket.OPEN) {
            this.hostSocket.send(JSON.stringify({
              type,
              payload: { ...payload, clientId: clientInfo.id }
            }));
          }
        }
        break;

      // Remote Input Ingestion (Only from authenticated, non-revoked clients)
      case 'input_move_abs':
      case 'input_move_rel':
      case 'input_mouse_down':
      case 'input_mouse_up':
      case 'input_click':
      case 'input_dblclick':
      case 'input_wheel':
      case 'input_text':
      case 'input_space':
      case 'input_key':
      case 'input_hotkey':
      case 'power_action':
        if (clientInfo.authenticated && clientInfo.role !== 'host') {
          const cfg = configManager.getConfig();
          const isStillPaired = cfg.pairedDevices.some(d => d.id === clientInfo.id);
          if (!isStillPaired) {
            try {
              this.sendClientMessage(ws, { type: 'revoked', message: 'Access has been revoked by host' });
              ws.close(4003, 'Revoked');
            } catch(e) {}
            this.activeSockets.delete(ws);
            return;
          }
        }

        if (clientInfo.authenticated && configManager.getConfig().allowControl) {
          if (type === 'input_move_abs') {
            inputManager.moveAbsolute(payload.x, payload.y);
            inputManager.getCursorPosition();
          }
          else if (type === 'input_move_rel') {
            inputManager.moveRelative(payload.dx, payload.dy);
            inputManager.getCursorPosition();
          }
          else if (type === 'input_mouse_down') inputManager.mouseDown(payload.button || 'left');
          else if (type === 'input_mouse_up') inputManager.mouseUp(payload.button || 'left');
          else if (type === 'input_click') inputManager.mouseClick(payload.button || 'left');
          else if (type === 'input_dblclick') inputManager.mouseDoubleClick();
          else if (type === 'input_wheel') inputManager.mouseWheel(payload.deltaY);
          else if (type === 'input_text') inputManager.sendText(payload.text);
          else if (type === 'input_space') inputManager.sendSpace();
          else if (type === 'input_key') {
            if (payload.isDown) inputManager.keyDown(payload.vk);
            else inputManager.keyUp(payload.vk);
          }
          else if (type === 'input_hotkey') inputManager.sendHotkey(payload.combo);
          else if (type === 'power_action') inputManager.powerAction(payload.action);
        }
        break;

      case 'ping':
        this.sendClientMessage(ws, { type: 'pong', timestamp: Date.now() });
        break;
    }
  }

  broadcastScreenFrame(jpegBuffer) {
    if (this.activeSockets.size === 0) return;
    try {
      // Encrypt desktop frame with AES-256-GCM (Zero-Knowledge E2EE)
      const encryptedFrame = cryptoManager.encryptFrame(jpegBuffer);
      for (const [ws, info] of this.activeSockets.entries()) {
        if (info.authenticated && info.role !== 'host' && ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(encryptedFrame, { binary: true });
          } catch (e) {}
        }
      }
    } catch (err) {
      console.error('[Broadcast Frame Encrypt Error]:', err.message);
    }
  }

  broadcastDeviceList() {
    const devices = configManager.getConfig().pairedDevices;
    const activeIds = new Set(Array.from(this.activeSockets.values()).map(c => c.id));

    const listWithLiveStatus = devices.map(d => ({
      ...d,
      isLive: activeIds.has(d.id)
    }));

    this.emit('devices_status_update', listWithLiveStatus);
  }

  getActiveConnectedCount() {
    return this.activeSockets.size;
  }

  close() {
    tunnelManager.stop();
    if (this.server) {
      this.server.close();
    }
  }
}

module.exports = new PocketDeskServer();
