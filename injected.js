/**
 * injected.js - Chạy trong MAIN world ở thời điểm document_start trên facebook.com
 * Nhiệm vụ:
 * 1. Đón lõng (Hook) kết nối WebSocket thời gian thực của Facebook Messenger.
 * 2. Đón lõng tầng dữ liệu Lightspeed (LS) / JSON.parse và IndexedDB (nơi lưu dữ liệu E2EE sau giải mã).
 * 3. Phát hiện tin nhắn mới (kể cả khi đang ở tab khác hoặc đóng khung chat) và sự kiện thu hồi (unsend).
 * 4. Gửi dữ liệu đã bóc tách sang content.js thông qua window.postMessage.
 */

(function () {
  if (window.__FB_UNSEND_INJECTED__) return;
  window.__FB_UNSEND_INJECTED__ = true;

  const LOG_PREFIX = '[FB-Unsend-Tracker]';
  console.log(`${LOG_PREFIX} Đã kích hoạt bộ theo dõi dữ liệu ngầm (MAIN World).`);

  // Bộ nhớ tạm trong phiên để đối chiếu nhanh theo Message ID (mid.$...)
  // Map: messageId -> { messageId, text, senderId, threadId, attachments, timestamp, rawStrings }
  const capturedMessages = new Map();

  // Danh sách các mẫu câu thông báo khi tin nhắn bị thu hồi của Facebook
  const UNSEND_PATTERNS = [
    /đã thu hồi một tin nhắn/i,
    /đã gỡ một tin nhắn/i,
    /bạn đã thu hồi một tin nhắn/i,
    /unsent a message/i,
    /you unsent a message/i,
    /removed a message/i,
    /tin nhắn đã bị thu hồi/i,
    /tin nhắn đã được thu hồi/i
  ];

  // Các chuỗi kỹ thuật nội bộ của Facebook Lightspeed cần loại trừ khỏi nội dung văn bản tin nhắn
  const IGNORED_STRINGS = new Set([
    'insertNewMessageRange',
    'upsertMessage',
    'insertMessage',
    'deleteThenInsertMessage',
    'deleteMessage',
    'markMessageUnsent',
    'handleUnsendMessage',
    'updateMessage',
    'upsertReaction',
    'deleteReaction',
    'replaceOptimisticMessage',
    'setMessageText',
    'setThreadSnippet',
    'updateThreadSnippet',
    'verifyThreadExists',
    'moveThreadToInbox',
    'updateReadReceipt',
    'markThreadRead',
    'insertAttachment',
    'insertAttachmentItem',
    'insertBlobAttachment',
    'insertStickerAttachment',
    'insertXmaAttachment',
    'armadillo',
    'lightspeed',
    'messages',
    'threads',
    'participants',
    ' contacts',
    'optimistic',
    'pending',
    'sent',
    'delivered',
    'read',
    'none',
    'null',
    'undefined',
    'true',
    'false',
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'video/mp4',
    'audio/mpeg',
    'audio/mp4',
    'audio/aac'
  ]);

  function isUnsendNoticeText(str) {
    if (!str || typeof str !== 'string') return false;
    return UNSEND_PATTERNS.some((regex) => regex.test(str.trim()));
  }

  function isTechnicalString(str) {
    if (!str || typeof str !== 'string') return true;
    const trimmed = str.trim();
    if (trimmed.length === 0) return true;
    if (IGNORED_STRINGS.has(trimmed)) return true;

    // Loại bỏ ID tin nhắn, mã định danh hệ thống, MIME types, đường dẫn nội bộ
    if (
      trimmed.startsWith('mid.$') ||
      trimmed.startsWith('wmid.') ||
      trimmed.startsWith('otid.') ||
      trimmed.startsWith('m_') ||
      trimmed.startsWith('thread:') ||
      trimmed.startsWith('user:') ||
      trimmed.startsWith('fbid:') ||
      trimmed.startsWith('ls://') ||
      trimmed.startsWith('data:') ||
      trimmed.startsWith('blob:') ||
      /^[0-9a-f]{24,64}$/i.test(trimmed) ||
      /^[A-Za-z0-9+/=_-]{40,}$/.test(trimmed) || // Chuỗi hash/base64 dài không khoảng trắng
      /^[a-z]+_[a-z_]+$/i.test(trimmed) || // Tên biến/hàm dạng snake_case kỹ thuật
      /^[a-z]+[A-Z][a-zA-Z0-9]+$/.test(trimmed) && (
        trimmed.startsWith('insert') ||
        trimmed.startsWith('upsert') ||
        trimmed.startsWith('update') ||
        trimmed.startsWith('delete') ||
        trimmed.startsWith('remove') ||
        trimmed.startsWith('handle') ||
        trimmed.startsWith('mark') ||
        trimmed.startsWith('set') ||
        trimmed.startsWith('clear') ||
        trimmed.startsWith('sync') ||
        trimmed.startsWith('fetch') ||
        trimmed.startsWith('verify')
      )
    ) {
      return true;
    }

    return false;
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
    } catch (e) {
      // Bỏ qua lỗi postMessage nếu có
    }
  }

  /**
   * Lưu hoặc cập nhật tin nhắn bắt được từ tầng dữ liệu ngầm
   */
  function registerCapturedMessage(msgData) {
    const { messageId, text, senderId, threadId, attachments, timestamp } = msgData;
    if (!messageId) return;

    const existing = capturedMessages.get(messageId);

    // Nếu phát hiện nội dung là thông báo thu hồi -> kích hoạt sự kiện gỡ tin nhắn
    if (text && isUnsendNoticeText(text)) {
      triggerMessageUnsent(messageId, {
        senderId: senderId || existing?.senderId,
        threadId: threadId || existing?.threadId,
        unsendNotice: text
      });
      return;
    }

    // Nếu chưa có nội dung text và chưa có đính kèm có nghĩa thì không ghi đè dữ liệu cũ
    const hasMeaningfulContent =
      (text && text.trim().length > 0 && !isUnsendNoticeText(text)) ||
      (attachments && attachments.length > 0);

    if (!hasMeaningfulContent) {
      return;
    }

    const updatedRecord = {
      messageId,
      text: text || existing?.text || '',
      senderId: senderId || existing?.senderId || '',
      threadId: threadId || existing?.threadId || '',
      attachments:
        attachments && attachments.length > 0
          ? attachments
          : existing?.attachments || [],
      timestamp: timestamp || existing?.timestamp || Date.now(),
      isUnsent: existing?.isUnsent || false
    };

    const isNewOrUpdated =
      !existing ||
      (updatedRecord.text && updatedRecord.text !== existing.text) ||
      updatedRecord.attachments.length > (existing.attachments?.length || 0);

    capturedMessages.set(messageId, updatedRecord);

    if (isNewOrUpdated) {
      console.log(
        `${LOG_PREFIX} Đã bắt ngầm tin nhắn [${messageId}]:`,
        updatedRecord.text || `(Đính kèm: ${updatedRecord.attachments.length})`
      );
      emitToContentScript('FB_MSG_CAPTURED', updatedRecord);
    }
  }

  /**
   * Đánh dấu một tin nhắn đã bị gỡ và báo ngay cho content.js
   */
  function triggerMessageUnsent(messageId, extraInfo = {}) {
    const existing = capturedMessages.get(messageId);
    const record = {
      messageId,
      text: existing?.text || extraInfo.fallbackText || '',
      senderId: existing?.senderId || extraInfo.senderId || '',
      threadId: existing?.threadId || extraInfo.threadId || '',
      attachments: existing?.attachments || extraInfo.attachments || [],
      timestamp: existing?.timestamp || Date.now(),
      unsentAt: Date.now(),
      isUnsent: true
    };

    if (existing) {
      existing.isUnsent = true;
      existing.unsentAt = record.unsentAt;
    } else {
      capturedMessages.set(messageId, record);
    }

    console.log(
      `${LOG_PREFIX} 🚨 PHÁT HIỆN GỠ TIN NHẮN [${messageId}]! Nội dung gốc:`,
      record.text || '(Chưa có text hoặc là media)'
    );

    emitToContentScript('FB_MSG_UNSENT', record);
  }

  /**
   * Bóc tách dữ liệu từ cây lệnh Lightspeed (LS steps) của Facebook
   * Trong Lightspeed:
   * - Số nguyên 64-bit (như userId, threadId, timestampMs) có dạng: [19, "1000..."]
   * - Giá trị null/undefined có dạng: [9]
   * - ID tin nhắn có dạng chuỗi: "mid.$..." hoặc "wmid...."
   */
  function inspectLightspeedNode(node, parentContext = { funcNames: [] }) {
    if (!node || typeof node !== 'object') return;

    if (Array.isArray(node)) {
      // Kiểm tra xem mảng hiện tại có phải là một lệnh (statement) chứa Message ID không
      let foundMessageIds = [];
      let stringLiterals = [];
      let mediaUrls = [];
      let i64Values = [];
      let funcNames = [...parentContext.funcNames];

      // Quét nhanh các phần tử trực tiếp trong mảng này
      for (let i = 0; i < node.length; i++) {
        const item = node[i];
        if (typeof item === 'string') {
          if (item.startsWith('mid.$') || item.startsWith('wmid.')) {
            foundMessageIds.push(item);
          } else if (/^https?:\/\//i.test(item)) {
            mediaUrls.push(item);
          } else if (
            item.includes('Unsent') ||
            item.includes('unsent') ||
            item.includes('deleteThenInsertMessage') ||
            item.includes('deleteMessage') ||
            item.includes('insertMessage') ||
            item.includes('upsertMessage') ||
            item.includes('insertNewMessageRange')
          ) {
            funcNames.push(item);
          } else if (!isTechnicalString(item)) {
            stringLiterals.push(item);
          }
        } else if (
          Array.isArray(item) &&
          item.length === 2 &&
          item[0] === 19 &&
          typeof item[1] === 'string'
        ) {
          // Kiểu Int64 của Lightspeed: [19, "1000123456789"]
          i64Values.push(item[1]);
        }
      }

      // Nếu trong mảng lệnh này có chứa Message ID (mid.$...)
      if (foundMessageIds.length > 0) {
        const msgId = foundMessageIds[0];
        const joinedFuncNames = funcNames.join(' ');
        const isDeleteOrUnsendFunc =
          /deleteThenInsertMessage|markMessageUnsent|handleUnsendMessage|deleteMessage/i.test(
            joinedFuncNames
          );

        // Phân loại các số Int64 thành timestamp và ID người dùng/cuộc trò chuyện
        let timestamp = null;
        let ids = [];
        for (const val of i64Values) {
          const num = Number(val);
          // Timestamp tính bằng ms (khoảng từ năm 2020 đến 2035)
          if (num > 1577836800000 && num < 2051222400000) {
            if (!timestamp) timestamp = num;
          } else if (val.length >= 5 && val !== '0') {
            ids.push(val);
          }
        }

        const threadId = ids[0] || '';
        const senderId = ids[1] || ids[0] || '';

        // Kiểm tra xem có chuỗi thông báo thu hồi không
        const unsendText = stringLiterals.find((s) => isUnsendNoticeText(s));
        if (unsendText) {
          triggerMessageUnsent(msgId, { threadId, senderId, unsendNotice: unsendText });
        } else if (stringLiterals.length > 0 || mediaUrls.length > 0) {
          // Chọn chuỗi văn bản tin nhắn hợp lý nhất
          const candidateText = stringLiterals[0] || '';
          registerCapturedMessage({
            messageId: msgId,
            text: candidateText,
            senderId,
            threadId,
            attachments: mediaUrls,
            timestamp: timestamp || Date.now()
          });
        } else if (isDeleteOrUnsendFunc && capturedMessages.has(msgId)) {
          // Nếu gọi hàm xóa/thu hồi trên một msgId đã từng có nội dung mà giờ không còn text mới
          triggerMessageUnsent(msgId, { threadId, senderId });
        }
      }

      // Tiếp tục duyệt đệ quy xuống các mảng con
      const nextContext = { funcNames };
      for (let i = 0; i < node.length; i++) {
        if (node[i] && typeof node[i] === 'object') {
          // Bỏ qua node Int64 [19, "..."] để tiết kiệm CPU
          if (Array.isArray(node[i]) && node[i].length === 2 && node[i][0] === 19) {
            continue;
          }
          inspectLightspeedNode(node[i], nextContext);
        }
      }
      return;
    }

    // Nếu là Object (ví dụ từ IndexedDB, E2EE Worker hoặc GraphQL/JSON)
    inspectPlainObject(node);
  }

  /**
   * Kiểm tra một Object bất kỳ (từ IndexedDB sau khi giải mã E2EE hoặc JSON payload)
   */
  function inspectPlainObject(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 6) return;

    try {
      // Nếu object có chứa trường step của Lightspeed
      if (Array.isArray(obj.step)) {
        inspectLightspeedNode(obj.step);
      }

      // Kiểm tra nếu object là một bản ghi tin nhắn (thường lưu trong IndexedDB của Messenger E2EE / MAW)
      const msgId =
        obj.messageId ||
        obj.message_id ||
        obj.msgId ||
        obj.id ||
        obj.offlineThreadingId ||
        (typeof obj.primaryKey === 'string' && obj.primaryKey.startsWith('mid.$')
          ? obj.primaryKey
          : null);

      if (typeof msgId === 'string' && (msgId.startsWith('mid.$') || msgId.startsWith('wmid.') || obj.threadKey || obj.threadId || obj.senderId)) {
        const textContent =
          obj.text ??
          obj.body ??
          obj.snippet ??
          obj.plaintext ??
          obj.messageText ??
          (typeof obj.message === 'string' ? obj.message : obj.message?.text);

        const senderId = String(
          obj.senderId || obj.sender_id || obj.author || obj.actorId || ''
        );
        const threadId = String(
          obj.threadId || obj.thread_id || obj.threadKey || obj.threadFbId || ''
        );
        const timestamp = Number(
          obj.timestampMs || obj.timestamp_ms || obj.timestamp || Date.now()
        );

        // Kiểm tra cờ thu hồi tin nhắn trong bản ghi IndexedDB / E2EE
        const isUnsentFlag =
          obj.isUnsent === true ||
          obj.is_unsent === true ||
          obj.unsent === true ||
          (typeof obj.unsentTimestampMs === 'number' && obj.unsentTimestampMs > 0) ||
          obj.messageRenderingType === 2 || // Mã thường dùng cho tin nhắn đã thu hồi
          (typeof textContent === 'string' && isUnsendNoticeText(textContent));

        if (isUnsentFlag) {
          triggerMessageUnsent(msgId, { senderId, threadId });
        } else if (typeof textContent === 'string' && textContent.trim().length > 0 && !isTechnicalString(textContent)) {
          const attachments = [];
          if (obj.attachments && Array.isArray(obj.attachments)) {
            for (const att of obj.attachments) {
              const url = att?.url || att?.previewUrl || att?.playableUrl || att?.imageUrl;
              if (url) attachments.push(url);
            }
          }
          registerCapturedMessage({
            messageId: msgId,
            text: textContent,
            senderId,
            threadId,
            attachments,
            timestamp
          });
        } else if (
          capturedMessages.has(msgId) &&
          (textContent === '' || textContent === null) &&
          (obj.hasOwnProperty('text') || obj.hasOwnProperty('body'))
        ) {
          // Bản ghi tin nhắn cũ bị cập nhật thành chuỗi rỗng/null -> đã bị gỡ
          triggerMessageUnsent(msgId, { senderId, threadId });
        }
      }

      // Duyệt các thuộc tính con nếu là object lồng nhau
      for (const key of Object.keys(obj)) {
        const val = obj[key];
        if (val && typeof val === 'object') {
          if (Array.isArray(val)) {
            inspectLightspeedNode(val);
          } else {
            inspectPlainObject(val, depth + 1);
          }
        } else if (
          typeof val === 'string' &&
          (val.includes('"step"') || val.includes('mid.$') || val.includes('upsertMessage') || val.includes('deleteThenInsertMessage')) &&
          val.startsWith('{')
        ) {
          try {
            const parsed = originalJSONParse(val);
            inspectPlainObject(parsed, depth + 1);
          } catch (_) {}
        }
      }
    } catch (_) {}
  }

  // ============================================================================
  // TẦNG HOOK 1: Chặn đọc JSON.parse (Bắt mọi gói Lightspeed & E2EE payload)
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
          text.includes('deleteThenInsertMessage') ||
          text.includes('markMessageUnsent') ||
          text.includes('isUnsent') ||
          text.includes('unsentTimestampMs'))
      ) {
        queueMicrotask(() => {
          try {
            inspectLightspeedNode(result);
          } catch (_) {}
        });
      }
    } catch (_) {}
    return result;
  };

  // ============================================================================
  // TẦNG HOOK 2: Chặn đọc WebSocket (wss://edge-chat.facebook.com & E2EE WS)
  // ============================================================================
  const OriginalWebSocket = window.WebSocket;
  const textDecoder = new TextDecoder('utf-8', { fatal: false });

  function extractJsonObjectsFromString(rawStr) {
    // Tìm các khối JSON trong gói binary MQTT/WebSocket
    const startIdx = rawStr.indexOf('{');
    const lastIdx = rawStr.lastIndexOf('}');
    if (startIdx === -1 || lastIdx === -1 || lastIdx <= startIdx) return;

    const candidate = rawStr.slice(startIdx, lastIdx + 1);
    try {
      const parsed = originalJSONParse(candidate);
      inspectPlainObject(parsed);
    } catch (_) {
      // Nếu có nhiều JSON nối tiếp nhau trong frame binary, dùng regex quét các payload con
      const payloadMatches = rawStr.match(/\{"request_id".*?\}|\{"step":\[.*?\]\}/g);
      if (payloadMatches) {
        for (const m of payloadMatches) {
          try {
            inspectPlainObject(originalJSONParse(m));
          } catch (_) {}
        }
      }
    }
  }

  function handleWebSocketFrame(data) {
    try {
      if (typeof data === 'string') {
        if (
          data.includes('mid.$') ||
          data.includes('step') ||
          data.includes('Message')
        ) {
          extractJsonObjectsFromString(data);
        }
      } else if (data instanceof ArrayBuffer) {
        const decoded = textDecoder.decode(new Uint8Array(data));
        if (
          decoded.includes('mid.$') ||
          decoded.includes('step') ||
          decoded.includes('Message')
        ) {
          extractJsonObjectsFromString(decoded);
        }
      } else if (ArrayBuffer.isView(data)) {
        const decoded = textDecoder.decode(data);
        if (
          decoded.includes('mid.$') ||
          decoded.includes('step') ||
          decoded.includes('Message')
        ) {
          extractJsonObjectsFromString(decoded);
        }
      } else if (data instanceof Blob) {
        data
          .arrayBuffer()
          .then((buf) => handleWebSocketFrame(buf))
          .catch(() => {});
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
  // TẦNG HOOK 3: Chặn đọc IndexedDB (Bắt dữ liệu E2EE ngay sau khi giải mã)
  // ============================================================================
  if (window.IDBObjectStore) {
    const origPut = IDBObjectStore.prototype.put;
    const origAdd = IDBObjectStore.prototype.add;

    IDBObjectStore.prototype.put = function (value, key) {
      try {
        if (value && typeof value === 'object') {
          queueMicrotask(() => {
            try {
              inspectPlainObject(value);
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
              inspectPlainObject(value);
            } catch (_) {}
          });
        }
      } catch (_) {}
      return origAdd.apply(this, arguments);
    };
  }
})();
