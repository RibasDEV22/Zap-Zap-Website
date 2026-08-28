const WS_URL = 'wss://zap-zap-24qi.onrender.com';

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

let ws = null;
let currentUser = null;
let activeChatTarget = null;
let isMuted = false;
let isRegisterMode = false;
let userAvatarBase64 = null;
let allContacts = [];

const soundNotification = new Audio('NotificationSound.mp3');
const soundCall = new Audio('CallSound.mp3');
soundCall.loop = true;

let currentCall = {
  peerConnection: null,
  localStream: null,
  targetUser: null,
  pendingOffer: null
};

let pendingIceCandidates = [];

if ('Notification' in window && Notification.permission !== 'granted') {
  Notification.requestPermission();
}

function hideSplashScreen() {
  const splashBar = document.getElementById('splash-bar');
  const splashOverlay = document.getElementById('splash-screen');

  if (splashBar) splashBar.style.width = '100%';

  setTimeout(() => {
    if (splashOverlay) splashOverlay.classList.add('hidden');
  }, 400);
}

function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log('[WS] Conectado ao servidor');
    updateNetworkStatus('online', 'Conectado');

    const saved = localStorage.getItem('zap_session');
    if (saved) {
      try {
        const creds = JSON.parse(saved);
        sendWS({ type: 'login', username: creds.username, password: creds.password });
      } catch (e) {
        localStorage.removeItem('zap_session');
        hideSplashScreen();
      }
    } else {
      hideSplashScreen();
    }
  };

  ws.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      handleServerMessage(data);
    } catch (err) {
      console.error('[WS] Erro ao processar JSON:', err);
    }
  };

  ws.onerror = () => {
    updateNetworkStatus('offline', 'Erro de Conexão');
    hideSplashScreen();
  };

  ws.onclose = () => {
    updateNetworkStatus('connecting', 'Reconectando...');
    setTimeout(connectWebSocket, 3000);
  };
}

function updateNetworkStatus(state, message) {
  const netBar = document.getElementById('network-bar');
  if (!netBar) return;
  netBar.className = `network-bar ${state}`;
  netBar.textContent = message;
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
      break;

    case 'auth_error':
      hideSplashScreen();
      showAuthError(data.message || 'Erro de Autenticação');
      break;

    case 'contacts_list':
    case 'users_list':
      allContacts = data.users || [];
      renderContacts(allContacts);
      updateHeaderStatus();
      break;

    case 'chat_message':
      playNotificationSound();
      showPushNotification(`Mensagem de @${data.from}`, data.text);
      if (activeChatTarget === data.from) {
        appendChatMessage(data.from, data.text, false);
      }
      break;

    case 'chat_history':
      if (activeChatTarget === data.withUser) {
        renderChatHistory(data.messages || []);
      }
      break;

    case 'call_incoming':
      soundCall.play().catch(() => {});
      currentCall.targetUser = data.caller;
      currentCall.pendingOffer = data.offer;
      showPushNotification(`Chamada Recebida`, `@${data.caller} está te ligando...`);
      openCallModal(data.callerDisplayName || data.caller, 'Recebendo chamada...', 'incoming');
      break;

    case 'call_offline':
    case 'call_error':
      soundCall.pause();
      soundCall.currentTime = 0;
      alert(data.message || `Usuário indisponível.`);
      cleanupCall();
      break;

    case 'call_rejected':
      soundCall.pause();
      soundCall.currentTime = 0;
      alert(`@${data.from || 'O usuário'} recusou a chamada.`);
      cleanupCall();
      break;

    case 'call_answered':
      soundCall.pause();
      soundCall.currentTime = 0;
      handleCallAnswered(data.answer);
      break;

    case 'call_ice_candidate':
      if (currentCall.peerConnection && currentCall.peerConnection.remoteDescription) {
        currentCall.peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(console.error);
      } else {
        pendingIceCandidates.push(data.candidate);
      }
      break;

    case 'call_ended':
      cleanupCall();
      break;
  }
}

