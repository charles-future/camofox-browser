/**
 * Download capture and DOM image extraction for camofox-browser.
 *
 * Handles Playwright download events, temp file lifecycle, and
 * in-page image source extraction with optional inline data.
 */

import crypto from 'crypto';
import path from 'path';
import os from 'os';
import fs from 'node:fs/promises';

const MAX_DOWNLOAD_RECORDS_PER_TAB = 20;
const MAX_DOWNLOAD_INLINE_BYTES = 20 * 1024 * 1024;

function sanitizeFilename(value) {
  return String(value || 'download.bin')
    .replace(/[\\/:*?"<>|\u0000-\u001F]/g, '_')
    .trim()
    .slice(0, 200) || 'download.bin';
}

function guessMimeTypeFromName(value) {
  const normalized = String(value || '').toLowerCase();
  if (normalized.endsWith('.png')) return 'image/png';
  if (normalized.endsWith('.jpg') || normalized.endsWith('.jpeg')) return 'image/jpeg';
  if (normalized.endsWith('.webp')) return 'image/webp';
  if (normalized.endsWith('.gif')) return 'image/gif';
  if (normalized.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

async function removeDownloadFileIfPresent(record) {
  const filePath = record?.filePath;
  if (!filePath) return;
  await fs.unlink(filePath).catch(() => {});
}

async function trimTabDownloads(tabState) {
  while (tabState.downloads.length > MAX_DOWNLOAD_RECORDS_PER_TAB) {
    const stale = tabState.downloads.shift();
    await removeDownloadFileIfPresent(stale);
  }
}

async function clearTabDownloads(tabState) {
  const entries = Array.isArray(tabState.downloads) ? [...tabState.downloads] : [];
  tabState.downloads = [];
  await Promise.all(entries.map(removeDownloadFileIfPresent));
}

async function clearSessionDownloads(session) {
  if (!session || !session.tabGroups) return;
  const tasks = [];
  for (const group of session.tabGroups.values()) {
    for (const tabState of group.values()) {
      tasks.push(clearTabDownloads(tabState));
    }
  }
  await Promise.all(tasks);
}

function attachDownloadListener(tabState, tabId, log) {
  if (tabState.downloadListenerAttached) return;
  tabState.downloadListenerAttached = true;

  tabState.page.on('download', async (download) => {
    const downloadId = crypto.randomUUID();
    const suggestedFilename = sanitizeFilename(download.suggestedFilename?.() || `download-${downloadId}.bin`);
    const filePath = path.join(os.tmpdir(), `camofox-download-${downloadId}-${suggestedFilename}`);

    let failure = null;
    let bytes = null;

    try {
      await download.saveAs(filePath);
      const stat = await fs.stat(filePath);
      bytes = stat.size;
    } catch (err) {
      failure = String(err?.message || err || 'download_save_failed');
      await fs.unlink(filePath).catch(() => {});
    }

    const reportedFailure = await download.failure().catch(() => null);
    if (reportedFailure) {
      failure = reportedFailure;
    }

    const url = String(download.url?.() || '').trim();
    if (url) {
      tabState.visitedUrls.add(url);
    }

    const mimeType = guessMimeTypeFromName(suggestedFilename) || guessMimeTypeFromName(url);
    tabState.downloads.push({
      id: downloadId,
      tabId,
      url,
      suggestedFilename,
      mimeType,
      bytes,
      createdAt: new Date().toISOString(),
      filePath: failure ? null : filePath,
      failure,
    });

    await trimTabDownloads(tabState);
    log('info', 'download captured', {
      tabId, downloadId, suggestedFilename, mimeType, bytes,
      hasUrl: Boolean(url), failure,
    });
  });
}

/**
 * Build the response array for GET /tabs/:tabId/downloads.
 */
async function getDownloadsList(tabState, { includeData = false, maxBytes = MAX_DOWNLOAD_INLINE_BYTES } = {}) {
  const snapshot = Array.isArray(tabState.downloads) ? [...tabState.downloads] : [];
  const downloads = [];

  for (const entry of snapshot) {
    const item = {
      id: entry.id,
      url: entry.url,
      suggestedFilename: entry.suggestedFilename,
      mimeType: entry.mimeType,
      bytes: entry.bytes,
      createdAt: entry.createdAt,
      failure: entry.failure,
    };

    if (includeData && entry.filePath && !entry.failure) {
      if (typeof entry.bytes === 'number' && entry.bytes > maxBytes) {
        item.dataSkipped = 'max_bytes_exceeded';
      } else {
        try {
          const raw = await fs.readFile(entry.filePath);
          item.dataBase64 = raw.toString('base64');
        } catch (err) {
          item.readError = String(err?.message || err || 'download_read_failed');
        }
      }
    }

    downloads.push(item);
  }

  return downloads;
}

/**
 * In-page image extraction script for page.evaluate().
 * Returns image metadata and optionally inline data URLs.
 */
async function extractPageImages(page, { includeData = false, maxBytes = MAX_DOWNLOAD_INLINE_BYTES, limit = 8 } = {}) {
  return page.evaluate(
    async ({ includeData, maxBytes, limit }) => {
      const toDataUrl = (blob) =>
        new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
          reader.onerror = () => reject(new Error('file_reader_failed'));
          reader.readAsDataURL(blob);
        });

      const nodes = Array.from(document.querySelectorAll('img'));
      const seen = new Set();
      const candidates = [];

      for (const node of nodes) {
        const src = String(node.currentSrc || node.src || node.getAttribute('src') || '').trim();
        if (!src || seen.has(src)) continue;
        seen.add(src);
        candidates.push({
          src,
          alt: String(node.alt || '').trim(),
          width: Number(node.naturalWidth || node.width || 0) || undefined,
          height: Number(node.naturalHeight || node.height || 0) || undefined,
        });
        if (candidates.length >= limit) break;
      }

      const results = [];
      for (const image of candidates) {
        const entry = { src: image.src, alt: image.alt, width: image.width, height: image.height };

        if (includeData) {
          try {
            if (image.src.startsWith('data:')) {
              const mimeMatch = image.src.match(/^data:([^;,]+)[;,]/i);
              const isBase64 = /;base64,/i.test(image.src);
              const payload = image.src.slice(image.src.indexOf(',') + 1);
              const estimatedBytes = isBase64 ? Math.floor((payload.length * 3) / 4) : payload.length;
              entry.mimeType = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
              entry.bytes = estimatedBytes;
              if (estimatedBytes <= maxBytes) {
                entry.dataUrl = image.src;
              } else {
                entry.dataSkipped = 'max_bytes_exceeded';
              }
            } else {
              const response = await fetch(image.src, { credentials: 'include' });
              if (response.ok) {
                const blob = await response.blob();
                entry.mimeType = blob.type || 'application/octet-stream';
                entry.bytes = blob.size;
                if (blob.size <= maxBytes) {
                  entry.dataUrl = await toDataUrl(blob);
                } else {
                  entry.dataSkipped = 'max_bytes_exceeded';
                }
              } else {
                entry.fetchError = `http_${response.status}`;
              }
            }
          } catch (err) {
            entry.fetchError = String(err?.message || err || 'image_fetch_failed');
          }
        }

        results.push(entry);
      }

      return results;
    },
    { includeData, maxBytes, limit },
  );
}

export {
  MAX_DOWNLOAD_INLINE_BYTES,
  sanitizeFilename,
  guessMimeTypeFromName,
  clearTabDownloads,
  clearSessionDownloads,
  attachDownloadListener,
  getDownloadsList,
  extractPageImages,
};
