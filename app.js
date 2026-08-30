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

// ========== ESTADO ==========
let ws = null, pingInterval = null, currentUser = null, activeChatTarget = null;
let isMuted = false, isRegisterMode = false, userAvatarBase64 = null, allContacts = [];
let currentTheme = localStorage.getItem('zap_theme') || 'dark';
let replyToMessage = null;
let selectedMessage = null;
let longPressTimer = null;
let searchDebounceTimer = null;
let isAppFocused = true;

// Audio prefs
const audioPrefs = JSON.parse(localStorage.getItem('zap_audio_prefs') || '{}');
let audioVolumeBoost = audioPrefs.volumeBoost ?? 100;
let audioNoiseReduction = audioPrefs.noiseReduction ?? true;
let audioSmoothVoice = audioPrefs.smoothVoice ?? true;

// Recording
let mediaRecorder = null, recordedChunks = [], recordingStream = null, isRecording = false, recordStartTs = 0;

// Sounds
const soundNotification = new Audio('NotificationSound.mp3');
const soundCall = new Audio('CallSound.mp3');
soundCall.loop = true;
let audioCtx = null, syntheticRingtoneInterval = null;

let currentCall = { peerConnection: null, localStream: null, targetUser: null, pendingOffer: null };
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

function isSecureContext() {
  return window.isSecureContext || location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
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

// ========== AUDIO CTX ==========
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

// ========== VISIBILIDADE (para o backend decidir push) ==========
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

// ========== PROCESSAMENTO DE ÁUDIO ==========
function saveAudioPrefs() {
  localStorage.setItem('zap_audio_prefs', JSON.stringify({
    volumeBoost: audioVolumeBoost,
    noiseReduction: audioNoiseReduction,
    smoothVoice: audioSmoothVoice
  }));
}

async function processAudioBuffer(audioBuffer) {
  const ctx = getAudioContext();
  if (!ctx) return audioBuffer;

  const offline = new OfflineAudioContext(1, audioBuffer.length, audioBuffer.sampleRate);
  const source = offline.createBufferSource();
  source.buffer = audioBuffer;
  let node = source;

  if (audioNoiseReduction) {
    const hp = offline.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 80;
    node.connect(hp);
    node = hp;

    const comp = offline.createDynamicsCompressor();
    comp.threshold.value = -32;
    comp.knee.value = 12;
    comp.ratio.value = 8;
    comp.attack.value = 0.003;
    comp.release.value = 0.15;
    node.connect(comp);
    node = comp;
  }

  if (audioSmoothVoice) {
    const lp = offline.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 7200;
    lp.Q.value = 0.7;
    node.connect(lp);
    node = lp;
  }

  const gain = offline.createGain();
  gain.gain.value = Math.min(5, Math.max(0.05, audioVolumeBoost / 100));
  node.connect(gain);
  gain.connect(offline.destination);

  source.start(0);
  return offline.startRendering();
}

async function compressAndProcessAudio(fileOrBlob) {
  const arrayBuffer = await (fileOrBlob.arrayBuffer ? fileOrBlob.arrayBuffer() : fileOrBlob);
  const ctx = getAudioContext() || new (window.AudioContext || window.webkitAudioContext)();
  let audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
  audioBuffer = await processAudioBuffer(audioBuffer);

  const targetRate = 22050;
  const offline = new OfflineAudioContext(1, Math.ceil(audioBuffer.duration * targetRate), targetRate);
  const src = offline.createBufferSource();
  src.buffer = audioBuffer;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();

  const dest = ctx.createMediaStreamDestination();
  const bs = ctx.createBufferSource();
  bs.buffer = rendered;
  bs.connect(dest);
  bs.start();

  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : 'audio/webm';

  const rec = new MediaRecorder(dest.stream, { mimeType: mime, audioBitsPerSecond: 48000 });
  const chunks = [];

  return new Promise((resolve, reject) => {
    rec.ondataavailable = e => chunks.push(e.data);
    rec.onstop = () => {
      const blob = new Blob(chunks, { type: mime });
      const reader = new FileReader();
      reader.onload = () => resolve({
        dataUrl: reader.result,
        mime,
        size: blob.size,
        duration: Math.round(audioBuffer.duration)
      });
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    };
    rec.onerror = reject;
    rec.start();
    setTimeout(() => {
      try { rec.stop(); } catch (e) {}
    }, (audioBuffer.duration * 1000) + 250);
  });
}

// ========== COMPRESSÃO DE MÍDIA ==========
async function compressImage(file, maxW = 1280, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let w = img.width, h = img.height;
      if (w > maxW) {
        h = Math.round(h * maxW / w);
        w = maxW;
      }
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      c.toBlob(blob => {
        if (!blob) return reject(new Error('Falha ao comprimir imagem'));
        const r = new FileReader();
        r.onload = () => resolve({ dataUrl: r.result, mime: 'image/jpeg', size: blob.size });
        r.onerror = reject;
        r.readAsDataURL(blob);
      }, 'image/jpeg', quality);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Imagem inválida'));
    };
    img.src = url;
  });
}

