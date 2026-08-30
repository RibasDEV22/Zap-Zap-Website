/* =========================================================
   ZapZap – media.js (revisado)
   Áudio, gravação, compressão, WebRTC, configurações
   Melhorias: robustez, compatibilidade e pequenas correções
   ========================================================= */

/* Helpers utilitários */
async function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    try {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(new Error('Erro ao ler blob como dataURL'));
      fr.readAsDataURL(blob);
    } catch (e) {
      reject(e);
    }
  });
}

function safeNumber(v, fallback = 100) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/* ========== PREFERÊNCIAS DE ÁUDIO ==========
   (usa variáveis globais externas quando existentes;
    caso não existam, aplica valores padrão localmente) */

function getAudioPref(name, def) {
  try {
    if (typeof window !== 'undefined' && window[name] !== undefined) return window[name];
  } catch (e) {}
  return def;
}

function saveAudioPrefs() {
  try {
    if (!window.localStorage) return;
    const payload = {
      volumeBoost: getAudioPref('audioVolumeBoost', 100),
      noiseReduction: getAudioPref('audioNoiseReduction', true),
      smoothVoice: getAudioPref('audioSmoothVoice', false)
    };
    localStorage.setItem('zap_audio_prefs', JSON.stringify(payload));
  } catch (e) {
    console.warn('saveAudioPrefs falhou:', e);
  }
}

/* ========== PROCESSAMENTO DE ÁUDIO ==========
   Funções defensivas, fallback para decodeAudioData e
   proteção contra contextos inexistentes. */
async function processAudioBuffer(audioBuffer) {
  if (!audioBuffer) return audioBuffer;

  const ctx = (typeof getAudioContext === 'function' && getAudioContext()) || null;
  if (!ctx) return audioBuffer;

  // Use OfflineAudioContext para processamento sem bloquear o principal
  const offline = new OfflineAudioContext(1, audioBuffer.length, audioBuffer.sampleRate);
  const source = offline.createBufferSource();
  source.buffer = audioBuffer;
  let node = source;

  const audioNoiseReduction = getAudioPref('audioNoiseReduction', true);
  const audioSmoothVoice = getAudioPref('audioSmoothVoice', false);
  const audioVolumeBoost = safeNumber(getAudioPref('audioVolumeBoost', 100), 100);

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
  // valor em [0.05, 5]
  gain.gain.value = Math.min(5, Math.max(0.05, audioVolumeBoost / 100));
  node.connect(gain);
  gain.connect(offline.destination);

  source.start(0);
  return offline.startRendering();
}

async function decodeAudioSafe(ctx, arrayBuffer) {
  // Compatibilidade com navegadores que ainda usam callbacks
  if (!ctx || !arrayBuffer) throw new Error('Contexto ou buffer inválido');
  if (ctx.decodeAudioData.length === 1) {
    // retorna Promise normalmente
    return ctx.decodeAudioData(arrayBuffer.slice(0));
  }
  // fallback callback-style
  return new Promise((resolve, reject) => {
    try {
      ctx.decodeAudioData(arrayBuffer.slice(0), resolve, err => reject(err || new Error('decodeAudioData falhou')));
    } catch (e) {
      reject(e);
    }
  });
}

