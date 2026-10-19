/**
 * injected.js - Chạy trong MAIN world ở thời điểm document_start trên facebook.com
 * Nhiệm vụ:
 * 1. Đón lõng (Hook) cả Chat thường/Nhóm (WebSocket, Lightspeed JSON) VÀ Chat mã hóa đầu cuối E2EE
 *    (MessagePort, SharedWorker, Worker, IndexedDB, React Fiber).
 * 2. Hỗ trợ mọi định dạng Message ID (cả "mid.$..." lẫn ID số/chuỗi của E2EE Armadillo/MAW).
 * 3. Phát hiện tin nhắn mới và sự kiện thu hồi (unsend), gửi sang content.js.
 */

(function () {
  if (window.__FB_UNSEND_INJECTED__) return;
  window.__FB_UNSEND_INJECTED__ = true;

  const LOG_PREFIX = '[FB-Unsend-Tracker]';
  console.log(`${LOG_PREFIX} Đã kích hoạt bộ theo dõi dữ liệu ngầm v2.0 (Hỗ trợ E2EE + Lightspeed).`);

  // Bộ nhớ lưu các tin nhắn đã bắt được theo Message ID
  // Map: messageId -> { messageId, text, senderId, threadId, attachments, timestamp, capturedAt, isUnsent }
  const capturedMessages = new Map();

  // Lưu thêm bảng tra cứu phụ theo offlineThreadingId / externalId nếu một tin nhắn có nhiều mã ID
  const aliasIdMap = new Map();

  // WeakSet để đánh dấu các mảng/object đã quét qua, tránh lặp log
  const processedNodes = new WeakSet();

  // Mẫu câu thông báo khi tin nhắn bị thu hồi (Tiếng Việt & Tiếng Anh)
  const UNSEND_PATTERNS = [
    /đã thu hồi một tin nhắn/i,
    /bạn đã thu hồi một tin nhắn/i,
    /đã gỡ một tin nhắn/i,
    /bạn đã gỡ một tin nhắn/i,
    /tin nhắn đã bị thu hồi/i,
    /tin nhắn đã được thu hồi/i,
    /unsent a message/i,
    /you unsent a message/i,
    /removed a message/i,
    /message was unsent/i
  ];

  // Các thông báo hệ thống cố định không phải là nội dung tin nhắn
  const SYSTEM_NOTICE_PATTERNS = [
    /Tin nhắn này đã bị gỡ do không tuân thủ Tiêu chuẩn cộng đồng/i,
    /Mọi thành viên mới của đoạn chat đều có thể xem lịch sử chat/i,
    /đã tham gia đoạn chat này/i,
    /đã rời khỏi nhóm/i,
    /đã tạo nhóm chat/i,
    /đã đặt tên đoạn chat là/i,
    /Bạn đã thêm .* vào đoạn chat/i,
    /Được mã hóa đầu cuối/i,
    /Tin nhắn và cuộc gọi được bảo mật bằng tính năng mã hóa đầu cuối/i,
    /End-to-end encrypted/i
  ];

  function isUnsendNoticeText(str) {
    if (!str || typeof str !== 'string') return false;
    return UNSEND_PATTERNS.some((regex) => regex.test(str.trim()));
  }

  function isSystemNoticeText(str) {
    if (!str || typeof str !== 'string') return false;
    return SYSTEM_NOTICE_PATTERNS.some((regex) => regex.test(str.trim()));
  }

  /**
   * Kiểm tra xem một chuỗi có phải là mã kỹ thuật / tên hàm / ID nội bộ của Facebook hay không
   */
  function isTechnicalString(str) {
    if (!str || typeof str !== 'string') return true;
    const trimmed = str.trim();
    if (trimmed.length === 0) return true;

    if (isSystemNoticeText(trimmed)) return true;

    if (
      trimmed.startsWith('mid.$') ||
      trimmed.startsWith('ee.mid.$') ||
      trimmed.startsWith('wmid.') ||
      trimmed.startsWith('otid.') ||
      trimmed.startsWith('m_') ||
      trimmed.startsWith('thread:') ||
      trimmed.startsWith('user:') ||
      trimmed.startsWith('fbid:') ||
      trimmed.startsWith('ls://') ||
      trimmed.startsWith('data:') ||
      trimmed.startsWith('blob:') ||
      trimmed.startsWith('https://www.facebook.com/selfxss') ||
      trimmed.startsWith('/messaging/lightspeed/') ||
      /^(image|video|audio|file|sticker|gif|attachment)-[0-9a-f_-]+(\.[a-z0-9]+)?$/i.test(trimmed)
    ) {
      return true;
    }

    // Dãy số ID 64-bit dài (12-25 chữ số) là ID kỹ thuật chứ không phải văn bản thường
    if (/^\d{12,25}$/.test(trimmed)) {
      return true;
    }

    if (
      (trimmed.includes('datr=') && trimmed.includes('c_user=')) ||
      trimmed.startsWith('Mozilla/5.0 (')
    ) {
      return true;
    }

    if (!trimmed.includes(' ')) {
      if (
        /^[0-9a-f]{20,64}$/i.test(trimmed) ||
        /^[A-Za-z0-9+/=_-]{36,}$/.test(trimmed) ||
        /^[a-z0-9]+(_[a-z0-9]+)+$/i.test(trimmed) ||
        /^(insert|upsert|update|delete|remove|handle|mark|set|clear|sync|fetch|verify|apply|replace|move|create|ensure|compute|process|execute|send|receive|check|truncate|populate|optimistic|lightspeed|armadillo|maw|wa)[A-Z][a-zA-Z0-9_]*$/.test(
          trimmed
        ) ||
        /^(image|video|audio|application|text)\/[a-z0-9.+-]+$/i.test(trimmed) ||
        /^(true|false|null|undefined|none|pending|sent|delivered|read|optimistic|success|error)$/i.test(
          trimmed
        )
      ) {
        return true;
      }
    }

    return false;
  }

  function extractMediaUrl(str) {
    if (!str || typeof str !== 'string') return null;
    const trimmed = str.trim();
    if (/^https?:\/\/(scontent|video|cdn\.fbsbx\.com|lookaside)/i.test(trimmed)) {
      return trimmed;
    }
    if (trimmed.startsWith('/messaging/lightspeed/media_fallback/')) {
      return `https://www.facebook.com${trimmed}`;
    }
    return null;
  }

  function emitToContentScript(eventType, payload) {
    try {
      window.postMessage(
        {
          source: 'FB_UNSEND_EXTENSION_MAIN',
          type: eventType,
          payload: payload
        },
        '*'
      );
    } catch (_) {}
  }

  function resolveCanonicalMessageId(id) {
    if (!id) return '';
    const strId = String(id).trim();
    return aliasIdMap.get(strId) || strId;
  }

  /**
   * Lưu hoặc cập nhật tin nhắn bắt được (hỗ trợ cả Chat thường và Chat mã hóa E2EE)
   */
  function registerCapturedMessage(msgData) {
    let { messageId, altIds, text, senderId, threadId, senderName, attachments, timestamp, source } = msgData;
    if (!messageId) return;

    messageId = resolveCanonicalMessageId(messageId);
    if (Array.isArray(altIds)) {
      for (const alt of altIds) {
        if (alt && String(alt) !== messageId) {
          aliasIdMap.set(String(alt), messageId);
        }
      }
    }

    if (text && isUnsendNoticeText(text)) {
      triggerMessageUnsent(messageId, { senderId, threadId, unsendNotice: text, source });
      return;
    }

    const cleanText =
      text && !isTechnicalString(text) && !isUnsendNoticeText(text) ? text.trim() : '';
    const cleanAttachments = Array.isArray(attachments) ? attachments.filter(Boolean) : [];

    const existing = capturedMessages.get(messageId);

    if (!cleanText && cleanAttachments.length === 0) {
      return;
    }

    const finalText = existing?.text ? existing.text : cleanText;

    const mergedAttachments = [...(existing?.attachments || [])];
    for (const url of cleanAttachments) {
      if (!mergedAttachments.includes(url)) {
        mergedAttachments.push(url);
      }
    }

    const isActuallyNew =
      !existing ||
      (!existing.text && finalText) ||
      mergedAttachments.length > (existing.attachments?.length || 0);

    const updatedRecord = {
      messageId,
      text: finalText,
      senderId: senderId || existing?.senderId || '',
      threadId: threadId || existing?.threadId || '',
      senderName: senderName || existing?.senderName || '',
      attachments: mergedAttachments,
      timestamp: timestamp || existing?.timestamp || Date.now(),
      capturedAt: existing?.capturedAt || Date.now(),
      source: source || existing?.source || 'ls',
      isUnsent: existing?.isUnsent || false
    };

    capturedMessages.set(messageId, updatedRecord);

    if (isActuallyNew) {
      console.log(
        `${LOG_PREFIX} 📩 Đã lưu tin nhắn [${messageId}] (${updatedRecord.source}):`,
        updatedRecord.text || `(Đính kèm: ${updatedRecord.attachments.length} media)`
      );
      emitToContentScript('FB_MSG_CAPTURED', updatedRecord);
    }
  }

  /**
   * Đánh dấu một tin nhắn đã bị gỡ và báo ngay cho content.js
   */
  function triggerMessageUnsent(rawMessageId, extraInfo = {}) {
    const messageId = resolveCanonicalMessageId(rawMessageId);
    if (!messageId) return;

    const existing = capturedMessages.get(messageId);
    if (existing?.isUnsent) return;

    const record = {
      messageId,
      text: existing?.text || extraInfo.fallbackText || '',
      senderId: existing?.senderId || extraInfo.senderId || '',
      threadId: existing?.threadId || extraInfo.threadId || '',
      senderName: existing?.senderName || extraInfo.senderName || '',
      attachments: existing?.attachments || extraInfo.attachments || [],
      timestamp: existing?.timestamp || Date.now(),
      capturedAt: existing?.capturedAt || Date.now(),
      unsentAt: Date.now(),
      source: extraInfo.source || existing?.source || 'unknown',
      isUnsent: true
    };

    capturedMessages.set(messageId, record);

    console.log(
      `${LOG_PREFIX} 🚨 PHÁT HIỆN GỠ TIN NHẮN [${messageId}]! Nội dung gốc:`,
      record.text ||
        (record.attachments.length > 0
          ? `[Media: ${record.attachments.join(', ')}]`
          : '(Đang đối chiếu vị trí trên khung chat...)')
    );

    emitToContentScript('FB_MSG_UNSENT', record);
  }

  // ============================================================================
  // BỘ PHÂN TÍCH 1: Cây lệnh Lightspeed & Mảng dữ liệu E2EE (MAW / ReStore)
  // ============================================================================
  function inspectLightspeedNode(
    node,
    context = { fromRealtime: false, currentFunc: '', packetHasUnsendText: false, source: 'ls' }
  ) {
    if (!node || typeof node !== 'object') return;
    if (processedNodes.has(node)) return;
    processedNodes.add(node);

    if (Array.isArray(node)) {
      let currentFunc = context.currentFunc;

      // Nhận diện lời gọi hàm Lightspeed [5, "funcName", ...] hoặc mảng lệnh E2EE ["funcName", ...]
      if (node.length >= 2 && node[0] === 5 && typeof node[1] === 'string') {
        currentFunc = node[1];
      } else if (
        node.length >= 2 &&
        typeof node[0] === 'string' &&
        /Message|Unsent|Snippet|Attachment|Thread/i.test(node[0])
      ) {
        currentFunc = node[0];
      }

      let directMsgIds = [];
      let directAltIds = [];
      let directTextLiterals = [];
      let directMediaUrls = [];
      let directI64Values = [];
      let nullMarkerCount = 0;
      let hasUnsendNoticeInNode = false;

      const isMessageRelatedFunc =
        /insertNewMessageRange|upsertMessage|insertMessage|replaceOptimisticMessage|deleteThenInsertMessage|markMessageUnsent|handleUnsendMessage|deleteMessage|updateMessage|setMessageText|maw|armadillo/i.test(
          currentFunc
        );

      for (let i = 0; i < node.length; i++) {
        const item = node[i];
        if (typeof item === 'string') {
          const trimmed = item.trim();
          if (
            trimmed.startsWith('mid.$') ||
            trimmed.startsWith('wmid.') ||
            trimmed.startsWith('otid.')
          ) {
            directMsgIds.push(trimmed);
          } else if (trimmed.startsWith('ee.mid.$')) {
            directAltIds.push(trimmed.replace(/^ee\./, ''));
          } else if (/^\d{15,22}$/.test(trimmed)) {
            // Trong E2EE & Lightspeed, chuỗi số 15-22 chữ số thường là offlineThreadingId / messageId
            directAltIds.push(trimmed);
          } else if (isUnsendNoticeText(trimmed)) {
            hasUnsendNoticeInNode = true;
          } else {
            const mediaUrl = extractMediaUrl(trimmed);
            if (mediaUrl) {
              directMediaUrls.push(mediaUrl);
            } else if (
              !(node[0] === 5 && i === 1) &&
              !(i === 0 && trimmed === currentFunc)
            ) {
              if (!isTechnicalString(trimmed)) {
                directTextLiterals.push(trimmed);
              }
            }
          }
        } else if (Array.isArray(item)) {
          if (item.length === 1 && item[0] === 9) {
            nullMarkerCount++;
          } else if (item.length === 2 && item[0] === 19 && typeof item[1] === 'string') {
            directI64Values.push(item[1]);
          }
        }
      }

      // Trong E2EE, đôi khi không có mid.$ mà dùng trực tiếp chuỗi số 64-bit làm ID tin nhắn trong hàm Message
      if (directMsgIds.length === 0 && isMessageRelatedFunc && directAltIds.length > 0) {
        directMsgIds.push(directAltIds[0]);
      }

      // Kiểm tra xem có bất kỳ ID nào trong node này trùng với tin nhắn đã lưu trước đó không
      if (directMsgIds.length === 0) {
        for (const candidateId of [...directAltIds, ...directI64Values]) {
          const resolved = resolveCanonicalMessageId(candidateId);
          if (capturedMessages.has(resolved)) {
            directMsgIds.push(resolved);
            break;
          }
        }
      }

      if (directMsgIds.length > 0) {
        const primaryId = directMsgIds[0];
        const allIds = [...directMsgIds, ...directAltIds];

        let timestamp = null;
        let ids = [];
        for (const val of directI64Values) {
          const num = Number(val);
          if (num > 1577836800000 && num < 2051222400000) {
            if (!timestamp) timestamp = num;
          } else if (val.length >= 5 && val !== '0') {
            ids.push(val);
          }
        }

        const threadId = ids[0] || '';
        const senderId = ids[1] || ids[0] || '';

        const isExplicitUnsendFunc =
          /deleteThenInsertMessage|markMessageUnsent|handleUnsendMessage|deleteMessage|unsent|retract|recall|tombstone/i.test(
            currentFunc
          );

        const isReactionOrReadFunc =
          /Reaction|ReadReceipt|MarkRead|Typing|Presence|Delivery|Optimistic/i.test(
            currentFunc
          );

        const resolvedId = resolveCanonicalMessageId(primaryId);
        const existingMsg = capturedMessages.get(resolvedId);

        if (hasUnsendNoticeInNode || isExplicitUnsendFunc) {
          triggerMessageUnsent(resolvedId, {
            threadId,
            senderId,
            source: context.source
          });
        } else if (directTextLiterals.length > 0 || directMediaUrls.length > 0) {
          registerCapturedMessage({
            messageId: primaryId,
            altIds: allIds,
            text: directTextLiterals[0] || '',
            senderId,
            threadId,
            attachments: directMediaUrls,
            timestamp: timestamp || Date.now(),
            source: context.source
          });
        } else if (
          existingMsg &&
          !existingMsg.isUnsent &&
          !isReactionOrReadFunc &&
          (context.packetHasUnsendText ||
            (context.fromRealtime &&
              Date.now() - existingMsg.capturedAt > 400 &&
              (nullMarkerCount >= 2 ||
                /delete|remove|clear|update|upsert|insert|admin|replace/i.test(currentFunc))))
        ) {
          triggerMessageUnsent(resolvedId, {
            threadId,
            senderId,
            source: context.source
          });
        }
      }

      const nextContext = {
        fromRealtime: context.fromRealtime,
        currentFunc,
        packetHasUnsendText: context.packetHasUnsendText || hasUnsendNoticeInNode,
        source: context.source
      };

      for (let i = 0; i < node.length; i++) {
        const child = node[i];
        if (child && typeof child === 'object') {
          if (
            Array.isArray(child) &&
            ((child.length === 2 && child[0] === 19) || (child.length === 1 && child[0] === 9))
          ) {
            continue;
          }
          inspectLightspeedNode(child, nextContext);
        }
      }
      return;
    }

    inspectPlainObject(node, 0, context);
  }

  // ============================================================================
  // BỘ PHÂN TÍCH 2: Object từ E2EE Worker, MessagePort, IndexedDB & React Fiber
  // ============================================================================
  function inspectPlainObject(
    obj,
    depth = 0,
    context = { fromRealtime: false, currentFunc: '', packetHasUnsendText: false, source: 'obj' }
  ) {
    if (!obj || typeof obj !== 'object' || depth > 7) return;
    if (depth === 0) {
      if (processedNodes.has(obj)) return;
      processedNodes.add(obj);
    }

    try {
      if (Array.isArray(obj.step)) {
        inspectLightspeedNode(obj.step, context);
      }

      // Trích xuất ID tin nhắn cho cả chuẩn thường (mid.$) VÀ chuẩn E2EE (externalId, offlineThreadingId, messageId, id...)
      const rawMsgId =
        obj.messageId ||
        obj.message_id ||
        obj.msgId ||
        obj.externalId ||
        obj.external_id ||
        obj.offlineThreadingId ||
        obj.offline_threading_id ||
        obj.otid ||
        (typeof obj.primaryKey === 'string' ? obj.primaryKey : null) ||
        (typeof obj.id === 'string' &&
        (obj.id.startsWith('mid.$') ||
          obj.id.startsWith('wmid.') ||
          obj.text !== undefined ||
          obj.body !== undefined ||
          obj.plaintext !== undefined ||
          obj.isUnsent !== undefined ||
          obj.unsentTimestampMs !== undefined ||
          obj.threadKey !== undefined ||
          obj.threadId !== undefined)
          ? obj.id
          : null);

      if (rawMsgId !== null && rawMsgId !== undefined) {
        const msgId = String(rawMsgId).trim();
        if (msgId.length >= 4) {
          const altIds = [
            obj.messageId,
            obj.externalId,
            obj.offlineThreadingId,
            obj.otid,
            obj.id
          ]
            .filter(Boolean)
            .map(String);

          const textContent =
            obj.text ??
            obj.body ??
            obj.plaintext ??
            obj.messageText ??
            obj.snippet ??
            (typeof obj.message === 'string' ? obj.message : obj.message?.text) ??
            (typeof obj.content === 'string' ? obj.content : obj.content?.text);

          const senderId = String(
            obj.senderId || obj.sender_id || obj.author || obj.actorId || obj.from || ''
          );
          const threadId = String(
            obj.threadId || obj.thread_id || obj.threadKey || obj.threadFbId || obj.chatId || ''
          );
          const senderName = String(obj.senderName || obj.authorName || obj.title || '');
          const timestamp = Number(
            obj.timestampMs || obj.timestamp_ms || obj.timestamp || Date.now()
          );

          const isUnsentFlag =
            obj.isUnsent === true ||
            obj.is_unsent === true ||
            obj.unsent === true ||
            obj.isRevoked === true ||
            obj.type === 'revoked' ||
            obj.type === 'unsent' ||
            (typeof obj.unsentTimestampMs === 'number' && obj.unsentTimestampMs > 0) ||
            (Array.isArray(obj.unsentTimestampMs) &&
              obj.unsentTimestampMs[0] === 19 &&
              obj.unsentTimestampMs[1] !== '0') ||
            obj.messageRenderingType === 2 ||
            (typeof textContent === 'string' && isUnsendNoticeText(textContent));

          if (isUnsentFlag) {
            triggerMessageUnsent(msgId, { senderId, threadId, senderName, source: context.source });
          } else if (
            typeof textContent === 'string' &&
            textContent.trim().length > 0 &&
            !isTechnicalString(textContent)
          ) {
            const attachments = [];
            const attList = obj.attachments || obj.blobAttachments || obj.media || [];
            if (Array.isArray(attList)) {
              for (const att of attList) {
                const url =
                  att?.url ||
                  att?.previewUrl ||
                  att?.playableUrl ||
                  att?.imageUrl ||
                  att?.largePreviewUrl;
                if (url && typeof url === 'string') attachments.push(url);
              }
            }
            registerCapturedMessage({
              messageId: msgId,
              altIds,
              text: textContent,
              senderId,
              threadId,
              senderName,
              attachments,
              timestamp,
              source: context.source
            });
          } else if (
            capturedMessages.has(resolveCanonicalMessageId(msgId)) &&
            (textContent === '' || textContent === null) &&
            (Object.prototype.hasOwnProperty.call(obj, 'text') ||
              Object.prototype.hasOwnProperty.call(obj, 'body') ||
              Object.prototype.hasOwnProperty.call(obj, 'plaintext'))
          ) {
            triggerMessageUnsent(msgId, { senderId, threadId, senderName, source: context.source });
          }
        }
      }

      // Duyệt các thuộc tính con (bỏ qua các node DOM hoặc window để tránh đệ quy vô tận)
      if (obj instanceof Node || obj === window) return;

      const keys = Object.keys(obj);
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        if (key.startsWith('__react') || key === 'ownerDocument' || key === 'parentNode') continue;
        const val = obj[key];
        if (val && typeof val === 'object') {
          if (Array.isArray(val)) {
            inspectLightspeedNode(val, context);
          } else if (!(val instanceof Node)) {
            inspectPlainObject(val, depth + 1, context);
          }
        } else if (
          typeof val === 'string' &&
          val.startsWith('{') &&
          (val.includes('"step"') ||
            val.includes('mid.$') ||
            val.includes('wmid.') ||
            val.includes('Message') ||
            val.includes('Unsent') ||
            isUnsendNoticeText(val))
        ) {
          try {
            const hasUnsendInStr =
              isUnsendNoticeText(val) || /deleteThenInsertMessage|Unsent/i.test(val);
            const parsed = originalJSONParse(val);
            inspectPlainObject(parsed, depth + 1, {
              ...context,
              packetHasUnsendText: context.packetHasUnsendText || hasUnsendInStr
            });
          } catch (_) {}
        }
      }
    } catch (_) {}
  }

  // ============================================================================
  // BỘ PHÂN TÍCH 3: Quét trực tiếp React Fiber (__reactFiber$) cho tin nhắn E2EE
  // ============================================================================
  function extractMessageFromReactFiber(domNode) {
    if (!domNode || typeof domNode !== 'object') return null;
    try {
      const fiberKey = Object.keys(domNode).find(
        (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
      );
      if (!fiberKey) return null;

      let fiber = domNode[fiberKey];
      let steps = 0;

      while (fiber && steps < 25) {
        const props = fiber.memoizedProps || fiber.pendingProps;
        if (props && typeof props === 'object') {
          // Kiểm tra các cấu trúc prop phổ biến của Messenger Web (Comet / MAW E2EE)
          const msgObj =
            props.message ||
            props.msg ||
            props.rowMessage ||
            props.item?.message ||
            props.row?.message ||
            (props.messageId || props.offlineThreadingId ? props : null);

          if (msgObj && typeof msgObj === 'object') {
            const id =
              msgObj.messageId ||
              msgObj.id ||
              msgObj.offlineThreadingId ||
              msgObj.externalId ||
              msgObj.otid;
            const text =
              msgObj.text ??
              msgObj.body ??
              msgObj.plaintext ??
              (typeof msgObj.message === 'string' ? msgObj.message : msgObj.message?.text);
            const isUnsent =
              Boolean(msgObj.isUnsent || msgObj.unsent || msgObj.unsentTimestampMs) ||
              msgObj.messageRenderingType === 2;

            if (id) {
              return {
                messageId: String(id),
                text: typeof text === 'string' ? text : '',
                senderId: String(msgObj.senderId || msgObj.author || ''),
                threadId: String(msgObj.threadId || msgObj.threadKey || ''),
                isUnsent,
                raw: msgObj
              };
            }
          }
        }
        fiber = fiber.return;
        steps++;
      }
    } catch (_) {}
    return null;
  }

  // Lắng nghe yêu cầu quét React Fiber từ content.js hoặc tự động quét các dòng tin nhắn trên DOM
  function scanVisibleChatFiber() {
    if (!document.body) return;
    try {
      const elements = document.querySelectorAll(
        'div[role="row"], div[role="gridcell"], div[data-scope="messages_table"], div[dir="auto"]'
      );
      elements.forEach((el) => {
        const fiberMsg = extractMessageFromReactFiber(el);
        if (fiberMsg && fiberMsg.messageId) {
          const rowContainer =
            el.closest('div[role="row"], div[role="gridcell"], div[data-scope="messages_table"]') ||
            el.parentElement;
          if (rowContainer && rowContainer instanceof HTMLElement) {
            rowContainer.dataset.fbMsgId = fiberMsg.messageId;
          }

          if (fiberMsg.isUnsent) {
            triggerMessageUnsent(fiberMsg.messageId, { source: 'react-fiber' });
          } else if (fiberMsg.text && !isTechnicalString(fiberMsg.text)) {
            if (rowContainer && rowContainer instanceof HTMLElement && !rowContainer.dataset.fbUnsendSavedText) {
              rowContainer.dataset.fbUnsendSavedText = fiberMsg.text;
            }
            registerCapturedMessage({
              messageId: fiberMsg.messageId,
              text: fiberMsg.text,
              senderId: fiberMsg.senderId,
              threadId: fiberMsg.threadId,
              source: 'react-fiber'
            });
          }
        }
      });
    } catch (_) {}
  }

  // Cho phép content.js yêu cầu quét Fiber ngay khi DOM có biến động
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data) return;
    if (event.data.source === 'FB_UNSEND_EXTENSION_CONTENT' && event.data.type === 'SCAN_FIBER') {
      scanVisibleChatFiber();
    }
  });

  // ============================================================================
  // TẦNG HOOK 1: Chặn đọc JSON.parse
  // ============================================================================
  const originalJSONParse = JSON.parse;
  JSON.parse = function (text, reviver) {
    const result = originalJSONParse.apply(this, arguments);
    try {
      if (
        typeof text === 'string' &&
        (text.includes('mid.$') ||
          text.includes('wmid.') ||
          text.includes('upsertMessage') ||
          text.includes('insertNewMessageRange') ||
          text.includes(' insertMessage') ||
          text.includes('deleteThenInsertMessage') ||
          text.includes('deleteMessage') ||
          text.includes('markMessageUnsent') ||
          text.includes('replaceOptimisticMessage') ||
          text.includes('isUnsent') ||
          text.includes('unsentTimestampMs') ||
          text.includes('offlineThreadingId') ||
          isUnsendNoticeText(text))
      ) {
        const packetHasUnsendText =
          isUnsendNoticeText(text) ||
          /deleteThenInsertMessage|markMessageUnsent|handleUnsendMessage/i.test(text);

        queueMicrotask(() => {
          try {
            inspectLightspeedNode(result, {
              fromRealtime: false,
              currentFunc: '',
              packetHasUnsendText,
              source: 'json'
            });
          } catch (_) {}
        });
      }
    } catch (_) {}
    return result;
  };

  // ============================================================================
  // TẦNG HOOK 2: Chặn đọc WebSocket (Cả Chat thường & WebSocket E2EE)
  // ============================================================================
  const OriginalWebSocket = window.WebSocket;
  const textDecoder = new TextDecoder('utf-8', { fatal: false });

  function extractJsonObjectsFromString(rawStr) {
    const packetHasUnsendText =
      isUnsendNoticeText(rawStr) ||
      /deleteThenInsertMessage|markMessageUnsent|handleUnsendMessage|deleteMessage/i.test(rawStr);

    const wsContext = {
      fromRealtime: true,
      currentFunc: '',
      packetHasUnsendText,
      source: 'ws'
    };

    const startIdx = rawStr.indexOf('{');
    const lastIdx = rawStr.lastIndexOf('}');
    if (startIdx === -1 || lastIdx === -1 || lastIdx <= startIdx) return;

    const candidate = rawStr.slice(startIdx, lastIdx + 1);
    try {
      const parsed = originalJSONParse(candidate);
      inspectPlainObject(parsed, 0, wsContext);
    } catch (_) {
      const payloadMatches = rawStr.match(/\{"request_id".*?\}|\{"step":\[.*?\]\}/g);
      if (payloadMatches) {
        for (const m of payloadMatches) {
          try {
            inspectPlainObject(originalJSONParse(m), 0, wsContext);
          } catch (_) {}
        }
      }
    }
  }

  function handleWebSocketFrame(data) {
    try {
      let decoded = '';
      if (typeof data === 'string') {
        decoded = data;
      } else if (data instanceof ArrayBuffer) {
        decoded = textDecoder.decode(new Uint8Array(data));
      } else if (ArrayBuffer.isView(data)) {
        decoded = textDecoder.decode(data);
      } else if (data instanceof Blob) {
        data
          .arrayBuffer()
          .then((buf) => handleWebSocketFrame(buf))
          .catch(() => {});
        return;
      }

      if (
        decoded &&
        (decoded.includes('mid.$') ||
          decoded.includes('wmid.') ||
          decoded.includes('"step"') ||
          decoded.includes('Message') ||
          isUnsendNoticeText(decoded))
      ) {
        extractJsonObjectsFromString(decoded);
      }
    } catch (_) {}
  }

  window.WebSocket = function (url, protocols) {
    const ws =
      protocols !== undefined
        ? new OriginalWebSocket(url, protocols)
        : new OriginalWebSocket(url);

    ws.addEventListener('message', (event) => {
      queueMicrotask(() => {
        handleWebSocketFrame(event.data);
      });
    });

    return ws;
  };
  window.WebSocket.prototype = OriginalWebSocket.prototype;
  Object.assign(window.WebSocket, OriginalWebSocket);

  // ============================================================================
  // TẦNG HOOK 3: Chặn đọc IndexedDB (put / add / delete cho bản ghi E2EE)
  // ============================================================================
  if (window.IDBObjectStore) {
    const origPut = IDBObjectStore.prototype.put;
    const origAdd = IDBObjectStore.prototype.add;
    const origDelete = IDBObjectStore.prototype.delete;

    IDBObjectStore.prototype.put = function (value, key) {
      try {
        if (value && typeof value === 'object') {
          queueMicrotask(() => {
            try {
              inspectPlainObject(value, 0, {
                fromRealtime: true,
                currentFunc: 'IDB.put',
                packetHasUnsendText: false,
                source: 'idb'
              });
            } catch (_) {}
          });
        }
      } catch (_) {}
      return origPut.apply(this, arguments);
    };

    IDBObjectStore.prototype.add = function (value, key) {
      try {
        if (value && typeof value === 'object') {
          queueMicrotask(() => {
            try {
              inspectPlainObject(value, 0, {
                fromRealtime: true,
                currentFunc: 'IDB.add',
                packetHasUnsendText: false,
                source: 'idb'
              });
            } catch (_) {}
          });
        }
      } catch (_) {}
      return origAdd.apply(this, arguments);
    };

    IDBObjectStore.prototype.delete = function (key) {
      try {
        if (typeof key === 'string' || typeof key === 'number') {
          const strKey = String(key);
          const resolved = resolveCanonicalMessageId(strKey);
          if (capturedMessages.has(resolved)) {
            queueMicrotask(() => {
              triggerMessageUnsent(resolved, { source: 'idb-delete' });
            });
          }
        }
      } catch (_) {}
      return origDelete.apply(this, arguments);
    };
  }

  // ============================================================================
  // TẦNG HOOK 4: Chặn đọc MessagePort, SharedWorker & Worker (Kênh E2EE MAW)
  // ============================================================================
  function inspectWorkerChannelData(data, sourceLabel) {
    if (!data) return;
    queueMicrotask(() => {
      try {
        if (typeof data === 'object') {
          if (Array.isArray(data)) {
            inspectLightspeedNode(data, {
              fromRealtime: true,
              currentFunc: sourceLabel,
              packetHasUnsendText: false,
              source: sourceLabel
            });
          } else {
            inspectPlainObject(data, 0, {
              fromRealtime: true,
              currentFunc: sourceLabel,
              packetHasUnsendText: false,
              source: sourceLabel
            });
          }
        } else if (typeof data === 'string' && data.startsWith('{')) {
          const parsed = originalJSONParse(data);
          inspectPlainObject(parsed, 0, {
            fromRealtime: true,
            currentFunc: sourceLabel,
            packetHasUnsendText: false,
            source: sourceLabel
          });
        }
      } catch (_) {}
    });
  }

  // Hook MessagePort.prototype (Cầu nối chính giữa E2EE SharedWorker/Worker và Main Thread)
  if (window.MessagePort) {
    const origPortPostMessage = MessagePort.prototype.postMessage;
    const origPortAddEventListener = MessagePort.prototype.addEventListener;
    const hookedPorts = new WeakSet();

    function ensurePortHooked(port) {
      if (!port || hookedPorts.has(port)) return;
      hookedPorts.add(port);
      origPortAddEventListener.call(port, 'message', (event) => {
        inspectWorkerChannelData(event.data, 'e2ee-port');
      });
    }

    MessagePort.prototype.postMessage = function (message, transfer) {
      ensurePortHooked(this);
      inspectWorkerChannelData(message, 'e2ee-port-out');
      return origPortPostMessage.apply(this, arguments);
    };

    MessagePort.prototype.addEventListener = function (type, listener, options) {
      ensurePortHooked(this);
      return origPortAddEventListener.apply(this, arguments);
    };

    const onmessageDesc = Object.getOwnPropertyDescriptor(MessagePort.prototype, 'onmessage');
    if (onmessageDesc && onmessageDesc.set) {
      Object.defineProperty(MessagePort.prototype, 'onmessage', {
        configurable: true,
        enumerable: true,
        get: onmessageDesc.get,
        set: function (fn) {
          ensurePortHooked(this);
          return onmessageDesc.set.call(this, fn);
        }
      });
    }
  }

  // Hook SharedWorker
  if (window.SharedWorker) {
    const OrigSharedWorker = window.SharedWorker;
    window.SharedWorker = function (scriptURL, options) {
      const sw =
        options !== undefined
          ? new OrigSharedWorker(scriptURL, options)
          : new OrigSharedWorker(scriptURL);
      try {
        if (sw.port) {
          sw.port.addEventListener('message', (event) => {
            inspectWorkerChannelData(event.data, 'e2ee-sharedworker');
          });
        }
      } catch (_) {}
      return sw;
    };
    window.SharedWorker.prototype = OrigSharedWorker.prototype;
    Object.assign(window.SharedWorker, OrigSharedWorker);
  }

  // Hook Dedicated Worker
  if (window.Worker) {
    const OrigWorker = window.Worker;
    window.Worker = function (scriptURL, options) {
      const worker =
        options !== undefined
          ? new OrigWorker(scriptURL, options)
          : new OrigWorker(scriptURL);
      try {
        worker.addEventListener('message', (event) => {
          inspectWorkerChannelData(event.data, 'e2ee-worker');
        });
      } catch (_) {}
      return worker;
    };
    window.Worker.prototype = OrigWorker.prototype;
    Object.assign(window.Worker, OrigWorker);
  }
})();