async function prepareMediaFile(file) {
  if (file.size > 8 * 1024 * 1024) throw new Error('Arquivo muito grande (máx. 8 MB bruto).');
  const type = file.type || '';

  if (type.startsWith('image/')) {
    const p = await compressImage(file);
    return Object.assign(p, { msg_type: 'image', fileName: file.name });
  }
  if (type.startsWith('audio/')) {
    const p = await compressAndProcessAudio(file);
    return Object.assign(p, { msg_type: 'audio', fileName: file.name });
  }
  if (type.startsWith('video/')) {
    if (file.size > 2.2 * 1024 * 1024) throw new Error('Vídeo muito grande (~2 MB máx).');
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res({
        dataUrl: r.result,
        mime: file.type,
        size: file.size,
        msg_type: 'video',
        fileName: file.name
      });
      r.onerror = rej;
      r.readAsDataURL(file);
    });
  }
  if (file.size > 1.8 * 1024 * 1024) throw new Error('Arquivo muito grande (~1.8 MB).');
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res({
      dataUrl: r.result,
      mime: file.type || 'application/octet-stream',
      size: file.size,
      msg_type: 'file',
      fileName: file.name
    });
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

// ========== MICROFONE (melhorado) ==========
function getPreferredMicConstraints(extra = {}) {
  const savedId = localStorage.getItem('zap_mic_id');
  const base = {
    echoCancellation: true,
    noiseSuppression: audioNoiseReduction,
    autoGainControl: true,
    ...extra
  };
  if (savedId) {
    return { ...base, deviceId: { ideal: savedId } };
  }
  return base;
}

async function getMicrophoneStream(extraConstraints = {}) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('Seu navegador não suporta acesso ao microfone.');
  }
  if (!isSecureContext()) {
    throw new Error('Microfone só funciona em HTTPS ou localhost.');
  }

  const constraints = {
    audio: getPreferredMicConstraints(extraConstraints),
    video: false
  };

  try {
    return await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    // Fallback mais permissivo (ajuda em celulares antigos / Safari)
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (err2) {
      let msg = 'Não foi possível acessar o microfone.';
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        msg = 'Permissão do microfone negada. Ative nas configurações do navegador/app.';
      } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
        msg = 'Nenhum microfone encontrado neste dispositivo.';
      } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
        msg = 'Microfone em uso por outro aplicativo.';
      } else if (err.name === 'OverconstrainedError') {
        msg = 'Configuração de microfone não suportada. Tente outro dispositivo nas Configurações.';
      }
      throw new Error(msg);
    }
  }
}

// ========== GRAVAÇÃO DE ÁUDIO ==========
async function startVoiceRecord() {
  if (isRecording) return;
  try {
    getAudioContext();
    recordingStream = await getMicrophoneStream();
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';

    mediaRecorder = new MediaRecorder(recordingStream, {
      mimeType: mime,
      audioBitsPerSecond: 64000
    });
    recordedChunks = [];

    mediaRecorder.ondataavailable = e => {
      if (e.data && e.data.size) recordedChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      const blob = new Blob(recordedChunks, { type: mime });
      try {
        showInAppToast('Processando', 'Aplicando efeitos de áudio...');
        const processed = await compressAndProcessAudio(blob);
        if (!activeChatTarget) return;

        sendWS({
          type: 'chat_message',
          to: activeChatTarget,
          media: processed.dataUrl,
          msg_type: 'audio',
          mime: processed.mime,
          fileName: 'audio_' + Date.now() + '.webm',
          duration: processed.duration,
          reply_to: replyToMessage ? replyToMessage.id : null
        });

        appendChatMessage({
          id: 'temp-' + Date.now(),
          sender: currentUser && currentUser.username,
          content: processed.dataUrl,
          msg_type: 'audio',
          media_meta: {
            name: 'Áudio',
            mime: processed.mime,
            size: processed.size,
            duration: processed.duration
          },
          isMe: true,
          reply_preview: replyToMessage
        });
        clearReply();
      } catch (err) {
        alert(err.message || 'Erro ao processar áudio.');
      } finally {
        stopRecordingTracks();
        updateRecordUI(false);
      }
    };

    mediaRecorder.start(100);
    isRecording = true;
    recordStartTs = Date.now();
    updateRecordUI(true);
  } catch (err) {
    alert(err.message || 'Não foi possível acessar o microfone.');
    console.error(err);
    stopRecordingTracks();
    updateRecordUI(false);
  }
}

function stopRecordingTracks() {
  if (recordingStream) {
    recordingStream.getTracks().forEach(t => {
      try { t.stop(); } catch (e) {}
    });
    recordingStream = null;
  }
}