async function compressAndProcessAudio(fileOrBlob) {
  // fileOrBlob pode ser Blob/File ou ArrayBuffer já decodificado
  const arrayBuffer = await (fileOrBlob && typeof fileOrBlob.arrayBuffer === 'function'
    ? fileOrBlob.arrayBuffer()
    : (fileOrBlob instanceof ArrayBuffer ? fileOrBlob : null));
  if (!arrayBuffer) throw new Error('Dados de áudio inválidos');

  const ctx = (typeof getAudioContext === 'function' && getAudioContext()) || new (window.AudioContext || window.webkitAudioContext)();
  // decodeAudioData pode lançar; usar decodeAudioSafe para compatibilidade
  let audioBuffer;
  try {
    audioBuffer = await decodeAudioSafe(ctx, arrayBuffer);
  } catch (err) {
    console.warn('decodeAudioData falhou, tentando com OfflineAudioContext:', err);
    // fallback: tentar com OfflineAudioContext decode
    const offlineTry = new OfflineAudioContext(1, Math.ceil(arrayBuffer.byteLength / 2), 22050);
    // Nota: esse fallback pode falhar; propagar erro se não ajudar
    audioBuffer = await offlineTry.decodeAudioData(arrayBuffer.slice(0));
  }

  // Processamento (filtros, ganho, etc.)
  audioBuffer = await processAudioBuffer(audioBuffer);

  // Re-renderizar para sampleRate alvo (reduz tamanho)
  const targetRate = 22050;
  const offline = new OfflineAudioContext(1, Math.ceil(audioBuffer.duration * targetRate), targetRate);
  const src = offline.createBufferSource();
  src.buffer = audioBuffer;
  src.connect(offline.destination);
  src.start(0);
  const rendered = await offline.startRendering();

  // Agora, gerar um MediaStream a partir de um AudioContext que exista
  // Usar um AudioContext temporário se o atual tiver problema
  const outCtx = ctx;
  const dest = outCtx.createMediaStreamDestination();
  const bs = outCtx.createBufferSource();
  bs.buffer = rendered;
  bs.connect(dest);

  // determinar MIME suportado
  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' :
               (MediaRecorder.isTypeSupported('audio/ogg;codecs=opus') ? 'audio/ogg;codecs=opus' : 'audio/webm');

  const options = {};
  // bitrate opcional (nem todos os browsers respeitam)
  options.audioBitsPerSecond = 48000;

  const rec = new MediaRecorder(dest.stream, Object.assign({ mimeType: mime }, options));
  const chunks = [];

  return new Promise((resolve, reject) => {
    let stopTimeout = null;
    rec.ondataavailable = e => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };

    rec.onerror = e => {
      reject(new Error((e && e.error && e.error.message) ? e.error.message : 'MediaRecorder erro'));
    };

    rec.onstop = async () => {
      try {
        const blob = new Blob(chunks, { type: mime });
        const dataUrl = await blobToDataURL(blob);
        resolve({
          dataUrl,
          mime,
          size: blob.size,
          duration: Math.round(audioBuffer.duration)
        });
      } catch (e) {
        reject(e);
      } finally {
        if (stopTimeout) clearTimeout(stopTimeout);
      }
    };

    try {
      rec.start();
      // iniciar a fonte; se falhar, parar gravação de forma segura
      try { bs.start(0); } catch (e) { /* pode lançar se já iniciado */ }

      // Garantir parada mesmo que algo dê errado: timeout com margem
      stopTimeout = setTimeout(() => {
        try {
          if (rec && rec.state !== 'inactive') rec.stop();
        } catch (e) {}
      }, (audioBuffer.duration * 1000) + 500);
    } catch (e) {
      reject(e);
    }
  });
}

/* ========== COMPRESSÃO DE MÍDIA ========== */
async function compressImage(file, maxW = 1280, quality = 0.72) {
  return new Promise((resolve, reject) => {
    if (!file) return reject(new Error('Arquivo inválido'));
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      try {
        let w = img.width, h = img.height;
        if (w > maxW) {
          h = Math.round(h * maxW / w);
          w = maxW;
        }
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx2d = c.getContext('2d');
        // limpar canvas
        ctx2d.clearRect(0, 0, w, h);
        ctx2d.drawImage(img, 0, 0, w, h);
        c.toBlob(blob => {
          if (!blob) return reject(new Error('Falha ao comprimir imagem'));
          blobToDataURL(blob).then(dataUrl => {
            resolve({ dataUrl, mime: 'image/jpeg', size: blob.size });
          }).catch(reject);
        }, 'image/jpeg', quality);
      } catch (e) {
        reject(e);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Imagem inválida'));
    };
    img.src = url;
  });
}

async function prepareMediaFile(file) {
  if (!file) throw new Error('Arquivo inválido');
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
    const dataUrl = await blobToDataURL(file);
    return { dataUrl, mime: file.type, size: file.size, msg_type: 'video', fileName: file.name };
  }
  if (file.size > 1.8 * 1024 * 1024) throw new Error('Arquivo muito grande (~1.8 MB máx).');
  const dataUrl = await blobToDataURL(file);
  return { dataUrl, mime: file.type || 'application/octet-stream', size: file.size, msg_type: 'file', fileName: file.name };
}