function toggleAuthMode(e) {
  if (e) e.preventDefault();
  isRegisterMode = !isRegisterMode;

  const title = document.getElementById('auth-title');
  const regFields = document.getElementById('register-fields');
  const btnSubmit = document.getElementById('auth-btn-submit');
  const toggleText = document.getElementById('auth-toggle-text');
  const toggleBtn = document.getElementById('auth-toggle-btn');
  const errBox = document.getElementById('auth-error-msg');

  if (errBox) errBox.classList.add('hidden');

  if (isRegisterMode) {
    title.innerText = 'Criar Nova Conta';
    regFields.classList.remove('hidden');
    btnSubmit.innerText = 'Cadastrar';
    toggleText.innerText = 'Já possui uma conta?';
    toggleBtn.innerText = 'Entrar';
  } else {
    title.innerText = 'Entrar no Zap Zap';
    regFields.classList.add('hidden');
    btnSubmit.innerText = 'Entrar';
    toggleText.innerText = 'Não tem uma conta?';
    toggleBtn.innerText = 'Cadastrar-se';
  }
}

function previewAvatar(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    userAvatarBase64 = e.target.result;
    const preview = document.getElementById('avatar-preview');
    if (preview) {
      preview.style.backgroundImage = `url("${encodeURI(userAvatarBase64)}")`;
      preview.innerText = '';
    }
  };
  reader.readAsDataURL(file);
}

function handleAuthSubmit(event) {
  event.preventDefault();
  const usernameInput = document.getElementById('auth-username').value.trim();
  const passwordInput = document.getElementById('auth-password').value.trim();
  const displayNameInput = document.getElementById('auth-displayname').value.trim();

  const payload = {
    type: isRegisterMode ? 'register' : 'login',
    username: usernameInput,
    password: passwordInput,
    displayName: displayNameInput || usernameInput,
    avatar: userAvatarBase64
  };

  sendWS(payload);
}

function showAuthError(msg) {
  const errBox = document.getElementById('auth-error-msg');
  if (errBox) {
    errBox.textContent = msg;
    errBox.classList.remove('hidden');
  }
}

function showMainScreen() {
  document.getElementById('auth-screen')?.classList.add('hidden');
  document.getElementById('app-container')?.classList.remove('hidden');
}

function renderUserProfile() {
  if (!currentUser) return;
  const dispName = document.getElementById('my-display-name');
  const userHandle = document.getElementById('my-username');
  const avatarBox = document.getElementById('my-avatar');

  if (dispName) dispName.textContent = currentUser.displayName || currentUser.username;
  if (userHandle) userHandle.textContent = `@${currentUser.username}`;
  if (avatarBox) {
    if (currentUser.avatar) {
      avatarBox.style.backgroundImage = `url("${encodeURI(currentUser.avatar)}")`;
      avatarBox.textContent = '';
    } else {
      avatarBox.textContent = (currentUser.displayName || currentUser.username).charAt(0).toUpperCase();
    }
  }
}

function logout() {
  localStorage.removeItem('zap_session');
  location.reload();
}

function renderContacts(contacts) {
  const listContainer = document.getElementById('contacts-list');
  if (!listContainer) return;
  listContainer.innerHTML = '';

  contacts.forEach(c => {
    if (currentUser && c.username === currentUser.username) return;

    const item = document.createElement('div');
    item.className = `contact-item ${activeChatTarget === c.username ? 'active' : ''}`;
    item.onclick = () => selectContact(c);

    const initial = (c.displayName || c.username).charAt(0).toUpperCase();
    const avatarStyle = c.avatar ? `style="background-image: url('${encodeURI(c.avatar)}');"` : '';
    const avatarHTML = c.avatar 
      ? `<div class="avatar" ${avatarStyle}></div>`
      : `<div class="avatar">${initial}</div>`;

    const isOnline = c.online;

    item.innerHTML = `
      ${avatarHTML}
      <div class="contact-details">
        <div class="contact-name">${escapeHTML(c.displayName || c.username)}</div>
        <div class="contact-status ${isOnline ? 'online-text' : ''}">
          ${isOnline ? '🟢 Online' : '⚪ Offline'}
        </div>
      </div>
    `;

    listContainer.appendChild(item);
  });
}

function filterContacts() {
  const query = document.getElementById('search-input')?.value.toLowerCase() || '';
  const filtered = allContacts.filter(c => 
    (c.displayName && c.displayName.toLowerCase().includes(query)) ||
    c.username.toLowerCase().includes(query)
  );
  renderContacts(filtered);
}

