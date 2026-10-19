/**
 * injected.js - Chạy trong MAIN world ở thời điểm document_start trên facebook.com
 * Nhiệm vụ:
 * 1. Hook trực tiếp vào hệ thống Module nội bộ của Facebook (window.__d):
 *    - MAWVault (Giải mã chuỗi văn bản bị ẩn dưới dạng @@vault:... của đoạn chat E2EE Armadillo).
 *    - LS*StoredProcedure (Các hàm nội bộ xử lý thêm/cập nhật/thu hồi tin nhắn sau khi giải mã).
 *    - ReStore / MAW* (Cơ sở dữ liệu bảng messages trong bộ nhớ của Messenger E2EE & Lightspeed).
 * 2. Hook WebSocket, IndexedDB và MessagePort để bắt mọi gói tin thời gian thực ở dưới nền
 *    (hoạt động ngay cả khi đóng khung chat hoặc chuyển sang tab khác làm việc).
 */

(function () {
  if (window.__FB_UNSEND_INJECTED__) return;
  window.__FB_UNSEND_INJECTED__ = true;

  const LOG_PREFIX = '[FB-Unsend-Tracker]';
  const PAGE_LOAD_TIME = Date.now();
  console.log(
    `${LOG_PREFIX} Đã kích hoạt bộ theo dõi mã nội bộ v3.0 (Hook __d + MAWVault + ReStore + Lightspeed).`
  );

  // Map: messageId -> { messageId, text, senderId, threadId, attachments, timestamp, capturedAt, isUnsent }
  const capturedMessages = new Map();
  const aliasIdMap = new Map();
  const processedNodes = new WeakSet();

  // Bảng lưu ánh xạ của MAWVault (Dành riêng cho tin nhắn mã hóa đầu cuối E2EE trên Facebook)
  // Trong E2EE, Facebook dùng MAWVault để đổi chuỗi thật (plaintext) thành chuỗi "@@vault:..."
  const vaultMap = new Map();
  let mawUnvaultFn = null;

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

  /**
   * Giải mã chuỗi MAWVault (nếu chuỗi có dạng @@vault:... của E2EE)
   */
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

    if (timestamp && isOldHistoricalTimestamp(timestamp)) {
      return;
    }

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
  // TẦNG HOOK CỐT LÕI: HỆ THỐNG MODULE NỘI BỘ FACEBOOK (window.__d)
  // Đón lõng MAWVault, LS*StoredProcedure, ReStore và MAW* cho cả E2EE & Thường
  // ============================================================================

  /**
   * Phân tích danh sách tham số (arguments) được truyền vào một hàm Stored Procedure nội bộ
   * Ví dụ: LSUpsertMessageStoredProcedure, LSDeleteThenInsertMessageStoredProcedure, MAW...
   */
  function inspectInternalProcedureCall(moduleName, args) {
    if (!args || args.length === 0) return;

    // Bỏ qua hàm đồng bộ lịch sử cũ
    if (/InsertNewMessageRange/i.test(moduleName)) return;

    let msgIds = [];
    let altIds = [];
    let texts = [];
    let mediaUrls = [];
    let i64Numbers = [];
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
      } else if (typeof arg === 'number') {
        if (arg > 1577836800000 && arg < 2051222400000) {
          i64Numbers.push(String(arg));
        }
      } else if (typeof arg === 'object') {
        if (Array.isArray(arg)) {
          // Kiểu I64 trong Lightspeed runtime: [high32, low32] hoặc [19, "1000..."]
          if (arg.length === 2 && arg[0] === 19 && typeof arg[1] === 'string') {
            i64Numbers.push(arg[1]);
          } else {
            inspectLightspeedNode(arg, {
              fromRealtime: true,
              currentFunc: moduleName,
              source: `module:${moduleName}`
            });
          }
        } else {
          // Nếu đối số là một Object (ví dụ bản ghi ReStore hoặc tham số đóng gói của MAW E2EE)
          inspectPlainObject(arg, 0, {
            fromRealtime: true,
            currentFunc: moduleName,
            source: `module:${moduleName}`
          });
        }
      }
    }

    // Với E2EE, đôi khi ID tin nhắn là chuỗi số 15-22 chữ số nằm trong altIds
    if (msgIds.length === 0 && altIds.length > 0) {
      // Kiểm tra xem có ID nào đã tồn tại trong capturedMessages không
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
        // Khi hàm DeleteThenInsertMessage hoặc UpsertMessage được gọi lại trên một tin nhắn đã lưu
        // nhưng tham số text truyền vào là null/rỗng -> Tin nhắn vừa bị thu hồi!
        triggerMessageUnsent(resolvedId, { source: `module:${moduleName}` });
      }
    }
  }

  /**
   * Bọc (Wrap) đối tượng bảng dữ liệu của ReStore (bảng messages, attachments)
   */
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

    if (typeof tableObj.delete === 'function') {
      const origDel = tableObj.delete;
      tableObj.delete = function (key) {
        try {
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

  /**
   * Kiểm tra và bọc moduleExports của một module vừa được khởi tạo qua window.__d
   */
  function instrumentFacebookModule(moduleName, exportsObj) {
    if (!exportsObj) return exportsObj;

    try {
      // 1. Module MAWVault: Nơi cất giữ chuỗi bản rõ của đoạn chat mã hóa đầu cuối E2EE
      if (/^MAWVault$/i.test(moduleName) || /MAWVault/i.test(moduleName)) {
        if (typeof exportsObj === 'object') {
          if (typeof exportsObj.unvault === 'function') {
            mawUnvaultFn = exportsObj.unvault.bind(exportsObj);
          }
          if (typeof exportsObj.vault === 'function') {
            const origVault = exportsObj.vault;
            exportsObj.vault = function (plainValue) {
              const vaultedToken = origVault.apply(this, arguments);
              try {
                if (typeof plainValue === 'string' && typeof vaultedToken === 'string') {
                  vaultMap.set(vaultedToken, plainValue);
                }
              } catch (_) {}
              return vaultedToken;
            };
          }
        }
        return exportsObj;
      }

      // 2. Các module Stored Procedure của Lightspeed & MAW xử lý tin nhắn
      if (
        /^(LS|MAW).*(InsertMessage|UpsertMessage|DeleteThenInsertMessage|MarkMessageUnsent|HandleUnsendMessage|DeleteMessage|ReplaceOptimisticMessage|Unsend|Revoke|Tombstone)/i.test(
          moduleName
        )
      ) {
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
      }
    } catch (_) {}

    return exportsObj;
  }

  // Thiết lập Hook lên window.__d ngay từ document_start
  let currentDefFunc = window.__d;
  function wrapDefineFn(origD) {
    if (!origD || origD.__fbUnsendWrapped) return origD;
    const wrappedD = function (moduleName, deps, factory, _extra) {
      if (
        typeof moduleName === 'string' &&
        typeof factory === 'function' &&
        (/^(LS|MAW).*(Message|Unsent|Unsend|Vault|Revoke|Tombstone)/i.test(moduleName) ||
          /^MAWVault/i.test(moduleName))
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
  // BỘ PHÂN TÍCH 2: Object từ ReStore, E2EE Worker, IndexedDB & React Fiber
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
      // Nếu object là một instance của ReStore DB (có thuộc tính tables.messages) -> Hook trực tiếp bảng messages!
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
  // BỘ PHÂN TÍCH 3: Quét React Fiber (__reactFiber$) trong vùng khung chat
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
          // Nếu tìm thấy đối tượng ReStore db trong React Context -> Hook ngay bảng messages!
          if (props.value?.tables?.messages) {
            wrapReStoreTable(props.value.tables.messages, 'messages');
          }

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
            const rawText =
              msgObj.text ??
              msgObj.body ??
              msgObj.plaintext ??
              (typeof msgObj.message === 'string' ? msgObj.message : msgObj.message?.text);
            const text = typeof rawText === 'string' ? unvaultString(rawText) : '';
            const isUnsent =
              Boolean(msgObj.isUnsent || msgObj.unsent || msgObj.unsentTimestampMs) ||
              msgObj.messageRenderingType === 2 ||
              (typeof text === 'string' && isUnsendNoticeText(text));

            if (id) {
              return {
                messageId: unvaultString(String(id)),
                text,
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
  // TẦNG HOOK PHỤ TRỢ: WebSocket, IndexedDB & MessagePort
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

    IDBObjectStore.prototype.delete = function (key) {
      try {
        if (key !== undefined && key !== null) {
          const strKey = Array.isArray(key) ? String(key[0]) : String(key);
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
})();
