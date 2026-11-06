/**
 * FB Unsend Message Viewer — popup.js
 * Copyright (c) 2026 binhake (https://github.com/binhake/fb-unsend-viewer)
 * Licensed under the Non-Commercial & Strict Attribution License.
 * Removing author attribution ("binhake") or unauthorized commercial use is strictly prohibited.
 */
// popup.js - Quản lý giao diện lịch sử tin nhắn thu hồi, bộ lọc, Xuất/Nhập Backup (JSON) và Lightbox

// ===== Hằng số =====
const STORAGE_KEY_MESSAGES = 'fb_captured_messages_v2';
const STORAGE_KEY_UNSENT = 'fb_unsent_messages_v2';
const STORAGE_KEY_CLEANED_FLAG = 'fb_unsend_schema_v4_cleaned';
const STORAGE_KEY_TOAST_ENABLED = 'fb_unsend_toast_enabled';
const STORAGE_KEY_UPDATE_INFO = 'fb_unsend_update_info_v1';
const GITHUB_RELEASES_PAGE_URL = 'https://github.com/binhake/fb-unsend-viewer/releases';
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
  statusTimer: null,
  lastRenderSignature: ''
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
  dom.debugBtn = document.getElementById('debug-btn');

  dom.updateBanner = document.getElementById('update-banner');
  dom.updateBannerTitle = document.getElementById('update-banner-title');
  dom.updateReleaseLink = document.getElementById('update-release-link');
  dom.updateDismissBtn = document.getElementById('update-dismiss-btn');

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

function isDashMpdXmlString(text) {
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();
  return (
    /^<\?xml\b/i.test(trimmed) ||
    /^<MPD\b/i.test(trimmed) ||
    trimmed.includes('urn:mpeg:dash:schema:mpd')
  );
}

