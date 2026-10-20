// content.js - Đồng bộ dữ liệu tin nhắn, lưu trữ cục bộ và khôi phục trực tiếp trên giao diện Facebook

(function () {
  const STORAGE_KEY_MESSAGES = 'fb_captured_messages_v2';
  const STORAGE_KEY_UNSENT = 'fb_unsent_messages_v2';
  const STORAGE_KEY_CLEANED_FLAG = 'fb_unsend_schema_v4_cleaned';
  const STORAGE_KEY_TOAST_ENABLED = 'fb_unsend_toast_enabled';
  const MAX_STORED_MESSAGES = 500;

  // Tùy chọn hiện thông báo ở góc màn hình (bật/tắt từ popup), mặc định bật
  let isToastEnabled = true;

  const messagesById = new Map();
  const domRowMessages = new WeakMap();
  let recentMessagesList = [];
  let unsentMessagesList = [];

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
    /^(Đã gửi|Đã nhận|Đã xem|Đang gửi|Đang viết|Sent|Delivered|Seen|Sending|Typing|Enter|Nhấn Enter để gửi|Được mã hóa đầu cuối|End-to-end encrypted|Trả lời|Reply|Chuyển tiếp|Forward|Xem thêm|See more|Bạn đã chuyển tiếp một tin nhắn|\d{1,2}:\d{2}(\s?[AP]M)?(\s+T\d|\s+CN)?)$/i;

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
    const inferredSelf = inferRecordIsSelf(msg);
    const cleanThread = !isGenericSenderName(msg.threadName) ? String(msg.threadName).trim() : '';
    let cleanPerson = !isGenericSenderName(msg.personName) ? String(msg.personName).trim() : '';
    let cleanSender = String(msg.senderName || '').trim();
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
    return {
      ...msg,
      isSelf: inferredSelf,
      personName: cleanPerson || msg.personName || '',
      threadName: cleanThread,
      senderName: finalSender,
      attachments: sanitizeAttachmentsList(msg.attachments)
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
                if (cleaned.threadName !== msg.threadName || cleaned.senderName !== msg.senderName) {
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
                  if (cleaned.threadName !== msg.threadName || cleaned.senderName !== msg.senderName) {
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
      /^(Facebook Chat|Facebook|Messenger|Đoạn chat|Danh sách đoạn chat|Chats|Chat|Cuộc trò chuyện|Nội dung cuộc trò chuyện|Tin nhắn trong cuộc trò chuyện|Thông tin về đoạn chat|Chi tiết đoạn chat|Cuộc trò chuyện đang hoạt động|Conversation|Thread|Messages)$/i.test(
        trimmed
      )
    );
  }

  function normalizeThreadTitle(name) {
    if (!name || typeof name !== 'string') return '';
    const cleaned = name.replace(/(?:\.\.\.|…)+$/g, '').trim();
    if (!cleaned || isGenericSenderName(cleaned)) return '';
    return cleaned;
  }

  function isSameThreadName(threadA, threadB, senderNameB = '') {
    const a = normalizeThreadTitle(threadA).toLowerCase();
    const b = normalizeThreadTitle(threadB).toLowerCase();
    if (!a || !b) return true;
    if (a === b) return true;
    if (a.length >= 3 && b.length >= 3 && (a.includes(b) || b.includes(a))) {
      return true;
    }
    if (senderNameB) {
      const parts = String(senderNameB)
        .split('•')
        .map((s) => normalizeThreadTitle(s).toLowerCase())
        .filter(Boolean);
      for (const part of parts) {
        if (part.length >= 3 && a.length >= 3 && (part.includes(a) || a.includes(part))) {
          return true;
        }
      }
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

    const activeThread = findActiveThreadName();
    const resolvedPerson =
      (!isSelfKeyword(msg.personName) && msg.personName) ||
      (!isSelfKeyword(existing?.personName) && existing?.personName) ||
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

    const merged = {
      ...existing,
      ...msg,
      messageId: bestId,
      isSelf: typeof msg.isSelf === 'boolean' ? msg.isSelf : existing?.isSelf ?? msgIsSelf,
      text: existing?.text || msg.text || '',
      attachments: combinedAttachments,
      personName: resolvedPerson,
      threadName: bestThread,
      senderName: resolvedSenderName,
      timestamp: earliestTimestamp,
      updatedAt: Date.now()
    };

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
        (!isSelfKeyword(newRecord.personName) && newRecord.personName) ||
        (!isSelfKeyword(existingItem.personName) && existingItem.personName) ||
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

      const merged = {
        ...existingItem,
        ...newRecord,
        messageId: bestId,
        isSelf: recIsSelf,
        text: cleanText || existingItem.text || '',
        attachments: mergedAttachments,
        personName: bestPerson,
        threadName: bestThread,
        senderName: resolvedSenderName,
        timestamp: earliestTimestamp,
        rowIndex:
          typeof existingItem.rowIndex === 'number'
            ? existingItem.rowIndex
            : newRecord.rowIndex,
        unsentAt: existingItem.unsentAt || newRecord.unsentAt || Date.now(),
        isUnsent: true
      };

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
      saveToStorage();
      return { record: merged, isNew: false };
    }

    const finalRecord = {
      ...newRecord,
      isSelf: recIsSelf,
      attachments: cleanAttachments,
      timestamp: newRecord.timestamp || getMonotonicTimestamp(),
      unsentAt: newRecord.unsentAt || Date.now(),
      isUnsent: true
    };

    messagesById.set(finalRecord.messageId, finalRecord);
    unsentMessagesList.unshift(finalRecord);
    saveToStorage();
    showUnsentToast(finalRecord);
    notifyUnreadBadge();
    return { record: finalRecord, isNew: true };
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

    const activeThread = findActiveThreadName();
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
      (!isGenericSenderName(activeThread) ? activeThread : '');

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
      timestamp: existing?.timestamp || unsentData.timestamp || getMonotonicTimestamp(),
      rowIndex: existing?.rowIndex,
      unsentAt: Date.now(),
      isUnsent: true
    };

    const { record } = upsertUnsentRecord(candidateRecord);
    requestMainWorldFiberScan();
    setTimeout(() => scanChatMessagesInDom(record), 60);
  }

  const ARIA_CONVERSATION_PREFIX_REGEX =
    /^(?:Cuộc trò chuyện với|Đoạn chat với|Tin nhắn trong cuộc trò chuyện với|Conversation with|Chat with)\s+/i;

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
        const chatContainer = targetEl.closest(
          'div[role="dialog"], div[data-pagelet*="ChatTab"], div[role="main"]'
        );
        if (chatContainer) {
          const ariaElements = [
            chatContainer,
            ...Array.from(
              chatContainer.querySelectorAll(
                '[aria-label*="Cuộc trò chuyện với"], [aria-label*="Đoạn chat với"], [aria-label*="Conversation with"], [aria-label*="Chat with"]'
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
            '[role="heading"]',
            'a[role="link"] span[dir="auto"]',
            'span[dir="auto"]'
          ];
          for (const sel of headerSelectors) {
            const els = chatContainer.querySelectorAll(sel);
            for (const headerEl of els) {
              if (
                headerEl.closest(
                  'div[data-scope="messages_table"], [aria-label="Đoạn chat"], [aria-label="Chats"], [role="grid"], [role="log"]'
                )
              ) {
                continue;
              }
              const rect = headerEl.getBoundingClientRect();
              if (rect.width <= 4 || rect.height <= 4) continue;
              if (containerRect.height > 150 && rect.top > containerRect.top + 110) continue;

              const name = (headerEl.innerText || headerEl.textContent || '').trim().split('\n')[0];
              if (
                name &&
                name.length >= 2 &&
                name.length < 100 &&
                !isGenericSenderName(name) &&
                !UI_IGNORE_REGEX.test(name) &&
                !UNSEND_REGEX.test(name)
              ) {
                return name;
              }
            }
          }
        }
      }

      const fromNotice = extractNameFromNotice(noticeText);
      if (fromNotice && !isSelfKeyword(fromNotice)) return fromNotice;

      const globalAriaEl = document.querySelector(
        '[aria-label*="Cuộc trò chuyện với"], [aria-label*="Đoạn chat với"], [aria-label*="Conversation with"], [aria-label*="Chat with"]'
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

    const rowRect = rowEl.getBoundingClientRect();
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
        rowSenderName,
        isSelf: detectRowIsSelf(rowEl, rowSenderName, null)
      };
    }

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
      if (el.closest('h3, h4, h5, h6')) return;

      const t = extractNodeTextWithEmoji(el).trim();
      if (!t) return;
      if (UNSEND_REGEX.test(t) || UI_IGNORE_REGEX.test(t)) return;
      if (!texts.includes(t)) {
        texts.push(t);
      }
    });

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

    const attachments = [];
    const seenPhotoContainers = new Set();

    rowEl.querySelectorAll('img, video, audio').forEach((mediaEl) => {
      const rawSrc = mediaEl.currentSrc || mediaEl.src || '';
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
    return (
      rowEl.closest('div[role="dialog"], div[data-pagelet*="ChatTab"], div[role="main"]') ||
      document.body
    );
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
        const hasFiberOnAllRows = rows.every((r) => Boolean(r.rowEl.dataset?.fbMsgId));

        const candidates = unsentMessagesList.filter((u) => {
          if (usedMessageIds.has(u.messageId)) return false;
          if (!u.text && (!u.attachments || u.attachments.length === 0)) return false;

          if (hasFiberOnAllRows && u.messageId && u.messageId.startsWith('mid.$')) {
            return false;
          }

          const uIsSelf = inferRecordIsSelf(u);
          if (uIsSelf !== rowIsSelf) return false;

          if (!isSameThreadName(threadName, u.threadName, u.senderName)) {
            return false;
          }

          const uAnchor = (u.anchorAboveText || '').trim();
          if (anchorAboveText && uAnchor && anchorAboveText !== uAnchor) {
            return false;
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
            const rowFiber = targetRow.rowEl.dataset?.fbMsgId;
            if (rowFiber && record.messageId && record.messageId.startsWith('mid.$') && rowFiber !== record.messageId) {
              continue;
            }
            rowToRecordMap.set(targetRow.rowEl, record);
            usedMessageIds.add(record.messageId);
          }
        }
      }
    }

    return rowToRecordMap;
  }

  function scanChatMessagesInDom(specificRecord = null) {
    const chatRows = getActualChatRows();
    if (chatRows.length === 0) return;

    const currentSnapshot = new Map();
    const currentActiveIds = new Set();
    const currentUnsentRows = [];
    const lastOtherSenderByContainer = new Map();
    const lastNormalTextByContainer = new Map();

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
      const anchorAboveText = lastNormalTextByContainer.get(container) || '';

      rowEl.dataset.fbUnsendIsSelf = analysis.isSelf ? 'true' : 'false';

      if (analysis.isUnsentRow) {
        if (!analysis.alreadyRestored && analysis.unsentNoticeEl) {
          currentUnsentRows.push({
            rowEl,
            noticeEl: analysis.unsentNoticeEl,
            rowIndex: index,
            threadName,
            chatContainer: container,
            anchorAboveText,
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
        if (analysis.text) {
          lastNormalTextByContainer.set(container, analysis.text);
        }

        const prev = domRowMessages.get(rowEl);
        const fiberMsgId = rowEl.dataset?.fbMsgId || '';

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
          : analysis.rowSenderName ||
            safePrev?.personName ||
            rowEl.dataset?.fbUnsendSavedSender ||
            inheritedOtherSender ||
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
          isSelf: analysis.isSelf,
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

        if (!safePrev || idUpgraded || textUpgraded || attachmentsUpgraded) {
          handleCapturedMessage(record);
        }
      }
    });

    const disappearedMessages = [];
    if (isInitialScanDone && visibleMessagesSnapshot.size > 0) {
      for (const [id, oldRec] of visibleMessagesSnapshot.entries()) {
        if (currentActiveIds.has(id)) continue;
        if (oldRec.rowEl && oldRec.rowEl.isConnected) {
          const checkNow = analyzeChatRow(oldRec.rowEl);
          if (!checkNow.isUnsentRow) {
            continue;
          }
        }
        disappearedMessages.push(oldRec);
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
        const fiberId = rowEl.dataset?.fbMsgId || '';

        const isRecordValidForThisRow = (cand) => {
          if (!cand || (!cand.text && (!cand.attachments || cand.attachments.length === 0))) {
            return false;
          }
          if (fiberId && cand.messageId && cand.messageId.startsWith('mid.$')) {
            return cand.messageId === fiberId;
          }
          const candIsSelf = inferRecordIsSelf(cand);
          if (candIsSelf !== Boolean(isSelf)) {
            return false;
          }
          if (!isSelf && noticePerson && cand.personName) {
            return isSamePersonName(noticePerson, cand.personName, false);
          }
          return true;
        };

        let restored = null;
        let restoredFromHistory = false;

        if (fiberId) {
          const fromUnsent = unsentMessagesList.find((u) => u.messageId === fiberId);
          const fromCaptured = messagesById.get(fiberId);
          if (isRecordValidForThisRow(fromUnsent)) {
            restored = fromUnsent;
            restoredFromHistory = true;
          } else if (isRecordValidForThisRow(fromCaptured)) {
            restored = fromCaptured;
          }
        }

        if (!restored) {
          const memRec = domRowMessages.get(rowEl);
          if (isRecordValidForThisRow(memRec)) {
            restored = memRec;
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
            if (isRecordValidForThisRow(candidate)) {
              restored = candidate;
            }
          }
        }

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

        if (
          !restored &&
          specificRecord &&
          !rowEl.dataset.fbUnsendOldNotice &&
          isRecordValidForThisRow(specificRecord)
        ) {
          const alreadyUsedOnDom = Boolean(
            specificRecord.messageId &&
              chatContainer.querySelector(
                `div[data-scope="messages_table"][data-fb-unsend-matched-id="${specificRecord.messageId}"]`
              )
          );
          if (!alreadyUsedOnDom) {
            restored = specificRecord;
          }
        }

        if (!restored && historyMatchedMap.has(rowEl)) {
          const histCand = historyMatchedMap.get(rowEl);
          if (isRecordValidForThisRow(histCand)) {
            restored = histCand;
            restoredFromHistory = true;
          }
        }

        if (
          restored &&
          (restored.text || (restored.attachments && restored.attachments.length > 0))
        ) {
          const cleanRestored = {
            ...restored,
            isSelf: typeof restored.isSelf === 'boolean' ? restored.isSelf : isSelf,
            attachments: sanitizeAttachmentsList(restored.attachments)
          };
          if (!cleanRestored.text && cleanRestored.attachments.length === 0) return;

          renderRestoredContentInDom(rowEl, noticeEl, cleanRestored);

          if (restoredFromHistory && cleanRestored.messageId) {
            rowEl.dataset.fbUnsendMatchedId = cleanRestored.messageId;
            if (!cleanRestored.threadName && !isGenericSenderName(threadName)) {
              cleanRestored.threadName = threadName;
              cleanRestored.senderName = formatSenderAndThreadName(
                cleanRestored.personName,
                threadName,
                cleanRestored.senderName
              );
              saveToStorage();
            }
            return;
          }

          const rawPerson =
            (!isSelfKeyword(cleanRestored.personName) && cleanRestored.personName) ||
            noticePerson ||
            rowSenderName ||
            rowEl.dataset?.fbUnsendSavedSender ||
            '';
          const bestPersonName =
            isSelf && currentUserFullName
              ? currentUserFullName
              : isSelfKeyword(rawPerson) && currentUserFullName
                ? currentUserFullName
                : rawPerson;
          const bestThreadName = !isGenericSenderName(threadName)
            ? threadName
            : cleanRestored.threadName || '';

          const resolvedSenderName = formatSenderAndThreadName(
            bestPersonName,
            bestThreadName,
            cleanRestored.senderName || ''
          );

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
            anchorAboveText: cleanRestored.anchorAboveText || anchorAboveText || '',
            timestamp: cleanRestored.timestamp || getMonotonicTimestamp(),
            rowIndex:
              typeof cleanRestored.rowIndex === 'number' ? cleanRestored.rowIndex : rowIndex,
            unsentAt: cleanRestored.unsentAt || Date.now(),
            isUnsent: true
          });

          rowEl.dataset.fbUnsendMatchedId = syncedRecord.messageId;
        } else {
          rowEl.dataset.fbUnsendOldNotice = 'true';
        }
      }
    );

    visibleMessagesSnapshot = currentSnapshot;
    isInitialScanDone = true;
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

  function renderRestoredContentInDom(rowEl, noticeEl, data) {
    if (!noticeEl || rowEl.dataset.fbUnsendRestored === 'true') return;
    rowEl.dataset.fbUnsendRestored = 'true';

    const bubbleEl = findOriginalBubbleElement(noticeEl, rowEl);
    if (bubbleEl) {
      bubbleEl.classList.add('fb-unsend-restored-bubble');
    }

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

    if (cleanAttachments.length > 0) {
      const mediaContainer = document.createElement('div');
      mediaContainer.className = 'fb-unsend-media-list';
      cleanAttachments.forEach((url) => {
        const img = document.createElement('img');
        img.src = url;
        img.className = 'fb-unsend-restored-img';
        img.title = 'Nhấn để phóng to hoặc tải ảnh';
        img.addEventListener('click', (e) => {
          e.stopPropagation();
          openImageLightbox(url);
        });
        img.addEventListener('error', () => {
          img.remove();
        });
        mediaContainer.appendChild(img);
      });
      (bubbleEl || noticeEl.parentElement || noticeEl).appendChild(mediaContainer);
    }
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

    const body = document.createElement('div');
    body.className = 'fb-unsend-toast-body';
    if (record.text) {
      body.textContent = record.text;
    } else {
      body.classList.add('fb-unsend-toast-body-muted');
      body.textContent = record.attachments?.length
        ? `Đính kèm ${record.attachments.length} hình ảnh / nhãn dán`
        : 'Không rõ nội dung';
    }

    toast.appendChild(header);
    toast.appendChild(body);

    const cleanAtt = sanitizeAttachmentsList(record.attachments);
    if (cleanAtt.length > 0) {
      const thumbWrap = document.createElement('div');
      thumbWrap.className = 'fb-unsend-toast-thumbs';
      cleanAtt.slice(0, 3).forEach((url) => {
        const thumb = document.createElement('img');
        thumb.src = url;
        thumb.className = 'fb-unsend-toast-thumb';
        thumb.title = 'Nhấn để phóng to ảnh';
        thumb.addEventListener('click', () => openImageLightbox(url));
        thumbWrap.appendChild(thumb);
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
