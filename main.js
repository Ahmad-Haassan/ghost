const { app, BrowserWindow, Tray, Menu, ipcMain, desktopCapturer } = require('electron');
const path = require('path');
const { exec } = require('child_process');

const server = require('./server');
const configManager = require('./config');
const inputManager = require('./inputManager');

// Disable WebRTC mDNS hiding for direct LAN/STUN P2P
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');

let mainWindow = null;
let tray = null;
let isQuitting = false;

// Ensure single instance
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  process.exit(0);
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 680,
    minWidth: 860,
    minHeight: 600,
    title: 'PocketDesk Remote - Control Center',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    backgroundColor: '#0f172a',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false
    },
    show: true
  });

  mainWindow.loadFile(path.join(__dirname, 'desktop', 'index.html'));

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      if (tray) {
        tray.displayBalloon({
          title: 'PocketDesk Remote',
          content: 'PocketDesk is running in your system tray. Paired phones can still connect!'
        });
      }
    }
  });
}

function createTray() {
  try {
    const iconPath = path.join(__dirname, 'assets', 'icon.ico');
    tray = new Tray(iconPath);

    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Open Dashboard',
        click: () => {
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
          }
        }
      },
      {
        label: 'Allow Mobile Control',
        type: 'checkbox',
        checked: configManager.getConfig().allowControl,
        click: (menuItem) => {
          configManager.updateConfig({ allowControl: menuItem.checked });
        }
      },
      { type: 'separator' },
      {
        label: 'Create Desktop Shortcut',
        click: () => setupDesktopShortcut()
      },
      { type: 'separator' },
      {
        label: 'Exit PocketDesk',
        click: () => {
          isQuitting = true;
          app.quit();
        }
      }
    ]);

    tray.setToolTip('PocketDesk Remote ($0)');
    tray.setContextMenu(contextMenu);

    tray.on('double-click', () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      }
    });
  } catch (err) {
    console.warn('Tray creation warning:', err);
  }
}

function setupAutoStart(enable) {
  const electronExe = path.join(__dirname, 'node_modules', 'electron', 'dist', 'electron.exe');
  const command = enable
    ? `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "PocketDesk Remote" /t REG_SZ /d "\\"${electronExe}\\" \\"${__dirname}\\"" /f`
    : `reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "PocketDesk Remote" /f`;

  exec(command, (err) => {
    if (err) console.error('[AutoStart Registry Error]:', err);
    else console.log(`[AutoStart] Registry set to: ${enable}`);
  });
}

function setupDesktopShortcut() {
  const ps1Path = path.join(__dirname, 'create-shortcut.ps1');
  exec(`powershell -ExecutionPolicy Bypass -File "${ps1Path}"`, (err, stdout) => {
    if (err) console.error('[Shortcut Error]:', err);
    else console.log('[Shortcut Created]:', stdout);
  });
}

// IPC Handlers
ipcMain.on('window-minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('window-close', () => {
  if (mainWindow) mainWindow.hide();
});

ipcMain.on('toggle-auto-start', (event, enable) => {
  setupAutoStart(enable);
});

ipcMain.on('create-desktop-shortcut', () => {
  setupDesktopShortcut();
});

ipcMain.handle('get-screen-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 0, height: 0 }
  });
  return sources.map(s => ({ id: s.id, name: s.name }));
});

let isCapturingFrame = false;
let screenCaptureInterval = null;

function startScreenBroadcaster() {
  if (screenCaptureInterval) return;

  screenCaptureInterval = setInterval(async () => {
    // Only capture if active mobile viewers are waiting
    if (server.getActiveConnectedCount() === 0 || isCapturingFrame) return;

    isCapturingFrame = true;
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1280, height: 720 }
      });
      if (sources.length > 0) {
        const primary = sources[0];
        const jpeg = primary.thumbnail.toJPEG(65);
        server.broadcastScreenFrame(jpeg);
      }
    } catch (e) {
      // ignore
    } finally {
      isCapturingFrame = false;
    }
  }, 100);
}

// App lifecycle
app.whenReady().then(async () => {
  try {
    // Start Express + WebSocket server
    await server.init();

    // Auto-start in registry if enabled
    const cfg = configManager.getConfig();
    if (cfg.autoStart) {
      setupAutoStart(true);
    }

    createTray();
    await createWindow();

    // Start WebSocket direct screen frame broadcaster (100% immune to 4G/5G carrier firewalls)
    startScreenBroadcaster();

    server.on('devices_status_update', (devices) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('devices-update', devices);
      }
    });

  } catch (err) {
    console.error('Failed to initialize PocketDesk:', err);
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  inputManager.destroy();
  server.close();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'win32' || isQuitting) {
    app.quit();
  }
});
