const { spawn } = require('child_process');
const path = require('path');
const EventEmitter = require('events');
const fs = require('fs');

class TunnelManager extends EventEmitter {
  constructor() {
    super();
    this.process = null;
    this.publicUrl = null;
    this.isStarting = false;
    this.exePath = path.join(__dirname, 'cloudflared.exe');
  }

  start(port = 48765) {
    if (!fs.existsSync(this.exePath)) {
      console.warn('[TunnelManager] cloudflared.exe not found');
      return;
    }

    if (this.process) return;

    this.isStarting = true;
    console.log(`[TunnelManager] Starting Cloudflare Quick Tunnel on port ${port}...`);

    try {
      this.process = spawn(this.exePath, ['tunnel', '--url', `http://127.0.0.1:${port}`], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      const handleData = (data) => {
        const text = data.toString();
        // Regex to match trycloudflare URL
        const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
        if (match) {
          const url = match[0];
          if (this.publicUrl !== url) {
            this.publicUrl = url;
            this.isStarting = false;
            console.log(`[TunnelManager] 🌐 Live Public HTTPS Tunnel: ${this.publicUrl}`);
            this.emit('ready', this.publicUrl);
          }
        }
      };

      this.process.stdout.on('data', handleData);
      this.process.stderr.on('data', handleData);

      this.process.on('exit', (code) => {
        console.warn('[TunnelManager] Process exited with code', code);
        this.process = null;
        this.publicUrl = null;
        // Auto-restart after 4 seconds
        setTimeout(() => this.start(port), 4000);
      });

      this.process.on('error', (err) => {
        console.error('[TunnelManager] Error:', err);
      });
    } catch (err) {
      console.error('[TunnelManager] Failed to start:', err);
    }
  }

  getPublicUrl() {
    return this.publicUrl;
  }

  stop() {
    if (this.process) {
      try {
        this.process.kill();
      } catch (e) {}
      this.process = null;
    }
    this.publicUrl = null;
  }
}

module.exports = new TunnelManager();
