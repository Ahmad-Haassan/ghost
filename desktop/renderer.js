const { ipcRenderer } = require('electron');

let currentConfig = null;
let currentIps = [];
let selectedIp = null;
let hostWs = null;
let screenStream = null;
let activePeerConnections = new Map(); // clientId -> RTCPeerConnection

// Free public STUN servers for WebRTC
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// DOM Elements
const tabButtons = document.querySelectorAll('.nav-item');
const tabPanes = document.querySelectorAll('.tab-pane');
const qrImage = document.getElementById('qrImage');
const qrLoading = document.getElementById('qrLoading');
const deviceIdInput = document.getElementById('deviceIdInput');
const pcPinInput = document.getElementById('pcPinInput');
const mobileUrlInput = document.getElementById('mobileUrlInput');
const ipSelector = document.getElementById('ipSelector');
const btnCopyId = document.getElementById('btnCopyId');
const btnCopyPin = document.getElementById('btnCopyPin');
const btnCopyUrl = document.getElementById('btnCopyUrl');
const devicesList = document.getElementById('devicesList');
const badgeDeviceCount = document.getElementById('badgeDeviceCount');
const footerIpDisplay = document.getElementById('footerIpDisplay');
const footerConnectedCount = document.getElementById('footerConnectedCount');
const toggleAutoStart = document.getElementById('toggleAutoStart');
const toggleAllowControl = document.getElementById('toggleAllowControl');
const btnCreateDesktopShortcut = document.getElementById('btnCreateDesktopShortcut');
const btnMinimize = document.getElementById('btnMinimize');
const btnClose = document.getElementById('btnClose');
const localScreenVideo = document.getElementById('localScreenVideo');

// Navigation Tabs
tabButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    tabButtons.forEach(b => b.classList.remove('active'));
    tabPanes.forEach(p => p.classList.remove('active'));

    btn.classList.add('active');
    const target = btn.getAttribute('data-tab');
    document.getElementById(target).classList.add('active');
  });
});

// Window controls
btnMinimize.addEventListener('click', () => ipcRenderer.send('window-minimize'));
btnClose.addEventListener('click', () => ipcRenderer.send('window-close'));

// Copy buttons
btnCopyId.addEventListener('click', () => {
  navigator.clipboard.writeText(deviceIdInput.value);
  btnCopyId.textContent = 'Copied!';
  setTimeout(() => btnCopyId.textContent = 'Copy', 1500);
});

if (btnCopyPin && pcPinInput) {
  btnCopyPin.addEventListener('click', () => {
    navigator.clipboard.writeText(pcPinInput.value);
    btnCopyPin.textContent = 'Copied!';
    setTimeout(() => btnCopyPin.textContent = 'Copy', 1500);
  });
}

btnCopyUrl.addEventListener('click', () => {
  navigator.clipboard.writeText(mobileUrlInput.value);
  btnCopyUrl.textContent = 'Copied!';
  setTimeout(() => btnCopyUrl.textContent = 'Copy Link', 1500);
});

// Network IP Selector change
ipSelector.addEventListener('change', () => {
  selectedIp = ipSelector.value;
  updateQR();
});

// Auto-Start Toggle
toggleAutoStart.addEventListener('change', async () => {
  const enabled = toggleAutoStart.checked;
  ipcRenderer.send('toggle-auto-start', enabled);
  await fetch('http://localhost:48765/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ autoStart: enabled })
  });
});

// Allow Control Toggle
toggleAllowControl.addEventListener('change', async () => {
  const allow = toggleAllowControl.checked;
  await fetch('http://localhost:48765/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ allowControl: allow })
  });
});

// Create Shortcut button
btnCreateDesktopShortcut.addEventListener('click', () => {
  ipcRenderer.send('create-desktop-shortcut');
  btnCreateDesktopShortcut.textContent = 'Shortcut Created!';
  setTimeout(() => {
    btnCreateDesktopShortcut.textContent = 'Create Desktop Shortcut Icon';
  }, 2000);
});

