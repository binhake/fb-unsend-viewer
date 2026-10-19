/**
 * injected.js - Chạy trong MAIN world ở thời điểm document_start trên facebook.com
 * Phiên bản v3.2:
 * - Gỡ bỏ hook SharedWorker / MessagePort và MAWBridge* để sửa triệt để lỗi "Không thể tải đoạn chat" trên E2EE.
 * - Giải mã chính xác mảng số nguyên 64-bit [high32, low32] của Lightspeed (LSUpsertMessage, LSDeleteThenInsertMessage)
 *   giúp chặn sạch 100% tin nhắn cũ từ lịch sử và thông báo quản trị nhóm (isAdminMessage).
 * - Gắn hook an toàn vào các module E2EE thực tế: MAWUnvaultTransform, MAWThreadSnippetForTextMsg,
 *   MAWThreadSnippetForRevokedMsg, MAWThreadSnippetFor*Msg, MAWBridgeBuildThreadSnippet.
 */

(function () {
  if (window.__FB_UNSEND_INJECTED__) return;
  window.__FB_UNSEND_INJECTED__ = true;

  const LOG_PREFIX = '[FB-Unsend-Tracker]';
  const DIAG_PREFIX = '🔍 [E2EE-DIAG]';
  const PAGE_LOAD_TIME = Date.now();
  const DIAG_KEYWORD = 'testngam';

  console.log(
    `%c${LOG_PREFIX} Đã kích hoạt bộ theo dõi dữ liệu ngầm v3.2 (An toàn cho E2EE + Lọc chuẩn Int64 Lightspeed).`,
    'background: #1877f2; color: #fff; font-weight: bold; padding: 3px 8px; border-radius: 4px;'
  );

  let isDiagActive = false;
  setTimeout(() => {
    isDiagActive = true;
  }, 6000);

  const capturedMessages = new Map();
  const aliasIdMap = new Map();
  const processedNodes = new WeakSet();
  const vaultMap = new Map();
  let mawUnvaultFn = null;

  const origTextDecoderDecode = TextDecoder.prototype.decode;
  const utf8Decoder = new TextDecoder('utf-8', { fatal: false });

  function safeDecodeBuffer(buf) {
    try {
      if (buf instanceof ArrayBuffer) {
        return origTextDecoderDecode.call(utf8Decoder, new Uint8Array(buf));
      }
      if (ArrayBuffer.isView(buf)) {
        return origTextDecoderDecode.call(utf8Decoder, buf);
      }
    } catch (_) {}
    return '';
  }

  /**
   * Chuyển đổi mảng 64-bit [high32, low32] hoặc [19, "str"] của Facebook Lightspeed sang chuỗi số nguyên
   */
  function parseLSInt64(val) {
    if (!Array.isArray(val) || val.length !== 2) return null;
    if (val[0] === 19 && typeof val[1] === 'string') {
      return val[1];
    }
    if (typeof val[0] === 'number' && typeof val[1] === 'number') {
      try {
        const big = (BigInt(val[0]) << 32n) | BigInt(val[1] >>> 0);
        return big.toString();
      } catch (_) {
        return String(val[0] * 4294967296 + (val[1] >>> 0));
      }
    }
    return null;
  }

  function containsKeywordDeep(val, keyword = DIAG_KEYWORD, depth = 0, visited = new WeakSet()) {
    if (!val || depth > 5) return false;
    if (typeof val === 'string') {
      return val.toLowerCase().includes(keyword);
    }
    if (typeof val === 'object') {
      if (visited.has(val)) return false;
      visited.add(val);

      if (val instanceof ArrayBuffer || ArrayBuffer.isView(val)) {
        const str = safeDecodeBuffer(val);
        return str.toLowerCase().includes(keyword);
      }

      if (Array.isArray(val)) {
        for (let i = 0; i < val.length; i++) {
          if (containsKeywordDeep(val[i], keyword, depth + 1, visited)) return true;
        }
        return false;
      }

      if (val instanceof Node || val === window) return false;

      const keys = Object.keys(val);
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (k.startsWith('__react')) continue;
        try {
          if (containsKeywordDeep(val[k], keyword, depth + 1, visited)) return true;
        } catch (_) {}
      }
    }
    return false;
  }

  function logDiagnosticHit(channel, detail, dataObj) {
    const stack = new Error().stack
      ?.split('\n')
      .slice(2, 8)
      .map((s) => s.trim())
      .join(' <- ');
    console.log(
      `%c${DIAG_PREFIX} 🎯 BẮT TRÚNG TỪ KHÓA "${DIAG_KEYWORD}" TẠI [${channel}] (${detail})`,
      'background: #ff4d4f; color: #fff; font-weight: bold; padding: 3px 6px; border-radius: 3px;',
      '\n📦 Dữ liệu:',
      dataObj,
      '\n🧭 Call Stack:',
      stack
    );
  }

  // ============================================================================
  // 1. Hook TextDecoder.prototype.decode (Theo dõi giải mã chuỗi từ Wasm/Binary)
  // ============================================================================
  TextDecoder.prototype.decode = function (input, options) {
    const result = origTextDecoderDecode.apply(this, arguments);
    try {
      if (typeof result === 'string' && result.length > 0) {
        if (result.toLowerCase().includes(DIAG_KEYWORD)) {
          logDiagnosticHit('TextDecoder.decode', `length=${result.length}`, result);
        }
      }
    } catch (_) {}
    return result;
  };

  // ============================================================================
  // 2. CÁC HÀM LỌC VÀ XỬ LÝ TIN NHẮN CỐT LÕI
  // ============================================================================
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

  function recordVaultMapping(vaultedToken, plainText, sourceLabel = 'MAWUnvault') {
    if (
      typeof vaultedToken === 'string' &&
      typeof plainText === 'string' &&
      vaultedToken !== plainText &&
      plainText.length > 0
    ) {
      vaultMap.set(vaultedToken, plainText);
      if (isDiagActive && !isTechnicalString(plainText)) {
        console.log(`${DIAG_PREFIX} 🔓 [${sourceLabel}] Giải mã Vault: "${vaultedToken}" -> "${plainText}"`);
      }
    }
  }

  function unvaultString(str) {
    if (!str || typeof str !== 'string') return str;
    if (vaultMap.has(str)) {
      return vaultMap.get(str);
    }
    if (mawUnvaultFn && (str.startsWith('@@vault') || str.startsWith('vault:'))) {
      try {
        const res = mawUnvaultFn(str);
        if (typeof res === 'string' && res !== str) {
          recordVaultMapping(str, res, 'mawUnvaultFn');
          return res;
        }
      } catch (_) {}
    }
    return str;
  }

  function isUnsendNoticeText(str) {
    if (!str || typeof str !== 'string') return false;
    const realStr = unvaultString(str).trim();
    if (realStr.length === 0 || realStr.length > 120) return false;
    return UNSEND_PATTERNS.some((regex) => regex.test(realStr));
  }

  function isSystemNoticeText(str) {
    if (!str || typeof str !== 'string') return false;
    const realStr = unvaultString(str).trim();
    return SYSTEM_NOTICE_PATTERNS.some((regex) => regex.test(realStr));
  }

  function isTechnicalString(str) {
    if (!str || typeof str !== 'string') return true;
    const trimmed = unvaultString(str).trim();
    if (trimmed.length === 0) return true;
    if (isSystemNoticeText(trimmed)) return true;

    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      return true;
    }

    if (
      trimmed.startsWith('@@vault') ||
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

    if (/^\d{12,25}$/.test(trimmed)) return true;

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
        /^(insert|upsert|update|delete|remove|handle|mark|set|clear|sync|fetch|verify|apply|replace|move|create|ensure|compute|process|execute|send|receive|check|truncate|populate|optimistic|lightspeed|armadillo|maw|wa|LS)[A-Z][a-zA-Z0-9_]*$/.test(
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
    const trimmed = unvaultString(str).trim();
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
    const strId = unvaultString(String(id)).trim();
    return aliasIdMap.get(strId) || strId;
  }

  /**
   * Kiểm tra xem timestamp (ms) có phải là tin nhắn cũ từ trước khi mở trang hay không.
   * Chỉ chấp nhận tin nhắn từ 30 giây trước khi mở trang trở đi.
   */
  function isOldHistoricalTimestamp(ts) {
    if (!ts || typeof ts !== 'number') return false;
    return ts > 1577836800000 && ts < PAGE_LOAD_TIME - 30 * 1000;
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
    if (timestamp && isOldHistoricalTimestamp(timestamp)) return;

    messageId = resolveCanonicalMessageId(messageId);
    if (Array.isArray(altIds)) {
      for (const alt of altIds) {
        if (alt) {
          const cleanAlt = unvaultString(String(alt)).trim();
          if (cleanAlt && cleanAlt !== messageId) {
            aliasIdMap.set(cleanAlt, messageId);
          }
        }
      }
    }

    const unvaultedText = typeof text === 'string' ? unvaultString(text) : '';

    if (unvaultedText && isUnsendNoticeText(unvaultedText)) {
      if (capturedMessages.has(messageId)) {
        triggerMessageUnsent(messageId, {
          senderId,
          threadId,
          unsendNotice: unvaultedText,
          source
        });
      }
      return;
    }

    const cleanText =
      unvaultedText &&
      !isTechnicalString(unvaultedText) &&
      !isUnsendNoticeText(unvaultedText)
        ? unvaultedText.trim()
        : '';
    const cleanAttachments = Array.isArray(attachments)
      ? attachments.map(unvaultString).filter(Boolean)
      : [];

    const existing = capturedMessages.get(messageId);
    if (!cleanText && cleanAttachments.length === 0) return;

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
      source: source || existing?.source || 'internal',
      isUnsent: existing?.isUnsent || false
    };

    capturedMessages.set(messageId, updatedRecord);

    if (isActuallyNew) {
      console.log(
        `${LOG_PREFIX} 📩 Đã bắt ngầm tin nhắn [${messageId}] (Nguồn: ${updatedRecord.source}):`,
        updatedRecord.text || `(Đính kèm: ${updatedRecord.attachments.length} media)`
      );
      emitToContentScript('FB_MSG_CAPTURED', updatedRecord);
    }
  }

  function triggerMessageUnsent(rawMessageId, extraInfo = {}) {
    const messageId = resolveCanonicalMessageId(rawMessageId);
    if (!messageId) return;

    const existing = capturedMessages.get(messageId);
    if (!existing || existing.isUnsent) return;
    if (!existing.text && (!existing.attachments || existing.attachments.length === 0)) return;

    const record = {
      ...existing,
      unsentAt: Date.now(),
      source: extraInfo.source || existing.source || 'internal',
      isUnsent: true
    };

    capturedMessages.set(messageId, record);

    console.log(
      `${LOG_PREFIX} 🚨 PHÁT HIỆN GỠ TIN NHẮN NGẦM [${messageId}] (Nguồn: ${record.source})! Nội dung gốc:`,
      record.text || `[Media: ${record.attachments.join(', ')}]`
    );

    emitToContentScript('FB_MSG_UNSENT', record);
  }

  // ============================================================================
  // 3. XỬ LÝ CHÍNH XÁC CÁC HÀM NỘI BỘ FACEBOOK (LS* & MAW*)
  // ============================================================================
  function inspectInternalProcedureCall(moduleName, args, returnValue) {
    if (!args) return;

    if (containsKeywordDeep(args) || containsKeywordDeep(returnValue)) {
      logDiagnosticHit(`__d Module: ${moduleName}`, `argsCount=${args.length}`, {
        args,
        returnValue
      });
    } else if (isDiagActive && /^MAW/i.test(moduleName)) {
      console.log(`${DIAG_PREFIX} [E2EE Module Call] ${moduleName}:`, { args, returnValue });
    }

    if (/InsertNewMessageRange/i.test(moduleName)) return;

    // A. Xử lý chuyên biệt cấu trúc 81-83 tham số của LSUpsertMessage & LSDeleteThenInsertMessage
    if (/^(LSUpsertMessage|LSDeleteThenInsertMessage)(\.|$)/i.test(moduleName) && args.length >= 18) {
      const rawText = typeof args[0] === 'string' ? unvaultString(args[0]) : undefined;
      const tsStr = parseLSInt64(args[2]);
      const timestamp = tsStr ? Number(tsStr) : Date.now();
      const threadId = parseLSInt64(args[3]) || '';
      const msgId = typeof args[8] === 'string' ? unvaultString(args[8]).trim() : '';
      const otid = typeof args[9] === 'string' ? unvaultString(args[9]).trim() : '';
      const senderId = parseLSInt64(args[10]) || '';
      const isAdminMessage = args[12] === true;
      const isUnsentFlag1 = args[17] === true;
      const unsentTsStr = parseLSInt64(args[18]);
      const isUnsentFlag2 = args.length > 43 && args[43] === true;

      // Bỏ qua thông báo hệ thống của nhóm (rời nhóm, vào nhóm, đổi tên...)
      if (isAdminMessage) return;
      if (!msgId) return;

      const resolvedId = resolveCanonicalMessageId(msgId);
      const isUnsent =
        isUnsentFlag1 ||
        isUnsentFlag2 ||
        (unsentTsStr && unsentTsStr !== '0') ||
        (rawText && isUnsendNoticeText(rawText)) ||
        (capturedMessages.has(resolvedId) && (rawText === undefined || rawText === null || rawText === ''));

      // Nếu là sự kiện thu hồi/xóa tin nhắn -> Kích hoạt ngay (kể cả tin nhắn gửi trước đó vài phút)
      if (isUnsent) {
        triggerMessageUnsent(resolvedId, {
          threadId,
          senderId,
          source: `module:${moduleName}`
        });
        return;
      }

      // Nếu là tin nhắn thường -> Chặn triệt để tin nhắn lịch sử cũ từ quá khứ
      if (isOldHistoricalTimestamp(timestamp)) return;

      if (rawText && !isTechnicalString(rawText)) {
        registerCapturedMessage({
          messageId: msgId,
          altIds: [msgId, otid].filter(Boolean),
          text: rawText,
          senderId,
          threadId,
          attachments: [],
          timestamp,
          source: `module:${moduleName}`
        });
      }
      return;
    }

    // B. Xử lý các module E2EE Snippet (MAWThreadSnippetFor*Msg)
    if (/^MAWThreadSnippetForRevokedMsg/i.test(moduleName)) {
      console.log(`${DIAG_PREFIX} 🚨 Phát hiện gọi hàm thu hồi E2EE [${moduleName}]:`, args);
    }

    // C. Quét tổng quát cho các module khác (LSInsertMessage, LSDeleteMessage, MAWThreadSnippetFor*Msg...)
    let msgIds = [];
    let altIds = [];
    let texts = [];
    let mediaUrls = [];
    let timestamps = [];
    let hasUnsendNotice = false;
    let hasNullTextAfterExisting = false;

    const allItems = [...args];
    if (returnValue !== undefined && returnValue !== null) {
      allItems.push(returnValue);
    }

    for (let i = 0; i < allItems.length; i++) {
      const arg = allItems[i];
      if (arg === null || arg === undefined) {
        hasNullTextAfterExisting = true;
        continue;
      }

      if (typeof arg === 'string') {
        const unvaulted = unvaultString(arg).trim();
        if (
          unvaulted.startsWith('mid.$') ||
          unvaulted.startsWith('wmid.') ||
          unvaulted.startsWith('otid.')
        ) {
          msgIds.push(unvaulted);
        } else if (unvaulted.startsWith('ee.mid.$')) {
          altIds.push(unvaulted.replace(/^ee\./, ''));
        } else if (/^\d{15,22}$/.test(unvaulted)) {
          altIds.push(unvaulted);
        } else if (isUnsendNoticeText(unvaulted)) {
          hasUnsendNotice = true;
        } else {
          const mUrl = extractMediaUrl(unvaulted);
          if (mUrl) {
            mediaUrls.push(mUrl);
          } else if (!isTechnicalString(unvaulted)) {
            texts.push(unvaulted);
          }
        }
      } else if (typeof arg === 'object') {
        const i64Str = parseLSInt64(arg);
        if (i64Str) {
          const num = Number(i64Str);
          if (num > 1577836800000 && num < 2051222400000) {
            timestamps.push(num);
          }
        } else if (Array.isArray(arg)) {
          inspectLightspeedNode(arg, {
            fromRealtime: true,
            currentFunc: moduleName,
            source: `module:${moduleName}`
          });
        } else {
          inspectPlainObject(arg, 0, {
            fromRealtime: true,
            currentFunc: moduleName,
            source: `module:${moduleName}`
          });
        }
      }
    }

    if (msgIds.length === 0 && altIds.length > 0) {
      const matchedExisting = altIds.find((id) =>
        capturedMessages.has(resolveCanonicalMessageId(id))
      );
      if (matchedExisting) {
        msgIds.push(matchedExisting);
      } else if (/InsertMessage|UpsertMessage|ReplaceOptimisticMessage|MAWThreadSnippet/i.test(moduleName)) {
        msgIds.push(altIds[0]);
      }
    }

    if (msgIds.length > 0) {
      const primaryId = msgIds[0];
      const resolvedId = resolveCanonicalMessageId(primaryId);
      const bestTimestamp = timestamps.length > 0 ? Math.min(...timestamps) : Date.now();

      const isUnsendProcedure =
        /MarkMessageUnsent|HandleUnsendMessage|DeleteMessage|Unsend|Revoke|Tombstone/i.test(
          moduleName
        );
      const isDeleteThenInsert = /DeleteThenInsertMessage|UpsertMessage|UpdateMessage/i.test(
        moduleName
      );

      if (isUnsendProcedure || hasUnsendNotice) {
        triggerMessageUnsent(resolvedId, { source: `module:${moduleName}` });
      } else if (
        isDeleteThenInsert &&
        capturedMessages.has(resolvedId) &&
        texts.length === 0 &&
        hasNullTextAfterExisting
      ) {
        triggerMessageUnsent(resolvedId, { source: `module:${moduleName}` });
      } else if (texts.length > 0 || mediaUrls.length > 0) {
        if (timestamps.length > 0 && isOldHistoricalTimestamp(bestTimestamp)) return;
        registerCapturedMessage({
          messageId: primaryId,
          altIds: [...msgIds, ...altIds],
          text: texts[0] || '',
          attachments: mediaUrls,
          timestamp: bestTimestamp,
          source: `module:${moduleName}`
        });
      }
    }
  }

  // Hook bảng ReStore (nếu truy cập qua plain object)
  const hookedTables = new WeakSet();
  function wrapReStoreTable(tableObj, tableName) {
    if (!tableObj || typeof tableObj !== 'object' || hookedTables.has(tableObj)) return;
    hookedTables.add(tableObj);

    const writeMethods = ['put', 'upsert', 'add', 'replace'];
    writeMethods.forEach((method) => {
      if (typeof tableObj[method] === 'function') {
        const origMethod = tableObj[method];
        tableObj[method] = function (record) {
          try {
            if (record && typeof record === 'object') {
              queueMicrotask(() => {
                inspectPlainObject(record, 0, {
                  fromRealtime: true,
                  currentFunc: `ReStore.${tableName}.${method}`,
                  source: `ReStore:${tableName}`
                });
              });
            }
          } catch (_) {}
          return origMethod.apply(this, arguments);
        };
      }
    });
  }

  /**
   * Bọc một hàm đơn lẻ một cách an toàn (giữ nguyên prototype và static properties để không làm hỏng Class/Bridge)
   */
  function safeWrapFunction(origFn, label, isUnvaultModule = false) {
    if (typeof origFn !== 'function' || origFn.__fbSafeWrapped) return origFn;
    // Không bọc nếu hàm là một Class Constructor có các phương thức trên prototype
    if (origFn.prototype && Object.getOwnPropertyNames(origFn.prototype).length > 1) {
      return origFn;
    }

    const wrapped = function () {
      const args = Array.from(arguments);
      const ret = origFn.apply(this, arguments);
      try {
        if (isUnvaultModule) {
          if (typeof args[0] === 'string' && typeof ret === 'string') {
            recordVaultMapping(args[0], ret, label);
          }
        } else {
          queueMicrotask(() => {
            try {
              inspectInternalProcedureCall(label, args, ret);
            } catch (_) {}
          });
        }
      } catch (_) {}
      return ret;
    };

    try {
      wrapped.prototype = origFn.prototype;
      Object.assign(wrapped, origFn);
      Object.defineProperty(wrapped, '__fbSafeWrapped', { value: true });
    } catch (_) {}

    return wrapped;
  }

  function instrumentFacebookModule(moduleName, exportsObj) {
    if (!exportsObj) return exportsObj;

    try {
      const isUnvaultMod = /^MAW(Vault|UnvaultTransform)$/i.test(moduleName);

      if (typeof exportsObj === 'function') {
        return safeWrapFunction(exportsObj, moduleName, isUnvaultMod);
      } else if (typeof exportsObj === 'object') {
        for (const key of Object.keys(exportsObj)) {
          const val = exportsObj[key];
          if (typeof val === 'function') {
            if (key === 'unvault') {
              mawUnvaultFn = val.bind(exportsObj);
            }
            exportsObj[key] = safeWrapFunction(val, `${moduleName}.${key}`, isUnvaultMod);
          }
        }
      }
    } catch (_) {}

    return exportsObj;
  }

  // Chỉ nhắm đích danh vào các module xử lý Tin nhắn & Giải mã Snippet, TUYỆT ĐỐI không chạm vào MAWBridge kết nối Worker
  const SAFE_TARGET_MODULE_REGEX =
    /^(LSUpsertMessage|LSDeleteThenInsertMessage|LSInsertMessage|LSReplaceOptimisticMessage|LSDeleteMessage|LSDeleteMessageRequest|LSMarkMessageUnsent|LSHandleUnsendMessage|LSUpdateMessage|LSInsertBlobAttachment|MAWUnvaultTransform|MAWVault|MAWThreadSnippetFor.*Msg|MAWBridgeBuildThreadSnippet)$/i;

  let currentDefFunc = window.__d;
  function wrapDefineFn(origD) {
    if (!origD || origD.__fbUnsendWrapped) return origD;
    const wrappedD = function (moduleName, deps, factory, _extra) {
      if (
        typeof moduleName === 'string' &&
        typeof factory === 'function' &&
        SAFE_TARGET_MODULE_REGEX.test(moduleName)
      ) {
        const origFactory = factory;
        factory = function (g, r, i, a, m, e, d) {
          const ret = origFactory.apply(this, arguments);
          try {
            if (m && m.exports) {
              m.exports = instrumentFacebookModule(moduleName, m.exports);
            } else if (e) {
              instrumentFacebookModule(moduleName, e);
            }
          } catch (_) {}
          return ret;
        };
      }
      return origD.apply(this, arguments);
    };
    wrappedD.__fbUnsendWrapped = true;
    return wrappedD;
  }

  if (typeof currentDefFunc === 'function') {
    currentDefFunc = wrapDefineFn(currentDefFunc);
  }

  try {
    Object.defineProperty(window, '__d', {
      configurable: true,
      enumerable: true,
      get: function () {
        return currentDefFunc;
      },
      set: function (newFn) {
        currentDefFunc = wrapDefineFn(newFn);
      }
    });
  } catch (_) {}

  // ============================================================================
  // 4. BỘ PHÂN TÍCH LIGHTSPEED & PLAIN OBJECT
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

      if (currentFunc === 'insertNewMessageRange') return;

      let directMsgIds = [];
      let directAltIds = [];
      let directTextLiterals = [];
      let directMediaUrls = [];
      let directI64Values = [];
      let hasUnsendNoticeInNode = false;

      for (let i = 0; i < node.length; i++) {
        const item = node[i];
        if (typeof item === 'string') {
          const trimmed = unvaultString(item).trim();
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
        } else if (Array.isArray(item) && item.length === 2) {
          const i64Str = parseLSInt64(item);
          if (i64Str) {
            directI64Values.push(i64Str);
          }
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
            if (!timestamp || num < timestamp) timestamp = num;
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

        const resolvedId = resolveCanonicalMessageId(primaryId);

        if (hasUnsendNoticeInNode || isExplicitUnsendFunc) {
          triggerMessageUnsent(resolvedId, {
            threadId,
            senderId,
            source: context.source
          });
        } else if (directTextLiterals.length > 0 || directMediaUrls.length > 0) {
          if (timestamp && isOldHistoricalTimestamp(timestamp)) return;
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
            ((child.length === 2 && parseLSInt64(child) !== null) ||
              (child.length === 1 && child[0] === 9))
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
      if (obj.tables && typeof obj.tables === 'object' && obj.tables.messages) {
        wrapReStoreTable(obj.tables.messages, 'messages');
      }

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
        const msgId = unvaultString(String(rawMsgId)).trim();
        if (msgId.length >= 4) {
          let timestamp = Date.now();
          if (typeof obj.timestampMs === 'number') {
            timestamp = obj.timestampMs;
          } else if (Array.isArray(obj.timestampMs)) {
            const parsedTs = parseLSInt64(obj.timestampMs);
            if (parsedTs) timestamp = Number(parsedTs);
          } else if (typeof obj.timestamp === 'number') {
            timestamp = obj.timestamp;
          }

          const altIds = [
            obj.messageId,
            obj.externalId,
            obj.offlineThreadingId,
            obj.otid,
            obj.id
          ]
            .filter(Boolean)
            .map((v) => unvaultString(String(v)));

          const rawTextContent =
            obj.text ??
            obj.body ??
            obj.plaintext ??
            obj.messageText ??
            obj.snippet ??
            (typeof obj.message === 'string' ? obj.message : obj.message?.text) ??
            (typeof obj.content === 'string' ? obj.content : obj.content?.text);

          const textContent =
            typeof rawTextContent === 'string' ? unvaultString(rawTextContent) : rawTextContent;

          const senderId = String(
            obj.senderId || obj.sender_id || obj.author || obj.actorId || obj.from || ''
          );
          const threadId = String(
            obj.threadId || obj.thread_id || obj.threadKey || obj.threadFbId || obj.chatId || ''
          );
          const senderName = String(obj.senderName || obj.authorName || obj.title || '');

          const unsentTsParsed = Array.isArray(obj.unsentTimestampMs)
            ? parseLSInt64(obj.unsentTimestampMs)
            : null;

          const isUnsentFlag =
            obj.isUnsent === true ||
            obj.is_unsent === true ||
            obj.unsent === true ||
            obj.isRevoked === true ||
            obj.type === 'revoked' ||
            obj.type === 'unsent' ||
            (typeof obj.unsentTimestampMs === 'number' && obj.unsentTimestampMs > 0) ||
            (unsentTsParsed && unsentTsParsed !== '0') ||
            obj.messageRenderingType === 2 ||
            (typeof textContent === 'string' && isUnsendNoticeText(textContent));

          if (isUnsentFlag) {
            triggerMessageUnsent(msgId, { senderId, threadId, senderName, source: context.source });
          } else if (
            typeof textContent === 'string' &&
            textContent.trim().length > 0 &&
            !isTechnicalString(textContent)
          ) {
            if (isOldHistoricalTimestamp(timestamp)) return;
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
                if (url && typeof url === 'string') attachments.push(unvaultString(url));
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
            (textContent === '' || textContent === null || textContent === undefined) &&
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
        }
      }
    } catch (_) {}
  }

  // ============================================================================
  // 5. Hook WebSocket & IndexedDB (Không chạm vào SharedWorker/MessagePort)
  // ============================================================================
  const originalJSONParse = JSON.parse;
  const OriginalWebSocket = window.WebSocket;

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

  function handleWebSocketFrame(data, wsUrl = '') {
    try {
      let decoded = '';
      if (typeof data === 'string') {
        decoded = data;
      } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        decoded = safeDecodeBuffer(data);
      } else if (data instanceof Blob) {
        data
          .arrayBuffer()
          .then((buf) => handleWebSocketFrame(buf, wsUrl))
          .catch(() => {});
        return;
      }

      if (decoded && decoded.toLowerCase().includes(DIAG_KEYWORD)) {
        logDiagnosticHit(`WebSocket (${wsUrl})`, `len=${decoded.length}`, decoded);
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
        handleWebSocketFrame(event.data, url);
      });
    });

    return ws;
  };
  window.WebSocket.prototype = OriginalWebSocket.prototype;
  Object.assign(window.WebSocket, OriginalWebSocket);

  if (window.IDBObjectStore) {
    const origPut = IDBObjectStore.prototype.put;
    const origAdd = IDBObjectStore.prototype.add;
    const origDelete = IDBObjectStore.prototype.delete;

    IDBObjectStore.prototype.put = function (value, key) {
      const storeName = this.name || 'unknown';
      try {
        if (containsKeywordDeep(value) || containsKeywordDeep(key)) {
          logDiagnosticHit(`IndexedDB.put (store="${storeName}")`, `key=${key}`, value);
        }
        if (value && typeof value === 'object') {
          queueMicrotask(() => {
            try {
              inspectPlainObject(value, 0, {
                fromRealtime: true,
                currentFunc: `IDB.put:${storeName}`,
                source: `idb:${storeName}`
              });
            } catch (_) {}
          });
        }
      } catch (_) {}
      return origPut.apply(this, arguments);
    };

    IDBObjectStore.prototype.add = function (value, key) {
      const storeName = this.name || 'unknown';
      try {
        if (containsKeywordDeep(value) || containsKeywordDeep(key)) {
          logDiagnosticHit(`IndexedDB.add (store="${storeName}")`, `key=${key}`, value);
        }
        if (value && typeof value === 'object') {
          queueMicrotask(() => {
            try {
              inspectPlainObject(value, 0, {
                fromRealtime: true,
                currentFunc: `IDB.add:${storeName}`,
                source: `idb:${storeName}`
              });
            } catch (_) {}
          });
        }
      } catch (_) {}
      return origAdd.apply(this, arguments);
    };

    IDBObjectStore.prototype.delete = function (key) {
      const storeName = this.name || 'unknown';
      try {
        if (key !== undefined && key !== null) {
          const strKey = Array.isArray(key) ? String(key[0]) : String(key);
          const resolved = resolveCanonicalMessageId(strKey);
          if (capturedMessages.has(resolved)) {
            queueMicrotask(() => {
              triggerMessageUnsent(resolved, { source: `idb-delete:${storeName}` });
            });
          }
        }
      } catch (_) {}
      return origDelete.apply(this, arguments);
    };
  }
})();
