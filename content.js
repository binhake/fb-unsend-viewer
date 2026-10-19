/**
 * content.js - Chạy trong ISOLATED world trên facebook.com
 * Nhiệm vụ:
 * 1. Nhận dữ liệu tin nhắn & sự kiện thu hồi từ injected.js (tầng ngầm WebSocket/Lightspeed/IndexedDB).
 * 2. Lưu trữ vào chrome.storage.local để không mất dữ liệu khi tải lại trang hoặc chuyển tab.
 * 3. Kết hợp theo dõi khung chat (DOM) để ghép nối vị trí bong bóng chat và hiển thị lại nội dung đã bị gỡ
 *    ngay tại chỗ có dòng "đã thu hồi một tin nhắn" / "unsent a message".
 */

(function () {
  const STORAGE_KEY_MESSAGES = 'fb_captured_messages_v1';
  const STORAGE_KEY_UNSENT = 'fb_unsent_messages_v1';
  const MAX_STORED_MESSAGES = 1000;

  // Map lưu tin nhắn theo ID từ tầng dữ liệu ngầm: messageId -> messageObj
  const messagesById = new Map();
  // Map lưu tin nhắn theo vị trí dòng DOM (dự phòng & ghép nối hiển thị trực tiếp)
  const domRowMessages = new WeakMap();
  // Danh sách các tin nhắn đã bắt được theo thứ tự thời gian (mới nhất ở cuối)
  let recentMessagesList = [];
  // Danh sách các tin nhắn đã bị gỡ
  let unsentMessagesList = [];

  const UNSEND_REGEX =
    /(đã thu hồi một tin nhắn|đã gỡ một tin nhắn|bạn đã thu hồi một tin nhắn|unsent a message|you unsent a message|removed a message|tin nhắn đã bị thu hồi)/i;

  // Khởi tạo: tải dữ liệu đã lưu từ chrome.storage.local
  function loadFromStorage() {
    if (!chrome?.storage?.local) return;
    chrome.storage.local.get([STORAGE_KEY_MESSAGES, STORAGE_KEY_UNSENT], (res) => {
      if (Array.isArray(res[STORAGE_KEY_MESSAGES])) {
        recentMessagesList = res[STORAGE_KEY_MESSAGES];
        for (const msg of recentMessagesList) {
          if (msg.messageId) {
            messagesById.set(msg.messageId, msg);
          }
        }
      }
      if (Array.isArray(res[STORAGE_KEY_UNSENT])) {
        unsentMessagesList = res[STORAGE_KEY_UNSENT];
      }
      console.log(
        `[FB-Unsend-Content] Đã tải ${recentMessagesList.length} tin nhắn lưu tạm và ${unsentMessagesList.length} tin nhắn bị gỡ.`
      );
    });
  }

  let saveTimeout = null;
  function saveToStorage() {
    if (!chrome?.storage?.local) return;
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
      if (recentMessagesList.length > MAX_STORED_MESSAGES) {
        recentMessagesList = recentMessagesList.slice(-MAX_STORED_MESSAGES);
      }
      chrome.storage.local.set({
        [STORAGE_KEY_MESSAGES]: recentMessagesList,
        [STORAGE_KEY_UNSENT]: unsentMessagesList
      });
    }, 300);
  }

  // ============================================================================
  // 1. NHẬN DỮ LIỆU TỪ TẦNG NGẦM (injected.js)
  // ============================================================================
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data) return;
    if (event.data.source !== 'FB_UNSEND_EXTENSION_MAIN') return;

    const { type, payload } = event.data;
    if (!payload) return;

    if (type === 'FB_MSG_CAPTURED') {
      handleCapturedMessageFromMain(payload);
    } else if (type === 'FB_MSG_UNSENT') {
      handleUnsentEventFromMain(payload);
    }
  });

  function handleCapturedMessageFromMain(msg) {
    if (!msg.messageId) return;

    const existing = messagesById.get(msg.messageId);
    const merged = {
      ...existing,
      ...msg,
      text: msg.text || existing?.text || '',
      attachments:
        msg.attachments && msg.attachments.length > 0
          ? msg.attachments
          : existing?.attachments || [],
      senderName: existing?.senderName || findActiveThreadName() || '',
      updatedAt: Date.now()
    };

    messagesById.set(msg.messageId, merged);

    const idx = recentMessagesList.findIndex((m) => m.messageId === msg.messageId);
    if (idx !== -1) {
      recentMessagesList[idx] = merged;
    } else {
      recentMessagesList.push(merged);
    }

    saveToStorage();
  }

  function handleUnsentEventFromMain(unsentData) {
    const existing = messagesById.get(unsentData.messageId);
    const originalText = existing?.text || unsentData.text || '';
    const originalAttachments =
      existing?.attachments?.length > 0
        ? existing.attachments
        : unsentData.attachments || [];

    const record = {
      messageId: unsentData.messageId,
      text: originalText,
      attachments: originalAttachments,
      senderId: existing?.senderId || unsentData.senderId || '',
      threadId: existing?.threadId || unsentData.threadId || '',
      senderName: existing?.senderName || findActiveThreadName() || 'Cuộc trò chuyện Facebook',
      timestamp: existing?.timestamp || unsentData.timestamp || Date.now(),
      unsentAt: Date.now(),
      isUnsent: true
    };

    messagesById.set(record.messageId, record);

    const existingUnsentIdx = unsentMessagesList.findIndex(
      (u) => u.messageId === record.messageId
    );
    if (existingUnsentIdx !== -1) {
      unsentMessagesList[existingUnsentIdx] = record;
    } else {
      unsentMessagesList.unshift(record);
    }

    saveToStorage();

    // Hiển thị thông báo nổi ở góc màn hình (nếu có nội dung gốc)
    if (record.text || record.attachments.length > 0) {
      showUnsentToast(record);
    }

    // Quét DOM để hiển thị ngay vào vị trí bong bóng chat bị thu hồi
    setTimeout(() => scanDomForUnsentNotices(record), 150);
  }

  // ============================================================================
  // 2. THEO DÕI KHUNG CHAT TRÊN GIAO DIỆN (DOM) & HIỂN THỊ LẠI NỘI DUNG BỊ GỠ
  // ============================================================================

  function findActiveThreadName() {
    try {
      // Tìm tiêu đề của hộp chat hoặc trang messages
      const headerEl = document.querySelector(
        'div[role="main"] h1, div[role="dialog"] h2, div[aria-label*="Cuộc trò chuyện"] h2, div[aria-label*="Conversation"] h2'
      );
      if (headerEl && headerEl.innerText) {
        return headerEl.innerText.trim().split('\n')[0];
      }
    } catch (_) {}
    return '';
  }

  /**
   * Trích xuất nội dung văn bản sạch của một dòng tin nhắn (row) trên khung chat
   */
  function extractRowMessageContent(rowEl) {
    const textElements = rowEl.querySelectorAll('div[dir="auto"]');
    const texts = [];

    textElements.forEach((el) => {
      const t = (el.innerText || '').trim();
      if (!t) return;
      // Bỏ qua thông báo thu hồi hoặc nhãn hệ thống
      if (UNSEND_REGEX.test(t)) return;
      if (/^(Đã gửi|Đã nhận|Đã xem|Sent|Delivered|Seen|Đang viết)/i.test(t)) return;
      texts.push(t);
    });

    const imageUrls = [];
    rowEl.querySelectorAll('img').forEach((img) => {
      const src = img.src || '';
      // Bỏ qua ảnh avatar nhỏ (thường kích thước <= 40px) hoặc emoji nhỏ
      const width = img.naturalWidth || img.width || 0;
      const height = img.naturalHeight || img.height || 0;
      if (
        src &&
        !src.startsWith('data:image/svg') &&
        (width > 45 || height > 45 || src.includes('scontent') || src.includes('fbsbx'))
      ) {
        // Kiểm tra xem có phải avatar người gửi nằm ngoài bong bóng tin nhắn không
        const isAvatar =
          img.closest('[role="button"][ aria-label]') && width <= 40 && height <= 40;
        if (!isAvatar && !imageUrls.includes(src)) {
          imageUrls.push(src);
        }
      }
    });

    return {
      text: texts.join('\n').trim(),
      attachments: imageUrls
    };
  }

  /**
   * Kiểm tra một dòng tin nhắn trên DOM:
   * - Nếu là tin nhắn bình thường -> lưu nội dung vào domRowMessages & recentMessagesList
   * - Nếu là thông báo "đã thu hồi một tin nhắn" -> hiển thị lại nội dung đã lưu!
   */
  function processChatRow(rowEl) {
    if (!rowEl || !(rowEl instanceof HTMLElement)) return;

    const fullRowText = (rowEl.innerText || '').trim();
    if (!fullRowText) return;

    // Kiểm tra xem dòng này có đang hiển thị thông báo thu hồi không
    if (UNSEND_REGEX.test(fullRowText)) {
      // Nếu đã chèn khung khôi phục rồi thì không chèn trùng
      if (rowEl.querySelector('.fb-unsend-restored-box')) return;

      // 1. Tìm trong bộ nhớ gắn trực tiếp với dòng DOM này (nếu dòng DOM được tái sử dụng tại chỗ)
      let restoredData = domRowMessages.get(rowEl);

      // 2. Nếu Facebook thay thế node DOM mới, tìm theo tin nhắn gần nhất chưa được gắn hoặc từ tầng ngầm
      if (!restoredData || (!restoredData.text && restoredData.attachments?.length === 0)) {
        restoredData = findBestMatchForUnsentRow(rowEl);
      }

      if (restoredData && (restoredData.text || (restoredData.attachments && restoredData.attachments.length > 0))) {
        renderRestoredContentInDom(rowEl, restoredData);

        // Đồng bộ vào danh sách lịch sử bị gỡ nếu chưa có
        const msgId = restoredData.messageId || `dom_${restoredData.timestamp || Date.now()}`;
        if (!unsentMessagesList.some((u) => u.messageId === msgId || (u.text && u.text === restoredData.text && Math.abs((u.unsentAt || 0) - Date.now()) < 10000))) {
          const unsentRecord = {
            messageId: msgId,
            text: restoredData.text || '',
            attachments: restoredData.attachments || [],
            senderName: restoredData.senderName || findActiveThreadName() || 'Facebook Chat',
            timestamp: restoredData.timestamp || Date.now(),
            unsentAt: Date.now(),
            isUnsent: true
          };
          unsentMessagesList.unshift(unsentRecord);
          saveToStorage();
          showUnsentToast(unsentRecord);
        }
      }
      return;
    }

    // Nếu là dòng tin nhắn bình thường (chưa bị gỡ) -> ghi nhận nội dung
    const extracted = extractRowMessageContent(rowEl);
    if (extracted.text || extracted.attachments.length > 0) {
      const prev = domRowMessages.get(rowEl);
      const record = {
        messageId: prev?.messageId || `dom_row_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        text: extracted.text || prev?.text || '',
        attachments:
          extracted.attachments.length > 0
            ? extracted.attachments
            : prev?.attachments || [],
        senderName: findActiveThreadName() || prev?.senderName || '',
        timestamp: prev?.timestamp || Date.now()
      };

      domRowMessages.set(rowEl, record);

      // Lưu một khóa dự phòng lên dataset của phần tử cha/hàng để khi React chỉ sửa bên trong row vẫn giữ được
      if (!rowEl.dataset.fbUnsendSavedText && record.text) {
        rowEl.dataset.fbUnsendSavedText = record.text;
      }
      if (!rowEl.dataset.fbUnsendSavedMedia && record.attachments.length > 0) {
        rowEl.dataset.fbUnsendSavedMedia = JSON.stringify(record.attachments);
      }
    }
  }

  /**
   * Tìm nội dung gốc phù hợp nhất khi một dòng DOM chuyển sang trạng thái đã bị gỡ
   */
  function findBestMatchForUnsentRow(rowEl) {
    // 1. Kiểm tra dataset dự phòng ngay trên rowEl hoặc phần tử cha gần nhất
    const savedText = rowEl.dataset?.fbUnsendSavedText;
    const savedMediaStr = rowEl.dataset?.fbUnsendSavedMedia;
    if (savedText || savedMediaStr) {
      let attachments = [];
      try {
        if (savedMediaStr) attachments = JSON.parse(savedMediaStr);
      } catch (_) {}
      return {
        text: savedText || '',
        attachments,
        timestamp: Date.now()
      };
    }

    // 2. Lấy tin nhắn vừa mới bị đánh dấu gỡ ở tầng ngầm (injected.js) trong vòng 60 giây gần đây
    if (unsentMessagesList.length > 0) {
      const latestUnsent = unsentMessagesList[0];
      if (
        (latestUnsent.text || latestUnsent.attachments?.length > 0) &&
        !latestUnsent._renderedInDom
      ) {
        latestUnsent._renderedInDom = true;
        return latestUnsent;
      }
    }

    // 3. Đối chiếu với danh sách tin nhắn bắt ngầm gần đây nhưng hiện không còn xuất hiện trên khung chat nữa
    const currentChatContainer =
      rowEl.closest('div[role="grid"], div[role="log"], div[role="main"], div[role="dialog"]') ||
      document.body;
    const visibleTextOnScreen = currentChatContainer.innerText || '';

    for (let i = recentMessagesList.length - 1; i >= 0; i--) {
      const candidate = recentMessagesList[i];
      if (candidate.text && !visibleTextOnScreen.includes(candidate.text)) {
        return candidate;
      }
    }

    return null;
  }

  /**
   * Chèn hộp hiển thị nội dung tin nhắn gốc ngay bên dưới dòng "đã thu hồi một tin nhắn"
   */
  function renderRestoredContentInDom(rowEl, data) {
    if (rowEl.querySelector('.fb-unsend-restored-box')) return;

    // Tìm phần tử chứa chữ "đã thu hồi một tin nhắn" / "unsent a message"
    let targetContainer = rowEl;
    const allDivs = rowEl.querySelectorAll('div, span');
    for (const el of allDivs) {
      if (
        el.childNodes.length === 1 &&
        el.firstChild.nodeType === Node.TEXT_NODE &&
        UNSEND_REGEX.test(el.textContent)
      ) {
        targetContainer = el.parentElement || el;
        break;
      }
    }

    const box = document.createElement('div');
    box.className = 'fb-unsend-restored-box';

    const badge = document.createElement('div');
    badge.className = 'fb-unsend-badge';
    badge.textContent = '🔓 Nội dung trước khi gỡ:';
    box.appendChild(badge);

    if (data.text) {
      const textDiv = document.createElement('div');
      textDiv.className = 'fb-unsend-text';
      textDiv.textContent = data.text;
      box.appendChild(textDiv);
    }

    if (data.attachments && data.attachments.length > 0) {
      const mediaContainer = document.createElement('div');
      mediaContainer.className = 'fb-unsend-media-list';
      data.attachments.forEach((url) => {
        const img = document.createElement('img');
        img.src = url;
        img.className = 'fb-unsend-restored-img';
        img.title = 'Nhấn để mở ảnh gốc';
        img.addEventListener('click', () => window.open(url, '_blank'));
        mediaContainer.appendChild(img);
      });
      box.appendChild(mediaContainer);
    }

    targetContainer.appendChild(box);
  }

  /**
   * Quét toàn bộ các dòng chat đang mở để tìm thông báo thu hồi
   */
  function scanDomForUnsentNotices(specificRecord = null) {
    const rows = document.querySelectorAll('div[role="row"], div[role="gridcell"], div[data-scope="messages_table"]');
    rows.forEach((row) => {
      if (specificRecord && UNSEND_REGEX.test(row.innerText || '') && !row.querySelector('.fb-unsend-restored-box')) {
        renderRestoredContentInDom(row, specificRecord);
      } else {
        processChatRow(row);
      }
    });
  }

  /**
   * Hiển thị thông báo nhỏ (Toast) ở góc dưới bên trái khi phát hiện có người gỡ tin nhắn
   */
  function showUnsentToast(record) {
    if (!document.body) return;

    let toastContainer = document.getElementById('fb-unsend-toast-container');
    if (!toastContainer) {
      toastContainer = document.createElement('div');
      toastContainer.id = 'fb-unsend-toast-container';
      document.body.appendChild(toastContainer);
    }

    const toast = document.createElement('div');
    toast.className = 'fb-unsend-toast';

    const title = document.createElement('div');
    title.className = 'fb-unsend-toast-title';
    title.textContent = `🚨 Phát hiện gỡ tin nhắn (${record.senderName || 'Facebook'})`;

    const body = document.createElement('div');
    body.className = 'fb-unsend-toast-body';
    body.textContent =
      record.text ||
      (record.attachments?.length
        ? `[Đính kèm ${record.attachments.length} tệp/hình ảnh]`
        : '(Không rõ nội dung)');

    toast.appendChild(title);
    toast.appendChild(body);
    toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('fb-unsend-toast-hide');
      setTimeout(() => toast.remove(), 400);
    }, 6000);
  }

  // ============================================================================
  // 3. KHỞI ĐỘNG MUTATION OBSERVER TRÊN DOM
  // ============================================================================
  function startDomObserver() {
    if (!document.body) {
      window.addEventListener('DOMContentLoaded', startDomObserver, { once: true });
      return;
    }

    // Quét lần đầu
    scanDomForUnsentNotices();

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          mutation.addedNodes.forEach((node) => {
            if (node instanceof HTMLElement) {
              if (node.matches?.('div[role="row"], div[role="gridcell"]')) {
                processChatRow(node);
              } else {
                const parentRow = node.closest?.('div[role="row"]');
                if (parentRow) {
                  processChatRow(parentRow);
                } else {
                  const childRows = node.querySelectorAll?.('div[role="row"]');
                  childRows?.forEach((r) => processChatRow(r));
                }
              }
            }
          });
        } else if (mutation.type === 'characterData') {
          const parentRow = mutation.target.parentElement?.closest?.('div[role="row"]');
          if (parentRow) {
            processChatRow(parentRow);
          }
        }
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  loadFromStorage();
  startDomObserver();
})();
