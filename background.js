/**
 * background.js - Service Worker (Manifest V3)
 * Nhiệm vụ:
 * 1. Theo dõi số lượng tin nhắn bị gỡ mới trong chrome.storage.local để hiển thị Badge trên icon Extension.
 * 2. Hỗ trợ xóa Badge khi người dùng mở Popup xem lịch sử.
 */

const STORAGE_KEY_UNREAD_COUNT = 'fb_unread_unsent_count_v2';

function updateBadge(count) {
  const num = Number(count) || 0;
  const text = num > 0 ? (num > 99 ? '99+' : String(num)) : '';
  chrome.action.setBadgeText({ text });
  if (num > 0) {
    chrome.action.setBadgeBackgroundColor({ color: '#ff4d4f' });
  }
}

// Khởi tạo trạng thái Badge khi trình duyệt / Service Worker khởi động
chrome.storage.local.get([STORAGE_KEY_UNREAD_COUNT], (res) => {
  updateBadge(res[STORAGE_KEY_UNREAD_COUNT] || 0);
});

// Tự động cập nhật Badge mỗi khi số lượng tin nhắn bị gỡ chưa đọc thay đổi
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes[STORAGE_KEY_UNREAD_COUNT]) {
    updateBadge(changes[STORAGE_KEY_UNREAD_COUNT].newValue || 0);
  }
});

// Lắng nghe yêu cầu từ content.js hoặc popup.js
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) return;

  if (message.type === 'INCREMENT_UNREAD_BADGE') {
    chrome.storage.local.get([STORAGE_KEY_UNREAD_COUNT], (res) => {
      const nextCount = (Number(res[STORAGE_KEY_UNREAD_COUNT]) || 0) + 1;
      chrome.storage.local.set({ [STORAGE_KEY_UNREAD_COUNT]: nextCount }, () => {
        updateBadge(nextCount);
        sendResponse({ ok: true, count: nextCount });
      });
    });
    return true;
  }

  if (message.type === 'CLEAR_UNREAD_BADGE') {
    chrome.storage.local.set({ [STORAGE_KEY_UNREAD_COUNT]: 0 }, () => {
      updateBadge(0);
      sendResponse({ ok: true });
    });
    return true;
  }
});
