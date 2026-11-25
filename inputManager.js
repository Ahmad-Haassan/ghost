const { spawn } = require('child_process');
const path = require('path');
const EventEmitter = require('events');

class InputManager extends EventEmitter {
  constructor() {
    super();
    this.process = null;
    this.screenWidth = 1920;
    this.screenHeight = 1080;
    this.isReady = false;
    this.exePath = path.join(__dirname, 'input_injector.exe');
    this.startProcess();
  }

  startProcess() {
    try {
      this.process = spawn(this.exePath, [], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      this.process.stdout.on('data', (data) => {
        const text = data.toString();
        const lines = text.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('POCKETDESK_INPUT_READY')) {
            this.isReady = true;
            const match = trimmed.match(/screen=(\d+)x(\d+)/);
            if (match) {
              this.screenWidth = parseInt(match[1], 10);
              this.screenHeight = parseInt(match[2], 10);
            }
            this.emit('ready', { width: this.screenWidth, height: this.screenHeight });
          } else if (trimmed.startsWith('SCREEN')) {
            const parts = trimmed.split(' ');
            if (parts.length >= 3) {
              this.screenWidth = parseInt(parts[1], 10);
              this.screenHeight = parseInt(parts[2], 10);
              this.emit('screen', { width: this.screenWidth, height: this.screenHeight });
            }
          } else if (trimmed.startsWith('CUR')) {
            const parts = trimmed.split(' ');
            if (parts.length >= 3) {
              const cx = parseInt(parts[1], 10);
              const cy = parseInt(parts[2], 10);
              this.emit('cursor', { x: cx, y: cy });
            }
          }
        }
      });

      this.process.stderr.on('data', (data) => {
        console.error('[InputInjector Error]:', data.toString());
      });

      this.process.on('exit', (code) => {
        console.warn('[InputInjector] Process exited with code', code);
        this.isReady = false;
        // Auto restart after 1 second if needed
        setTimeout(() => this.startProcess(), 1000);
      });
    } catch (err) {
      console.error('[InputInjector] Failed to start process:', err);
    }
  }

  send(cmd) {
    if (this.process && this.process.stdin && !this.process.stdin.destroyed) {
      try {
        this.process.stdin.write(cmd + '\n');
      } catch (err) {
        console.error('[InputInjector] Write error:', err);
      }
    }
  }

  moveAbsolute(normX, normY) {
    // Clamp to 0.0 - 1.0
    const x = Math.max(0, Math.min(1, normX));
    const y = Math.max(0, Math.min(1, normY));
    this.send(`MMA ${x.toFixed(4)} ${y.toFixed(4)}`);
  }

  moveRelative(dx, dy) {
    this.send(`MMR ${Math.round(dx)} ${Math.round(dy)}`);
  }

  mouseDown(button = 'left') {
    this.send(`MD ${button}`);
  }

  mouseUp(button = 'left') {
    this.send(`MU ${button}`);
  }

  mouseClick(button = 'left') {
    this.send(`MC ${button}`);
  }

  mouseDoubleClick() {
    this.send('MDC');
  }

  mouseWheel(deltaY) {
    this.send(`MW ${Math.round(deltaY)}`);
  }

  keyDown(vkCode) {
    this.send(`KD ${vkCode}`);
  }

  keyUp(vkCode) {
    this.send(`KU ${vkCode}`);
  }

  keyPress(vkCode) {
    this.send(`KP ${vkCode}`);
  }

  sendText(text) {
    if (!text) return;
    const b64 = Buffer.from(text, 'utf8').toString('base64');
    this.send(`TEXT_B64 ${b64}`);
  }

  sendSpace() {
    this.send('SPACE');
  }

  sendHotkey(combo) {
    this.send(`HOTKEY ${combo}`);
  }

  powerAction(action) {
    this.send(`PWR ${action}`);
  }

  refreshScreen() {
    this.send('SCREEN');
  }

  getCursorPosition() {
    this.send('GETCUR');
  }

  destroy() {
    if (this.process) {
      try {
        this.process.kill();
      } catch (e) {}
      this.process = null;
    }
  }
}

module.exports = new InputManager();
