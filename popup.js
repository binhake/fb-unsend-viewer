// popup.js - Quản lý giao diện lịch sử tin nhắn thu hồi, bộ lọc, Xuất/Nhập Backup (JSON) và Lightbox

const STORAGE_KEY_MESSAGES = 'fb_captured_messages_v2';
const STORAGE_KEY_UNSENT = 'fb_unsent_messages_v2';
const STORAGE_KEY_CLEANED_FLAG = 'fb_unsend_schema_v4_cleaned';

const unsentListEl = document.getElementById('unsent-list');
const statTotalEl = document.getElementById('stat-total');
const statOthersEl = document.getElementById('stat-others');
const statMediaEl = document.getElementById('stat-media');
const statCachedEl = document.getElementById('stat-cached');

const searchInputEl = document.getElementById('search-input');
const clearSearchBtnEl = document.getElementById('clear-search-btn');
const threadFilterEl = document.getElementById('thread-filter');
const filterTabsEl = document.getElementById('filter-tabs');

const exportBtnEl = document.getElementById('export-btn');
const importBtnEl = document.getElementById('import-btn');
const importFileInputEl = document.getElementById('import-file-input');
const clearAllBtnEl = document.getElementById('clear-all-btn');
const statusBannerEl = document.getElementById('status-banner');

const lightboxModalEl = document.getElementById('lightbox-modal');
const lightboxImgEl = document.getElementById('lightbox-img');
const lightboxDownloadEl = document.getElementById('lightbox-download');
const lightboxCloseEl = document.getElementById('lightbox-close');

let allUnsentMessages = [];
let allCapturedMessages = [];
let activeTabFilter = 'all'; // 'all' | 'others' | 'self' | 'media'
let activeThreadFilter = 'ALL';
let clearConfirmTimeout = null;
let bannerTimeout = null;

const AVATAR_GRADIENTS = [
  'linear-gradient(135deg, #f43f5e, #e11d48)',
  'linear-gradient(135deg, #8b5cf6, #6d28d9)',
  'linear-gradient(135deg, #0ea5e9, #0284c7)',
  'linear-gradient(135deg, #10b981, #059669)',
  'linear-gradient(135deg, #f59e0b, #d97706)',
  'linear-gradient(135deg, #ec4899, #be185d)',
  'linear-gradient(135deg, #6366f1, #4338ca)'
];

function isGenericName(name) {
  if (!name || typeof name !== 'string') return true;
  const trimmed = name.trim();
  return (
    !trimmed ||
    /^(Facebook Chat|Facebook|Messenger|Đoạn chat|Danh sách đoạn chat|Chats|Chat|Cuộc trò chuyện|Nội dung cuộc trò chuyện|Tin nhắn trong cuộc trò chuyện|Thông tin về đoạn chat|Chi tiết đoạn chat|Cuộc trò chuyện đang hoạt động|Conversation|Thread|Messages)$/i.test(
      trimmed
    )
  );
}

function normalizeThreadKey(name) {
  if (!name || typeof name !== 'string') return '';
  const cleaned = name.replace(/(?:\.\.\.|…)+$/g, '').trim();
  if (!cleaned || isGenericName(cleaned)) return '';
  return cleaned;
}

function parseRecordNames(item) {
  let person = !isGenericName(item.personName) ? String(item.personName).trim() : '';
  let thread = !isGenericName(item.threadName) ? String(item.threadName).trim() : '';
  const rawSender = String(item.senderName || '').trim();

  if (rawSender.includes('•')) {
    const parts = rawSender
      .split('•')
      .map((s) => s.trim())
      .filter((s) => s && !isGenericName(s));
    if (!person && parts[0]) person = parts[0];
    if (!thread && parts[1]) thread = parts[1];
  } else if (!person && !isGenericName(rawSender)) {
    person = rawSender;
  }

  const isSelf = Boolean(item.isSelf) || /^(Bạn|You|Chính bạn)$/i.test(person);
  if (!person) {
    person = isSelf ? 'Bạn' : thread || 'Người dùng Facebook';
  }

  return { person, thread, isSelf };
}

function getAvatarGradient(name) {
  const str = String(name || 'F');
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_GRADIENTS[Math.abs(hash) % AVATAR_GRADIENTS.length];
}