function stopVoiceRecord() {
  if (!isRecording || !mediaRecorder) return;
  isRecording = false;
  try {
    if (mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  } catch (e) {}
}

function cancelVoiceRecord() {
  if (!isRecording) return;
  isRecording = false;
  recordedChunks = [];
  try {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  } catch (e) {}
  stopRecordingTracks();
  updateRecordUI(false);
}

function updateRecordUI(recording) {
  const btn = document.getElementById('btn-record');
  const bar = document.getElementById('recording-bar');
  if (btn) {
    btn.classList.toggle('recording', recording);
    btn.textContent = recording ? '⏹️' : '🎤';
    btn.title = recording ? 'Parar gravação' : 'Gravar áudio';
  }
  if (bar) bar.classList.toggle('hidden', !recording);
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

  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    updateNetworkStatus('online', 'Conectado');
    if (pingInterval) clearInterval(pingInterval);
    pingInterval = setInterval(() => sendWS({ type: 'ping' }), 25000);

    // Envia estado de foco inicial
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
      console.error(err);
    }
  };

  ws.onerror = () => {
    updateNetworkStatus('offline', 'Erro de conexão');
    hideSplashScreen();
  };

  ws.onclose = () => {
    if (pingInterval) clearInterval(pingInterval);
    updateNetworkStatus('connecting', 'Reconectando...');
    setTimeout(connectWebSocket, 2800);
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
      renderContacts(allContacts);
      updateHeaderStatus();
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

    case 'chat_message': {
      const isOwn = data.from === (currentUser && currentUser.username) || data.confirmed;

      if (!isOwn) {
        playNotificationSound();
        const preview = data.msg_type === 'text'
          ? (data.text || '').slice(0, 80)
          : '[' + (data.msg_type || 'mídia').toUpperCase() + ']';
        showPushNotification('@' + data.from, preview, { tag: 'msg-' + data.from });
      }

      if (data.confirmed) {
        const temp = document.querySelector('.message[data-id^="temp-"]');
        if (temp && temp.dataset.sender === (currentUser && currentUser.username)) {
          temp.dataset.id = data.id;
        } else if (activeChatTarget === data.to || activeChatTarget === data.from) {
          if (!document.querySelector('.message[data-id="' + data.id + '"]')) {
            appendChatMessage({
              id: data.id,
              sender: data.from,
              content: data.text || data.media,
              msg_type: data.msg_type || 'text',
              media_meta: data.media_meta,
              timestamp: data.timestamp,
              isMe: true,
              reply_preview: data.reply_preview,
              edited: data.edited
            });
          }
        }
      } else if (activeChatTarget === data.from) {
        appendChatMessage({
          id: data.id,
          sender: data.from,
          content: data.text || data.media,
          msg_type: data.msg_type || 'text',
          media_meta: data.media_meta,
          timestamp: data.timestamp,
          isMe: false,
          reply_preview: data.reply_preview,
          edited: data.edited
        });
        // Marca como lida se o chat está aberto e o app está em foco
        if (isAppFocused) {
          sendWS({ type: 'mark_as_read', withUser: data.from });
        }
      }
      break;
    }

    case 'chat_history':
      if (activeChatTarget === data.withUser) {
        renderChatHistory(data.messages || []);
        // Ao abrir o histórico, marca mensagens como lidas
        sendWS({ type: 'mark_as_read', withUser: data.withUser });
      }
      break;

    case 'message_deleted':
      removeMessageFromUI(data.messageId, data.forAll);
      break;

    case 'message_edited':
      applyMessageEdit(data.messageId, data.text);
      break;

    case 'conversation_deleted':
      if (activeChatTarget === data.withUser) {
        const c = document.getElementById('chat-messages');
        if (c) c.innerHTML = '';
      }
      break;

    case 'messages_read':
      // Opcional: atualizar UI de "lido" se quiser no futuro
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
    case 'announcement_new':
      if (data.items && data.items.length) {
        const last = data.items[0];
        showInAppToast('Aviso', last.message || 'Novo recado do administrador');
      } else if (data.message) {
        showInAppToast('Aviso', data.message);
      }
      break;

    case 'announcement_removed':
      // silencioso
      break;

    case 'account_restricted':
      alert(data.message || 'Sua conta está temporariamente restrita.');
      break;

    case 'call_incoming':
      startRingtoneSound();
      currentCall.targetUser = data.caller;
      currentCall.pendingOffer = data.offer;
      showPushNotification('Chamada', '@' + data.caller + ' está ligando...', {
        requireInteraction: true,
        tag: 'call'
      });
      openCallModal(data.callerDisplayName || data.caller, 'Recebendo chamada...', 'incoming');
      break;

    case 'call_offline':
    case 'call_error':
      stopRingtoneSound();
      alert(data.message || 'Indisponível');
      cleanupCall();
      break;

    case 'call_rejected':
      stopRingtoneSound();
      alert('Chamada recusada');
      cleanupCall();
      break;

    case 'call_answered':
      stopRingtoneSound();
      handleCallAnswered(data.answer);
      break;

    case 'call_ice_candidate':
      if (currentCall.peerConnection &&
          currentCall.peerConnection.remoteDescription &&
          currentCall.peerConnection.remoteDescription.type) {
        currentCall.peerConnection
          .addIceCandidate(new RTCIceCandidate(data.candidate))
          .catch(() => {});
      } else {
        pendingIceCandidates.push(data.candidate);
      }
      break;

    case 'call_ended':
      cleanupCall();
      break;

    default:
      // mensagens desconhecidas ignoradas
      break;
  }
}

