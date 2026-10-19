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
  // Giữ khóa đồng bộ với popup.js và dùng cờ schema_v3_cleaned để dọn sạch các bản ghi bị bắt nhầm trước đó
  const STORAGE_KEY_MESSAGES = 'fb_captured_messages_v2';
  const STORAGE_KEY_UNSENT = 'fb_unsent_messages_v2';
  const STORAGE_KEY_CLEANED_FLAG = 'fb_unsend_schema_v3_cleaned';
  const MAX_STORED_MESSAGES = 500;

  const messagesById = new Map();
  const domRowMessages = new WeakMap();
  let recentMessagesList = [];
  let unsentMessagesList = [];

  // Bộ đếm thời gian tăng dần tuyệt đối để giữ đúng thứ tự tin nhắn từ trên xuống dưới
  let lastTimestampCounter = 0;
  function getMonotonicTimestamp() {
    const now = Date.now();
    if (now <= lastTimestampCounter) {
      lastTimestampCounter += 1;
    } else {
      lastTimestampCounter = now;
    }
    return lastTimestampCounter;
  }

  // Ảnh chụp các dòng tin nhắn đang hiển thị trong khung chat hiện tại
  let visibleMessagesSnapshot = new Map();
  let isInitialScanDone = false;

  // Mẫu nhận diện thông báo thu hồi / xóa tin nhắn trên Facebook (bao gồm "đã xóa một tin nhắn")
  const UNSEND_REGEX =
    /(đã xóa một tin nhắn|đã xoá một tin nhắn|bạn đã xóa một tin nhắn|bạn đã xoá một tin nhắn|đã thu hồi một tin nhắn|bạn đã thu hồi một tin nhắn|đã gỡ một tin nhắn|bạn đã gỡ một tin nhắn|tin nhắn đã bị thu hồi|tin nhắn đã được thu hồi|tin nhắn đã bị xóa|unsent a message|you unsent a message|deleted a message|you deleted a message|removed a message|message was unsent)/i;

  // Các nhãn giao diện cần bỏ qua khi đọc text trong dòng chat
  const UI_IGNORE_REGEX =
    /^(Đã gửi|Đã nhận|Đã xem|Đang gửi|Đang viết|Sent|Delivered|Seen|Sending|Typing|Enter|Nhấn Enter để gửi|Được mã hóa đầu cuối|End-to-end encrypted|Trả lời|Reply|Chuyển tiếp|Forward|Xem thêm|See more|Bạn đã chuyển tiếp một tin nhắn|\d{1,2}:\d{2}(\s?[AP]M)?(\s+T\d|\s+CN)?)$/i;

  function sanitizeAttachmentsList(attachments) {
    if (!Array.isArray(attachments)) return [];
    const valid = [];
    for (const url of attachments) {
      if (!url || typeof url !== 'string') continue;
      // Loại bỏ URL media_fallback nội bộ (luôn bị lỗi sau khi gỡ) và URL ảnh đại diện Facebook
      if (
        url.includes('/messaging/lightspeed/media_fallback/') ||
        /\/t39\.30808-1\/|p50x50|p100x100|s100x100|p60x60|p40x40|dst-jpg_s\d+x\d+/i.test(url)
      ) {
        continue;
      }
      if (!valid.includes(url)) {
        valid.push(url);
      }
    }
    // Nếu đã có ảnh data:image/webp (ảnh đã lưu đệm), ưu tiên giữ ảnh data:image/ để không bị trùng với URL mạng
    const dataUrls = valid.filter((u) => u.startsWith('data:image/'));
    return dataUrls.length > 0 ? dataUrls : valid;
  }

  function isExtensionContextValid() {
    try {
      return Boolean(chrome && chrome.runtime && chrome.runtime.id && chrome.storage?.local);
    } catch (_) {
      return false;
    }
  }

  // Nhận diện ID và Tên thật của tài khoản Facebook đang đăng nhập để ánh xạ chính xác "Bạn" <-> Tên thật
  let currentUserId = '';
  let currentUserFullName = '';

  function detectCurrentUserIdentity() {
    try {
      if (!currentUserId && document.cookie) {
        const m = document.cookie.match(/(?:^|;\s*)c_user=(\d+)/);
        if (m && m[1]) {
          currentUserId = m[1];
        }
      }
      if (!currentUserFullName && document.documentElement) {
        const scripts = document.querySelectorAll('script');
        for (const s of scripts) {
          const txt = s.textContent || '';
          if (!txt.includes('CurrentUserInitialData')) continue;
          const nameMatch = txt.match(
            /"CurrentUserInitialData"\s*,\s*\[\]\s*,\s*\{[^}]*?"NAME"\s*:\s*"((?:[^"\\]|\\.)*)"/
          );
          if (nameMatch && nameMatch[1]) {
            try {
              currentUserFullName = JSON.parse(`"${nameMatch[1]}"`).trim();
              if (currentUserFullName) break;
            } catch (_) {
              currentUserFullName = nameMatch[1].trim();
            }
          }
        }
      }
    } catch (_) {}
  }

  function isSelfKeyword(name) {
    return /^(bạn|you|bạn đã gửi|you sent)$/i.test((name || '').trim());
  }

  function isCurrentUserName(name) {
    const clean = (name || '').trim().toLowerCase();
    if (!clean) return false;
    if (isSelfKeyword(clean)) return true;
    if (!currentUserFullName) detectCurrentUserIdentity();
    if (currentUserFullName) {
      const selfLower = currentUserFullName.toLowerCase();
      if (clean === selfLower) return true;
    }
    return false;
  }

  function loadFromStorage() {
    if (!isExtensionContextValid()) return;
    try {
      detectCurrentUserIdentity();
      chrome.storage.local.remove(['fb_captured_messages_v1', 'fb_unsent_messages_v1']);

      chrome.storage.local.get(
        [STORAGE_KEY_MESSAGES, STORAGE_KEY_UNSENT, STORAGE_KEY_CLEANED_FLAG],
        (res) => {
          if (!isExtensionContextValid() || !res) return;
          try {
            if (!res[STORAGE_KEY_CLEANED_FLAG]) {
              // Xóa 1 lần các bản ghi bị bắt nhầm từ lỗi parentElement ở phiên bản thử nghiệm trước
              chrome.storage.local.set({
                [STORAGE_KEY_MESSAGES]: [],
                [STORAGE_KEY_UNSENT]: [],
                [STORAGE_KEY_CLEANED_FLAG]: true
              });
              recentMessagesList = [];
              unsentMessagesList = [];
              console.log(`${LOG_PREFIX} Đã làm sạch dữ liệu cũ và sẵn sàng theo dõi chính xác.`);
              scheduleDomScan();
              return;
            }

            if (Array.isArray(res[STORAGE_KEY_MESSAGES])) {
              recentMessagesList = res[STORAGE_KEY_MESSAGES].map((msg) => ({
                ...msg,
                attachments: sanitizeAttachmentsList(msg.attachments)
              }));
              for (const msg of recentMessagesList) {
                if (msg.messageId) {
                  messagesById.set(msg.messageId, msg);
                }
              }
            }
            if (Array.isArray(res[STORAGE_KEY_UNSENT])) {
              unsentMessagesList = res[STORAGE_KEY_UNSENT]
                .map((msg) => ({
                  ...msg,
                  attachments: sanitizeAttachmentsList(msg.attachments)
                }))
                .filter((msg) => msg.text || (msg.attachments && msg.attachments.length > 0));
              for (const msg of unsentMessagesList) {
                if (msg.messageId) {
                  messagesById.set(msg.messageId, msg);
                }
              }
            }
            console.log(
              `${LOG_PREFIX} Đã sẵn sàng (${recentMessagesList.length} tin nhắn lưu tạm, ${unsentMessagesList.length} tin nhắn bị gỡ).`
            );
            // Quét lại khung chat ngay sau khi nạp xong dữ liệu từ Storage để khôi phục các tin nhắn bị gỡ sau khi F5
            scheduleDomScan();
          } catch (_) {}
        }
      );
    } catch (_) {}
  }

  let saveTimeout = null;
  function saveToStorage() {
    if (!isExtensionContextValid()) return;
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
      if (!isExtensionContextValid()) return;
      try {
        if (recentMessagesList.length > MAX_STORED_MESSAGES) {
          recentMessagesList = recentMessagesList.slice(-MAX_STORED_MESSAGES);
        }
        chrome.storage.local.set({
          [STORAGE_KEY_MESSAGES]: recentMessagesList,
          [STORAGE_KEY_UNSENT]: unsentMessagesList
        });
      } catch (_) {}
    }, 300);
  }

  function requestMainWorldFiberScan() {
    try {
      window.postMessage(
        {
          source: 'FB_UNSEND_EXTENSION_CONTENT',
          type: 'SCAN_FIBER'
        },
        '*'
      );
    } catch (_) {}
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
    } else if (type === 'FB_FIBER_UPDATED') {
      scanChatMessagesInDom();
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
    let cleanPerson = !isGenericSenderName(personName) ? String(personName).trim() : '';
    if (isSelfKeyword(cleanPerson) && currentUserFullName) {
      cleanPerson = currentUserFullName;
    }
    const cleanThread = !isGenericSenderName(threadName) ? String(threadName).trim() : '';
    const cleanFallback = !isGenericSenderName(fallbackName) ? String(fallbackName).trim() : '';

    if (cleanPerson && cleanThread) {
      const pLower = cleanPerson.toLowerCase();
      const tLower = cleanThread.toLowerCase();
      if (pLower === tLower) {
        return cleanThread;
      }
      // Nếu là chat 1-1 mà tên người gỡ là tên gọi ngắn nằm trong tên đầy đủ của hộp chat (VD: "Bình" trong "Nguyễn Trọng Bình")
      if (tLower.includes(pLower) && !isSelfKeyword(cleanPerson) && !cleanThread.includes('|')) {
        return cleanThread;
      }
      return `${cleanPerson} • ${cleanThread}`;
    }

    return cleanPerson || cleanThread || cleanFallback || 'Facebook Chat';
  }

  function handleCapturedMessage(msg) {
    if (!msg.messageId) return;

    detectCurrentUserIdentity();
    if (
      currentUserId &&
      msg.senderId &&
      String(msg.senderId) === String(currentUserId) &&
      msg.personName &&
      !isGenericSenderName(msg.personName) &&
      !isSelfKeyword(msg.personName)
    ) {
      currentUserFullName = msg.personName.trim();
    }

    const existing = messagesById.get(msg.messageId);
    const activeThread = findActiveThreadName();
    const resolvedSenderName = formatSenderAndThreadName(
      msg.personName || existing?.personName || '',
      msg.threadName || existing?.threadName || activeThread,
      msg.senderName || existing?.senderName || ''
    );

    const combinedAttachments = sanitizeAttachmentsList([
      ...(msg.attachments || []),
      ...(existing?.attachments || [])
    ]);

    const merged = {
      ...existing,
      ...msg,
      text: existing?.text || msg.text || '',
      attachments: combinedAttachments,
      personName: msg.personName || existing?.personName || '',
      threadName:
        msg.threadName ||
        existing?.threadName ||
        (!isGenericSenderName(activeThread) ? activeThread : ''),
      senderName: resolvedSenderName,
      timestamp: existing?.timestamp || msg.timestamp || getMonotonicTimestamp(),
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
    if (!isExtensionContextValid()) return;
    try {
      if (chrome?.runtime?.sendMessage) {
        chrome.runtime.sendMessage({ type: 'INCREMENT_UNREAD_BADGE' });
      }
    } catch (_) {}
  }

  function handleUnsentEvent(unsentData) {
    detectCurrentUserIdentity();
    if (
      currentUserId &&
      unsentData.senderId &&
      String(unsentData.senderId) === String(currentUserId) &&
      unsentData.personName &&
      !isGenericSenderName(unsentData.personName) &&
      !isSelfKeyword(unsentData.personName)
    ) {
      currentUserFullName = unsentData.personName.trim();
    }

    const existing = messagesById.get(unsentData.messageId);
    const originalText = existing?.text || unsentData.text || '';
    const originalAttachments = sanitizeAttachmentsList([
      ...(existing?.attachments || []),
      ...(unsentData.attachments || [])
    ]);

    if (!originalText && originalAttachments.length === 0) return;

    const noticePerson = extractNameFromNotice(unsentData.unsendNotice);
    if (
      isSelfKeyword(noticePerson) &&
      (unsentData.personName || existing?.personName) &&
      !isSelfKeyword(unsentData.personName || existing?.personName)
    ) {
      currentUserFullName = (unsentData.personName || existing?.personName).trim();
    }

    const activeThread = findActiveThreadName();
    const bestPerson =
      (!isSelfKeyword(unsentData.personName) && unsentData.personName) ||
      (!isSelfKeyword(existing?.personName) && existing?.personName) ||
      noticePerson ||
      currentUserFullName ||
      '';
    const bestThread =
      unsentData.threadName ||
      existing?.threadName ||
      (!isGenericSenderName(activeThread) ? activeThread : '');

    const resolvedSenderName = formatSenderAndThreadName(
      bestPerson,
      bestThread,
      unsentData.senderName || existing?.senderName || ''
    );

    const record = {
      messageId: unsentData.messageId,
      text: originalText,
      attachments: originalAttachments,
      senderId: existing?.senderId || unsentData.senderId || '',
      threadId: existing?.threadId || unsentData.threadId || '',
      personName: bestPerson,
      threadName: bestThread,
      senderName: resolvedSenderName,
      anchorAboveText: existing?.anchorAboveText || '',
      timestamp: existing?.timestamp || unsentData.timestamp || getMonotonicTimestamp(),
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
    requestMainWorldFiberScan();
    setTimeout(() => scanChatMessagesInDom(record), 60);
  }

  // ============================================================================
  // 2. QUÉT CHÍNH XÁC CÁC DÒNG TIN NHẮN TRONG KHUNG CHAT (KHÔNG QUÉT NEWS FEED)
  // ============================================================================

  function findActiveThreadName(contextEl = null, noticeText = '') {
    try {
      let targetEl = contextEl;
      if (!(targetEl instanceof HTMLElement)) {
        const activeRows = getActualChatRows();
        if (activeRows.length > 0) {
          targetEl = activeRows[activeRows.length - 1];
        }
      }

      if (targetEl instanceof HTMLElement) {
        // Lưu ý: Không dùng div[role="region"] vì vùng cuộn tin nhắn có role="region" nằm bên trong hộp chat,
        // sẽ làm .closest() dừng sớm trước khi tới thanh tiêu đề của cửa sổ chat (div[role="dialog"]).
        const chatContainer = targetEl.closest(
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
   * Kiểm tra xem thẻ <img> có phải là avatar người gửi, icon cảm xúc, hay lớp ảnh nền làm mờ (blur) của Facebook không
   */
  function isAvatarOrDecorativeImage(imgEl, rawSrc, rowSenderName = '') {
    if (!rawSrc || rawSrc.startsWith('data:image/svg')) return true;

    // 1. Chặn theo mẫu URL của ảnh đại diện (profile picture /t39.30808-1/), emoji hoặc tài nguyên tĩnh Facebook
    if (
      /\/t39\.30808-1\/|p50x50|p100x100|s100x100|p60x60|p40x40|dst-jpg_s\d+x\d+|emoji\.php|rsrc\.php|static\.xx\.fbcdn\.net/i.test(
        rawSrc
      )
    ) {
      return true;
    }

    // 2. Chỉ lấy ảnh đã tải hoàn tất và có kích thước gốc đủ lớn (> 64x64)
    if (!imgEl.complete || imgEl.naturalWidth <= 64 || imgEl.naturalHeight <= 64) {
      return true;
    }

    // 3. Kiểm tra kích thước hiển thị thực tế trên màn hình (TUYỆT ĐỐI không fallback sang imgEl.width vì sẽ trả về naturalWidth)
    const rect = imgEl.getBoundingClientRect();
    if (rect.width <= 58 || rect.height <= 58) {
      return true;
    }

    // 4. Kiểm tra thuộc tính alt: Ảnh đại diện luôn có alt là tên người gửi hoặc "Đã xem bởi..."
    const alt = (imgEl.getAttribute('alt') || '').trim();
    if (alt) {
      if (/^(Đã xem|Seen by)/i.test(alt)) return true;
      if (rowSenderName && alt.toLowerCase() === rowSenderName.toLowerCase()) return true;
    }

    if (imgEl.closest('svg, [role="button"][aria-label*="cảm xúc"]')) {
      return true;
    }

    // 5. Kiểm tra CSS của ảnh và 3 cấp thẻ cha:
    // - Chặn ảnh nền làm mờ (filter: blur(...)) mà Facebook chèn phía sau ảnh chính
    // - Chặn ảnh đại diện hình tròn (border-radius: 50%) hoặc khung nhỏ <= 58px
    let curr = imgEl;
    for (let depth = 0; depth < 4 && curr && curr instanceof HTMLElement; depth++) {
      try {
        const cs = window.getComputedStyle(curr);
        if (cs.filter && cs.filter.includes('blur')) {
          return true;
        }
        if (cs.borderTopLeftRadius === '50%') {
          return true;
        }
        const radiusPx = parseFloat(cs.borderTopLeftRadius) || 0;
        const currRect = curr.getBoundingClientRect();
        if (
          currRect.width > 0 &&
          Math.abs(currRect.width - currRect.height) <= 4 &&
          radiusPx >= currRect.width * 0.45 &&
          currRect.width <= 80
        ) {
          return true;
        }
        if (currRect.width > 0 && (currRect.width <= 58 || currRect.height <= 58)) {
          return true;
        }
      } catch (_) {}
      curr = curr.parentElement;
    }

    return false;
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

    if (imgEl.complete && imgEl.naturalWidth > 64 && imgEl.naturalHeight > 64) {
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
   * - attachments: Hình ảnh / Video / Sticker trong tin nhắn (đã lọc sạch avatar & ảnh nền mờ)
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

    // 2. Nếu là dòng tin nhắn bình thường -> Trích xuất văn bản tin nhắn (kèm cả icon emoji <img alt="🐕">)
    const extractNodeTextWithEmoji = (node) => {
      if (!node) return '';
      if (node.nodeType === Node.TEXT_NODE) {
        return node.nodeValue || '';
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return '';
      const el = node;
      if (el.tagName === 'BR') return '\n';
      if (el.tagName === 'IMG') {
        const alt = (el.getAttribute('alt') || '').trim();
        const src = el.getAttribute('src') || '';
        if (
          alt &&
          (src.includes('emoji.php') ||
            (alt.length <= 8 && !/^(Đã xem|Seen by|Hình ảnh|Ảnh|Image|Photo)$/i.test(alt)))
        ) {
          return alt;
        }
        return '';
      }
      let out = '';
      for (const child of el.childNodes) {
        out += extractNodeTextWithEmoji(child);
      }
      return out;
    };

    const texts = [];
    const textNodes = rowEl.querySelectorAll('div[dir="auto"]');
    textNodes.forEach((el) => {
      if (el.closest('h3, h4, h5, h6')) return;

      const t = extractNodeTextWithEmoji(el).trim();
      if (!t) return;
      if (UNSEND_REGEX.test(t) || UI_IGNORE_REGEX.test(t)) return;
      if (!texts.includes(t)) {
        texts.push(t);
      }
    });

    // Trường hợp tin nhắn chỉ gửi độc lập 1 icon cảm xúc lớn (VD: 🐕, ❤️, 👍) nằm ngoài div[dir="auto"]
    if (texts.length === 0) {
      rowEl.querySelectorAll('img[src*="emoji.php"][alt]').forEach((emojiImg) => {
        if (emojiImg.closest('[aria-label*="cảm xúc"], [aria-label*="reaction"], [role="button"][tabindex="0"]')) {
          return;
        }
        const alt = (emojiImg.getAttribute('alt') || '').trim();
        if (alt && !texts.includes(alt)) {
          texts.push(alt);
        }
      });
    }

    // 3. Trích xuất hình ảnh / sticker / video trong dòng tin nhắn (bỏ qua avatar người gửi & ảnh nền mờ)
    const attachments = [];
    const seenPhotoContainers = new Set();

    rowEl.querySelectorAll('img, video, audio').forEach((mediaEl) => {
      const rawSrc = mediaEl.currentSrc || mediaEl.src || '';
      if (!rawSrc || rawSrc.startsWith('data:image/svg')) return;

      if (mediaEl.tagName === 'IMG') {
        if (isAvatarOrDecorativeImage(mediaEl, rawSrc, rowSenderName)) {
          return;
        }

        // Mỗi khung ảnh (a[role="link"] hoặc div[role="button"]) chỉ lấy tối đa 1 thẻ <img> chính
        const photoContainer = mediaEl.closest('a[role="link"], div[role="button"]');
        if (photoContainer) {
          if (seenPhotoContainers.has(photoContainer)) return;
          seenPhotoContainers.add(photoContainer);
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
      attachments: sanitizeAttachmentsList(attachments),
      rowSenderName
    };
  }

  function isSamePersonName(nameA, nameB) {
    const a = (nameA || '').trim().toLowerCase();
    const b = (nameB || '').trim().toLowerCase();
    if (!a || !b) return false;
    if (a === b) return true;
    // Nếu cả 2 đều chỉ người dùng đang đăng nhập (VD: "Bạn" trên khung chat và "Nguyễn Trọng Bình" từ hệ thống)
    if (isCurrentUserName(a) && isCurrentUserName(b)) {
      return true;
    }
    if (a.length >= 2 && b.length >= 2 && !isSelfKeyword(a) && !isSelfKeyword(b)) {
      if (a.includes(b) || b.includes(a)) {
        return true;
      }
    }
    return false;
  }

  function getChatContainerForRow(rowEl) {
    if (!rowEl || !(rowEl instanceof HTMLElement)) return document.body;
    return (
      rowEl.closest('div[role="dialog"], div[data-pagelet*="ChatTab"], div[role="main"]') ||
      document.body
    );
  }

  /**
   * Đối chiếu các dòng "đã xóa một tin nhắn" trên khung chat với lịch sử unsentMessagesList đã lưu
   * để tự động hiện lại tin nhắn bị gỡ sau khi tải lại trang (F5) hoặc mở lại cuộc trò chuyện
   */
  function matchUnsentRowsFromSavedHistory(unmatchedRows) {
    if (!unmatchedRows.length || !unsentMessagesList.length) return new Map();

    const rowToRecordMap = new Map();

    // Tách riêng từng khung chat (VD: trang /messages/t/... có thể có cả khung chính role="main" và bong bóng chat role="dialog")
    const rowsByContainer = new Map();
    for (const item of unmatchedRows) {
      const container = getChatContainerForRow(item.rowEl);
      if (!rowsByContainer.has(container)) {
        rowsByContainer.set(container, []);
      }
      rowsByContainer.get(container).push(item);
    }

    for (const [container, containerRows] of rowsByContainer.entries()) {
      const usedMessageIds = new Set();

      // Chỉ ghi nhận các messageId đã dùng trong CÙNG khung chat này
      container
        .querySelectorAll('div[data-scope="messages_table"][data-fb-unsend-matched-id]')
        .forEach((el) => {
          if (el.dataset.fbUnsendMatchedId) {
            usedMessageIds.add(el.dataset.fbUnsendMatchedId);
          }
        });

      // Bước 1: Khớp chính xác tuyệt đối theo Message ID (mid.$...) từ React Fiber trên chính rowEl
      const remainingRows = [];
      for (const item of containerRows) {
        const fiberId = item.rowEl.dataset?.fbMsgId;
        if (fiberId) {
          const exactMatch = unsentMessagesList.find((u) => u.messageId === fiberId);
          if (exactMatch && (exactMatch.text || exactMatch.attachments?.length)) {
            rowToRecordMap.set(item.rowEl, exactMatch);
            usedMessageIds.add(exactMatch.messageId);
            continue;
          }
        }
        remainingRows.push(item);
      }

      if (remainingRows.length === 0) continue;

      // Bước 2: Gom nhóm các dòng chưa có mid.$ theo (Tên người gỡ trên thông báo + Tên cuộc trò chuyện)
      const groups = new Map();
      for (const item of remainingRows) {
        const noticeText = (item.noticeEl?.textContent || '').trim();
        const noticePerson = extractNameFromNotice(noticeText) || item.rowSenderName || '';
        const groupKey = `${noticePerson.toLowerCase()}__${(item.threadName || '').toLowerCase()}`;
        if (!groups.has(groupKey)) {
          groups.set(groupKey, {
            noticePerson,
            threadName: item.threadName || '',
            rows: []
          });
        }
        groups.get(groupKey).rows.push(item);
      }

      for (const group of groups.values()) {
        const { noticePerson, threadName, rows } = group;
        const pLower = noticePerson.toLowerCase();
        const tLower = !isGenericSenderName(threadName) ? threadName.toLowerCase() : '';

        // Chỉ lấy các bản ghi khớp NGHIÊM NGẶT cả tên người gỡ VÀ tên cuộc trò chuyện (không dùng fallback sang người khác/nhóm khác)
        const candidates = unsentMessagesList.filter((u) => {
          if (usedMessageIds.has(u.messageId)) return false;
          if (!u.text && (!u.attachments || u.attachments.length === 0)) return false;

          const uPerson = (u.personName || '').trim();
          const uThread = (u.threadName || '').trim().toLowerCase();
          const uSenderParts = (u.senderName || '').split('•').map((s) => s.trim());
          const uSenderPerson = uSenderParts[0] || '';

          const personMatches = !pLower
            ? true
            : isSamePersonName(noticePerson, uPerson) ||
              isSamePersonName(noticePerson, uSenderPerson);

          const threadMatches = !tLower
            ? true
            : uThread === tLower ||
              (uThread && (uThread.includes(tLower) || tLower.includes(uThread))) ||
              (u.senderName || '').toLowerCase().includes(tLower);

          return personMatches && threadMatches;
        });

        if (candidates.length === 0) continue;

        // Lấy tối đa rows.length bản ghi gần nhất của người đó trong cuộc trò chuyện này,
        // sau đó SẮP XẾP THEO THỜI ĐIỂM GỬI TIN NHẮN GỐC TĂNG DẦN (timestamp cũ -> mới)
        // để luôn khớp đúng thứ tự từ trên xuống dưới trên khung chat bất kể thứ tự bấm nút thu hồi!
        const selected = candidates
          .slice(0, rows.length)
          .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

        const unmatchedTargetRows = [...rows];
        const remainingSelected = [];

        // Ưu tiên khớp theo mốc tin nhắn ngay phía trên (anchorAboveText) nếu có
        for (const rec of selected) {
          if (rec.anchorAboveText) {
            const matchIdx = unmatchedTargetRows.findIndex(
              (r) => r.anchorAboveText && r.anchorAboveText === rec.anchorAboveText
            );
            if (matchIdx !== -1) {
              const targetRow = unmatchedTargetRows.splice(matchIdx, 1)[0];
              rowToRecordMap.set(targetRow.rowEl, rec);
              usedMessageIds.add(rec.messageId);
              continue;
            }
          }
          remainingSelected.push(rec);
        }

        // Khớp các dòng còn lại theo đúng thứ tự thời gian gửi từ trên xuống dưới
        const startRowOffset = Math.max(0, unmatchedTargetRows.length - remainingSelected.length);
        for (let i = 0; i < remainingSelected.length; i++) {
          const targetRow = unmatchedTargetRows[startRowOffset + i];
          const record = remainingSelected[i];
          if (targetRow && record) {
            rowToRecordMap.set(targetRow.rowEl, record);
            usedMessageIds.add(record.messageId);
          }
        }
      }
    }

    return rowToRecordMap;
  }

  /**
   * Quét toàn bộ các dòng tin nhắn trong khung chat
   */
  function scanChatMessagesInDom(specificRecord = null) {
    const chatRows = getActualChatRows();
    if (chatRows.length === 0) return;

    const currentSnapshot = new Map();
    const currentActiveIds = new Set();
    const currentUnsentRows = [];
    const lastSenderByContainer = new Map();
    const lastNormalTextByContainer = new Map();

    chatRows.forEach((rowEl, index) => {
      const container = getChatContainerForRow(rowEl);
      const analysis = analyzeChatRow(rowEl);
      const threadName = findActiveThreadName(rowEl);

      if (analysis.rowSenderName) {
        lastSenderByContainer.set(container, analysis.rowSenderName);
      }
      const lastKnownRowSender = lastSenderByContainer.get(container) || '';
      const anchorAboveText = lastNormalTextByContainer.get(container) || '';

      if (analysis.isUnsentRow) {
        if (!analysis.alreadyRestored && analysis.unsentNoticeEl) {
          currentUnsentRows.push({
            rowEl,
            noticeEl: analysis.unsentNoticeEl,
            rowIndex: index,
            threadName,
            chatContainer: container,
            anchorAboveText,
            rowSenderName: analysis.rowSenderName || rowEl.dataset?.fbUnsendSavedSender || ''
          });
        }
        return;
      }

      if (analysis.text || analysis.attachments.length > 0) {
        if (analysis.text) {
          lastNormalTextByContainer.set(container, analysis.text);
        }

        const prev = domRowMessages.get(rowEl);
        const fiberMsgId = rowEl.dataset?.fbMsgId || '';

        // Kiểm tra xem React có tái sử dụng node DOM này cho một tin nhắn khác khi cuộn trang / đổi đoạn chat không
        const isRecycledNode =
          prev &&
          ((fiberMsgId && prev.fiberMsgId && fiberMsgId !== prev.fiberMsgId) ||
            (analysis.text && prev.text && analysis.text !== prev.text) ||
            (analysis.rowSenderName &&
              prev.personName &&
              !isSamePersonName(analysis.rowSenderName, prev.personName)));

        const safePrev = isRecycledNode ? null : prev;
        if (isRecycledNode) {
          delete rowEl.dataset.fbUnsendSavedText;
          delete rowEl.dataset.fbUnsendSavedMedia;
          delete rowEl.dataset.fbUnsendSavedSender;
          delete rowEl.dataset.fbUnsendSavedMid;
        }

        const msgId =
          fiberMsgId ||
          safePrev?.messageId ||
          `dom_${getMonotonicTimestamp()}_${index}_${Math.random().toString(36).slice(2, 6)}`;

        // Nếu dòng này vừa được gắn mid.$ từ React Fiber, chuyển dữ liệu từ ID tạm dom_... sang mid.$
        if (safePrev && safePrev.messageId && fiberMsgId && safePrev.messageId !== fiberMsgId) {
          currentActiveIds.add(safePrev.messageId);
          messagesById.delete(safePrev.messageId);
          const oldIdx = recentMessagesList.findIndex((m) => m.messageId === safePrev.messageId);
          if (oldIdx !== -1) {
            recentMessagesList[oldIdx].messageId = fiberMsgId;
          }
        }

        const personName =
          analysis.rowSenderName ||
          safePrev?.personName ||
          rowEl.dataset?.fbUnsendSavedSender ||
          lastKnownRowSender ||
          '';
        const fullSenderName = formatSenderAndThreadName(
          personName,
          threadName,
          safePrev?.senderName || ''
        );

        const cleanAttachments = sanitizeAttachmentsList(
          analysis.attachments.length > 0 ? analysis.attachments : safePrev?.attachments || []
        );

        const existingById = messagesById.get(msgId);
        const record = {
          messageId: msgId,
          fiberMsgId: fiberMsgId || safePrev?.fiberMsgId || '',
          text: analysis.text || safePrev?.text || '',
          attachments: cleanAttachments,
          personName,
          threadName: !isGenericSenderName(threadName) ? threadName : safePrev?.threadName || '',
          senderName: fullSenderName,
          anchorAboveText: safePrev?.anchorAboveText || anchorAboveText || '',
          timestamp: safePrev?.timestamp || existingById?.timestamp || getMonotonicTimestamp(),
          rowIndex: index,
          rowEl,
          chatContainer: container
        };

        domRowMessages.set(rowEl, record);

        // CHỈ lưu dữ liệu trên chính rowEl của dòng đó, TUYỆT ĐỐI KHÔNG lưu lên rowEl.parentElement
        // vì rowEl.parentElement là khung chứa chung của mọi dòng tin nhắn!
        if (fiberMsgId) {
          rowEl.dataset.fbUnsendSavedMid = fiberMsgId;
        }
        if (record.text) {
          rowEl.dataset.fbUnsendSavedText = record.text;
        }
        if (personName) {
          rowEl.dataset.fbUnsendSavedSender = personName;
        }
        if (record.attachments.length > 0) {
          rowEl.dataset.fbUnsendSavedMedia = JSON.stringify(record.attachments);
        }

        currentSnapshot.set(record.messageId, record);
        currentActiveIds.add(record.messageId);
        if (safePrev?.messageId) {
          currentActiveIds.add(safePrev.messageId);
        }

        const attachmentsUpgraded =
          safePrev &&
          record.attachments.length > 0 &&
          JSON.stringify(record.attachments) !== JSON.stringify(safePrev.attachments || []);

        if (!safePrev || attachmentsUpgraded) {
          if (!safePrev) {
            console.log(
              `${LOG_PREFIX} 💬 Đã ghi nhận tin nhắn trong khung chat [${record.senderName}]:`,
              record.text || `(Đính kèm ${record.attachments.length} media)`
            );
          }
          handleCapturedMessage(record);
        }
      }
    });

    // Tìm các tin nhắn thực sự biến mất khỏi khung chat (loại bỏ hoàn toàn trường hợp đổi ID từ dom_ sang mid.$ hoặc dòng vẫn đang hiển thị bình thường)
    const disappearedMessages = [];
    if (isInitialScanDone && visibleMessagesSnapshot.size > 0) {
      for (const [id, oldRec] of visibleMessagesSnapshot.entries()) {
        if (currentActiveIds.has(id)) continue;
        // Nếu phần tử DOM của tin nhắn đó vẫn đang nằm trên màn hình và KHÔNG phải dòng thông báo gỡ -> Tin nhắn đó CHƯA HỀ BỊ GỠ!
        if (oldRec.rowEl && oldRec.rowEl.isConnected) {
          const checkNow = analyzeChatRow(oldRec.rowEl);
          if (!checkNow.isUnsentRow) {
            continue;
          }
        }
        disappearedMessages.push(oldRec);
      }
    }

    // Nếu vừa có sự kiện gỡ trực tiếp (specificRecord) và trên khung chat xuất hiện dòng "Bạn đã xóa một tin nhắn",
    // tự động ghi nhận tên thật của người dùng từ specificRecord để khớp 100%
    if (
      specificRecord &&
      specificRecord.personName &&
      !isSelfKeyword(specificRecord.personName) &&
      !currentUserFullName
    ) {
      const hasNewSelfUnsentRow = currentUnsentRows.some(({ rowEl, noticeEl, rowSenderName }) => {
        if (rowEl.dataset.fbUnsendRestored === 'true') return false;
        const np = extractNameFromNotice((noticeEl?.textContent || '').trim()) || rowSenderName || '';
        return isSelfKeyword(np);
      });
      if (hasNewSelfUnsentRow) {
        currentUserFullName = specificRecord.personName.trim();
      }
    }

    // Đối chiếu trước các dòng thông báo xóa với lịch sử unsentMessagesList (dùng khi người dùng F5 tải lại trang hoặc mở /messages/t/...)
    const historyMatchedMap = matchUnsentRowsFromSavedHistory(currentUnsentRows);

    // Xử lý các dòng có thông báo "đã xóa một tin nhắn" / "đã thu hồi một tin nhắn"
    currentUnsentRows.forEach(
      ({ rowEl, noticeEl, rowIndex, threadName, chatContainer, anchorAboveText, rowSenderName }) => {
        if (rowEl.dataset.fbUnsendRestored === 'true') return;

        const noticeTextBeforeRestore = (noticeEl.textContent || '').trim();
        const noticePerson = extractNameFromNotice(noticeTextBeforeRestore) || rowSenderName || '';
        const fiberId = rowEl.dataset?.fbMsgId || '';

        // Hàm kiểm tra nghiêm ngặt: Dữ liệu khôi phục bắt buộc phải khớp tên người gỡ trong câu thông báo
        const isRecordValidForThisRow = (cand) => {
          if (!cand || (!cand.text && (!cand.attachments || cand.attachments.length === 0))) {
            return false;
          }
          if (fiberId && cand.messageId && cand.messageId.startsWith('mid.$')) {
            return cand.messageId === fiberId;
          }
          if (noticePerson && cand.personName) {
            return isSamePersonName(noticePerson, cand.personName);
          }
          return true;
        };

        let restored = null;

        // Cách 1: Khớp chính xác theo Message ID (mid.$...) từ React Fiber trên dòng hiện tại
        if (fiberId) {
          const fromUnsent = unsentMessagesList.find((u) => u.messageId === fiberId);
          const fromCaptured = messagesById.get(fiberId);
          if (isRecordValidForThisRow(fromUnsent)) {
            restored = fromUnsent;
          } else if (isRecordValidForThisRow(fromCaptured)) {
            restored = fromCaptured;
          }
        }

        // Cách 2: Nếu vừa nhận sự kiện gỡ trực tiếp từ injected.js (specificRecord)
        if (!restored && specificRecord && isRecordValidForThisRow(specificRecord)) {
          if (!fiberId || !specificRecord.messageId || specificRecord.messageId === fiberId) {
            restored = specificRecord;
          }
        }

        // Cách 3: Kiểm tra bộ nhớ gắn trực tiếp trên chính rowEl (khi vừa xóa trực tiếp trên màn hình)
        if (!restored) {
          const memRec = domRowMessages.get(rowEl);
          if (isRecordValidForThisRow(memRec)) {
            restored = memRec;
          }
        }

        // Cách 4: Kiểm tra dataset lưu trên chính rowEl (TUYỆT ĐỐI KHÔNG đọc từ parentElement)
        if (!restored) {
          const savedMid = rowEl.dataset?.fbUnsendSavedMid || '';
          const midConsistent = !fiberId || !savedMid || fiberId === savedMid;
          const savedText = rowEl.dataset?.fbUnsendSavedText;
          const savedMediaStr = rowEl.dataset?.fbUnsendSavedMedia;
          const savedSender = rowEl.dataset?.fbUnsendSavedSender || '';

          if (midConsistent && (savedText || savedMediaStr)) {
            let attachments = [];
            try {
              if (savedMediaStr) attachments = JSON.parse(savedMediaStr);
            } catch (_) {}
            const candidate = {
              messageId: fiberId || savedMid || `unsend_${getMonotonicTimestamp()}_${rowIndex}`,
              text: savedText || '',
              attachments: sanitizeAttachmentsList(attachments),
              personName: savedSender || rowSenderName || '',
              threadName,
              senderName: threadName,
              anchorAboveText,
              timestamp: getMonotonicTimestamp()
            };
            if (isRecordValidForThisRow(candidate)) {
              restored = candidate;
            }
          }
        }

        // Cách 5: Khôi phục từ lịch sử đã lưu trong chrome.storage.local (sau khi tải lại trang F5 / mở đoạn chat)
        if (!restored && historyMatchedMap.has(rowEl)) {
          const histCand = historyMatchedMap.get(rowEl);
          if (isRecordValidForThisRow(histCand)) {
            restored = histCand;
          }
        }

        // Cách 6: Snapshot Diffing - chỉ ghép nếu tin nhắn biến mất trong CÙNG khung chat, CÙNG vị trí dòng (lệch <= 1) và CÙNG tên người gửi
        if (!restored && !rowEl.dataset.fbUnsendOldNotice && disappearedMessages.length > 0) {
          const matchIdx = disappearedMessages.findIndex(
            (oldRec) =>
              oldRec.chatContainer === chatContainer &&
              Math.abs((oldRec.rowIndex || 0) - rowIndex) <= 1 &&
              isRecordValidForThisRow(oldRec)
          );
          if (matchIdx !== -1) {
            restored = disappearedMessages.splice(matchIdx, 1)[0];
          }
        }

        // Nếu tìm được nội dung gốc hợp lệ -> Khôi phục ngay lên màn hình + Lưu/Cập nhật lịch sử
        if (
          restored &&
          (restored.text || (restored.attachments && restored.attachments.length > 0))
        ) {
          const cleanRestored = {
            ...restored,
            attachments: sanitizeAttachmentsList(restored.attachments)
          };
          if (!cleanRestored.text && cleanRestored.attachments.length === 0) return;

          const rawPerson =
            (!isSelfKeyword(cleanRestored.personName) && cleanRestored.personName) ||
            noticePerson ||
            rowSenderName ||
            rowEl.dataset?.fbUnsendSavedSender ||
            '';
          const bestPersonName =
            isSelfKeyword(rawPerson) && currentUserFullName ? currentUserFullName : rawPerson;
          const bestThreadName = !isGenericSenderName(threadName)
            ? threadName
            : cleanRestored.threadName || '';

          const resolvedSenderName = formatSenderAndThreadName(
            bestPersonName,
            bestThreadName,
            cleanRestored.senderName || ''
          );

          const msgId = fiberId || cleanRestored.messageId || `unsend_${getMonotonicTimestamp()}`;
          rowEl.dataset.fbUnsendMatchedId = msgId;

          renderRestoredContentInDom(rowEl, noticeEl, cleanRestored);

          const existingIdx = unsentMessagesList.findIndex(
            (u) =>
              u.messageId === msgId ||
              (cleanRestored.messageId && u.messageId === cleanRestored.messageId)
          );

          if (existingIdx === -1) {
            const unsentRecord = {
              messageId: msgId,
              text: cleanRestored.text || '',
              attachments: cleanRestored.attachments || [],
              personName: bestPersonName,
              threadName: bestThreadName,
              senderName: resolvedSenderName,
              anchorAboveText: cleanRestored.anchorAboveText || anchorAboveText || '',
              timestamp: cleanRestored.timestamp || getMonotonicTimestamp(),
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
          } else {
            // Cập nhật lại ID chuẩn mid.$ (nếu trước đó là ID tạm), tên người gỡ/nhóm đầy đủ và danh sách media đã làm sạch
            const existingItem = unsentMessagesList[existingIdx];
            let changed = false;
            if (fiberId && existingItem.messageId !== fiberId) {
              existingItem.messageId = fiberId;
              changed = true;
            }
            if (
              !isGenericSenderName(resolvedSenderName) &&
              (isGenericSenderName(existingItem.senderName) ||
                (resolvedSenderName.length > (existingItem.senderName || '').length &&
                  resolvedSenderName.includes('•')))
            ) {
              existingItem.senderName = resolvedSenderName;
              existingItem.personName = bestPersonName || existingItem.personName || '';
              existingItem.threadName = bestThreadName || existingItem.threadName || '';
              changed = true;
            }
            if (
              cleanRestored.attachments.length > 0 &&
              JSON.stringify(existingItem.attachments) !== JSON.stringify(cleanRestored.attachments)
            ) {
              existingItem.attachments = cleanRestored.attachments;
              changed = true;
            }
            if (changed) {
              saveToStorage();
            }
          }
        } else {
          rowEl.dataset.fbUnsendOldNotice = 'true';
        }
      }
    );

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

    // 2. Thay "Bình đã xóa một tin nhắn" thành "Bình đã xóa một tin nhắn: <nội dung>"
    // Luôn đặt lại textContent của noticeEl để đảm bảo có dấu ": " tách biệt rõ ràng
    const baseText = (noticeEl.textContent || '').trim().replace(/[:.\s]+$/, '');
    const cleanAttachments = sanitizeAttachmentsList(data.attachments);

    if (data.text) {
      noticeEl.textContent = `${baseText}: `;
      const contentSpan = document.createElement('span');
      contentSpan.className = 'fb-unsend-inline-text';
      contentSpan.textContent = data.text;
      noticeEl.appendChild(contentSpan);
    } else if (cleanAttachments.length > 0) {
      noticeEl.textContent = `${baseText}:`;
    }

    // 3. Nếu có đính kèm hình ảnh / sticker thì hiển thị ngay bên dưới câu chữ trong cùng bong bóng
    if (cleanAttachments.length > 0) {
      const mediaContainer = document.createElement('div');
      mediaContainer.className = 'fb-unsend-media-list';
      cleanAttachments.forEach((url) => {
        const img = document.createElement('img');
        img.src = url;
        img.className = 'fb-unsend-restored-img';
        img.title = 'Nhấn để mở ảnh gốc';
        img.addEventListener('click', () => window.open(url, '_blank'));
        // Tự động ẩn nếu URL ảnh cũ đã hết hạn để không hiện khung ảnh lỗi
        img.addEventListener('error', () => {
          img.remove();
        });
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
    // Yêu cầu injected.js gắn data-fb-msg-id (mid.$...) từ React Fiber ngay lập tức trước khi quét DOM
    requestMainWorldFiberScan();
    setTimeout(() => {
      domScanScheduled = false;
      scanChatMessagesInDom();
    }, 60);
  }

  function startDomObserver() {
    if (!document.body) {
      window.addEventListener('DOMContentLoaded', startDomObserver, { once: true });
      return;
    }

    // Đợi 1 giây sau khi trang khởi tạo xong để không ảnh hưởng quá trình Hydrate của React (#418)
    setTimeout(() => {
      scheduleDomScan();

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
