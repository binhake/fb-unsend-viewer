/**
 * FB Unsend Message Viewer — background.js
 * Copyright (c) 2026 binhake (https://github.com/binhake/fb-unsend-viewer)
 * Licensed under the Non-Commercial & Strict Attribution License.
 * Removing author attribution ("binhake") or unauthorized commercial use is strictly prohibited.
 */
// background.js - Service Worker quản lý Badge thông báo tin nhắn thu hồi & kiểm tra bản phát hành mới trên GitHub Releases

const STORAGE_KEY_UNREAD_COUNT = 'fb_unread_unsent_count_v2';
const STORAGE_KEY_UPDATE_INFO = 'fb_unsend_update_info_v1';
const GITHUB_LATEST_RELEASE_API =
  'https://api.github.com/repos/binhake/fb-unsend-viewer/releases/latest';
const GITHUB_RELEASES_PAGE_URL = 'https://github.com/binhake/fb-unsend-viewer/releases';
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 giờ

function parseSemVer(verStr) {
  const clean = String(verStr || '')
    .trim()
    .replace(/^[vV]+/, '')
    .split('-')[0];
  if (!/^\d+(\.\d+)*$/.test(clean)) return null;
  return clean.split('.').map((n) => parseInt(n, 10) || 0);
}

function isNewerVersion(remoteVer, localVer) {
  const r = parseSemVer(remoteVer);
  const l = parseSemVer(localVer);
  if (!r || !l) return false;
  const maxLen = Math.max(r.length, l.length);
  for (let i = 0; i < maxLen; i++) {
    const rv = r[i] || 0;
    const lv = l[i] || 0;
    if (rv > lv) return true;
    if (rv < lv) return false;
  }
  return false;
}

function refreshBadgeFromStorage() {
  chrome.storage.local.get([STORAGE_KEY_UNREAD_COUNT, STORAGE_KEY_UPDATE_INFO], (res) => {
    const unreadNum = Number(res[STORAGE_KEY_UNREAD_COUNT]) || 0;
    if (unreadNum > 0) {
      const text = unreadNum > 99 ? '99+' : String(unreadNum);
      chrome.action.setBadgeText({ text });
      chrome.action.setBadgeBackgroundColor({ color: '#ff4d4f' });
      return;
    }

    const updateInfo = res[STORAGE_KEY_UPDATE_INFO];
    const currentVer = chrome.runtime.getManifest().version;
    if (
      updateInfo &&
      updateInfo.latestVersion &&
      isNewerVersion(updateInfo.latestVersion, currentVer) &&
      updateInfo.dismissedVersion !== updateInfo.latestVersion
    ) {
      chrome.action.setBadgeText({ text: 'NEW' });
      chrome.action.setBadgeBackgroundColor({ color: '#0866ff' });
    } else {
      chrome.action.setBadgeText({ text: '' });
    }
  });
}

