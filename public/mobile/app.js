(function() {
  'use strict';

  // Cookie helpers
  function getCookie(name) {
    const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
    return match ? decodeURIComponent(match[2]) : '';
  }

  function setCookie(name, val) {
    document.cookie = `${name}=${encodeURIComponent(val)}; max-age=31536000; path=/; SameSite=Lax`;
  }

  // Base64URL to Uint8Array converter for Web Crypto API
  function base64UrlToUint8Array(str) {
    let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) base64 += '=';
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  // Credentials extraction: Hash fragment has highest priority (Zero-Knowledge: never sent to servers)
  let hashToken = '';
  let hashKey = '';
  if (window.location.hash && window.location.hash.length > 1) {
    const hashParams = new URLSearchParams(window.location.hash.substring(1));
    hashToken = hashParams.get('token') || '';
    hashKey = hashParams.get('key') || '';
  }

  const searchParams = new URLSearchParams(window.location.search);
  let pcId = searchParams.get('id') || localStorage.getItem('pocketdesk_pc_id') || getCookie('pocketdesk_pc_id') || '';
  let token = hashToken || searchParams.get('token') || localStorage.getItem('pocketdesk_token') || getCookie('pocketdesk_token') || '';
  let encryptionKey = hashKey || searchParams.get('key') || localStorage.getItem('pocketdesk_key') || getCookie('pocketdesk_key') || '';

  function persistCredentials() {
    if (pcId) {
      localStorage.setItem('pocketdesk_pc_id', pcId);
      setCookie('pocketdesk_pc_id', pcId);
    }
    if (token) {
      localStorage.setItem('pocketdesk_token', token);
      setCookie('pocketdesk_token', token);
    }
    if (encryptionKey) {
      localStorage.setItem('pocketdesk_key', encryptionKey);
      setCookie('pocketdesk_key', encryptionKey);
    }
    // Maintain Zero-Knowledge URL hash for offline bookmarks & refresh
    if (token && encryptionKey) {
      try {
        history.replaceState(null, '', `?id=${encodeURIComponent(pcId)}#token=${encodeURIComponent(token)}&key=${encodeURIComponent(encryptionKey)}`);
      } catch (e) {}
    }
  }

  persistCredentials();

  // Web Crypto Subtle AES-256-GCM cipher state
  let cryptoKey = null;

  async function initCryptoKey(keyBase64Url) {
    if (!keyBase64Url) return false;
    try {
      const keyBytes = base64UrlToUint8Array(keyBase64Url);
      cryptoKey = await window.crypto.subtle.importKey(
        'raw',
        keyBytes,
        { name: 'AES-GCM' },
        false,
        ['encrypt', 'decrypt']
      );
      console.log('[E2EE] AES-256-GCM master key imported');
      const badge = document.getElementById('e2eeBadge');
      if (badge) badge.style.display = 'inline-flex';
      return true;
    } catch (err) {
      console.error('[E2EE] Key import error:', err);
      return false;
    }
  }

  let ws = null;
  let peerConnection = null;
  let isConnected = false;
  let isRevoked = false;
  let reconnectTimer = null;
  let isScrollMode = false;

  // Speeds: 1.5x (Slow), 2.5x (Normal/Default), 3.8x (Fast), 5.5x (Super Fast)
  const speeds = [1.5, 2.5, 3.8, 5.5];
  let speedIndex = parseInt(localStorage.getItem('pocketdesk_speed_idx') || '1', 10);
  if (isNaN(speedIndex) || speedIndex < 0 || speedIndex >= speeds.length) speedIndex = 1;
  let currentSpeed = speeds[speedIndex];

  // Touch tracking state
  let touchStartTime = 0;
  let touchStartX = 0;
  let touchStartY = 0;
  let lastTouchX = 0;
  let lastTouchY = 0;
  let touchMoved = false;
  let touchCount = 0;

  // DOM Elements
  const statusDot = document.getElementById('statusDot');
  const pcNameDisplay = document.getElementById('pcNameDisplay');
  const remoteVideo = document.getElementById('remoteVideo');
  const remoteScreenImg = document.getElementById('remoteScreenImg');
  const virtualCursor = document.getElementById('virtualCursor');
  const screenWrapper = document.getElementById('screenWrapper');
  let currentFrameBlobUrl = null;
  let pcScreenWidth = 1920;
  let pcScreenHeight = 1080;
  let cursorX = 960;
  let cursorY = 540;

  function updateCursorDisplay(x, y) {
    if (!virtualCursor || !remoteScreenImg || !screenWrapper) return;
    cursorX = Math.max(0, Math.min(pcScreenWidth, x));
    cursorY = Math.max(0, Math.min(pcScreenHeight, y));

    const rect = remoteScreenImg.getBoundingClientRect();
    const wrapperRect = screenWrapper.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const imgAspect = pcScreenWidth / pcScreenHeight;
    const containerAspect = rect.width / rect.height;
    let renderW, renderH, offsetX, offsetY;

    if (containerAspect > imgAspect) {
      renderH = rect.height;
      renderW = renderH * imgAspect;
      offsetX = (rect.width - renderW) / 2;
      offsetY = 0;
    } else {
      renderW = rect.width;
      renderH = renderW / imgAspect;
      offsetX = 0;
      offsetY = (rect.height - renderH) / 2;
    }

    const screenLeft = (rect.left - wrapperRect.left) + offsetX;
    const screenTop = (rect.top - wrapperRect.top) + offsetY;

    const pixelX = screenLeft + (cursorX / pcScreenWidth) * renderW;
    const pixelY = screenTop + (cursorY / pcScreenHeight) * renderH;

    virtualCursor.style.left = `${pixelX}px`;
    virtualCursor.style.top = `${pixelY}px`;
  }

  const touchSurface = document.getElementById('touchSurface');
  const touchFeedback = document.getElementById('touchFeedback');
  const connectingOverlay = document.getElementById('connectingOverlay');
  const connectingSpinner = document.getElementById('connectingSpinner');
  const connectingStatus = document.getElementById('connectingStatus');
  const connectingSubtext = document.getElementById('connectingSubtext');
  const pinEntryBox = document.getElementById('pinEntryBox');
  const pinInput = document.getElementById('pinInput');
  const btnSubmitPin = document.getElementById('btnSubmitPin');
  const pinError = document.getElementById('pinError');
  const revokedOverlay = document.getElementById('revokedOverlay');
  
  const speedToggleBtn = document.getElementById('speedToggleBtn');
  const speedLabel = document.getElementById('speedLabel');
  const keyboardToggleBtn = document.getElementById('keyboardToggleBtn');
  const keyboardInput = document.getElementById('keyboardInput');
  const shortcutsToggleBtn = document.getElementById('shortcutsToggleBtn');
  const shortcutsBar = document.getElementById('shortcutsBar');
  const btnQuickSpace = document.getElementById('btnQuickSpace');
  
  const btnLeftClick = document.getElementById('btnLeftClick');
  const btnScrollToggle = document.getElementById('btnScrollToggle');
  const btnRightClick = document.getElementById('btnRightClick');
  
  const powerModalBtn = document.getElementById('powerModalBtn');
  const powerModal = document.getElementById('powerModal');
  const closePowerModalBtn = document.getElementById('closePowerModalBtn');

  // WebRTC ICE Configuration (Free Public STUN servers)
  const rtcConfig = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  };

  function updateSpeedUI() {
    if (speedLabel) speedLabel.textContent = `${currentSpeed}x`;
    localStorage.setItem('pocketdesk_speed_idx', speedIndex);
  }

  async function init() {
    updateSpeedUI();

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }

    setupEventListeners();

    if (encryptionKey) {
      await initCryptoKey(encryptionKey);
    }

    if (!token) {
      showPinEntry('Pairing Token Missing', 'Enter your PC 6-digit PIN to authorize this browser:');
      return;
    }

    connectWebSocket();
  }

  function showPinEntry(title, message) {
    connectingStatus.textContent = title;
    connectingSubtext.textContent = message;
    connectingSpinner.classList.add('hidden');
    pinEntryBox.classList.remove('hidden');
    connectingOverlay.classList.remove('hidden');
  }

  async function connectWebSocket() {
    if (isRevoked || !token) return;

    if (ws) {
      try { ws.close(); } catch(e) {}
    }

    if (!cryptoKey && encryptionKey) {
      await initCryptoKey(encryptionKey);
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    setStatus('connecting', 'Connecting...');
    connectingSpinner.classList.remove('hidden');
    pinEntryBox.classList.add('hidden');
    connectingOverlay.classList.remove('hidden');

    try {
      ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';

      ws.onopen = async () => {
        console.log('[WS] Connected, authenticating E2EE...');
        await sendSocket('auth', {
          id: pcId,
          token: token,
          name: getDeviceFriendlyName(),
          userAgent: navigator.userAgent
        });
      };

      ws.onmessage = async (event) => {
        // Direct E2EE screen frame & control messages
        if (event.data instanceof ArrayBuffer) {
          const buf = new Uint8Array(event.data);

          // E2EE Typed packet: [Type (1 byte)] + [IV (12 bytes)] + [Ciphertext + Tag]
          if (cryptoKey && buf.length >= 29 && (buf[0] === 1 || buf[0] === 2)) {
            const packetType = buf[0];
            const iv = buf.subarray(1, 13);
            const cipherWithTag = buf.subarray(13);
            try {
              const decrypted = await window.crypto.subtle.decrypt(
                { name: 'AES-GCM', iv },
                cryptoKey,
                cipherWithTag
              );

              if (packetType === 1) { // Screen Frame JPEG
                if (currentFrameBlobUrl) {
                  URL.revokeObjectURL(currentFrameBlobUrl);
                }
                const frameBlob = new Blob([decrypted], { type: 'image/jpeg' });
                currentFrameBlobUrl = URL.createObjectURL(frameBlob);
                remoteScreenImg.src = currentFrameBlobUrl;
                connectingOverlay.classList.add('hidden');
              } else if (packetType === 2) { // Control JSON
                const decStr = new TextDecoder().decode(decrypted);
                const msg = JSON.parse(decStr);
                handleServerMessage(msg);
              }
            } catch (err) {
              console.error('[E2EE Decrypt Error]:', err);
            }
            return;
          }

          // Fallback: check if unencrypted JPEG frame (magic bytes 0xFF 0xD8)
          if (buf.length > 2 && buf[0] === 0xFF && buf[1] === 0xD8) {
            if (currentFrameBlobUrl) {
              URL.revokeObjectURL(currentFrameBlobUrl);
            }
            const frameBlob = new Blob([event.data], { type: 'image/jpeg' });
            currentFrameBlobUrl = URL.createObjectURL(frameBlob);
            remoteScreenImg.src = currentFrameBlobUrl;
            connectingOverlay.classList.add('hidden');
            return;
          }
        }

        // String message fallback
        if (typeof event.data === 'string') {
          try {
            const msg = JSON.parse(event.data);
            handleServerMessage(msg);
          } catch (err) {
            console.error('[WS Parse Error]:', err);
          }
        }
      };

      ws.onclose = (event) => {
        if (event.code === 4003 || isRevoked) {
          handleRevocation();
          return;
        }
        handleDisconnect('PC offline or restarting. Reconnecting automatically...');
      };

      ws.onerror = () => {
        if (!isRevoked) handleDisconnect('Connection error. Retrying...');
      };
    } catch (err) {
      handleDisconnect('Failed to reach server. Retrying...');
    }
  }

  function handleDisconnect(message) {
    if (isRevoked) return;
    isConnected = false;
    setStatus('disconnected', 'Disconnected');
    connectingOverlay.classList.remove('hidden');
    connectingStatus.textContent = 'Reconnecting...';
    connectingSubtext.textContent = message;

    if (peerConnection) {
      try { peerConnection.close(); } catch(e) {}
      peerConnection = null;
    }

    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectWebSocket, 2500);
  }

  function handleRevocation() {
    isRevoked = true;
    isConnected = false;
    token = '';
    encryptionKey = '';
    cryptoKey = null;
    localStorage.removeItem('pocketdesk_pc_id');
    localStorage.removeItem('pocketdesk_token');
    localStorage.removeItem('pocketdesk_key');
    setCookie('pocketdesk_token', '');
    setCookie('pocketdesk_key', '');

    setStatus('disconnected', 'Revoked');
    connectingOverlay.classList.add('hidden');
    revokedOverlay.classList.remove('hidden');

    if (peerConnection) {
      try { peerConnection.close(); } catch(e) {}
      peerConnection = null;
    }
  }

  function handleServerMessage(msg) {
    const { type, payload } = msg;

    switch (type) {
      case 'auth_success':
        isConnected = true;
        setStatus('connected', payload.deviceName || 'PC Connected');
        pcNameDisplay.textContent = payload.deviceName || 'My PC';
        if (payload.screenWidth) pcScreenWidth = payload.screenWidth;
        if (payload.screenHeight) pcScreenHeight = payload.screenHeight;
        cursorX = pcScreenWidth / 2;
        cursorY = pcScreenHeight / 2;
        updateCursorDisplay(cursorX, cursorY);
        connectingStatus.textContent = 'Streaming PC Screen (E2EE)...';
        initWebRTC();
        break;

      case 'cursor_pos':
        if (payload && typeof payload.x === 'number') {
          updateCursorDisplay(payload.x, payload.y);
        }
        break;

      case 'auth_failed':
        showPinEntry('Authentication Expired', 'The PC pairing key changed. Enter your 6-digit PIN:');
        break;

      case 'revoked':
        handleRevocation();
        break;

      case 'webrtc_offer':
        handleWebRTCOffer(payload);
        break;

      case 'webrtc_ice':
        handleRemoteICE(payload);
        break;
    }
  }

  // WebRTC Setup (Free Public STUN servers)
  function initWebRTC() {
    if (peerConnection) {
      try { peerConnection.close(); } catch(e) {}
    }

    peerConnection = new RTCPeerConnection(rtcConfig);

    peerConnection.ontrack = (event) => {
      console.log('[WebRTC] Stream track received:', event.streams[0]);
      remoteVideo.srcObject = event.streams[0];
      remoteVideo.play().catch(e => console.warn('Video play:', e));
      connectingOverlay.classList.add('hidden');
    };

    peerConnection.onicecandidate = (event) => {
      if (event.candidate && ws && ws.readyState === WebSocket.OPEN) {
        sendSocket('webrtc_ice', event.candidate);
      }
    };

    peerConnection.onconnectionstatechange = () => {
      console.log('[WebRTC] Connection state:', peerConnection.connectionState);
      if (peerConnection.connectionState === 'connected') {
        connectingOverlay.classList.add('hidden');
      } else if (peerConnection.connectionState === 'failed' || peerConnection.connectionState === 'disconnected') {
        if (ws && ws.readyState === WebSocket.OPEN) {
          initWebRTC();
        }
      }
    };
  }

  async function handleWebRTCOffer(offer) {
    try {
      if (!peerConnection) initWebRTC();
      await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);

      if (ws && ws.readyState === WebSocket.OPEN) {
        sendSocket('webrtc_answer', answer);
      }
    } catch (err) {
      console.error('[WebRTC] Offer error:', err);
    }
  }

  async function handleRemoteICE(candidate) {
    try {
      if (peerConnection && candidate) {
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      }
    } catch (err) {
      console.error('[WebRTC] ICE candidate error:', err);
    }
  }

  // Dedicated Trackpad Touch Handlers with Velocity Acceleration
  function setupEventListeners() {
    // Speed Toggle
    if (speedToggleBtn) {
      speedToggleBtn.addEventListener('click', () => {
        speedIndex = (speedIndex + 1) % speeds.length;
        currentSpeed = speeds[speedIndex];
        updateSpeedUI();
        triggerVibrate(20);
      });
    }

    // PIN Submit
    if (btnSubmitPin) {
      btnSubmitPin.addEventListener('click', async () => {
        const pin = pinInput.value.trim();
        if (!pin) return;

        btnSubmitPin.disabled = true;
        btnSubmitPin.textContent = 'Verifying...';
        pinError.classList.add('hidden');

        try {
          const res = await fetch('/api/auth-pin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pin })
          });
          const data = await res.json();
          if (data.success && data.token) {
            token = data.token;
            pcId = data.deviceId;
            encryptionKey = data.encryptionKey || '';

            persistCredentials();
            if (encryptionKey) {
              await initCryptoKey(encryptionKey);
            }

            pinEntryBox.classList.add('hidden');
            connectingSpinner.classList.remove('hidden');
            connectWebSocket();
          } else {
            pinError.textContent = data.error || 'Invalid PIN';
            pinError.classList.remove('hidden');
          }
        } catch (err) {
          pinError.textContent = 'Unable to reach PC';
          pinError.classList.remove('hidden');
        } finally {
          btnSubmitPin.disabled = false;
          btnSubmitPin.textContent = 'Pair';
        }
      });
    }

    // Trackpad Surface Touch Gestures
    touchSurface.addEventListener('touchstart', onTouchStart, { passive: false });
    touchSurface.addEventListener('touchmove', onTouchMove, { passive: false });
    touchSurface.addEventListener('touchend', onTouchEnd, { passive: false });
    touchSurface.addEventListener('touchcancel', onTouchEnd, { passive: false });

    // Scroll Mode Toggle
    btnScrollToggle.addEventListener('click', () => {
      isScrollMode = !isScrollMode;
      btnScrollToggle.classList.toggle('active', isScrollMode);
    });

    // Left Click
    btnLeftClick.addEventListener('click', () => {
      sendSocket('input_click', { button: 'left' });
      triggerVibrate(20);
    });

    // Right Click
    btnRightClick.addEventListener('click', () => {
      sendSocket('input_click', { button: 'right' });
      triggerVibrate(30);
    });

    // Keyboard Toggle
    keyboardToggleBtn.addEventListener('click', () => {
      keyboardInput.value = '';
      keyboardInput.focus();
      keyboardInput.click();
    });

    // Native Mobile Keyboard Input & Space Handling
    keyboardInput.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.code === 'Space' || e.keyCode === 32) {
        e.preventDefault();
        sendSocket('input_space');
        triggerVibrate(15);
      } else if (e.key === 'Backspace' || e.keyCode === 8) {
        sendSocket('input_key', { vk: 8, isDown: true });
        setTimeout(() => sendSocket('input_key', { vk: 8, isDown: false }), 20);
        triggerVibrate(15);
      } else if (e.key === 'Enter' || e.keyCode === 13) {
        sendSocket('input_key', { vk: 13, isDown: true });
        setTimeout(() => sendSocket('input_key', { vk: 13, isDown: false }), 20);
        triggerVibrate(20);
      }
    });

    keyboardInput.addEventListener('input', (e) => {
      const val = keyboardInput.value;
      if (!val) return;

      if (val === ' ') {
        sendSocket('input_space');
      } else {
        sendSocket('input_text', { text: val });
      }
      keyboardInput.value = '';
    });

    // Quick Space Button
    if (btnQuickSpace) {
      btnQuickSpace.addEventListener('click', () => {
        sendSocket('input_space');
        triggerVibrate(20);
      });
    }

    // Shortcuts Bar
    shortcutsToggleBtn.addEventListener('click', () => {
      shortcutsBar.classList.toggle('hidden');
    });

    document.querySelectorAll('.key-btn[data-hotkey]').forEach(btn => {
      btn.addEventListener('click', () => {
        const hotkey = btn.getAttribute('data-hotkey');
        if (hotkey) sendSocket('input_hotkey', { combo: hotkey });
        triggerVibrate(25);
      });
    });

    document.querySelectorAll('.key-btn[data-key]').forEach(btn => {
      btn.addEventListener('click', () => {
        const vk = parseInt(btn.getAttribute('data-key'), 10);
        sendSocket('input_key', { vk, isDown: true });
        setTimeout(() => sendSocket('input_key', { vk, isDown: false }), 30);
        triggerVibrate(25);
      });
    });

    // Power Modal
    powerModalBtn.addEventListener('click', () => {
      powerModal.classList.remove('hidden');
    });

    closePowerModalBtn.addEventListener('click', () => {
      powerModal.classList.add('hidden');
    });

    document.querySelectorAll('.power-action-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.getAttribute('data-action');
        if (action === 'restart') {
          if (confirm('Are you sure you want to RESTART your PC?\n\nPocketDesk will reconnect automatically once Windows reboots.')) {
            sendSocket('power_action', { action: 'restart' });
            powerModal.classList.add('hidden');
          }
        } else {
          sendSocket('power_action', { action });
          powerModal.classList.add('hidden');
        }
      });
    });
  }

  function onTouchStart(e) {
    e.preventDefault();
    touchCount = e.touches.length;
    touchStartTime = Date.now();
    touchMoved = false;

    const t = e.touches[0];
    const rect = touchSurface.getBoundingClientRect();
    touchStartX = t.clientX - rect.left;
    touchStartY = t.clientY - rect.top;
    lastTouchX = t.clientX;
    lastTouchY = t.clientY;

    showTouchFeedback(touchStartX, touchStartY);
  }

  function onTouchMove(e) {
    e.preventDefault();
    const t = e.touches[0];
    const rawDx = t.clientX - lastTouchX;
    const rawDy = t.clientY - lastTouchY;

    if (Math.abs(rawDx) > 2 || Math.abs(rawDy) > 2) {
      touchMoved = true;
    }

    lastTouchX = t.clientX;
    lastTouchY = t.clientY;

    const rect = touchSurface.getBoundingClientRect();
    showTouchFeedback(t.clientX - rect.left, t.clientY - rect.top);

    if (isScrollMode || e.touches.length === 2) {
      // 2-finger scroll
      const scrollDelta = -rawDy * 3;
      sendSocket('input_wheel', { deltaY: scrollDelta });
      return;
    }

    // Dynamic Velocity-Based Acceleration
    const dist = Math.hypot(rawDx, rawDy);
    let accel = 1.0;
    if (dist > 15) {
      accel = 2.0; // Fast swipe reaches far across the screen
    } else if (dist > 8) {
      accel = 1.45;
    } else if (dist < 2.5) {
      accel = 0.85; // Micro precision
    }

    const dx = rawDx * currentSpeed * accel;
    const dy = rawDy * currentSpeed * accel;

    cursorX += dx;
    cursorY += dy;
    updateCursorDisplay(cursorX, cursorY);

    sendSocket('input_move_rel', { dx, dy });
  }

  function onTouchEnd(e) {
    e.preventDefault();
    hideTouchFeedback();
    const elapsed = Date.now() - touchStartTime;

    if (!touchMoved && elapsed < 260) {
      // Tap detected on the trackpad
      if (touchCount === 1) {
        // 1 finger tap = Left Click
        sendSocket('input_click', { button: 'left' });
        triggerVibrate(15);
      } else if (touchCount === 2) {
        // 2 finger tap = Right Click
        sendSocket('input_click', { button: 'right' });
        triggerVibrate(30);
      }
    }

    touchCount = e.touches.length;
  }

  // Encrypted Outgoing Socket Dispatcher (Zero-Knowledge E2EE)
  async function sendSocket(type, payload = {}) {
    if (!ws || ws.readyState !== WebSocket.OPEN || isRevoked) return;
    const jsonStr = JSON.stringify({ type, payload });

    if (cryptoKey) {
      try {
        const iv = window.crypto.getRandomValues(new Uint8Array(12));
        const plaintextBytes = new TextEncoder().encode(jsonStr);
        const encrypted = await window.crypto.subtle.encrypt(
          { name: 'AES-GCM', iv },
          cryptoKey,
          plaintextBytes
        );
        // Wire packet format: [Type 0x02 (JSON)] + [IV (12 bytes)] + [Ciphertext + Tag]
        const packet = new Uint8Array(1 + 12 + encrypted.byteLength);
        packet[0] = 0x02; // PACKET_TYPE_JSON
        packet.set(iv, 1);
        packet.set(new Uint8Array(encrypted), 13);
        ws.send(packet.buffer);
        return;
      } catch (err) {
        console.error('[E2EE Encrypt Error]:', err);
      }
    }

    // Fallback: unencrypted text
    ws.send(jsonStr);
  }

  function setStatus(status, text) {
    statusDot.className = `status-dot ${status}`;
    pcNameDisplay.title = text;
  }

  function showTouchFeedback(x, y) {
    touchFeedback.style.left = `${x}px`;
    touchFeedback.style.top = `${y}px`;
    touchFeedback.classList.add('active');
  }

  function hideTouchFeedback() {
    touchFeedback.classList.remove('active');
  }

  function triggerVibrate(ms) {
    if ('vibrate' in navigator) {
      try { navigator.vibrate(ms); } catch(e) {}
    }
  }

  function getDeviceFriendlyName() {
    const ua = navigator.userAgent;
    if (/iPhone/i.test(ua)) return 'Apple iPhone';
    if (/iPad/i.test(ua)) return 'Apple iPad';
    if (/Android/i.test(ua)) return 'Android Device';
    return 'Mobile Phone';
  }

  window.addEventListener('DOMContentLoaded', init);
  window.addEventListener('resize', () => updateCursorDisplay(cursorX, cursorY));
})();