/* ========== MICROFONE ========== */
function getPreferredMicConstraints(extra = {}) {
  const savedId = (typeof localStorage !== 'undefined') ? localStorage.getItem('zap_mic_id') : null;
  const audioNoiseReduction = getAudioPref('audioNoiseReduction', true);
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
  if (!window.isSecureContext) {
    throw new Error('Microfone só funciona em HTTPS ou localhost.');
  }

  const constraints = { audio: getPreferredMicConstraints(extraConstraints), video: false };

  try {
    return await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    // tentar sem constraints específicos
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (err2) {
      const name = (err && err.name) || (err2 && err2.name) || '';
      let msg = 'Não foi possível acessar o microfone.';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        msg = 'Permissão do microfone negada. Ative nas configurações do navegador/app.';
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        msg = 'Nenhum microfone encontrado neste dispositivo.';
      } else if (name === 'NotReadableError' || name === 'TrackStartError') {
        msg = 'Microfone em uso por outro aplicativo.';
      } else if (name === 'OverconstrainedError') {
        msg = 'Configuração de microfone não suportada. Tente outro dispositivo nas Configurações.';
      }
      throw new Error(msg);
    }
  }
}

/* ========== GRAVAÇÃO ========== */
/* Observação: variáveis globais usadas aqui (isRecording, recordingStream, mediaRecorder, etc.)
   devem existir no escopo global da sua aplicação; caso não existam, você pode inicializá-las. */

async function startVoiceRecord() {
  try {
    if (typeof isRecording !== 'undefined' && isRecording) return;
    if (typeof getAudioContext === 'function') getAudioContext();
    recordingStream = await getMicrophoneStream();
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';

    mediaRecorder = new MediaRecorder(recordingStream, { mimeType: mime, audioBitsPerSecond: 64000 });
    recordedChunks = [];

    mediaRecorder.ondataavailable = e => {
      if (e.data && e.data.size) recordedChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      const blob = new Blob(recordedChunks, { type: mime });
      try {
        if (typeof showInAppToast === 'function') showInAppToast('Processando', 'Aplicando efeitos de áudio...');
        const processed = await compressAndProcessAudio(blob);
        if (!activeChatTarget) return;
        // enviar via WS (assumindo sendWS disponível)
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
        if (typeof clearReply === 'function') clearReply();
      } catch (err) {
        alert(err.message || 'Erro ao processar áudio.');
      } finally {
        stopRecordingTracks();
        if (typeof updateRecordUI === 'function') updateRecordUI(false);
      }
    };

    mediaRecorder.onerror = e => {
      console.error('mediaRecorder error', e);
    };

    mediaRecorder.start(100);
    isRecording = true;
    recordStartTs = Date.now();
    if (typeof updateRecordUI === 'function') updateRecordUI(true);
  } catch (err) {
    alert(err.message || 'Não foi possível acessar o microfone.');
    console.error(err);
    stopRecordingTracks();
    if (typeof updateRecordUI === 'function') updateRecordUI(false);
  }
}

function stopRecordingTracks() {
  try {
    if (recordingStream) {
      recordingStream.getTracks().forEach(t => {
        try { t.stop(); } catch (e) {}
      });
      recordingStream = null;
    }
  } catch (e) {
    console.warn('stopRecordingTracks erro', e);
  }
}

function stopVoiceRecord() {
  try {
    if (typeof isRecording === 'undefined' || !isRecording || !mediaRecorder) return;
    isRecording = false;
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  } catch (e) { console.warn(e); }
}

