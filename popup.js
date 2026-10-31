// popup.js - Quản lý giao diện lịch sử tin nhắn thu hồi, bộ lọc, Xuất/Nhập Backup (JSON) và Lightbox

// ===== Hằng số =====
const STORAGE_KEY_MESSAGES = 'fb_captured_messages_v2';
const STORAGE_KEY_UNSENT = 'fb_unsent_messages_v2';
const STORAGE_KEY_CLEANED_FLAG = 'fb_unsend_schema_v4_cleaned';
const STORAGE_KEY_TOAST_ENABLED = 'fb_unsend_toast_enabled';
const STATUS_HIDE_MS = 3600;
const COPY_FEEDBACK_MS = 1200;
const CARD_REMOVE_ANIM_MS = 180;

// Màu nền avatar chữ cái — tông phẳng giống avatar mặc định của Facebook
const AVATAR_COLORS = ['#e4405f', '#8b5cf6', '#0ea5e9', '#10b981', '#f59e0b', '#ec4899', '#14b8a6'];
const SELF_AVATAR_COLOR = '#0866ff';

const WEEKDAY_NAMES = ['Chủ nhật', 'Thứ hai', 'Thứ ba', 'Thứ tư', 'Thứ năm', 'Thứ sáu', 'Thứ bảy'];

// ===== State =====
const appState = {
  unsentMessages: [],
  capturedMessages: [],
  tabFilter: 'all', // 'all' | 'others' | 'self' | 'media'
  threadFilter: 'ALL',
  statusTimer: null
};

const dom = {};

function cacheDom() {
  dom.unsentList = document.getElementById('unsent-list');
  dom.searchInput = document.getElementById('search-input');
  dom.clearSearchBtn = document.getElementById('clear-search-btn');
  dom.threadFilter = document.getElementById('thread-filter');
  dom.filterTabs = document.getElementById('filter-tabs');
  dom.tabButtons = dom.filterTabs.querySelectorAll('.tab-btn');
  dom.tabCounts = dom.filterTabs.querySelectorAll('.tab-count');

  dom.exportBtn = document.getElementById('export-btn');
  dom.importBtn = document.getElementById('import-btn');
  dom.importFileInput = document.getElementById('import-file-input');
  dom.clearAllBtn = document.getElementById('clear-all-btn');
  dom.toastToggle = document.getElementById('toast-toggle');

  dom.confirmModal = document.getElementById('confirm-modal');
  dom.confirmDesc = document.getElementById('confirm-desc');
  dom.confirmCancel = document.getElementById('confirm-cancel');
  dom.confirmOk = document.getElementById('confirm-ok');

  dom.footerInfo = document.getElementById('footer-info');
  dom.versionTag = document.getElementById('version-tag');

  dom.statusToast = document.getElementById('status-toast');
  dom.statusIconUse = dom.statusToast.querySelector('.status-icon use');
  dom.statusText = dom.statusToast.querySelector('.status-text');

  dom.lightbox = document.getElementById('lightbox-modal');
  dom.lightboxImg = document.getElementById('lightbox-img');
  dom.lightboxDownload = document.getElementById('lightbox-download');
  dom.lightboxClose = document.getElementById('lightbox-close');
}

function cloneTemplate(id) {
  const template = document.getElementById(id);
  if (!template) throw new Error('Missing template: ' + id);
  return template.content.firstElementChild.cloneNode(true);
}

// ===== Chuẩn hóa tên người gửi / đoạn chat =====
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
      .map(s => s.trim())
      .filter(s => s && !isGenericName(s));
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

function getRecordAttachments(item) {
  return Array.isArray(item.attachments) ? item.attachments.filter(Boolean) : [];
}

function getRecordTime(item) {
  return item.unsentAt || item.timestamp || Date.now();
}

// ── Avatar ──
function getAvatarColor(name) {
  const str = String(name || 'F');
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
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

// ── Thời gian ──
function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatExactTime(ts) {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())} • ${pad2(d.getDate())}/${pad2(
      d.getMonth() + 1
    )}/${d.getFullYear()}`;
  } catch (_) {
    return '';
  }
}

function getDayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function formatDayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);

  if (getDayKey(ts) === getDayKey(today.getTime())) return 'Hôm nay';
  if (getDayKey(ts) === getDayKey(yesterday.getTime())) return 'Hôm qua';
  return `${WEEKDAY_NAMES[d.getDay()]}, ${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
}