function getInitials(name) {
  const clean = String(name || 'F').trim();
  if (!clean) return 'F';
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return clean.slice(0, 2).toUpperCase();
}

function formatExactTime(ts) {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} • ${pad(
      d.getDate()
    )}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
  } catch (_) {
    return '';
  }
}

function formatRelativeTime(ts) {
  if (!ts) return 'Vừa xong';
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 45) return 'Vừa xong';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} phút trước`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour} giờ trước`;
  const diffDay = Math.floor(diffHour / 24);
  return `${diffDay} ngày trước`;
}

function showStatusBanner(message, isError = false) {
  if (!statusBannerEl) return;
  if (bannerTimeout) clearTimeout(bannerTimeout);
  statusBannerEl.textContent = message;
  statusBannerEl.classList.toggle('error', Boolean(isError));
  statusBannerEl.hidden = false;
  bannerTimeout = setTimeout(() => {
    statusBannerEl.hidden = true;
  }, 4200);
}

function openLightbox(url) {
  if (!url || !lightboxModalEl) return;
  lightboxImgEl.src = url;
  lightboxDownloadEl.href = url;
  lightboxDownloadEl.download = `fb-unsent-${Date.now()}.webp`;
  lightboxModalEl.hidden = false;
}

function closeLightbox() {
  if (!lightboxModalEl) return;
  lightboxModalEl.hidden = true;
  lightboxImgEl.src = '';
}

function updateStatsAndThreadOptions() {
  const total = allUnsentMessages.length;
  let othersCount = 0;
  let mediaCount = 0;

  const threadGroups = [];

  allUnsentMessages.forEach((item) => {
    const { thread, isSelf } = parseRecordNames(item);
    if (!isSelf) othersCount++;
    if (Array.isArray(item.attachments) && item.attachments.length > 0) mediaCount++;

    const norm = normalizeThreadKey(thread).toLowerCase();
    if (!norm) return;

    const existingGroup = threadGroups.find(
      (g) => g.key === norm || (g.key.length >= 4 && norm.length >= 4 && (g.key.includes(norm) || norm.includes(g.key)))
    );
    if (existingGroup) {
      existingGroup.count++;
      if (normalizeThreadKey(thread).length > normalizeThreadKey(existingGroup.label).length) {
        existingGroup.label = thread;
        existingGroup.key = norm;
      }
    } else {
      threadGroups.push({
        key: norm,
        label: thread,
        count: 1
      });
    }
  });

  statTotalEl.textContent = String(total);
  statOthersEl.textContent = String(othersCount);
  statMediaEl.textContent = String(mediaCount);
  statCachedEl.textContent = String(allCapturedMessages.length);

  const previousValue = threadFilterEl.value;
  threadFilterEl.innerHTML = '';

  const allOpt = document.createElement('option');
  allOpt.value = 'ALL';
  allOpt.textContent = `Tất cả cuộc trò chuyện (${total})`;
  threadFilterEl.appendChild(allOpt);

  threadGroups.forEach((g) => {
    const opt = document.createElement('option');
    opt.value = g.key;
    opt.textContent = `${g.label} (${g.count})`;
    threadFilterEl.appendChild(opt);
  });

  if (threadGroups.some((g) => g.key === previousValue)) {
    threadFilterEl.value = previousValue;
  } else {
    threadFilterEl.value = 'ALL';
    activeThreadFilter = 'ALL';
  }
}

function matchesSelectedThread(item, selectedKey) {
  if (!selectedKey || selectedKey === 'ALL') return true;
  const { thread, person } = parseRecordNames(item);
  const normThread = normalizeThreadKey(thread).toLowerCase();
  const normPerson = normalizeThreadKey(person).toLowerCase();
  if (normThread && (normThread === selectedKey || normThread.includes(selectedKey) || selectedKey.includes(normThread))) {
    return true;
  }
  if (normPerson && normPerson === selectedKey) {
    return true;
  }
  return false;
}