// ========== AUTH / UI ==========
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

// ========== CONTATOS ==========
function renderContacts(contacts) {
  const list = document.getElementById('contacts-list');
  if (!list) return;
  list.innerHTML = '';

  contacts.forEach(c => {
    if (currentUser && c.username === currentUser.username) return;

    const item = document.createElement('div');
    item.className = 'contact-item' + (activeChatTarget === c.username ? ' active' : '');
    item.onclick = () => selectContact(c);

    const initial = (c.displayName || c.username).charAt(0).toUpperCase();
    const avStyle = c.avatar ? ' style="background-image:url(\'' + encodeURI(c.avatar) + '\')"' : '';

    item.innerHTML =
      (c.avatar
        ? '<div class="avatar"' + avStyle + '></div>'
        : '<div class="avatar">' + initial + '</div>') +
      '<div class="contact-details">' +
        '<div class="contact-name">' + escapeHTML(c.displayName || c.username) + '</div>' +
        '<div class="contact-status' + (c.online ? ' online-text' : '') + '">' +
          (c.online ? 'Online' : 'Offline') +
        '</div>' +
      '</div>';

    list.appendChild(item);
  });
}

function filterContactsDebounced() {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(filterContacts, 180);
}

function filterContacts() {
  const q = (document.getElementById('search-input')?.value || '').toLowerCase().trim();
  if (!q) {
    renderContacts(allContacts);
    return;
  }
  renderContacts(allContacts.filter(c =>
    (c.displayName && c.displayName.toLowerCase().includes(q)) ||
    c.username.toLowerCase().includes(q)
  ));
}

function selectContact(contact) {
  getAudioContext();
  activeChatTarget = contact.username;
  clearReply();
  closeMessageMenu();
  renderContacts(allContacts);

  document.getElementById('empty-state')?.classList.add('hidden');
  document.getElementById('chat-header')?.classList.remove('hidden');
  document.getElementById('chat-messages')?.classList.remove('hidden');
  document.getElementById('chat-input-area')?.classList.remove('hidden');
  document.getElementById('chat-user-name').textContent = contact.displayName || contact.username;
  updateHeaderStatus();

  const av = document.getElementById('chat-user-avatar');
  if (av) {
    if (contact.avatar) {
      av.style.backgroundImage = 'url("' + encodeURI(contact.avatar) + '")';
      av.textContent = '';
    } else {
      av.style.backgroundImage = '';
      av.textContent = (contact.displayName || contact.username).charAt(0).toUpperCase();
    }
  }

  const box = document.getElementById('chat-messages');
  if (box) box.innerHTML = '';

  sendWS({ type: 'get_chat_history', withUser: contact.username });
  document.getElementById('app-container')?.classList.add('active-chat');
}

function updateHeaderStatus() {
  if (!activeChatTarget) return;
  const u = allContacts.find(c => c.username === activeChatTarget);
  const el = document.getElementById('chat-user-status');
  if (el && u) {
    el.textContent = u.online ? 'Online' : 'Offline';
    el.className = 'status-indicator' + (u.online ? ' online' : '');
  }
}

function backToContacts() {
  document.getElementById('app-container')?.classList.remove('active-chat');
  clearReply();
  closeMessageMenu();
}

// ========== CHAT ==========
function renderChatHistory(messages) {
  const box = document.getElementById('chat-messages');
  if (!box) return;
  box.innerHTML = '';
  messages.forEach(m => appendChatMessage({
    id: m.id,
    sender: m.sender,
    content: m.content,
    msg_type: m.msg_type || 'text',
    media_meta: m.media_meta,
    timestamp: m.timestamp,
    isMe: m.sender === (currentUser && currentUser.username),
    deleted_for_all: m.deleted_for_all,
    reply_preview: m.reply_preview,
    edited: m.edited
  }));
}