async function checkForGithubReleaseUpdate(force = false) {
  try {
    const currentVer = chrome.runtime.getManifest().version;
    const stored = await chrome.storage.local.get([STORAGE_KEY_UPDATE_INFO]);
    const prevInfo = stored[STORAGE_KEY_UPDATE_INFO] || {};

    if (
      !force &&
      prevInfo.checkedAt &&
      Date.now() - Number(prevInfo.checkedAt) < UPDATE_CHECK_INTERVAL_MS
    ) {
      refreshBadgeFromStorage();
      return prevInfo;
    }

    const resp = await fetch(GITHUB_LATEST_RELEASE_API, {
      method: 'GET',
      headers: { Accept: 'application/vnd.github+json' },
      cache: 'no-store'
    });

    if (resp.status === 404) {
      const info = {
        checkedAt: Date.now(),
        latestVersion: currentVer,
        hasUpdate: false,
        releaseUrl: GITHUB_RELEASES_PAGE_URL,
        dismissedVersion: prevInfo.dismissedVersion || ''
      };
      await chrome.storage.local.set({ [STORAGE_KEY_UPDATE_INFO]: info });
      refreshBadgeFromStorage();
      return info;
    }

    if (!resp.ok) {
      return prevInfo;
    }

    const data = await resp.json();
    const rawTag = String(data?.tag_name || data?.name || '').trim();
    const cleanLatest = rawTag.replace(/^[vV]+/, '');
    const hasUpdate = isNewerVersion(cleanLatest, currentVer);
    const releaseUrl =
      typeof data?.html_url === 'string' && data.html_url.startsWith('https://github.com/')
        ? data.html_url
        : GITHUB_RELEASES_PAGE_URL;

    const info = {
      checkedAt: Date.now(),
      latestVersion: cleanLatest || currentVer,
      hasUpdate,
      releaseUrl,
      releaseName: String(data?.name || rawTag || '').trim(),
      dismissedVersion: prevInfo.dismissedVersion || ''
    };
    await chrome.storage.local.set({ [STORAGE_KEY_UPDATE_INFO]: info });
    refreshBadgeFromStorage();
    return info;
  } catch (_) {
    refreshBadgeFromStorage();
    return null;
  }
}

refreshBadgeFromStorage();
checkForGithubReleaseUpdate(false);

chrome.runtime.onInstalled.addListener(() => {
  checkForGithubReleaseUpdate(true);
});

chrome.runtime.onStartup.addListener(() => {
  checkForGithubReleaseUpdate(false);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (
    areaName === 'local' &&
    (changes[STORAGE_KEY_UNREAD_COUNT] || changes[STORAGE_KEY_UPDATE_INFO])
  ) {
    refreshBadgeFromStorage();
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) return;

  if (message.type === 'INCREMENT_UNREAD_BADGE') {
    chrome.storage.local.get([STORAGE_KEY_UNREAD_COUNT], (res) => {
      const nextCount = (Number(res[STORAGE_KEY_UNREAD_COUNT]) || 0) + 1;
      chrome.storage.local.set({ [STORAGE_KEY_UNREAD_COUNT]: nextCount }, () => {
        refreshBadgeFromStorage();
        sendResponse({ ok: true, count: nextCount });
      });
    });
    return true;
  }

  if (message.type === 'CLEAR_UNREAD_BADGE') {
    chrome.storage.local.set({ [STORAGE_KEY_UNREAD_COUNT]: 0 }, () => {
      refreshBadgeFromStorage();
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === 'CHECK_GITHUB_RELEASE_UPDATE') {
    checkForGithubReleaseUpdate(Boolean(message.force)).then((info) => {
      sendResponse({ ok: true, info });
    });
    return true;
  }

  if (message.type === 'FETCH_MEDIA_AS_BASE64') {
    const mediaUrl = typeof message.url === 'string' ? message.url.trim() : '';
    const maxBytes = Number(message.maxBytes) || 15 * 1024 * 1024;
    if (!/^https?:\/\//i.test(mediaUrl)) {
      sendResponse({ ok: false, dataUrl: '' });
      return false;
    }
    fetch(mediaUrl, { credentials: 'omit', cache: 'force-cache' })
      .then((resp) => {
        if (!resp || !resp.ok) return null;
        return resp.blob();
      })
      .then((blob) => {
        if (!blob || blob.size === 0 || blob.size > maxBytes) {
          sendResponse({ ok: false, dataUrl: '' });
          return;
        }
        const reader = new FileReader();
        reader.onloadend = () => {
          const res = typeof reader.result === 'string' ? reader.result : '';
          sendResponse({
            ok: res.startsWith('data:'),
            dataUrl: res.startsWith('data:') ? res : ''
          });
        };
        reader.onerror = () => {
          sendResponse({ ok: false, dataUrl: '' });
        };
        reader.readAsDataURL(blob);
      })
      .catch(() => {
        sendResponse({ ok: false, dataUrl: '' });
      });
    return true;
  }
});
