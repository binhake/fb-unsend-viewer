/**
 * injected.js - Chạy trong MAIN world ở thời điểm document_start trên facebook.com
 * Nhiệm vụ:
 * 1. Đón lõng (Hook) kết nối WebSocket thời gian thực của Facebook Messenger.
 * 2. Đón lõng tầng dữ liệu Lightspeed (LS) / JSON.parse, Web Worker và IndexedDB (nơi lưu dữ liệu E2EE sau giải mã).
 * 3. Phát hiện tin nhắn mới (kể cả khi đang ở tab khác hoặc đóng khung chat) và sự kiện thu hồi (unsend).
 * 4. Gửi dữ liệu đã bóc tách sang content.js thông qua window.postMessage.
 */

(function () {
  if (window.__FB_UNSEND_INJECTED__) return;
  window.__FB_UNSEND_INJECTED__ = true;

  const LOG_PREFIX = '[FB-Unsend-Tracker]';
  console.log(`${LOG_PREFIX} Đã kích hoạt bộ theo dõi dữ liệu ngầm v1.1 (MAIN World).`);

  // Bộ nhớ lưu các tin nhắn đã bắt được theo Message ID (mid.$... hoặc wmid...)
  // Map: messageId -> { messageId, text, senderId, threadId, attachments, timestamp, capturedAt, isUnsent }
  const capturedMessages = new Map();

  // WeakSet để đánh dấu các mảng/object đã quét qua, tránh quét lặp lại gây spam log
  const processedNodes = new WeakSet();

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

  // Các thông báo hệ thống của Facebook không phải là nội dung tin nhắn người dùng
  const SYSTEM_NOTICE_PATTERNS = [
    /Tin nhắn này đã bị gỡ do không tuân thủ Tiêu chuẩn cộng đồng/i,
    /Mọi thành viên mới của đoạn chat đều có thể xem lịch sử chat/i,
    /đã tham gia đoạn chat này/i,
    /đã rời khỏi nhóm/i,
    /đã tạo nhóm chat/i,
    /đã đặt tên đoạn chat là/i,
    /Bạn đã thêm .* vào đoạn chat/i
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

    // 1. Loại bỏ các thông báo hệ thống cố định
    if (isSystemNoticeText(trimmed)) return true;

    // 2. Loại bỏ các tiền tố ID kỹ thuật, đường dẫn nội bộ, tên file media tự sinh
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
      trimmed.startsWith('/messaging/lightspeed/') ||
      /^(image|video|audio|file|sticker|gif|attachment)-[0-9a-f_-]+(\.[a-z0-9]+)?$/i.test(trimmed)
    ) {
      return true;
    }

    // 3. Loại bỏ các chuỗi chỉ toàn chữ số dài (ID 64-bit của Facebook như 7517916657198095682)
    if (/^\d{12,25}$/.test(trimmed)) {
      return true;
    }

    // 4. Loại bỏ chuỗi Cookie hoặc User-Agent kỹ thuật (nếu không phải tin nhắn người dùng cố tình gửi)
    if (
      (trimmed.includes('datr=') && trimmed.includes('c_user=')) ||
      trimmed.startsWith('Mozilla/5.0 (')
    ) {
      return true;
    }

    // 5. Loại bỏ các tên hàm Stored Procedure của Lightspeed (dạng camelCase kỹ thuật không có khoảng trắng)
    if (!trimmed.includes(' ')) {
      if (
        /^[0-9a-f]{24,64}$/i.test(trimmed) ||
        /^[A-Za-z0-9+/=_-]{40,}$/.test(trimmed) ||
        /^[a-z0-9]+(_[a-z0-9]+)+$/i.test(trimmed) || // snake_case kỹ thuật
        /^(insert|upsert|update|delete|remove|handle|mark|set|clear|sync|fetch|verify|apply|replace|move|create|ensure|compute|process|execute|send|receive|check|truncate|populate|optimistic|lightspeed|armadillo)[A-Z][a-zA-Z0-9_]*$/.test(
          trimmed
        ) ||
        /^(image|video|audio|application|text)\/[a-z0-9.+-]+$/i.test(trimmed) ||
        /^(true|false|null|undefined|none|pending|sent|delivered|read|optimistic)$/i.test(trimmed)
      ) {
        return true;
      }
    }

    return false;
  }

  /**
   * Kiểm tra xem chuỗi có phải là đường dẫn Media/Sticker của Facebook không
   */
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

  /**
   * Lưu hoặc cập nhật tin nhắn bắt được từ tầng dữ liệu ngầm
   */
  function registerCapturedMessage(msgData) {
    const { messageId, text, senderId, threadId, attachments, timestamp } = msgData;
    if (!messageId) return;

    const cleanText = text && !isTechnicalString(text) && !isUnsendNoticeText(text) ? text.trim() : '';
    const cleanAttachments = Array.isArray(attachments) ? attachments.filter(Boolean) : [];

    // Nếu phát hiện nội dung là thông báo thu hồi -> kích hoạt sự kiện gỡ tin nhắn
    if (text && isUnsendNoticeText(text)) {
      triggerMessageUnsent(messageId, {
        senderId,
        threadId,
        unsendNotice: text
      });
      return;
    }

    const existing = capturedMessages.get(messageId);

    // Nếu không có nội dung chữ hợp lệ và không có đính kèm mới thì bỏ qua
    if (!cleanText && cleanAttachments.length === 0) {
      return;
    }

    // Bảo vệ nội dung gốc: Nếu đã có existing.text hợp lệ, KHÔNG ghi đè bằng chuỗi rỗng
    const finalText = existing?.text ? existing.text : cleanText;

    // Gộp danh sách đính kèm không trùng lặp
    const mergedAttachments = [...(existing?.attachments || [])];
    for (const url of cleanAttachments) {
      if (!mergedAttachments.includes(url)) {
        mergedAttachments.push(url);
      }
    }

    // Kiểm tra xem có thông tin gì thực sự mới không (để tránh in log lặp lại)
    const isActuallyNew =
      !existing ||
      (!existing.text && finalText) ||
      mergedAttachments.length > (existing.attachments?.length || 0);

    const updatedRecord = {
      messageId,
      text: finalText,
      senderId: senderId || existing?.senderId || '',
      threadId: threadId || existing?.threadId || '',
      attachments: mergedAttachments,
      timestamp: timestamp || existing?.timestamp || Date.now(),
      capturedAt: existing?.capturedAt || Date.now(),
      isUnsent: existing?.isUnsent || false
    };

    capturedMessages.set(messageId, updatedRecord);

    if (isActuallyNew) {
      console.log(
        `${LOG_PREFIX} 📩 Đã lưu tin nhắn [${messageId}]:`,
        updatedRecord.text || `(Đính kèm: ${updatedRecord.attachments.length} media)`
      );
      emitToContentScript('FB_MSG_CAPTURED', updatedRecord);
    }
  }

  /**
   * Đánh dấu một tin nhắn đã bị gỡ và báo ngay cho content.js
   */
  function triggerMessageUnsent(messageId, extraInfo = {}) {
    const existing = capturedMessages.get(messageId);
    // Nếu đã báo gỡ cho tin nhắn này rồi thì không báo lặp lại
    if (existing?.isUnsent) return;

    const record = {
      messageId,
      text: existing?.text || extraInfo.fallbackText || '',
      senderId: existing?.senderId || extraInfo.senderId || '',
      threadId: existing?.threadId || extraInfo.threadId || '',
      attachments: existing?.attachments || extraInfo.attachments || [],
      timestamp: existing?.timestamp || Date.now(),
      capturedAt: existing?.capturedAt || Date.now(),
      unsentAt: Date.now(),
      isUnsent: true
    };

    capturedMessages.set(messageId, record);

    console.log(
      `${LOG_PREFIX} 🚨 PHÁT HIỆN GỠ TIN NHẮN [${messageId}]! Nội dung gốc:`,
      record.text ||
        (record.attachments.length > 0
          ? `[Media: ${record.attachments.join(', ')}]`
          : '(Chưa lưu được nội dung trước khi gỡ)')
    );

    emitToContentScript('FB_MSG_UNSENT', record);
  }

  /**
   * Quét một lệnh gọi hàm của Lightspeed: [5, "tên_hàm", ...args]
   * hoặc một mảng dữ liệu chứa Message ID ("mid.$..." / "wmid....")
   */
  function inspectLightspeedNode(node, context = { fromWebSocket: false, currentFunc: '', packetHasUnsendText: false }) {
    if (!node || typeof node !== 'object') return;
    if (processedNodes.has(node)) return;
    processedNodes.add(node);

    if (Array.isArray(node)) {
      let currentFunc = context.currentFunc;

      // Trong Lightspeed, mảng bắt đầu bằng số 5 và phần tử thứ 2 là tên hàm Stored Procedure:
      // Ví dụ: [5, "insertNewMessageRange", ...] hoặc [5, "deleteThenInsertMessage", ...]
      if (node.length >= 2 && node[0] === 5 && typeof node[1] === 'string') {
        currentFunc = node[1];
      }

      // Kiểm tra các phần tử trực tiếp (shallow) của mảng hiện tại xem có chứa trực tiếp mid.$ không
      let directMsgIds = [];
      let directTextLiterals = [];
      let directMediaUrls = [];
      let directI64Values = [];
      let nullMarkerCount = 0; // Số lượng phần tử [9] (null/undefined trong Lightspeed)
      let hasUnsendNoticeInNode = false;

      for (let i = 0; i < node.length; i++) {
        const item = node[i];
        if (typeof item === 'string') {
          if (item.startsWith('mid.$') || item.startsWith('wmid.')) {
            directMsgIds.push(item);
          } else if (isUnsendNoticeText(item)) {
            hasUnsendNoticeInNode = true;
          } else {
            const mediaUrl = extractMediaUrl(item);
            if (mediaUrl) {
              directMediaUrls.push(mediaUrl);
            } else if (i !== 1 || node[0] !== 5) {
              // Không lấy tên hàm ở vị trí node[1] làm nội dung tin nhắn
              if (!isTechnicalString(item)) {
                directTextLiterals.push(item);
              }
            }
          }
        } else if (Array.isArray(item)) {
          if (item.length === 1 && item[0] === 9) {
            // [9] là ký hiệu null/undefined trong Lightspeed
            nullMarkerCount++;
          } else if (item.length === 2 && item[0] === 19 && typeof item[1] === 'string') {
            // [19, "1000..."] là kiểu Int64 trong Lightspeed
            directI64Values.push(item[1]);
          }
        }
      }

      // Nếu mảng lệnh này trực tiếp chứa Message ID
      if (directMsgIds.length > 0) {
        const msgId = directMsgIds[0];

        // Phân loại Int64 thành timestamp và threadId/senderId
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

        // Kiểm tra xem lệnh này có phải là lệnh XÓA / THU HỒI tin nhắn hay không
        const isExplicitUnsendFunc =
          /deleteThenInsertMessage|markMessageUnsent|handleUnsendMessage|deleteMessage|unsent|retract|recall|tombstone/i.test(
            currentFunc
          );

        const isReactionOrReadFunc =
          /Reaction|ReadReceipt|MarkRead|Typing|Presence|Delivery|Optimistic/i.test(
            currentFunc
          );

        const existingMsg = capturedMessages.get(msgId);

        if (hasUnsendNoticeInNode || isExplicitUnsendFunc) {
          triggerMessageUnsent(msgId, { threadId, senderId });
        } else if (directTextLiterals.length > 0 || directMediaUrls.length > 0) {
          registerCapturedMessage({
            messageId: msgId,
            text: directTextLiterals[0] || '',
            senderId,
            threadId,
            attachments: directMediaUrls,
            timestamp: timestamp || Date.now()
          });
        } else if (
          existingMsg &&
          !existingMsg.isUnsent &&
          !isReactionOrReadFunc &&
          (context.packetHasUnsendText ||
            (context.fromWebSocket &&
              Date.now() - existingMsg.capturedAt > 500 &&
              (nullMarkerCount >= 2 || /delete|remove|clear|update|upsert|insert|admin/i.test(currentFunc))))
        ) {
          // Khi tin nhắn đã lưu xuất hiện lại trong gói WebSocket thời gian thực
          // nhưng nội dung text đã bị xóa thành [9] (null) hoặc đi kèm thông báo thu hồi trong gói tin
          console.log(
            `${LOG_PREFIX} 🔄 Phát hiện lệnh cập nhật làm trống tin nhắn [${msgId}] qua hàm "${currentFunc}" (nullCount=${nullMarkerCount})`
          );
          triggerMessageUnsent(msgId, { threadId, senderId });
        }
      }

      // Duyệt đệ quy xuống các phần tử con
      const nextContext = {
        fromWebSocket: context.fromWebSocket,
        currentFunc,
        packetHasUnsendText: context.packetHasUnsendText || hasUnsendNoticeInNode
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

  /**
   * Kiểm tra một Object bất kỳ (từ IndexedDB, Worker E2EE hoặc JSON payload)
   */
  function inspectPlainObject(obj, depth = 0, context = { fromWebSocket: false, currentFunc: '', packetHasUnsendText: false }) {
    if (!obj || typeof obj !== 'object' || depth > 7) return;
    if (depth === 0 && processedNodes.has(obj)) return;
    if (depth === 0) processedNodes.add(obj);

    try {
      if (Array.isArray(obj.step)) {
        inspectLightspeedNode(obj.step, context);
      }

      // Kiểm tra bản ghi tin nhắn (IndexedDB / E2EE Worker)
      const msgId =
        obj.messageId ||
        obj.message_id ||
        obj.msgId ||
        (typeof obj.id === 'string' && (obj.id.startsWith('mid.$') || obj.id.startsWith('wmid.'))
          ? obj.id
          : null) ||
        (typeof obj.primaryKey === 'string' && obj.primaryKey.startsWith('mid.$')
          ? obj.primaryKey
          : null);

      if (typeof msgId === 'string' && msgId.length > 4) {
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

        const isUnsentFlag =
          obj.isUnsent === true ||
          obj.is_unsent === true ||
          obj.unsent === true ||
          (typeof obj.unsentTimestampMs === 'number' && obj.unsentTimestampMs > 0) ||
          obj.messageRenderingType === 2 ||
          (typeof textContent === 'string' && isUnsendNoticeText(textContent));

        if (isUnsentFlag) {
          triggerMessageUnsent(msgId, { senderId, threadId });
        } else if (
          typeof textContent === 'string' &&
          textContent.trim().length > 0 &&
          !isTechnicalString(textContent)
        ) {
          const attachments = [];
          if (Array.isArray(obj.attachments)) {
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
          (Object.prototype.hasOwnProperty.call(obj, 'text') ||
            Object.prototype.hasOwnProperty.call(obj, 'body'))
        ) {
          triggerMessageUnsent(msgId, { senderId, threadId });
        }
      }

      for (const key of Object.keys(obj)) {
        const val = obj[key];
        if (val && typeof val === 'object') {
          if (Array.isArray(val)) {
            inspectLightspeedNode(val, context);
          } else {
            inspectPlainObject(val, depth + 1, context);
          }
        } else if (
          typeof val === 'string' &&
          val.startsWith('{') &&
          (val.includes('"step"') ||
            val.includes('mid.$') ||
            val.includes('wmid.') ||
            val.includes('Unsent') ||
            val.includes('deleteThenInsertMessage'))
        ) {
          try {
            const hasUnsendInStr = isUnsendNoticeText(val) || /deleteThenInsertMessage|Unsent/i.test(val);
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
          text.includes('deleteMessage') ||
          text.includes('markMessageUnsent') ||
          text.includes('isUnsent') ||
          text.includes('unsentTimestampMs') ||
          isUnsendNoticeText(text))
      ) {
        const packetHasUnsendText =
          isUnsendNoticeText(text) ||
          /deleteThenInsertMessage|markMessageUnsent|handleUnsendMessage/i.test(text);

        queueMicrotask(() => {
          try {
            inspectLightspeedNode(result, {
              fromWebSocket: false,
              currentFunc: '',
              packetHasUnsendText
            });
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
    const packetHasUnsendText =
      isUnsendNoticeText(rawStr) ||
      /deleteThenInsertMessage|markMessageUnsent|handleUnsendMessage|deleteMessage/i.test(rawStr);

    const wsContext = {
      fromWebSocket: true,
      currentFunc: '',
      packetHasUnsendText
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
              inspectPlainObject(value, 0, {
                fromWebSocket: true,
                currentFunc: 'IDB.put',
                packetHasUnsendText: false
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
                fromWebSocket: true,
                currentFunc: 'IDB.add',
                packetHasUnsendText: false
              });
            } catch (_) {}
          });
        }
      } catch (_) {}
      return origAdd.apply(this, arguments);
    };
  }

  // ============================================================================
  // TẦNG HOOK 4: Chặn đọc Web Worker (Nơi giải mã tin nhắn E2EE Armadillo/MAW)
  // ============================================================================
  if (window.Worker) {
    const OrigWorker = window.Worker;
    window.Worker = function (scriptURL, options) {
      const worker = new OrigWorker(scriptURL, options);
      worker.addEventListener('message', (event) => {
        if (event.data && typeof event.data === 'object') {
          queueMicrotask(() => {
            try {
              inspectPlainObject(event.data, 0, {
                fromWebSocket: true,
                currentFunc: 'Worker.message',
                packetHasUnsendText: false
              });
            } catch (_) {}
          });
        }
      });
      return worker;
    };
    window.Worker.prototype = OrigWorker.prototype;
    Object.assign(window.Worker, OrigWorker);
  }
})();