function renderList() {
  const kw = (searchInputEl.value || '').trim().toLowerCase();
  clearSearchBtnEl.hidden = !kw;

  const filtered = allUnsentMessages.filter((item) => {
    const { person, thread, isSelf } = parseRecordNames(item);
    const hasMedia = Array.isArray(item.attachments) && item.attachments.length > 0;

    if (activeTabFilter === 'others' && isSelf) return false;
    if (activeTabFilter === 'self' && !isSelf) return false;
    if (activeTabFilter === 'media' && !hasMedia) return false;

    if (!matchesSelectedThread(item, activeThreadFilter)) return false;

    if (kw) {
      const hay = `${person} ${thread} ${item.senderName || ''} ${item.text || ''}`.toLowerCase();
      if (!hay.includes(kw)) return false;
    }

    return true;
  });

  unsentListEl.innerHTML = '';

  if (filtered.length === 0) {
    const emptyDiv = document.createElement('div');
    emptyDiv.className = 'empty-state';

    const icon = document.createElement('div');
    icon.className = 'empty-icon';
    icon.textContent = kw || activeTabFilter !== 'all' || activeThreadFilter !== 'ALL' ? '🔍' : '📭';

    const title = document.createElement('div');
    title.className = 'empty-title';
    title.textContent =
      kw || activeTabFilter !== 'all' || activeThreadFilter !== 'ALL'
        ? 'Không tìm thấy tin nhắn phù hợp'
        : 'Chưa có tin nhắn nào bị gỡ';

    const desc = document.createElement('div');
    desc.className = 'empty-desc';
    desc.textContent =
      kw || activeTabFilter !== 'all' || activeThreadFilter !== 'ALL'
        ? 'Hãy thử đổi từ khóa tìm kiếm hoặc chọn lại bộ lọc cuộc trò chuyện.'
        : 'Mọi tin nhắn văn bản và hình ảnh bị thu hồi trên Facebook & Messenger sẽ tự động hiển thị tại đây.';

    emptyDiv.appendChild(icon);
    emptyDiv.appendChild(title);
    emptyDiv.appendChild(desc);
    unsentListEl.appendChild(emptyDiv);
    return;
  }

  filtered.forEach((item) => {
    const { person, thread, isSelf } = parseRecordNames(item);
    const cleanAttachments = Array.isArray(item.attachments) ? item.attachments.filter(Boolean) : [];
    const ts = item.unsentAt || item.timestamp || Date.now();

    const card = document.createElement('div');
    card.className = `unsent-card${isSelf ? ' self-card' : ''}`;

    const top = document.createElement('div');
    top.className = 'card-top';

    const senderGroup = document.createElement('div');
    senderGroup.className = 'sender-group';

    const avatar = document.createElement('div');
    avatar.className = 'sender-avatar';
    avatar.style.background = isSelf
      ? 'linear-gradient(135deg, #6366f1, #4f46e5)'
      : getAvatarGradient(person);
    avatar.textContent = getInitials(person);

    const senderMeta = document.createElement('div');
    senderMeta.className = 'sender-meta';

    const nameRow = document.createElement('div');
    nameRow.className = 'sender-name-row';

    const personSpan = document.createElement('span');
    personSpan.className = 'person-name';
    personSpan.textContent = person;
    personSpan.title = person;

    const rolePill = document.createElement('span');
    rolePill.className = `role-pill ${isSelf ? 'self' : 'other'}`;
    rolePill.textContent = isSelf ? 'Bạn gỡ' : 'Người khác';

    nameRow.appendChild(personSpan);
    nameRow.appendChild(rolePill);
    senderMeta.appendChild(nameRow);

    if (thread && thread.toLowerCase() !== person.toLowerCase()) {
      const threadBadge = document.createElement('div');
      threadBadge.className = 'thread-badge';
      threadBadge.textContent = `💬 ${thread}`;
      threadBadge.title = thread;
      senderMeta.appendChild(threadBadge);
    }

    senderGroup.appendChild(avatar);
    senderGroup.appendChild(senderMeta);

    const timeGroup = document.createElement('div');
    timeGroup.className = 'time-group';

    const relTime = document.createElement('span');
    relTime.className = 'relative-time';
    relTime.textContent = formatRelativeTime(ts);

    const exTime = document.createElement('span');
    exTime.className = 'exact-time';
    exTime.textContent = formatExactTime(ts);

    timeGroup.appendChild(relTime);
    timeGroup.appendChild(exTime);

    top.appendChild(senderGroup);
    top.appendChild(timeGroup);
    card.appendChild(top);

    if (item.text) {
      const bodyDiv = document.createElement('div');
      bodyDiv.className = 'card-body';
      bodyDiv.textContent = item.text;
      card.appendChild(bodyDiv);
    }

    if (cleanAttachments.length > 0) {
      const mediaDiv = document.createElement('div');
      mediaDiv.className = 'card-media';
      cleanAttachments.forEach((url) => {
        const wrap = document.createElement('div');
        wrap.className = 'media-item-wrap';

        const img = document.createElement('img');
        img.src = url;
        img.alt = 'Ảnh đính kèm';
        img.title = 'Nhấn để phóng to hoặc tải ảnh về máy';
        img.addEventListener('click', () => openLightbox(url));
        img.addEventListener('error', () => wrap.remove());

        wrap.appendChild(img);
        mediaDiv.appendChild(wrap);
      });
      card.appendChild(mediaDiv);
    }

    const footer = document.createElement('div');
    footer.className = 'card-footer';

    if (item.anchorAboveText) {
      const anchorSpan = document.createElement('span');
      anchorSpan.className = 'anchor-hint';
      anchorSpan.textContent = `↳ Sau tin: "${item.anchorAboveText}"`;
      anchorSpan.title = `Nằm ngay bên dưới tin nhắn: "${item.anchorAboveText}"`;
      footer.appendChild(anchorSpan);
    }

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'card-actions';

    if (item.text) {
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'action-btn';
      copyBtn.textContent = '📋 Sao chép';
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(item.text).then(() => {
          copyBtn.textContent = '✅ Đã chép';
          setTimeout(() => {
            copyBtn.textContent = '📋 Sao chép';
          }, 1200);
        });
      });
      actionsDiv.appendChild(copyBtn);
    }

    if (cleanAttachments.length > 0) {
      const dlBtn = document.createElement('a');
      dlBtn.href = cleanAttachments[0];
      dlBtn.download = `fb-unsent-${Date.now()}.webp`;
      dlBtn.className = 'action-btn';
      dlBtn.textContent = '⬇ Tải ảnh';
      actionsDiv.appendChild(dlBtn);
    }

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'action-btn delete';
    delBtn.textContent = '🗑 Xóa';
    delBtn.addEventListener('click', () => {
      allUnsentMessages = allUnsentMessages.filter((m) => m.messageId !== item.messageId);
      chrome.storage.local.set({ [STORAGE_KEY_UNSENT]: allUnsentMessages }, () => {
        updateStatsAndThreadOptions();
        renderList();
      });
    });
    actionsDiv.appendChild(delBtn);

    footer.appendChild(actionsDiv);
    card.appendChild(footer);
    unsentListEl.appendChild(card);
  });
}

