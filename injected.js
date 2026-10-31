// injected.js - Theo dõi luồng dữ liệu Messenger/Lightspeed/E2EE và React Fiber (MAIN World)

(function () {
  if (window.__FB_UNSEND_INJECTED__) return;
  window.__FB_UNSEND_INJECTED__ = true;

  const MAX_LOG_ENTRIES = 600;
  const mainLogBuffer = [];

  function serializeForLog(val, depth = 0) {
    if (val === null || val === undefined) return val;
    if (typeof val === 'string') {
      if (val.length > 300) {
        return `${val.slice(0, 140)}... [len=${val.length}]`;
      }
      return unvaultString(val);
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
      return val.slice(0, 45).map((item) => serializeForLog(item, depth + 1));
    }
    if (typeof val === 'object') {
      const out = {};
      const keys = Object.keys(val).slice(0, 45);
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
      mainLogBuffer.push({
        t: new Date().toISOString(),
        ms: Date.now(),
        tag,
        data: args.map((a) => serializeForLog(a, 0))
      });
      if (mainLogBuffer.length > MAX_LOG_ENTRIES) {
        mainLogBuffer.splice(0, mainLogBuffer.length - MAX_LOG_ENTRIES);
      }
    } catch (_) {}
  }

  const PAGE_LOAD_TIME = Date.now();
  const INITIAL_SYNC_GRACE_MS = 6000;

  const capturedMessages = new Map();
  const messageMetaMap = new Map();
  const pendingVaultMessages = new Map();
  const aliasIdMap = new Map();
  const processedNodes = new WeakSet();
  const vaultMap = new Map();
  const contactNameMap = new Map();
  const threadNameMap = new Map();
  const seenE2EETexts = new Map();
  let lastE2EEMessageId = null;
  let mawUnvaultFn = null;

  const deepUnsupportedInspector = {
    wsSentFrames: [],
    wsReceivedRawFrames: [],
    graphqlSyncRequests: [],
    graphqlInterestingResponses: [],
    interestingModuleNames: [],
    recentLsProcedureRing: [],
    unsupportedCallSnapshots: [],
    activeProbes: [],
    e2eeRavenExtracted: [],
    moduleSources: {}
  };
  const interestingModuleSet = new Set();
  const capturedModuleExports = new Map();
  const passiveModuleExports = new Map();
  const probedMessageIds = new Set();
  const probedE2EEThreads = new Set();
  const unlockedViewOnceMediaMap = new Map();
  let fbRequireFn = null;
  let fbImportNamespaceFn = null;

  function getFbModule(modName) {
    if (passiveModuleExports.has(modName)) {
      const p = passiveModuleExports.get(modName);
      if (p && (typeof p !== 'object' || Object.keys(p).length > 0)) return p;
    }
    if (capturedModuleExports.has(modName)) {
      const c = capturedModuleExports.get(modName);
      if (c && (typeof c !== 'object' || Object.keys(c).length > 0)) return c;
    }
    const reqCandidates = [
      fbImportNamespaceFn,
      fbRequireFn,
      typeof window.require === 'function' ? window.require : null
    ];
    for (const fn of reqCandidates) {
      if (typeof fn === 'function') {
        try {
          const mod = fn(modName);
          if (mod && (typeof mod !== 'object' || Object.keys(mod).length > 0)) {
            passiveModuleExports.set(modName, mod);
            return mod;
          }
        } catch (_) {}
      }
    }
    return null;
  }

  function bytesToDataUrl(buf, mimeType = 'image/jpeg') {
    try {
      const u8 =
        buf instanceof Uint8Array
          ? buf
          : buf instanceof ArrayBuffer
            ? new Uint8Array(buf)
            : ArrayBuffer.isView(buf)
              ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
              : null;
      if (!u8 || u8.byteLength === 0) return null;
      let bin = '';
      const chunkSize = 8192;
      for (let i = 0; i < u8.byteLength; i += chunkSize) {
        const sub = u8.subarray(i, Math.min(i + chunkSize, u8.byteLength));
        bin += String.fromCharCode.apply(null, sub);
      }
      return `data:${mimeType};base64,${btoa(bin)}`;
    } catch (_) {
      return null;
    }
  }

  function uint8ToBase64(u8) {
    try {
      const maxLen = Math.min(u8.length, 65536);
      let bin = '';
      for (let i = 0; i < maxLen; i++) {
        bin += String.fromCharCode(u8[i]);
      }
      return `[Bytes(${u8.length}):base64:${btoa(bin)}]`;
    } catch (e) {
      return `[Bytes(${u8.length}):err:${String(e)}]`;
    }
  }

  function serializeUntruncated(val, depth = 0) {
    if (val === null || val === undefined) return val;
    if (typeof val === 'string') {
      return val.length > 16000 ? `${val.slice(0, 16000)}... [len=${val.length}]` : unvaultString(val);
    }
    if (typeof val === 'number' || typeof val === 'boolean') return val;
    if (typeof val === 'function') return `[Function: ${val.name || 'anonymous'}]`;
    if (val instanceof ArrayBuffer) {
      return uint8ToBase64(new Uint8Array(val));
    }
    if (ArrayBuffer.isView(val)) {
      return uint8ToBase64(new Uint8Array(val.buffer, val.byteOffset, val.byteLength));
    }
    if (val instanceof Map) {
      const mapOut = {};
      let count = 0;
      for (const [k, v] of val.entries()) {
        if (count++ >= 40) break;
        mapOut[String(k)] = serializeUntruncated(v, depth + 1);
      }
      return { __type: 'Map', size: val.size, entries: mapOut };
    }
    if (val instanceof Set) {
      return { __type: 'Set', size: val.size, values: serializeUntruncated(Array.from(val).slice(0, 40), depth + 1) };
    }
    if (depth >= 7) return Array.isArray(val) ? `[Array(${val.length})]` : '[Object]';
    if (Array.isArray(val)) {
      return val.slice(0, 150).map((item) => serializeUntruncated(item, depth + 1));
    }
    if (typeof val === 'object') {
      const out = {};
      for (const k of Object.keys(val).slice(0, 60)) {
        try {
          out[k] = serializeUntruncated(val[k], depth + 1);
        } catch (_) {}
      }
      return out;
    }
    return String(val);
  }

  async function probeUnsupportedMessageData(info) {
    const { messageId, otid, threadId, senderId } = info || {};
    const probeKey = messageId || otid || 'unknown';
    if (probedMessageIds.has(probeKey)) return;
    probedMessageIds.add(probeKey);

    const probeEntry = {
      t: new Date().toISOString(),
      messageId,
      otid,
      threadId,
      senderId,
      mediaFallbackChecks: [],
      requireModuleInspect: {}
    };
    deepUnsupportedInspector.activeProbes.push(probeEntry);
    if (deepUnsupportedInspector.activeProbes.length > 15) {
      deepUnsupportedInspector.activeProbes.shift();
    }

    try {
      for (const [modName, exp] of capturedModuleExports.entries()) {
        try {
          if (!exp) continue;
          if (typeof exp === 'function') {
            probeEntry.requireModuleInspect[modName] = {
              type: 'function',
              source: Function.prototype.toString.call(exp).slice(0, 4000)
            };
          } else if (typeof exp === 'object') {
            const summary = {};
            for (const k of Object.keys(exp).slice(0, 25)) {
              const v = exp[k];
              summary[k] =
                typeof v === 'function'
                  ? Function.prototype.toString.call(v).slice(0, 2500)
                  : serializeUntruncated(v, 1);
            }
            probeEntry.requireModuleInspect[modName] = {
              type: 'object',
              keys: Object.keys(exp),
              summary
            };
          }
        } catch (_) {}
      }
    } catch (_) {}

    const candidateEntities = [otid, messageId ? messageId.replace(/^mid\.\$/, '') : ''].filter(Boolean);
    const entityTypes = [1, 2, 4, 8];
    for (const entityId of candidateEntities) {
      for (const et of entityTypes) {
        const url = `/messaging/lightspeed/media_fallback/?entity_id=${encodeURIComponent(
          entityId
        )}&entity_type=${et}`;
        try {
          const resp = await window.fetch(url, {
            method: 'GET',
            credentials: 'include'
          });
          const contentType = resp.headers.get('content-type') || '';
          let bodyPreview = '';
          if (/json|text|xml|html/i.test(contentType)) {
            const txt = await resp.text();
            bodyPreview = txt.slice(0, 600);
          }
          probeEntry.mediaFallbackChecks.push({
            url,
            status: resp.status,
            redirected: resp.redirected,
            finalUrl: resp.url,
            contentType,
            bodyPreview
          });
        } catch (err) {
          probeEntry.mediaFallbackChecks.push({
            url,
            error: String(err?.message || err)
          });
        }
      }
    }
  }

  dlog('INIT', '#00a8ff', 'injected.js đã khởi tạo trong MAIN world tại', location.href);

  window.__FB_UNSEND_MAIN_STATE__ = {
    mainLogBuffer,
    capturedMessages,
    messageMetaMap,
    pendingVaultMessages,
    aliasIdMap,
    vaultMap,
    contactNameMap,
    threadNameMap
  };

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

  // ============================================================================
  // 1. CÁC HÀM LỌC VÀ NHẬN DIỆN NỘI DUNG TIN NHẮN
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

  const FB_LIKE_STICKER_IDS = new Set([
    '369239263222822',
    '369239343222814',
    '369239383222810'
  ]);

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
    /^Telegram sticker$/i,
    /^Đang hoạt động$/i,
    /^Hoạt động .* trước$/i
  ];

  function isVaultToken(str) {
    return typeof str === 'string' && (str.startsWith('@@vault') || str.startsWith('vault:'));
  }

  function recordVaultMapping(strA, strB) {
    if (typeof strA !== 'string' || typeof strB !== 'string' || strA === strB) return;

    let vaultedToken = '';
    let plainText = '';
    if (isVaultToken(strA) && !isVaultToken(strB) && strB.length > 0) {
      vaultedToken = strA;
      plainText = strB;
    } else if (isVaultToken(strB) && !isVaultToken(strA) && strA.length > 0) {
      vaultedToken = strB;
      plainText = strA;
    } else {
      return;
    }

    vaultMap.set(vaultedToken, plainText);

    if (pendingVaultMessages.has(vaultedToken)) {
      const pendingList = pendingVaultMessages.get(vaultedToken);
      pendingVaultMessages.delete(vaultedToken);
      for (const pendingMsg of pendingList) {
        dlog('VAULT-RESOLVED', '#00cec9', 'Đã giải mã tin nhắn chờ từ MAWVault:', {
          vaultedToken,
          plainText,
          messageId: pendingMsg.messageId
        });
        registerCapturedMessage({
          ...pendingMsg,
          text: plainText
        });
      }
    }
  }

  function unvaultString(str) {
    if (!str || typeof str !== 'string') return str;
    if (!isVaultToken(str)) return str;
    if (vaultMap.has(str)) {
      return vaultMap.get(str);
    }
    if (mawUnvaultFn) {
      try {
        const res = mawUnvaultFn(str);
        if (typeof res === 'string' && res !== str && !isVaultToken(res)) {
          recordVaultMapping(str, res);
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

  function extractNameFromNoticeText(noticeText) {
    if (!noticeText || typeof noticeText !== 'string') return '';
    const realStr = unvaultString(noticeText).trim();
    const beforeColon = realStr.split(':')[0] || realStr;
    const cleaned = beforeColon
      .replace(
        /\s*(đã xóa một tin nhắn|đã xoá một tin nhắn|đã thu hồi một tin nhắn|đã gỡ một tin nhắn|unsent a message|deleted a message|removed a message).*$/i,
        ''
      )
      .trim();
    if (
      cleaned &&
      cleaned.length >= 1 &&
      cleaned.length < 60 &&
      !/^(bạn|you|tin nhắn|message)$/i.test(cleaned)
    ) {
      return cleaned;
    }
    return '';
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
      (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
      trimmed.includes('":[') ||
      trimmed.includes('"],[') ||
      trimmed.includes('[19,"') ||
      trimmed.includes('[9],[9]') ||
      trimmed.includes('\\"') ||
      trimmed.includes('verifyContactRowExists') ||
      trimmed.includes('executeFinallyBlockForSyncTransaction') ||
      trimmed.includes('set_pinned_message_search')
    ) {
      return true;
    }

    if (
      trimmed.startsWith('@@vault') ||
      trimmed.startsWith('mid.$') ||
      trimmed.startsWith('unsupportedmid.$') ||
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
      /^(audioclip|videoclip|voiceclip|audio_clip|video_clip|image|video|audio|file|sticker|gif|attachment)[_-][0-9a-f_-]+(\.[a-z0-9]+)?$/i.test(
        trimmed
      )
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
        /^(true|false|null|undefined|none|pending|sent|delivered|read|optimistic|success|error|unavailable|unsupported|full)$/i.test(
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
    if (
      /^https?:\/\/([a-z0-9-]+\.)*(scontent[a-z0-9-]*|video[a-z0-9-]*|fbcdn\.net|cdn\.fbsbx\.com|lookaside)/i.test(
        trimmed
      )
    ) {
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
    if (!ts || typeof ts !== 'number') return true;
    if (ts < 1577836800000 || ts > 2051222400000) return true;
    return ts < PAGE_LOAD_TIME - 15 * 1000;
  }

  function resolveContactAndThreadName(senderId, threadId, explicitSenderName = '', explicitThreadName = '') {
    const cleanSenderId = senderId ? String(senderId).trim() : '';
    const cleanThreadId = threadId ? String(threadId).trim() : '';

    const mappedContact = cleanSenderId ? contactNameMap.get(cleanSenderId) || '' : '';
    const mappedThread = cleanThreadId ? threadNameMap.get(cleanThreadId) || '' : '';

    const finalPersonName = explicitSenderName || mappedContact || '';
    const finalThreadName = explicitThreadName || mappedThread || '';

    let combinedName = '';
    if (finalPersonName && finalThreadName) {
      if (
        finalPersonName.toLowerCase() === finalThreadName.toLowerCase() ||
        finalThreadName.toLowerCase().includes(finalPersonName.toLowerCase())
      ) {
        combinedName = finalThreadName;
      } else {
        combinedName = `${finalPersonName} • ${finalThreadName}`;
      }
    } else {
      combinedName = finalPersonName || finalThreadName || '';
    }

    return {
      senderName: combinedName,
      personName: finalPersonName,
      threadName: finalThreadName
    };
  }

  function registerCapturedMessage(msgData) {
    let {
      messageId,
      altIds,
      text,
      senderId,
      threadId,
      senderName,
      threadName,
      attachments,
      timestamp,
      source
    } = msgData;
    if (!messageId) return;
    if (isOldHistoricalTimestamp(timestamp)) return;

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

    if (unvaultedText && isVaultToken(unvaultedText)) {
      const list = pendingVaultMessages.get(unvaultedText) || [];
      list.push({
        ...msgData,
        messageId
      });
      pendingVaultMessages.set(unvaultedText, list);
      dlog('VAULT-PENDING', '#fdcb6e', 'Tin nhắn đang giữ token @@vault, đưa vào hàng đợi giải mã:', {
        messageId,
        vaultToken: unvaultedText,
        source
      });
      return;
    }

    if (unvaultedText && isUnsendNoticeText(unvaultedText)) {
      triggerMessageUnsent(messageId, {
        senderId,
        threadId,
        senderName,
        threadName,
        unsendNotice: unvaultedText,
        source
      });
      return;
    }

    const cleanText =
      unvaultedText &&
      !isTechnicalString(unvaultedText) &&
      !isUnsendNoticeText(unvaultedText)
        ? unvaultedText.trim()
        : '';
    const cleanAttachments = Array.isArray(attachments)
      ? attachments.map(unvaultString).filter((u) => u && !isVaultToken(u))
      : [];

    const existing = capturedMessages.get(messageId);
    if (!cleanText && cleanAttachments.length === 0) return;

    const isAuthoritativeModule =
      typeof source === 'string' && /^module:LS(Upsert|DeleteThenInsert|Insert)Message/i.test(source);
    const finalText =
      isAuthoritativeModule && cleanText
        ? cleanText
        : existing?.text
          ? existing.text
          : cleanText;
    const mergedAttachments = [...(existing?.attachments || [])];
    for (const url of cleanAttachments) {
      if (!mergedAttachments.includes(url)) {
        mergedAttachments.push(url);
      }
    }

    const finalSenderId = senderId || existing?.senderId || '';
    const finalThreadId = threadId || existing?.threadId || '';
    const resolvedNames = resolveContactAndThreadName(
      finalSenderId,
      finalThreadId,
      senderName || existing?.personName || '',
      threadName || existing?.threadName || ''
    );

    const isActuallyNew =
      !existing ||
      (!existing.text && finalText) ||
      (isAuthoritativeModule && cleanText && existing.text !== finalText) ||
      mergedAttachments.length > (existing.attachments?.length || 0);

    const updatedRecord = {
      messageId,
      text: finalText,
      senderId: finalSenderId,
      threadId: finalThreadId,
      senderName: resolvedNames.senderName || existing?.senderName || '',
      personName: resolvedNames.personName || existing?.personName || '',
      threadName: resolvedNames.threadName || existing?.threadName || '',
      attachments: mergedAttachments,
      timestamp: existing?.timestamp || timestamp || Date.now(),
      capturedAt: existing?.capturedAt || Date.now(),
      source: source || existing?.source || 'internal',
      isUnsent: existing?.isUnsent || false
    };

    capturedMessages.set(messageId, updatedRecord);

    if (isActuallyNew) {
      dlog('CAPTURED', '#4cd137', {
        messageId,
        text: finalText,
        personName: updatedRecord.personName,
        threadName: updatedRecord.threadName,
        source: updatedRecord.source
      });
      emitToContentScript('FB_MSG_CAPTURED', updatedRecord);
    }
  }

  function triggerMessageUnsent(rawMessageId, extraInfo = {}) {
    const messageId = resolveCanonicalMessageId(rawMessageId);
    if (!messageId) return;

    const existing = capturedMessages.get(messageId);
    const noticeSenderName = extractNameFromNoticeText(extraInfo.unsendNotice || '');

    const finalSenderId = extraInfo.senderId || existing?.senderId || '';
    const finalThreadId = extraInfo.threadId || existing?.threadId || '';
    const resolvedNames = resolveContactAndThreadName(
      finalSenderId,
      finalThreadId,
      extraInfo.senderName || noticeSenderName || existing?.personName || '',
      extraInfo.threadName || existing?.threadName || ''
    );

    if (existing?.isUnsent) {
      const hasNewNotice = Boolean(extraInfo.unsendNotice && !existing.unsendNotice);
      const hasNewPerson = Boolean(resolvedNames.personName && !existing.personName);
      const hasNewThread = Boolean(resolvedNames.threadName && !existing.threadName);
      const hasNewSenderId = Boolean(finalSenderId && !existing.senderId);
      const hasNewThreadId = Boolean(finalThreadId && !existing.threadId);
      if (!hasNewNotice && !hasNewPerson && !hasNewThread && !hasNewSenderId && !hasNewThreadId) {
        return;
      }
    }

    if (!existing || (!existing.text && (!existing.attachments || existing.attachments.length === 0))) {
      dlog('UNSENT-SIGNAL-ONLY', '#fbc531', 'Phát hiện lệnh gỡ nhưng MAIN chưa có text, chuyển tín hiệu sang CONTENT:', {
        rawMessageId,
        resolvedId: messageId,
        extraInfo,
        resolvedNames
      });
      emitToContentScript('FB_MSG_UNSENT', {
        messageId,
        rawMessageId: String(rawMessageId || ''),
        senderId: finalSenderId,
        threadId: finalThreadId,
        senderName: resolvedNames.senderName || '',
        personName: resolvedNames.personName || '',
        threadName: resolvedNames.threadName || '',
        unsendNotice: extraInfo.unsendNotice || '',
        unsentAt: existing?.unsentAt || Date.now(),
        source: extraInfo.source || 'internal',
        isUnsent: true,
        isSignalOnly: true
      });
      return;
    }

    const record = {
      ...existing,
      senderId: finalSenderId,
      threadId: finalThreadId,
      senderName: resolvedNames.senderName || existing.senderName || '',
      personName: resolvedNames.personName || existing.personName || '',
      threadName: resolvedNames.threadName || existing.threadName || '',
      unsendNotice: extraInfo.unsendNotice || existing.unsendNotice || '',
      unsentAt: existing.unsentAt || Date.now(),
      source: extraInfo.source || existing.source || 'internal',
      isUnsent: true
    };

    capturedMessages.set(messageId, record);

    dlog('UNSENT-HIT', '#e84118', 'Bắt được sự kiện gỡ tin nhắn từ MAIN world:', record);
    emitToContentScript('FB_MSG_UNSENT', record);
  }

  // ============================================================================
  // 2. BẮT TRỰC TIẾP VĂN BẢN E2EE TỪ BỘ GIẢI MÃ MAWVault (Qua TextDecoder.decode)
  // ============================================================================
  TextDecoder.prototype.decode = function (input, options) {
    const result = origTextDecoderDecode.apply(this, arguments);
    try {
      if (typeof result === 'string' && result.length > 0 && result.length <= 2000) {
        const trimmed = result.trim();
        if (trimmed.length > 0) {
          if (isUnsendNoticeText(trimmed)) {
            return result;
          }

          if (!isTechnicalString(trimmed)) {
            const stack = new Error().stack || '';
            if (stack.includes('Array.reduce')) {
              const now = Date.now();
              if (now - PAGE_LOAD_TIME <= INITIAL_SYNC_GRACE_MS) {
                if (!seenE2EETexts.has(trimmed)) {
                  seenE2EETexts.set(trimmed, { id: `e2ee_init_${seenE2EETexts.size}`, time: now });
                }
              } else {
                const prevEntry = seenE2EETexts.get(trimmed);
                if (!prevEntry || now - prevEntry.time > 1500) {
                  const e2eeMsgId = `e2ee_${now}_${Math.random().toString(36).slice(2, 6)}`;
                  seenE2EETexts.set(trimmed, { id: e2eeMsgId, time: now });
                  lastE2EEMessageId = e2eeMsgId;

                  queueMicrotask(() => {
                    registerCapturedMessage({
                      messageId: e2eeMsgId,
                      altIds: [],
                      text: trimmed,
                      senderId: '',
                      threadId: '',
                      attachments: [],
                      timestamp: now,
                      source: 'MAWVault-E2EE'
                    });
                  });
                } else if (prevEntry.id && capturedMessages.has(prevEntry.id)) {
                  lastE2EEMessageId = prevEntry.id;
                }
              }
            }
          }
        }
      }
    } catch (_) {}
    return result;
  };

  // ============================================================================
  // 3. XỬ LÝ CHÍNH XÁC CÁC HÀM NỘI BỘ FACEBOOK (LSUpsertMessage, LSDeleteThenInsertMessage...)
  // ============================================================================
  function inspectInternalProcedureCall(moduleName, args, returnValue) {
    if (!args) return;
    if (/InsertNewMessageRange/i.test(moduleName)) return;

    if (/^(LSVerifyContactRowExists|LSUpdateOrInsertContact|LSUpsertContact)(\.|$)/i.test(moduleName)) {
      const contactId = parseLSInt64(args[0]);
      if (contactId && contactId !== '0') {
        for (let i = 1; i < Math.min(args.length, 10); i++) {
          if (typeof args[i] === 'string') {
            const candidate = unvaultString(args[i]).trim();
            if (
              candidate.length >= 2 &&
              candidate.length <= 80 &&
              !candidate.startsWith('http') &&
              !isTechnicalString(candidate)
            ) {
              contactNameMap.set(contactId, candidate);
              break;
            }
          }
        }
      }
      return;
    }

    if (/^(LSUpdateOrInsertThread|LSVerifyHybridThreadExists|LSUpsertThread)(\.|$)/i.test(moduleName)) {
      let threadId = '';
      let threadName = '';
      for (let i = 0; i < Math.min(args.length, 16); i++) {
        if (!threadId && Array.isArray(args[i]) && args[i].length === 2) {
          const idStr = parseLSInt64(args[i]);
          const num = Number(idStr);
          if (idStr && idStr.length >= 6 && !(num > 1577836800000 && num < 2051222400000)) {
            threadId = idStr;
          }
        } else if (!threadName && typeof args[i] === 'string') {
          const candidate = unvaultString(args[i]).trim();
          if (
            candidate.length >= 2 &&
            candidate.length <= 100 &&
            !candidate.startsWith('http') &&
            !/^(inbox|pending|other|archived|spam)$/i.test(candidate) &&
            !isTechnicalString(candidate) &&
            !isUnsendNoticeText(candidate)
          ) {
            threadName = candidate;
          }
        }
      }
      if (threadId && threadName) {
        threadNameMap.set(threadId, threadName);
      }
      return;
    }

    const isNoisyDeleteRequest =
      /^LSDeleteMessageRequest(\.|$)/i.test(moduleName) &&
      !args.some((a) => typeof a === 'string' && unvaultString(a).includes('mid.$'));
    if (!isNoisyDeleteRequest) {
      dlog('PROC', '#9c88ff', moduleName, { args, returnValue });
    }

    if (/^MpsRavenToBridge\.(processRavenAttachment|ravenToBridge)$/i.test(moduleName)) {
      try {
        const arg0 = args[0];
        const msgWrapper = arg0?.message || arg0;
        const suppMap = arg0?.supplementalMessages || null;
        const ravenInfo = decodeRavenFromProtobufWrapper(msgWrapper, suppMap);
        if (ravenInfo) {
          deepUnsupportedInspector.e2eeRavenExtracted.push({
            t: new Date().toISOString(),
            source: moduleName,
            ravenInfo
          });
          if (deepUnsupportedInspector.e2eeRavenExtracted.length > 20) {
            deepUnsupportedInspector.e2eeRavenExtracted.shift();
          }
        }
      } catch (_) {}
    }

    if (
      /^(LSUpsertMessage|LSDeleteThenInsertMessage|LSInsertMessage|LSReplaceOptimisticMessage)(\.|$)/i.test(
        moduleName
      ) &&
      args.length >= 10
    ) {
      const rawText = typeof args[0] === 'string' ? unvaultString(args[0]) : undefined;
      const msgId = typeof args[8] === 'string' ? unvaultString(args[8]).trim() : '';
      const otid = typeof args[9] === 'string' ? unvaultString(args[9]).trim() : '';

      if (msgId) {
        let validTimestamps = [];
        let validIds = [];
        for (let i = 1; i <= Math.min(16, args.length - 1); i++) {
          if (Array.isArray(args[i]) && args[i].length === 2) {
            const strVal = parseLSInt64(args[i]);
            if (strVal) {
              const numVal = Number(strVal);
              if (numVal > 1577836800000 && numVal < 2051222400000) {
                validTimestamps.push(numVal);
              } else if (strVal.length >= 6 && strVal !== '0') {
                validIds.push(strVal);
              }
            }
          }
        }

        const timestamp = validTimestamps.length > 0 ? Math.min(...validTimestamps) : null;
        const explicitThreadId = parseLSInt64(args[3]);
        const explicitSenderId = parseLSInt64(args[10]);
        const threadId = explicitThreadId || validIds[0] || '';
        const senderId = explicitSenderId || validIds[1] || validIds[0] || '';

        const resolvedId = resolveCanonicalMessageId(msgId);
        if (otid && otid !== resolvedId) {
          aliasIdMap.set(otid, resolvedId);
        }

        if (timestamp && !isOldHistoricalTimestamp(timestamp)) {
          const prevMeta = messageMetaMap.get(resolvedId);
          messageMetaMap.set(resolvedId, {
            messageId: resolvedId,
            altIds: [msgId, otid, ...(prevMeta?.altIds || [])].filter(Boolean),
            senderId: senderId || prevMeta?.senderId || '',
            threadId: threadId || prevMeta?.threadId || '',
            timestamp: prevMeta?.timestamp ? Math.min(prevMeta.timestamp, timestamp) : timestamp
          });
        }

        const existingRec = capturedMessages.get(resolvedId);
        const isClearedByDeleteThenInsert =
          /^LSDeleteThenInsertMessage(\.|$)/i.test(moduleName) &&
          (rawText === undefined || rawText === null || rawText.trim() === '') &&
          Boolean(existingRec && (existingRec.text || existingRec.attachments?.length));

        const isUnsent = Boolean(
          (rawText && isUnsendNoticeText(rawText)) || isClearedByDeleteThenInsert
        );

        if (isUnsent) {
          triggerMessageUnsent(resolvedId, {
            threadId,
            senderId,
            unsendNotice: rawText || '',
            source: `module:${moduleName}`
          });
          return;
        }

        if (timestamp && !isOldHistoricalTimestamp(timestamp)) {
          if (rawText && (isVaultToken(rawText) || !isTechnicalString(rawText))) {
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
            return;
          }
        }
      }
    }

    let msgIds = [];
    let altIds = [];
    let texts = [];
    let mediaUrls = [];
    let timestamps = [];
    let candidateIds = [];
    let unsendNoticeStr = '';
    let hasUnsendNotice = false;

    const allItems = [...args];
    if (returnValue !== undefined && returnValue !== null) {
      allItems.push(returnValue);
    }

    for (let i = 0; i < allItems.length; i++) {
      const arg = allItems[i];
      if (arg === null || arg === undefined) {
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
        } else if (FB_LIKE_STICKER_IDS.has(unvaulted)) {
          texts.push('👍');
        } else if (/^\d{15,22}$/.test(unvaulted)) {
          altIds.push(unvaulted);
        } else if (isUnsendNoticeText(unvaulted)) {
          hasUnsendNotice = true;
          unsendNoticeStr = unvaulted;
        } else {
          const mUrl = extractMediaUrl(unvaulted);
          if (mUrl) {
            mediaUrls.push(mUrl);
          } else if (isVaultToken(unvaulted) || !isTechnicalString(unvaulted)) {
            texts.push(unvaulted);
          }
        }
      } else if (typeof arg === 'object') {
        const i64Str = parseLSInt64(arg);
        if (i64Str) {
          const num = Number(i64Str);
          if (FB_LIKE_STICKER_IDS.has(i64Str)) {
            texts.push('👍');
          } else if (num > 1577836800000 && num < 2051222400000) {
            timestamps.push(num);
          } else if (i64Str.length >= 6 && i64Str !== '0') {
            candidateIds.push(i64Str);
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
      const savedMeta = messageMetaMap.get(resolvedId);
      const rawBestTimestamp = timestamps.length > 0 ? Math.min(...timestamps) : null;
      const bestTimestamp = rawBestTimestamp || savedMeta?.timestamp || null;
      const fallbackThreadId = savedMeta?.threadId || candidateIds[0] || '';
      const fallbackSenderId = savedMeta?.senderId || candidateIds[1] || candidateIds[0] || '';

      const isUnsendProcedure =
        /^(LSMarkMessageUnsent|LSHandleUnsendMessage|LSDeleteMessage|LSDeleteMessageRequest|LSUpdateUnsentMessage.*|LSRetractMessage|LSRecallMessage|MAW.*Unsend.*|MAW.*Delete.*Message.*)(\.|$)/i.test(
          moduleName
        );

      if (isUnsendProcedure || hasUnsendNotice) {
        triggerMessageUnsent(resolvedId, {
          threadId: fallbackThreadId,
          senderId: fallbackSenderId,
          unsendNotice: unsendNoticeStr,
          source: `module:${moduleName}`
        });
      } else if (texts.length > 0 || mediaUrls.length > 0) {
        if (!bestTimestamp || isOldHistoricalTimestamp(bestTimestamp)) return;
        const isXmaOrAttachmentMod = /Xma|Attachment/i.test(moduleName);
        const uniqueTexts = Array.from(new Set(texts.map((t) => t.trim()).filter(Boolean)));
        const isUnsupportedAttachmentPacket =
          isXmaOrAttachmentMod &&
          (args.some(
            (a) =>
              typeof a === 'string' &&
              (a === 'unavailable' || a.startsWith('unsupportedmid.$'))
          ) ||
            uniqueTexts.some((t) =>
              /File đính kèm không được hỗ trợ|Unsupported attachment|Tin nhắn không hiển thị|Tin nhắn này không hiển thị trên ứng dụng này/i.test(
                t
              )
            ));
        let combinedText = '';
        if (isUnsupportedAttachmentPacket && mediaUrls.length === 0) {
          const detailParts = uniqueTexts.filter(
            (t) => !/^Tin nhắn không hiển thị$/i.test(t)
          );
          const bodyText =
            detailParts.length > 0
              ? detailParts.slice(0, 2).join(' — ')
              : 'File đính kèm không được hỗ trợ — Tin nhắn này không hiển thị trên ứng dụng này';
          combinedText = bodyText.startsWith('⚠️') ? bodyText : `⚠️ ${bodyText}`;
          const candidateOtid =
            [...altIds, ...(savedMeta?.altIds || [])].find((id) => /^\d{15,22}$/.test(id)) || '';
          probeUnsupportedMessageData({
            messageId: resolvedId,
            otid: candidateOtid,
            threadId: fallbackThreadId,
            senderId: fallbackSenderId
          });
        } else {
          combinedText =
            isXmaOrAttachmentMod && uniqueTexts.length > 1
              ? uniqueTexts.slice(0, 3).join(' — ')
              : uniqueTexts[0] || '';
        }
        registerCapturedMessage({
          messageId: primaryId,
          altIds: [...msgIds, ...altIds, ...(savedMeta?.altIds || [])],
          text: combinedText,
          senderId: fallbackSenderId,
          threadId: fallbackThreadId,
          attachments: mediaUrls,
          timestamp: bestTimestamp,
          source: `module:${moduleName}`
        });
      }
    }
  }

  const hookedTables = new WeakSet();
  function wrapReStoreTable(tableObj, tableName) {
    if (!tableObj || typeof tableObj !== 'object' || hookedTables.has(tableObj)) return;
    hookedTables.add(tableObj);
    dlog('HOOK-RESTORE', '#00cec9', `Đã hook bảng ReStore.${tableName}`);

    const writeMethods = ['put', 'upsert', 'add', 'replace', 'delete'];
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

  function safeWrapFunction(origFn, label, isUnvaultModule = false) {
    if (typeof origFn !== 'function' || origFn.__fbSafeWrapped) return origFn;
    if (origFn.prototype && Object.getOwnPropertyNames(origFn.prototype).length > 1) {
      return origFn;
    }

    try {
      if (
        /Attachment|Ephemeral|ViewOnce|Unsupported|LightspeedRequest|SyncParams|Capabilit/i.test(
          label
        ) &&
        !deepUnsupportedInspector.moduleSources[label]
      ) {
        deepUnsupportedInspector.moduleSources[label] = Function.prototype.toString
          .call(origFn)
          .slice(0, 5000);
      }
    } catch (_) {}

    const wrapped = function () {
      const args = Array.from(arguments);
      const ret = origFn.apply(this, arguments);
      try {
        if (isUnvaultModule) {
          if (typeof args[0] === 'string' && typeof ret === 'string') {
            recordVaultMapping(args[0], ret);
          }
        } else {
          deepUnsupportedInspector.recentLsProcedureRing.push({
            t: Date.now(),
            mod: label,
            args: serializeUntruncated(args, 0)
          });
          if (deepUnsupportedInspector.recentLsProcedureRing.length > 80) {
            deepUnsupportedInspector.recentLsProcedureRing.shift();
          }

          const hasUnsupportedMarker = args.some(
            (a) =>
              typeof a === 'string' &&
              (a === 'unavailable' ||
                a.startsWith('unsupportedmid.$') ||
                /File đính kèm không được hỗ trợ|Tin nhắn không hiển thị/i.test(a))
          );
          if (hasUnsupportedMarker || /^LSInsertAttachment(\.|$)/i.test(label)) {
            const stackStr = new Error().stack || '';
            deepUnsupportedInspector.unsupportedCallSnapshots.push({
              t: new Date().toISOString(),
              mod: label,
              fullArgs: serializeUntruncated(args, 0),
              returnValue: serializeUntruncated(ret, 0),
              stack: stackStr,
              fnSource: Function.prototype.toString.call(origFn).slice(0, 5000),
              precedingLsCalls: deepUnsupportedInspector.recentLsProcedureRing.slice(-35)
            });
            if (deepUnsupportedInspector.unsupportedCallSnapshots.length > 15) {
              deepUnsupportedInspector.unsupportedCallSnapshots.shift();
            }
          }

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
      Object.defineProperty(wrapped, 'length', {
        value: origFn.length,
        configurable: true
      });
      if (origFn.name) {
        Object.defineProperty(wrapped, 'name', {
          value: origFn.name,
          configurable: true
        });
      }
      Object.defineProperty(wrapped, 'toString', {
        value: function () {
          return Function.prototype.toString.call(origFn);
        },
        configurable: true
      });
      Object.defineProperty(wrapped, '__fbSafeWrapped', { value: true });
    } catch (_) {}

    return wrapped;
  }

  function instrumentFacebookModule(moduleName, exportsObj) {
    if (!exportsObj) return exportsObj;

    try {
      capturedModuleExports.set(moduleName, exportsObj);
      const isUnvaultMod = /^MAW(Vault|UnvaultTransform)$/i.test(moduleName);

      if (typeof exportsObj === 'function') {
        if (/^MAWUnvaultTransform$/i.test(moduleName) && !mawUnvaultFn) {
          mawUnvaultFn = exportsObj;
        }
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

  const SAFE_TARGET_MODULE_REGEX =
    /^(LS(UpsertMessage|DeleteThenInsertMessage|InsertMessage|ReplaceOptimisticMessage|DeleteMessage|DeleteMessageRequest|MarkMessageUnsent|HandleUnsendMessage|UpdateMessage|InsertBlobAttachment|InsertAttachment|InsertXmaAttachment|InsertStickerAttachment|VerifyContactRowExists|UpdateOrInsertContact|UpsertContact|UpdateOrInsertThread|VerifyHybridThreadExists|UpsertThread)|MAW(UnvaultTransform|Vault|ThreadSnippetFor.*Msg|BridgeBuildThreadSnippet)|MpsRavenToBridge)$/i;

  const PASSIVE_EXPORT_CAPTURE_REGEX =
    /^(Mps(OverBridge|RavenToBridge|MediaToBridge|MessageToBridge|MessageToBridgeWrapper|MessageToLoadResponse|ToBridgeMessageId|Types|LoadMessagesStep|ReactionSupplementals)|MAW(ProtobufDeserializers|AttachmentBlob\.react|GetAttachmentThumbnailBlob|DbMedia|MediaDownloadStatusBackendFetcher|DownloadMediaInWorker|DownloadMediaInWorkerDeferred|BridgeNewMsgHandler|BridgeNewMediaHandler|BridgeBuildMsg|BridgeSendAndReceive|MediaManagerUtils|MediaUtils)|WAMediaTransport\.pb|WAArmadilloApplication\.pb|WAConsumerApplication\.pb|WAHashUtils|WAByteArray|decodeProtobuf|LSDatabaseSingleton|ReQL)$/i;

  const INTERESTING_MODULE_NAME_REGEX =
    /^Mps[A-Z]|Attachment|Ephemeral|ViewOnce|Unsupported|MediaFallback|LightspeedRequest|LSPlatform|SyncParams|LSVersion|Capabilit|Xma|Raven|MAWDbMedia|MAWMedia|MAWBridge|WAMedia|WAArmadillo/i;

  const SOURCE_CAPTURE_MODULE_REGEX =
    /^Mps[A-Z]|Raven|ViewOnce|LSPlatformMessengerSyncParams|LSVersion|MAWSecure.*Attachment|MAWAttachmentBlob|MAWGetAttachmentThumbnailBlob|MAWThreadViewAttachmentStateHandlerContent|MAWMediaTransportUtils|MAWMediaManagerUtils|MAWMediaUtils|WAMediaTransport\.pb|WAArmadilloApplication\.pb|MAWBridgeBuildMsg|MAWBridgeMsg|MAWBridgeNewMsgHandler|MAWBridgeNewMediaHandler|MAWDbMedia|MAWMediaDownload|MAWDownload|MAWProtobufDeserializers|MpsUnsupported|MpsEphemeral|MAWEphemeral|EphemeralMediaViewMode|mwpIsMessageUnsupported|MWV2UnsupportedAttachment|MWV2ChatUnsupportedMessage|MWMustacheUnsupportedMediaAttachment|LSComputeParticipantCapabilities|LSComputeOptimisticThreadCapabilities|LSIssueThreadCapabilitySyncTask|LSWriteThreadCapabilities|MAWUpdateLSThreadCapabilities|MWLSThreadCapabilities|LSPlatformMessengerConfig|LSPlatformHardcodedInitSync|LSPlatformGraphQLLightspeedRequest|LSMediaUrlAttachment/i;

  function applyUnlockedViewOnceMedia(msgId, mediaUrls, meta = {}) {
    if (!msgId || !Array.isArray(mediaUrls) || mediaUrls.length === 0) return;
    const validUrls = mediaUrls.filter((u) => typeof u === 'string' && u.length > 0);
    if (validUrls.length === 0) return;

    unlockedViewOnceMediaMap.set(msgId, validUrls);

    const labelText = meta.mediaType === 'video' ? '① Video (Xem 1 lần)' : '① Ảnh (Xem 1 lần)';
    registerCapturedMessage({
      messageId: msgId,
      altIds: [msgId],
      text: labelText,
      senderId: meta.senderId || '',
      threadId: meta.threadId || '',
      attachments: validUrls,
      timestamp: meta.timestamp || Date.now(),
      source: 'E2EE-ViewOnce-Raven'
    });

    if (document.body) {
      let domUpdated = false;
      const rows = document.querySelectorAll('div[data-scope="messages_table"]');
      rows.forEach((rowEl) => {
        const rId =
          rowEl.dataset.fbMsgId ||
          rowEl.dataset.messageId ||
          findFiberMessageIdForRow(rowEl) ||
          '';
        if (rId === msgId) {
          rowEl.dataset.fbMsgId = msgId;
          rowEl.dataset.fbViewOnceRow = 'true';
          rowEl.dataset.fbFiberMedia = JSON.stringify(validUrls);
          domUpdated = true;
        }
      });
      if (domUpdated) {
        emitToContentScript('FB_FIBER_UPDATED', { updatedCount: 1, msgId });
      }
    }
  }

  async function decryptWhatsAppMediaFromTransport(
    integralObj,
    mediaType = 'image',
    mimeType = 'image/jpeg'
  ) {
    try {
      const directPath = integralObj?.directPath;
      const rawKey = integralObj?.mediaKey;
      if (!directPath || !rawKey || !window.crypto?.subtle) return null;

      const mediaKey =
        rawKey instanceof Uint8Array
          ? rawKey
          : rawKey instanceof ArrayBuffer
            ? new Uint8Array(rawKey)
            : ArrayBuffer.isView(rawKey)
              ? new Uint8Array(rawKey.buffer, rawKey.byteOffset, rawKey.byteLength)
              : null;
      if (!mediaKey || mediaKey.byteLength !== 32) return null;

      const infoStr =
        mediaType === 'video'
          ? 'WhatsApp Video Keys'
          : mediaType === 'audio'
            ? 'WhatsApp Audio Keys'
            : 'WhatsApp Image Keys';

      const baseKey = await window.crypto.subtle.importKey('raw', mediaKey, 'HKDF', false, [
        'deriveBits'
      ]);
      const derivedBits = await window.crypto.subtle.deriveBits(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: new Uint8Array(32),
          info: new TextEncoder().encode(infoStr)
        },
        baseKey,
        112 * 8
      );
      const derived = new Uint8Array(derivedBits);
      const iv = derived.slice(0, 16);
      const cipherKeyBytes = derived.slice(16, 48);

      const aesKey = await window.crypto.subtle.importKey(
        'raw',
        cipherKeyBytes,
        { name: 'AES-CBC' },
        false,
        ['decrypt']
      );

      const urlCandidates = directPath.startsWith('http')
        ? [directPath]
        : [
            `https://mmg.whatsapp.net${directPath}`,
            `https://scontent.xx.fbcdn.net${directPath}`,
            `https://rupload.facebook.com${directPath}`
          ];

      for (const cdnUrl of urlCandidates) {
        try {
          const resp = await window.fetch(cdnUrl, { credentials: 'omit' });
          if (!resp.ok) continue;
          const encBuf = await resp.arrayBuffer();
          if (!encBuf || encBuf.byteLength <= 16) continue;

          const sliceCandidates = [
            encBuf.byteLength > 10 ? encBuf.slice(0, encBuf.byteLength - 10) : null,
            encBuf
          ].filter(Boolean);

          for (const cipherBuf of sliceCandidates) {
            try {
              const plainBuf = await window.crypto.subtle.decrypt(
                { name: 'AES-CBC', iv },
                aesKey,
                cipherBuf
              );
              if (plainBuf && plainBuf.byteLength > 0) {
                return bytesToDataUrl(plainBuf, mimeType);
              }
            } catch (_) {}
          }
        } catch (_) {}
      }
    } catch (_) {}
    return null;
  }

  async function resolveFullViewOnceMedia(
    fullMsgId,
    tIntegral,
    tAncillary,
    thumbObj,
    isVideo,
    meta
  ) {
    try {
      const mimeType = tAncillary?.mimetype || (isVideo ? 'video/mp4' : 'image/jpeg');
      const mediaType = isVideo ? 'video' : 'image';

      const bridgeSendMod = getFbModule('MAWBridgeSendAndReceive');
      const hashUtilsMod = getFbModule('WAHashUtils');
      if (
        tIntegral?.fileSha256 &&
        bridgeSendMod?.sendAndReceive &&
        hashUtilsMod?.toPlaintextHash
      ) {
        try {
          const ptHash = hashUtilsMod.toPlaintextHash(tIntegral.fileSha256);
          if (ptHash) {
            const blobRes = await bridgeSendMod.sendAndReceive(
              'backend',
              'getBlobDataUrlByPlaintextHash',
              { description: 'view_once_unlock', plaintextHash: ptHash }
            );
            if (blobRes instanceof Blob && blobRes.size > 0) {
              const arrBuf = await blobRes.arrayBuffer();
              const dataUrl = bytesToDataUrl(arrBuf, blobRes.type || mimeType);
              if (dataUrl) {
                applyUnlockedViewOnceMedia(fullMsgId, [dataUrl], meta);
                return;
              }
            } else if (typeof blobRes === 'string' && blobRes.length > 0) {
              applyUnlockedViewOnceMedia(fullMsgId, [blobRes], meta);
              return;
            }
          }
        } catch (_) {}
      }

      const fullDataUrl = await decryptWhatsAppMediaFromTransport(tIntegral, mediaType, mimeType);
      if (fullDataUrl) {
        applyUnlockedViewOnceMedia(fullMsgId, [fullDataUrl], meta);
        return;
      }

      if (thumbObj?.downloadableThumbnail) {
        const dlThumbUrl = await decryptWhatsAppMediaFromTransport(
          thumbObj.downloadableThumbnail,
          'image',
          'image/jpeg'
        );
        if (dlThumbUrl) {
          applyUnlockedViewOnceMedia(fullMsgId, [dlThumbUrl], meta);
        }
      }
    } catch (_) {}
  }

  function decodeRavenFromProtobufWrapper(msgWrapper, supplementalMessages, rawMsgObj = null) {
    try {
      const deserMod = getFbModule('MAWProtobufDeserializers');
      const mediaToBridgeMod = getFbModule('MpsMediaToBridge');
      const decodeProtoMod = getFbModule('decodeProtobuf');
      const mediaTransportPb = getFbModule('WAMediaTransport.pb');

      let topBackup = null;
      try {
        topBackup = msgWrapper?.deserialize?.();
      } catch (_) {}
      if (!topBackup && deserMod?.DeserializedBackupMessage?.create) {
        const rawTopBytes =
          msgWrapper?.message?.payload ?? rawMsgObj?.toplevelProtobuf?.payload ?? null;
        if (rawTopBytes) {
          try {
            topBackup = deserMod.DeserializedBackupMessage.create(rawTopBytes);
          } catch (_) {}
        }
      }

      const topEnc = topBackup?.encryptedTransportMessage?.();
      const topArmadillo = topEnc?.armadillo?.();
      const topContent = topArmadillo?.payload?.content || topArmadillo?.proto?.payload?.content;
      const topRaven = topContent?.ravenMessage ?? topContent?.ravenMessageMsgr ?? null;

      const suppDecoded = [];
      let suppRaven = null;
      let suppNotif = null;

      const suppEntries = [];
      if (supplementalMessages) {
        if (typeof supplementalMessages.forEach === 'function') {
          supplementalMessages.forEach((v, k) => suppEntries.push([k, v]));
        } else if (typeof supplementalMessages === 'object') {
          for (const [k, v] of Object.entries(supplementalMessages)) {
            suppEntries.push([k, v]);
          }
        }
      }

      for (const [suppKey, suppVal] of suppEntries) {
        try {
          const payloadBytes = suppVal?.payload ?? suppVal?.message?.payload ?? suppVal;
          let backup = null;
          if (typeof suppVal?.deserialize === 'function') {
            backup = suppVal.deserialize();
          } else if (deserMod?.DeserializedBackupMessage?.create && payloadBytes) {
            backup = deserMod.DeserializedBackupMessage.create(payloadBytes);
          }
          const enc = backup?.encryptedTransportMessage?.();
          const arm = enc?.armadillo?.();
          const cont = arm?.payload?.content || arm?.proto?.payload?.content;
          const rMsg = cont?.ravenMessage ?? cont?.ravenMessageMsgr ?? null;
          const rNotif = cont?.ravenActionNotifMessage ?? null;
          if (rMsg && (rMsg.imageMessage || rMsg.videoMessage || !suppRaven)) {
            suppRaven = rMsg;
          }
          if (rNotif) suppNotif = rNotif;
          suppDecoded.push({
            key: String(suppKey),
            contentKeys: cont ? Object.keys(cont) : [],
            raven: serializeUntruncated(rMsg, 0),
            notif: serializeUntruncated(rNotif, 0)
          });
        } catch (err) {
          suppDecoded.push({ key: String(suppKey), error: String(err) });
        }
      }

      const activeRaven = suppRaven || topRaven;
      if (!activeRaven && !topRaven) return null;

      let decodedImageTransport = null;
      let decodedVideoTransport = null;
      let bridgeMediaPreview = null;

      const imgMsg = suppRaven?.imageMessage || topRaven?.imageMessage || null;
      const vidMsg = suppRaven?.videoMessage || topRaven?.videoMessage || null;

      if (imgMsg) {
        const rawImgBytes = imgMsg?.payload ?? imgMsg?.image?.payload;
        if (rawImgBytes && decodeProtoMod?.decodeProtobuf && mediaTransportPb?.ImageTransportSpec) {
          try {
            decodedImageTransport = decodeProtoMod.decodeProtobuf(
              mediaTransportPb.ImageTransportSpec,
              rawImgBytes
            );
          } catch (_) {}
        }
        if (!decodedImageTransport && deserMod?.DeserializedImageMessage) {
          try {
            const wrappedInput = imgMsg.image ? imgMsg : { image: imgMsg };
            const inst = new deserMod.DeserializedImageMessage(wrappedInput);
            decodedImageTransport = inst.payload;
          } catch (e) {
            decodedImageTransport = { error: String(e) };
          }
        }
        if (
          mediaToBridgeMod?.getBridgeFromAttachmentTransport &&
          decodedImageTransport &&
          !decodedImageTransport.error &&
          msgWrapper
        ) {
          try {
            bridgeMediaPreview = mediaToBridgeMod.getBridgeFromAttachmentTransport(
              decodedImageTransport,
              'Image',
              msgWrapper
            );
          } catch (_) {}
        }
      }

      if (vidMsg) {
        const rawVidBytes = vidMsg?.payload ?? vidMsg?.video?.payload;
        if (rawVidBytes && decodeProtoMod?.decodeProtobuf && mediaTransportPb?.VideoTransportSpec) {
          try {
            decodedVideoTransport = decodeProtoMod.decodeProtobuf(
              mediaTransportPb.VideoTransportSpec,
              rawVidBytes
            );
          } catch (_) {}
        }
        if (!decodedVideoTransport && deserMod?.DeserializedVideoMessage) {
          try {
            const wrappedInput = vidMsg.video ? vidMsg : { video: vidMsg };
            const inst = new deserMod.DeserializedVideoMessage(wrappedInput);
            decodedVideoTransport = inst.payload;
          } catch (e) {
            decodedVideoTransport = { error: String(e) };
          }
        }
        if (
          mediaToBridgeMod?.getBridgeFromAttachmentTransport &&
          decodedVideoTransport &&
          !decodedVideoTransport.error &&
          msgWrapper
        ) {
          try {
            bridgeMediaPreview = mediaToBridgeMod.getBridgeFromAttachmentTransport(
              decodedVideoTransport,
              'Video',
              msgWrapper
            );
          } catch (_) {}
        }
      }

      const fullMsgId =
        msgWrapper?.getMsgId?.() ||
        (rawMsgObj?.toplevelProtobuf
          ? `${rawMsgObj.toplevelProtobuf.threadId}.${rawMsgObj.toplevelProtobuf.messageId}`
          : null) ||
        msgWrapper?.message?.messageId ||
        null;
      const threadId =
        msgWrapper?.message?.threadId || rawMsgObj?.toplevelProtobuf?.threadId || null;
      const senderId =
        msgWrapper?.message?.senderId || rawMsgObj?.toplevelProtobuf?.senderId || null;
      const timestampMs =
        msgWrapper?.message?.timestampMs ||
        rawMsgObj?.toplevelProtobuf?.timestampMs ||
        Date.now();

      const isVideo = Boolean(decodedVideoTransport && !decodedVideoTransport.error);
      const validTransport = isVideo
        ? decodedVideoTransport
        : decodedImageTransport && !decodedImageTransport.error
          ? decodedImageTransport
          : null;

      if (validTransport && fullMsgId) {
        const waTransport =
          validTransport?.integral?.transport || validTransport?.transport || validTransport;
        const tIntegral = waTransport?.integral;
        const tAncillary = waTransport?.ancillary;
        const thumbObj = tAncillary?.thumbnail;
        const meta = {
          mediaType: isVideo ? 'video' : 'image',
          senderId,
          threadId,
          timestamp: timestampMs
        };

        const thumbDataUrl = thumbObj?.jpegThumbnail
          ? bytesToDataUrl(thumbObj.jpegThumbnail, 'image/jpeg')
          : null;
        if (thumbDataUrl) {
          applyUnlockedViewOnceMedia(fullMsgId, [thumbDataUrl], meta);
        }

        resolveFullViewOnceMedia(fullMsgId, tIntegral, tAncillary, thumbObj, isVideo, meta);
      }

      return {
        t: new Date().toISOString(),
        msgId: fullMsgId,
        threadId,
        senderId,
        topContentKeys: topContent ? Object.keys(topContent) : [],
        topRaven: serializeUntruncated(topRaven, 0),
        suppDecoded,
        decodedImageTransport: serializeUntruncated(decodedImageTransport, 0),
        decodedVideoTransport: serializeUntruncated(decodedVideoTransport, 0),
        bridgeMediaPreview: serializeUntruncated(bridgeMediaPreview, 0)
      };
    } catch (e) {
      return { error: String(e) };
    }
  }

  async function inspectE2EERavenMessagesFromMps(fullMsgId) {
    try {
      if (!fullMsgId || !/@(msgr|g\.us)\./.test(fullMsgId)) return;
      if (probedE2EEThreads.has(fullMsgId)) return;

      const mpsMod = getFbModule('MpsOverBridge');
      const wrapperMod = getFbModule('MpsMessageToBridgeWrapper');
      if (!mpsMod || typeof mpsMod.mps !== 'function') return;

      probedE2EEThreads.add(fullMsgId);
      const lastDot = fullMsgId.lastIndexOf('.');
      const threadId = fullMsgId.slice(0, lastDot);
      const stanzaId = fullMsgId.slice(lastDot + 1);

      const mpsInstance = mpsMod.mps();
      let singleRes = await mpsInstance.loadMessage({
        config: { shouldFetchSupplementals: true, strategy: 'local-first' },
        debug: { purpose: 'reply-fetch-local' },
        messageId: stanzaId,
        threadId
      });
      if (!singleRes?.success || !singleRes?.value) {
        singleRes = await mpsInstance.loadMessage({
          config: { shouldFetchSupplementals: true, useMessageVisibility: true },
          debug: { purpose: 'load-more' },
          messageId: stanzaId,
          threadId
        });
      }

      let listRes = null;
      const threadListKey = `thread_list_${threadId}`;
      if (!probedE2EEThreads.has(threadListKey)) {
        probedE2EEThreads.add(threadListKey);
        listRes = await mpsInstance.loadMessages({
          config: { shouldFetchSupplementals: true, useMessageVisibility: true },
          debug: { purpose: 'load-more' },
          direction: 'desc',
          from: [Date.now() + 86400000, stanzaId],
          numMessages: 25,
          threadId
        });
      }

      const rawMsgs = [];
      if (singleRes?.value?.toplevelProtobuf) {
        rawMsgs.push(singleRes.value);
      } else if (singleRes?.value?.message?.toplevelProtobuf) {
        rawMsgs.push(singleRes.value.message);
      }
      if (Array.isArray(listRes?.value?.messages)) {
        for (const m of listRes.value.messages) {
          if (m?.toplevelProtobuf) rawMsgs.push(m);
        }
      }

      const extractedItems = [];
      for (const rawMsg of rawMsgs) {
        try {
          const w = wrapperMod?.MpsMessageToBridgeWrapper?.fromTopLevel
            ? wrapperMod.MpsMessageToBridgeWrapper.fromTopLevel(rawMsg.toplevelProtobuf)
            : null;
          const ravenInfo = decodeRavenFromProtobufWrapper(
            w,
            rawMsg.supplementalProtobufs,
            rawMsg
          );
          if (ravenInfo) {
            extractedItems.push(ravenInfo);
          }
        } catch (err) {
          extractedItems.push({ error: String(err) });
        }
      }

      deepUnsupportedInspector.e2eeRavenExtracted.push({
        t: new Date().toISOString(),
        source: 'mpsOverBridgeProbe',
        fullMsgId,
        threadId,
        stanzaId,
        singleResSuccess: singleRes?.success,
        singleResKeys: singleRes?.value ? Object.keys(singleRes.value) : null,
        listResSuccess: listRes?.success,
        listCount: listRes?.value?.messages?.length ?? 0,
        extractedItems,
        rawSingleSample: serializeUntruncated(singleRes, 0)
      });
      if (deepUnsupportedInspector.e2eeRavenExtracted.length > 25) {
        deepUnsupportedInspector.e2eeRavenExtracted.shift();
      }
    } catch (e) {
      deepUnsupportedInspector.e2eeRavenExtracted.push({
        t: new Date().toISOString(),
        source: 'mpsOverBridgeProbeError',
        fullMsgId,
        error: String(e)
      });
    }
  }

  let currentDefFunc = window.__d;
  function wrapDefineFn(origD) {
    if (!origD || origD.__fbUnsendWrapped) return origD;
    const wrappedD = function (moduleName, deps, factory, _extra) {
      if (typeof moduleName === 'string') {
        if (
          INTERESTING_MODULE_NAME_REGEX.test(moduleName) &&
          !interestingModuleSet.has(moduleName)
        ) {
          interestingModuleSet.add(moduleName);
          if (deepUnsupportedInspector.interestingModuleNames.length < 1000) {
            deepUnsupportedInspector.interestingModuleNames.push(moduleName);
          }
        }

        if (
          typeof factory === 'function' &&
          SOURCE_CAPTURE_MODULE_REGEX.test(moduleName) &&
          !deepUnsupportedInspector.moduleSources[moduleName]
        ) {
          try {
            deepUnsupportedInspector.moduleSources[moduleName] = {
              deps: Array.isArray(deps) ? deps : [],
              code: Function.prototype.toString.call(factory).slice(0, 12000)
            };
          } catch (_) {}
        }

        const shouldSafeWrap = SAFE_TARGET_MODULE_REGEX.test(moduleName);
        const shouldPassiveCapture = PASSIVE_EXPORT_CAPTURE_REGEX.test(moduleName);

        if (typeof factory === 'function' && (shouldSafeWrap || shouldPassiveCapture)) {
          const origFactory = factory;
          factory = function (g, r, i, a, m, e, d) {
            if (!fbRequireFn && typeof i === 'function') {
              fbRequireFn = i;
            }
            if (!fbImportNamespaceFn && typeof a === 'function') {
              fbImportNamespaceFn = a;
            }
            const ret = origFactory.apply(this, arguments);
            try {
              const hasD = d && typeof d === 'object' && Object.keys(d).length > 0;
              const hasM =
                m &&
                m.exports !== undefined &&
                m.exports !== null &&
                (typeof m.exports !== 'object' || Object.keys(m.exports).length > 0);
              const hasE = e && typeof e === 'object' && Object.keys(e).length > 0;
              const exp = hasD ? d : hasM ? m.exports : hasE ? e : d || (m && m.exports) || e;

              if (exp && shouldPassiveCapture) {
                passiveModuleExports.set(moduleName, exp);
              }
              if (shouldSafeWrap) {
                if (hasD) {
                  instrumentFacebookModule(moduleName, d);
                } else if (hasM) {
                  m.exports = instrumentFacebookModule(moduleName, m.exports);
                } else if (hasE) {
                  instrumentFacebookModule(moduleName, e);
                }
              }
            } catch (_) {}
            return ret;
          };
          try {
            Object.defineProperty(factory, 'length', {
              value: origFactory.length,
              configurable: true
            });
          } catch (_) {}
        }
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
        /Message|Unsent|Snippet|Attachment|Thread|Contact/i.test(node[0])
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

      if (
        /verifyContactRowExists|updateOrInsertContact/i.test(currentFunc) &&
        directI64Values.length > 0 &&
        directTextLiterals.length > 0
      ) {
        const cId = directI64Values[0];
        const cName = directTextLiterals[0];
        if (cId && cId !== '0' && cName.length >= 2 && cName.length <= 80) {
          contactNameMap.set(cId, cName);
        }
      } else if (
        /updateOrInsertThread|verifyHybridThreadExists/i.test(currentFunc) &&
        directI64Values.length > 0 &&
        directTextLiterals.length > 0
      ) {
        const tId = directI64Values.find((v) => {
          const n = Number(v);
          return v.length >= 6 && !(n > 1577836800000 && n < 2051222400000);
        });
        const tName = directTextLiterals.find(
          (lit) => !/^(inbox|pending|other|archived|spam)$/i.test(lit)
        );
        if (tId && tName && tName.length >= 2 && tName.length <= 100) {
          threadNameMap.set(tId, tName);
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
          /^(markMessageUnsent|handleUnsendMessage|deleteMessage|retractMessage|recallMessage)$/i.test(
            currentFunc
          );
        const isExplicitInsertMsgFunc =
          /^(insertMessage|upsertMessage|deleteThenInsertMessage|replaceOptimisticMessage|MAWThreadSnippetForTextMsg)$/i.test(
            currentFunc
          );

        const resolvedId = resolveCanonicalMessageId(primaryId);

        if (hasUnsendNoticeInNode || isExplicitUnsendFunc) {
          triggerMessageUnsent(resolvedId, {
            threadId,
            senderId,
            source: context.source
          });
        } else if (
          (isExplicitInsertMsgFunc && directTextLiterals.length > 0) ||
          directMediaUrls.length > 0
        ) {
          if (!timestamp || isOldHistoricalTimestamp(timestamp)) return;
          registerCapturedMessage({
            messageId: primaryId,
            altIds: allIds,
            text: isExplicitInsertMsgFunc ? directTextLiterals[0] || '' : '',
            senderId,
            threadId,
            attachments: directMediaUrls,
            timestamp,
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
          let timestamp = null;
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
            (typeof textContent === 'string' && isUnsendNoticeText(textContent));

          if (isUnsentFlag) {
            triggerMessageUnsent(msgId, { senderId, threadId, senderName, source: context.source });
          } else {
            let cleanText =
              typeof textContent === 'string' &&
              textContent.trim().length > 0 &&
              !isTechnicalString(textContent)
                ? textContent.trim()
                : '';

            if (!cleanText && obj.hotEmojiSize !== undefined && obj.hotEmojiSize !== null) {
              const hotSize = Array.isArray(obj.hotEmojiSize)
                ? Number(parseLSInt64(obj.hotEmojiSize))
                : Number(obj.hotEmojiSize);
              if (hotSize >= 1 && hotSize <= 3) {
                cleanText = '👍';
              }
            }

            const attachments = [];
            const attList = obj.attachments || obj.blobAttachments || obj.media || [];
            if (Array.isArray(attList)) {
              for (const att of attList) {
                const url =
                  att?.playableUrl ||
                  att?.audioUrl ||
                  att?.videoUrl ||
                  att?.hdUrl ||
                  att?.sdUrl ||
                  att?.url ||
                  att?.previewUrl ||
                  att?.imageUrl ||
                  att?.largePreviewUrl;
                if (url && typeof url === 'string') attachments.push(unvaultString(url));
              }
            }
            const directPlayable =
              obj.playableUrl || obj.audioUrl || obj.videoUrl || obj.hdUrl || obj.sdUrl;
            if (typeof directPlayable === 'string') {
              attachments.push(unvaultString(directPlayable));
            }

            if (cleanText || attachments.length > 0) {
              if (!timestamp || isOldHistoricalTimestamp(timestamp)) return;
              registerCapturedMessage({
                messageId: msgId,
                altIds,
                text: cleanText,
                senderId,
                threadId,
                senderName,
                attachments,
                timestamp,
                source: context.source
              });
            }
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
  // 5. Hook WebSocket & IndexedDB
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
      let byteLen = 0;
      if (typeof data === 'string') {
        decoded = data;
        byteLen = data.length;
      } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        byteLen = data.byteLength || 0;
        decoded = safeDecodeBuffer(data);
      } else if (data instanceof Blob) {
        data
          .arrayBuffer()
          .then((buf) => handleWebSocketFrame(buf, wsUrl))
          .catch(() => {});
        return;
      }

      if (decoded) {
        const isAfterInit = Date.now() - PAGE_LOAD_TIME > INITIAL_SYNC_GRACE_MS;
        const hasUnsupportedOrAttachment =
          decoded.includes('unsupported') ||
          decoded.includes('unavailable') ||
          decoded.includes('File đính kèm') ||
          decoded.includes('Tin nhắn không hiển thị') ||
          decoded.includes('insertAttachment') ||
          decoded.includes('insertBlobAttachment') ||
          decoded.includes('insertXmaAttachment') ||
          decoded.includes('ephemeral') ||
          decoded.includes('view_once') ||
          (isAfterInit && decoded.includes('mid.$'));

        if (hasUnsupportedOrAttachment) {
          deepUnsupportedInspector.wsReceivedRawFrames.push({
            t: new Date().toISOString(),
            ms: Date.now(),
            byteLen,
            decodedText: decoded.slice(0, 25000)
          });
          if (deepUnsupportedInspector.wsReceivedRawFrames.length > 35) {
            deepUnsupportedInspector.wsReceivedRawFrames.shift();
          }
        }
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

  const origWsSend = OriginalWebSocket.prototype.send;
  OriginalWebSocket.prototype.send = function (data) {
    try {
      let decoded = '';
      let byteLen = 0;
      if (typeof data === 'string') {
        decoded = data;
        byteLen = data.length;
      } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        byteLen = data.byteLength || 0;
        decoded = safeDecodeBuffer(data);
      }
      if (decoded) {
        deepUnsupportedInspector.wsSentFrames.push({
          t: new Date().toISOString(),
          url: this.url || '',
          byteLen,
          decodedText: decoded.slice(0, 15000)
        });
        if (deepUnsupportedInspector.wsSentFrames.length > 40) {
          deepUnsupportedInspector.wsSentFrames.shift();
        }
      }
    } catch (_) {}
    return origWsSend.apply(this, arguments);
  };

  if (window.XMLHttpRequest) {
    const origXhrOpen = XMLHttpRequest.prototype.open;
    const origXhrSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__fbUnsendUrl = String(url || '');
      this.__fbUnsendMethod = String(method || '');
      return origXhrOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
      try {
        const url = this.__fbUnsendUrl || '';
        const bodyStr = typeof body === 'string' ? body : '';
        if (
          bodyStr &&
          (bodyStr.includes('LSPlatform') ||
            bodyStr.includes('sync_params') ||
            bodyStr.includes('request_payload') ||
            bodyStr.includes('lightspeed'))
        ) {
          let decodedBody = bodyStr;
          try {
            decodedBody = decodeURIComponent(bodyStr);
          } catch (_) {}
          deepUnsupportedInspector.graphqlSyncRequests.push({
            t: new Date().toISOString(),
            url,
            body: decodedBody.slice(0, 15000)
          });
          if (deepUnsupportedInspector.graphqlSyncRequests.length > 25) {
            deepUnsupportedInspector.graphqlSyncRequests.shift();
          }
        }
        this.addEventListener('load', function () {
          try {
            if (
              (!this.responseType || this.responseType === 'text') &&
              typeof this.responseText === 'string'
            ) {
              const rt = this.responseText;
              if (
                rt.includes('unsupportedmid.$') ||
                rt.includes('File đính kèm không được hỗ trợ') ||
                rt.includes('insertAttachment')
              ) {
                const idx =
                  rt.indexOf('unsupportedmid.$') !== -1
                    ? rt.indexOf('unsupportedmid.$')
                    : rt.indexOf('insertAttachment');
                const start = Math.max(0, idx - 1500);
                deepUnsupportedInspector.graphqlInterestingResponses.push({
                  t: new Date().toISOString(),
                  url,
                  totalLen: rt.length,
                  excerpt: rt.slice(start, start + 12000)
                });
                if (deepUnsupportedInspector.graphqlInterestingResponses.length > 20) {
                  deepUnsupportedInspector.graphqlInterestingResponses.shift();
                }
              }
            }
          } catch (_) {}
        });
      } catch (_) {}
      return origXhrSend.apply(this, arguments);
    };
  }

  window.WebSocket = function (url, protocols) {
    const ws =
      protocols !== undefined
        ? new OriginalWebSocket(url, protocols)
        : new OriginalWebSocket(url);

    dlog('WS-NEW', '#00b894', 'Facebook tạo kết nối WebSocket mới:', url);

    ws.addEventListener('open', () => {
      dlog('WS-OPEN', '#00b894', 'Kết nối WebSocket đã mở:', url);
      emitToContentScript('FB_WS_RECONNECTED', { url, time: Date.now() });
    });

    ws.addEventListener('close', (ev) => {
      dlog('WS-CLOSE', '#d63031', 'Kết nối WebSocket bị đóng:', {
        url,
        code: ev.code,
        reason: ev.reason
      });
    });

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

    IDBObjectStore.prototype.put = function (value, key) {
      const storeName = this.name || 'unknown';
      try {
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
  }

  // ============================================================================
  // 6. QUÉT CHỈ ĐỌC REACT FIBER TRÊN DÒNG CHAT ĐỂ LẤY MESSAGE ID (HỖ TRỢ KHÔI PHỤC SAU KHI F5)
  // ============================================================================
  function extractMsgIdFromProps(props, depth = 0, seen = new WeakSet()) {
    if (!props || typeof props !== 'object' || depth > 3) return '';
    if (seen.has(props)) return '';
    seen.add(props);

    const directCandidates = [
      props.messageId,
      props.message_id,
      props.msgId,
      props.id,
      props.message?.messageId,
      props.message?.message_id,
      props.message?.id,
      props.message?.offlineThreadingId,
      props.row?.messageId,
      props.row?.message?.messageId
    ];
    for (const c of directCandidates) {
      if (typeof c === 'string') {
        const clean = unvaultString(c).trim();
        if (
          clean.startsWith('mid.$') ||
          clean.startsWith('wmid.') ||
          clean.startsWith('otid.') ||
          clean.startsWith('ee.mid.$')
        ) {
          return clean.replace(/^ee\./, '');
        }
      }
    }

    const keys = Object.keys(props);
    for (let i = 0; i < Math.min(keys.length, 25); i++) {
      const k = keys[i];
      if (k === 'children' || k.startsWith('_') || k.startsWith('$$')) continue;
      let val;
      try {
        val = props[k];
      } catch (_) {
        continue;
      }
      if (typeof val === 'string') {
        const clean = unvaultString(val).trim();
        if (
          clean.startsWith('mid.$') ||
          clean.startsWith('wmid.') ||
          clean.startsWith('otid.') ||
          clean.startsWith('ee.mid.$')
        ) {
          return clean.replace(/^ee\./, '');
        }
      } else if (val && typeof val === 'object' && !(val instanceof Node)) {
        const nested = extractMsgIdFromProps(val, depth + 1, seen);
        if (nested) return nested;
      }
    }
    return '';
  }

  function findFiberMessageIdForRow(rowEl) {
    if (!rowEl || !(rowEl instanceof HTMLElement)) return '';
    const domDataId =
      rowEl.dataset?.messageId || rowEl.getAttribute('data-message-id') || '';
    if (domDataId) {
      const cleanDomId = unvaultString(domDataId).trim().replace(/^ee\./, '');
      if (cleanDomId) {
        return resolveCanonicalMessageId(cleanDomId);
      }
    }
    const priorityNodes = Array.from(rowEl.querySelectorAll('div[dir="auto"], span, div'));
    const elementsToCheck = [rowEl, ...priorityNodes.slice(0, 40)];
    for (const el of elementsToCheck) {
      const fiberKey = Object.keys(el).find(
        (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
      );
      if (!fiberKey) continue;
      let curr = el[fiberKey];
      for (let step = 0; step < 16 && curr; step++) {
        if (typeof curr.key === 'string') {
          const cleanKey = unvaultString(curr.key).trim();
          if (
            cleanKey.startsWith('mid.$') ||
            cleanKey.startsWith('wmid.') ||
            cleanKey.startsWith('otid.')
          ) {
            return resolveCanonicalMessageId(cleanKey);
          }
        }
        const fromProps = extractMsgIdFromProps(curr.memoizedProps);
        if (fromProps) {
          return resolveCanonicalMessageId(fromProps);
        }
        curr = curr.return;
      }
    }
    return '';
  }

  const UNSUPPORTED_ATTACHMENT_DOM_REGEX =
    /File đính kèm không được hỗ trợ|Tin nhắn này không hiển thị trên ứng dụng này|Unsupported attachment|isn't available on this app|Chỉ có thể xem trên ứng dụng di động|chỉ có thể xem được 1 lần|chỉ có thể xem được một lần|Hãy xem trên ứng dụng di động|only be viewed once|View it on the mobile app|View once photo|View once video|Ảnh xem một lần|Video xem một lần/i;

  function isLikelyAvatarMediaUrl(url) {
    if (!url || typeof url !== 'string') return true;
    return /\/t39\.30808-1\/|p50x50|p100x100|s100x100|p60x60|p40x40|dst-jpg_s(32|36|40|48|50|60|64|80|100)x|emoji\.php|rsrc\.php|static\.xx\.fbcdn\.net/i.test(
      url
    );
  }

  function extractPlayableUrlsFromProps(
    props,
    outUrls,
    depth = 0,
    seen = new WeakSet(),
    includePreviewMedia = false
  ) {
    if (!props || typeof props !== 'object' || depth > 4) return;
    if (seen.has(props)) return;
    seen.add(props);

    const mediaKeyNames = [
      'playableUrl',
      'playable_url',
      'audioUrl',
      'audio_url',
      'videoUrl',
      'video_url',
      'hdUrl',
      'sdUrl',
      'browser_native_hd_url',
      'browser_native_sd_url'
    ];
    if (includePreviewMedia) {
      mediaKeyNames.push(
        'previewUrl',
        'preview_url',
        'largePreviewUrl',
        'large_preview_url',
        'imageUrl',
        'image_url',
        'xmaPreviewUri',
        'fallbackUrl',
        'fallback_url'
      );
    }

    for (const k of mediaKeyNames) {
      let v;
      try {
        v = props[k];
      } catch (_) {
        continue;
      }
      if (typeof v === 'string') {
        const mUrl = extractMediaUrl(v);
        if (mUrl && !isLikelyAvatarMediaUrl(mUrl) && !outUrls.includes(mUrl)) {
          outUrls.push(mUrl);
        }
      }
    }

    const keys = Object.keys(props);
    for (let i = 0; i < Math.min(keys.length, 35); i++) {
      const k = keys[i];
      if (k === 'children' || k.startsWith('_') || k.startsWith('$$')) continue;
      let val;
      try {
        val = props[k];
      } catch (_) {
        continue;
      }
      if (typeof val === 'string') {
        const mUrl = extractMediaUrl(val);
        if (mUrl && !isLikelyAvatarMediaUrl(mUrl)) {
          const isPlayableFile =
            /(\.ogg|\.mp3|\.wav|\.m4a|\.aac|\.opus|\.mp4|\.webm|\.mov)(\?|$)/i.test(mUrl) ||
            /audioclip|videoclip|\/t59\.3654-21\/|\/t42\./i.test(mUrl);
          const isPreviewImage =
            includePreviewMedia &&
            !/(avatar|profile|author|sender|actor)/i.test(k) &&
            (/(\.jpg|\.jpeg|\.png|\.webp|\.gif)(\?|$)/i.test(mUrl) ||
              /scontent|fbcdn\.net|cdn\.fbsbx\.com/i.test(mUrl));
          if ((isPlayableFile || isPreviewImage) && !outUrls.includes(mUrl)) {
            outUrls.push(mUrl);
          }
        }
      } else if (val && typeof val === 'object' && !(val instanceof Node)) {
        extractPlayableUrlsFromProps(val, outUrls, depth + 1, seen, includePreviewMedia);
      }
    }
  }

  function collectFiberPropsSummary(rowEl) {
    if (!rowEl || !(rowEl instanceof HTMLElement)) return [];
    const results = [];
    const elementsToCheck = [
      rowEl,
      ...Array.from(rowEl.querySelectorAll('div, span, a, [role="button"]')).slice(0, 45)
    ];
    const seenFibers = new WeakSet();
    for (const el of elementsToCheck) {
      const fiberKey = Object.keys(el).find(
        (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
      );
      if (!fiberKey) continue;
      let curr = el[fiberKey];
      for (let step = 0; step < 12 && curr; step++) {
        if (seenFibers.has(curr)) {
          curr = curr.return;
          continue;
        }
        seenFibers.add(curr);
        const mp = curr.memoizedProps;
        if (mp && typeof mp === 'object') {
          const interestingKeys = Object.keys(mp).filter(
            (k) =>
              k !== 'children' &&
              k !== 'className' &&
              k !== 'style' &&
              !k.startsWith('__') &&
              !k.startsWith('on') &&
              mp[k] !== undefined &&
              mp[k] !== null &&
              typeof mp[k] !== 'function'
          );
          if (interestingKeys.length > 0) {
            const snap = {};
            for (const k of interestingKeys.slice(0, 25)) {
              snap[k] = serializeForLog(mp[k], 0);
            }
            const compName =
              typeof curr.type === 'function'
                ? curr.type.displayName || curr.type.name || 'Component'
                : typeof curr.type === 'string'
                  ? curr.type
                  : 'FiberNode';
            results.push({
              comp: compName,
              key: curr.key || null,
              props: snap
            });
            if (results.length >= 25) return results;
          }
        }
        curr = curr.return;
      }
    }
    return results;
  }

  function findFiberPlayableMediaForRow(rowEl, isUnsupportedRow = false) {
    if (!rowEl || !(rowEl instanceof HTMLElement)) return [];
    const urls = [];
    const priorityNodes = Array.from(
      rowEl.querySelectorAll(
        'audio, video, [role="button"], [role="slider"], div[dir="auto"], span, div'
      )
    );
    const elementsToCheck = [rowEl, ...priorityNodes.slice(0, 50)];
    const seenProps = new WeakSet();
    for (const el of elementsToCheck) {
      const fiberKey = Object.keys(el).find(
        (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
      );
      if (!fiberKey) continue;
      let curr = el[fiberKey];
      for (let step = 0; step < 12 && curr; step++) {
        extractPlayableUrlsFromProps(curr.memoizedProps, urls, 0, seenProps, isUnsupportedRow);
        if (urls.length >= 4) return urls;
        curr = curr.return;
      }
    }
    return urls;
  }

  function isDomRowViewOnceBubble(rowEl) {
    if (!rowEl || !(rowEl instanceof HTMLElement)) return false;
    if (rowEl.dataset.fbViewOnceRow === 'true') return true;
    const nodes = rowEl.querySelectorAll('span, div');
    for (const el of nodes) {
      if (el.childElementCount > 0) continue;
      const txt = (el.textContent || '').trim();
      if (!txt) continue;
      if (
        /(chỉ có thể xem được 1 lần|chỉ có thể xem được một lần|Hãy xem trên ứng dụng di động|only be viewed once|View it on the mobile app)/i.test(
          txt
        )
      ) {
        return true;
      }
      if (
        /^(Ảnh|Video|Photo|Tin nhắn ảnh xem 1 lần|Tin nhắn video xem 1 lần|View once photo|View once video)$/i.test(
          txt
        )
      ) {
        const pill =
          el.closest('.x6s0dn4.x78zum5') ||
          el.closest('[role="button"], .x78zum5') ||
          el.parentElement?.parentElement;
        if (pill && (pill.querySelector('svg') || rowEl.querySelector('svg'))) {
          return true;
        }
      }
    }
    return false;
  }

  function scanReactFiberOnChatRows() {
    if (!document.body) return;
    let updatedCount = 0;
    const rows = document.querySelectorAll('div[data-scope="messages_table"]');
    rows.forEach((rowEl) => {
      const currentId = rowEl.dataset.fbMsgId || '';
      const msgId = findFiberMessageIdForRow(rowEl);
      if (msgId && msgId !== currentId) {
        if (currentId) {
          dlog('FIBER-RECYCLED', '#fd79a8', 'React tái sử dụng rowEl cho tin nhắn khác:', {
            oldId: currentId,
            newId: msgId
          });
          delete rowEl.dataset.fbUnsendRestored;
          delete rowEl.dataset.fbUnsendMatchedId;
          delete rowEl.dataset.fbUnsendFirstSeenAt;
          delete rowEl.dataset.fbUnsendSavedMid;
          delete rowEl.dataset.fbUnsendSavedText;
          delete rowEl.dataset.fbUnsendSavedMedia;
          delete rowEl.dataset.fbUnsendSavedSender;
          delete rowEl.dataset.fbFiberMedia;
          delete rowEl.dataset.fbUnsupportedLogged;
          delete rowEl.dataset.fbUnsupportedUnlocked;
          delete rowEl.dataset.fbViewOnceRow;
        }
        rowEl.dataset.fbMsgId = msgId;
        updatedCount++;
      }

      const rawRowText = (rowEl.innerText || rowEl.textContent || '').trim();
      const isViewOnceBubble = isDomRowViewOnceBubble(rowEl);
      if (isViewOnceBubble && rowEl.dataset.fbViewOnceRow !== 'true') {
        rowEl.dataset.fbViewOnceRow = 'true';
        updatedCount++;
      }
      const isUnsupportedRow = isViewOnceBubble || UNSUPPORTED_ATTACHMENT_DOM_REGEX.test(rawRowText);
      const effectiveId = msgId || currentId || rowEl.dataset.messageId || '';
      if (effectiveId && /@(msgr|g\.us)\./.test(effectiveId)) {
        inspectE2EERavenMessagesFromMps(effectiveId);
      }

      const fiberMediaUrls = findFiberPlayableMediaForRow(rowEl, isUnsupportedRow);
      if (effectiveId && unlockedViewOnceMediaMap.has(effectiveId)) {
        for (const uUrl of unlockedViewOnceMediaMap.get(effectiveId)) {
          if (uUrl && !fiberMediaUrls.includes(uUrl)) {
            fiberMediaUrls.unshift(uUrl);
          }
        }
      }
      if (fiberMediaUrls.length > 0) {
        const serialized = JSON.stringify(fiberMediaUrls);
        if (rowEl.dataset.fbFiberMedia !== serialized) {
          rowEl.dataset.fbFiberMedia = serialized;
          updatedCount++;
        }
      }

      if (isUnsupportedRow && !rowEl.dataset.fbUnsupportedLogged) {
        rowEl.dataset.fbUnsupportedLogged = 'true';
        const resolvedId = msgId ? resolveCanonicalMessageId(msgId) : '';
        const capturedRec = resolvedId ? capturedMessages.get(resolvedId) : null;
        const savedMeta = resolvedId ? messageMetaMap.get(resolvedId) : null;
        const fiberSummary = collectFiberPropsSummary(rowEl);
        dlog('FIBER-UNSUPPORTED-ROW', '#e056fd', 'Phát hiện dòng File đính kèm không được hỗ trợ trên DOM:', {
          msgId: resolvedId || msgId,
          rawRowText: rawRowText.slice(0, 240),
          fiberMediaUrls,
          capturedRec: serializeForLog(capturedRec, 0),
          savedMeta: serializeForLog(savedMeta, 0),
          fiberSummary
        });
      }
    });
    if (updatedCount > 0) {
      emitToContentScript('FB_FIBER_UPDATED', { updatedCount });
    }
  }

  function buildUnsupportedAndRecentFiberDump() {
    if (!document.body) return [];
    const rows = Array.from(document.querySelectorAll('div[data-scope="messages_table"]'));
    const out = [];
    rows.forEach((rowEl, idx) => {
      const rawText = (rowEl.innerText || rowEl.textContent || '').trim();
      const isUnsupported = UNSUPPORTED_ATTACHMENT_DOM_REGEX.test(rawText);
      const isRecentTail = idx >= Math.max(0, rows.length - 6);
      if (!isUnsupported && !isRecentTail) return;
      const msgId = rowEl.dataset.fbMsgId || findFiberMessageIdForRow(rowEl) || '';
      out.push({
        rowIndex: idx,
        msgId,
        isUnsupported,
        rawText: rawText.slice(0, 240),
        fiberMedia: rowEl.dataset.fbFiberMedia || null,
        fiberPropsChain: collectFiberPropsSummary(rowEl)
      });
    });
    return out;
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data) return;
    if (event.data.source === 'FB_UNSEND_EXTENSION_CONTENT') {
      if (event.data.type === 'SCAN_FIBER') {
        scanReactFiberOnChatRows();
      } else if (event.data.type === 'REQUEST_MAIN_DEBUG_DUMP') {
        scanReactFiberOnChatRows();
        try {
          const syncParamsMod = getFbModule('LSPlatformMessengerSyncParams');
          const lsVersionMod = getFbModule('LSVersion');
          const threadCapMod = getFbModule('MWLSThreadCapabilities');
          const partCapMod = getFbModule('LSComputeParticipantCapabilities');
          const targetInspectMods = [
            'LSIssueAttachmentRestoreTask',
            'LSUpsertAttachmentRange',
            'LSUpsertAttachmentRangeStoredProcedure',
            'LSIssueFetchThreadCapabilitiesTask',
            'LSTaskSerializerSyncThreadCapabilities',
            'MessengerAttachmentTransformer.bs',
            'MessengerStoryAttachmentTransformer.bs',
            'LSInsertAttachment',
            'LSInsertBlobAttachment',
            'LSInsertXmaAttachment',
            'LSMediaUrlAttachment',
            'LSPlatformClientSingleton',
            'LSDatabaseSingleton'
          ];
          for (const mName of deepUnsupportedInspector.interestingModuleNames) {
            if (
              /Restore|UpsertAttachment|Capability|SyncTask|Transformer|Ephemeral|ViewOnce|Unsupported/i.test(
                mName
              ) &&
              !targetInspectMods.includes(mName)
            ) {
              targetInspectMods.push(mName);
            }
          }
          const restoreAndAttachmentModules = {};
          for (const mName of targetInspectMods) {
            try {
              const mod = getFbModule(mName);
              if (!mod) continue;
              if (typeof mod === 'function') {
                restoreAndAttachmentModules[mName] = {
                  type: 'function',
                  sprocName: mod.__sproc_name__ || null,
                  tables: mod.__tables__ || null,
                  source: Function.prototype.toString.call(mod).slice(0, 12000)
                };
              } else if (typeof mod === 'object') {
                const objInfo = {};
                for (const k of Object.keys(mod).slice(0, 30)) {
                  const v = mod[k];
                  objInfo[k] =
                    typeof v === 'function'
                      ? Function.prototype.toString.call(v).slice(0, 6000)
                      : serializeUntruncated(v, 1);
                }
                restoreAndAttachmentModules[mName] = {
                  type: 'object',
                  keys: Object.keys(mod),
                  objInfo
                };
              }
            } catch (_) {}
          }
          deepUnsupportedInspector.syncParamsInspect = {
            syncParams: serializeUntruncated(syncParamsMod, 0),
            lsVersion: serializeUntruncated(lsVersionMod, 0),
            threadCap: serializeUntruncated(threadCapMod, 0),
            partCap: serializeUntruncated(partCapMod, 0),
            restoreAndAttachmentModules
          };
        } catch (_) {}
        emitToContentScript('FB_MAIN_DEBUG_DUMP', {
          mainLogs: mainLogBuffer,
          capturedMessages: Array.from(capturedMessages.values()).slice(-200).map((m) => serializeForLog(m, 0)),
          messageMetaMap: Array.from(messageMetaMap.entries()).slice(-200),
          pendingVaultMessages: Array.from(pendingVaultMessages.entries()).slice(-50).map(([k, v]) => [k, serializeForLog(v, 0)]),
          aliasIdMap: Array.from(aliasIdMap.entries()).slice(-200),
          contactNameMap: Array.from(contactNameMap.entries()).slice(-100),
          threadNameMap: Array.from(threadNameMap.entries()).slice(-100),
          vaultMapSize: vaultMap.size,
          vaultMapSample: Array.from(vaultMap.entries()).slice(-100),
          hasMawUnvaultFn: Boolean(mawUnvaultFn),
          fiberRowsInspect: buildUnsupportedAndRecentFiberDump(),
          deepUnsupportedInspector
        });
      }
    }
  });
})();

