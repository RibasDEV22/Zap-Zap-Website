/* =========================================================
   ZapZap – core.js
   Estado global, WebSocket, autenticação, tema, notificações
   ========================================================= */

const WS_URL = 'wss://zap-zap-24qi.onrender.com';

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:openrelay.metered.ca:80' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelay', credential: 'openrelay' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelay', credential: 'openrelay' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelay', credential: 'openrelay' }
  ]
};

// ========== ESTADO GLOBAL ==========
let ws = null;
let pingInterval = null;
let reconnectTimer = null;
let currentUser = null;
let activeChatTarget = null;
let isMuted = false;
let isRegisterMode = false;
let userAvatarBase64 = null;
let allContacts = [];
let currentTheme = localStorage.getItem('zap_theme') || 'dark';
let replyToMessage = null;
let selectedMessage = null;
let longPressTimer = null;
let searchDebounceTimer = null;
let isAppFocused = true;

// Áudio prefs
const audioPrefs = JSON.parse(localStorage.getItem('zap_audio_prefs') || '{}');
let audioVolumeBoost = audioPrefs.volumeBoost ?? 100;
let audioNoiseReduction = audioPrefs.noiseReduction ?? true;
let audioSmoothVoice = audioPrefs.smoothVoice ?? true;

// Gravação
let mediaRecorder = null;
let recordedChunks = [];
let recordingStream = null;
let isRecording = false;
let recordStartTs = 0;

// Sons
const soundNotification = new Audio('NotificationSound.mp3');
const soundCall = new Audio('CallSound.mp3');
soundCall.loop = true;
let audioCtx = null;
let syntheticRingtoneInterval = null;

// Chamada
let currentCall = {
  peerConnection: null,
  localStream: null,
  targetUser: null,
  pendingOffer: null
};
let pendingIceCandidates = [];

// ========== HELPERS ==========
function setCookie(name, value, days = 365) {
  const d = new Date();
  d.setTime(d.getTime() + days * 864e5);
  document.cookie = name + '=' + encodeURIComponent(value) + ';expires=' + d.toUTCString() + ';path=/;SameSite=Lax';
}

function getCookie(name) {
  const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}

function escapeHTML(str) {
  return String(str ?? '').replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

function escapeAttr(str) {
  return String(str ?? '').replace(/["'&<>]/g, m => ({
    '"': '&quot;', "'": '&#39;', '&': '&amp;', '<': '&lt;', '>': '&gt;'
  }[m]));
}

function isSecureContext() {
  return window.isSecureContext ||
    location.protocol === 'https:' ||
    location.hostname === 'localhost' ||
    location.hostname === '127.0.0.1';
}

// ========== TEMA ==========
function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('zap_theme', theme);
  const btn = document.getElementById('theme-toggle-btn');
  if (btn) btn.textContent = theme === 'dark' ? '☀️' : '🌙';
}

function toggleTheme() {
  applyTheme(currentTheme === 'dark' ? 'light' : 'dark');
}

// ========== AUDIO CONTEXT ==========
function getAudioContext() {
  if (!audioCtx) {
    const C = window.AudioContext || window.webkitAudioContext;
    if (C) audioCtx = new C();
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

function playSyntheticBeep() {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    gain.gain.setValueAtTime(0.12, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.28);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.28);
  } catch (e) {}
}

function playNotificationSound() {
  soundNotification.currentTime = 0;
  soundNotification.play().catch(() => playSyntheticBeep());
}

function startRingtoneSound() {
  soundCall.currentTime = 0;
  soundCall.play().catch(() => {
    stopRingtoneSound();
    syntheticRingtoneInterval = setInterval(playSyntheticBeep, 1000);
  });
}

function stopRingtoneSound() {
  soundCall.pause();
  soundCall.currentTime = 0;
  if (syntheticRingtoneInterval) {
    clearInterval(syntheticRingtoneInterval);
    syntheticRingtoneInterval = null;
  }
}

// ========== NOTIFICAÇÕES ==========
async function requestNotificationPermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') {
    setCookie('zap_notif', '1');
    return true;
  }
  if (Notification.permission !== 'denied') {
    const r = await Notification.requestPermission();
    if (r === 'granted') setCookie('zap_notif', '1');
    return r === 'granted';
  }
  return false;
}

function showPushNotification(title, body, options = {}) {
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      const n = new Notification(title, {
        body,
        tag: options.tag || 'zapzap',
        renotify: true,
        requireInteraction: !!options.requireInteraction,
        silent: false
      });
      n.onclick = () => {
        window.focus();
        n.close();
      };
      if (!options.requireInteraction) setTimeout(() => n.close(), 5500);
      return;
    } catch (e) {}
  }
  showInAppToast(title, body);
}

function showInAppToast(title, body) {
  let t = document.getElementById('in-app-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'in-app-toast';
    t.className = 'in-app-toast';
    document.body.appendChild(t);
  }
  t.innerHTML = '<strong>' + escapeHTML(title) + '</strong><span>' + escapeHTML(body) + '</span>';
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 4000);
}

