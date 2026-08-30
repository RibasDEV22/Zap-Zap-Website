/* =========================================================
   ZapZap – core.js (MELHORADO)
   Estado global, WebSocket, autenticação, tema, notificações
   FIXES: Session tokens, reconexão robusta, background suport
   ========================================================= */

const WS_URL = 'wss://zap-zap-24qi.onrender.com';
const RECONNECT_INTERVALS = [1000, 2000, 4000, 8000, 15000]; // Backoff exponencial
const MAX_RECONNECT_ATTEMPTS = 15;
const MESSAGE_QUEUE_STORAGE = 'zap_message_queue';
const SESSION_STORAGE = 'zap_session_token';

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
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
let reconnectAttempts = 0;
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
let messageQueueTimer = null;

// FIX #5.1: Session token do servidor
let currentSessionToken = localStorage.getItem(SESSION_STORAGE) || null;

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
  pendingOffer: null,
  isActive: false
};
let pendingIceCandidates = [];

// ========== FILA DE MENSAGENS (PERSISTÊNCIA) ==========
class MessageQueue {
  constructor() {
    this.queue = this.loadQueue();
  }

  add(message) {
    const item = {
      id: 'temp-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9),
      data: message,
      timestamp: Date.now(),
      retries: 0
    };
    this.queue.push(item);
    this.saveQueue();
    return item;
  }

  remove(id) {
    this.queue = this.queue.filter(m => m.id !== id);
    this.saveQueue();
  }

  getAll() {
    return this.queue.filter(m => Date.now() - m.timestamp < 300000); // 5 min
  }

  clear() {
    this.queue = [];
    this.saveQueue();
  }

  saveQueue() {
    try {
      localStorage.setItem(MESSAGE_QUEUE_STORAGE, JSON.stringify(this.queue));
    } catch (e) {
      console.warn('[Queue] Erro ao salvar fila:', e.message);
    }
  }

  loadQueue() {
    try {
      return JSON.parse(localStorage.getItem(MESSAGE_QUEUE_STORAGE) || '[]');
    } catch {
      return [];
    }
  }
}

const messageQueue = new MessageQueue();

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
        silent: false,
        badge: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">⚡</text></svg>'
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

// ========== VISIBILIDADE & BACKGROUND ==========
function sendAppVisibility(focused) {
  isAppFocused = !!focused;
  sendWS({ type: 'app_visibility', focused: isAppFocused });
}

function setupVisibilityListeners() {
  document.addEventListener('visibilitychange', () => {
    const isFocused = document.visibilityState === 'visible';
    sendAppVisibility(isFocused);
    if (isFocused) {
      // FIX #5.4: Recarrega contatos e announcements ao retornar
      sendWS({ type: 'get_contacts' });
      sendWS({ type: 'get_announcements' });
    }
  });
  window.addEventListener('focus', () => sendAppVisibility(true));
  window.addEventListener('blur', () => sendAppVisibility(false));
}

// ========== WEBSOCKET COM RECONEXÃO ROBUSTA ==========
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
    console.log('[WS] Conectado');
    reconnectAttempts = 0;
    updateNetworkStatus('online', 'Conectado');
    if (pingInterval) clearInterval(pingInterval);
    pingInterval = setInterval(() => sendWS({ type: 'ping' }), 25000);

    sendAppVisibility(document.visibilityState === 'visible');

    // FIX #5.1: Tenta reconectar com session token
    const token = localStorage.getItem(SESSION_STORAGE);
    if (token) {
      console.log('[WS] Reconectando com session token');
      sendWS({ type: reconnect_session, sessionToken: token });
    } else {
      // Tenta autenticar com credenciais antigas
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
    }

    // Processa fila de mensagens pendentes
    flushMessageQueue();
  };

  ws.onmessage = e => {
    try {
      const data = JSON.parse(e.data);
      if (data.type === 'pong') return;
      handleServerMessage(data);
    } catch (err) {
      console.error('[WS] Erro ao processar mensagem:', err);
    }
  };

  ws.onerror = (error) => {
    console.error('[WS] Erro:', error);
    updateNetworkStatus('offline', 'Erro de conexão');
    hideSplashScreen();
  };

  ws.onclose = () => {
    console.log('[WS] Desconectado. Tentando reconectar...');
    if (pingInterval) clearInterval(pingInterval);
    updateNetworkStatus('connecting', 'Reconectando...');
    
    // FIX #5.2: Backoff exponencial
    const interval = RECONNECT_INTERVALS[Math.min(reconnectAttempts, RECONNECT_INTERVALS.length - 1)];
    reconnectAttempts++;

    if (reconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
      if (!reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connectWebSocket();
        }, interval);
      }
    } else {
      updateNetworkStatus('offline', 'Falha ao conectar. Recarregando...');
      setTimeout(() => location.reload(), 3000);
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
    return true;
  }
  return false;
}