function selectContact(contact) {
  activeChatTarget = contact.username;
  renderContacts(allContacts);

  document.getElementById('empty-state')?.classList.add('hidden');
  document.getElementById('chat-header')?.classList.remove('hidden');
  document.getElementById('chat-messages')?.classList.remove('hidden');
  document.getElementById('chat-input-area')?.classList.remove('hidden');

  document.getElementById('chat-user-name').textContent = contact.displayName || contact.username;
  updateHeaderStatus();

  const avatarBox = document.getElementById('chat-user-avatar');
  if (avatarBox) {
    if (contact.avatar) {
      avatarBox.style.backgroundImage = `url("${encodeURI(contact.avatar)}")`;
      avatarBox.textContent = '';
    } else {
      avatarBox.textContent = (contact.displayName || contact.username).charAt(0).toUpperCase();
    }
  }

  const container = document.getElementById('chat-messages');
  if (container) container.innerHTML = '';

  sendWS({ type: 'get_chat_history', withUser: contact.username });
  document.getElementById('app-container')?.classList.add('active-chat');
}

function updateHeaderStatus() {
  if (!activeChatTarget) return;
  const targetUser = allContacts.find(c => c.username === activeChatTarget);
  const statusEl = document.getElementById('chat-user-status');
  if (statusEl && targetUser) {
    statusEl.textContent = targetUser.online ? 'Online' : 'Offline';
    statusEl.className = `status-indicator ${targetUser.online ? 'online' : ''}`;
  }
}

function backToContacts() {
  document.getElementById('app-container')?.classList.remove('active-chat');
}

function renderChatHistory(messages) {
  const container = document.getElementById('chat-messages');
  if (!container) return;
  container.innerHTML = '';

  messages.forEach(msg => {
    const isMe = msg.sender === currentUser.username;
    appendChatMessage(msg.sender, msg.content, isMe);
  });
}

function handleKeyPress(e) {
  if (e.key === 'Enter') {
    sendMessage();
  }
}

function sendMessage() {
  const inputEl = document.getElementById('message-input');
  if (!inputEl) return;
  const text = inputEl.value.trim();

  if (!activeChatTarget || !text) return;

  sendWS({ type: 'chat_message', to: activeChatTarget, text: text });
  appendChatMessage(currentUser ? currentUser.username : 'Eu', text, true);
  inputEl.value = '';
}

function appendChatMessage(sender, text, isMe) {
  const container = document.getElementById('chat-messages');
  if (!container) return;

  const msgDiv = document.createElement('div');
  msgDiv.className = `message ${isMe ? 'sent' : 'received'}`;
  msgDiv.innerHTML = `<strong>${escapeHTML(sender)}:</strong> ${escapeHTML(text)}`;
  
  container.appendChild(msgDiv);
  container.scrollTop = container.scrollHeight;
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'F4') {
    e.preventDefault();
    toggleMicrophone();
  }
});

function toggleMicrophone() {
  if (!currentCall.localStream) return;
  
  isMuted = !isMuted;
  currentCall.localStream.getAudioTracks().forEach(track => {
    track.enabled = !isMuted;
  });

  const muteBtn = document.getElementById('btn-toggle-mic');
  if (muteBtn) {
    muteBtn.textContent = isMuted ? '🎙️ Desmutar (F4)' : '🎙️ Mutar (F4)';
  }

  showPushNotification('Microfone', isMuted ? 'Microfone Mutado' : 'Microfone Ativado');
}

async function startCall(targetUserOverride) {
  const target = targetUserOverride || activeChatTarget;
  if (!target) {
    alert('Selecione um usuário para iniciar a chamada.');
    return;
  }

  try {
    currentCall.targetUser = target;
    
    currentCall.localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false
    });

    setupPeerConnection();

    currentCall.localStream.getTracks().forEach(track => {
      currentCall.peerConnection.addTrack(track, currentCall.localStream);
    });

    const offer = await currentCall.peerConnection.createOffer();
    await currentCall.peerConnection.setLocalDescription(offer);

    sendWS({ type: 'call_initiate', callee: target, offer });
    
    soundCall.play().catch(() => {});
    openCallModal(target, 'Chamando...', 'calling');
  } catch (err) {
    alert('Erro ao acessar o microfone ou dispositivo de áudio.');
    cleanupCall();
  }
}