// ========== VISIBILIDADE ==========
function sendAppVisibility(focused) {
  isAppFocused = !!focused;
  sendWS({ type: 'app_visibility', focused: isAppFocused });
}

function setupVisibilityListeners() {
  document.addEventListener('visibilitychange', () => {
    sendAppVisibility(document.visibilityState === 'visible');
  });
  window.addEventListener('focus', () => sendAppVisibility(true));
  window.addEventListener('blur', () => sendAppVisibility(false));
}

// ========== WEBSOCKET ==========
function hideSplashScreen() {
  const bar = document.getElementById('splash-bar');
  const ov = document.getElementById('splash-screen');
  if (bar) bar.style.width = '100%';
  setTimeout(() => {
    if (ov) ov.classList.add('hidden');
  }, 350);
}

function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    updateNetworkStatus('online', 'Conectado');
    if (pingInterval) clearInterval(pingInterval);
    pingInterval = setInterval(() => sendWS({ type: 'ping' }), 25000);

    sendAppVisibility(document.visibilityState === 'visible');

    const saved = localStorage.getItem('zap_session');
    if (saved) {
      try {
        const c = JSON.parse(saved);
        sendWS({ type: 'login', username: c.username, password: c.password });
      } catch {
        localStorage.removeItem('zap_session');
        hideSplashScreen();
      }
    } else {
      hideSplashScreen();
    }
  };

  ws.onmessage = e => {
    try {
      const data = JSON.parse(e.data);
      if (data.type === 'pong') return;
      handleServerMessage(data);
    } catch (err) {
      console.error('[WS] Erro ao processar mensagem do servidor:', err);
    }
  };

  ws.onerror = () => {
    updateNetworkStatus('offline', 'Erro de conexão');
    hideSplashScreen();
  };

  ws.onclose = () => {
    if (pingInterval) clearInterval(pingInterval);
    updateNetworkStatus('connecting', 'Reconectando...');
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectWebSocket();
      }, 2800);
    }
  };
}

function updateNetworkStatus(state, msg) {
  const el = document.getElementById('network-bar');
  if (!el) return;
  el.className = 'network-bar ' + state;
  el.textContent = msg;
}

