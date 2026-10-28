// content.js - Đồng bộ dữ liệu tin nhắn, lưu trữ cục bộ và khôi phục trực tiếp trên giao diện Facebook

(function () {
  const STORAGE_KEY_MESSAGES = 'fb_captured_messages_v2';
  const STORAGE_KEY_UNSENT = 'fb_unsent_messages_v2';
  const STORAGE_KEY_CLEANED_FLAG = 'fb_unsend_schema_v4_cleaned';
  const STORAGE_KEY_TOAST_ENABLED = 'fb_unsend_toast_enabled';
  const MAX_STORED_MESSAGES = 500;

  // Tùy chọn hiện thông báo ở góc màn hình (bật/tắt từ popup), mặc định bật
  let isToastEnabled = true;

  const MAX_LOG_ENTRIES = 600;
  const contentLogBuffer = [];

  function serializeForLog(val, depth = 0) {
    if (val === null || val === undefined) return val;
    if (typeof val === 'string') {
      if (val.length > 300) {
        return `${val.slice(0, 140)}... [len=${val.length}]`;
      }
      return val;
    }
    if (typeof val === 'number' || typeof val === 'boolean') return val;
    if (typeof val === 'function') return `[Function: ${val.name || 'anonymous'}]`;
    if (val instanceof Error) return { message: val.message, stack: val.stack };
    if (typeof Node !== 'undefined' && val instanceof Node) {
      return `[DOMNode: ${val.nodeName}]`;
    }
    if (depth >= 3) {
      return Array.isArray(val) ? `[Array(${val.length})]` : '[Object]';
    }
    if (Array.isArray(val)) {
      return val.slice(0, 25).map((item) => serializeForLog(item, depth + 1));
    }
    if (typeof val === 'object') {
      const out = {};
      const keys = Object.keys(val).slice(0, 25);
      for (const k of keys) {
        try {
          out[k] = serializeForLog(val[k], depth + 1);
        } catch (_) {}
      }
      return out;
    }
    return String(val);
  }

  function dlog(tag, _color, ...args) {
    try {
      contentLogBuffer.push({
        t: new Date().toISOString(),
        ms: Date.now(),
        tag,
        data: args.map((a) => serializeForLog(a, 0))
      });
      if (contentLogBuffer.length > MAX_LOG_ENTRIES) {
        contentLogBuffer.splice(0, contentLogBuffer.length - MAX_LOG_ENTRIES);
      }
    } catch (_) {}
  }

  const messagesById = new Map();
  const domRowMessages = new WeakMap();
  let recentMessagesList = [];
  let unsentMessagesList = [];
  let recentlyDisappearedMessages = [];

  function stripDomReferences(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    const { rowEl, chatContainer, ...clean } = obj;
    return clean;
  }

  dlog('INIT', '#00a8ff', 'content.js đã khởi tạo tại', location.href);

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

  function isTempDomId(id) {
    return !id || typeof id !== 'string' || id.startsWith('dom_') || id.startsWith('unsend_');
  }

  let visibleMessagesSnapshot = new Map();
  let isInitialScanDone = false;

  const UNSEND_REGEX =
    /(đã xóa một tin nhắn|đã xoá một tin nhắn|bạn đã xóa một tin nhắn|bạn đã xoá một tin nhắn|đã thu hồi một tin nhắn|bạn đã thu hồi một tin nhắn|đã gỡ một tin nhắn|bạn đã gỡ một tin nhắn|tin nhắn đã bị thu hồi|tin nhắn đã được thu hồi|tin nhắn đã bị xóa|unsent a message|you unsent a message|deleted a message|you deleted a message|removed a message|message was unsent)/i;

  const UI_IGNORE_REGEX =
    /^(Đã gửi|Đã nhận|Đã xem|Đang gửi|Đang viết|Đang hoạt động|Hoạt động\s+.+\s+trước|Active now|Active\s+.+\s+ago|Sent|Delivered|Seen|Sending|Typing|Enter|Nhấn Enter để gửi|Được mã hóa đầu cuối|End-to-end encrypted|Trả lời|Reply|Chuyển tiếp|Forward|Xem thêm|See more|Bạn đã chuyển tiếp một tin nhắn|\d{1,2}:\d{2}(\s?[AP]M)?(\s+T\d|\s+CN)?)$/i;

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
      /(videoclip|video_clip|\/t42\.|https?:\/\/video[a-z0-9.-]*\.fbcdn\.net|mime=video)/i.test(
        clean
      )
    ) {
      return 'video';
    }
    return 'image';
  }

  function sanitizeAttachmentsList(attachments) {
    if (!Array.isArray(attachments)) return [];
    const valid = [];
    for (const url of attachments) {
      if (!url || typeof url !== 'string') continue;
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
    const dataImages = valid.filter((u) => u.startsWith('data:image/'));
    if (dataImages.length > 0) {
      const nonImages = valid.filter((u) => getAttachmentMediaType(u) !== 'image');
      return [...dataImages, ...nonImages];
    }
    return valid;
  }

  function isExtensionContextValid() {
    try {
      return Boolean(chrome && chrome.runtime && chrome.runtime.id && chrome.storage?.local);
    } catch (_) {
      return false;
    }
  }

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
      if ((!currentUserFullName || !currentUserId) && document.documentElement) {
        const scripts = document.querySelectorAll('script');
        for (const s of scripts) {
          const txt = s.textContent || '';
          if (!txt.includes('CurrentUserInitialData')) continue;
          if (!currentUserId) {
            const idMatch = txt.match(
              /"CurrentUserInitialData"\s*,\s*\[\]\s*,\s*\{[^}]*?"(?:USER_ID|ACCOUNT_ID)"\s*:\s*"(\d+)"/
            );
            if (idMatch && idMatch[1] && idMatch[1] !== '0') {
              currentUserId = idMatch[1];
            }
          }
          if (!currentUserFullName) {
            const nameMatch = txt.match(
              /"CurrentUserInitialData"\s*,\s*\[\]\s*,\s*\{[^}]*?"NAME"\s*:\s*"((?:[^"\\]|\\.)*)"/
            );
            if (nameMatch && nameMatch[1]) {
              try {
                currentUserFullName = JSON.parse(`"${nameMatch[1]}"`).trim();
              } catch (_) {
                currentUserFullName = nameMatch[1].trim();
              }
            }
          }
          if (currentUserId && currentUserFullName) break;
        }
      }
    } catch (_) {}
  }

  function isSelfKeyword(name) {
    return /^(bạn|you|bạn đã gửi|you sent)$/i.test((name || '').trim());
  }

  function isSelfUnsendNotice(noticeText) {
    if (!noticeText || typeof noticeText !== 'string') return false;
    return /^(bạn|you)\s+(đã xóa|đã xoá|đã thu hồi|đã gỡ|unsent|deleted|removed)/i.test(
      noticeText.trim()
    );
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

  function inferRecordIsSelf(rec) {
    if (!rec) return false;
    detectCurrentUserIdentity();
    if (currentUserId && rec.senderId) {
      return String(rec.senderId) === String(currentUserId);
    }
    if (typeof rec.isSelf === 'boolean') return rec.isSelf;
    if (rec.unsendNotice) {
      if (isSelfUnsendNotice(rec.unsendNotice)) return true;
      const np = extractNameFromNotice(rec.unsendNotice);
      if (np && !isSelfKeyword(np)) return false;
    }
    if (isSelfKeyword(rec.personName)) return true;
    return false;
  }

  function sanitizeStoredRecord(msg) {
    if (!msg || typeof msg !== 'object') return msg;
    const base = stripDomReferences(msg);
    const inferredSelf = inferRecordIsSelf(base);
    const cleanThread = !isGenericSenderName(base.threadName) ? String(base.threadName).trim() : '';
    let cleanPerson = !isGenericSenderName(base.personName) ? String(base.personName).trim() : '';
    let cleanSender = String(base.senderName || '').trim();
    if (cleanSender.includes('•')) {
      const parts = cleanSender
        .split('•')
        .map((p) => p.trim())
        .filter((p) => p && !isGenericSenderName(p));
      if (!cleanPerson && parts[0]) cleanPerson = parts[0];
      cleanSender = parts.join(' • ');
    } else if (isGenericSenderName(cleanSender)) {
      cleanSender = '';
    }
    if (inferredSelf && currentUserFullName) {
      cleanPerson = currentUserFullName;
    }
    const finalSender = formatSenderAndThreadName(cleanPerson, cleanThread, cleanSender);
    const cleanAttachments = sanitizeAttachmentsList(base.attachments);
    const cleanText =
      base.text && isAttachmentFilenameText(base.text) && cleanAttachments.length > 0
        ? ''
        : base.text || '';
    return {
      ...base,
      text: cleanText,
      isSelf: inferredSelf,
      personName: cleanPerson || base.personName || '',
      threadName: cleanThread,
      senderName: finalSender,
      attachments: cleanAttachments
    };
  }

  function loadFromStorage() {
    if (!isExtensionContextValid()) return;
    try {
      detectCurrentUserIdentity();
      chrome.storage.local.remove(['fb_captured_messages_v1', 'fb_unsent_messages_v1']);

      chrome.storage.local.get(
        [STORAGE_KEY_MESSAGES, STORAGE_KEY_UNSENT, STORAGE_KEY_CLEANED_FLAG, STORAGE_KEY_TOAST_ENABLED],
        (res) => {
          if (!isExtensionContextValid() || !res) return;
          isToastEnabled = res[STORAGE_KEY_TOAST_ENABLED] !== false;
          try {
            if (!res[STORAGE_KEY_CLEANED_FLAG]) {
              chrome.storage.local.set({
                [STORAGE_KEY_MESSAGES]: [],
                [STORAGE_KEY_UNSENT]: [],
                [STORAGE_KEY_CLEANED_FLAG]: true
              });
              recentMessagesList = [];
              unsentMessagesList = [];
              messagesById.clear();
              scheduleDomScan();
              return;
            }

            let needsResave = false;
            if (Array.isArray(res[STORAGE_KEY_MESSAGES])) {
              recentMessagesList = res[STORAGE_KEY_MESSAGES].map((msg) => {
                const cleaned = sanitizeStoredRecord(msg);
                if (
                  cleaned.text !== msg.text ||
                  cleaned.threadName !== msg.threadName ||
                  cleaned.senderName !== msg.senderName ||
                  msg.rowEl ||
                  msg.chatContainer
                ) {
                  needsResave = true;
                }
                return cleaned;
              });
              for (const msg of recentMessagesList) {
                if (msg.messageId) {
                  messagesById.set(msg.messageId, msg);
                }
              }
            }
            if (Array.isArray(res[STORAGE_KEY_UNSENT])) {
              unsentMessagesList = res[STORAGE_KEY_UNSENT]
                .map((msg) => {
                  const cleaned = sanitizeStoredRecord(msg);
                  if (
                    cleaned.text !== msg.text ||
                    cleaned.threadName !== msg.threadName ||
                    cleaned.senderName !== msg.senderName ||
                    msg.rowEl ||
                    msg.chatContainer
                  ) {
                    needsResave = true;
                  }
                  return cleaned;
                })
                .filter((msg) => msg.text || (msg.attachments && msg.attachments.length > 0));
              for (const msg of unsentMessagesList) {
                if (msg.messageId) {
                  messagesById.set(msg.messageId, msg);
                }
              }
            }
            dlog('STORAGE-LOADED', '#00cec9', {
              capturedCount: recentMessagesList.length,
              unsentCount: unsentMessagesList.length,
              currentUserId,
              currentUserFullName
            });
            if (needsResave) {
              saveToStorage();
            }
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
        const cleanRecent = recentMessagesList.map(stripDomReferences);
        const cleanUnsent = unsentMessagesList.map(stripDomReferences);
        recentMessagesList = cleanRecent;
        unsentMessagesList = cleanUnsent;
        chrome.storage.local.set(
          {
            [STORAGE_KEY_MESSAGES]: cleanRecent,
            [STORAGE_KEY_UNSENT]: cleanUnsent
          },
          () => {
            if (chrome.runtime?.lastError) {
              dlog('STORAGE-ERROR', '#e84118', 'Lỗi khi lưu chrome.storage.local:', chrome.runtime.lastError);
            } else {
              dlog('STORAGE-SAVED', '#00b894', {
                capturedCount: cleanRecent.length,
                unsentCount: cleanUnsent.length
              });
            }
          }
        );
      } catch (err) {
        dlog('STORAGE-EXCEPTION', '#e84118', 'Exception trong saveToStorage:', err);
      }
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

  function buildDomChatRowsSnapshot() {
    try {
      const rows = getActualChatRows();
      return rows.map((rowEl, idx) => {
        const analysis = analyzeChatRow(rowEl);
        const threadName = findActiveThreadName(rowEl);
        const rawText = (rowEl.innerText || rowEl.textContent || '').trim().slice(0, 300);
        const subElements = Array.from(rowEl.querySelectorAll('div, span, h4, h5, h6'))
          .slice(0, 35)
          .map((el) => ({
            tag: el.tagName,
            dir: el.getAttribute('dir') || '',
            childElemCount: el.childElementCount,
            className: typeof el.className === 'string' ? el.className.slice(0, 60) : '',
            text: (el.textContent || '').trim().slice(0, 140)
          }))
          .filter((item) => item.text.length > 0);

        return {
          rowIndex: idx,
          threadName,
          dataset: { ...rowEl.dataset },
          analysis: {
            isUnsentRow: analysis.isUnsentRow,
            alreadyRestored: analysis.alreadyRestored,
            noticeElText: analysis.unsentNoticeEl ? (analysis.unsentNoticeEl.textContent || '').trim() : null,
            text: analysis.text,
            attachmentsCount: analysis.attachments?.length || 0,
            rowSenderName: analysis.rowSenderName,
            isSelf: analysis.isSelf
          },
          hasMemoryRecord: domRowMessages.has(rowEl),
          memoryRecord: serializeForLog(domRowMessages.get(rowEl), 0),
          rawText,
          subElements: analysis.isUnsentRow || !analysis.text ? subElements : undefined
        };
      });
    } catch (e) {
      return [{ error: String(e) }];
    }
  }

  function downloadDebugReport(mainDump = {}) {
    try {
      const report = {
        exportedAt: new Date().toISOString(),
        url: location.href,
        userAgent: navigator.userAgent,
        identity: {
          currentUserId,
          currentUserFullName,
          isToastEnabled
        },
        mainWorld: mainDump,
        contentWorld: {
          contentLogs: contentLogBuffer,
          unsentMessagesList: unsentMessagesList.map((m) => serializeForLog(m, 0)),
          recentMessagesListTail: recentMessagesList.slice(-120).map((m) => serializeForLog(m, 0)),
          recentlyDisappearedMessages: recentlyDisappearedMessages.map((m) => serializeForLog(m, 0)),
          domChatRowsSnapshot: buildDomChatRowsSnapshot()
        }
      };

      const jsonStr = JSON.stringify(report, null, 2);
      const blob = new Blob([jsonStr], { type: 'application/json;charset=utf-8' });
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = `fb-unsend-debug-${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        a.remove();
        URL.revokeObjectURL(blobUrl);
      }, 500);
    } catch (_) {}
  }

  let debugExportFallbackTimer = null;
  function triggerDebugExport() {
    dlog('DEBUG-EXPORT-TRIGGERED', '#00a8ff', 'Người dùng yêu cầu xuất file log debug');
    if (debugExportFallbackTimer) clearTimeout(debugExportFallbackTimer);
    debugExportFallbackTimer = setTimeout(() => {
      debugExportFallbackTimer = null;
      downloadDebugReport({ note: 'MAIN world did not respond within 600ms' });
    }, 600);
    try {
      window.postMessage(
        {
          source: 'FB_UNSEND_EXTENSION_CONTENT',
          type: 'REQUEST_MAIN_DEBUG_DUMP'
        },
        '*'
      );
    } catch (_) {}
  }

  window.addEventListener(
    'keydown',
    (e) => {
      if (e.altKey && e.shiftKey && (e.key === 'D' || e.key === 'd' || e.code === 'KeyD')) {
        e.preventDefault();
        e.stopPropagation();
        triggerDebugExport();
      }
    },
    true
  );

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
    } else if (type === 'FB_WS_RECONNECTED') {
      dlog('WS-RECONNECTED', '#00b894', 'Nhận tín hiệu kết nối lại WebSocket, quét lại DOM & Fiber');
      scheduleDomScan();
      setTimeout(scheduleDomScan, 500);
      setTimeout(scheduleDomScan, 1500);
    } else if (type === 'FB_MAIN_DEBUG_DUMP') {
      if (debugExportFallbackTimer) {
        clearTimeout(debugExportFallbackTimer);
        debugExportFallbackTimer = null;
      }
      downloadDebugReport(payload);
    }
  });

  function isGenericSenderName(name) {
    if (!name || typeof name !== 'string') return true;
    const trimmed = name.trim();
    if (!trimmed || !/[\p{L}\p{N}]/u.test(trimmed)) return true;
    return (
      /^(Facebook Chat|Facebook|Messenger|Đoạn chat|Danh sách đoạn chat|Chats|Chat|Cuộc trò chuyện|Nội dung cuộc trò chuyện|Tin nhắn trong cuộc trò chuyện|Thông tin về đoạn chat|Chi tiết đoạn chat|Cuộc trò chuyện đang hoạt động|Conversation|Thread|Messages|inbox|pending|other|archived|spam|Đang hoạt động|Hoạt động\s+.+\s+trước|Active now|Active\s+.+\s+ago)$/i.test(
        trimmed
      )
    );
  }

  function getRowMessageId(rowEl) {
    if (!rowEl || !(rowEl instanceof HTMLElement)) return '';
    let raw =
      rowEl.dataset?.messageId ||
      rowEl.getAttribute('data-message-id') ||
      rowEl.dataset?.fbMsgId ||
      '';
    if (!raw) {
      const childWithId = rowEl.querySelector('[data-message-id], [data-fb-msg-id]');
      if (childWithId instanceof HTMLElement) {
        raw =
          childWithId.dataset?.messageId ||
          childWithId.getAttribute('data-message-id') ||
          childWithId.dataset?.fbMsgId ||
          '';
      }
    }
    return String(raw).trim().replace(/^ee\./, '');
  }

  function chooseBestPersonName(...candidates) {
    const valid = [];
    for (const c of candidates) {
      if (!c || typeof c !== 'string') continue;
      const trimmed = c.trim();
      if (!trimmed || isGenericSenderName(trimmed) || isSelfKeyword(trimmed)) continue;
      valid.push(trimmed);
    }
    if (valid.length === 0) {
      for (const c of candidates) {
        if (c && typeof c === 'string' && isSelfKeyword(c.trim())) {
          return currentUserFullName || 'Bạn';
        }
      }
      return '';
    }
    let best = valid[0];
    for (let i = 1; i < valid.length; i++) {
      const cand = valid[i];
      if (
        cand.length > best.length &&
        cand.toLowerCase().includes(best.toLowerCase())
      ) {
        best = cand;
      }
    }
    return best;
  }

  function normalizeThreadTitle(name) {
    if (!name || typeof name !== 'string') return '';
    const cleaned = name.replace(/(?:\.\.\.|…)+$/g, '').trim();
    if (!cleaned || isGenericSenderName(cleaned)) return '';
    return cleaned;
  }

  function isSameThreadName(threadA, threadB, senderNameB = '') {
    const a = normalizeThreadTitle(threadA).toLowerCase();
    let b = normalizeThreadTitle(threadB).toLowerCase();
    if (!b && senderNameB && String(senderNameB).includes('•')) {
      const parts = String(senderNameB)
        .split('•')
        .map((s) => normalizeThreadTitle(s).toLowerCase())
        .filter(Boolean);
      if (parts.length >= 2) {
        b = parts[parts.length - 1];
      }
    }
    if (!a || !b) return true;
    if (a === b) return true;
    if (a.length >= 3 && b.length >= 3 && (a.includes(b) || b.includes(a))) {
      return true;
    }
    return false;
  }

  function extractNameFromNotice(noticeText) {
    if (!noticeText || typeof noticeText !== 'string') return '';
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

    const msgIsSelf = inferRecordIsSelf(msg);
    let existing = messagesById.get(msg.messageId);
    let duplicateIdx = -1;

    if (!existing && (msg.text || (msg.attachments && msg.attachments.length > 0))) {
      const cleanText = (msg.text || '').trim();
      const msgTime = msg.timestamp || Date.now();
      duplicateIdx = recentMessagesList.findIndex((m) => {
        if (!m || m.messageId === msg.messageId) return false;
        const oneIsTemp = isTempDomId(m.messageId) !== isTempDomId(msg.messageId);
        if (!oneIsTemp) return false;
        if (typeof m.isSelf === 'boolean' && m.isSelf !== msgIsSelf) return false;
        if (cleanText && (m.text || '').trim() === cleanText) {
          return Math.abs((m.timestamp || 0) - msgTime) < 15000;
        }
        return false;
      });
      if (duplicateIdx !== -1) {
        existing = recentMessagesList[duplicateIdx];
      }
    }

    const bestId = !isTempDomId(msg.messageId)
      ? msg.messageId
      : existing && !isTempDomId(existing.messageId)
        ? existing.messageId
        : msg.messageId;

    const contextRow = msg.rowEl || existing?.rowEl || null;
    const activeThread = contextRow ? findActiveThreadName(contextRow) : '';
    const resolvedPerson =
      chooseBestPersonName(msg.personName, existing?.personName) ||
      (msgIsSelf && currentUserFullName ? currentUserFullName : '') ||
      msg.personName ||
      existing?.personName ||
      '';

    const bestThread =
      (!isGenericSenderName(msg.threadName) && msg.threadName) ||
      (!isGenericSenderName(existing?.threadName) && existing?.threadName) ||
      (!isGenericSenderName(activeThread) ? activeThread : '');

    const resolvedSenderName = formatSenderAndThreadName(
      resolvedPerson,
      bestThread,
      msg.senderName || existing?.senderName || ''
    );

    const combinedAttachments = sanitizeAttachmentsList([
      ...(msg.attachments || []),
      ...(existing?.attachments || [])
    ]);

    const earliestTimestamp =
      existing?.timestamp && msg.timestamp
        ? Math.min(existing.timestamp, msg.timestamp)
        : existing?.timestamp || msg.timestamp || getMonotonicTimestamp();

    const rawMergedText = existing?.text || msg.text || '';
    const cleanMergedText =
      rawMergedText && isAttachmentFilenameText(rawMergedText) && combinedAttachments.length > 0
        ? ''
        : rawMergedText;

    const merged = stripDomReferences({
      ...existing,
      ...msg,
      messageId: bestId,
      isSelf: typeof msg.isSelf === 'boolean' ? msg.isSelf : existing?.isSelf ?? msgIsSelf,
      text: cleanMergedText,
      attachments: combinedAttachments,
      personName: resolvedPerson,
      threadName: bestThread,
      senderName: resolvedSenderName,
      anchorAboveText: msg.anchorAboveText || existing?.anchorAboveText || '',
      anchorAboveSender: msg.anchorAboveSender || existing?.anchorAboveSender || '',
      anchorAboveIsSelf:
        typeof msg.anchorAboveIsSelf === 'boolean'
          ? msg.anchorAboveIsSelf
          : existing?.anchorAboveIsSelf,
      timestamp: earliestTimestamp,
      updatedAt: Date.now()
    });

    const isBrandNew = !existing || (!existing.text && merged.text);

    if (existing && existing.messageId && existing.messageId !== bestId) {
      messagesById.delete(existing.messageId);
    }
    messagesById.set(bestId, merged);

    const idx =
      duplicateIdx !== -1
        ? duplicateIdx
        : recentMessagesList.findIndex((m) => m.messageId === bestId || m.messageId === msg.messageId);
    if (idx !== -1) {
      recentMessagesList[idx] = merged;
    } else {
      recentMessagesList.push(merged);
    }

    if (isBrandNew) {
      dlog('CAPTURED', '#4cd137', {
        messageId: bestId,
        text: merged.text,
        personName: merged.personName,
        threadName: merged.threadName,
        anchorAboveText: merged.anchorAboveText
      });
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

  function upsertUnsentRecord(newRecord) {
    const cleanText = (newRecord.text || '').trim();
    const cleanAttachments = sanitizeAttachmentsList(newRecord.attachments);
    const recIsSelf = inferRecordIsSelf(newRecord);

    const existingIdx = unsentMessagesList.findIndex((u) => {
      if (!u) return false;
      if (u.messageId === newRecord.messageId) return true;
      if (newRecord.originalMessageId && u.messageId === newRecord.originalMessageId) return true;

      const hasTempId = isTempDomId(u.messageId) || isTempDomId(newRecord.messageId);
      if (!hasTempId) return false;

      if (typeof u.isSelf === 'boolean' && u.isSelf !== recIsSelf) return false;

      const sameText = cleanText && (u.text || '').trim() === cleanText;
      const sameMedia =
        !cleanText &&
        cleanAttachments.length > 0 &&
        (u.attachments?.length || 0) === cleanAttachments.length;

      if (!sameText && !sameMedia) return false;

      const timeDiff = Math.abs((u.unsentAt || 0) - (newRecord.unsentAt || Date.now()));
      return timeDiff < 20000;
    });

    if (existingIdx !== -1) {
      const existingItem = unsentMessagesList[existingIdx];
      const oldId = existingItem.messageId;
      const bestId = !isTempDomId(newRecord.messageId)
        ? newRecord.messageId
        : !isTempDomId(oldId)
          ? oldId
          : newRecord.messageId || oldId;

      const mergedAttachments = sanitizeAttachmentsList([
        ...cleanAttachments,
        ...(existingItem.attachments || [])
      ]);

      const bestPerson =
        chooseBestPersonName(newRecord.personName, existingItem.personName) ||
        (recIsSelf && currentUserFullName ? currentUserFullName : '') ||
        newRecord.personName ||
        existingItem.personName ||
        '';

      const threadCandA = !isGenericSenderName(newRecord.threadName) ? newRecord.threadName : '';
      const threadCandB = !isGenericSenderName(existingItem.threadName) ? existingItem.threadName : '';
      const bestThread =
        normalizeThreadTitle(threadCandA).length >= normalizeThreadTitle(threadCandB).length
          ? threadCandA || threadCandB
          : threadCandB || threadCandA;

      const resolvedSenderName = formatSenderAndThreadName(
        bestPerson,
        bestThread,
        newRecord.senderName || existingItem.senderName || ''
      );

      const earliestTimestamp =
        existingItem.timestamp && newRecord.timestamp
          ? Math.min(existingItem.timestamp, newRecord.timestamp)
          : existingItem.timestamp || newRecord.timestamp || getMonotonicTimestamp();

      const rawMergedText = cleanText || existingItem.text || '';
      const finalMergedText =
        rawMergedText && isAttachmentFilenameText(rawMergedText) && mergedAttachments.length > 0
          ? ''
          : rawMergedText;

      const merged = stripDomReferences({
        ...existingItem,
        ...newRecord,
        messageId: bestId,
        isSelf: recIsSelf,
        text: finalMergedText,
        attachments: mergedAttachments,
        personName: bestPerson,
        threadName: bestThread,
        senderName: resolvedSenderName,
        anchorAboveText: newRecord.anchorAboveText || existingItem.anchorAboveText || '',
        anchorAboveSender: newRecord.anchorAboveSender || existingItem.anchorAboveSender || '',
        anchorAboveIsSelf:
          typeof newRecord.anchorAboveIsSelf === 'boolean'
            ? newRecord.anchorAboveIsSelf
            : existingItem.anchorAboveIsSelf,
        hasNativePlaceholder: Boolean(
          newRecord.hasNativePlaceholder || existingItem.hasNativePlaceholder
        ),
        timestamp: earliestTimestamp,
        rowIndex:
          typeof existingItem.rowIndex === 'number'
            ? existingItem.rowIndex
            : newRecord.rowIndex,
        unsentAt: existingItem.unsentAt || newRecord.unsentAt || Date.now(),
        isUnsent: true
      });

      unsentMessagesList[existingIdx] = merged;
      if (oldId && oldId !== bestId) {
        messagesById.delete(oldId);
        document
          .querySelectorAll(`div[data-scope="messages_table"][data-fb-unsend-matched-id="${oldId}"]`)
          .forEach((el) => {
            el.dataset.fbUnsendMatchedId = bestId;
          });
      }
      messagesById.set(bestId, merged);
      dlog('UNSENT-MERGED', '#00cec9', 'Cập nhật bản ghi gỡ đã có trong History:', merged);
      updateActiveToastIfPresent(merged);
      saveToStorage();
      return { record: merged, isNew: false };
    }

    const finalCleanText =
      cleanText && isAttachmentFilenameText(cleanText) && cleanAttachments.length > 0
        ? ''
        : cleanText;

    const finalRecord = stripDomReferences({
      ...newRecord,
      text: finalCleanText,
      isSelf: recIsSelf,
      attachments: cleanAttachments,
      timestamp: newRecord.timestamp || getMonotonicTimestamp(),
      unsentAt: newRecord.unsentAt || Date.now(),
      isUnsent: true
    });

    messagesById.set(finalRecord.messageId, finalRecord);
    unsentMessagesList.unshift(finalRecord);
    dlog('UNSENT-ADDED', '#e84118', 'Đã thêm bản ghi gỡ MỚI vào History:', finalRecord);
    saveToStorage();
    showUnsentToast(finalRecord);
    notifyUnreadBadge();
    return { record: finalRecord, isNew: true };
  }

  function handleUnsentEvent(unsentData) {
    dlog('UNSENT-EVENT', '#fdcb6e', 'Nhận sự kiện FB_MSG_UNSENT từ MAIN:', unsentData);
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

    let existing =
      messagesById.get(unsentData.messageId) ||
      (unsentData.rawMessageId ? messagesById.get(unsentData.rawMessageId) : null);

    if (!existing && unsentData.messageId) {
      existing =
        recentlyDisappearedMessages.find(
          (d) => d.messageId === unsentData.messageId || d.fiberMsgId === unsentData.messageId
        ) || null;
    }

    const originalText = existing?.text || unsentData.text || '';
    const originalAttachments = sanitizeAttachmentsList([
      ...(existing?.attachments || []),
      ...(unsentData.attachments || [])
    ]);

    if (!originalText && originalAttachments.length === 0) {
      dlog('UNSENT-EVENT-NO-TEXT-YET', '#fbc531', 'Sự kiện gỡ chưa tìm thấy nội dung theo ID, kích hoạt quét Fiber + DOM:', {
        messageId: unsentData.messageId,
        disappearedCount: recentlyDisappearedMessages.length
      });
      requestMainWorldFiberScan();
      setTimeout(() => scanChatMessagesInDom(), 60);
      setTimeout(() => {
        requestMainWorldFiberScan();
        scanChatMessagesInDom();
      }, 250);
      return;
    }

    const noticePerson = extractNameFromNotice(unsentData.unsendNotice);
    const isSelf =
      typeof existing?.isSelf === 'boolean'
        ? existing.isSelf
        : inferRecordIsSelf({
            ...unsentData,
            personName: unsentData.personName || existing?.personName || noticePerson
          });

    if (
      isSelf &&
      (unsentData.personName || existing?.personName) &&
      !isSelfKeyword(unsentData.personName || existing?.personName)
    ) {
      currentUserFullName = (unsentData.personName || existing?.personName).trim();
    }

    const bestPerson =
      (!isSelfKeyword(unsentData.personName) && unsentData.personName) ||
      (!isSelfKeyword(existing?.personName) && existing?.personName) ||
      (!isSelfKeyword(noticePerson) && noticePerson) ||
      (isSelf && currentUserFullName ? currentUserFullName : '') ||
      noticePerson ||
      '';
    const bestThread =
      (!isGenericSenderName(unsentData.threadName) && unsentData.threadName) ||
      (!isGenericSenderName(existing?.threadName) && existing?.threadName) ||
      '';

    const resolvedSenderName = formatSenderAndThreadName(
      bestPerson,
      bestThread,
      unsentData.senderName || existing?.senderName || ''
    );

    const candidateRecord = {
      messageId: unsentData.messageId,
      isSelf,
      text: originalText,
      attachments: originalAttachments,
      senderId: existing?.senderId || unsentData.senderId || '',
      threadId: existing?.threadId || unsentData.threadId || '',
      personName: bestPerson,
      threadName: bestThread,
      senderName: resolvedSenderName,
      anchorAboveText: existing?.anchorAboveText || '',
      anchorAboveSender: existing?.anchorAboveSender || '',
      anchorAboveIsSelf:
        typeof existing?.anchorAboveIsSelf === 'boolean' ? existing.anchorAboveIsSelf : undefined,
      timestamp: existing?.timestamp || unsentData.timestamp || getMonotonicTimestamp(),
      rowIndex: existing?.rowIndex,
      unsentAt: Date.now(),
      isUnsent: true
    };

    const { record } = upsertUnsentRecord(candidateRecord);
    requestMainWorldFiberScan();
    setTimeout(() => scanChatMessagesInDom(record), 60);
    setTimeout(() => scanChatMessagesInDom(record), 300);
    setTimeout(() => scanChatMessagesInDom(record), 600);
  }

  const ARIA_CONVERSATION_PREFIX_REGEX =
    /^(?:Cuộc trò chuyện có tiêu đề|Cuộc trò chuyện với|Đoạn chat cộng đồng|Đoạn chat có tiêu đề|Đoạn chat với|Tin nhắn trong cuộc trò chuyện có tiêu đề|Tin nhắn trong cuộc trò chuyện với|Conversation titled|Conversation with|Community chat|Chat with)\s+/i;

  const HEADER_SUBTITLE_IGNORE_REGEX =
    /^(Đang hoạt động|Hoạt động\s+|Active\s+|Được mã hóa|End-to-end|\d+[\d.,]*\s*(người|thành viên|members|online|đang hoạt động)|Ngoại tuyến|Offline|Đang chờ| Đang kết nối)/i;

  function findActiveThreadName(contextEl = null, noticeText = '') {
    try {
      const hasExplicitContext = contextEl instanceof HTMLElement;
      let targetEl = contextEl;
      if (!hasExplicitContext) {
        const activeRows = getActualChatRows();
        if (activeRows.length > 0) {
          targetEl = activeRows[activeRows.length - 1];
        }
      }

      if (targetEl instanceof HTMLElement) {
        const chatContainer = getChatContainerForRow(targetEl);
        if (chatContainer && chatContainer !== document.body) {
          const ariaElements = [
            chatContainer,
            ...Array.from(
              chatContainer.querySelectorAll(
                '[aria-label*="Cuộc trò chuyện"], [aria-label*="Đoạn chat"], [aria-label*="Conversation"], [aria-label*="Chat with"], [aria-label*="Community chat"]'
              )
            )
          ];

          for (const el of ariaElements) {
            const ariaLabel = (el.getAttribute('aria-label') || '').trim();
            if (!ariaLabel || !ARIA_CONVERSATION_PREFIX_REGEX.test(ariaLabel)) continue;
            const stripped = ariaLabel.replace(ARIA_CONVERSATION_PREFIX_REGEX, '').trim();
            if (stripped && stripped.length < 100 && !isGenericSenderName(stripped)) {
              return stripped;
            }
          }

          const containerRect = chatContainer.getBoundingClientRect();
          const headerSelectors = [
            'h1',
            'h2',
            'h3',
            'h4',
            '[role="heading"]',
            'a[role="link"] span[dir="auto"]',
            'a[role="link"]',
            'div[role="button"] span[dir="auto"]',
            'span[dir="auto"]',
            'div[role="button"] span',
            'span'
          ];
          const foundHeaderTexts = [];
          for (const sel of headerSelectors) {
            const els = chatContainer.querySelectorAll(sel);
            for (const headerEl of els) {
              if (
                headerEl.closest(
                  'div[data-scope="messages_table"], [aria-label="Đoạn chat"], [aria-label="Chats"], [role="grid"], [role="log"], [role="textbox"], .fb-unsend-community-restored-list'
                )
              ) {
                continue;
              }
              if (headerEl.querySelector('span, div, h1, h2, h3, h4')) {
                continue;
              }
              const rect = headerEl.getBoundingClientRect();
              if (rect.width <= 4 || rect.height <= 4) continue;
              if (containerRect.height > 150 && rect.top > containerRect.top + 96) continue;
              if (
                containerRect.width > 180 &&
                rect.left > containerRect.left + containerRect.width * 0.76
              ) {
                continue;
              }

              const name = (headerEl.innerText || headerEl.textContent || '').trim().split('\n')[0];
              if (
                name &&
                name.length >= 2 &&
                name.length < 100 &&
                !isGenericSenderName(name) &&
                !UI_IGNORE_REGEX.test(name) &&
                !UNSEND_REGEX.test(name) &&
                !HEADER_SUBTITLE_IGNORE_REGEX.test(name)
              ) {
                if (!foundHeaderTexts.some((t) => t.toLowerCase() === name.toLowerCase())) {
                  foundHeaderTexts.push(name);
                  if (foundHeaderTexts.length >= 2) break;
                }
              }
            }
            if (foundHeaderTexts.length >= 2) break;
          }

          if (foundHeaderTexts.length === 1) {
            return foundHeaderTexts[0];
          }
          if (foundHeaderTexts.length >= 2) {
            const primary = foundHeaderTexts[0];
            const secondary = foundHeaderTexts[1];
            if (
              secondary.length <= 45 &&
              !primary.toLowerCase().includes(secondary.toLowerCase()) &&
              !secondary.toLowerCase().includes(primary.toLowerCase())
            ) {
              return `${primary} (${secondary})`;
            }
            return primary;
          }
        }

        if (hasExplicitContext) {
          const fromNotice = extractNameFromNotice(noticeText);
          if (fromNotice && !isSelfKeyword(fromNotice)) return fromNotice;
          return 'Facebook Chat';
        }
      }

      const fromNotice = extractNameFromNotice(noticeText);
      if (fromNotice && !isSelfKeyword(fromNotice)) return fromNotice;

      const globalAriaEl = document.querySelector(
        '[aria-label*="Cuộc trò chuyện"], [aria-label*="Đoạn chat"], [aria-label*="Conversation"], [aria-label*="Chat with"]'
      );
      if (globalAriaEl) {
        const aria = (globalAriaEl.getAttribute('aria-label') || '').trim();
        if (ARIA_CONVERSATION_PREFIX_REGEX.test(aria)) {
          const stripped = aria.replace(ARIA_CONVERSATION_PREFIX_REGEX, '').trim();
          if (stripped && !isGenericSenderName(stripped)) return stripped;
        }
      }
    } catch (_) {}
    return 'Facebook Chat';
  }

  function extractSenderFromChatRow(rowEl) {
    if (!rowEl || !(rowEl instanceof HTMLElement)) return '';

    const senderHeaders = rowEl.querySelectorAll('h4, h5, h6');
    for (const h of senderHeaders) {
      if (h.closest('.fb-unsend-community-restored-list')) continue;
      const raw = (h.innerText || h.textContent || '').trim().split('\n')[0];
      if (!raw) continue;
      if (/^(Bạn đã gửi|You sent)$/i.test(raw)) return 'Bạn';
      if (
        raw.length >= 2 &&
        raw.length <= 60 &&
        /[\p{L}\p{N}]/u.test(raw) &&
        !UNSEND_REGEX.test(raw) &&
        !UI_IGNORE_REGEX.test(raw)
      ) {
        return raw;
      }
    }

    const rowRect = rowEl.getBoundingClientRect();
    const imgs = rowEl.querySelectorAll('img[alt]');
    for (const img of imgs) {
      if (img.closest('.fb-unsend-community-restored-list')) continue;
      const src = img.getAttribute('src') || img.currentSrc || '';
      if (/emoji\.php|rsrc\.php|static\.xx\.fbcdn\.net/i.test(src)) continue;
      const alt = (img.getAttribute('alt') || '').trim();
      if (!alt || alt.length < 2 || alt.length > 60 || !/[\p{L}\p{N}]/u.test(alt)) continue;
      if (
        /^(Đã xem|Seen by|Hình ảnh|Ảnh|Image|Photo|Sticker|Nhãn dán|Mở |Open )/i.test(alt) ||
        UI_IGNORE_REGEX.test(alt)
      ) {
        continue;
      }
      const rect = img.getBoundingClientRect();
      const w = rect.width || img.clientWidth || img.width || 0;
      const isLeftAvatar =
        rowRect.width === 0 || rect.left <= rowRect.left + rowRect.width * 0.45;
      if ((w === 0 || w <= 52) && isLeftAvatar) {
        return alt;
      }
    }

    return '';
  }

  function detectRowIsSelf(rowEl, rowSenderName = '', noticeEl = null) {
    if (!rowEl || !(rowEl instanceof HTMLElement)) return false;

    if (noticeEl) {
      const noticeText = (noticeEl.textContent || '').trim();
      if (isSelfUnsendNotice(noticeText)) return true;
      const np = extractNameFromNotice(noticeText);
      if (np && !isSelfKeyword(np)) return false;
    }

    if (rowSenderName) {
      if (isSelfKeyword(rowSenderName)) return true;
      return false;
    }

    if (rowEl.dataset?.fbUnsendIsSelf === 'true') return true;
    if (rowEl.dataset?.fbUnsendIsSelf === 'false') return false;

    try {
      const rowRect = rowEl.getBoundingClientRect();
      const targetEl =
        noticeEl ||
        rowEl.querySelector('div[dir="auto"]') ||
        rowEl.querySelector('img, video, audio');
      if (targetEl && rowRect.width > 120) {
        const targetRect = targetEl.getBoundingClientRect();
        if (targetRect.width > 0 && targetRect.width < rowRect.width * 0.92) {
          const leftGap = targetRect.left - rowRect.left;
          const rightGap = rowRect.right - targetRect.right;
          if (leftGap > rightGap + 24) return true;
          if (rightGap > leftGap + 24) return false;
        }
      }
    } catch (_) {}

    return false;
  }

  function isAvatarOrDecorativeImage(imgEl, rawSrc, rowSenderName = '') {
    if (!rawSrc || rawSrc.startsWith('data:image/svg')) return true;

    if (
      /\/t39\.30808-1\/|p50x50|p100x100|s100x100|p60x60|p40x40|dst-jpg_s\d+x\d+|emoji\.php|rsrc\.php|static\.xx\.fbcdn\.net/i.test(
        rawSrc
      )
    ) {
      return true;
    }

    if (!imgEl.complete || imgEl.naturalWidth <= 64 || imgEl.naturalHeight <= 64) {
      return true;
    }

    const rect = imgEl.getBoundingClientRect();
    if (rect.width <= 58 || rect.height <= 58) {
      return true;
    }

    const alt = (imgEl.getAttribute('alt') || '').trim();
    if (alt) {
      if (/^(Đã xem|Seen by)/i.test(alt)) return true;
      if (rowSenderName && alt.toLowerCase() === rowSenderName.toLowerCase()) return true;
    }

    if (imgEl.closest('svg, [role="button"][aria-label*="cảm xúc"]')) {
      return true;
    }

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

  const cachedImageMap = new Map();
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

  function getActualChatRows() {
    if (!document.body) return [];
    const rows = Array.from(document.querySelectorAll('div[data-scope="messages_table"]'));
    return rows.filter((row) => {
      if (row.closest('[aria-label="Đoạn chat"], [aria-label="Chats"]')) return false;
      return true;
    });
  }

  function analyzeChatRow(rowEl) {
    if (!rowEl || !(rowEl instanceof HTMLElement)) {
      return {
        isUnsentRow: false,
        alreadyRestored: false,
        unsentNoticeEl: null,
        text: '',
        attachments: [],
        rowSenderName: '',
        isSelf: false
      };
    }

    const rowSenderName = extractSenderFromChatRow(rowEl);

    const hasRestoredDomNodes = Array.from(
      rowEl.querySelectorAll('.fb-unsend-inline-text, .fb-unsend-media-list')
    ).some((el) => !el.closest('.fb-unsend-community-restored-list'));
    const currentFiberId = getRowMessageId(rowEl);
    const restoredMid = rowEl.dataset.fbUnsendRestoredMid || '';
    const isMidChanged = Boolean(
      currentFiberId &&
        restoredMid &&
        currentFiberId.startsWith('mid.$') &&
        restoredMid.startsWith('mid.$') &&
        currentFiberId !== restoredMid
    );

    if (rowEl.dataset.fbUnsendRestored === 'true' || hasRestoredDomNodes) {
      if (!hasRestoredDomNodes || isMidChanged) {
        dlog('ROW-RESET', '#fd79a8', 'Phát hiện React re-render hoặc đổi messageId trên dòng đã khôi phục, reset để vẽ lại:', {
          hasRestoredDomNodes,
          currentFiberId,
          restoredMid
        });
        delete rowEl.dataset.fbUnsendRestored;
        delete rowEl.dataset.fbUnsendRestoredMid;
        if (isMidChanged) {
          delete rowEl.dataset.fbUnsendMatchedId;
        }
        rowEl.querySelectorAll('.fb-unsend-inline-text, .fb-unsend-media-list').forEach((n) => {
          if (!n.closest('.fb-unsend-community-restored-list')) {
            n.remove();
          }
        });
        rowEl
          .querySelectorAll('.fb-unsend-restored-bubble')
          .forEach((n) => {
            if (!n.closest('.fb-unsend-community-restored-list')) {
              n.classList.remove('fb-unsend-restored-bubble');
            }
          });
      } else {
        return {
          isUnsentRow: true,
          alreadyRestored: true,
          unsentNoticeEl: null,
          text: '',
          attachments: [],
          rowSenderName,
          isSelf: detectRowIsSelf(rowEl, rowSenderName, null)
        };
      }
    }

    let unsentNoticeEl = null;
    const allElements = rowEl.querySelectorAll('div, span, i, em');
    for (const el of allElements) {
      if (el.closest('h3, h4, h5, h6, .fb-unsend-community-restored-list')) continue;
      if (el.childElementCount === 0) {
        const txt = (el.textContent || '').trim();
        if (txt && txt.length < 180 && UNSEND_REGEX.test(txt)) {
          unsentNoticeEl = el;
          break;
        }
      }
    }

    if (!unsentNoticeEl) {
      for (const el of allElements) {
        if (el.closest('h3, h4, h5, h6, .fb-unsend-community-restored-list')) continue;
        const txt = (el.textContent || '').trim();
        if (txt && txt.length < 180 && UNSEND_REGEX.test(txt)) {
          const hasMatchingChild = Array.from(el.querySelectorAll('div, span, i, em')).some((c) => {
            if (c.closest('.fb-unsend-community-restored-list')) return false;
            const cTxt = (c.textContent || '').trim();
            return cTxt && cTxt.length < 180 && UNSEND_REGEX.test(cTxt);
          });
          if (!hasMatchingChild) {
            unsentNoticeEl = el;
            break;
          }
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
        rowSenderName,
        isSelf: detectRowIsSelf(rowEl, rowSenderName, unsentNoticeEl)
      };
    }

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
      if (el.closest('h3, h4, h5, h6, .fb-unsend-community-restored-list')) return;

      const t = extractNodeTextWithEmoji(el).trim();
      if (!t) return;
      if (UNSEND_REGEX.test(t) || UI_IGNORE_REGEX.test(t)) return;
      if (!texts.includes(t)) {
        texts.push(t);
      }
    });

    if (texts.length === 0) {
      rowEl.querySelectorAll('img[src*="emoji.php"][alt]').forEach((emojiImg) => {
        if (
          emojiImg.closest(
            '[aria-label*="cảm xúc"], [aria-label*="reaction"], [role="button"][tabindex="0"], .fb-unsend-community-restored-list'
          )
        ) {
          return;
        }
        const alt = (emojiImg.getAttribute('alt') || '').trim();
        if (alt && !texts.includes(alt)) {
          texts.push(alt);
        }
      });
    }

    const attachments = [];
    const seenPhotoContainers = new Set();

    rowEl.querySelectorAll('img, video, audio').forEach((mediaEl) => {
      if (mediaEl.closest('.fb-unsend-community-restored-list, .fb-unsend-media-list')) return;
      const sourceChild =
        mediaEl.tagName !== 'IMG' ? mediaEl.querySelector('source[src]') : null;
      const rawSrc =
        mediaEl.currentSrc ||
        mediaEl.src ||
        (sourceChild ? sourceChild.getAttribute('src') || '' : '');
      if (!rawSrc || rawSrc.startsWith('data:image/svg')) return;

      if (mediaEl.tagName === 'IMG') {
        if (isAvatarOrDecorativeImage(mediaEl, rawSrc, rowSenderName)) {
          return;
        }

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

      if (!rawSrc.startsWith('blob:') && !attachments.includes(rawSrc)) {
        attachments.push(rawSrc);
      }
    });

    if (rowEl.dataset?.fbFiberMedia) {
      try {
        const fiberUrls = JSON.parse(rowEl.dataset.fbFiberMedia);
        if (Array.isArray(fiberUrls)) {
          for (const fUrl of fiberUrls) {
            if (typeof fUrl === 'string' && fUrl && !attachments.includes(fUrl)) {
              attachments.push(fUrl);
            }
          }
        }
      } catch (_) {}
    }

    return {
      isUnsentRow: false,
      alreadyRestored: false,
      unsentNoticeEl: null,
      text: texts.join('\n').trim(),
      attachments: sanitizeAttachmentsList(attachments),
      rowSenderName,
      isSelf: detectRowIsSelf(rowEl, rowSenderName, null)
    };
  }

  function isSamePersonName(nameA, nameB, allowSelfAlias = false) {
    const a = (nameA || '').trim().toLowerCase();
    const b = (nameB || '').trim().toLowerCase();
    if (!a || !b) return false;
    if (a === b) return true;
    if (allowSelfAlias && isCurrentUserName(a) && isCurrentUserName(b)) {
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

    const explicitContainer = rowEl.closest(
      'div[role="dialog"], div[data-pagelet*="ChatTab"], div[aria-label^="Cuộc trò chuyện "], div[aria-label^="Đoạn chat "], div[aria-label^="Tin nhắn trong cuộc trò chuyện "], div[aria-label^="Conversation "], div[aria-label^="Chat with "], div[aria-label^="Community chat "]'
    );
    if (explicitContainer) return explicitContainer;

    const rowRect = rowEl.getBoundingClientRect();
    const isFloatingWidthRow =
      rowRect.width > 0 && rowRect.width <= 480 && !rowEl.closest('div[role="main"]');

    let curr = rowEl.parentElement;
    let bestCandidate = null;
    for (
      let depth = 0;
      depth < 20 && curr && curr !== document.body && curr !== document.documentElement;
      depth++
    ) {
      if (curr.getAttribute('role') === 'main') {
        return bestCandidate || curr;
      }
      const aria = (curr.getAttribute('aria-label') || '').trim();
      if (aria && ARIA_CONVERSATION_PREFIX_REGEX.test(aria)) {
        return curr;
      }

      const grids = curr.querySelectorAll('[role="grid"], [role="log"]');
      if (grids.length > 1) {
        break;
      }

      const textboxes = curr.querySelectorAll('[role="textbox"][contenteditable="true"]');
      if (textboxes.length > 1) {
        break;
      }

      const rect = curr.getBoundingClientRect();
      if (isFloatingWidthRow && rect.width > 540) {
        break;
      }

      if (rect.width >= 200 && rect.height >= 180) {
        const hasHeaderOutsideMessages = Array.from(
          curr.querySelectorAll(
            'h1, h2, h3, h4, [role="heading"], a[role="link"], div[role="button"] span, span[dir="auto"]'
          )
        ).some(
          (el) =>
            !el.closest(
              'div[data-scope="messages_table"], [role="grid"], [role="log"], [role="textbox"], .fb-unsend-community-restored-list'
            ) && Boolean((el.textContent || '').trim())
        );
        if (hasHeaderOutsideMessages) {
          bestCandidate = curr;
          if (rect.width <= 540 && rect.height <= window.innerHeight) {
            const parentRect = curr.parentElement?.getBoundingClientRect();
            const parentTextboxes =
              curr.parentElement?.querySelectorAll('[role="textbox"][contenteditable="true"]')
                .length || 0;
            if (
              !parentRect ||
              parentRect.width > 540 ||
              parentRect.height === 0 ||
              parentTextboxes > 1
            ) {
              return curr;
            }
          }
        }
      }

      curr = curr.parentElement;
    }

    return bestCandidate || rowEl.closest('div[role="main"]') || document.body;
  }

  function matchUnsentRowsFromSavedHistory(unmatchedRows) {
    if (!unmatchedRows.length || !unsentMessagesList.length) return new Map();

    const rowToRecordMap = new Map();
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

      container
        .querySelectorAll('div[data-scope="messages_table"][data-fb-unsend-matched-id]')
        .forEach((el) => {
          if (el.dataset.fbUnsendMatchedId) {
            usedMessageIds.add(el.dataset.fbUnsendMatchedId);
          }
        });

      const remainingRows = [];
      for (const item of containerRows) {
        const fiberId = getRowMessageId(item.rowEl);
        if (fiberId) {
          const exactMatch = unsentMessagesList.find(
            (u) => u.messageId === fiberId || u.originalMessageId === fiberId
          );
          if (exactMatch && (exactMatch.text || exactMatch.attachments?.length)) {
            rowToRecordMap.set(item.rowEl, exactMatch);
            usedMessageIds.add(exactMatch.messageId);
            continue;
          }
        }
        remainingRows.push(item);
      }

      if (remainingRows.length === 0) continue;

      const groups = new Map();
      for (const item of remainingRows) {
        const noticeText = (item.noticeEl?.textContent || '').trim();
        const rowIsSelf = Boolean(item.isSelf);
        const noticePerson = rowIsSelf
          ? 'Bạn'
          : extractNameFromNotice(noticeText) || item.rowSenderName || '';
        const anchorKey = (item.anchorAboveText || '').trim().toLowerCase();
        const groupKey = `${rowIsSelf ? 'SELF' : 'OTHER'}__${noticePerson.toLowerCase()}__${(
          item.threadName || ''
        ).toLowerCase()}__${anchorKey}`;
        if (!groups.has(groupKey)) {
          groups.set(groupKey, {
            rowIsSelf,
            noticePerson,
            threadName: item.threadName || '',
            anchorAboveText: (item.anchorAboveText || '').trim(),
            rows: []
          });
        }
        groups.get(groupKey).rows.push(item);
      }

      for (const group of groups.values()) {
        const { rowIsSelf, noticePerson, threadName, anchorAboveText, rows } = group;
        const pLower = noticePerson.toLowerCase();
        const maxRowFirstSeen = Math.max(
          ...rows.map((r) => Number(r.rowEl.dataset?.fbUnsendFirstSeenAt) || Date.now())
        );

        const candidates = unsentMessagesList.filter((u) => {
          if (usedMessageIds.has(u.messageId)) return false;
          if (!u.text && (!u.attachments || u.attachments.length === 0)) return false;

          if (u.unsentAt && u.unsentAt > maxRowFirstSeen + 3000) {
            return false;
          }

          const uIsSelf = inferRecordIsSelf(u);
          if (uIsSelf !== rowIsSelf) return false;

          if (!isSameThreadName(threadName, u.threadName, u.senderName)) {
            return false;
          }

          const uAnchor = (u.anchorAboveText || '').trim();
          const isVeryRecentUnsend = Boolean(u.unsentAt && Date.now() - u.unsentAt <= 8000);

          if (!isVeryRecentUnsend) {
            if (!anchorAboveText || !uAnchor || anchorAboveText.toLowerCase() !== uAnchor.toLowerCase()) {
              return false;
            }
          } else {
            if (anchorAboveText && uAnchor && anchorAboveText.toLowerCase() !== uAnchor.toLowerCase()) {
              return false;
            }
          }

          if (rowIsSelf) {
            return true;
          }

          if (!pLower) return true;
          const uPerson = (u.personName || '').trim();
          const uSenderParts = (u.senderName || '').split('•').map((s) => s.trim());
          const uSenderPerson = uSenderParts[0] || '';

          return (
            isSamePersonName(noticePerson, uPerson, false) ||
            isSamePersonName(noticePerson, uSenderPerson, false)
          );
        });

        if (candidates.length === 0) continue;

        const selected = candidates
          .slice(0, rows.length)
          .sort((a, b) => {
            const timeDiff = (a.timestamp || 0) - (b.timestamp || 0);
            if (timeDiff !== 0) return timeDiff;
            return (a.rowIndex ?? 0) - (b.rowIndex ?? 0);
          });

        const startRowOffset = Math.max(0, rows.length - selected.length);
        for (let i = 0; i < selected.length; i++) {
          const targetRow = rows[startRowOffset + i];
          const record = selected[i];
          if (targetRow && record) {
            const rowFiber = getRowMessageId(targetRow.rowEl);
            if (
              rowFiber &&
              rowFiber.startsWith('mid.$') &&
              record.messageId &&
              record.messageId.startsWith('mid.$') &&
              rowFiber !== record.messageId &&
              rowFiber !== record.originalMessageId
            ) {
              continue;
            }
            rowToRecordMap.set(targetRow.rowEl, record);
            usedMessageIds.add(record.messageId);
            if (!record.hasNativePlaceholder) {
              record.hasNativePlaceholder = true;
            }
          }
        }
      }
    }

    return rowToRecordMap;
  }

  function isNormalChatContainer(container, threadName, hasNativeUnsentInContainer) {
    if (hasNativeUnsentInContainer) return true;
    if (!container || !(container instanceof HTMLElement)) return false;

    const cleanThread = normalizeThreadTitle(threadName);
    if (cleanThread) {
      const hasNativeHistoryInThread = unsentMessagesList.some((u) => {
        if (!u || !u.hasNativePlaceholder) return false;
        const uThread = normalizeThreadTitle(u.threadName);
        if (!uThread) return false;
        return isSameThreadName(cleanThread, uThread, u.senderName);
      });
      if (hasNativeHistoryInThread) return true;
    }

    const containerRect = container.getBoundingClientRect();
    const callButtons = container.querySelectorAll(
      '[aria-label*="Gọi thoại"], [aria-label*="Gọi video"], [aria-label*="Bắt đầu gọi"], [aria-label*="Audio call"], [aria-label*="Video call"], [aria-label*="Start a voice call"], [aria-label*="Start a video call"]'
    );
    for (const btn of callButtons) {
      const rect = btn.getBoundingClientRect();
      if (rect.width > 4 && rect.height > 4 && rect.top <= containerRect.top + 110) {
        return true;
      }
    }

    return false;
  }

  function scanChatMessagesInDom(specificRecord = null) {
    const chatRows = getActualChatRows();
    if (chatRows.length === 0) return;

    const now = Date.now();
    recentlyDisappearedMessages = recentlyDisappearedMessages.filter(
      (item) => now - (item.disappearedAt || 0) < 25000
    );

    const currentSnapshot = new Map();
    const currentActiveIds = new Set();
    const currentUnsentRows = [];
    const lastOtherSenderByContainer = new Map();
    const lastNormalRowInfoByContainer = new Map();

    chatRows.forEach((rowEl, index) => {
      const container = getChatContainerForRow(rowEl);
      const analysis = analyzeChatRow(rowEl);
      const threadName = findActiveThreadName(rowEl);

      const noticeText = analysis.unsentNoticeEl
        ? (analysis.unsentNoticeEl.textContent || '').trim()
        : '';
      const noticePerson = extractNameFromNotice(noticeText);

      if (!analysis.isSelf) {
        const knownOtherName =
          (!isSelfKeyword(analysis.rowSenderName) && analysis.rowSenderName) ||
          (!isSelfKeyword(noticePerson) && noticePerson) ||
          '';
        if (knownOtherName) {
          lastOtherSenderByContainer.set(container, knownOtherName);
        }
      }

      const inheritedOtherSender = !analysis.isSelf
        ? lastOtherSenderByContainer.get(container) || ''
        : '';
      const lastNormalInfo = lastNormalRowInfoByContainer.get(container) || null;
      const anchorAboveText = lastNormalInfo?.text || '';
      const anchorAboveSender = lastNormalInfo?.personName || '';
      const anchorAboveIsSelf =
        typeof lastNormalInfo?.isSelf === 'boolean' ? lastNormalInfo.isSelf : undefined;

      rowEl.dataset.fbUnsendIsSelf = analysis.isSelf ? 'true' : 'false';

      if (analysis.isUnsentRow) {
        if (!analysis.alreadyRestored && analysis.unsentNoticeEl) {
          if (!rowEl.dataset.fbUnsendFirstSeenAt) {
            rowEl.dataset.fbUnsendFirstSeenAt = String(Date.now());
            dlog('UNSENT-ROW-NEW', '#fdcb6e', 'Phát hiện dòng thông báo gỡ chưa khôi phục trên DOM:', {
              rowIndex: index,
              fiberId: getRowMessageId(rowEl),
              noticeText,
              noticePerson,
              threadName,
              anchorAboveText,
              isSelf: analysis.isSelf,
              savedTextAttr: rowEl.dataset.fbUnsendSavedText || ''
            });
          }
          currentUnsentRows.push({
            rowEl,
            noticeEl: analysis.unsentNoticeEl,
            rowIndex: index,
            threadName,
            chatContainer: container,
            anchorAboveText,
            anchorAboveSender,
            anchorAboveIsSelf,
            isSelf: analysis.isSelf,
            rowSenderName:
              analysis.rowSenderName ||
              rowEl.dataset?.fbUnsendSavedSender ||
              inheritedOtherSender ||
              ''
          });
        }
        return;
      }

      if (analysis.text || analysis.attachments.length > 0) {
        const prev = domRowMessages.get(rowEl);
        const fiberMsgId = getRowMessageId(rowEl);

        const isRecycledNode =
          prev &&
          ((fiberMsgId && prev.fiberMsgId && fiberMsgId !== prev.fiberMsgId) ||
            (analysis.text && prev.text && analysis.text !== prev.text) ||
            (typeof prev.isSelf === 'boolean' && prev.isSelf !== analysis.isSelf) ||
            (analysis.rowSenderName &&
              prev.personName &&
              !isSamePersonName(analysis.rowSenderName, prev.personName, analysis.isSelf)));

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

        const idUpgraded = Boolean(
          safePrev && safePrev.messageId && fiberMsgId && safePrev.messageId !== fiberMsgId
        );
        if (idUpgraded) {
          currentActiveIds.add(safePrev.messageId);
          messagesById.delete(safePrev.messageId);
          const oldIdx = recentMessagesList.findIndex((m) => m.messageId === safePrev.messageId);
          if (oldIdx !== -1) {
            recentMessagesList[oldIdx].messageId = fiberMsgId;
          }
        }

        const personName = analysis.isSelf
          ? currentUserFullName || 'Bạn'
          : chooseBestPersonName(
              analysis.rowSenderName,
              safePrev?.personName,
              rowEl.dataset?.fbUnsendSavedSender,
              inheritedOtherSender
            );

        if (analysis.text) {
          lastNormalRowInfoByContainer.set(container, {
            text: analysis.text,
            personName,
            isSelf: analysis.isSelf
          });
        }

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
          isSelf: analysis.isSelf,
          text: analysis.text || safePrev?.text || '',
          attachments: cleanAttachments,
          personName,
          threadName: !isGenericSenderName(threadName) ? threadName : safePrev?.threadName || '',
          senderName: fullSenderName,
          anchorAboveText: anchorAboveText || safePrev?.anchorAboveText || '',
          anchorAboveSender: anchorAboveSender || safePrev?.anchorAboveSender || '',
          anchorAboveIsSelf:
            typeof anchorAboveIsSelf === 'boolean'
              ? anchorAboveIsSelf
              : safePrev?.anchorAboveIsSelf,
          timestamp: safePrev?.timestamp || existingById?.timestamp || getMonotonicTimestamp(),
          rowIndex: index,
          rowEl,
          chatContainer: container
        };

        domRowMessages.set(rowEl, record);

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

        const textUpgraded = Boolean(
          safePrev && record.text && record.text !== (safePrev.text || '')
        );
        const attachmentsUpgraded =
          safePrev &&
          record.attachments.length > 0 &&
          JSON.stringify(record.attachments) !== JSON.stringify(safePrev.attachments || []);
        const metaUpgraded = Boolean(
          safePrev &&
            ((record.personName && record.personName !== safePrev.personName) ||
              (record.threadName && record.threadName !== safePrev.threadName) ||
              (record.anchorAboveText && record.anchorAboveText !== safePrev.anchorAboveText))
        );
        const storeNeedsEnrich = Boolean(
          existingById &&
            ((record.personName && !existingById.personName) ||
              (record.threadName && isGenericSenderName(existingById.threadName)) ||
              (record.anchorAboveText && !existingById.anchorAboveText))
        );

        if (
          !safePrev ||
          idUpgraded ||
          textUpgraded ||
          attachmentsUpgraded ||
          metaUpgraded ||
          storeNeedsEnrich
        ) {
          handleCapturedMessage(record);
        }
      }
    });

    if (isInitialScanDone && visibleMessagesSnapshot.size > 0) {
      for (const [id, oldRec] of visibleMessagesSnapshot.entries()) {
        if (currentActiveIds.has(id)) continue;
        if (oldRec.rowEl && oldRec.rowEl.isConnected) {
          const checkNow = analyzeChatRow(oldRec.rowEl);
          if (!checkNow.isUnsentRow) {
            continue;
          }
        }
        const alreadyInDisappeared = recentlyDisappearedMessages.some(
          (d) =>
            d.messageId === oldRec.messageId ||
            (d.text && d.text === oldRec.text && Math.abs((d.rowIndex || 0) - (oldRec.rowIndex || 0)) <= 2)
        );
        if (!alreadyInDisappeared) {
          const disappearedEntry = {
            ...oldRec,
            disappearedAt: Date.now()
          };
          recentlyDisappearedMessages.push(disappearedEntry);
          dlog('DOM-DISAPPEARED', '#e17055', 'Tin nhắn vừa biến mất khỏi DOM (đưa vào bộ đệm 25s):', {
            messageId: oldRec.messageId,
            text: oldRec.text,
            personName: oldRec.personName,
            threadName: oldRec.threadName,
            rowIndex: oldRec.rowIndex,
            anchorAboveText: oldRec.anchorAboveText
          });
        }
      }
    }

    if (
      specificRecord &&
      specificRecord.personName &&
      !isSelfKeyword(specificRecord.personName) &&
      !currentUserFullName
    ) {
      const hasNewSelfUnsentRow = currentUnsentRows.some(({ rowEl, isSelf }) => {
        if (rowEl.dataset.fbUnsendRestored === 'true') return false;
        return Boolean(isSelf);
      });
      if (hasNewSelfUnsentRow) {
        currentUserFullName = specificRecord.personName.trim();
        specificRecord.isSelf = true;
      }
    }

    const historyMatchedMap = matchUnsentRowsFromSavedHistory(currentUnsentRows);

    currentUnsentRows.forEach(
      ({
        rowEl,
        noticeEl,
        rowIndex,
        threadName,
        chatContainer,
        anchorAboveText,
        isSelf,
        rowSenderName
      }) => {
        if (rowEl.dataset.fbUnsendRestored === 'true') return;

        const noticeTextBeforeRestore = (noticeEl.textContent || '').trim();
        const noticePerson = extractNameFromNotice(noticeTextBeforeRestore) || rowSenderName || '';
        const fiberId = getRowMessageId(rowEl);
        const firstSeenAt = Number(rowEl.dataset?.fbUnsendFirstSeenAt) || Date.now();
        const isNewlyUnsentRow = Date.now() - firstSeenAt <= 6000;

        const isRecordValidForThisRow = (cand, requireNameMatch = false) => {
          if (!cand || (!cand.text && (!cand.attachments || cand.attachments.length === 0))) {
            return false;
          }
          if (
            fiberId &&
            fiberId.startsWith('mid.$') &&
            cand.messageId &&
            cand.messageId.startsWith('mid.$')
          ) {
            return cand.messageId === fiberId || cand.originalMessageId === fiberId;
          }
          if (cand.unsentAt && cand.unsentAt > firstSeenAt + 3000) {
            return false;
          }
          const candIsSelf = inferRecordIsSelf(cand);
          if (candIsSelf !== Boolean(isSelf)) {
            return false;
          }
          if (!isSameThreadName(threadName, cand.threadName, cand.senderName)) {
            return false;
          }
          if (requireNameMatch && !isSelf && noticePerson && cand.personName) {
            return isSamePersonName(noticePerson, cand.personName, false);
          }
          return true;
        };

        let restored = null;
        let restoredFromHistory = false;
        let matchStrategy = '';

        if (fiberId) {
          const fromUnsent = unsentMessagesList.find(
            (u) => u.messageId === fiberId || u.originalMessageId === fiberId
          );
          const fromCaptured = messagesById.get(fiberId);
          if (isRecordValidForThisRow(fromUnsent, false)) {
            restored = fromUnsent;
            restoredFromHistory = true;
            matchStrategy = 'fiberId-from-unsentHistory';
          } else if (isRecordValidForThisRow(fromCaptured, false)) {
            restored = fromCaptured;
            matchStrategy = 'fiberId-from-capturedMap';
          }
        }

        if (!restored) {
          const memRec = domRowMessages.get(rowEl);
          if (isRecordValidForThisRow(memRec, false)) {
            restored = memRec;
            matchStrategy = 'domRowMessages-WeakMap';
          }
        }

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
              isSelf,
              text: savedText || '',
              attachments: sanitizeAttachmentsList(attachments),
              personName: savedSender || rowSenderName || '',
              threadName,
              senderName: threadName,
              anchorAboveText,
              rowIndex,
              timestamp: getMonotonicTimestamp()
            };
            if (isRecordValidForThisRow(candidate, false)) {
              restored = candidate;
              matchStrategy = 'rowEl-dataset-savedText';
            }
          }
        }

        if (!restored && isNewlyUnsentRow && recentlyDisappearedMessages.length > 0) {
          const matchIdx = recentlyDisappearedMessages.findIndex(
            (oldRec) =>
              oldRec.chatContainer === chatContainer &&
              (Math.abs((oldRec.rowIndex || 0) - rowIndex) <= 3 ||
                (anchorAboveText &&
                  oldRec.anchorAboveText &&
                  anchorAboveText.toLowerCase() === oldRec.anchorAboveText.toLowerCase())) &&
              isRecordValidForThisRow(oldRec, true)
          );
          if (matchIdx !== -1) {
            restored = recentlyDisappearedMessages.splice(matchIdx, 1)[0];
            matchStrategy = 'recentlyDisappearedMessages';
          }
        }

        if (
          !restored &&
          specificRecord &&
          isNewlyUnsentRow &&
          isRecordValidForThisRow(specificRecord, true)
        ) {
          const alreadyUsedOnDom = Boolean(
            specificRecord.messageId &&
              chatContainer.querySelector(
                `div[data-scope="messages_table"][data-fb-unsend-matched-id="${specificRecord.messageId}"]`
              )
          );
          if (!alreadyUsedOnDom) {
            restored = specificRecord;
            matchStrategy = 'specificRecord-from-network';
          }
        }

        if (!restored && historyMatchedMap.has(rowEl)) {
          const histCand = historyMatchedMap.get(rowEl);
          if (isRecordValidForThisRow(histCand, true)) {
            restored = histCand;
            restoredFromHistory = true;
            matchStrategy = 'historyMatchedMap';
          }
        }

        if (
          restored &&
          (restored.text || (restored.attachments && restored.attachments.length > 0))
        ) {
          dlog('RESTORE-HIT', '#00b894', `Khôi phục thành công dòng gỡ qua [${matchStrategy}]:`, {
            fiberId,
            text: restored.text,
            personName: restored.personName,
            threadName,
            anchorAboveText
          });
          const cleanRestored = {
            ...restored,
            isSelf: typeof restored.isSelf === 'boolean' ? restored.isSelf : isSelf,
            attachments: sanitizeAttachmentsList(restored.attachments)
          };
          if (!cleanRestored.text && cleanRestored.attachments.length === 0) return;

          renderRestoredContentInDom(rowEl, noticeEl, cleanRestored);

          const rawPerson = chooseBestPersonName(
            cleanRestored.personName,
            rowSenderName,
            noticePerson,
            rowEl.dataset?.fbUnsendSavedSender
          );
          const bestPersonName =
            isSelf && currentUserFullName
              ? currentUserFullName
              : isSelfKeyword(rawPerson) && currentUserFullName
                ? currentUserFullName
                : rawPerson;
          const bestThreadName = !isGenericSenderName(threadName)
            ? threadName
            : cleanRestored.threadName || '';
          const bestAnchor = cleanRestored.anchorAboveText || anchorAboveText || '';

          const resolvedSenderName = formatSenderAndThreadName(
            bestPersonName,
            bestThreadName,
            cleanRestored.senderName || ''
          );

          if (restoredFromHistory && cleanRestored.messageId) {
            rowEl.dataset.fbUnsendMatchedId = cleanRestored.messageId;
            const needsHistoryEnrich = Boolean(
              !restored.hasNativePlaceholder ||
                (bestPersonName && bestPersonName !== (restored.personName || '')) ||
                (bestThreadName && bestThreadName !== (restored.threadName || '')) ||
                (bestAnchor && !restored.anchorAboveText)
            );
            if (!needsHistoryEnrich) {
              return;
            }
          }

          const initialMsgId =
            fiberId || cleanRestored.messageId || `unsend_${getMonotonicTimestamp()}`;

          const { record: syncedRecord } = upsertUnsentRecord({
            messageId: initialMsgId,
            originalMessageId: cleanRestored.messageId || '',
            isSelf,
            text: cleanRestored.text || '',
            attachments: cleanRestored.attachments || [],
            personName: bestPersonName,
            threadName: bestThreadName,
            senderName: resolvedSenderName,
            anchorAboveText: bestAnchor,
            hasNativePlaceholder: true,
            timestamp: cleanRestored.timestamp || getMonotonicTimestamp(),
            rowIndex:
              typeof cleanRestored.rowIndex === 'number' ? cleanRestored.rowIndex : rowIndex,
            unsentAt: cleanRestored.unsentAt || Date.now(),
            isUnsent: true
          });

          rowEl.dataset.fbUnsendMatchedId = syncedRecord.messageId;
        } else if (isNewlyUnsentRow && !rowEl.dataset.fbUnsendLoggedMiss) {
          rowEl.dataset.fbUnsendLoggedMiss = 'true';
          dlog('RESTORE-MISS', '#d63031', 'Chưa tìm thấy dữ liệu khôi phục cho dòng thông báo gỡ:', {
            fiberId,
            noticeTextBeforeRestore,
            noticePerson,
            threadName,
            isSelf,
            anchorAboveText,
            disappearedCount: recentlyDisappearedMessages.length,
            unsentHistoryCount: unsentMessagesList.length,
            capturedMapSize: messagesById.size
          });
        }
      }
    );

    restoreCommunityUnsentInDom(chatRows, currentActiveIds);

    visibleMessagesSnapshot = currentSnapshot;
    isInitialScanDone = true;
  }

  function restoreCommunityUnsentInDom(chatRows, currentActiveIds) {
    if (!chatRows.length || !unsentMessagesList.length) return;

    const usedNativeIds = new Set();
    document
      .querySelectorAll('div[data-scope="messages_table"][data-fb-unsend-matched-id]')
      .forEach((el) => {
        if (el.dataset.fbUnsendMatchedId) {
          usedNativeIds.add(el.dataset.fbUnsendMatchedId);
        }
      });

    document
      .querySelectorAll('.fb-unsend-community-item[data-fb-unsend-community-id]')
      .forEach((itemEl) => {
        const cid = itemEl.dataset.fbUnsendCommunityId || '';
        if (cid && (currentActiveIds.has(cid) || usedNativeIds.has(cid))) {
          const parentList = itemEl.parentElement;
          itemEl.remove();
          if (parentList && parentList.children.length === 0) {
            parentList.remove();
          }
        }
      });

    const normalRowsByContainer = new Map();
    const allTextsByContainer = new Map();

    chatRows.forEach((rowEl, idx) => {
      const container = getChatContainerForRow(rowEl);
      const isRowNativeUnsent = Boolean(
        rowEl.dataset.fbUnsendRestored === 'true' ||
          rowEl.dataset.fbUnsendFirstSeenAt ||
          rowEl.dataset.fbUnsendMatchedId
      );

      if (!normalRowsByContainer.has(container)) {
        normalRowsByContainer.set(container, {
          threadName: findActiveThreadName(rowEl),
          hasNativeUnsent: false,
          rows: []
        });
        allTextsByContainer.set(container, new Set());
      }

      if (isRowNativeUnsent) {
        normalRowsByContainer.get(container).hasNativeUnsent = true;
      }

      const mem = domRowMessages.get(rowEl);
      const currentText = (mem?.text || '').trim();
      const existingCommList = rowEl.querySelector(':scope > .fb-unsend-community-restored-list');
      if (existingCommList) {
        const expectedAnchor = (rowEl.dataset.fbUnsendCommunityAnchor || '').trim();
        if (!currentText || (expectedAnchor && expectedAnchor.toLowerCase() !== currentText.toLowerCase())) {
          existingCommList.remove();
          delete rowEl.dataset.fbUnsendCommunityAnchor;
        }
      }

      if (!mem || !currentText) return;
      if (
        mem.threadName &&
        !isGenericSenderName(mem.threadName) &&
        isGenericSenderName(normalRowsByContainer.get(container).threadName)
      ) {
        normalRowsByContainer.get(container).threadName = mem.threadName;
      }

      const nextRowEl = chatRows[idx + 1] || null;
      const nextRowIsNativeUnsent = Boolean(
        nextRowEl &&
          (nextRowEl.dataset.fbUnsendRestored === 'true' ||
            nextRowEl.dataset.fbUnsendFirstSeenAt ||
            nextRowEl.dataset.fbUnsendMatchedId)
      );
      normalRowsByContainer.get(container).rows.push({
        rowEl,
        rowIndex: idx,
        text: currentText,
        personName: mem.personName || '',
        isSelf: Boolean(mem.isSelf),
        nextRowIsNativeUnsent
      });
      allTextsByContainer.get(container).add(currentText.toLowerCase());
    });

    if (normalRowsByContainer.size === 0) return;

    const placedUnsentIds = new Set([...currentActiveIds, ...usedNativeIds]);
    let storageNeedsSave = false;

    for (const [container, containerInfo] of normalRowsByContainer.entries()) {
      const { threadName: containerThreadName, hasNativeUnsent, rows } = containerInfo;

      if (isNormalChatContainer(container, containerThreadName, hasNativeUnsent)) {
        if (container && container instanceof HTMLElement) {
          container
            .querySelectorAll('.fb-unsend-community-restored-list')
            .forEach((el) => el.remove());
        }
        continue;
      }

      if (rows.length === 0) continue;

      const otherContainerTexts = new Set();
      for (const [otherCont, textSet] of allTextsByContainer.entries()) {
        if (otherCont !== container) {
          for (const t of textSet) otherContainerTexts.add(t);
        }
      }

      const itemsByRowEl = new Map();

      for (const u of unsentMessagesList) {
        if (!u || !u.messageId || u.hasNativePlaceholder || placedUnsentIds.has(u.messageId)) {
          continue;
        }
        if (!u.text && (!u.attachments || u.attachments.length === 0)) continue;
        if (u.unsentAt && Date.now() - u.unsentAt < 350) continue;

        const uAnchor = (u.anchorAboveText || '').trim();
        if (!uAnchor) continue;
        const uAnchorLower = uAnchor.toLowerCase();

        const isShortGenericAnchor = uAnchor.length <= 3;
        const unsentAgeMs = Date.now() - (u.unsentAt || u.timestamp || 0);
        if (isShortGenericAnchor && unsentAgeMs > 15 * 60 * 1000) {
          continue;
        }

        const matchingRows = rows.filter((r) => {
          if (r.text.toLowerCase() !== uAnchorLower) return false;
          if (typeof u.anchorAboveIsSelf === 'boolean' && r.isSelf !== u.anchorAboveIsSelf) {
            return false;
          }
          if (
            !r.isSelf &&
            u.anchorAboveSender &&
            r.personName &&
            !isSamePersonName(r.personName, u.anchorAboveSender, false)
          ) {
            return false;
          }
          return true;
        });
        if (matchingRows.length === 0) continue;

        const targetRowInfo = matchingRows[matchingRows.length - 1];
        if (targetRowInfo.nextRowIsNativeUnsent) continue;

        const sameThread = isSameThreadName(containerThreadName, u.threadName, u.senderName);
        const uniqueAnchorInThisWindow =
          uAnchor.length >= 10 && !otherContainerTexts.has(uAnchorLower);

        if (!sameThread && !uniqueAnchorInThisWindow) continue;

        if (
          !isGenericSenderName(containerThreadName) &&
          u.threadName !== containerThreadName
        ) {
          u.threadName = containerThreadName;
          u.senderName = formatSenderAndThreadName(
            u.personName,
            containerThreadName,
            u.senderName
          );
          storageNeedsSave = true;
        }

        if (!itemsByRowEl.has(targetRowInfo.rowEl)) {
          itemsByRowEl.set(targetRowInfo.rowEl, {
            anchorText: targetRowInfo.text,
            items: []
          });
        }
        itemsByRowEl.get(targetRowInfo.rowEl).items.push(u);
        placedUnsentIds.add(u.messageId);
      }

      if (itemsByRowEl.size > 0) {
        for (const group of itemsByRowEl.values()) {
          let addedMore = true;
          while (addedMore) {
            addedMore = false;
            for (const u2 of unsentMessagesList) {
              if (
                !u2 ||
                !u2.messageId ||
                u2.hasNativePlaceholder ||
                placedUnsentIds.has(u2.messageId)
              ) {
                continue;
              }
              if (!u2.text && (!u2.attachments || u2.attachments.length === 0)) continue;
              if (u2.unsentAt && Date.now() - u2.unsentAt < 350) continue;

              const u2Anchor = (u2.anchorAboveText || '').trim().toLowerCase();
              const matchedParent = group.items.find((parentItem) => {
                const timeDiff = Math.abs(
                  (u2.unsentAt || u2.timestamp || 0) -
                    (parentItem.unsentAt || parentItem.timestamp || 0)
                );
                if (timeDiff > 90000) return false;

                const parentText = (parentItem.text || '').trim().toLowerCase();
                if (u2Anchor && parentText && u2Anchor === parentText) {
                  return true;
                }
                if (!u2Anchor) {
                  const sameSelf = inferRecordIsSelf(u2) === inferRecordIsSelf(parentItem);
                  const samePerson =
                    sameSelf &&
                    (inferRecordIsSelf(parentItem) ||
                      isSamePersonName(parentItem.personName, u2.personName, false));
                  return samePerson;
                }
                return false;
              });

              if (matchedParent) {
                if (
                  !isGenericSenderName(containerThreadName) &&
                  u2.threadName !== containerThreadName
                ) {
                  u2.threadName = containerThreadName;
                  u2.senderName = formatSenderAndThreadName(
                    u2.personName,
                    containerThreadName,
                    u2.senderName
                  );
                  storageNeedsSave = true;
                }
                group.items.push(u2);
                placedUnsentIds.add(u2.messageId);
                addedMore = true;
              }
            }
          }
        }

        for (const [anchorRowEl, group] of itemsByRowEl.entries()) {
          group.items.sort(
            (a, b) =>
              (a.timestamp || a.unsentAt || 0) - (b.timestamp || b.unsentAt || 0)
          );
          renderCommunityRestoredItemsOnRow(anchorRowEl, group.anchorText, group.items);
        }
      }
    }

    if (storageNeedsSave) {
      saveToStorage();
    }
  }

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

  // Icon SVG dựng bằng DOM (không dùng url()/data: trong CSS để khỏi vướng CSP của Facebook)
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICON_PATHS = {
    unsend: [
      'M20 11.5c0 4.1-3.6 7.5-8 7.5-1 0-1.9-.2-2.8-.5L4 20l1.3-3.9A7.2 7.2 0 0 1 4 11.5C4 7.4 7.6 4 12 4s8 3.4 8 7.5z',
      'M10.2 8.8 8 11l2.2 2.2',
      'M8.2 11h4.8a2.3 2.3 0 0 1 0 4.6h-1.2'
    ],
    close: ['M6 6l12 12', 'M18 6 6 18'],
    download: ['M12 4v11', 'm7 10 5 5 5-5', 'M5 20h14']
  };
  const TOAST_LIFETIME_MS = 6500;

  function createIcon(paths) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'fb-unsend-icon');
    svg.setAttribute('aria-hidden', 'true');
    paths.forEach((d) => {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    });
    return svg;
  }

  function openImageLightbox(url) {
    if (!url || !document.body) return;
    const existing = document.getElementById('fb-unsend-lightbox-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'fb-unsend-lightbox-overlay';

    function onKeyDown(e) {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      closeLightbox();
    }

    function closeLightbox() {
      overlay.remove();
      document.removeEventListener('keydown', onKeyDown, true);
    }

    const modal = document.createElement('div');
    modal.className = 'fb-unsend-lightbox-modal';
    modal.addEventListener('click', (e) => e.stopPropagation());

    const img = document.createElement('img');
    img.src = url;
    img.className = 'fb-unsend-lightbox-img';
    img.alt = 'Ảnh tin nhắn đã khôi phục';

    const downloadBtn = document.createElement('a');
    downloadBtn.href = url;
    downloadBtn.download = `fb-unsent-image-${Date.now()}.webp`;
    downloadBtn.className = 'fb-unsend-lightbox-download';
    downloadBtn.appendChild(createIcon(ICON_PATHS.download));
    downloadBtn.appendChild(document.createTextNode('Tải ảnh về máy'));
    if (!url.startsWith('data:')) {
      downloadBtn.target = '_blank';
      downloadBtn.rel = 'noopener noreferrer';
    }

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'fb-unsend-lightbox-close';
    closeBtn.title = 'Đóng (Esc)';
    closeBtn.setAttribute('aria-label', 'Đóng');
    closeBtn.appendChild(createIcon(ICON_PATHS.close));
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeLightbox();
    });

    modal.appendChild(img);
    modal.appendChild(downloadBtn);
    overlay.appendChild(closeBtn);
    overlay.appendChild(modal);

    overlay.addEventListener('click', closeLightbox);
    document.addEventListener('keydown', onKeyDown, true);
    document.body.appendChild(overlay);
  }

  function createRestoredMediaElement(url, isToast = false) {
    const mediaType = getAttachmentMediaType(url);
    if (mediaType === 'audio') {
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.preload = 'metadata';
      audio.src = url;
      audio.className = isToast ? 'fb-unsend-toast-audio' : 'fb-unsend-restored-audio';
      audio.addEventListener('click', (e) => e.stopPropagation());
      return audio;
    }
    if (mediaType === 'video') {
      const video = document.createElement('video');
      video.controls = true;
      video.preload = 'metadata';
      video.playsInline = true;
      video.src = url;
      video.className = isToast ? 'fb-unsend-toast-video' : 'fb-unsend-restored-video';
      video.addEventListener('click', (e) => e.stopPropagation());
      return video;
    }
    const img = document.createElement('img');
    img.src = url;
    img.className = isToast ? 'fb-unsend-toast-thumb' : 'fb-unsend-restored-img';
    img.title = 'Nhấn để phóng to hoặc tải ảnh';
    img.addEventListener('click', (e) => {
      e.stopPropagation();
      openImageLightbox(url);
    });
    img.addEventListener('error', () => {
      img.remove();
    });
    return img;
  }

  function renderRestoredContentInDom(rowEl, noticeEl, data) {
    if (!noticeEl || rowEl.dataset.fbUnsendRestored === 'true') return;
    rowEl.dataset.fbUnsendRestored = 'true';
    rowEl.dataset.fbUnsendRestoredMid = getRowMessageId(rowEl) || data.messageId || '';

    const bubbleEl = findOriginalBubbleElement(noticeEl, rowEl);
    if (bubbleEl) {
      bubbleEl.classList.add('fb-unsend-restored-bubble');
    }

    const baseText = (noticeEl.textContent || '').trim().replace(/[:.\s]+$/, '');
    const cleanAttachments = sanitizeAttachmentsList(data.attachments);
    const displayText =
      data.text && !(isAttachmentFilenameText(data.text) && cleanAttachments.length > 0)
        ? data.text
        : '';

    if (displayText) {
      noticeEl.textContent = `${baseText}: `;
      const contentSpan = document.createElement('span');
      contentSpan.className = 'fb-unsend-inline-text';
      contentSpan.textContent = displayText;
      noticeEl.appendChild(contentSpan);
    } else if (cleanAttachments.length > 0) {
      noticeEl.textContent = `${baseText}:`;
    }

    if (cleanAttachments.length > 0) {
      const mediaContainer = document.createElement('div');
      mediaContainer.className = 'fb-unsend-media-list';
      cleanAttachments.forEach((url) => {
        mediaContainer.appendChild(createRestoredMediaElement(url, false));
      });
      (bubbleEl || noticeEl.parentElement || noticeEl).appendChild(mediaContainer);
    }
  }

  function renderCommunityRestoredItemsOnRow(anchorRowEl, anchorText, items) {
    if (!anchorRowEl || !(anchorRowEl instanceof HTMLElement) || !items.length) return;

    anchorRowEl.dataset.fbUnsendCommunityAnchor = anchorText;
    let listEl = anchorRowEl.querySelector(':scope > .fb-unsend-community-restored-list');
    if (!listEl) {
      listEl = document.createElement('div');
      listEl.className = 'fb-unsend-community-restored-list';
      anchorRowEl.appendChild(listEl);
    }

    items.forEach((item) => {
      if (!item || !item.messageId) return;
      if (listEl.querySelector(`[data-fb-unsend-community-id="${item.messageId}"]`)) {
        return;
      }

      const itemIsSelf = inferRecordIsSelf(item);
      const cleanAttachments = sanitizeAttachmentsList(item.attachments);
      const displayText =
        item.text && !(isAttachmentFilenameText(item.text) && cleanAttachments.length > 0)
          ? item.text
          : '';
      if (!displayText && cleanAttachments.length === 0) return;

      const wrap = document.createElement('div');
      wrap.className = `fb-unsend-community-item${
        itemIsSelf ? ' fb-unsend-community-item-self' : ''
      }`;
      wrap.dataset.fbUnsendCommunityId = item.messageId;

      const bubble = document.createElement('div');
      bubble.className = 'fb-unsend-community-bubble fb-unsend-restored-bubble';

      const who = itemIsSelf ? 'Bạn' : item.personName || 'Thành viên';
      const labelSpan = document.createElement('span');
      labelSpan.className = 'fb-unsend-community-label';
      labelSpan.textContent = displayText
        ? `${who} đã xóa một tin nhắn: `
        : `${who} đã xóa một tin nhắn:`;
      bubble.appendChild(labelSpan);

      if (displayText) {
        const textSpan = document.createElement('span');
        textSpan.className = 'fb-unsend-inline-text';
        textSpan.textContent = displayText;
        bubble.appendChild(textSpan);
      }

      if (cleanAttachments.length > 0) {
        const mediaContainer = document.createElement('div');
        mediaContainer.className = 'fb-unsend-media-list';
        cleanAttachments.forEach((url) => {
          mediaContainer.appendChild(createRestoredMediaElement(url, false));
        });
        bubble.appendChild(mediaContainer);
      }

      wrap.appendChild(bubble);
      listEl.appendChild(wrap);

      dlog('COMMUNITY-RESTORE-HIT', '#00b894', 'Đã tái tạo tin nhắn gỡ trong Đoạn chat Cộng đồng:', {
        messageId: item.messageId,
        text: displayText,
        personName: item.personName,
        threadName: item.threadName,
        anchorText
      });
    });
  }

  function updateActiveToastIfPresent(record) {
    if (!record || !record.messageId || !document.body) return;
    try {
      const container = document.getElementById('fb-unsend-toast-container');
      if (!container) return;
      const toasts = container.querySelectorAll('.fb-unsend-toast');
      for (const toast of toasts) {
        if (
          toast.dataset.fbUnsendMsgId === record.messageId ||
          (record.originalMessageId && toast.dataset.fbUnsendMsgId === record.originalMessageId)
        ) {
          toast.dataset.fbUnsendMsgId = record.messageId;
          toast.classList.toggle('fb-unsend-toast-self', Boolean(record.isSelf));
          const titleEl = toast.querySelector('.fb-unsend-toast-title');
          if (titleEl) {
            titleEl.textContent = record.isSelf
              ? 'Bạn vừa gỡ một tin nhắn'
              : 'Vừa có tin nhắn bị gỡ';
          }
          const senderEl = toast.querySelector('.fb-unsend-toast-sender');
          if (senderEl && record.senderName) {
            senderEl.textContent = record.senderName;
            senderEl.title = record.senderName;
          }
        }
      }
    } catch (_) {}
  }

  function showUnsentToast(record) {
    // Tắt thông báo chỉ ẩn toast; tin vẫn được khôi phục trên khung chat và lưu lịch sử
    if (!isToastEnabled || !document.body) return;

    let toastContainer = document.getElementById('fb-unsend-toast-container');
    if (!toastContainer) {
      toastContainer = document.createElement('div');
      toastContainer.id = 'fb-unsend-toast-container';
      document.body.appendChild(toastContainer);
    }

    const toast = document.createElement('div');
    toast.className = `fb-unsend-toast${record.isSelf ? ' fb-unsend-toast-self' : ''}`;
    toast.dataset.fbUnsendMsgId = record.messageId || '';

    // ── Đếm ngược tự đóng, tạm dừng khi rê chuột để kịp đọc ──
    let remainingMs = TOAST_LIFETIME_MS;
    let startedAt = Date.now();
    let hideTimer = null;

    function dismissToast() {
      clearTimeout(hideTimer);
      if (!toast.isConnected) return;
      toast.classList.add('fb-unsend-toast-hide');
      setTimeout(() => toast.remove(), 300);
    }

    toast.addEventListener('mouseenter', () => {
      clearTimeout(hideTimer);
      remainingMs -= Date.now() - startedAt;
    });
    toast.addEventListener('mouseleave', () => {
      startedAt = Date.now();
      hideTimer = setTimeout(dismissToast, Math.max(800, remainingMs));
    });

    const header = document.createElement('div');
    header.className = 'fb-unsend-toast-header';

    const iconTile = document.createElement('div');
    iconTile.className = 'fb-unsend-toast-icon';
    iconTile.appendChild(createIcon(ICON_PATHS.unsend));

    const heading = document.createElement('div');
    heading.className = 'fb-unsend-toast-heading';

    const title = document.createElement('div');
    title.className = 'fb-unsend-toast-title';
    title.textContent = record.isSelf ? 'Bạn vừa gỡ một tin nhắn' : 'Vừa có tin nhắn bị gỡ';

    const sender = document.createElement('div');
    sender.className = 'fb-unsend-toast-sender';
    sender.textContent = record.senderName || 'Facebook';
    sender.title = record.senderName || 'Facebook';

    heading.appendChild(title);
    heading.appendChild(sender);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'fb-unsend-toast-close';
    closeBtn.title = 'Đóng thông báo';
    closeBtn.setAttribute('aria-label', 'Đóng thông báo');
    closeBtn.appendChild(createIcon(ICON_PATHS.close));
    closeBtn.addEventListener('click', dismissToast);

    header.appendChild(iconTile);
    header.appendChild(heading);
    header.appendChild(closeBtn);

    const cleanAtt = sanitizeAttachmentsList(record.attachments);
    const displayText =
      record.text && !(isAttachmentFilenameText(record.text) && cleanAtt.length > 0)
        ? record.text
        : '';

    const body = document.createElement('div');
    body.className = 'fb-unsend-toast-body';
    if (displayText) {
      body.textContent = displayText;
    } else {
      body.classList.add('fb-unsend-toast-body-muted');
      if (cleanAtt.length > 0) {
        const hasAudio = cleanAtt.some((u) => getAttachmentMediaType(u) === 'audio');
        const hasVideo = cleanAtt.some((u) => getAttachmentMediaType(u) === 'video');
        if (hasAudio) {
          body.textContent = 'Đính kèm đoạn âm thanh (tin nhắn thoại)';
        } else if (hasVideo) {
          body.textContent = `Đính kèm ${cleanAtt.length} video`;
        } else {
          body.textContent = `Đính kèm ${cleanAtt.length} hình ảnh / nhãn dán`;
        }
      } else {
        body.textContent = 'Không rõ nội dung';
      }
    }

    toast.appendChild(header);
    toast.appendChild(body);

    if (cleanAtt.length > 0) {
      const thumbWrap = document.createElement('div');
      thumbWrap.className = 'fb-unsend-toast-thumbs';
      cleanAtt.slice(0, 3).forEach((url) => {
        thumbWrap.appendChild(createRestoredMediaElement(url, true));
      });
      toast.appendChild(thumbWrap);
    }

    const progress = document.createElement('div');
    progress.className = 'fb-unsend-toast-progress';
    progress.style.animationDuration = `${TOAST_LIFETIME_MS}ms`;
    toast.appendChild(progress);

    toastContainer.appendChild(toast);
    hideTimer = setTimeout(dismissToast, TOAST_LIFETIME_MS);
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
    }, 60);
  }

  try {
    if (isExtensionContextValid() && chrome.storage?.onChanged) {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (!isExtensionContextValid() || areaName !== 'local') return;
        try {
          if (changes[STORAGE_KEY_TOAST_ENABLED]) {
            isToastEnabled = changes[STORAGE_KEY_TOAST_ENABLED].newValue !== false;
          }
          let updated = false;
          if (changes[STORAGE_KEY_MESSAGES]?.newValue) {
            const newMsgs = changes[STORAGE_KEY_MESSAGES].newValue;
            if (Array.isArray(newMsgs)) {
              recentMessagesList = newMsgs.map((msg) => sanitizeStoredRecord(msg));
              for (const msg of recentMessagesList) {
                if (msg.messageId) messagesById.set(msg.messageId, msg);
              }
              updated = true;
            }
          }
          if (changes[STORAGE_KEY_UNSENT]?.newValue) {
            const newUnsent = changes[STORAGE_KEY_UNSENT].newValue;
            if (Array.isArray(newUnsent)) {
              unsentMessagesList = newUnsent
                .map((msg) => sanitizeStoredRecord(msg))
                .filter((msg) => msg.text || (msg.attachments && msg.attachments.length > 0));
              for (const msg of unsentMessagesList) {
                if (msg.messageId) messagesById.set(msg.messageId, msg);
              }
              updated = true;
            }
          }
          if (updated) {
            scheduleDomScan();
          }
        } catch (_) {}
      });
    }
  } catch (_) {}

  function startDomObserver() {
    if (!document.body) {
      window.addEventListener('DOMContentLoaded', startDomObserver, { once: true });
      return;
    }

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

      window.addEventListener('focus', () => {
        scheduleDomScan();
      });

      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          dlog('TAB-VISIBLE', '#00a8ff', 'Tab Facebook hiển thị trở lại, quét lại Fiber & DOM');
          scheduleDomScan();
          setTimeout(scheduleDomScan, 400);
        }
      });

      let lastHref = location.href;
      setInterval(() => {
        if (location.href !== lastHref) {
          lastHref = location.href;
          scheduleDomScan();
          setTimeout(scheduleDomScan, 400);
          setTimeout(scheduleDomScan, 1000);
        } else if (unsentMessagesList.length > 0) {
          const unm = document.querySelector(
            'div[data-scope="messages_table"]:not([data-fb-unsend-restored="true"])'
          );
          if (unm) {
            scheduleDomScan();
          }
        }
      }, 1500);
    }, 1000);
  }

  loadFromStorage();
  startDomObserver();
})();
