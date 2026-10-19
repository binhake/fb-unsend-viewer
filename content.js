/**
 * content.js - Chạy trong ISOLATED world trên facebook.com
 * Nhiệm vụ:
 * 1. Nhận dữ liệu tin nhắn mới & sự kiện thu hồi từ injected.js.
 * 2. Chỉ theo dõi các dòng tin nhắn thực sự trong khung chat (div[data-scope="messages_table"]),
 *    không quét nhầm News Feed, Stories hay danh sách hội thoại bên ngoài.
 * 3. Phát hiện chính xác thông báo "đã xóa một tin nhắn" / "đã thu hồi một tin nhắn" mới xuất hiện,
 *    đối chiếu với tin nhắn vừa biến mất (Snapshot Diffing) hoặc dữ liệu đã lưu để khôi phục ngay lập tức.
 */

(function () {
  const LOG_PREFIX = '[FB-Unsend-Content]';
  // Đổi khóa lưu trữ sang v2 để xóa sạch dữ liệu lịch sử cũ bị bắt nhầm ở bản thử nghiệm trước
  const STORAGE_KEY_MESSAGES = 'fb_captured_messages_v2';
  const STORAGE_KEY_UNSENT = 'fb_unsent_messages_v2';
  const MAX_STORED_MESSAGES = 500;

  const messagesById = new Map();
  const domRowMessages = new WeakMap();
  let recentMessagesList = [];
  let unsentMessagesList = [];

  // Ảnh chụp các dòng tin nhắn đang hiển thị trong khung chat hiện tại
  // Map: rowKey -> { messageId, text, attachments, senderName, timestamp, rowIndex }
  let visibleMessagesSnapshot = new Map();
  let isInitialScanDone = false;

  // Mẫu nhận diện thông báo thu hồi / xóa tin nhắn trên Facebook (bao gồm "đã xóa một tin nhắn")
  const UNSEND_REGEX =
    /(đã xóa một tin nhắn|đã xoá một tin nhắn|bạn đã xóa một tin nhắn|bạn đã xoá một tin nhắn|đã thu hồi một tin nhắn|bạn đã thu hồi một tin nhắn|đã gỡ một tin nhắn|bạn đã gỡ một tin nhắn|tin nhắn đã bị thu hồi|tin nhắn đã được thu hồi|tin nhắn đã bị xóa|unsent a message|you unsent a message|deleted a message|you deleted a message|removed a message|message was unsent)/i;

  // Các nhãn giao diện cần bỏ qua khi đọc text trong dòng chat
  const UI_IGNORE_REGEX =
    /^(Đã gửi|Đã nhận|Đã xem|Đang gửi|Đang viết|Sent|Delivered|Seen|Sending|Typing|Enter|Nhấn Enter để gửi|Được mã hóa đầu cuối|End-to-end encrypted|Trả lời|Reply|Chuyển tiếp|Forward|Xem thêm|See more|Bạn đã chuyển tiếp một tin nhắn|\d{1,2}:\d{2}(\s?[AP]M)?(\s+T\d|\s+CN)?)$/i;

  function loadFromStorage() {
    if (!chrome?.storage?.local) return;
    // Dọn dẹp khóa v1 cũ nếu có
    chrome.storage.local.remove(['fb_captured_messages_v1', 'fb_unsent_messages_v1']);

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
        `${LOG_PREFIX} Đã sẵn sàng (${recentMessagesList.length} tin nhắn lưu tạm, ${unsentMessagesList.length} tin nhắn bị gỡ).`
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
    }, 100);
  }

  // ============================================================================
  // 1. NHẬN SỰ KIỆN TỪ TẦNG NGẦM (injected.js)
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

    if (!originalText && originalAttachments.length === 0) return;

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
      showUnsentToast(record);
    }

    saveToStorage();
    setTimeout(() => scanChatMessagesInDom(record), 80);
  }

  // ============================================================================
  // 2. QUÉT CHÍNH XÁC CÁC DÒNG TIN NHẮN TRONG KHUNG CHAT (KHÔNG QUÉT NEWS FEED)
  // ============================================================================

  function findActiveThreadName(contextEl = null) {
    try {
      if (contextEl instanceof HTMLElement) {
        const chatDialog = contextEl.closest('div[role="dialog"], div[role="main"]');
        if (chatDialog) {
          const h2 = chatDialog.querySelector('h1, h2');
          if (h2 && h2.innerText) {
            return h2.innerText.trim().split('\n')[0];
          }
        }
      }
      const headerEl = document.querySelector(
        'div[aria-label*="Cuộc trò chuyện"] h2, div[aria-label*="Conversation"] h2, div[role="dialog"] h2, div[role="main"] h1'
      );
      if (headerEl && headerEl.innerText) {
        return headerEl.innerText.trim().split('\n')[0];
      }
    } catch (_) {}
    return 'Facebook Chat';
  }

  /**
   * Lấy danh sách các phần tử dòng tin nhắn THỰC SỰ nằm trong cửa sổ chat đang mở
   * Trên Facebook, mỗi cụm/dòng tin nhắn trong khung chat luôn có div[data-scope="messages_table"]
   */
  function getActualChatRows() {
    if (!document.body) return [];
    const rows = Array.from(document.querySelectorAll('div[data-scope="messages_table"]'));
    return rows.filter((row) => {
      // Loại bỏ nếu nằm trong menu danh sách hội thoại bên ngoài
      if (row.closest('[aria-label="Đoạn chat"], [aria-label="Chats"]')) return false;
      return true;
    });
  }

  /**
   * Trích xuất nội dung của một dòng tin nhắn trong khung chat:
   * Phân biệt rõ:
   * - isUnsentRow: Dòng này đang hiển thị câu "Bình đã xóa một tin nhắn" / "đã thu hồi một tin nhắn"
   * - text: Nội dung văn bản của tin nhắn (không lấy tên người gửi ở đầu dòng)
   * - attachments: Hình ảnh / Video / Sticker trong tin nhắn
   */
  function analyzeChatRow(rowEl) {
    if (!rowEl || !(rowEl instanceof HTMLElement)) {
      return {
        isUnsentRow: false,
        alreadyRestored: false,
        unsentNoticeEl: null,
        text: '',
        attachments: []
      };
    }

    // Nếu dòng này đã được khôi phục trước đó thì bỏ qua ngay, không quét lại
    if (
      rowEl.dataset.fbUnsendRestored === 'true' ||
      rowEl.querySelector('.fb-unsend-restored-bubble, .fb-unsend-inline-text')
    ) {
      return {
        isUnsentRow: true,
        alreadyRestored: true,
        unsentNoticeEl: null,
        text: '',
        attachments: []
      };
    }

    // 1. Kiểm tra xem dòng này có chứa thông báo thu hồi / xóa tin nhắn không
    let unsentNoticeEl = null;
    const allElements = rowEl.querySelectorAll('div, span');
    for (const el of allElements) {
      if (el.childElementCount === 0) {
        const txt = (el.textContent || '').trim();
        if (txt && txt.length < 120 && UNSEND_REGEX.test(txt)) {
          unsentNoticeEl = el;
          break;
        }
      }
    }

    if (unsentNoticeEl) {
      return {
        isUnsentRow: true,
        alreadyRestored: false,
        unsentNoticeEl,
        text: '',
        attachments: []
      };
    }

    // 2. Nếu là dòng tin nhắn bình thường -> Trích xuất văn bản tin nhắn trong div[dir="auto"]
    const texts = [];
    const textNodes = rowEl.querySelectorAll('div[dir="auto"]');
    textNodes.forEach((el) => {
      // Bỏ qua tiêu đề tên người gửi (thường nằm trong thẻ h4, h5 hoặc span role="presentation" phía trên bong bóng)
      if (el.closest('h3, h4, h5, h6')) return;

      const t = (el.innerText || '').trim();
      if (!t) return;
      if (UNSEND_REGEX.test(t) || UI_IGNORE_REGEX.test(t)) return;
      if (!texts.includes(t)) {
        texts.push(t);
      }
    });

    // 3. Trích xuất hình ảnh / sticker / video trong dòng tin nhắn (bỏ qua avatar người gửi)
    const attachments = [];
    rowEl.querySelectorAll('img, video, audio').forEach((mediaEl) => {
      const src = mediaEl.currentSrc || mediaEl.src || '';
      if (!src || src.startsWith('data:image/svg')) return;

      if (mediaEl.tagName === 'IMG') {
        const rect = mediaEl.getBoundingClientRect();
        const displayW = rect.width || mediaEl.clientWidth || mediaEl.width || 0;
        const displayH = rect.height || mediaEl.clientHeight || mediaEl.height || 0;
        // Avatar người gửi (28x28 - 40x40), icon đã xem (14x14) và emoji nhỏ luôn có kích thước hiển thị <= 52px
        if (
          (displayW > 0 && displayW <= 52 && displayH > 0 && displayH <= 52) ||
          mediaEl.closest('a[role="link"], svg, [role="button"][aria-label*="cảm xúc"]')
        ) {
          return;
        }
      }

      if (!attachments.includes(src)) {
        attachments.push(src);
      }
    });

    return {
      isUnsentRow: false,
      alreadyRestored: false,
      unsentNoticeEl: null,
      text: texts.join('\n').trim(),
      attachments
    };
  }

  /**
   * Quét toàn bộ các dòng tin nhắn trong khung chat
   */
  function scanChatMessagesInDom(specificRecord = null) {
    const chatRows = getActualChatRows();
    if (chatRows.length === 0) return;

    const currentSnapshot = new Map();
    const currentUnsentRows = [];

    chatRows.forEach((rowEl, index) => {
      const analysis = analyzeChatRow(rowEl);
      const threadName = findActiveThreadName(rowEl);

      if (analysis.isUnsentRow) {
        if (!analysis.alreadyRestored && analysis.unsentNoticeEl) {
          currentUnsentRows.push({
            rowEl,
            noticeEl: analysis.unsentNoticeEl,
            rowIndex: index,
            threadName
          });
        }
        return;
      }

      if (analysis.text || analysis.attachments.length > 0) {
        const prev = domRowMessages.get(rowEl);
        const fiberMsgId = rowEl.dataset?.fbMsgId;
        const msgId =
          fiberMsgId ||
          prev?.messageId ||
          `dom_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 6)}`;

        const record = {
          messageId: msgId,
          text: analysis.text || prev?.text || '',
          attachments:
            analysis.attachments.length > 0
              ? analysis.attachments
              : prev?.attachments || [],
          senderName: threadName || prev?.senderName || 'Facebook Chat',
          timestamp: prev?.timestamp || Date.now(),
          rowIndex: index
        };

        domRowMessages.set(rowEl, record);

        // Lưu dữ liệu ngay trên phần tử DOM và phần tử cha của nó để khi bị xóa/sửa tại chỗ vẫn đọc lại được
        if (record.text) {
          rowEl.dataset.fbUnsendSavedText = record.text;
          if (rowEl.parentElement) {
            rowEl.parentElement.dataset.fbUnsendSavedText = record.text;
          }
        }
        if (record.attachments.length > 0) {
          const mediaJson = JSON.stringify(record.attachments);
          rowEl.dataset.fbUnsendSavedMedia = mediaJson;
          if (rowEl.parentElement) {
            rowEl.parentElement.dataset.fbUnsendSavedMedia = mediaJson;
          }
        }

        // Lưu vào Snapshot hiện tại
        currentSnapshot.set(record.messageId, record);

        // Chỉ in log và lưu khi có tin nhắn mới xuất hiện trên khung chat
        if (!prev) {
          console.log(
            `${LOG_PREFIX} 💬 Đã ghi nhận tin nhắn trong khung chat [${record.senderName}]:`,
            record.text || `(Đính kèm ${record.attachments.length} media)`
          );
          handleCapturedMessage(record);
        }
      }
    });

    // Tìm các tin nhắn vừa biến mất khỏi khung chat so với Snapshot ngay trước đó
    const disappearedMessages = [];
    if (isInitialScanDone && visibleMessagesSnapshot.size > 0) {
      // Kiểm tra xem có còn đang ở cùng khung chat không
      const currentTexts = new Set(
        Array.from(currentSnapshot.values()).map((r) => r.text)
      );
      for (const [id, oldRec] of visibleMessagesSnapshot.entries()) {
        if (!currentSnapshot.has(id) && (!oldRec.text || !currentTexts.has(oldRec.text))) {
          disappearedMessages.push(oldRec);
        }
      }
    }

    // Xử lý các dòng có thông báo "đã xóa một tin nhắn" / "đã thu hồi một tin nhắn"
    currentUnsentRows.forEach(({ rowEl, noticeEl, rowIndex, threadName }) => {
      if (rowEl.dataset.fbUnsendRestored === 'true') return;

      // Tìm dữ liệu gốc của dòng vừa bị xóa
      let restored = specificRecord;

      // Cách 1: Kiểm tra bộ nhớ gắn trực tiếp trên rowEl (nếu React giữ nguyên phần tử div[data-scope="messages_table"])
      if (!restored || (!restored.text && !restored.attachments?.length)) {
        restored = domRowMessages.get(rowEl);
      }

      // Cách 2: Kiểm tra dataset dự phòng trên rowEl hoặc phần tử cha
      if (!restored || (!restored.text && !restored.attachments?.length)) {
        const savedText =
          rowEl.dataset?.fbUnsendSavedText ||
          rowEl.parentElement?.dataset?.fbUnsendSavedText;
        const savedMediaStr =
          rowEl.dataset?.fbUnsendSavedMedia ||
          rowEl.parentElement?.dataset?.fbUnsendSavedMedia;
        if (savedText || savedMediaStr) {
          let attachments = [];
          try {
            if (savedMediaStr) attachments = JSON.parse(savedMediaStr);
          } catch (_) {}
          restored = {
            messageId: rowEl.dataset?.fbMsgId || `unsend_${Date.now()}_${rowIndex}`,
            text: savedText || '',
            attachments,
            senderName: threadName,
            timestamp: Date.now()
          };
        }
      }

      // Cách 3: Kiểm tra theo Message ID từ React Fiber
      if (!restored || (!restored.text && !restored.attachments?.length)) {
        const fiberId = rowEl.dataset?.fbMsgId || rowEl.parentElement?.dataset?.fbMsgId;
        if (fiberId && messagesById.has(fiberId)) {
          restored = messagesById.get(fiberId);
        }
      }

      // Cách 4: Nếu đây là dòng thông báo xóa MỚI xuất hiện (không phải dòng đã xóa cũ từ lúc mới mở khung chat)
      // thì ghép với tin nhắn vừa biến mất khỏi khung chat (Snapshot Diffing)!
      if (!restored || (!restored.text && !restored.attachments?.length)) {
        if (!rowEl.dataset.fbUnsendOldNotice && disappearedMessages.length > 0) {
          // Tìm tin nhắn biến mất có vị trí dòng (rowIndex) gần với dòng vừa bị xóa nhất
          disappearedMessages.sort(
            (a, b) => Math.abs((a.rowIndex || 0) - rowIndex) - Math.abs((b.rowIndex || 0) - rowIndex)
          );
          restored = disappearedMessages.shift();
        }
      }

      // Nếu tìm được nội dung gốc -> Khôi phục ngay lên màn hình + Hiện Toast + Lưu lịch sử!
      if (
        restored &&
        (restored.text || (restored.attachments && restored.attachments.length > 0))
      ) {
        renderRestoredContentInDom(rowEl, noticeEl, restored);

        const msgId = restored.messageId || `unsend_${Date.now()}`;
        const alreadySaved = unsentMessagesList.some(
          (u) =>
            u.messageId === msgId ||
            (u.text === restored.text && Math.abs((u.unsentAt || 0) - Date.now()) < 10000)
        );

        if (!alreadySaved) {
          const unsentRecord = {
            messageId: msgId,
            text: restored.text || '',
            attachments: restored.attachments || [],
            senderName: restored.senderName || threadName || 'Facebook Chat',
            timestamp: restored.timestamp || Date.now(),
            unsentAt: Date.now(),
            isUnsent: true
          };

          console.log(
            `${LOG_PREFIX} 🚨 ĐÃ KHÔI PHỤC TIN NHẮN BỊ GỠ [${unsentRecord.senderName}]:`,
            unsentRecord.text || `(Đính kèm ${unsentRecord.attachments.length} media)`
          );

          unsentMessagesList.unshift(unsentRecord);
          saveToStorage();
          showUnsentToast(unsentRecord);
        }
      } else {
        // Nếu dòng này đã bị xóa từ trước khi mở khung chat (không có dữ liệu gốc),
        // đánh dấu là dòng cũ để không lấy nhầm tin nhắn mới sau này gắn vào đây
        rowEl.dataset.fbUnsendOldNotice = 'true';
      }
    });

    visibleMessagesSnapshot = currentSnapshot;
    isInitialScanDone = true;
  }

  /**
   * Tìm phần tử bong bóng gốc có chứa viền (border / border-radius) bao quanh câu "Bình đã xóa một tin nhắn"
   */
  function findOriginalBubbleElement(noticeEl, rowEl) {
    let curr = noticeEl;
    let roundedCandidate = null;

    for (let depth = 0; depth < 6 && curr && curr !== rowEl; depth++) {
      try {
        const cs = window.getComputedStyle(curr);
        const borderW = parseFloat(cs.borderTopWidth) || parseFloat(cs.borderLeftWidth) || 0;
        const radius = parseFloat(cs.borderTopLeftRadius) || 0;

        if (borderW > 0 && cs.borderTopStyle !== 'none') {
          return curr;
        }
        if (!roundedCandidate && radius >= 10) {
          roundedCandidate = curr;
        }
      } catch (_) {}
      curr = curr.parentElement;
    }

    return roundedCandidate || noticeEl.parentElement || noticeEl;
  }

  /**
   * Đổi viền gốc của bong bóng tin nhắn sang đỏ và nối nội dung trực tiếp thành:
   * "Bình đã xóa một tin nhắn: <nội dung>"
   */
  function renderRestoredContentInDom(rowEl, noticeEl, data) {
    if (!noticeEl || rowEl.dataset.fbUnsendRestored === 'true') return;
    rowEl.dataset.fbUnsendRestored = 'true';

    // 1. Chuyển viền gốc của bong bóng tin nhắn thành màu đỏ
    const bubbleEl = findOriginalBubbleElement(noticeEl, rowEl);
    if (bubbleEl) {
      bubbleEl.classList.add('fb-unsend-restored-bubble');
    }

    // 2. Thay "Bình đã xóa một tin nhắn" thành "Bình đã xóa một tin nhắn: nội dung"
    const baseText = (noticeEl.textContent || '').trim().replace(/\.+$/, '');
    const displayContent = data.text
      ? data.text
      : data.attachments?.length
        ? `[Đính kèm ${data.attachments.length} media]`
        : '';

    if (displayContent) {
      if (noticeEl.firstChild && noticeEl.firstChild.nodeType === Node.TEXT_NODE) {
        noticeEl.firstChild.nodeValue = `${baseText}: `;
      } else {
        noticeEl.textContent = `${baseText}: `;
      }

      const contentSpan = document.createElement('span');
      contentSpan.className = 'fb-unsend-inline-text';
      contentSpan.textContent = displayContent;
      noticeEl.appendChild(contentSpan);
    }

    // 3. Nếu có đính kèm hình ảnh / sticker thì hiển thị ngay bên dưới câu chữ trong cùng bong bóng
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
      (bubbleEl || noticeEl.parentElement || noticeEl).appendChild(mediaContainer);
    }
  }

  /**
   * Hiển thị thông báo nổi (Toast) ở góc dưới màn hình khi có tin nhắn bị gỡ
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
  // 3. KHỞI ĐỘNG MUTATION OBSERVER (SAU KHI TRANG TẢI XONG ĐỂ TRÁNH REACT ERROR #418)
  // ============================================================================
  let domScanScheduled = false;
  function scheduleDomScan() {
    if (domScanScheduled) return;
    domScanScheduled = true;
    requestMainWorldFiberScan();
    setTimeout(() => {
      domScanScheduled = false;
      scanChatMessagesInDom();
    }, 80);
  }

  function startDomObserver() {
    if (!document.body) {
      window.addEventListener('DOMContentLoaded', startDomObserver, { once: true });
      return;
    }

    // Đợi 1 giây sau khi trang khởi tạo xong để không ảnh hưởng quá trình Hydrate của React (#418)
    setTimeout(() => {
      scanChatMessagesInDom();

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
    }, 1000);
  }

  loadFromStorage();
  startDomObserver();
})();