function appendChatMessage(opts) {
  const {
    id, sender, content, msg_type = 'text', media_meta,
    isMe, deleted_for_all, reply_preview, edited, timestamp
  } = opts;

  const box = document.getElementById('chat-messages');
  if (!box) return;

  if (id && !String(id).startsWith('temp-') &&
      document.querySelector('.message[data-id="' + id + '"]')) {
    return;
  }

  const div = document.createElement('div');
  div.className = 'message ' + (isMe ? 'sent' : 'received');
  div.dataset.id = id || '';
  div.dataset.sender = sender || '';
  div.dataset.ts = timestamp || Date.now();
  div.dataset.type = msg_type;

  let html = '';
  if (reply_preview) {
    html += '<div class="reply-quote">' +
      '<span class="rq-user">' + escapeHTML(reply_preview.sender || '') + '</span>' +
      '<span class="rq-text">' + escapeHTML(reply_preview.content || '') + '</span>' +
      '</div>';
  }

  if (deleted_for_all) {
    html += '<em class="deleted-msg">Mensagem apagada</em>';
  } else if (msg_type === 'image' && content) {
    html += '<div class="media-bubble"><img src="' + content + '" alt="img" loading="lazy" onclick="openMediaViewer(this.src,\'image\')"></div>';
  } else if (msg_type === 'audio' && content) {
    html += '<div class="media-bubble audio-bubble">' +
      '<audio controls preload="metadata" src="' + content + '"></audio>' +
      (media_meta && media_meta.duration ? '<small>' + media_meta.duration + 's</small>' : '') +
      '</div>';
  } else if (msg_type === 'video' && content) {
    html += '<div class="media-bubble"><video controls preload="metadata" playsinline src="' + content + '"></video></div>';
  } else if (msg_type === 'file' && content) {
    const name = (media_meta && media_meta.name) || 'Arquivo';
    html += '<div class="media-bubble file-bubble">' +
      '<a href="' + content + '" download="' + escapeHTML(name) + '">📎 ' + escapeHTML(name) + '</a>' +
      '</div>';
  } else {
    html += '<span class="msg-text">' + escapeHTML(content || '') + '</span>';
    if (edited) html += ' <span class="edited-tag">editado</span>';
  }

  div.innerHTML = html;

  // Long-press / swipe
  let startX = 0, startY = 0, moved = false;

  const onStart = (e) => {
    const t = e.touches ? e.touches[0] : e;
    startX = t.clientX;
    startY = t.clientY;
    moved = false;
    longPressTimer = setTimeout(() => {
      if (!moved) openMessageMenu(div, opts);
    }, 480);
  };

  const onMove = (e) => {
    const t = e.touches ? e.touches[0] : e;
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    if (Math.abs(dx) > 12 || Math.abs(dy) > 12) {
      moved = true;
      clearTimeout(longPressTimer);
    }
    if (dx > 60 && Math.abs(dy) < 40) {
      clearTimeout(longPressTimer);
      setReply(opts);
      moved = true;
    }
  };

  const onEnd = () => clearTimeout(longPressTimer);

  div.addEventListener('touchstart', onStart, { passive: true });
  div.addEventListener('touchmove', onMove, { passive: true });
  div.addEventListener('touchend', onEnd);
  div.addEventListener('mousedown', onStart);
  div.addEventListener('mousemove', onMove);
  div.addEventListener('mouseup', onEnd);
  div.addEventListener('mouseleave', onEnd);
  div.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openMessageMenu(div, opts);
  });

  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function openMessageMenu(el, opts) {
  closeMessageMenu();
  selectedMessage = opts;
  el.classList.add('selected');
  const menu = document.getElementById('msg-action-menu');
  if (!menu) return;

  const isOwn = opts.isMe || opts.sender === (currentUser && currentUser.username);
  const canEdit = isOwn && opts.msg_type === 'text' && opts.id &&
    !String(opts.id).startsWith('temp-') &&
    (Date.now() - (Number(opts.timestamp) || Number(el.dataset.ts) || 0)) <= 300000;

  menu.querySelector('[data-action="reply"]').style.display = '';
  menu.querySelector('[data-action="forward"]').style.display = '';
  menu.querySelector('[data-action="edit"]').style.display = canEdit ? '' : 'none';
  menu.querySelector('[data-action="delete"]').style.display =
    opts.id && !String(opts.id).startsWith('temp-') ? '' : 'none';

  menu.classList.remove('hidden');
}

function closeMessageMenu() {
  selectedMessage = null;
  document.querySelectorAll('.message.selected').forEach(el => el.classList.remove('selected'));
  document.getElementById('msg-action-menu')?.classList.add('hidden');
}

function handleMenuAction(action) {
  if (!selectedMessage) return;
  const m = selectedMessage;
  closeMessageMenu();
  if (action === 'reply') setReply(m);
  else if (action === 'edit') startEditMessage(m);
  else if (action === 'delete') {
    promptDeleteMessage(m.id, m.isMe || m.sender === (currentUser && currentUser.username));
  } else if (action === 'forward') forwardMessage(m);
}

function setReply(m) {
  replyToMessage = {
    id: m.id,
    sender: m.sender,
    content: m.msg_type === 'text'
      ? (m.content || '').slice(0, 80)
      : '[' + (m.msg_type || 'mídia') + ']',
    msg_type: m.msg_type
  };
  const bar = document.getElementById('reply-bar');
  if (bar) {
    bar.classList.remove('hidden');
    bar.querySelector('.reply-bar-user').textContent = m.sender || '';
    bar.querySelector('.reply-bar-text').textContent = replyToMessage.content;
  }
  document.getElementById('message-input')?.focus();
}

