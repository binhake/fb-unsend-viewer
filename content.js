/**
 * content.js - Chạy trong ISOLATED world trên facebook.com
 * Nhiệm vụ:
 * 1. Nhận dữ liệu tin nhắn & sự kiện thu hồi từ injected.js (WebSocket, Lightspeed, MessagePort E2EE, React Fiber).
 * 2. Theo dõi trực tiếp và chụp ảnh vi sai (Snapshot Diffing) các khung chat để bắt 100% tin nhắn E2EE
 *    ngay cả khi Facebook mã hóa hoàn toàn luồng Worker.
 * 3. Lưu vào chrome.storage.local, hiện thông báo Toast và hiển thị nội dung gốc ngay dưới thông báo thu hồi.
 */

(function () {
  const LOG_PREFIX = '[FB-Unsend-Content]';
  const STORAGE_KEY_MESSAGES = 'fb_captured_messages_v1';
  const STORAGE_KEY_UNSENT = 'fb_unsent_messages_v1';
  const MAX_STORED_MESSAGES = 1000;

  // Map lưu tin nhắn theo ID từ tầng ngầm / React Fiber: messageId -> messageObj
  const messagesById = new Map();
  // Map lưu dữ liệu gắn với phần tử DOM dòng tin nhắn
  const domRowMessages = new WeakMap();
  // Danh sách tin nhắn đã bắt được
  let recentMessagesList = [];
  // Danh sách tin nhắn đã bị gỡ
  let unsentMessagesList = [];

  // Lưu trạng thái ảnh chụp (Snapshot) các tin nhắn đang hiển thị trên màn hình để so sánh vi sai khi có tin bị gỡ
  // Map: textOrKey -> { text, attachments, senderName, timestamp, element }
  let visibleMessagesSnapshot = new Map();

  // Mẫu nhận diện thông báo thu hồi của Facebook (Tiếng Việt & Tiếng Anh)
  const UNSEND_REGEX =
    /(đã thu hồi một tin nhắn|bạn đã thu hồi một tin nhắn|đã gỡ một tin nhắn|bạn đã gỡ một tin nhắn|tin nhắn đã bị thu hồi|tin nhắn đã được thu hồi|unsent a message|you unsent a message|removed a message|message was unsent)/i;

  // Các nhãn trạng thái giao diện của Facebook cần bỏ qua khi trích xuất văn bản tin nhắn
  const UI_IGNORE_REGEX =
    /^(Đã gửi|Đã nhận|Đã xem|Đang gửi|Đang viết|Sent|Delivered|Seen|Sending|Typing|Enter|Nhấn Enter để gửi|Được mã hóa đầu cuối|End-to-end encrypted|Trả lời|Reply|Chuyển tiếp|Forward|Xem thêm|See more|\d{1,2}:\d{2}(\s?[AP]M)?)$/i;

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
        `${LOG_PREFIX} Đã tải ${recentMessagesList.length} tin nhắn lưu tạm và ${unsentMessagesList.length} tin nhắn bị gỡ.`
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

  // Yêu cầu injected.js (MAIN world) quét React Fiber để lấy messageId của tin nhắn E2EE
  let fiberScanTimer = null;
  function requestMainWorldFiberScan() {
    if (fiberScanTimer) return;
    fiberScanTimer = setTimeout(() => {
      fiberScanTimer = null;
      try {
        window.postMessage(
          {
            source: 'FB_UNSEND_EXTENSION_CONTENT',
            type: 'SCAN_FIBER'
          },
          '*'
        );
      } catch (_) {}
    }, 120);
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
      handleCapturedMessage(payload);
    } else if (type === 'FB_MSG_UNSENT') {
      handleUnsentEvent(payload);
    }
  });

  function handleCapturedMessage(msg) {
    if (!msg.messageId) return;

    const existing = messagesById.get(msg.messageId);
    const merged = {
      ...existing,
      ...msg,
      text: existing?.text || msg.text || '',
      attachments:
        msg.attachments && msg.attachments.length > 0
          ? msg.attachments
          : existing?.attachments || [],
      senderName: msg.senderName || existing?.senderName || findActiveThreadName() || '',
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

  function handleUnsentEvent(unsentData) {
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
      senderName:
        existing?.senderName ||
        unsentData.senderName ||
        findActiveThreadName() ||
        'Cuộc trò chuyện Facebook',
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

    if (record.text || record.attachments.length > 0) {
      showUnsentToast(record);
    }

    setTimeout(() => scanDomForMessagesAndUnsent(record), 100);
  }

  // ============================================================================
  // 2. THEO DÕI TRỰC TIẾP KHUNG CHAT (DOM & SNAPSHOT DIFFING CHO E2EE)
  // ============================================================================

  function findActiveThreadName() {
    try {
      const headerEl = document.querySelector(
        'div[role="main"] h1, div[role="main"] h2, div[role="dialog"] h2, div[aria-label*="Cuộc trò chuyện"] h2, div[aria-label*="Conversation"] h2'
      );
      if (headerEl && headerEl.innerText) {
        return headerEl.innerText.trim().split('\n')[0];
      }
    } catch (_) {}
    return '';
  }

  /**
   * Tìm phần tử bao ngoài của một dòng tin nhắn trên Facebook (hỗ trợ cả giao diện cũ và E2EE mới)
   */
  function getMessageRowContainer(el) {
    if (!el || !(el instanceof HTMLElement)) return null;
    return (
      el.closest(
        'div[role="row"], div[role="gridcell"], div[data-scope="messages_table"]'
      ) ||
      el.parentElement?.parentElement ||
      el.parentElement
    );
  }

  /**
   * Trích xuất văn bản và hình ảnh đính kèm trong một phần tử dòng tin nhắn
   */
  function extractRowContent(rowEl) {
    if (!rowEl || !(rowEl instanceof HTMLElement)) return { text: '', attachments: [] };

    const texts = [];
    const dirAutoEls = rowEl.querySelectorAll('div[dir="auto"], span[dir="auto"]');

    dirAutoEls.forEach((el) => {
      // Không lấy nội dung bên trong hộp khôi phục của chính extension
      if (el.closest('.fb-unsend-restored-box')) return;
      const t = (el.innerText || '').trim();
      if (!t) return;
      if (UNSEND_REGEX.test(t) || UI_IGNORE_REGEX.test(t)) return;
      if (!texts.includes(t)) {
        texts.push(t);
      }
    });

    const attachments = [];
    rowEl.querySelectorAll('img, video, audio').forEach((mediaEl) => {
      if (mediaEl.closest('.fb-unsend-restored-box')) return;
      const src = mediaEl.currentSrc || mediaEl.src || '';
      if (!src || src.startsWith('data:image/svg')) return;

      if (mediaEl.tagName === 'IMG') {
        const w = mediaEl.naturalWidth || mediaEl.width || 0;
        const h = mediaEl.naturalHeight || mediaEl.height || 0;
        // Bỏ qua ảnh avatar nhỏ (<= 40px) hoặc icon cảm xúc nhỏ (<= 24px)
        if (w > 0 && w <= 40 && h > 0 && h <= 40) return;
      }

      if (!attachments.includes(src)) {
        attachments.push(src);
      }
    });

    return {
      text: texts.join('\n').trim(),
      attachments
    };
  }

  /**
   * Tìm tất cả các phần tử đang hiển thị câu thông báo thu hồi ("đã thu hồi một tin nhắn" / "unsent a message")
   */
  function findUnsentNoticeElements() {
    const results = [];
    if (!document.body) return results;

    const candidates = document.querySelectorAll(
      'div[role="row"] div, div[role="row"] span, div[role="gridcell"] div, div[role="gridcell"] span, div[data-scope="messages_table"] div, div[data-scope="messages_table"] span, div[role="main"] span, div[role="dialog"] span'
    );

    candidates.forEach((el) => {
      if (el.closest('.fb-unsend-restored-box') || el.closest('#fb-unsend-toast-container')) {
        return;
      }
      // Tìm phần tử lá trực tiếp chứa text thông báo thu hồi
      if (el.childElementCount === 0) {
        const txt = (el.textContent || '').trim();
        if (txt && txt.length < 120 && UNSEND_REGEX.test(txt)) {
          results.push(el);
        }
      }
    });

    return results;
  }

  /**
   * Quét toàn bộ khung chat để:
   * 1. Ghi nhận mọi tin nhắn đang hiển thị (kể cả tin nhắn E2EE) vào Snapshot và Storage.
   * 2. Phát hiện bất kỳ tin nhắn nào vừa biến thành thông báo thu hồi để khôi phục ngay lập tức.
   */
  function scanDomForMessagesAndUnsent(specificRecord = null) {
    if (!document.body) return;

    const currentVisibleKeys = new Set();
    const newSnapshot = new Map();

    // 1. Quét tất cả các phần tử tin nhắn có nội dung văn bản (div[dir="auto"]) hoặc media
    const messageElements = document.querySelectorAll(
      'div[role="row"], div[role="gridcell"], div[data-scope="messages_table"], div[role="main"] div[dir="auto"], div[role="dialog"] div[dir="auto"]'
    );

    const processedContainers = new WeakSet();

    messageElements.forEach((el) => {
      if (el.closest('.fb-unsend-restored-box') || el.closest('#fb-unsend-toast-container')) {
        return;
      }
      // Không lấy phần tử trong ô nhập tin nhắn (textbox)
      if (el.closest('[role="textbox"], [contenteditable="true"]')) {
        return;
      }

      const rowContainer = getMessageRowContainer(el) || el;
      if (processedContainers.has(rowContainer)) return;
      processedContainers.add(rowContainer);

      const extracted = extractRowContent(rowContainer);
      if (extracted.text || extracted.attachments.length > 0) {
        const prev = domRowMessages.get(rowContainer);
        const fiberMsgId = rowContainer.dataset?.fbMsgId;
        const msgId =
          fiberMsgId ||
          prev?.messageId ||
          `dom_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

        const record = {
          messageId: msgId,
          text: extracted.text || prev?.text || '',
          attachments:
            extracted.attachments.length > 0
              ? extracted.attachments
              : prev?.attachments || [],
          senderName: findActiveThreadName() || prev?.senderName || 'Facebook Chat',
          timestamp: prev?.timestamp || Date.now()
        };

        domRowMessages.set(rowContainer, record);

        // Lưu dự phòng vào dataset của phần tử dòng và phần tử cha để không bị mất khi React cập nhật con bên trong
        if (record.text) {
          rowContainer.dataset.fbUnsendSavedText = record.text;
          if (rowContainer.parentElement) {
            rowContainer.parentElement.dataset.fbUnsendSavedText = record.text;
          }
        }
        if (record.attachments.length > 0) {
          const mediaJson = JSON.stringify(record.attachments);
          rowContainer.dataset.fbUnsendSavedMedia = mediaJson;
          if (rowContainer.parentElement) {
            rowContainer.parentElement.dataset.fbUnsendSavedMedia = mediaJson;
          }
        }

        // Đưa vào Snapshot hiện tại để đối chiếu vi sai nếu lát nữa tin nhắn này bị gỡ
        const snapshotKey = `${record.text}__${record.attachments.join(',')}`;
        currentVisibleKeys.add(snapshotKey);
        newSnapshot.set(snapshotKey, {
          ...record,
          rowContainer
        });

        // Nếu là tin nhắn mới trên DOM chưa từng được ghi nhận, lưu vào recentMessagesList và in log
        if (!prev && (record.text || record.attachments.length > 0)) {
          const alreadyLogged = recentMessagesList.some(
            (m) =>
              m.messageId === record.messageId ||
              (m.text === record.text && Math.abs((m.timestamp || 0) - record.timestamp) < 5000)
          );
          if (!alreadyLogged) {
            console.log(
              `${LOG_PREFIX} 💬 Đã ghi nhận tin nhắn trên khung chat [${record.messageId}]:`,
              record.text || `(Media: ${record.attachments.length})`
            );
            handleCapturedMessage(record);
          }
        }
      }
    });

    // 2. Tìm xem có tin nhắn nào vừa biến mất khỏi Snapshot trước đó không
    const disappearedMessages = [];
    for (const [key, oldRecord] of visibleMessagesSnapshot.entries()) {
      if (!currentVisibleKeys.has(key)) {
        disappearedMessages.push(oldRecord);
      }
    }

    // 3. Quét tất cả các thông báo thu hồi ("đã thu hồi một tin nhắn" / "unsent a message") trên màn hình
    const unsentNoticeEls = findUnsentNoticeElements();
    unsentNoticeEls.forEach((noticeEl) => {
      const rowContainer = getMessageRowContainer(noticeEl) || noticeEl.parentElement;
      if (!rowContainer) return;

      // Nếu dòng này đã được chèn hộp khôi phục rồi thì bỏ qua
      if (
        rowContainer.querySelector('.fb-unsend-restored-box') ||
        noticeEl.parentElement?.querySelector('.fb-unsend-restored-box')
      ) {
        return;
      }

      // Tìm dữ liệu gốc của tin nhắn vừa bị gỡ theo thứ tự ưu tiên chính xác nhất:
      let restored = specificRecord;

      // Ưu tiên 1: Kiểm tra bộ nhớ WeakMap gắn trực tiếp với rowContainer
      if (!restored || (!restored.text && !restored.attachments?.length)) {
        restored = domRowMessages.get(rowContainer);
      }

      // Ưu tiên 2: Kiểm tra dataset dự phòng trên rowContainer hoặc phần tử cha
      if (!restored || (!restored.text && !restored.attachments?.length)) {
        const savedText =
          rowContainer.dataset?.fbUnsendSavedText ||
          rowContainer.parentElement?.dataset?.fbUnsendSavedText;
        const savedMediaStr =
          rowContainer.dataset?.fbUnsendSavedMedia ||
          rowContainer.parentElement?.dataset?.fbUnsendSavedMedia;
        if (savedText || savedMediaStr) {
          let attachments = [];
          try {
            if (savedMediaStr) attachments = JSON.parse(savedMediaStr);
          } catch (_) {}
          restored = {
            messageId: rowContainer.dataset?.fbMsgId || `dom_unsend_${Date.now()}`,
            text: savedText || '',
            attachments,
            senderName: findActiveThreadName() || 'Facebook Chat',
            timestamp: Date.now()
          };
        }
      }

      // Ưu tiên 3: Kiểm tra theo Message ID từ React Fiber (data-fb-msg-id)
      if (!restored || (!restored.text && !restored.attachments?.length)) {
        const fiberId =
          rowContainer.dataset?.fbMsgId || rowContainer.parentElement?.dataset?.fbMsgId;
        if (fiberId && messagesById.has(fiberId)) {
          restored = messagesById.get(fiberId);
        }
      }

      // Ưu tiên 4: Phép so sánh vi sai (Snapshot Diffing) - Tin nhắn vừa biến mất khỏi màn hình ngay lúc xuất hiện dòng thu hồi!
      if (!restored || (!restored.text && !restored.attachments?.length)) {
        if (disappearedMessages.length > 0) {
          restored = disappearedMessages.pop();
        }
      }

      // Ưu tiên 5: Đối chiếu với danh sách tin nhắn bắt ngầm gần đây không còn hiển thị trên khung chat
      if (!restored || (!restored.text && !restored.attachments?.length)) {
        const chatArea =
          rowContainer.closest('div[role="main"], div[role="dialog"]') || document.body;
        const visibleText = chatArea.innerText || '';
        for (let i = recentMessagesList.length - 1; i >= 0; i--) {
          const cand = recentMessagesList[i];
          if (cand.text && !visibleText.includes(cand.text)) {
            restored = cand;
            break;
          }
        }
      }

      // Nếu tìm thấy nội dung gốc -> Hiển thị lên khung chat + Báo Toast + Lưu lịch sử!
      if (
        restored &&
        (restored.text || (restored.attachments && restored.attachments.length > 0))
      ) {
        renderRestoredContentInDom(noticeEl, restored);

        const msgId = restored.messageId || `unsend_${Date.now()}`;
        const alreadyInUnsent = unsentMessagesList.some(
          (u) =>
            u.messageId === msgId ||
            (u.text === restored.text && Math.abs((u.unsentAt || 0) - Date.now()) < 8000)
        );

        if (!alreadyInUnsent) {
          const unsentRecord = {
            messageId: msgId,
            text: restored.text || '',
            attachments: restored.attachments || [],
            senderName:
              restored.senderName || findActiveThreadName() || 'Cuộc trò chuyện Facebook',
            timestamp: restored.timestamp || Date.now(),
            unsentAt: Date.now(),
            isUnsent: true
          };

          console.log(
            `${LOG_PREFIX} 🚨 ĐÃ KHÔI PHỤC TIN NHẮN BỊ GỠ [${msgId}]:`,
            unsentRecord.text || `(Media: ${unsentRecord.attachments.length})`
          );

          unsentMessagesList.unshift(unsentRecord);
          saveToStorage();
          showUnsentToast(unsentRecord);
        }
      }
    });

    // Cập nhật Snapshot mới (giữ lại các tin nhắn khi vẫn đang trong cùng khung chat)
    if (newSnapshot.size > 0 || unsentNoticeEls.length > 0) {
      visibleMessagesSnapshot = newSnapshot;
    }
  }

  /**
   * Chèn hộp hiển thị nội dung tin nhắn gốc ngay bên dưới dòng "đã thu hồi một tin nhắn"
   */
  function renderRestoredContentInDom(noticeEl, data) {
    const targetParent = noticeEl.parentElement || noticeEl;
    if (targetParent.querySelector('.fb-unsend-restored-box')) return;

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
        img.title = 'Nhấn để mở media gốc';
        img.addEventListener('click', () => window.open(url, '_blank'));
        mediaContainer.appendChild(img);
      });
      box.appendChild(mediaContainer);
    }

    targetParent.appendChild(box);
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
  let domScanScheduled = false;
  function scheduleDomScan() {
    if (domScanScheduled) return;
    domScanScheduled = true;
    requestMainWorldFiberScan();
    setTimeout(() => {
      domScanScheduled = false;
      scanDomForMessagesAndUnsent();
    }, 80);
  }

  function startDomObserver() {
    if (!document.body) {
      window.addEventListener('DOMContentLoaded', startDomObserver, { once: true });
      return;
    }

    scanDomForMessagesAndUnsent();

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'childList' || mutation.type === 'characterData') {
          scheduleDomScan();
          break;
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
