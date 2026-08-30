/* =========================================================
   ZapZap – chat.js
   Contatos, mensagens, reply, edit, delete, forward
   ========================================================= */

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
    const avStyle = c.avatar
      ? ' style="background-image:url(\'' + encodeURI(c.avatar) + '\')"'
      : '';

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

// ========== MENSAGENS ==========
function handleIncomingChatMessage(data) {
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
    if (isAppFocused) {
      sendWS({ type: 'mark_as_read', withUser: data.from });
    }
  }
}

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

  const safeContent = escapeAttr(content || '');

  if (deleted_for_all) {
    html += '<em class="deleted-msg">Mensagem apagada</em>';
  } else if (msg_type === 'image' && content) {
    html += '<div class="media-bubble"><img src="' + safeContent + '" alt="imagem" loading="lazy" onclick="openMediaViewer(this.src,\'image\')"></div>';
  } else if (msg_type === 'audio' && content) {
    html += '<div class="media-bubble audio-bubble">' +
      '<audio controls preload="metadata" src="' + safeContent + '"></audio>' +
      (media_meta && media_meta.duration ? '<small>' + Number(media_meta.duration) + 's</small>' : '') +
      '</div>';
  } else if (msg_type === 'video' && content) {
    html += '<div class="media-bubble"><video controls preload="metadata" playsinline src="' + safeContent + '"></video></div>';
  } else if (msg_type === 'file' && content) {
    const name = (media_meta && media_meta.name) || 'Arquivo';
    html += '<div class="media-bubble file-bubble">' +
      '<a href="' + safeContent + '" download="' + escapeAttr(name) + '">📎 ' + escapeHTML(name) + '</a>' +
      '</div>';
  } else {
    html += '<span class="msg-text">' + escapeHTML(content || '') + '</span>';
    if (edited) html += ' <span class="edited-tag">editado</span>';
  }

  div.innerHTML = html;

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
    messageId: messageId,
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

// ========== ENVIAR TEXTO ==========
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
      messageId: editId,
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