function cancelVoiceRecord() {
  try {
    if (typeof isRecording === 'undefined' || !isRecording) return;
    isRecording = false;
    recordedChunks = [];
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  } catch (e) { console.warn(e); }
  stopRecordingTracks();
  if (typeof updateRecordUI === 'function') updateRecordUI(false);
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

/* ========== ARQUIVO ========== */
async function handleFileSelect(event) {
  const file = event.target && event.target.files && event.target.files[0];
  if (!file || !activeChatTarget) return;
  // limpar input
  try { event.target.value = ''; } catch (e) {}

  try {
    if (typeof showInAppToast === 'function') showInAppToast('Preparando', 'Comprimindo...');
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
    if (typeof clearReply === 'function') clearReply();
  } catch (err) {
    alert(err.message || 'Erro no arquivo');
  }
}

/* ========== MEDIA VIEWER ========== */
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
  const safeSrc = typeof escapeAttr === 'function' ? escapeAttr(src) : src;
  if (type === 'image') {
    content.innerHTML = '<img src="' + safeSrc + '" alt="preview">';
  } else if (type === 'video') {
    content.innerHTML = '<video src="' + safeSrc + '" controls autoplay playsinline></video>';
  } else {
    content.innerHTML = '<a href="' + safeSrc + '" target="_blank" rel="noopener noreferrer">Abrir mídia</a>';
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

/* ========== WEBRTC / CHAMADAS ========== */
window.addEventListener('keydown', e => {
  if (e.key === 'F4') {
    e.preventDefault();
    if (typeof toggleMicrophone === 'function') toggleMicrophone();
  }
});

function toggleMicrophone() {
  if (!currentCall || !currentCall.localStream) return;
  isMuted = !isMuted;
  currentCall.localStream.getAudioTracks().forEach(t => { t.enabled = !isMuted; });
  const b = document.getElementById('btn-toggle-mic');
  if (b) b.textContent = isMuted ? '🎙️ Desmutar (F4)' : '🎙️ Mutar (F4)';
}

function onCallIncoming(data) {
  if (typeof startRingtoneSound === 'function') startRingtoneSound();
  currentCall.targetUser = data.caller;
  currentCall.pendingOffer = data.offer;
  if (typeof showPushNotification === 'function') {
    showPushNotification('Chamada', '@' + data.caller + ' está ligando...', {
      requireInteraction: true,
      tag: 'call'
    });
  }
  if (typeof openCallModal === 'function') openCallModal(data.callerDisplayName || data.caller, 'Recebendo chamada...', 'incoming');
}

function onIceCandidate(data) {
  try {
    if (currentCall.peerConnection &&
        currentCall.peerConnection.remoteDescription &&
        currentCall.peerConnection.remoteDescription.type) {
      currentCall.peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(() => {});
    } else {
      pendingIceCandidates = pendingIceCandidates || [];
      pendingIceCandidates.push(data.candidate);
    }
  } catch (e) {
    console.warn('onIceCandidate erro', e);
  }
}

async function startCall(targetUserOverride) {
  try {
    if (typeof getAudioContext === 'function') getAudioContext();
    const target = targetUserOverride || activeChatTarget;
    if (!target) return alert('Selecione um usuário');

    currentCall.targetUser = target;
    currentCall.localStream = await getMicrophoneStream();
    setupPeerConnection();
    currentCall.localStream.getTracks().forEach(t => {
      currentCall.peerConnection.addTrack(t, currentCall.localStream);
    });
    const offer = await currentCall.peerConnection.createOffer();
    await currentCall.peerConnection.setLocalDescription(offer);
    sendWS({ type: 'call_initiate', callee: target, offer });
    if (typeof startRingtoneSound === 'function') startRingtoneSound();
    openCallModal(target, 'Chamando...', 'calling');
  } catch (err) {
    alert(err.message || 'Erro no microfone');
    cleanupCall();
  }
}

async function acceptCall() {
  try {
    if (typeof getAudioContext === 'function') getAudioContext();
    if (typeof stopRingtoneSound === 'function') stopRingtoneSound();
    currentCall.localStream = await getMicrophoneStream();
    setupPeerConnection();
    currentCall.localStream.getTracks().forEach(t => {
      currentCall.peerConnection.addTrack(t, currentCall.localStream);
    });
    if (!currentCall.pendingOffer) throw new Error('Oferta pendente não encontrada');
    await currentCall.peerConnection.setRemoteDescription(new RTCSessionDescription(currentCall.pendingOffer));
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
  if (currentCall && currentCall.targetUser) {
    sendWS({ type: 'call_reject', caller: currentCall.targetUser });
  }
  cleanupCall();
}

function setupPeerConnection() {
  const pc = new RTCPeerConnection(typeof RTC_CONFIG !== 'undefined' ? RTC_CONFIG : null);

  pc.onicecandidate = e => {
    if (e.candidate && currentCall && currentCall.targetUser) {
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
    a.srcObject = e.streams && e.streams[0] ? e.streams[0] : e.stream;
    a.play().catch(() => {});
  };

  currentCall = currentCall || {};
  currentCall.peerConnection = pc;
}

async function handleCallAnswered(answer) {
  try {
    if (currentCall.peerConnection) {
      await currentCall.peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
      await processPendingIceCandidates();
      updateCallModalState('Em chamada', 'active');
    }
  } catch (e) {
    console.warn('handleCallAnswered erro', e);
  }
}

async function processPendingIceCandidates() {
  pendingIceCandidates = pendingIceCandidates || [];
  while (pendingIceCandidates.length) {
    const c = pendingIceCandidates.shift();
    try {
      if (currentCall.peerConnection && currentCall.peerConnection.remoteDescription) {
        await currentCall.peerConnection.addIceCandidate(new RTCIceCandidate(c));
      }
    } catch (e) {
      console.warn('processPendingIceCandidates addIceCandidate falhou', e);
    }
  }
}

function endCall() {
  if (currentCall && currentCall.targetUser) {
    sendWS({ type: 'call_end', to: currentCall.targetUser });
  }
  cleanupCall();
}

function cleanupCall() {
  try {
    if (typeof stopRingtoneSound === 'function') stopRingtoneSound();
    if (currentCall && currentCall.localStream) {
      currentCall.localStream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} });
    }
    if (currentCall && currentCall.peerConnection) {
      try { currentCall.peerConnection.close(); } catch (e) {}
    }
    const a = document.getElementById('remote-audio');
    if (a) a.srcObject = null;
  } catch (e) {
    console.warn('cleanupCall erro', e);
  }

  currentCall = {
    peerConnection: null,
    localStream: null,
    targetUser: null,
    pendingOffer: null
  };
  pendingIceCandidates = [];
  isMuted = false;
  if (typeof closeCallModal === 'function') closeCallModal();
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
    const el = document.getElementById('call-actions-' + k);
    if (el) el.classList.add('hidden');
  });
  if (state) {
    const el = document.getElementById('call-actions-' + state);
    if (el) el.classList.remove('hidden');
  }
}

