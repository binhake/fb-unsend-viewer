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

  function isGenericSenderName(name) {
    if (!name || typeof name !== 'string') return true;
    const trimmed = name.trim();
    return (
      !trimmed ||
      /^(Facebook Chat|Facebook|Messenger|Đoạn chat|Chats|Chat)$/i.test(trimmed)
    );
  }

  function extractNameFromNotice(noticeText) {
    if (!noticeText || typeof noticeText !== 'string') return '';
    // Bỏ phần ": <nội dung khôi phục>" nếu chuỗi đã được nối
    const beforeColon = noticeText.split(':')[0] || noticeText;
    const cleaned = beforeColon
      .replace(
        /\s*(đã xóa một tin nhắn|đã xoá một tin nhắn|đã thu hồi một tin nhắn|đã gỡ một tin nhắn|unsent a message|deleted a message|removed a message).*$/i,
        ''
      )
      .trim();
    if (cleaned && cleaned.length >= 1 && cleaned.length < 60 && !/^(tin nhắn|message)$/i.test(cleaned)) {
      return cleaned;
    }
    return '';
  }

  function formatSenderAndThreadName(personName, threadName, fallbackName = '') {
    const cleanPerson = !isGenericSenderName(personName) ? String(personName).trim() : '';
    const cleanThread = !isGenericSenderName(threadName) ? String(threadName).trim() : '';
    const cleanFallback = !isGenericSenderName(fallbackName) ? String(fallbackName).trim() : '';

    if (cleanPerson && cleanThread) {
      const pLower = cleanPerson.toLowerCase();
      const tLower = cleanThread.toLowerCase();
      if (pLower === tLower) {
        return cleanThread;
      }
      // Nếu là chat 1-1 mà tên người gỡ là tên gọi ngắn nằm trong tên đầy đủ của hộp chat (VD: "Bình" trong "Nguyễn Trọng Bình")
      if (tLower.includes(pLower) && !/^(bạn|you)$/i.test(cleanPerson) && !cleanThread.includes('|')) {
        return cleanThread;
      }
      return `${cleanPerson} • ${cleanThread}`;
    }

    return cleanPerson || cleanThread || cleanFallback || 'Facebook Chat';
  }

  function handleCapturedMessage(msg) {
    if (!msg.messageId) return;

    const existing = messagesById.get(msg.messageId);
    const activeThread = findActiveThreadName();
    const resolvedSenderName = formatSenderAndThreadName(
      msg.personName || existing?.personName || '',
      msg.threadName || existing?.threadName || activeThread,
      msg.senderName || existing?.senderName || ''
    );

    const merged = {
      ...existing,
      ...msg,
      text: existing?.text || msg.text || '',
      attachments:
        msg.attachments && msg.attachments.length > 0
          ? msg.attachments
          : existing?.attachments || [],
      personName: msg.personName || existing?.personName || '',
      threadName: msg.threadName || existing?.threadName || (!isGenericSenderName(activeThread) ? activeThread : ''),
      senderName: resolvedSenderName,
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

  function notifyUnreadBadge() {
    try {
      if (chrome?.runtime?.sendMessage) {
        chrome.runtime.sendMessage({ type: 'INCREMENT_UNREAD_BADGE' });
      }
    } catch (_) {}
  }

  function handleUnsentEvent(unsentData) {
    const existing = messagesById.get(unsentData.messageId);
    const originalText = existing?.text || unsentData.text || '';
    const originalAttachments =
      existing?.attachments?.length > 0
        ? existing.attachments
        : unsentData.attachments || [];

    if (!originalText && originalAttachments.length === 0) return;

    const noticePerson = extractNameFromNotice(unsentData.unsendNotice);
    const activeThread = findActiveThreadName();
    const resolvedSenderName = formatSenderAndThreadName(
      noticePerson || unsentData.personName || existing?.personName || '',
      unsentData.threadName || existing?.threadName || activeThread,
      unsentData.senderName || existing?.senderName || ''
    );

    const record = {
      messageId: unsentData.messageId,
      text: originalText,
      attachments: originalAttachments,
      senderId: existing?.senderId || unsentData.senderId || '',
      threadId: existing?.threadId || unsentData.threadId || '',
      personName: noticePerson || unsentData.personName || existing?.personName || '',
      threadName: unsentData.threadName || existing?.threadName || (!isGenericSenderName(activeThread) ? activeThread : ''),
      senderName: resolvedSenderName,
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
      notifyUnreadBadge();
    }

    saveToStorage();
    setTimeout(() => scanChatMessagesInDom(record), 80);
  }

  // ============================================================================
  // 2. QUÉT CHÍNH XÁC CÁC DÒNG TIN NHẮN TRONG KHUNG CHAT (KHÔNG QUÉT NEWS FEED)
  // ============================================================================

  function findActiveThreadName(contextEl = null, noticeText = '') {
    try {
      if (contextEl instanceof HTMLElement) {
        // Lưu ý: Không dùng div[role="region"] vì vùng cuộn tin nhắn có role="region" nằm bên trong hộp chat,
        // sẽ làm .closest() dừng sớm trước khi tới thanh tiêu đề của cửa sổ chat (div[role="dialog"]).
        const chatContainer = contextEl.closest(
          'div[role="dialog"], div[data-pagelet*="ChatTab"], div[role="main"]'
        );
        if (chatContainer) {
          // 1. Kiểm tra aria-label của cửa sổ chat hoặc vùng con có nhãn "Cuộc trò chuyện với..."
          const ariaCandidates = [
            chatContainer.getAttribute('aria-label') || '',
            chatContainer
              .querySelector(
                '[aria-label*="Cuộc trò chuyện với"], [aria-label*="Đoạn chat với"], [aria-label*="Conversation with"], [aria-label*="Chat with"]'
              )
              ?.getAttribute('aria-label') || ''
          ];

          for (const ariaLabel of ariaCandidates) {
            if (!ariaLabel) continue;
            const stripped = ariaLabel
              .replace(/^(Cuộc trò chuyện với|Đoạn chat với|Conversation with|Chat with)\s+/i, '')
              .trim();
            if (stripped && stripped.length < 80 && !isGenericSenderName(stripped)) {
              return stripped;
            }
          }

          // 2. Kiểm tra thẻ tiêu đề trong phần đầu khung chat
          const headerSelectors = [
            'h1',
            'h2',
            'h3',
            '[role="heading"]',
            'a[role="link"] span[dir="auto"]'
          ];
          for (const sel of headerSelectors) {
            const els = chatContainer.querySelectorAll(sel);
            for (const headerEl of els) {
              // Không lấy nhầm thẻ nằm bên trong bảng tin nhắn
              if (headerEl.closest('div[data-scope="messages_table"]')) continue;
              const name = (headerEl.innerText || headerEl.textContent || '').trim().split('\n')[0];
              if (
                name &&
                name.length >= 2 &&
                name.length < 80 &&
                !isGenericSenderName(name) &&
                !UI_IGNORE_REGEX.test(name)
              ) {
                return name;
              }
            }
          }
        }
      }

      const fromNotice = extractNameFromNotice(noticeText);
      if (fromNotice) return fromNotice;

      const globalHeader = document.querySelector(
        'div[aria-label*="Cuộc trò chuyện với"], div[aria-label*="Conversation with"], div[role="dialog"] h2, div[role="main"] h1'
      );
      if (globalHeader) {
        const aria = globalHeader.getAttribute('aria-label');
        if (aria) {
          const stripped = aria
            .replace(/^(Cuộc trò chuyện với|Đoạn chat với|Conversation with|Chat with)\s+/i, '')
            .trim();
          if (stripped && !isGenericSenderName(stripped)) return stripped;
        }
        if (globalHeader.innerText) {
          const text = globalHeader.innerText.trim().split('\n')[0];
          if (text && !isGenericSenderName(text)) return text;
        }
      }
    } catch (_) {}
    return 'Facebook Chat';
  }

  /**
   * Trích xuất tên người gửi trực tiếp từ dòng tin nhắn DOM (trước hoặc sau khi gỡ)
   */
  function extractSenderFromChatRow(rowEl) {
    if (!rowEl || !(rowEl instanceof HTMLElement)) return '';

    // 1. Kiểm tra thẻ tiêu đề tên người gửi phía trên bong bóng chat (trong nhóm chat)
    const senderHeaders = rowEl.querySelectorAll('h4, h5, h6');
    for (const h of senderHeaders) {
      const raw = (h.innerText || h.textContent || '').trim().split('\n')[0];
      if (!raw) continue;
      if (/^(Bạn đã gửi|You sent)$/i.test(raw)) return 'Bạn';
      if (
        raw.length >= 2 &&
        raw.length <= 60 &&
        !UNSEND_REGEX.test(raw) &&
        !UI_IGNORE_REGEX.test(raw)
      ) {
        return raw;
      }
    }

    // 2. Kiểm tra thuộc tính alt của ảnh avatar người gửi nằm cạnh bong bóng tin nhắn
    const imgs = rowEl.querySelectorAll('img[alt]');
    for (const img of imgs) {
      const alt = (img.getAttribute('alt') || '').trim();
      if (!alt || alt.length < 2 || alt.length > 60) continue;
      if (
        /^(Đã xem|Seen by|Hình ảnh|Ảnh|Image|Photo|Sticker|Nhãn dán|Mở |Open )/i.test(alt) ||
        UI_IGNORE_REGEX.test(alt)
      ) {
        continue;
      }
      // Avatar người gửi luôn có kích thước nhỏ (<= 52px)
      const rect = img.getBoundingClientRect();
      const w = rect.width || img.clientWidth || img.width || 0;
      if (w === 0 || w <= 52) {
        return alt;
      }
    }

    return '';
  }

  /**
   * Chuyển ảnh (đặc biệt là ảnh E2EE dạng blob: vốn sẽ bị Facebook thu hồi ngay khi gỡ)
   * sang dạng Data URL (webp nén nhẹ) để giữ lại vĩnh viễn khi tin nhắn bị xóa
   */
  const cachedImageMap = new Map(); // rawSrc -> dataUrl
  function getOrCacheImageSrc(imgEl) {
    const rawSrc = imgEl.currentSrc || imgEl.src || '';
    if (!rawSrc) return '';
    if (cachedImageMap.has(rawSrc)) {
      return cachedImageMap.get(rawSrc);
    }

    // Nếu ảnh đã tải xong và vẽ được lên canvas (như ảnh blob: trong E2EE)
    if (imgEl.complete && imgEl.naturalWidth > 0 && imgEl.naturalHeight > 0) {
      try {
        const maxDim = 360;
        let w = imgEl.naturalWidth;
        let h = imgEl.naturalHeight;
        if (w > maxDim || h > maxDim) {
          if (w > h) {
            h = Math.round((h * maxDim) / w);
            w = maxDim;
          } else {
            w = Math.round((w * maxDim) / h);
            h = maxDim;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(imgEl, 0, 0, w, h);
        const dataUrl = canvas.toDataURL('image/webp', 0.82);
        if (dataUrl && dataUrl.startsWith('data:image/')) {
          cachedImageMap.set(rawSrc, dataUrl);
          return dataUrl;
        }
      } catch (_) {}
    }

    return rawSrc;
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
   * - rowSenderName: Tên người gửi trích xuất từ dòng chat
   */
  function analyzeChatRow(rowEl) {
    if (!rowEl || !(rowEl instanceof HTMLElement)) {
      return {
        isUnsentRow: false,
        alreadyRestored: false,
        unsentNoticeEl: null,
        text: '',
        attachments: [],
        rowSenderName: ''
      };
    }

    const rowSenderName = extractSenderFromChatRow(rowEl);

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
        attachments: [],
        rowSenderName
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
        attachments: [],
        rowSenderName
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
      const rawSrc = mediaEl.currentSrc || mediaEl.src || '';
      if (!rawSrc || rawSrc.startsWith('data:image/svg')) return;

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

        const cachedSrc = getOrCacheImageSrc(mediaEl);
        if (cachedSrc && !attachments.includes(cachedSrc)) {
          attachments.push(cachedSrc);
        }
        return;
      }

      if (!attachments.includes(rawSrc)) {
        attachments.push(rawSrc);
      }
    });

    return {
      isUnsentRow: false,
      alreadyRestored: false,
      unsentNoticeEl: null,
      text: texts.join('\n').trim(),
      attachments,
      rowSenderName
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
    let lastKnownRowSender = '';

    chatRows.forEach((rowEl, index) => {
      const analysis = analyzeChatRow(rowEl);
      const threadName = findActiveThreadName(rowEl);
      if (analysis.rowSenderName) {
        lastKnownRowSender = analysis.rowSenderName;
      }

      if (analysis.isUnsentRow) {
        if (!analysis.alreadyRestored && analysis.unsentNoticeEl) {
          currentUnsentRows.push({
            rowEl,
            noticeEl: analysis.unsentNoticeEl,
            rowIndex: index,
            threadName,
            rowSenderName: analysis.rowSenderName || rowEl.dataset?.fbUnsendSavedSender || ''
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

        const personName =
          analysis.rowSenderName ||
          prev?.personName ||
          rowEl.dataset?.fbUnsendSavedSender ||
          lastKnownRowSender ||
          '';
        const fullSenderName = formatSenderAndThreadName(
          personName,
          threadName,
          prev?.senderName || ''
        );

        const record = {
          messageId: msgId,
          text: analysis.text || prev?.text || '',
          attachments:
            analysis.attachments.length > 0
              ? analysis.attachments
              : prev?.attachments || [],
          personName,
          threadName: !isGenericSenderName(threadName) ? threadName : prev?.threadName || '',
          senderName: fullSenderName,
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
        if (personName) {
          rowEl.dataset.fbUnsendSavedSender = personName;
          if (rowEl.parentElement) {
            rowEl.parentElement.dataset.fbUnsendSavedSender = personName;
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
    currentUnsentRows.forEach(({ rowEl, noticeEl, rowIndex, threadName, rowSenderName }) => {
      if (rowEl.dataset.fbUnsendRestored === 'true') return;

      // Tìm dữ liệu gốc của dòng vừa bị xóa
      let restored = specificRecord;

      // Cách 1: Kiểm tra bộ nhớ gắn trực tiếp trên rowEl
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
            personName:
              rowSenderName ||
              rowEl.dataset?.fbUnsendSavedSender ||
              rowEl.parentElement?.dataset?.fbUnsendSavedSender ||
              '',
            threadName,
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

      // Cách 4: Snapshot Diffing - ghép với tin nhắn vừa biến mất khỏi khung chat
      if (!restored || (!restored.text && !restored.attachments?.length)) {
        if (!rowEl.dataset.fbUnsendOldNotice && disappearedMessages.length > 0) {
          disappearedMessages.sort(
            (a, b) => Math.abs((a.rowIndex || 0) - rowIndex) - Math.abs((b.rowIndex || 0) - rowIndex)
          );
          restored = disappearedMessages.shift();
        }
      }

      // Nếu tìm được nội dung gốc -> Khôi phục ngay lên màn hình + Hiện Toast + Lưu/Cập nhật lịch sử!
      if (
        restored &&
        (restored.text || (restored.attachments && restored.attachments.length > 0))
      ) {
        const noticeTextBeforeRestore = (noticeEl.textContent || '').trim();
        const noticePerson = extractNameFromNotice(noticeTextBeforeRestore);
        const bestPersonName =
          noticePerson ||
          rowSenderName ||
          restored.personName ||
          rowEl.dataset?.fbUnsendSavedSender ||
          '';
        const bestThreadName = !isGenericSenderName(threadName)
          ? threadName
          : restored.threadName || '';

        const resolvedSenderName = formatSenderAndThreadName(
          bestPersonName,
          bestThreadName,
          restored.senderName || ''
        );

        renderRestoredContentInDom(rowEl, noticeEl, restored);

        const msgId = restored.messageId || `unsend_${Date.now()}`;
        const existingIdx = unsentMessagesList.findIndex(
          (u) =>
            u.messageId === msgId ||
            (u.text && u.text === restored.text && Math.abs((u.unsentAt || 0) - Date.now()) < 15000)
        );

        if (existingIdx === -1) {
          const unsentRecord = {
            messageId: msgId,
            text: restored.text || '',
            attachments: restored.attachments || [],
            personName: bestPersonName,
            threadName: bestThreadName,
            senderName: resolvedSenderName,
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
          notifyUnreadBadge();
        } else if (!isGenericSenderName(resolvedSenderName)) {
          // Nếu bản ghi đã được lưu trước đó 80ms bởi tầng ngầm nhưng chưa có tên người gỡ/nhóm đầy đủ -> Cập nhật ngay!
          const existingItem = unsentMessagesList[existingIdx];
          if (
            isGenericSenderName(existingItem.senderName) ||
            (resolvedSenderName.length > (existingItem.senderName || '').length &&
              resolvedSenderName.includes('•'))
          ) {
            existingItem.senderName = resolvedSenderName;
            existingItem.personName = bestPersonName || existingItem.personName || '';
            existingItem.threadName = bestThreadName || existingItem.threadName || '';
            saveToStorage();

            // Cập nhật cả tên trên Toast đang hiển thị (nếu có)
            const activeToastSender = document.querySelector(
              '#fb-unsend-toast-container .fb-unsend-toast-sender'
            );
            if (activeToastSender) {
              activeToastSender.textContent = resolvedSenderName;
            }
          }
        }
      } else {
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