// Fetch Server Status & QR
async function loadStatus() {
  try {
    const res = await fetch('http://localhost:48765/api/status');
    const data = await res.json();
    currentConfig = data;

    deviceIdInput.value = data.deviceId;
    if (pcPinInput && data.pin) pcPinInput.value = data.pin;
    toggleAutoStart.checked = data.autoStart;
    toggleAllowControl.checked = data.allowControl;

    // Populate Network Selector
    currentIps = data.ips;
    ipSelector.innerHTML = '';

    // Option 1: Global Cloudflare Tunnel (HTTPS)
    const optTunnel = document.createElement('option');
    optTunnel.value = 'tunnel';
    optTunnel.textContent = data.tunnelUrl
      ? `🌐 Global 4G/5G Internet (HTTPS - Anywhere)`
      : `🌐 Global 4G/5G Internet (Connecting Tunnel...)`;
    ipSelector.appendChild(optTunnel);

    // Option 2: Local Wi-Fi / LAN IPs
    currentIps.forEach(net => {
      const opt = document.createElement('option');
      opt.value = net.address;
      opt.textContent = `📶 Local Wi-Fi: ${net.name} (${net.address})`;
      ipSelector.appendChild(opt);
    });

    if (!selectedIp) {
      selectedIp = 'tunnel';
    }

    footerIpDisplay.textContent = data.tunnelUrl
      ? `Internet: Live (4G/5G)`
      : `Local IP: ${currentIps.length > 0 ? currentIps[0].address : '127.0.0.1'}`;

    await updateQR();
    await loadDevices();
  } catch (err) {
    console.error('Error fetching status:', err);
  }
}

async function updateQR() {
  try {
    qrLoading.style.display = 'block';
    const target = selectedIp || 'tunnel';
    const res = await fetch(`http://localhost:48765/api/qr?ip=${target}`);
    const data = await res.json();

    if (data.success) {
      qrImage.src = data.qr;
      mobileUrlInput.value = data.url;
      qrLoading.style.display = 'none';
    }
  } catch (err) {
    console.error('Error loading QR:', err);
  }
}

async function loadDevices() {
  try {
    const res = await fetch('http://localhost:48765/api/devices');
    const data = await res.json();
    renderDevicesList(data.devices || []);
  } catch (err) {
    console.error('Error loading devices:', err);
  }
}

function renderDevicesList(devices) {
  badgeDeviceCount.textContent = devices.length;
  if (!devices || devices.length === 0) {
    devicesList.innerHTML = `
      <div class="empty-state">
        <span class="empty-icon">📱</span>
        <p>No mobile devices paired yet.</p>
        <small>Scan the QR code in the Connect tab to pair your phone.</small>
      </div>
    `;
    return;
  }

  devicesList.innerHTML = '';
  devices.forEach(dev => {
    const item = document.createElement('div');
    item.className = 'device-item';
    const isLive = dev.isLive || false;
    item.innerHTML = `
      <div class="device-meta">
        <strong>
          ${escapeHtml(dev.name)}
          <span class="device-status ${isLive ? 'live' : 'offline'}">${isLive ? 'Active' : 'Offline'}</span>
        </strong>
        <small>IP: ${escapeHtml(dev.ip || 'Unknown')} • Paired: ${new Date(dev.pairedAt).toLocaleDateString()}</small>
      </div>
      <button class="btn-action" data-revoke="${dev.id}">Revoke</button>
    `;

    item.querySelector('button').addEventListener('click', async () => {
      if (confirm(`Revoke access for ${dev.name}?`)) {
        await fetch(`http://localhost:48765/api/devices/${dev.id}`, { method: 'DELETE' });
        loadDevices();
      }
    });

    devicesList.appendChild(item);
  });
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Host Screen Capture & WebRTC Broadcasting
async function startHostScreenCapture() {
  try {
    // Get primary display screen source
    const sources = await ipcRenderer.invoke('get-screen-sources');
    const primarySource = sources[0] || sources.find(s => s.name.includes('Entire Screen') || s.name.includes('Screen 1')) || sources[0];

    if (!primarySource) {
      console.error('No screen source found');
      return;
    }

    screenStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: primarySource.id,
          minWidth: 1280,
          maxWidth: 1920,
          minHeight: 720,
          maxHeight: 1080
        }
      }
    });

    const track = screenStream.getVideoTracks()[0];
    if (track) {
      track.onended = () => {
        console.warn('[Host Stream] Video track ended');
        screenStream = null;
      };
    }

    localScreenVideo.srcObject = screenStream;
    console.log('[Host Stream] Screen capture active at 60 FPS');
  } catch (err) {
    console.error('Screen capture error:', err);
  }
}