async function acceptCall() {
  try {
    soundCall.pause();
    soundCall.currentTime = 0;

    currentCall.localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false
    });

    setupPeerConnection();

    currentCall.localStream.getTracks().forEach(track => {
      currentCall.peerConnection.addTrack(track, currentCall.localStream);
    });

    await currentCall.peerConnection.setRemoteDescription(new RTCSessionDescription(currentCall.pendingOffer));
    await processPendingIceCandidates();

    const answer = await currentCall.peerConnection.createAnswer();
    await currentCall.peerConnection.setLocalDescription(answer);

    sendWS({ type: 'call_answer', caller: currentCall.targetUser, answer });
    updateCallModalState('Em Chamada', 'active');
  } catch (err) {
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

  pc.onicecandidate = (event) => {
    if (event.candidate && currentCall.targetUser) {
      sendWS({ type: 'call_ice_candidate', to: currentCall.targetUser, candidate: event.candidate });
    }
  };

  pc.ontrack = (event) => {
    let remoteAudio = document.getElementById('remote-audio');
    if (!remoteAudio) {
      remoteAudio = document.createElement('audio');
      remoteAudio.id = 'remote-audio';
      remoteAudio.autoplay = true;
      document.body.appendChild(remoteAudio);
    }
    
    remoteAudio.srcObject = event.streams[0];
    remoteAudio.play().catch(e => console.log('Autoplay bloqueado pelo sistema:', e));
  };

  currentCall.peerConnection = pc;
}

async function handleCallAnswered(answer) {
  if (currentCall.peerConnection) {
    await currentCall.peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
    await processPendingIceCandidates();
    updateCallModalState('Em Chamada', 'active');
  }
}

async function processPendingIceCandidates() {
  while (pendingIceCandidates.length > 0) {
    const candidate = pendingIceCandidates.shift();
    try {
      if (currentCall.peerConnection) {
        await currentCall.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      }
    } catch (e) {
      console.error('[WebRTC] Erro ao adicionar ICE:', e);
    }
  }
}

function endCall() {
  if (currentCall.targetUser) {
    sendWS({ type: 'call_end', to: currentCall.targetUser });
  }
  cleanupCall();
}

function cleanupCall() {
  soundCall.pause();
  soundCall.currentTime = 0;

  if (currentCall.localStream) {
    currentCall.localStream.getTracks().forEach(t => t.stop());
  }
  if (currentCall.peerConnection) {
    currentCall.peerConnection.close();
  }

  const remoteAudio = document.getElementById('remote-audio');
  if (remoteAudio) {
    remoteAudio.srcObject = null;
  }

  currentCall = { peerConnection: null, localStream: null, targetUser: null, pendingOffer: null };
  pendingIceCandidates = [];
  isMuted = false;
  closeCallModal();
}

function openCallModal(name, status, state) {
  const modal = document.getElementById('call-modal');
  const userEl = document.getElementById('call-user-name');
  if (userEl) userEl.textContent = name;
  if (modal) modal.classList.remove('hidden');
  updateCallModalState(status, state);
}

function updateCallModalState(status, state) {
  const statusEl = document.getElementById('call-status-text');
  if (statusEl) statusEl.textContent = status;

  document.getElementById('call-actions-calling')?.classList.add('hidden');
  document.getElementById('call-actions-incoming')?.classList.add('hidden');
  document.getElementById('call-actions-active')?.classList.add('hidden');

  if (state === 'calling') document.getElementById('call-actions-calling')?.classList.remove('hidden');
  if (state === 'incoming') document.getElementById('call-actions-incoming')?.classList.remove('hidden');
  if (state === 'active') document.getElementById('call-actions-active')?.classList.remove('hidden');
}

function closeCallModal() {
  document.getElementById('call-modal')?.classList.add('hidden');
}

async function showSettings() {
  const modal = document.getElementById('settings-modal');
  if (!modal) return;
  modal.classList.remove('hidden');

  const micSelect = document.getElementById('mic-select');
  if (!micSelect) return;

  micSelect.innerHTML = '';
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = devices.filter(d => d.kind === 'audioinput');

    audioInputs.forEach((device, index) => {
      const opt = document.createElement('option');
      opt.value = device.deviceId;
      opt.text = device.label || `Microfone ${index + 1}`;
      micSelect.appendChild(opt);
    });
  } catch (err) {
    console.error('Erro ao enumerar dispositivos:', err);
  }
}

function hideSettings() {
  document.getElementById('settings-modal')?.classList.add('hidden');
}

function playNotificationSound() {
  soundNotification.currentTime = 0;
  soundNotification.play().catch(() => {});
}

function showPushNotification(title, body) {
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(title, { body });
  }
}

function escapeHTML(str) {
  return String(str).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

document.addEventListener('DOMContentLoaded', connectWebSocket);