function loadPopupData() {
  chrome.storage.local.get([STORAGE_KEY_UNSENT, STORAGE_KEY_MESSAGES], (res) => {
    allUnsentMessages = Array.isArray(res[STORAGE_KEY_UNSENT]) ? res[STORAGE_KEY_UNSENT] : [];
    allCapturedMessages = Array.isArray(res[STORAGE_KEY_MESSAGES]) ? res[STORAGE_KEY_MESSAGES] : [];
    updateStatsAndThreadOptions();
    renderList();
  });

  chrome.runtime.sendMessage({ type: 'CLEAR_UNREAD_BADGE' });
}

// ============================================================================
// XUẤT DỮ LIỆU (EXPORT BACKUP JSON) & NHẬP DỮ LIỆU (IMPORT BACKUP SMART MERGE)
// ============================================================================

function exportBackupJson() {
  chrome.storage.local.get([STORAGE_KEY_UNSENT, STORAGE_KEY_MESSAGES], (res) => {
    const unsent = Array.isArray(res[STORAGE_KEY_UNSENT]) ? res[STORAGE_KEY_UNSENT] : [];
    const captured = Array.isArray(res[STORAGE_KEY_MESSAGES]) ? res[STORAGE_KEY_MESSAGES] : [];

    if (unsent.length === 0 && captured.length === 0) {
      showStatusBanner('⚠️ Chưa có dữ liệu tin nhắn nào để xuất sao lưu!', true);
      return;
    }

    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const fileStamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(
      now.getHours()
    )}-${pad(now.getMinutes())}`;

    const backupPayload = {
      app: 'FB Unsend Message Viewer',
      schemaVersion: 4,
      exportedAt: now.toISOString(),
      unsentCount: unsent.length,
      capturedCount: captured.length,
      unsentMessages: unsent,
      capturedMessages: captured
    };

    const blob = new Blob([JSON.stringify(backupPayload, null, 2)], {
      type: 'application/json;charset=utf-8'
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `fb-unsend-backup-${fileStamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);

    showStatusBanner(`✅ Đã xuất ${unsent.length} tin bị gỡ & ${captured.length} tin lưu tạm!`);
  });
}

