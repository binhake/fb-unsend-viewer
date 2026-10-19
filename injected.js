/**
 * injected.js - Chạy trong MAIN world ở thời điểm document_start trên facebook.com
 * Nhiệm vụ:
 * 1. Đón lõng (Hook) các tin nhắn MỚI và sự kiện GỠ/XÓA tin nhắn thời gian thực.
 * 2. Bỏ qua các gói dữ liệu đồng bộ lịch sử cũ khi vừa mở trang để không báo động giả.
 * 3. Hỗ trợ cả câu thông báo "đã xóa một tin nhắn", "đã thu hồi một tin nhắn", "đã gỡ một tin nhắn".
 */

(function () {
  if (window.__FB_UNSEND_INJECTED__) return;
  window.__FB_UNSEND_INJECTED__ = true;

  const LOG_PREFIX = '[FB-Unsend-Tracker]';
  const PAGE_LOAD_TIME = Date.now();
  console.log(`${LOG_PREFIX} Đã kích hoạt bộ theo dõi dữ liệu ngầm v2.1.`);

  // Map: messageId -> { messageId, text, senderId, threadId, attachments, timestamp, capturedAt, isUnsent }
  const capturedMessages = new Map();
  const aliasIdMap = new Map();
  const processedNodes = new WeakSet();

  // Mẫu câu thông báo khi tin nhắn bị thu hồi / xóa (Bao gồm "đã xóa một tin nhắn" trên giao diện FB mới)
  const UNSEND_PATTERNS = [
    /đã xóa một tin nhắn/i,
    /đã xoá một tin nhắn/i,
    /bạn đã xóa một tin nhắn/i,
    /bạn đã xoá một tin nhắn/i,
    /đã thu hồi một tin nhắn/i,
    /bạn đã thu hồi một tin nhắn/i,
    /đã gỡ một tin nhắn/i,
    /bạn đã gỡ một tin nhắn/i,
    /tin nhắn đã bị thu hồi/i,
    /tin nhắn đã được thu hồi/i,
    /tin nhắn đã bị xóa/i,
    /unsent a message/i,
    /you unsent a message/i,
    /deleted a message/i,
    /you deleted a message/i,
    /removed a message/i,
    /message was unsent/i
  ];

  // Các thông báo hệ thống cố định không phải là nội dung tin nhắn người dùng
  const SYSTEM_NOTICE_PATTERNS = [
    /Tin nhắn này đã bị gỡ do không tuân thủ Tiêu chuẩn cộng đồng/i,
    /Mọi thành viên mới của đoạn chat đều có thể xem lịch sử chat/i,
    /đã tham gia đoạn chat này/i,
    /đã rời khỏi nhóm/i,
    /đã tạo nhóm chat/i,
    /đã đặt tên đoạn chat là/i,
    /Đoạn chat đã được đặt tên là/i,
    /Bạn đã thêm .* vào đoạn chat/i,
    /đã thêm .* vào đoạn chat/i,
    /đã xoá bạn khỏi nhóm/i,
    /đã xóa bạn khỏi nhóm/i,
    /Được mã hóa đầu cuối/i,
    /Tin nhắn và cuộc gọi được bảo mật bằng tính năng mã hóa đầu cuối/i,
    /End-to-end encrypted/i,
    /Đã bày tỏ cảm xúc .* về tin nhắn/i,
    /reacted .* to your message/i,
    /^Tìm hiểu thêm$/i,
    /^Like, thumbs up$/i,
    /^Telegram sticker$/i
  ];

  function isUnsendNoticeText(str) {
    if (!str || typeof str !== 'string') return false;
    const trimmed = str.trim();
    if (trimmed.length === 0 || trimmed.length > 120) return false;
    return UNSEND_PATTERNS.some((regex) => regex.test(trimmed));
  }

  function isSystemNoticeText(str) {
    if (!str || typeof str !== 'string') return false;
    return SYSTEM_NOTICE_PATTERNS.some((regex) => regex.test(str.trim()));
  }

  function isTechnicalString(str) {
    if (!str || typeof str !== 'string') return true;
    const trimmed = str.trim();
    if (trimmed.length === 0) return true;

    if (isSystemNoticeText(trimmed)) return true;

    // Loại bỏ các chuỗi JSON cấu hình nội bộ như {"contextual_menu_actions":...} hoặc {}
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      return true;
    }

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
   * Kiểm tra xem timestamp của tin nhắn có phải là tin nhắn cũ từ lịch sử (trước khi mở trang quá 5 phút) không
   */
  function isOldHistoricalTimestamp(ts) {
    if (!ts || typeof ts !== 'number') return false;
    // Nếu tin nhắn có timestamp cũ hơn thời điểm mở trang quá 5 phút -> là tin nhắn lịch sử cũ
    return ts > 1577836800000 && ts < PAGE_LOAD_TIME - 5 * 60 * 1000;
  }

  function registerCapturedMessage(msgData) {
    let {
      messageId,
      altIds,
      text,
      senderId,
      threadId,
      senderName,
      attachments,
      timestamp,
      source
    } = msgData;
    if (!messageId) return;

    // Bỏ qua các tin nhắn cũ từ lịch sử để không làm rác Console và bộ nhớ
    if (timestamp && isOldHistoricalTimestamp(timestamp)) {
      return;
    }

    messageId = resolveCanonicalMessageId(messageId);
    if (Array.isArray(altIds)) {
      for (const alt of altIds) {
        if (alt && String(alt) !== messageId) {
          aliasIdMap.set(String(alt), messageId);
        }
      }
    }

    if (text && isUnsendNoticeText(text)) {
      // Chỉ báo gỡ nếu tin nhắn này đã từng được lưu trước đó trong phiên
      if (capturedMessages.has(messageId)) {
        triggerMessageUnsent(messageId, { senderId, threadId, unsendNotice: text, source });
      }
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
        `${LOG_PREFIX} 📩 Đã lưu tin nhắn mới [${messageId}] (${updatedRecord.source}):`,
        updatedRecord.text || `(Đính kèm: ${updatedRecord.attachments.length} media)`
      );
      emitToContentScript('FB_MSG_CAPTURED', updatedRecord);
    }
  }

  function triggerMessageUnsent(rawMessageId, extraInfo = {}) {
    const messageId = resolveCanonicalMessageId(rawMessageId);
    if (!messageId) return;

    const existing = capturedMessages.get(messageId);
    // Chỉ kích hoạt gỡ nếu tin nhắn này thực sự đã được bắt trước đó và có nội dung, tránh báo động giả cho tin nhắn cũ
    if (!existing || existing.isUnsent) return;
    if (!existing.text && (!existing.attachments || existing.attachments.length === 0)) return;

    const record = {
      ...existing,
      unsentAt: Date.now(),
      source: extraInfo.source || existing.source || 'unknown',
      isUnsent: true
    };

    capturedMessages.set(messageId, record);

    console.log(
      `${LOG_PREFIX} 🚨 PHÁT HIỆN GỠ TIN NHẮN [${messageId}]! Nội dung gốc:`,
      record.text || `[Media: ${record.attachments.join(', ')}]`
    );

    emitToContentScript('FB_MSG_UNSENT', record);
  }

  // ============================================================================
  // BỘ PHÂN TÍCH 1: Cây lệnh Lightspeed
  // ============================================================================
  function inspectLightspeedNode(
    node,
    context = { fromRealtime: false, currentFunc: '', source: 'ls' }
  ) {
    if (!node || typeof node !== 'object') return;
    if (processedNodes.has(node)) return;
    processedNodes.add(node);

    if (Array.isArray(node)) {
      let currentFunc = context.currentFunc;

      if (node.length >= 2 && node[0] === 5 && typeof node[1] === 'string') {
        currentFunc = node[1];
      } else if (
        node.length >= 2 &&
        typeof node[0] === 'string' &&
        /Message|Unsent|Snippet|Attachment|Thread/i.test(node[0])
      ) {
        currentFunc = node[0];
      }

      // Bỏ qua hoàn toàn hàm đồng bộ lịch sử cũ (insertNewMessageRange) để không tải lại tin nhắn cũ rích
      if (currentFunc === 'insertNewMessageRange') {
        return;
      }

      let directMsgIds = [];
      let directAltIds = [];
      let directTextLiterals = [];
      let directMediaUrls = [];
      let directI64Values = [];
      let hasUnsendNoticeInNode = false;

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
        } else if (
          Array.isArray(item) &&
          item.length === 2 &&
          item[0] === 19 &&
          typeof item[1] === 'string'
        ) {
          directI64Values.push(item[1]);
        }
      }

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
            // Lấy giá trị timestamp hợp lệ nhỏ nhất (thường là thời điểm tạo tin nhắn gốc)
            if (!timestamp || num < timestamp) timestamp = num;
          } else if (val.length >= 5 && val !== '0') {
            ids.push(val);
          }
        }

        // Nếu phát hiện timestamp là của tin nhắn lịch sử cũ từ xưa -> bỏ qua ngay!
        if (timestamp && isOldHistoricalTimestamp(timestamp)) {
          return;
        }

        const threadId = ids[0] || '';
        const senderId = ids[1] || ids[0] || '';

        const isExplicitUnsendFunc =
          /deleteThenInsertMessage|markMessageUnsent|handleUnsendMessage|deleteMessage|unsent|retract|recall|tombstone/i.test(
            currentFunc
          );

        const resolvedId = resolveCanonicalMessageId(primaryId);

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
        }
      }

      const nextContext = {
        fromRealtime: context.fromRealtime,
        currentFunc,
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
    context = { fromRealtime: false, currentFunc: '', source: 'obj' }
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
          obj.unsentTimestampMs !== undefined)
          ? obj.id
          : null);

      if (rawMsgId !== null && rawMsgId !== undefined) {
        const msgId = String(rawMsgId).trim();
        if (msgId.length >= 4) {
          const timestamp = Number(
            obj.timestampMs || obj.timestamp_ms || obj.timestamp || Date.now()
          );

          // Bỏ qua nếu là bản ghi tin nhắn cũ trong lịch sử
          if (isOldHistoricalTimestamp(timestamp)) {
            return;
          }

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
            val.includes('upsertMessage') ||
            val.includes('deleteThenInsertMessage') ||
            isUnsendNoticeText(val))
        ) {
          try {
            const parsed = originalJSONParse(val);
            inspectPlainObject(parsed, depth + 1, context);
          } catch (_) {}
        }
      }
    } catch (_) {}
  }

  // ============================================================================
  // BỘ PHÂN TÍCH 3: Quét React Fiber (__reactFiber$) chỉ trong vùng khung chat
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
              msgObj.messageRenderingType === 2 ||
              (typeof text === 'string' && isUnsendNoticeText(text));

            if (id) {
              return {
                messageId: String(id),
                text: typeof text === 'string' ? text : '',
                senderId: String(msgObj.senderId || msgObj.author || ''),
                threadId: String(msgObj.threadId || msgObj.threadKey || ''),
                isUnsent
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

  function scanVisibleChatFiber() {
    if (!document.body) return;
    try {
      // Chỉ quét các dòng tin nhắn thực sự có data-scope="messages_table"
      const elements = document.querySelectorAll(
        'div[data-scope="messages_table"], div[data-scope="messages_table"] div[dir="auto"]'
      );
      elements.forEach((el) => {
        const fiberMsg = extractMessageFromReactFiber(el);
        if (fiberMsg && fiberMsg.messageId) {
          const rowContainer = el.closest('div[data-scope="messages_table"]') || el;
          if (rowContainer instanceof HTMLElement) {
            rowContainer.dataset.fbMsgId = fiberMsg.messageId;
          }

          if (fiberMsg.isUnsent) {
            triggerMessageUnsent(fiberMsg.messageId, { source: 'react-fiber' });
          } else if (fiberMsg.text && !isTechnicalString(fiberMsg.text)) {
            if (rowContainer instanceof HTMLElement && !rowContainer.dataset.fbUnsendSavedText) {
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

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data) return;
    if (event.data.source === 'FB_UNSEND_EXTENSION_CONTENT' && event.data.type === 'SCAN_FIBER') {
      scanVisibleChatFiber();
    }
  });

  // ============================================================================
  // TẦNG HOOK 1: Chặn đọc WebSocket (Chỉ xử lý các gói thời gian thực)
  // ============================================================================
  const originalJSONParse = JSON.parse;
  const OriginalWebSocket = window.WebSocket;
  const textDecoder = new TextDecoder('utf-8', { fatal: false });

  function extractJsonObjectsFromString(rawStr) {
    const wsContext = {
      fromRealtime: true,
      currentFunc: '',
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
          decoded.includes('upsertMessage') ||
          decoded.includes('insertMessage') ||
          decoded.includes('deleteThenInsertMessage') ||
          decoded.includes('markMessageUnsent') ||
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
  // TẦNG HOOK 2: Chặn đọc IndexedDB & MessagePort cho E2EE
  // ============================================================================
  if (window.IDBObjectStore) {
    const origPut = IDBObjectStore.prototype.put;
    const origAdd = IDBObjectStore.prototype.add;

    IDBObjectStore.prototype.put = function (value, key) {
      try {
        if (value && typeof value === 'object') {
          queueMicrotask(() => {
            try {
              inspectPlainObject(value, 0, {
                fromRealtime: true,
                currentFunc: 'IDB.put',
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
                source: 'idb'
              });
            } catch (_) {}
          });
        }
      } catch (_) {}
      return origAdd.apply(this, arguments);
    };
  }

  function inspectWorkerChannelData(data, sourceLabel) {
    if (!data) return;
    queueMicrotask(() => {
      try {
        if (typeof data === 'object') {
          if (Array.isArray(data)) {
            inspectLightspeedNode(data, {
              fromRealtime: true,
              currentFunc: sourceLabel,
              source: sourceLabel
            });
          } else {
            inspectPlainObject(data, 0, {
              fromRealtime: true,
              currentFunc: sourceLabel,
              source: sourceLabel
            });
          }
        }
      } catch (_) {}
    });
  }

  if (window.MessagePort) {
    const origPortAddEventListener = MessagePort.prototype.addEventListener;
    const hookedPorts = new WeakSet();

    function ensurePortHooked(port) {
      if (!port || hookedPorts.has(port)) return;
      hookedPorts.add(port);
      origPortAddEventListener.call(port, 'message', (event) => {
        inspectWorkerChannelData(event.data, 'e2ee-port');
      });
    }

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
})();