function extractDashMpdVideoUrl(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!isDashMpdXmlString(trimmed) || !trimmed.includes('<BaseURL>')) return null;

  let bestVideoUrl = null;
  let bestBandwidth = -1;
  let fallbackUrl = null;

  const repRegex = /<Representation\b([^>]*)>[\s\S]*?<BaseURL>([\s\S]*?)<\/BaseURL>/gi;
  let match;
  while ((match = repRegex.exec(trimmed)) !== null) {
    const attrs = match[1] || '';
    const rawUrl = (match[2] || '').trim().replace(/&amp;/g, '&');
    if (!/^https?:\/\//i.test(rawUrl)) continue;
    if (!fallbackUrl) fallbackUrl = rawUrl;

    const isAudio = /mimeType=["']audio\//i.test(attrs);
    const isVideo = /mimeType=["']video\//i.test(attrs) || !isAudio;
    if (isVideo) {
      const bwMatch = attrs.match(/bandwidth=["'](\d+)["']/i);
      const bw = bwMatch ? parseInt(bwMatch[1], 10) : 0;
      if (bw >= bestBandwidth) {
        bestBandwidth = bw;
        bestVideoUrl = rawUrl;
      }
    }
  }

  if (bestVideoUrl) return bestVideoUrl;
  if (fallbackUrl) return fallbackUrl;

  const baseMatch = trimmed.match(/<BaseURL>([\s\S]*?)<\/BaseURL>/i);
  if (baseMatch && baseMatch[1]) {
    const url = baseMatch[1].trim().replace(/&amp;/g, '&');
    if (/^https?:\/\//i.test(url)) return url;
  }
  return null;
}

function isDashStreamVideoUrl(url) {
  return typeof url === 'string' && /[?&]efg=eyJ2ZW5jb2RlX3RhZyI6ImRhc2hf/i.test(url);
}

function sanitizePopupRecord(item) {
  if (!item || typeof item !== 'object') return { item, changed: false };
  let changed = false;
  const rawAttachments = Array.isArray(item.attachments) ? item.attachments : [];
  let cleanAttachments = [];
  for (const rawUrl of rawAttachments) {
    if (!rawUrl || typeof rawUrl !== 'string') continue;
    if (isDashMpdXmlString(rawUrl)) {
      changed = true;
      const extracted = extractDashMpdVideoUrl(rawUrl);
      if (extracted && !cleanAttachments.includes(extracted)) {
        cleanAttachments.push(extracted);
      }
    } else if (!cleanAttachments.includes(rawUrl)) {
      cleanAttachments.push(rawUrl);
    }
  }

  let cleanText = typeof item.text === 'string' ? item.text : '';
  if (cleanText && isDashMpdXmlString(cleanText)) {
    changed = true;
    if (!cleanAttachments.some(u => getAttachmentMediaType(u) === 'video')) {
      const mpdUrl = extractDashMpdVideoUrl(cleanText);
      if (mpdUrl && !cleanAttachments.includes(mpdUrl)) {
        cleanAttachments.unshift(mpdUrl);
      }
    }
    cleanText = cleanAttachments.length > 0 ? '' : '🎬 [Video]';
  } else if (
    cleanText &&
    cleanText.startsWith('⚠️') &&
    cleanText.includes(' — ') &&
    /File đính kèm không được hỗ trợ|Tin nhắn này không hiển thị trên ứng dụng này/i.test(cleanText)
  ) {
    cleanText = cleanText.replace(/\s*—\s*/g, ' - ');
    changed = true;
  }

  const hasProgressiveVideo = cleanAttachments.some(
    u => getAttachmentMediaType(u) === 'video' && !isDashStreamVideoUrl(u)
  );
  if (hasProgressiveVideo && cleanAttachments.some(isDashStreamVideoUrl)) {
    cleanAttachments = cleanAttachments.filter(u => !isDashStreamVideoUrl(u));
    changed = true;
  }

  if (!changed) {
    return { item, changed: false };
  }

  return {
    item: {
      ...item,
      text: cleanText,
      attachments: cleanAttachments
    },
    changed: true
  };
}

function getRecordAttachments(item) {
  const raw = Array.isArray(item.attachments) ? item.attachments.filter(Boolean) : [];
  let out = [];
  for (const u of raw) {
    const clean = isDashMpdXmlString(u) ? extractDashMpdVideoUrl(u) : u;
    if (clean && !isDashMpdXmlString(clean) && !out.includes(clean)) {
      out.push(clean);
    }
  }
  if (
    item.text &&
    isDashMpdXmlString(item.text) &&
    !out.some(u => getAttachmentMediaType(u) === 'video')
  ) {
    const fromText = extractDashMpdVideoUrl(item.text);
    if (fromText && !out.includes(fromText)) {
      out.unshift(fromText);
    }
  }
  const hasProgressiveVideo = out.some(
    u => getAttachmentMediaType(u) === 'video' && !isDashStreamVideoUrl(u)
  );
  if (hasProgressiveVideo) {
    out = out.filter(u => !isDashStreamVideoUrl(u));
  }
  return out;
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

  // dom.footerInfo.textContent = `Lưu tạm ${appState.capturedMessages.length.toLocaleString('vi-VN')} tin để đối chiếu`;
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

function buildMediaItem(url, onExpired) {
  const mediaType = getAttachmentMediaType(url);
  if (mediaType === 'audio') {
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.preload = 'metadata';
    audio.src = url;
    audio.className = 'media-audio';
    audio.addEventListener('error', function () {
      const fallback = document.createElement('div');
      fallback.className = 'media-expired-notice';
      fallback.textContent = '🎵 Âm thanh không còn khả dụng (liên kết trên máy chủ Facebook đã hết hạn)';
      audio.replaceWith(fallback);
      if (typeof onExpired === 'function') onExpired(url);
    });
    return audio;
  }
  if (mediaType === 'video') {
    const video = document.createElement('video');
    video.controls = true;
    video.preload = 'metadata';
    video.playsInline = true;
    video.src = url;
    video.className = 'media-video';
    video.addEventListener('error', function () {
      const fallback = document.createElement('div');
      fallback.className = 'media-expired-notice';
      fallback.textContent = '🎬 Video không còn khả dụng (liên kết trên máy chủ Facebook đã hết hạn)';
      video.replaceWith(fallback);
      if (typeof onExpired === 'function') onExpired(url);
    });
    return video;
  }
  return buildMediaThumb(url);
}

function extractSenderIdFromRecord(rec, isSelf = false) {
  if (!rec || typeof rec !== 'object') return '';
  if (rec.senderId) {
    return String(rec.senderId).trim().replace(/@(msgr|g\.us|c\.us)$/i, '');
  }
  if (!isSelf) {
    const rawId = String(rec.messageId || rec.originalMessageId || rec.fiberMsgId || '');
    const m = rawId.match(/^(\d{6,25})@msgr\.\d+$/);
    if (m) return m[1];
  }
  return '';
}

function repairPopupListsIdsAndAvatars(unsentList, capturedList) {
  let unsentChanged = false;
  let capturedChanged = false;
  const entries = [
    ...unsentList.map(rec => ({ rec, isUnsent: true })),
    ...capturedList.map(rec => ({ rec, isUnsent: false }))
  ].filter(e => e.rec && typeof e.rec === 'object');
  if (entries.length === 0) return { unsentChanged: false, capturedChanged: false };

  const markChanged = entry => {
    if (entry.isUnsent) unsentChanged = true;
    else capturedChanged = true;
  };

  const corruptedSet = new WeakSet();
  const groupThreadIds = new Set();
  const namesByThreadId = new Map();

  const getExplicitLowerPerson = rec => {
    const raw = !isGenericName(rec.personName) ? String(rec.personName).trim() : '';
    if (raw && !/^(người dùng facebook|bạn|you|chính bạn)$/i.test(raw)) {
      return raw.toLowerCase();
    }
    return '';
  };

  for (const entry of entries) {
    const { rec } = entry;
    const sId = String(rec.senderId || '').trim().replace(/@(msgr|g\.us|c\.us)$/i, '');
    const tId = String(rec.threadId || '').trim().replace(/@(msgr|g\.us|c\.us)$/i, '');
    const { isSelf } = parseRecordNames(rec);
    const pName = getExplicitLowerPerson(rec);
    const rawMid = String(rec.messageId || rec.originalMessageId || rec.fiberMsgId || '');
    const isDirectMsgrRecord = /^\d+@msgr\./i.test(rawMid);

    if (tId && /^\d{1,6}$/.test(tId)) {
      if (sId && sId.length >= 10) {
        rec.threadId = sId;
        rec.senderId = '';
        groupThreadIds.add(sId);
      } else {
        rec.threadId = '';
      }
      corruptedSet.add(rec);
      markChanged(entry);
    } else if (
      sId &&
      sId === tId &&
      sId.length >= 14 &&
      !isDirectMsgrRecord &&
      !sId.startsWith('1000') &&
      !sId.startsWith('615')
    ) {
      rec.senderId = '';
      groupThreadIds.add(tId);
      corruptedSet.add(rec);
      markChanged(entry);
    }

    const finalTid = String(rec.threadId || '').trim();
    const isPersonalOrDirectTid =
      isDirectMsgrRecord || finalTid.startsWith('1000') || finalTid.startsWith('615');
    if (finalTid && finalTid.length >= 10 && pName && !isSelf && !isPersonalOrDirectTid) {
      if (!namesByThreadId.has(finalTid)) {
        namesByThreadId.set(finalTid, new Set());
      }
      namesByThreadId.get(finalTid).add(pName);
    }
  }

  for (const [tId, names] of namesByThreadId.entries()) {
    if (
      !tId.startsWith('1000') &&
      !tId.startsWith('615') &&
      (names.size > 1 || tId.length >= 14)
    ) {
      groupThreadIds.add(tId);
    }
  }

  for (const entry of entries) {
    const { rec } = entry;
    const sId = String(rec.senderId || '').trim();
    if (sId && groupThreadIds.has(sId)) {
      if (!rec.threadId) {
        rec.threadId = sId;
      }
      rec.senderId = '';
      corruptedSet.add(rec);
      markChanged(entry);
    }
  }

  const senderIdNameCounts = new Map();
  for (const { rec } of entries) {
    const sId = String(rec.senderId || '').trim();
    const { isSelf } = parseRecordNames(rec);
    const pName = getExplicitLowerPerson(rec);
    if (!sId || !pName || isSelf) continue;
    if (!senderIdNameCounts.has(sId)) {
      senderIdNameCounts.set(sId, new Map());
    }
    const counts = senderIdNameCounts.get(sId);
    counts.set(pName, (counts.get(pName) || 0) + 1);
  }

  const validOwnerBySenderId = new Map();
  for (const [sId, counts] of senderIdNameCounts.entries()) {
    if (counts.size <= 1) {
      for (const name of counts.keys()) {
        validOwnerBySenderId.set(sId, name);
      }
      continue;
    }
    let bestName = '';
    let bestCount = 0;
    for (const [name, cnt] of counts.entries()) {
      if (cnt > bestCount) {
        bestCount = cnt;
        bestName = name;
      }
    }
    if (bestName) {
      validOwnerBySenderId.set(sId, bestName);
    }
  }

  for (const entry of entries) {
    const { rec } = entry;
    const sId = String(rec.senderId || '').trim();
    const { isSelf } = parseRecordNames(rec);
    const pName = getExplicitLowerPerson(rec);
    if (!sId || !pName || isSelf) continue;
    const rawMid = String(rec.messageId || rec.originalMessageId || rec.fiberMsgId || '');
    const m = rawMid.match(/^(\d{6,25})@msgr\.\d+$/);
    if (m && m[1] === sId) continue;
    const owner = validOwnerBySenderId.get(sId);
    if (owner && owner !== pName) {
      rec.senderId = '';
      corruptedSet.add(rec);
      markChanged(entry);
    }
  }

  const avatarNameCounts = new Map();
  for (const { rec } of entries) {
    const av = String(rec.avatarUrl || '').trim();
    const { isSelf } = parseRecordNames(rec);
    const pName = getExplicitLowerPerson(rec);
    if (!av || !pName || isSelf) continue;
    if (!avatarNameCounts.has(av)) {
      avatarNameCounts.set(av, new Map());
    }
    const counts = avatarNameCounts.get(av);
    const weight = corruptedSet.has(rec) ? 1 : 10;
    counts.set(pName, (counts.get(pName) || 0) + weight);
  }

  const avatarTrueOwner = new Map();
  for (const [av, counts] of avatarNameCounts.entries()) {
    if (counts.size <= 1) continue;
    let bestName = '';
    let bestScore = 0;
    for (const [name, score] of counts.entries()) {
      if (score > bestScore) {
        bestScore = score;
        bestName = name;
      }
    }
    if (bestName) {
      avatarTrueOwner.set(av, bestName);
    }
  }

  for (const entry of entries) {
    const { rec } = entry;
    const av = String(rec.avatarUrl || '').trim();
    const pName = getExplicitLowerPerson(rec);
    if (!av || !pName) continue;
    if (avatarTrueOwner.has(av) && avatarTrueOwner.get(av) !== pName) {
      rec.avatarUrl = '';
      markChanged(entry);
    }
  }

  return { unsentChanged, capturedChanged };
}

function findBestAvatarForItem(item, person, thread, isSelf) {
  const cleanPerson = (person || '').trim().toLowerCase();
  const cleanThread = (thread || person || '').trim().toLowerCase();
  const senderId = extractSenderIdFromRecord(item, isSelf);
  const pools = [appState.unsentMessages, appState.capturedMessages];

  // 1. Ưu tiên tuyệt đối: khớp theo UID (senderId) VÀ cùng tên người gửi
  if (senderId) {
    for (const list of pools) {
      if (!Array.isArray(list)) continue;
      for (const cand of list) {
        if (!cand || !cand.avatarUrl || !/^https?:\/\//i.test(cand.avatarUrl)) continue;
        const candNames = parseRecordNames(cand);
        const candId = extractSenderIdFromRecord(cand, candNames.isSelf);
        const candPerson = (candNames.person || '').trim().toLowerCase();
        if (candId && candId === senderId && (!cleanPerson || !candPerson || candPerson === cleanPerson)) {
          return cand.avatarUrl.trim();
        }
      }
    }
  }

  // 2. Dùng avatar đã lưu trực tiếp trên bản ghi
  if (item.avatarUrl && typeof item.avatarUrl === 'string' && /^https?:\/\//i.test(item.avatarUrl)) {
    return item.avatarUrl.trim();
  }

  // 3. Dự phòng: chỉ khớp theo ngữ cảnh cùng đoạn chat + cùng người gửi (không bao giờ khớp toàn cục theo tên)
  for (const list of pools) {
    if (!Array.isArray(list)) continue;
    for (const cand of list) {
      if (!cand || !cand.avatarUrl || !/^https?:\/\//i.test(cand.avatarUrl)) continue;
      const candNames = parseRecordNames(cand);
      if (isSelf && candNames.isSelf) {
        return cand.avatarUrl.trim();
      }
      if (!isSelf && !candNames.isSelf && cleanPerson) {
        const candPerson = (candNames.person || '').trim().toLowerCase();
        const candThread = (candNames.thread || candNames.person || '').trim().toLowerCase();
        if (candPerson === cleanPerson && candThread === cleanThread) {
          return cand.avatarUrl.trim();
        }
      }
    }
  }
  return '';
}

function buildMessageCard(item, ts) {
  const { person, thread, isSelf } = parseRecordNames(item);
  const attachments = getRecordAttachments(item);
  const displayText =
    item.text &&
    !isDashMpdXmlString(item.text) &&
    !(isAttachmentFilenameText(item.text) && attachments.length > 0)
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

  const avatarUrl = findBestAvatarForItem(item, person, thread, isSelf);
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
    roleEl.textContent = 'Bạn';
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

  const downloadBtn = card.querySelector('[data-action="download"]');
  if (attachments.length > 0) {
    applyDownloadLink(downloadBtn, attachments[0]);
    downloadBtn.hidden = false;
    const mediaEl = card.querySelector('.msg-media');
    attachments.forEach((url, idx) => {
      mediaEl.appendChild(
        buildMediaItem(url, function () {
          if (idx === 0 && downloadBtn) {
            downloadBtn.hidden = true;
          }
        })
      );
    });
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

function computeUnsentRenderSignature() {
  return JSON.stringify(
    appState.unsentMessages.map(item => {
      const { person, thread, isSelf } = parseRecordNames(item);
      const av = findBestAvatarForItem(item, person, thread, isSelf);
      return [
        item.messageId,
        person,
        thread,
        isSelf,
        item.text,
        getRecordAttachments(item),
        item.anchorAboveText,
        getRecordTime(item),
        av
      ];
    })
  );
}

function refreshView() {
  appState.lastRenderSignature = computeUnsentRenderSignature();
  updateThreadOptions();
  renderList();
}

function removeUnsentMessage(messageId) {
  appState.unsentMessages = appState.unsentMessages.filter(m => m.messageId !== messageId);
  chrome.storage.local.set({ [STORAGE_KEY_UNSENT]: appState.unsentMessages }, refreshView);
}

function loadPopupData(isBackgroundUpdate = false) {
  chrome.storage.local.get([STORAGE_KEY_UNSENT, STORAGE_KEY_MESSAGES, STORAGE_KEY_TOAST_ENABLED], function (res) {
    const rawUnsent = Array.isArray(res[STORAGE_KEY_UNSENT]) ? res[STORAGE_KEY_UNSENT] : [];
    const rawCaptured = Array.isArray(res[STORAGE_KEY_MESSAGES]) ? res[STORAGE_KEY_MESSAGES] : [];
    let unsentChanged = false;
    let capturedChanged = false;

    appState.unsentMessages = rawUnsent.map(m => {
      const cleaned = sanitizePopupRecord(m);
      if (cleaned.changed) unsentChanged = true;
      return cleaned.item;
    });
    appState.capturedMessages = rawCaptured.map(m => {
      const cleaned = sanitizePopupRecord(m);
      if (cleaned.changed) capturedChanged = true;
      return cleaned.item;
    });

    const repaired = repairPopupListsIdsAndAvatars(appState.unsentMessages, appState.capturedMessages);
    if (repaired.unsentChanged) unsentChanged = true;
    if (repaired.capturedChanged) capturedChanged = true;

    if (unsentChanged || capturedChanged) {
      const patch = {};
      if (unsentChanged) patch[STORAGE_KEY_UNSENT] = appState.unsentMessages;
      if (capturedChanged) patch[STORAGE_KEY_MESSAGES] = appState.capturedMessages;
      chrome.storage.local.set(patch);
    }

    // Chưa từng lưu thì coi như đang bật
    dom.toastToggle.checked = res[STORAGE_KEY_TOAST_ENABLED] !== false;
    if (isBackgroundUpdate && appState.lastRenderSignature) {
      // dom.footerInfo.textContent = `Lưu tạm ${appState.capturedMessages.length.toLocaleString('vi-VN')} tin để đối chiếu`;
      if (computeUnsentRenderSignature() === appState.lastRenderSignature) {
        return;
      }
    }
    refreshView();
  });

  if (!isBackgroundUpdate) {
    chrome.runtime.sendMessage({ type: 'CLEAR_UNREAD_BADGE' });
  }
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
      author: 'binhake (https://github.com/binhake/fb-unsend-viewer)',
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

function downloadFallbackDebugJson() {
  chrome.storage.local.get(
    [STORAGE_KEY_UNSENT, STORAGE_KEY_MESSAGES, STORAGE_KEY_TOAST_ENABLED],
    function (res) {
      const unsent = Array.isArray(res[STORAGE_KEY_UNSENT]) ? res[STORAGE_KEY_UNSENT] : [];
      const captured = Array.isArray(res[STORAGE_KEY_MESSAGES]) ? res[STORAGE_KEY_MESSAGES] : [];
      const report = {
        exportedAt: new Date().toISOString(),
        source:
          'popup-storage-fallback (không tìm thấy tab Facebook đang mở hoặc tab chưa tải lại trang)',
        version: chrome.runtime.getManifest().version,
        userAgent: navigator.userAgent,
        isToastEnabled: res[STORAGE_KEY_TOAST_ENABLED] !== false,
        unsentCount: unsent.length,
        capturedCount: captured.length,
        contentWorld: {
          unsentMessagesList: unsent,
          recentMessagesListTail: captured.slice(-150)
        }
      };

      const blob = new Blob([JSON.stringify(report, null, 2)], {
        type: 'application/json;charset=utf-8'
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `fb-unsend-debug-${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () {
        URL.revokeObjectURL(url);
      }, 1500);

      showStatus('Đã tải tệp Debug (dữ liệu lưu trữ — mở tab Facebook và F5 nếu cần chụp thêm DOM)');
    }
  );
}

function exportDebugReport() {
  if (!chrome.tabs || typeof chrome.tabs.query !== 'function') {
    downloadFallbackDebugJson();
    return;
  }

  chrome.tabs.query({ active: true, currentWindow: true }, function (activeTabs) {
    const activeTab = (activeTabs || []).find(t => t && t.id);
    const tryFallbackTabs = function () {
      chrome.tabs.query({ url: '*://*.facebook.com/*' }, function (fbTabs) {
        const targetTab = (fbTabs || []).find(t => t && t.id);
        if (!targetTab) {
          downloadFallbackDebugJson();
          return;
        }
        chrome.tabs.sendMessage(targetTab.id, { type: 'TRIGGER_DEBUG_EXPORT' }, function (resp) {
          if (chrome.runtime.lastError || !resp || !resp.ok) {
            downloadFallbackDebugJson();
          } else {
            showStatus('Đã tải tệp chẩn đoán lỗi (Debug JSON)');
          }
        });
      });
    };

    if (activeTab && (!activeTab.url || /facebook\.com/i.test(activeTab.url))) {
      chrome.tabs.sendMessage(activeTab.id, { type: 'TRIGGER_DEBUG_EXPORT' }, function (resp) {
        if (chrome.runtime.lastError || !resp || !resp.ok) {
          tryFallbackTabs();
        } else {
          showStatus('Đã tải tệp chẩn đoán lỗi (Debug JSON)');
        }
      });
    } else {
      tryFallbackTabs();
    }
  });
}

function isTempId(id) {
  return !id || String(id).startsWith('dom_') || String(id).startsWith('unsend_');
}

function smartMergeRecords(existingList, importedList, isUnsentCollection = true) {
  const result = Array.isArray(existingList) ? [...existingList] : [];
  let addedCount = 0;
  let mergedCount = 0;

  for (const origItem of importedList) {
    if (!origItem || typeof origItem !== 'object') continue;
    const { item: rawItem } = sanitizePopupRecord(origItem);
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
            [STORAGE_KEY_MESSAGES]: capturedMerge.result.slice(-3000),
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
  if (dom.debugBtn) {
    dom.debugBtn.addEventListener('click', exportDebugReport);
  }
  if (dom.versionTag) {
    dom.versionTag.addEventListener('click', function () {
      checkUpdateFromPopup(true);
    });
  }
  if (dom.updateDismissBtn) {
    dom.updateDismissBtn.addEventListener('click', function () {
      const latestVer = dom.updateBanner?.dataset?.latestVersion || '';
      dom.updateBanner.hidden = true;
      if (latestVer && chrome?.storage?.local) {
        chrome.storage.local.get([STORAGE_KEY_UPDATE_INFO], function (res) {
          const prev = res?.[STORAGE_KEY_UPDATE_INFO] || {};
          chrome.storage.local.set({
            [STORAGE_KEY_UPDATE_INFO]: {
              ...prev,
              dismissedVersion: latestVer
            }
          });
        });
      }
    });
  }

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
      loadPopupData(true);
    }
  });
}

// Bảo vệ bản quyền tác giả gốc (binhake) trên giao diện và manifest
const AUTHOR_HANDLE = [98, 105, 110, 104, 97, 107, 101].map(c => String.fromCharCode(c)).join('');
const AUTHOR_REPO_URL = `https://github.com/${AUTHOR_HANDLE}/fb-unsend-viewer`;

function enforceAuthorAttribution() {
  let tampered = false;
  try {
    const manifest = chrome.runtime.getManifest();
    if (!manifest.author || !String(manifest.author).toLowerCase().includes(AUTHOR_HANDLE)) {
      tampered = true;
    }
  } catch (_) {}

  const footer = document.querySelector('.app-footer');
  if (!footer) return;

  let meta = footer.querySelector('.footer-meta');
  if (!meta) {
    tampered = true;
    meta = document.createElement('span');
    meta.className = 'footer-meta';
    footer.appendChild(meta);
  }

  let credit = document.getElementById('author-credit');
  if (!credit || !meta.contains(credit)) {
    tampered = true;
    credit = document.createElement('a');
    credit.id = 'author-credit';
    credit.className = 'author-credit';
    credit.target = '_blank';
    credit.rel = 'noopener noreferrer';
    meta.prepend(credit);
  }

  const expectedLabel = `© ${AUTHOR_HANDLE}`;
  if ((credit.textContent || '').trim() !== expectedLabel) {
    tampered = true;
    credit.textContent = expectedLabel;
  }
  if (credit.getAttribute('href') !== AUTHOR_REPO_URL) {
    tampered = true;
    credit.setAttribute('href', AUTHOR_REPO_URL);
  }
  if (credit.hidden) {
    tampered = true;
    credit.hidden = false;
  }

  const computed = window.getComputedStyle(credit);
  if (computed.display === 'none' || computed.visibility === 'hidden' || Number(computed.opacity) < 0.2) {
    tampered = true;
    credit.style.setProperty('display', 'inline', 'important');
    credit.style.setProperty('visibility', 'visible', 'important');
    credit.style.setProperty('opacity', '1', 'important');
  }

  if (tampered) {
    showStatus(`Bản quyền gốc thuộc về ${AUTHOR_HANDLE} (${AUTHOR_REPO_URL})`, true);
  }
}

function parseSemVer(verStr) {
  const clean = String(verStr || '')
    .trim()
    .replace(/^[vV]+/, '')
    .split('-')[0];
  if (!/^\d+(\.\d+)*$/.test(clean)) return null;
  return clean.split('.').map(n => parseInt(n, 10) || 0);
}

function isNewerVersion(remoteVer, localVer) {
  const r = parseSemVer(remoteVer);
  const l = parseSemVer(localVer);
  if (!r || !l) return false;
  const maxLen = Math.max(r.length, l.length);
  for (let i = 0; i < maxLen; i++) {
    const rv = r[i] || 0;
    const lv = l[i] || 0;
    if (rv > lv) return true;
    if (rv < lv) return false;
  }
  return false;
}

function renderUpdateState(updateInfo) {
  let currentVer = '1.2.5';
  try {
    currentVer = chrome.runtime.getManifest().version || currentVer;
  } catch (_) {}

  if (!dom.versionTag || !dom.updateBanner) return;

  const latestVer = String(updateInfo?.latestVersion || '')
    .trim()
    .replace(/^[vV]+/, '');
  const hasUpdate = Boolean(latestVer && isNewerVersion(latestVer, currentVer));
  const isDismissed = Boolean(hasUpdate && updateInfo?.dismissedVersion === latestVer);

  if (hasUpdate) {
    dom.versionTag.textContent = `v${currentVer} → v${latestVer}`;
    dom.versionTag.classList.add('has-update');
    dom.versionTag.title = `Đã có bản phát hành mới v${latestVer} trên GitHub Releases (nhấn để mở)`;
  } else {
    dom.versionTag.textContent = `v${currentVer}`;
    dom.versionTag.classList.remove('has-update');
    dom.versionTag.title = 'Nhấn để kiểm tra bản cập nhật mới trên GitHub Releases';
  }

  if (hasUpdate && !isDismissed) {
    dom.updateBannerTitle.textContent = `Đã có phiên bản mới v${latestVer}`;
    dom.updateReleaseLink.href = updateInfo?.releaseUrl || GITHUB_RELEASES_PAGE_URL;
    dom.updateBanner.dataset.latestVersion = latestVer;
    dom.updateBanner.hidden = false;
  } else {
    dom.updateBanner.hidden = true;
  }
}

function checkUpdateFromPopup(manual = false) {
  if (!chrome?.runtime?.sendMessage) return;
  if (manual) {
    showStatus('Đang kiểm tra bản phát hành mới trên GitHub Releases…');
  }
  chrome.runtime.sendMessage({ type: 'CHECK_GITHUB_RELEASE_UPDATE', force: manual }, function (resp) {
    const info = resp?.info;
    renderUpdateState(info);
    if (manual) {
      let currentVer = '1.2.5';
      try {
        currentVer = chrome.runtime.getManifest().version || currentVer;
      } catch (_) {}
      const latestVer = String(info?.latestVersion || '')
        .trim()
        .replace(/^[vV]+/, '');
      if (latestVer && isNewerVersion(latestVer, currentVer)) {
        // Nếu người dùng tự bấm kiểm tra thì bỏ trạng thái ẩn của bản đó để hiện lại banner
        chrome.storage.local.set(
          {
            [STORAGE_KEY_UPDATE_INFO]: {
              ...info,
              dismissedVersion: ''
            }
          },
          function () {
            renderUpdateState({ ...info, dismissedVersion: '' });
            showStatus(`Phát hiện bản phát hành mới v${latestVer}!`);
          }
        );
      } else {
        showStatus(`Bạn đang dùng phiên bản mới nhất (v${currentVer})`);
      }
    }
  });
}

function init() {
  cacheDom();
  try {
    dom.versionTag.textContent = `v${chrome.runtime.getManifest().version}`;
  } catch (_) {}
  enforceAuthorAttribution();
  bindEvents();
  loadPopupData();

  if (chrome?.storage?.local) {
    chrome.storage.local.get([STORAGE_KEY_UPDATE_INFO], function (res) {
      renderUpdateState(res?.[STORAGE_KEY_UPDATE_INFO]);
      checkUpdateFromPopup(false);
    });
  }
}

init();