// Hôm nay & dưới 1 giờ thì hiện "x phút trước", còn lại hiện giờ:phút (ngày đã có ở nhãn nhóm)
function formatCardTime(ts) {
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 45) return 'Vừa xong';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60 && getDayKey(ts) === getDayKey(Date.now())) return `${diffMin} phút trước`;
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// ===== Thông báo nổi & Lightbox =====
function showStatus(message, isError = false) {
  if (appState.statusTimer) clearTimeout(appState.statusTimer);

  dom.statusText.textContent = message;
  dom.statusToast.classList.toggle('error', Boolean(isError));
  dom.statusIconUse.setAttribute('href', isError ? '#i-alert' : '#i-check');

  // Ẩn rồi hiện lại để animation chạy lại khi có thông báo mới liên tiếp
  dom.statusToast.hidden = true;
  void dom.statusToast.offsetWidth;
  dom.statusToast.hidden = false;

  appState.statusTimer = setTimeout(function () {
    dom.statusToast.hidden = true;
  }, STATUS_HIDE_MS);
}

function isAttachmentFilenameText(text) {
  if (!text || typeof text !== 'string') return false;
  return /^(audioclip|videoclip|voiceclip|audio_clip|video_clip|image|video|audio|file|sticker|gif|attachment)[_-][0-9a-f_-]+(\.[a-z0-9]+)?$/i.test(
    text.trim()
  );
}

