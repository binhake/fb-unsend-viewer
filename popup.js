/**
 * popup.js - Quản lý hiển thị, tìm kiếm, sao chép và xóa lịch sử tin nhắn bị gỡ
 */

const STORAGE_KEY_MESSAGES = 'fb_captured_messages_v2';
const STORAGE_KEY_UNSENT = 'fb_unsent_messages_v2';

const unsentListEl = document.getElementById('unsent-list');
const unsentCountEl = document.getElementById('unsent-count');
const capturedStatsEl = document.getElementById('captured-stats');
const searchInputEl = document.getElementById('search-input');
const clearAllBtnEl = document.getElementById('clear-all-btn');

let allUnsentMessages = [];

function formatTime(ts) {
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

function renderList(filterKeyword = '') {
  const kw = filterKeyword.trim().toLowerCase();
  const filtered = kw
    ? allUnsentMessages.filter((item) => {
        const name = (item.senderName || '').toLowerCase();
        const text = (item.text || '').toLowerCase();
        return name.includes(kw) || text.includes(kw);
      })
    : allUnsentMessages;

  unsentCountEl.textContent = String(allUnsentMessages.length);
  unsentListEl.innerHTML = '';

  if (filtered.length === 0) {
    const emptyDiv = document.createElement('div');
    emptyDiv.className = 'empty-state';
    emptyDiv.textContent = kw
      ? 'Không tìm thấy tin nhắn bị gỡ nào khớp từ khóa.'
      : 'Chưa có tin nhắn nào bị gỡ được ghi nhận.';
    unsentListEl.appendChild(emptyDiv);
    return;
  }

  filtered.forEach((item) => {
    const card = document.createElement('div');
    card.className = 'unsent-card';

    const header = document.createElement('div');
    header.className = 'card-header';

    const senderSpan = document.createElement('span');
    senderSpan.className = 'sender-name';
    senderSpan.textContent = item.senderName || 'Facebook Chat';

    const timeSpan = document.createElement('span');
    timeSpan.className = 'unsent-time';
    timeSpan.textContent = formatTime(item.unsentAt || item.timestamp);

    header.appendChild(senderSpan);
    header.appendChild(timeSpan);
    card.appendChild(header);

    if (item.text) {
      const bodyDiv = document.createElement('div');
      bodyDiv.className = 'card-body';
      bodyDiv.textContent = item.text;
      card.appendChild(bodyDiv);
    }

    if (Array.isArray(item.attachments) && item.attachments.length > 0) {
      const mediaDiv = document.createElement('div');
      mediaDiv.className = 'card-media';
      item.attachments.forEach((url) => {
        const img = document.createElement('img');
        img.src = url;
        img.title = 'Nhấn để mở media trong tab mới';
        img.addEventListener('click', () => {
          window.open(url, '_blank');
        });
        mediaDiv.appendChild(img);
      });
      card.appendChild(mediaDiv);
    }

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'card-actions';

    if (item.text) {
      const copyBtn = document.createElement('button');
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

    const delBtn = document.createElement('button');
    delBtn.className = 'action-btn';
    delBtn.textContent = '🗑️ Xóa';
    delBtn.addEventListener('click', () => {
      allUnsentMessages = allUnsentMessages.filter((m) => m.messageId !== item.messageId);
      chrome.storage.local.set({ [STORAGE_KEY_UNSENT]: allUnsentMessages }, () => {
        renderList(searchInputEl.value);
      });
    });
    actionsDiv.appendChild(delBtn);

    card.appendChild(actionsDiv);
    unsentListEl.appendChild(card);
  });
}

function loadPopupData() {
  chrome.storage.local.get([STORAGE_KEY_UNSENT, STORAGE_KEY_MESSAGES], (res) => {
    allUnsentMessages = Array.isArray(res[STORAGE_KEY_UNSENT]) ? res[STORAGE_KEY_UNSENT] : [];
    const capturedList = Array.isArray(res[STORAGE_KEY_MESSAGES]) ? res[STORAGE_KEY_MESSAGES] : [];
    capturedStatsEl.textContent = `Đang lưu tạm: ${capturedList.length} tin nhắn`;
    renderList(searchInputEl.value);
  });

  // Xóa số đếm chưa đọc trên Badge khi người dùng mở Popup
  chrome.runtime.sendMessage({ type: 'CLEAR_UNREAD_BADGE' });
}

searchInputEl.addEventListener('input', () => {
  renderList(searchInputEl.value);
});

clearAllBtnEl.addEventListener('click', () => {
  allUnsentMessages = [];
  chrome.storage.local.set({ [STORAGE_KEY_UNSENT]: [] }, () => {
    renderList('');
  });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && (changes[STORAGE_KEY_UNSENT] || changes[STORAGE_KEY_MESSAGES])) {
    loadPopupData();
  }
});

loadPopupData();