function clearReply() {
  replyToMessage = null;
  document.getElementById('reply-bar')?.classList.add('hidden');
}

function startEditMessage(m) {
  const input = document.getElementById('message-input');
  if (!input || m.msg_type !== 'text') return;
  input.value = m.content || '';
  input.dataset.editId = m.id;
  input.focus();
  showInAppToast('Editar', 'Edite e pressione Enviar (limite 5 min)');
}

function applyMessageEdit(id, text) {
  const el = document.querySelector('.message[data-id="' + id + '"] .msg-text');
  if (el) {
    el.textContent = text;
    const tag = el.parentElement.querySelector('.edited-tag');
    if (!tag) {
      const s = document.createElement('span');
      s.className = 'edited-tag';
      s.textContent = ' editado';
      el.parentElement.appendChild(s);
    }
  }
}

function promptDeleteMessage(messageId, isMine) {
  const forAll = isMine && confirm('Apagar para TODOS?\nOK = todos | Cancelar = só você');
  sendWS({
    type: 'delete_message',
    messageId: Number(messageId),
    forAll: !!forAll,
    withUser: activeChatTarget
  });
  removeMessageFromUI(messageId, forAll);
}

function removeMessageFromUI(id, forAll) {
  const el = document.querySelector('.message[data-id="' + id + '"]');
  if (!el) return;
  if (forAll) {
    el.innerHTML = '<em class="deleted-msg">Mensagem apagada</em>';
    el.classList.add('deleted');
  } else {
    el.remove();
  }
}

function deleteCurrentConversation() {
  if (!activeChatTarget) return;
  const forAll = confirm('Apagar conversa?\nOK = suas msgs para todos | Cancelar = só você');
  sendWS({
    type: 'delete_conversation',
    withUser: activeChatTarget,
    forAll: !!forAll
  });
  const c = document.getElementById('chat-messages');
  if (c) c.innerHTML = '';
}

function forwardMessage(m) {
  const target = prompt('Encaminhar para usuário (@username):');
  if (!target || !target.trim()) return;
  const to = target.replace(/^@/, '').trim().toLowerCase();

  if (m.msg_type === 'text') {
    sendWS({ type: 'chat_message', to, text: m.content, msg_type: 'text' });
  } else if (m.content) {
    sendWS({
      type: 'chat_message',
      to,
      media: m.content,
      msg_type: m.msg_type,
      mime: (m.media_meta && m.media_meta.mime) || undefined,
      fileName: (m.media_meta && m.media_meta.name) || 'forwarded'
    });
  }
  showInAppToast('Encaminhado', 'Para @' + to);
}

// ========== ENVIAR TEXTO / ARQUIVO ==========
function handleKeyPress(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

function sendMessage() {
  const input = document.getElementById('message-input');
  if (!input || !activeChatTarget) return;
  const text = input.value.trim();
  if (!text) return;

  const editId = input.dataset.editId;
  if (editId) {
    sendWS({
      type: 'edit_message',
      messageId: Number(editId),
      text,
      withUser: activeChatTarget
    });
    applyMessageEdit(editId, text);
    delete input.dataset.editId;
    input.value = '';
    return;
  }

  sendWS({
    type: 'chat_message',
    to: activeChatTarget,
    text,
    msg_type: 'text',
    reply_to: replyToMessage ? replyToMessage.id : null
  });

  appendChatMessage({
    id: 'temp-' + Date.now(),
    sender: currentUser && currentUser.username,
    content: text,
    msg_type: 'text',
    isMe: true,
    reply_preview: replyToMessage,
    timestamp: Date.now()
  });

  input.value = '';
  clearReply();
}

async function handleFileSelect(event) {
  const file = event.target.files && event.target.files[0];
  if (!file || !activeChatTarget) return;
  event.target.value = '';

  try {
    showInAppToast('Preparando', 'Comprimindo...');
    const p = await prepareMediaFile(file);

    sendWS({
      type: 'chat_message',
      to: activeChatTarget,
      media: p.dataUrl,
      msg_type: p.msg_type,
      mime: p.mime,
      fileName: p.fileName,
      duration: p.duration || null,
      reply_to: replyToMessage ? replyToMessage.id : null
    });

    appendChatMessage({
      id: 'temp-' + Date.now(),
      sender: currentUser && currentUser.username,
      content: p.dataUrl,
      msg_type: p.msg_type,
      media_meta: {
        name: p.fileName,
        mime: p.mime,
        size: p.size,
        duration: p.duration
      },
      isMe: true,
      reply_preview: replyToMessage
    });
    clearReply();
  } catch (err) {
    alert(err.message || 'Erro no arquivo');
  }
}

// ========== MEDIA VIEWER ==========
function openMediaViewer(src, type) {
  let ov = document.getElementById('media-viewer');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'media-viewer';
    ov.className = 'media-viewer hidden';
    ov.innerHTML =
      '<button type="button" class="mv-close" onclick="closeMediaViewer()">✕</button>' +
      '<div class="mv-content"></div>';
    document.body.appendChild(ov);
  }
  const content = ov.querySelector('.mv-content');
  if (type === 'image') {
    content.innerHTML = '<img src="' + src + '" alt="preview">';
  } else if (type === 'video') {
    content.innerHTML = '<video src="' + src + '" controls autoplay playsinline></video>';
  }
  ov.classList.remove('hidden');
}

