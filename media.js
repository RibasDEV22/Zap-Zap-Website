/* =========================================================
   ZapZap – media.js
   Áudio, gravação, compressão, WebRTC, configurações
   ========================================================= */

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
  src.start(0);
  const rendered = await offline.startRendering();

  const dest = ctx.createMediaStreamDestination();
  const bs = ctx.createBufferSource();
  bs.buffer = rendered;
  bs.connect(dest);

  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : 'audio/webm';

  const rec = new MediaRecorder(dest.stream, { mimeType: mime, audioBitsPerSecond: 48000 });
  const chunks = [];

  return new Promise((resolve, reject) => {
    rec.ondataavailable = e => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };

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
    bs.start(0);

    setTimeout(() => {
      try {
        if (rec.state !== 'inactive') rec.stop();
      } catch (e) {}
    }, (audioBuffer.duration * 1000) + 150);
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
    if (file.size > 2.2 * 1024 * 1024) throw new Error('Vídeo muito grande (~2.2 MB máx).');
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
  if (file.size > 1.8 * 1024 * 1024) throw new Error('Arquivo muito grande (~1.8 MB máx).');
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

// ========== MICROFONE ==========
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

// ========== GRAVAÇÃO ==========
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

// ========== ARQUIVO ==========
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
  const safeSrc = escapeAttr(src);
  if (type === 'image') {
    content.innerHTML = '<img src="' + safeSrc + '" alt="preview">';
  } else if (type === 'video') {
    content.innerHTML = '<video src="' + safeSrc + '" controls autoplay playsinline></video>';
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

// ========== WEBRTC / CHAMADAS ==========
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

function onCallIncoming(data) {
  startRingtoneSound();
  currentCall.targetUser = data.caller;
  currentCall.pendingOffer = data.offer;
  showPushNotification('Chamada', '@' + data.caller + ' está ligando...', {
    requireInteraction: true,
    tag: 'call'
  });
  openCallModal(data.callerDisplayName || data.caller, 'Recebendo chamada...', 'incoming');
}

function onIceCandidate(data) {
  if (currentCall.peerConnection &&
      currentCall.peerConnection.remoteDescription &&
      currentCall.peerConnection.remoteDescription.type) {
    currentCall.peerConnection
      .addIceCandidate(new RTCIceCandidate(data.candidate))
      .catch(() => {});
  } else {
    pendingIceCandidates.push(data.candidate);
  }
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

  const micSelect = document.getElementById('mic-select');
  if (micSelect) {
    micSelect.innerHTML = '';
    try {
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