function isTempId(id) {
  return !id || String(id).startsWith('dom_') || String(id).startsWith('unsend_');
}

function smartMergeRecords(existingList, importedList, isUnsentCollection = true) {
  const result = Array.isArray(existingList) ? [...existingList] : [];
  let addedCount = 0;
  let mergedCount = 0;

  for (const rawItem of importedList) {
    if (!rawItem || typeof rawItem !== 'object') continue;
    const text = String(rawItem.text || '').trim();
    const attachments = Array.isArray(rawItem.attachments) ? rawItem.attachments.filter(Boolean) : [];
    if (isUnsentCollection && !text && attachments.length === 0) continue;

    const itemIsSelf = Boolean(rawItem.isSelf);
    const itemTime = rawItem.unsentAt || rawItem.timestamp || Date.now();

    const dupIdx = result.findIndex((ex) => {
      if (!ex) return false;
      if (ex.messageId && rawItem.messageId && ex.messageId === rawItem.messageId) return true;

      if (Boolean(ex.isSelf) !== itemIsSelf) return false;
      const exText = String(ex.text || '').trim();
      const sameText = text && exText === text;
      const sameMedia =
        !text &&
        !exText &&
        attachments.length > 0 &&
        Array.isArray(ex.attachments) &&
        ex.attachments.length === attachments.length;
      if (!sameText && !sameMedia) return false;

      const exTime = ex.unsentAt || ex.timestamp || 0;
      return Math.abs(exTime - itemTime) < 30000;
    });

    if (dupIdx !== -1) {
      const ex = result[dupIdx];
      const bestId = !isTempId(rawItem.messageId)
        ? rawItem.messageId
        : !isTempId(ex.messageId)
          ? ex.messageId
          : ex.messageId || rawItem.messageId;

      const mergedAttachments = Array.from(
        new Set([...(ex.attachments || []), ...attachments])
      );

      const exThread = normalizeThreadKey(ex.threadName);
      const impThread = normalizeThreadKey(rawItem.threadName);
      const bestThread = impThread.length > exThread.length ? rawItem.threadName : ex.threadName || rawItem.threadName || '';

      result[dupIdx] = {
        ...ex,
        ...rawItem,
        messageId: bestId,
        isSelf: itemIsSelf,
        text: ex.text || text,
        attachments: mergedAttachments,
        threadName: bestThread,
        timestamp:
          ex.timestamp && rawItem.timestamp
            ? Math.min(ex.timestamp, rawItem.timestamp)
            : ex.timestamp || rawItem.timestamp || Date.now(),
        unsentAt: ex.unsentAt || rawItem.unsentAt || Date.now()
      };
      mergedCount++;
    } else {
      result.push({
        ...rawItem,
        messageId: rawItem.messageId || `import_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        isSelf: itemIsSelf,
        text,
        attachments,
        timestamp: rawItem.timestamp || Date.now(),
        ...(isUnsentCollection ? { unsentAt: rawItem.unsentAt || rawItem.timestamp || Date.now(), isUnsent: true } : {})
      });
      addedCount++;
    }
  }

  if (isUnsentCollection) {
    result.sort((a, b) => (b.unsentAt || b.timestamp || 0) - (a.unsentAt || a.timestamp || 0));
  } else {
    result.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  }

  return { result, addedCount, mergedCount };
}

function handleImportFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const parsed = JSON.parse(String(e.target?.result || ''));
      let importedUnsent = [];
      let importedCaptured = [];

      if (Array.isArray(parsed)) {
        importedUnsent = parsed;
      } else if (parsed && typeof parsed === 'object') {
        if (Array.isArray(parsed.unsentMessages)) {
          importedUnsent = parsed.unsentMessages;
        } else if (Array.isArray(parsed[STORAGE_KEY_UNSENT])) {
          importedUnsent = parsed[STORAGE_KEY_UNSENT];
        }
        if (Array.isArray(parsed.capturedMessages)) {
          importedCaptured = parsed.capturedMessages;
        } else if (Array.isArray(parsed[STORAGE_KEY_MESSAGES])) {
          importedCaptured = parsed[STORAGE_KEY_MESSAGES];
        }
      }

      if (importedUnsent.length === 0 && importedCaptured.length === 0) {
        showStatusBanner('⚠️ Tệp JSON không chứa dữ liệu tin nhắn hợp lệ!', true);
        return;
      }

      chrome.storage.local.get([STORAGE_KEY_UNSENT, STORAGE_KEY_MESSAGES], (res) => {
        const currentUnsent = Array.isArray(res[STORAGE_KEY_UNSENT]) ? res[STORAGE_KEY_UNSENT] : [];
        const currentCaptured = Array.isArray(res[STORAGE_KEY_MESSAGES]) ? res[STORAGE_KEY_MESSAGES] : [];

        const unsentMerge = smartMergeRecords(currentUnsent, importedUnsent, true);
        const capturedMerge = smartMergeRecords(currentCaptured, importedCaptured, false);

        chrome.storage.local.set(
          {
            [STORAGE_KEY_UNSENT]: unsentMerge.result,
            [STORAGE_KEY_MESSAGES]: capturedMerge.result.slice(-2000),
            [STORAGE_KEY_CLEANED_FLAG]: true
          },
          () => {
            loadPopupData();
            showStatusBanner(
              `✅ Đã nhập thêm ${unsentMerge.addedCount} tin mới (hợp nhất ${unsentMerge.mergedCount} tin trùng)!`
            );
          }
        );
      });
    } catch (_) {
      showStatusBanner('❌ Không thể đọc tệp JSON. Vui lòng kiểm tra lại định dạng tệp!', true);
    }
  };
  reader.readAsText(file, 'utf-8');
}

// ============================================================================
// SỰ KIỆN GIAO DIỆN
// ============================================================================

searchInputEl.addEventListener('input', () => {
  renderList();
});

clearSearchBtnEl.addEventListener('click', () => {
  searchInputEl.value = '';
  searchInputEl.focus();
  renderList();
});

threadFilterEl.addEventListener('change', () => {
  activeThreadFilter = threadFilterEl.value;
  renderList();
});

filterTabsEl.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    filterTabsEl.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    activeTabFilter = btn.dataset.filter || 'all';
    renderList();
  });
});

exportBtnEl.addEventListener('click', exportBackupJson);

importBtnEl.addEventListener('click', () => {
  importFileInputEl.value = '';
  importFileInputEl.click();
});

importFileInputEl.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (file) {
    handleImportFile(file);
  }
});

clearAllBtnEl.addEventListener('click', () => {
  if (allUnsentMessages.length === 0) {
    showStatusBanner('Danh sách tin nhắn bị gỡ đang trống.');
    return;
  }

  if (!clearAllBtnEl.classList.contains('confirming')) {
    clearAllBtnEl.classList.add('confirming');
    clearAllBtnEl.innerHTML = '<span>⚠️</span> Xác nhận?';
    if (clearConfirmTimeout) clearTimeout(clearConfirmTimeout);
    clearConfirmTimeout = setTimeout(() => {
      clearAllBtnEl.classList.remove('confirming');
      clearAllBtnEl.innerHTML = '<span>🗑</span> Xóa hết';
    }, 3000);
    return;
  }

  if (clearConfirmTimeout) clearTimeout(clearConfirmTimeout);
  clearAllBtnEl.classList.remove('confirming');
  clearAllBtnEl.innerHTML = '<span>🗑</span> Xóa hết';

  allUnsentMessages = [];
  chrome.storage.local.set({ [STORAGE_KEY_UNSENT]: [] }, () => {
    updateStatsAndThreadOptions();
    renderList();
    showStatusBanner('🗑 Đã xóa toàn bộ lịch sử tin nhắn bị gỡ.');
  });
});

lightboxCloseEl.addEventListener('click', closeLightbox);
lightboxModalEl.addEventListener('click', (e) => {
  if (e.target === lightboxModalEl) {
    closeLightbox();
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && (changes[STORAGE_KEY_UNSENT] || changes[STORAGE_KEY_MESSAGES])) {
    loadPopupData();
  }
});

loadPopupData();