function closeMediaViewer() {
  const ov = document.getElementById('media-viewer');
  if (ov) {
    ov.classList.add('hidden');
    const v = ov.querySelector('video');
    if (v) v.pause();
  }
}

// ========== CHAMADAS ==========
window.addEventListener('keydown', e => {
  if (e.key === 'F4') {
    e.preventDefault();
    toggleMicrophone();
  }
});

function toggleMicrophone() {
  if (!currentCall.localStream) return;
  isMuted = !isMuted;
  currentCall.localStream.getAudioTracks().forEach(t => {
    t.enabled = !isMuted;
  });
  const b = document.getElementById('btn-toggle-mic');
  if (b) b.textContent = isMuted ? '🎙️ Desmutar (F4)' : '🎙️ Mutar (F4)';
}

async function startCall(targetUserOverride) {
  getAudioContext();
  const target = targetUserOverride || activeChatTarget;
  if (!target) return alert('Selecione um usuário');

  try {
    currentCall.targetUser = target;
    currentCall.localStream = await getMicrophoneStream();
    setupPeerConnection();
    currentCall.localStream.getTracks().forEach(t => {
      currentCall.peerConnection.addTrack(t, currentCall.localStream);
    });
    const offer = await currentCall.peerConnection.createOffer();
    await currentCall.peerConnection.setLocalDescription(offer);
    sendWS({ type: 'call_initiate', callee: target, offer });
    startRingtoneSound();
    openCallModal(target, 'Chamando...', 'calling');
  } catch (err) {
    alert(err.message || 'Erro no microfone');
    cleanupCall();
  }
}

async function acceptCall() {
  getAudioContext();
  try {
    stopRingtoneSound();
    currentCall.localStream = await getMicrophoneStream();
    setupPeerConnection();
    currentCall.localStream.getTracks().forEach(t => {
      currentCall.peerConnection.addTrack(t, currentCall.localStream);
    });
    await currentCall.peerConnection.setRemoteDescription(
      new RTCSessionDescription(currentCall.pendingOffer)
    );
    await processPendingIceCandidates();
    const answer = await currentCall.peerConnection.createAnswer();
    await currentCall.peerConnection.setLocalDescription(answer);
    sendWS({ type: 'call_answer', caller: currentCall.targetUser, answer });
    updateCallModalState('Em chamada', 'active');
  } catch (err) {
    alert(err.message || 'Erro ao atender');
    cleanupCall();
  }
}

function rejectCall() {
  if (currentCall.targetUser) {
    sendWS({ type: 'call_reject', caller: currentCall.targetUser });
  }
  cleanupCall();
}

function setupPeerConnection() {
  const pc = new RTCPeerConnection(RTC_CONFIG);

  pc.onicecandidate = e => {
    if (e.candidate && currentCall.targetUser) {
      sendWS({
        type: 'call_ice_candidate',
        to: currentCall.targetUser,
        candidate: e.candidate
      });
    }
  };

  pc.ontrack = e => {
    let a = document.getElementById('remote-audio');
    if (!a) {
      a = document.createElement('audio');
      a.id = 'remote-audio';
      a.autoplay = true;
      a.playsInline = true;
      document.body.appendChild(a);
    }
    a.srcObject = e.streams[0];
    a.play().catch(() => {});
  };

  currentCall.peerConnection = pc;
}

async function handleCallAnswered(answer) {
  if (currentCall.peerConnection) {
    await currentCall.peerConnection.setRemoteDescription(
      new RTCSessionDescription(answer)
    );
    await processPendingIceCandidates();
    updateCallModalState('Em chamada', 'active');
  }
}

async function processPendingIceCandidates() {
  while (pendingIceCandidates.length) {
    const c = pendingIceCandidates.shift();
    try {
      if (currentCall.peerConnection && currentCall.peerConnection.remoteDescription) {
        await currentCall.peerConnection.addIceCandidate(new RTCIceCandidate(c));
      }
    } catch (e) {}
  }
}

function endCall() {
  if (currentCall.targetUser) {
    sendWS({ type: 'call_end', to: currentCall.targetUser });
  }
  cleanupCall();
}

