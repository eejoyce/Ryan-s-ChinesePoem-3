/* 背古诗词搭子 · Service Worker
 * 拦截语音识别模型 / 推理引擎请求：
 *   1. 优先从 Cache API 返回（预下载已缓存 → 秒加载）
 *   2. 未命中 → 从 jsDelivr CDN（大陆可直连）回源并缓存
 * 使识别模型加载既快又稳，不依赖 GitHub Pages 直连速度。 */
const CACHE = 'poem-model-cache-v4';
const CDN = 'https://cdn.jsdelivr.net/gh/eejoyce/Ryan-s-ChinesePoem-3@main';
const MODEL_PATH = '/models/Xenova/whisper-tiny/';
const ORT_PATH = '/js/ort/';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  if (!url.pathname.includes(MODEL_PATH) && !url.pathname.includes(ORT_PATH)) return;
  if (e.request.method !== 'GET') return;

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(e.request);
    if (hit) return hit;
    // 超 20MB 的大模型文件：jsDelivr 拒 403，直接同域（GitHub Pages）回源（页面已用 Range 分块并发预下载）
    if (url.pathname.includes('decoder_model_merged_quantized.onnx')) {
      try { return await fetch(e.request); } catch (err) { return new Response('', { status: 502 }); }
    }
    try {
      const remote = CDN + url.pathname;
      const resp = await fetch(remote, { mode: 'cors' });
      if (resp.ok) cache.put(e.request, resp.clone());
      return resp;
    } catch (err) {
      return fetch(e.request); // CDN 不可达时直接回源同域
    }
  })());
});