// ========== FILA DE MENSAGENS ==========
function flushMessageQueue() {
  if (messageQueueTimer) clearTimeout(messageQueueTimer);
  messageQueueTimer = setTimeout(() => {
    const pending = messageQueue.getAll();
    if (pending.length === 0) return;

    pending.forEach(item => {
      if (item.retries < 3 && sendWS(Object.assign({}, item.data))) {
        messageQueue.remove(item.id);
      } else if (item.retries >= 3) {
        messageQueue.remove(item.id);
      } else {
        item.retries++;
        messageQueue.saveQueue();
      }
    });
  }, 1000);
}

// ========== HANDLER CENTRAL DE MENSAGENS DO SERVIDOR ==========
function handleServerMessage(data) {
  switch (data.type) {
    case 'auth_success':
      currentUser = data.user;
      // FIX #5.1: Salva session token do servidor
      if (data.sessionToken) {
        currentSessionToken = data.sessionToken;
        localStorage.setItem(SESSION_STORAGE, data.sessionToken);
      }
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

    case 'reconnect_success':
      console.log('[WS] Reconexão com token bem-sucedida');
      currentUser = data.user;
      showMainScreen();
      renderUserProfile();
      sendWS({ type: 'get_contacts' });
      sendWS({ type: 'get_announcements' });
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
      localStorage.removeItem(SESSION_STORAGE);
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
      showPushNotification('Aviso', data.message || 'Novo recado do administrador');
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
    case 'reaction_updated':
    case 'reaction_removed':
      if (typeof applyReactionUpdate === 'function') {
        applyReactionUpdate(data);
      }
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
  localStorage.removeItem(SESSION_STORAGE);
  currentSessionToken = null;
  messageQueue.clear();
  location.reload();
}

// ========== SERVICE WORKER REGISTRATION ==========
function registerServiceWorker() {
  if ('serviceWorker' in navigator && isSecureContext()) {
    navigator.serviceWorker.register('sw.js').then(reg => {
      console.log('[SW] Registrado:', reg);
    }).catch(err => {
      console.log('[SW] Erro ao registrar:', err);
    });
  }
}

// ========== INIT ==========
document.addEventListener('DOMContentLoaded', () => {
  applyTheme(currentTheme);
  setupVisibilityListeners();
  registerServiceWorker();
  connectWebSocket();

  if (getCookie('zap_notif') === '1' || Notification.permission === 'granted') {
    requestNotificationPermission();
  }

  document.addEventListener('click', e => {
    if (!e.target.closest('#msg-action-menu') && !e.target.closest('.message')) {
      if (typeof closeMessageMenu === 'function') closeMessageMenu();
    }
  });

  // Mantém app vivo em background
  if ('serviceWorker' in navigator && currentCall.isActive) {
    navigator.serviceWorker.ready.then(reg => {
      reg.active?.postMessage({ type: 'keep_alive' });
    });
  }
});

// Limpa antes de sair
window.addEventListener('beforeunload', () => {
  if (currentCall.isActive) {
    sendWS({ type: 'call_end', to: currentCall.targetUser });
  }
});