function cleanupCall() {
  stopRingtoneSound();
  if (currentCall.localStream) {
    currentCall.localStream.getTracks().forEach(t => {
      try { t.stop(); } catch (e) {}
    });
  }
  if (currentCall.peerConnection) {
    try { currentCall.peerConnection.close(); } catch (e) {}
  }
  const a = document.getElementById('remote-audio');
  if (a) a.srcObject = null;

  currentCall = {
    peerConnection: null,
    localStream: null,
    targetUser: null,
    pendingOffer: null
  };
  pendingIceCandidates = [];
  isMuted = false;
  closeCallModal();
}

function openCallModal(name, status, state) {
  const m = document.getElementById('call-modal');
  const u = document.getElementById('call-user-name');
  if (u) u.textContent = name;
  if (m) m.classList.remove('hidden');
  updateCallModalState(status, state);
}

function updateCallModalState(status, state) {
  const s = document.getElementById('call-status-text');
  if (s) s.textContent = status;
  ['calling', 'incoming', 'active'].forEach(k => {
    document.getElementById('call-actions-' + k)?.classList.add('hidden');
  });
  if (state) {
    document.getElementById('call-actions-' + state)?.classList.remove('hidden');
  }
}

function closeCallModal() {
  document.getElementById('call-modal')?.classList.add('hidden');
}

// ========== SETTINGS ==========
async function showSettings() {
  const modal = document.getElementById('settings-modal');
  if (!modal) return;
  modal.classList.remove('hidden');

  const dn = document.getElementById('profile-displayname');
  const bio = document.getElementById('profile-bio');
  const un = document.getElementById('profile-username');

  if (currentUser) {
    if (dn) dn.value = currentUser.displayName || '';
    if (bio) bio.value = currentUser.bio || '';
    if (un) un.textContent = '@' + currentUser.username;
  }

  const vol = document.getElementById('audio-volume');
  const nr = document.getElementById('audio-noise');
  const sm = document.getElementById('audio-smooth');
  if (vol) {
    vol.value = audioVolumeBoost;
    document.getElementById('audio-volume-label').textContent = audioVolumeBoost + '%';
  }
  if (nr) nr.checked = audioNoiseReduction;
  if (sm) sm.checked = audioSmoothVoice;

  // Microfones
  const micSelect = document.getElementById('mic-select');
  if (micSelect) {
    micSelect.innerHTML = '';
    try {
      // Pede permissão primeiro para obter labels reais
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        s.getTracks().forEach(t => t.stop());
      } catch (e) {}

      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter(d => d.kind === 'audioinput');

      if (inputs.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.text = 'Nenhum microfone detectado';
        micSelect.appendChild(opt);
      } else {
        inputs.forEach((d, i) => {
          const opt = document.createElement('option');
          opt.value = d.deviceId;
          opt.text = d.label || ('Microfone ' + (i + 1));
          micSelect.appendChild(opt);
        });
        const saved = localStorage.getItem('zap_mic_id');
        if (saved) micSelect.value = saved;
      }
    } catch (e) {
      console.error(e);
      const opt = document.createElement('option');
      opt.value = '';
      opt.text = 'Erro ao listar microfones';
      micSelect.appendChild(opt);
    }
  }
}

function hideSettings() {
  document.getElementById('settings-modal')?.classList.add('hidden');
}

function saveProfile() {
  const dn = document.getElementById('profile-displayname')?.value.trim();
  const bio = document.getElementById('profile-bio')?.value.trim() || '';
  if (!dn) return alert('Nome de exibição obrigatório');

  let avatar = currentUser && currentUser.avatar;
  if (userAvatarBase64 && userAvatarBase64 !== (currentUser && currentUser.avatar)) {
    avatar = userAvatarBase64;
  }

  sendWS({
    type: 'update_profile',
    displayName: dn,
    bio,
    avatar: avatar || ''
  });
}

function previewProfileAvatar(e) {
  const file = e.target.files[0];
  if (!file) return;
  const r = new FileReader();
  r.onload = ev => {
    userAvatarBase64 = ev.target.result;
    const p = document.getElementById('profile-avatar-preview');
    if (p) {
      p.style.backgroundImage = 'url("' + encodeURI(userAvatarBase64) + '")';
      p.textContent = '';
    }
  };
  r.readAsDataURL(file);
}

function onAudioPrefChange() {
  const vol = document.getElementById('audio-volume');
  const nr = document.getElementById('audio-noise');
  const sm = document.getElementById('audio-smooth');
  if (vol) {
    audioVolumeBoost = Number(vol.value) || 100;
    document.getElementById('audio-volume-label').textContent = audioVolumeBoost + '%';
  }
  if (nr) audioNoiseReduction = nr.checked;
  if (sm) audioSmoothVoice = sm.checked;
  saveAudioPrefs();
}

function onMicChange() {
  const sel = document.getElementById('mic-select');
  if (sel && sel.value) {
    localStorage.setItem('zap_mic_id', sel.value);
  }
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
      closeMessageMenu();
    }
  });
});