function sendWS(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// ========== HANDLER CENTRAL DE MENSAGENS DO SERVIDOR ==========
function handleServerMessage(data) {
  switch (data.type) {
    case 'auth_success':
      currentUser = data.user;
      if (data.credentials) {
        localStorage.setItem('zap_session', JSON.stringify(data.credentials));
      }
      hideSplashScreen();
      showMainScreen();
      renderUserProfile();
      sendWS({ type: 'get_contacts' });
      sendWS({ type: 'get_announcements' });
      requestNotificationPermission();
      break;

    case 'auth_error':
      hideSplashScreen();
      showAuthError(data.message || 'Erro de autenticação');
      break;

    case 'contacts_list':
    case 'users_list':
      allContacts = data.users || [];
      if (typeof renderContacts === 'function') renderContacts(allContacts);
      if (typeof updateHeaderStatus === 'function') updateHeaderStatus();
      break;

    case 'profile_updated':
      if (data.user) {
        currentUser = Object.assign({}, currentUser, data.user);
        renderUserProfile();
        showInAppToast('Perfil', 'Atualizado com sucesso');
      }
      break;

    case 'profile_error':
      alert(data.message || 'Erro ao atualizar perfil');
      break;

    case 'chat_message':
      if (typeof handleIncomingChatMessage === 'function') {
        handleIncomingChatMessage(data);
      }
      break;

    case 'chat_history':
      if (activeChatTarget === data.withUser && typeof renderChatHistory === 'function') {
        renderChatHistory(data.messages || []);
        sendWS({ type: 'mark_as_read', withUser: data.withUser });
      }
      break;

    case 'message_deleted':
      if (typeof removeMessageFromUI === 'function') {
        removeMessageFromUI(data.messageId, data.forAll);
      }
      break;

    case 'message_edited':
      if (typeof applyMessageEdit === 'function') {
        applyMessageEdit(data.messageId, data.text);
      }
      break;

    case 'conversation_deleted':
      if (activeChatTarget === data.withUser) {
        const c = document.getElementById('chat-messages');
        if (c) c.innerHTML = '';
      }
      break;

    case 'messages_read':
      break;

    case 'chat_error':
      alert(data.message || 'Erro no chat');
      break;

    case 'maintenance_active':
      alert(data.message || 'Servidor em manutenção. Tente novamente mais tarde.');
      localStorage.removeItem('zap_session');
      location.reload();
      break;

    case 'maintenance_status':
      if (data.active) {
        showInAppToast('Manutenção', data.message || 'Servidor em manutenção');
      }
      break;

    case 'announcements_list':
      if (data.items && data.items.length) {
        const last = data.items[0];
        showInAppToast('Aviso', last.message || 'Novo recado');
      }
      break;

    case 'announcement_new':
      showInAppToast('Aviso', data.message || 'Novo recado do administrador');
      break;

    case 'account_restricted':
      alert(data.message || 'Sua conta está temporariamente restrita.');
      break;

    case 'call_incoming':
      if (typeof onCallIncoming === 'function') onCallIncoming(data);
      break;
    case 'call_offline':
    case 'call_error':
      stopRingtoneSound();
      alert(data.message || 'Indisponível');
      if (typeof cleanupCall === 'function') cleanupCall();
      break;
    case 'call_rejected':
      stopRingtoneSound();
      alert('Chamada recusada');
      if (typeof cleanupCall === 'function') cleanupCall();
      break;
    case 'call_answered':
      stopRingtoneSound();
      if (typeof handleCallAnswered === 'function') handleCallAnswered(data.answer);
      break;
    case 'call_ice_candidate':
      if (typeof onIceCandidate === 'function') onIceCandidate(data);
      break;
    case 'call_ended':
      if (typeof cleanupCall === 'function') cleanupCall();
      break;

    default:
      break;
  }
}

// ========== AUTH UI ==========
function toggleAuthMode(e) {
  if (e) e.preventDefault();
  isRegisterMode = !isRegisterMode;

  const title = document.getElementById('auth-title');
  const reg = document.getElementById('register-fields');
  const btn = document.getElementById('auth-btn-submit');
  const tt = document.getElementById('auth-toggle-text');
  const tb = document.getElementById('auth-toggle-btn');
  const err = document.getElementById('auth-error-msg');
  if (err) err.classList.add('hidden');

  if (isRegisterMode) {
    title.innerText = 'Criar Nova Conta';
    reg.classList.remove('hidden');
    btn.innerText = 'Cadastrar';
    tt.innerText = 'Já possui conta?';
    tb.innerText = 'Entrar';
  } else {
    title.innerText = 'Entrar no Zap Zap';
    reg.classList.add('hidden');
    btn.innerText = 'Entrar';
    tt.innerText = 'Não tem conta?';
    tb.innerText = 'Cadastrar-se';
  }
}

function previewAvatar(event) {
  const file = event.target.files[0];
  if (!file) return;
  const r = new FileReader();
  r.onload = e => {
    userAvatarBase64 = e.target.result;
    const p = document.getElementById('avatar-preview');
    if (p) {
      p.style.backgroundImage = 'url("' + encodeURI(userAvatarBase64) + '")';
      p.innerText = '';
    }
  };
  r.readAsDataURL(file);
}

function handleAuthSubmit(event) {
  event.preventDefault();
  getAudioContext();

  const username = document.getElementById('auth-username').value.trim();
  const password = document.getElementById('auth-password').value;

  if (password.length < 6) {
    showAuthError('A senha deve ter no mínimo 6 caracteres.');
    return;
  }

  sendWS({
    type: isRegisterMode ? 'register' : 'login',
    username,
    password,
    displayName: (document.getElementById('auth-displayname') || {}).value?.trim() || undefined,
    avatar: userAvatarBase64
  });
}

function showAuthError(msg) {
  const el = document.getElementById('auth-error-msg');
  if (el) {
    el.textContent = msg;
    el.classList.remove('hidden');
  }
}

function showMainScreen() {
  document.getElementById('auth-screen')?.classList.add('hidden');
  document.getElementById('app-container')?.classList.remove('hidden');
}

function renderUserProfile() {
  if (!currentUser) return;

  const dn = document.getElementById('my-display-name');
  const uh = document.getElementById('my-username');
  const av = document.getElementById('my-avatar');
  const role = document.getElementById('my-role');

  if (dn) dn.textContent = currentUser.displayName || currentUser.username;
  if (uh) uh.textContent = '@' + currentUser.username;
  if (role) {
    role.textContent = currentUser.role || 'Membro';
    role.className = 'role-badge role-' + (currentUser.role || 'Membro');
  }
  if (av) {
    if (currentUser.avatar) {
      av.style.backgroundImage = 'url("' + encodeURI(currentUser.avatar) + '")';
      av.textContent = '';
    } else {
      av.style.backgroundImage = '';
      av.textContent = (currentUser.displayName || currentUser.username).charAt(0).toUpperCase();
    }
  }
}

function logout() {
  localStorage.removeItem('zap_session');
  location.reload();
}

// ========== INIT ==========
document.addEventListener('DOMContentLoaded', () => {
  applyTheme(currentTheme);
  setupVisibilityListeners();
  connectWebSocket();

  if (getCookie('zap_notif') === '1' || Notification.permission === 'granted') {
    requestNotificationPermission();
  }

  document.addEventListener('click', e => {
    if (!e.target.closest('#msg-action-menu') && !e.target.closest('.message')) {
      if (typeof closeMessageMenu === 'function') closeMessageMenu();
    }
  });
});
