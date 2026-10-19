/**
 * injected.js - Chạy trong MAIN world ở thời điểm document_start trên facebook.com
 * Phiên bản v3.1: Tích hợp Bộ chẩn đoán tận gốc E2EE (Deep E2EE Diagnostic Sniffer)
 * Nhiệm vụ:
 * 1. Bắt và khôi phục tin nhắn như bình thường.
 * 2. Dò tìm tận gốc đường đi của tin nhắn Mã hóa đầu cuối (E2EE) qua tất cả các tầng:
 *    - TextDecoder.prototype.decode (Bắt khoảnh khắc Wasm/Signal giải mã mảng byte UTF-8 thành string)
 *    - crypto.subtle.decrypt (Bắt khoảnh khắc WebCrypto giải mã dữ liệu)
 *    - IndexedDB (put / add / delete trên mọi ObjectStore)
 *    - Worker / SharedWorker / MessagePort / BroadcastChannel
 *    - Hệ thống Module window.__d (Liệt kê và theo dõi mọi hàm MAW*, ReStore*, LS*)
 *    - In kèm Call Stack (new Error().stack) ngay khi thấy từ khóa "testngam" hoặc sự kiện E2EE!
 */

(function () {
  if (window.__FB_UNSEND_INJECTED__) return;
  window.__FB_UNSEND_INJECTED__ = true;

  const LOG_PREFIX = '[FB-Unsend-Tracker]';
  const DIAG_PREFIX = '🔍 [E2EE-DIAG]';
  const PAGE_LOAD_TIME = Date.now();
  const DIAG_KEYWORD = 'testngam';

  // Chỉ bật log chi tiết cho mọi sự kiện ngầm sau khi trang đã nạp xong (sau 6 giây)
  // riêng từ khóa "testngam" thì bắt ngay lập tức ở mọi thời điểm!
  let isDiagActive = false;
  setTimeout(() => {
    isDiagActive = true;
    console.log(
      `%c${DIAG_PREFIX} ĐÃ SẴN SÀNG CHẨN ĐOÁN E2EE! Hãy lấy nick kia nhắn chữ "${DIAG_KEYWORD}" rồi bấm gỡ (có thể đóng khung chat để test ngầm).`,
      'background: #1e1e2e; color: #52c41a; font-weight: bold; padding: 4px 8px; border-radius: 4px;'
    );
    console.log(`${DIAG_PREFIX} Các module E2EE/LS đã phát hiện trong __d:`, Array.from(discoveredModules).slice(0, 60));
  }, 6000);

  const capturedMessages = new Map();
  const aliasIdMap = new Map();
  const processedNodes = new WeakSet();
  const discoveredModules = new Set();
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
   * Kiểm tra xem một dữ liệu bất kỳ (String, Object, Array, ArrayBuffer) có chứa từ khóa chẩn đoán không
   */
  function containsKeywordDeep(val, keyword = DIAG_KEYWORD, depth = 0, visited = new WeakSet()) {
    if (!val || depth > 6) return false;
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
  // CHẨN ĐOÁN 1: Hook TextDecoder.prototype.decode (Bắt mọi chuỗi vừa giải mã từ Wasm/Binary)
  // ============================================================================
  TextDecoder.prototype.decode = function (input, options) {
    const result = origTextDecoderDecode.apply(this, arguments);
    try {
      if (typeof result === 'string' && result.length > 0) {
        if (result.toLowerCase().includes(DIAG_KEYWORD)) {
          logDiagnosticHit('TextDecoder.decode', `length=${result.length}`, result);
        } else if (
          isDiagActive &&
          result.length < 2000 &&
          (result.includes('mid.$') ||
            result.includes('wmid.') ||
            result.includes('deleteThenInsertMessage') ||
            result.includes('markMessageUnsent') ||
            isUnsendNoticeText(result))
        ) {
          console.log(`${DIAG_PREFIX} [TextDecoder] Giải mã gói tin có cấu trúc Message:`, result.slice(0, 300));
        }
      }
    } catch (_) {}
    return result;
  };

  // ============================================================================
  // CHẨN ĐOÁN 2: Hook WebCrypto (crypto.subtle.decrypt)
  // ============================================================================
  if (window.crypto && window.crypto.subtle && window.crypto.subtle.decrypt) {
    const origDecrypt = window.crypto.subtle.decrypt;
    window.crypto.subtle.decrypt = function (algorithm, key, data) {
      const promise = origDecrypt.apply(this, arguments);
      try {
        promise
          .then((decryptedBuffer) => {
            const decodedStr = safeDecodeBuffer(decryptedBuffer);
            if (decodedStr && decodedStr.toLowerCase().includes(DIAG_KEYWORD)) {
              logDiagnosticHit('crypto.subtle.decrypt', `alg=${algorithm?.name || algorithm}`, decodedStr);
            } else if (isDiagActive && decodedStr && decodedStr.length > 0) {
              // In thử các chuỗi có ý nghĩa đọc được từ bản rõ sau khi giải mã WebCrypto
              const printable = decodedStr.replace(/[^\x20-\x7E\u00A0-\uFFFF]/g, ' ').trim();
              if (printable.length > 3) {
                console.log(`${DIAG_PREFIX} [WebCrypto.decrypt] Bản rõ sau giải mã (${decryptedBuffer.byteLength} bytes):`, printable.slice(0, 200));
              }
            }
          })
          .catch(() => {});
      } catch (_) {}
      return promise;
    };
  }

  // ============================================================================
  // CÁC HÀM LỌC VÀ XỬ LÝ TIN NHẮN CỐT LÕI
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

  function unvaultString(str) {
    if (!str || typeof str !== 'string') return str;
    if (vaultMap.has(str)) {
      return vaultMap.get(str);
    }
    if (mawUnvaultFn && (str.startsWith('@@vault') || str.startsWith('vault:'))) {
      try {
        const res = mawUnvaultFn(str);
        if (typeof res === 'string' && res !== str) {
          vaultMap.set(str, res);
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

  function isOldHistoricalTimestamp(ts) {
    if (!ts || typeof ts !== 'number') return false;
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
  // CHẨN ĐOÁN 3: Hook window.__d (Module Loader của Facebook)
  // ============================================================================
  function inspectInternalProcedureCall(moduleName, args) {
    if (!args || args.length === 0) return;

    if (containsKeywordDeep(args)) {
      logDiagnosticHit(`__d Module: ${moduleName}`, `argsCount=${args.length}`, args);
    } else if (
      isDiagActive &&
      /Unsend|Unsent|Delete|Revoke|Tombstone|InsertMessage|UpsertMessage/i.test(moduleName) &&
      !/InsertNewMessageRange/i.test(moduleName)
    ) {
      console.log(`${DIAG_PREFIX} [Module Call] ${moduleName}:`, args);
    }

    if (/InsertNewMessageRange/i.test(moduleName)) return;

    let msgIds = [];
    let altIds = [];
    let texts = [];
    let mediaUrls = [];
    let hasUnsendNotice = false;
    let hasNullTextAfterExisting = false;

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
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
        if (Array.isArray(arg)) {
          if (!(arg.length === 2 && arg[0] === 19)) {
            inspectLightspeedNode(arg, {
              fromRealtime: true,
              currentFunc: moduleName,
              source: `module:${moduleName}`
            });
          }
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
      } else if (/InsertMessage|UpsertMessage|ReplaceOptimisticMessage/i.test(moduleName)) {
        msgIds.push(altIds[0]);
      }
    }

    if (msgIds.length > 0) {
      const primaryId = msgIds[0];
      const resolvedId = resolveCanonicalMessageId(primaryId);

      const isUnsendProcedure =
        /MarkMessageUnsent|HandleUnsendMessage|DeleteMessage|Unsend|Revoke|Tombstone/i.test(
          moduleName
        );
      const isDeleteThenInsert = /DeleteThenInsertMessage|UpsertMessage|UpdateMessage/i.test(
        moduleName
      );

      if (isUnsendProcedure || hasUnsendNotice) {
        triggerMessageUnsent(resolvedId, { source: `module:${moduleName}` });
      } else if (texts.length > 0 || mediaUrls.length > 0) {
        registerCapturedMessage({
          messageId: primaryId,
          altIds: [...msgIds, ...altIds],
          text: texts[0] || '',
          attachments: mediaUrls,
          timestamp: Date.now(),
          source: `module:${moduleName}`
        });
      } else if (
        isDeleteThenInsert &&
        capturedMessages.has(resolvedId) &&
        texts.length === 0 &&
        hasNullTextAfterExisting
      ) {
        triggerMessageUnsent(resolvedId, { source: `module:${moduleName}` });
      }
    }
  }

  const hookedTables = new WeakSet();
  function wrapReStoreTable(tableObj, tableName) {
    if (!tableObj || typeof tableObj !== 'object' || hookedTables.has(tableObj)) return;
    hookedTables.add(tableObj);
    console.log(`${DIAG_PREFIX} Đã gắn hook trực tiếp vào bảng ReStore [${tableName}]!`);

    const writeMethods = ['put', 'upsert', 'add', 'replace'];
    writeMethods.forEach((method) => {
      if (typeof tableObj[method] === 'function') {
        const origMethod = tableObj[method];
        tableObj[method] = function (record) {
          try {
            if (containsKeywordDeep(record)) {
              logDiagnosticHit(`ReStore.${tableName}.${method}`, '', record);
            } else if (isDiagActive && tableName === 'messages') {
              console.log(`${DIAG_PREFIX} [ReStore.messages.${method}]:`, record);
            }
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

    if (typeof tableObj.delete === 'function') {
      const origDel = tableObj.delete;
      tableObj.delete = function (key) {
        try {
          if (isDiagActive) {
            console.log(`${DIAG_PREFIX} [ReStore.${tableName}.delete] key=`, key);
          }
          if (key !== undefined && key !== null) {
            const strKey = Array.isArray(key) ? String(key[0]) : String(key);
            const resolved = resolveCanonicalMessageId(strKey);
            if (capturedMessages.has(resolved)) {
              queueMicrotask(() => {
                triggerMessageUnsent(resolved, { source: `ReStore:${tableName}.delete` });
              });
            }
          }
        } catch (_) {}
        return origDel.apply(this, arguments);
      };
    }
  }

  function instrumentFacebookModule(moduleName, exportsObj) {
    if (!exportsObj) return exportsObj;

    try {
      if (/MAWVault/i.test(moduleName)) {
        const target = exportsObj.default || exportsObj;
        if (typeof target === 'object' && target !== null) {
          if (typeof target.unvault === 'function') {
            mawUnvaultFn = target.unvault.bind(target);
          }
          if (typeof target.vault === 'function') {
            const origVault = target.vault;
            target.vault = function (plainValue) {
              const vaultedToken = origVault.apply(this, arguments);
              try {
                if (typeof plainValue === 'string' && typeof vaultedToken === 'string') {
                  vaultMap.set(vaultedToken, plainValue);
                  if (plainValue.toLowerCase().includes(DIAG_KEYWORD)) {
                    logDiagnosticHit(`${moduleName}.vault`, `token=${vaultedToken}`, plainValue);
                  } else if (isDiagActive && !isTechnicalString(plainValue)) {
                    console.log(`${DIAG_PREFIX} [MAWVault.vault] Chuỗi vừa đưa vào Vault:`, plainValue, '->', vaultedToken);
                  }
                }
              } catch (_) {}
              return vaultedToken;
            };
          }
        }
        return exportsObj;
      }

      if (typeof exportsObj === 'function') {
        const origFn = exportsObj;
        const wrapped = function () {
          const args = Array.from(arguments);
          queueMicrotask(() => {
            try {
              inspectInternalProcedureCall(moduleName, args);
            } catch (_) {}
          });
          return origFn.apply(this, arguments);
        };
        Object.assign(wrapped, origFn);
        return wrapped;
      } else if (typeof exportsObj === 'object') {
        for (const key of Object.keys(exportsObj)) {
          if (typeof exportsObj[key] === 'function') {
            const origMethod = exportsObj[key];
            exportsObj[key] = function () {
              const args = Array.from(arguments);
              queueMicrotask(() => {
                try {
                  inspectInternalProcedureCall(`${moduleName}.${key}`, args);
                } catch (_) {}
              });
              return origMethod.apply(this, arguments);
            };
          }
        }
      }
    } catch (_) {}

    return exportsObj;
  }

  let currentDefFunc = window.__d;
  function wrapDefineFn(origD) {
    if (!origD || origD.__fbUnsendWrapped) return origD;
    const wrappedD = function (moduleName, deps, factory, _extra) {
      if (typeof moduleName === 'string') {
        if (/^(MAW|LS|ReStore|MWP|WAWeb).*(Message|Msg|Unsend|Unsent|Vault|Revoke|Tombstone|Bridge|Table|Db)/i.test(moduleName)) {
          discoveredModules.add(moduleName);
        }
      }

      if (
        typeof moduleName === 'string' &&
        typeof factory === 'function' &&
        (/^(LS|MAW|MWP|WAWeb).*(Message|Msg|Unsent|Unsend|Vault|Revoke|Tombstone|Bridge)/i.test(
          moduleName
        ) ||
          /MAWVault/i.test(moduleName))
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
  // BỘ PHÂN TÍCH 1 & 2: Lightspeed & Plain Object
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
            if (!timestamp || num < timestamp) timestamp = num;
          } else if (val.length >= 5 && val !== '0') {
            ids.push(val);
          }
        }

        if (timestamp && isOldHistoricalTimestamp(timestamp)) return;

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
          } else if (Array.isArray(obj.timestampMs) && obj.timestampMs[0] === 19) {
            timestamp = Number(obj.timestampMs[1]);
          } else if (typeof obj.timestamp === 'number') {
            timestamp = obj.timestamp;
          }

          if (isOldHistoricalTimestamp(timestamp)) return;

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
  // CHẨN ĐOÁN 4: Hook WebSocket, IndexedDB, Worker, SharedWorker, MessagePort
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
    console.log(`${DIAG_PREFIX} 🌐 Facebook mở kết nối WebSocket:`, url);
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

  // Hook IndexedDB
  if (window.IDBObjectStore) {
    const origPut = IDBObjectStore.prototype.put;
    const origAdd = IDBObjectStore.prototype.add;
    const origDelete = IDBObjectStore.prototype.delete;

    IDBObjectStore.prototype.put = function (value, key) {
      const storeName = this.name || 'unknown';
      try {
        if (containsKeywordDeep(value) || containsKeywordDeep(key)) {
          logDiagnosticHit(`IndexedDB.put (store="${storeName}")`, `key=${key}`, value);
        } else if (isDiagActive && /message|msg|thread|maw|ls/i.test(storeName)) {
          console.log(`${DIAG_PREFIX} [IDB.put] store="${storeName}" key=`, key, 'value=', value);
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
        } else if (isDiagActive && /message|msg|thread|maw|ls/i.test(storeName)) {
          console.log(`${DIAG_PREFIX} [IDB.add] store="${storeName}" key=`, key, 'value=', value);
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
        if (isDiagActive) {
          console.log(`${DIAG_PREFIX} [IDB.delete] store="${storeName}" key=`, key);
        }
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

  // Hook Worker / SharedWorker / MessagePort
  function inspectWorkerChannelData(data, sourceLabel) {
    if (!data) return;
    try {
      if (containsKeywordDeep(data)) {
        logDiagnosticHit(sourceLabel, '', data);
      } else if (isDiagActive) {
        console.log(`${DIAG_PREFIX} [${sourceLabel}] Gói dữ liệu Worker:`, data);
      }

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
    } catch (_) {}
  }

  if (window.Worker) {
    const OrigWorker = window.Worker;
    window.Worker = function (scriptURL, options) {
      console.log(`${DIAG_PREFIX} ⚙️ Facebook khởi tạo Dedicated Worker:`, String(scriptURL));
      const worker =
        options !== undefined
          ? new OrigWorker(scriptURL, options)
          : new OrigWorker(scriptURL);
      worker.addEventListener('message', (event) => {
        inspectWorkerChannelData(event.data, 'Worker.in');
      });
      return worker;
    };
    window.Worker.prototype = OrigWorker.prototype;
    Object.assign(window.Worker, OrigWorker);
  }

  if (window.SharedWorker) {
    const OrigSharedWorker = window.SharedWorker;
    window.SharedWorker = function (scriptURL, options) {
      console.log(`${DIAG_PREFIX} ⚙️ Facebook khởi tạo SharedWorker:`, String(scriptURL));
      const sw =
        options !== undefined
          ? new OrigSharedWorker(scriptURL, options)
          : new OrigSharedWorker(scriptURL);
      if (sw.port) {
        sw.port.addEventListener('message', (event) => {
          inspectWorkerChannelData(event.data, 'SharedWorker.in');
        });
      }
      return sw;
    };
    window.SharedWorker.prototype = OrigSharedWorker.prototype;
    Object.assign(window.SharedWorker, OrigSharedWorker);
  }

  if (window.MessagePort) {
    const origPortAddEventListener = MessagePort.prototype.addEventListener;
    const hookedPorts = new WeakSet();

    function ensurePortHooked(port) {
      if (!port || hookedPorts.has(port)) return;
      hookedPorts.add(port);
      origPortAddEventListener.call(port, 'message', (event) => {
        inspectWorkerChannelData(event.data, 'MessagePort.in');
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