function closeCallModal() {
  const m = document.getElementById('call-modal');
  if (m) m.classList.add('hidden');
}

/* ========== SETTINGS ========== */

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
    if (un) un.textContent = '@' + (currentUser.username || '');
  }

  const vol = document.getElementById('audio-volume');
  const nr = document.getElementById('audio-noise');
  const sm = document.getElementById('audio-smooth');
  const audioVolumeBoost = safeNumber(getAudioPref('audioVolumeBoost', 100), 100);
  if (vol) {
    vol.value = audioVolumeBoost;
    const lbl = document.getElementById('audio-volume-label');
    if (lbl) lbl.textContent = audioVolumeBoost + '%';
  }
  if (nr) nr.checked = getAudioPref('audioNoiseReduction', true);
  if (sm) sm.checked = getAudioPref('audioSmoothVoice', false);

  const micSelect = document.getElementById('mic-select');
  if (micSelect) {
    micSelect.innerHTML = '';
    try {
      // solicitar permissão apenas para obter labels (se possível)
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        s.getTracks().forEach(t => t.stop());
      } catch (e) {
        // ignorar: pode falhar se permissão negada
      }

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
        const saved = (typeof localStorage !== 'undefined') ? localStorage.getItem('zap_mic_id') : null;
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
    const value = Number(vol.value);
    audioVolumeBoost = Number.isFinite(value) ? value : 100;
    const lbl = document.getElementById('audio-volume-label');
    if (lbl) lbl.textContent = audioVolumeBoost + '%';
  }
  if (nr) audioNoiseReduction = nr.checked;
  if (sm) audioSmoothVoice = sm.checked;
  saveAudioPrefs();
}

function onMicChange() {
  const sel = document.getElementById('mic-select');
  if (sel && sel.value) {
    try {
      localStorage.setItem('zap_mic_id', sel.value);
    } catch (e) {}
  }
}