function getAttachmentMediaType(url) {
  if (!url || typeof url !== 'string') return 'image';
  const clean = url.trim();
  if (
    clean.startsWith('data:audio/') ||
    /(\.ogg|\.mp3|\.wav|\.m4a|\.aac|\.opus|\.flac)(\?|#|$)/i.test(clean) ||
    /(audioclip|audio_clip|voice_clip|\/t59\.3654-21\/|mime=audio)/i.test(clean)
  ) {
    return 'audio';
  }
  if (
    clean.startsWith('data:video/') ||
    /(\.mp4|\.webm|\.mov|\.m4v|\.ogv)(\?|#|$)/i.test(clean) ||
    /(videoclip|video_clip|\/t42\.|https?:\/\/video[a-z0-9.-]*\.fbcdn\.net|mime=video)/i.test(clean)
  ) {
    return 'video';
  }
  return 'image';
}

function applyDownloadLink(linkEl, url) {
  const mediaType = getAttachmentMediaType(url);
  const ext = mediaType === 'audio' ? 'ogg' : mediaType === 'video' ? 'mp4' : 'webp';
  linkEl.href = url;
  linkEl.download = `fb-unsent-${Date.now()}.${ext}`;
  if (mediaType === 'audio') {
    linkEl.title = 'Tải âm thanh về máy';
  } else if (mediaType === 'video') {
    linkEl.title = 'Tải video về máy';
  } else {
    linkEl.title = 'Tải ảnh về máy';
  }
  // Link ngoài (CDN Facebook) không tải được bằng thuộc tính download → mở tab mới thay vì điều hướng popup
  if (!url.startsWith('data:')) {
    linkEl.target = '_blank';
    linkEl.rel = 'noopener noreferrer';
  } else {
    linkEl.removeAttribute('target');
    linkEl.removeAttribute('rel');
  }
}

function openLightbox(url) {
  if (!url) return;
  dom.lightboxImg.src = url;
  applyDownloadLink(dom.lightboxDownload, url);
  dom.lightbox.hidden = false;
}

function closeLightbox() {
  dom.lightbox.hidden = true;
  dom.lightboxImg.src = '';
}

// ===== Thống kê & danh sách đoạn chat =====
function updateThreadOptions() {
  const threadGroups = [];

  appState.unsentMessages.forEach(item => {
    const { thread } = parseRecordNames(item);
    const norm = normalizeThreadKey(thread).toLowerCase();
    if (!norm) return;

    const existingGroup = threadGroups.find(
      g => g.key === norm || (g.key.length >= 4 && norm.length >= 4 && (g.key.includes(norm) || norm.includes(g.key)))
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

  const previousValue = dom.threadFilter.value;
  dom.threadFilter.replaceChildren();
  dom.threadFilter.appendChild(new Option('Mọi đoạn chat', 'ALL'));
  threadGroups.forEach(g => {
    dom.threadFilter.appendChild(new Option(`${g.label} (${g.count})`, g.key));
  });

  if (threadGroups.some(g => g.key === previousValue)) {
    dom.threadFilter.value = previousValue;
  } else {
    dom.threadFilter.value = 'ALL';
    appState.threadFilter = 'ALL';
  }

  dom.footerInfo.textContent = `Lưu tạm ${appState.capturedMessages.length.toLocaleString('vi-VN')} tin để đối chiếu`;
}

// Số đếm trên tab tính theo đoạn chat + từ khóa đang chọn
function updateTabCounts(baseItems) {
  const counts = { all: baseItems.length, others: 0, self: 0, media: 0 };
  baseItems.forEach(item => {
    if (parseRecordNames(item).isSelf) counts.self++;
    else counts.others++;
    if (getRecordAttachments(item).length > 0) counts.media++;
  });

  dom.tabCounts.forEach(el => {
    const value = counts[el.dataset.count] || 0;
    el.textContent = String(value);
    el.classList.toggle('is-zero', value === 0);
  });
}

// ===== Lọc =====
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

function matchesKeyword(item, keyword) {
  if (!keyword) return true;
  const { person, thread } = parseRecordNames(item);
  const hay = `${person} ${thread} ${item.senderName || ''} ${item.text || ''}`.toLowerCase();
  return hay.includes(keyword);
}

function matchesTabFilter(item, tabFilter) {
  const { isSelf } = parseRecordNames(item);
  if (tabFilter === 'others') return !isSelf;
  if (tabFilter === 'self') return isSelf;
  if (tabFilter === 'media') return getRecordAttachments(item).length > 0;
  return true;
}

// ===== Render =====
function buildEmptyState(isFiltering) {
  const empty = cloneTemplate('emptyStateTemplate');
  empty.querySelector('.empty-icon use').setAttribute('href', isFiltering ? '#i-search' : '#i-inbox');
  empty.querySelector('.empty-title').textContent = isFiltering
    ? 'Không tìm thấy tin nhắn phù hợp'
    : 'Chưa có tin nhắn nào bị gỡ';
  empty.querySelector('.empty-desc').textContent = isFiltering
    ? 'Thử đổi từ khóa hoặc chọn lại bộ lọc đoạn chat.'
    : 'Tin nhắn văn bản và hình ảnh bị thu hồi trên Facebook & Messenger sẽ tự động hiện ở đây.';
  return empty;
}

function buildMediaThumb(url) {
  const thumb = cloneTemplate('mediaThumbTemplate');
  const img = thumb.querySelector('img');
  img.src = url;
  img.addEventListener('error', function () {
    thumb.remove();
  });
  thumb.addEventListener('click', function () {
    openLightbox(url);
  });
  return thumb;
}

function buildMediaItem(url) {
  const mediaType = getAttachmentMediaType(url);
  if (mediaType === 'audio') {
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.preload = 'metadata';
    audio.src = url;
    audio.className = 'media-audio';
    return audio;
  }
  if (mediaType === 'video') {
    const video = document.createElement('video');
    video.controls = true;
    video.preload = 'metadata';
    video.playsInline = true;
    video.src = url;
    video.className = 'media-video';
    return video;
  }
  return buildMediaThumb(url);
}

function findBestAvatarForItem(item, person, isSelf) {
  if (item.avatarUrl && typeof item.avatarUrl === 'string' && /^https?:\/\//i.test(item.avatarUrl)) {
    return item.avatarUrl.trim();
  }
  const cleanPerson = (person || '').trim().toLowerCase();
  const senderId = item.senderId ? String(item.senderId) : '';
  const pools = [appState.unsentMessages, appState.capturedMessages];
  for (const list of pools) {
    if (!Array.isArray(list)) continue;
    for (const cand of list) {
      if (!cand || !cand.avatarUrl || !/^https?:\/\//i.test(cand.avatarUrl)) continue;
      if (senderId && cand.senderId && String(cand.senderId) === senderId) {
        return cand.avatarUrl.trim();
      }
      const candNames = parseRecordNames(cand);
      if (isSelf && candNames.isSelf) {
        return cand.avatarUrl.trim();
      }
      if (cleanPerson && candNames.person && candNames.person.toLowerCase() === cleanPerson) {
        return cand.avatarUrl.trim();
      }
    }
  }
  return '';
}

function buildMessageCard(item, ts) {
  const { person, thread, isSelf } = parseRecordNames(item);
  const attachments = getRecordAttachments(item);
  const displayText =
    item.text && !(isAttachmentFilenameText(item.text) && attachments.length > 0)
      ? item.text
      : '';
  const card = cloneTemplate('messageCardTemplate');
  card.classList.toggle('is-self', isSelf);

  // ── Người gửi ──
  const avatar = card.querySelector('.msg-avatar');
  const fallbackBg = isSelf ? SELF_AVATAR_COLOR : getAvatarColor(person);
  const fallbackText = isSelf ? 'Bạn' : getInitials(person);
  avatar.style.background = fallbackBg;
  avatar.textContent = fallbackText;

  const avatarUrl = findBestAvatarForItem(item, person, isSelf);
  if (avatarUrl) {
    const avatarImg = document.createElement('img');
    avatarImg.className = 'msg-avatar-img';
    avatarImg.src = avatarUrl;
    avatarImg.alt = person;
    avatarImg.referrerPolicy = 'no-referrer';
    avatarImg.addEventListener('error', function () {
      avatarImg.remove();
      avatar.classList.remove('has-img');
      avatar.textContent = fallbackText;
    });
    avatar.textContent = '';
    avatar.classList.add('has-img');
    avatar.appendChild(avatarImg);
  }

  const nameEl = card.querySelector('.msg-name');
  nameEl.textContent = person;
  nameEl.title = person;

  // Chỉ gắn nhãn khi chính bạn gỡ; tin người khác gỡ là trường hợp mặc định nên không cần nhãn
  if (isSelf) {
    const roleEl = card.querySelector('.msg-role');
    roleEl.classList.add('self');
    roleEl.textContent = 'Bạn gỡ';
    roleEl.hidden = false;
  }

  const timeEl = card.querySelector('.msg-time');
  timeEl.textContent = formatCardTime(ts);
  timeEl.title = `Gỡ lúc ${formatExactTime(ts)}`;
  timeEl.dateTime = new Date(ts).toISOString();

  if (thread && thread.toLowerCase() !== person.toLowerCase()) {
    const threadEl = card.querySelector('.msg-thread');
    threadEl.querySelector('.msg-thread-name').textContent = thread;
    threadEl.title = thread;
    threadEl.hidden = false;
  }

  // ── Nội dung ──
  if (item.anchorAboveText) {
    const anchorEl = card.querySelector('.msg-anchor');
    anchorEl.querySelector('.msg-anchor-text').textContent = `Sau tin: "${item.anchorAboveText}"`;
    anchorEl.title = `Nằm ngay bên dưới tin nhắn: "${item.anchorAboveText}"`;
    anchorEl.hidden = false;
  }

  if (displayText) {
    const bubbleEl = card.querySelector('.msg-bubble');
    bubbleEl.textContent = displayText;
    bubbleEl.hidden = false;
  }

  if (attachments.length > 0) {
    const mediaEl = card.querySelector('.msg-media');
    attachments.forEach(url => mediaEl.appendChild(buildMediaItem(url)));
    mediaEl.hidden = false;
  }

  // ── Thao tác ──
  const copyBtn = card.querySelector('[data-action="copy"]');
  if (displayText) {
    copyBtn.hidden = false;
    copyBtn.addEventListener('click', function () {
      navigator.clipboard.writeText(displayText).then(function () {
        const iconUse = copyBtn.querySelector('use');
        iconUse.setAttribute('href', '#i-check');
        copyBtn.classList.add('done');
        showStatus('Đã sao chép nội dung tin nhắn');
        setTimeout(function () {
          iconUse.setAttribute('href', '#i-copy');
          copyBtn.classList.remove('done');
        }, COPY_FEEDBACK_MS);
      });
    });
  }

  if (attachments.length > 0) {
    const downloadBtn = card.querySelector('[data-action="download"]');
    applyDownloadLink(downloadBtn, attachments[0]);
    downloadBtn.hidden = false;
  }

  card.querySelector('[data-action="delete"]').addEventListener('click', function () {
    card.classList.add('removing');
    setTimeout(function () {
      removeUnsentMessage(item.messageId);
    }, CARD_REMOVE_ANIM_MS);
  });

  return card;
}

function renderList() {
  const keyword = (dom.searchInput.value || '').trim().toLowerCase();
  dom.clearSearchBtn.hidden = !keyword;

  const baseItems = appState.unsentMessages.filter(
    item => matchesSelectedThread(item, appState.threadFilter) && matchesKeyword(item, keyword)
  );
  updateTabCounts(baseItems);

  const visibleItems = baseItems
    .filter(item => matchesTabFilter(item, appState.tabFilter))
    .sort((a, b) => getRecordTime(b) - getRecordTime(a));

  dom.unsentList.replaceChildren();

  if (visibleItems.length === 0) {
    const isFiltering = Boolean(keyword) || appState.tabFilter !== 'all' || appState.threadFilter !== 'ALL';
    dom.unsentList.appendChild(buildEmptyState(isFiltering));
    return;
  }

  // Gom tin theo ngày: mỗi ngày một thẻ, tin nhắn nằm trong .day-items
  const fragment = document.createDocumentFragment();
  let lastDayKey = '';
  let dayItems = null;
  visibleItems.forEach(item => {
    const ts = getRecordTime(item);
    const dayKey = getDayKey(ts);
    if (dayKey !== lastDayKey) {
      const dayGroup = cloneTemplate('dayGroupTemplate');
      dayGroup.querySelector('.day-label').textContent = formatDayLabel(ts);
      dayItems = dayGroup.querySelector('.day-items');
      fragment.appendChild(dayGroup);
      lastDayKey = dayKey;
    }
    dayItems.appendChild(buildMessageCard(item, ts));
  });
  dom.unsentList.appendChild(fragment);
}

function refreshView() {
  updateThreadOptions();
  renderList();
}

function removeUnsentMessage(messageId) {
  appState.unsentMessages = appState.unsentMessages.filter(m => m.messageId !== messageId);
  chrome.storage.local.set({ [STORAGE_KEY_UNSENT]: appState.unsentMessages }, refreshView);
}

function loadPopupData() {
  chrome.storage.local.get([STORAGE_KEY_UNSENT, STORAGE_KEY_MESSAGES, STORAGE_KEY_TOAST_ENABLED], function (res) {
    appState.unsentMessages = Array.isArray(res[STORAGE_KEY_UNSENT]) ? res[STORAGE_KEY_UNSENT] : [];
    appState.capturedMessages = Array.isArray(res[STORAGE_KEY_MESSAGES]) ? res[STORAGE_KEY_MESSAGES] : [];
    // Chưa từng lưu thì coi như đang bật
    dom.toastToggle.checked = res[STORAGE_KEY_TOAST_ENABLED] !== false;
    refreshView();
  });

  chrome.runtime.sendMessage({ type: 'CLEAR_UNREAD_BADGE' });
}

// ============================================================================
// XUẤT DỮ LIỆU (EXPORT BACKUP JSON) & NHẬP DỮ LIỆU (IMPORT BACKUP SMART MERGE)
// ============================================================================

function exportBackupJson() {
  chrome.storage.local.get([STORAGE_KEY_UNSENT, STORAGE_KEY_MESSAGES], function (res) {
    const unsent = Array.isArray(res[STORAGE_KEY_UNSENT]) ? res[STORAGE_KEY_UNSENT] : [];
    const captured = Array.isArray(res[STORAGE_KEY_MESSAGES]) ? res[STORAGE_KEY_MESSAGES] : [];

    if (unsent.length === 0 && captured.length === 0) {
      showStatus('Chưa có dữ liệu tin nhắn nào để xuất', true);
      return;
    }

    const now = new Date();
    const fileStamp = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}_${pad2(
      now.getHours()
    )}-${pad2(now.getMinutes())}`;

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
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 1500);

    showStatus(`Đã xuất ${unsent.length} tin bị gỡ & ${captured.length} tin lưu tạm`);
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

    const dupIdx = result.findIndex(ex => {
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

      const mergedAttachments = Array.from(new Set([...(ex.attachments || []), ...attachments]));

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
  reader.onload = function (e) {
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
        showStatus('Tệp JSON không chứa dữ liệu tin nhắn hợp lệ', true);
        return;
      }

      chrome.storage.local.get([STORAGE_KEY_UNSENT, STORAGE_KEY_MESSAGES], function (res) {
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
          function () {
            loadPopupData();
            showStatus(`Đã nhập ${unsentMerge.addedCount} tin mới, hợp nhất ${unsentMerge.mergedCount} tin trùng`);
          }
        );
      });
    } catch (_) {
      showStatus('Không đọc được tệp JSON, kiểm tra lại định dạng', true);
    }
  };
  reader.readAsText(file, 'utf-8');
}

// ============================================================================
// SỰ KIỆN GIAO DIỆN
// ============================================================================

// ── Hộp thoại xác nhận xóa toàn bộ ──
function openConfirmModal() {
  const count = appState.unsentMessages.length.toLocaleString('vi-VN');
  const strong = document.createElement('strong');
  strong.textContent = `${count} tin nhắn đã gỡ`;
  dom.confirmDesc.replaceChildren(
    'Toàn bộ ',
    strong,
    ' sẽ bị xóa vĩnh viễn và không thể khôi phục. Nên xuất bản sao lưu trước nếu cần.'
  );
  dom.confirmModal.hidden = false;
  // Mặc định focus vào "Hủy" để lỡ nhấn Enter cũng không xóa nhầm
  dom.confirmCancel.focus();
}

function closeConfirmModal() {
  dom.confirmModal.hidden = true;
  dom.clearAllBtn.focus();
}

function handleClearAllClick() {
  if (appState.unsentMessages.length === 0) {
    showStatus('Danh sách tin nhắn bị gỡ đang trống');
    return;
  }
  openConfirmModal();
}

function clearAllUnsentMessages() {
  dom.confirmModal.hidden = true;
  appState.unsentMessages = [];
  chrome.storage.local.set({ [STORAGE_KEY_UNSENT]: [] }, function () {
    refreshView();
    showStatus('Đã xóa toàn bộ lịch sử tin nhắn bị gỡ');
  });
}

function bindEvents() {
  dom.searchInput.addEventListener('input', renderList);

  dom.clearSearchBtn.addEventListener('click', function (e) {
    e.preventDefault();
    dom.searchInput.value = '';
    dom.searchInput.focus();
    renderList();
  });

  dom.threadFilter.addEventListener('change', function () {
    appState.threadFilter = dom.threadFilter.value;
    renderList();
  });

  dom.tabButtons.forEach(btn => {
    btn.addEventListener('click', function () {
      dom.tabButtons.forEach(b => b.classList.toggle('active', b === btn));
      appState.tabFilter = btn.dataset.filter || 'all';
      renderList();
    });
  });

  dom.exportBtn.addEventListener('click', exportBackupJson);

  dom.importBtn.addEventListener('click', function () {
    dom.importFileInput.value = '';
    dom.importFileInput.click();
  });

  dom.importFileInput.addEventListener('change', function (e) {
    const file = e.target.files?.[0];
    if (file) {
      handleImportFile(file);
    }
  });

  dom.clearAllBtn.addEventListener('click', handleClearAllClick);
  dom.confirmCancel.addEventListener('click', closeConfirmModal);
  dom.confirmOk.addEventListener('click', clearAllUnsentMessages);
  dom.confirmModal.addEventListener('click', function (e) {
    if (e.target === dom.confirmModal) {
      closeConfirmModal();
    }
  });

  dom.toastToggle.addEventListener('change', function () {
    const enabled = dom.toastToggle.checked;
    chrome.storage.local.set({ [STORAGE_KEY_TOAST_ENABLED]: enabled }, function () {
      showStatus(enabled ? 'Đã bật thông báo ở góc màn hình' : 'Đã tắt thông báo ở góc màn hình');
    });
  });

  dom.lightboxClose.addEventListener('click', closeLightbox);
  dom.lightbox.addEventListener('click', function (e) {
    if (e.target === dom.lightbox) {
      closeLightbox();
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (!dom.confirmModal.hidden) {
      e.preventDefault();
      closeConfirmModal();
    } else if (!dom.lightbox.hidden) {
      e.preventDefault();
      closeLightbox();
    }
  });

  chrome.storage.onChanged.addListener(function (changes, areaName) {
    if (areaName === 'local' && (changes[STORAGE_KEY_UNSENT] || changes[STORAGE_KEY_MESSAGES])) {
      loadPopupData();
    }
  });
}

function init() {
  cacheDom();
  try {
    dom.versionTag.textContent = `v${chrome.runtime.getManifest().version}`;
  } catch (_) {}
  bindEvents();
  loadPopupData();
}

init();