function connectHostWebSocket() {
  const wsUrl = 'ws://localhost:48765/ws';
  hostWs = new WebSocket(wsUrl);

  hostWs.onopen = () => {
    console.log('[Host WS] Connected, registering host...');
    hostWs.send(JSON.stringify({ type: 'register_host' }));
  };

  hostWs.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleHostMessage(msg);
    } catch (e) {
      console.error('Host WS message error:', e);
    }
  };

  hostWs.onclose = () => {
    console.warn('[Host WS] Closed, reconnecting in 2s...');
    setTimeout(connectHostWebSocket, 2000);
  };
}

async function handleHostMessage(msg) {
  const { type, payload } = msg;

  if (type === 'viewer_joined') {
    const { clientId } = payload;
    console.log('[Host] Viewer joined, creating WebRTC offer for client:', clientId);
    if (!screenStream) {
      await startHostScreenCapture();
    }
    createPeerConnectionForViewer(clientId);
  } else if (type === 'webrtc_answer') {
    const { clientId, sdp } = payload;
    const pc = activePeerConnections.get(clientId) || activePeerConnections.values().next().value;
    if (pc) {
      console.log('[Host] Setting remote answer description');
      await pc.setRemoteDescription(new RTCSessionDescription(payload));
    }
  } else if (type === 'webrtc_ice') {
    const { clientId } = payload;
    const pc = activePeerConnections.get(clientId) || activePeerConnections.values().next().value;
    if (pc && payload.candidate) {
      await pc.addIceCandidate(new RTCIceCandidate(payload));
    }
  }
}

async function createPeerConnectionForViewer(clientId) {
  if (activePeerConnections.has(clientId)) {
    try { activePeerConnections.get(clientId).close(); } catch(e) {}
  }

  // Ensure live screen capture stream is active before creating WebRTC offer
  if (!screenStream || screenStream.getVideoTracks().length === 0 || screenStream.getVideoTracks()[0].readyState === 'ended') {
    await startHostScreenCapture();
  }

  const pc = new RTCPeerConnection(rtcConfig);
  activePeerConnections.set(clientId, pc);

  // Add video track from screen capture
  if (screenStream) {
    screenStream.getTracks().forEach(track => {
      pc.addTrack(track, screenStream);
    });
  }

  pc.onicecandidate = (event) => {
    if (event.candidate && hostWs && hostWs.readyState === WebSocket.OPEN) {
      hostWs.send(JSON.stringify({
        type: 'webrtc_ice',
        payload: event.candidate
      }));
    }
  };

  pc.onconnectionstatechange = () => {
    console.log(`[Host PeerConnection ${clientId}] state:`, pc.connectionState);
    if (pc.connectionState === 'disconnected' || pc.connectionState === 'closed') {
      activePeerConnections.delete(clientId);
      updateConnectedCount();
    } else if (pc.connectionState === 'connected') {
      updateConnectedCount();
    }
  };

  // Create WebRTC Offer
  const offer = await pc.createOffer({
    offerToReceiveVideo: false,
    offerToReceiveAudio: false
  });
  await pc.setLocalDescription(offer);

  if (hostWs && hostWs.readyState === WebSocket.OPEN) {
    hostWs.send(JSON.stringify({
      type: 'webrtc_offer',
      payload: offer
    }));
  }
}

function updateConnectedCount() {
  const count = activePeerConnections.size;
  footerConnectedCount.textContent = `${count} Active Stream ${count === 1 ? 'Client' : 'Clients'}`;
}

// IPC updates from main process
ipcRenderer.on('devices-update', (event, devices) => {
  renderDevicesList(devices);
});

// Periodic refresh
setInterval(loadDevices, 4000);

// Auto-refresh when tunnel becomes available
const tunnelCheckInterval = setInterval(async () => {
  if (currentConfig && !currentConfig.tunnelUrl) {
    await loadStatus();
  } else if (currentConfig && currentConfig.tunnelUrl) {
    clearInterval(tunnelCheckInterval);
  }
}, 2500);

// Initialize
window.addEventListener('DOMContentLoaded', async () => {
  await loadStatus();
  connectHostWebSocket();
});
