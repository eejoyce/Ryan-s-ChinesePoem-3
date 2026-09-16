/* ===== 背古诗词搭子 · 应用逻辑 ===== */
(function () {
'use strict';

/* ---------- 设置 ---------- */
const DEFAULTS = { loop: false, readVol: 'm', bgmVol: 'm', speed: 'm', size: 'm', theme: 'green' };
let settings = loadSettings();

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('gsp_settings') || '{}');
    return Object.assign({}, DEFAULTS, s);
  } catch (e) { return Object.assign({}, DEFAULTS); }
}
function saveSettings() {
  localStorage.setItem('gsp_settings', JSON.stringify(settings));
  document.body.dataset.theme = settings.theme;
  document.body.dataset.size = settings.size;
}
/* 阅读次数 / 背诵分 / 考试分 */
function getViews(id) { return parseInt(localStorage.getItem('gsp_view_' + id) || '0', 10); }
function addView(id) { localStorage.setItem('gsp_view_' + id, String(getViews(id) + 1)); }
function getReciteScore(id) { return parseInt(localStorage.getItem('gsp_recite_' + id) || '-1', 10); }
function setReciteScore(id, s) {
  const old = getReciteScore(id);
  if (s > old) localStorage.setItem('gsp_recite_' + id, String(s));
  return Math.max(old, s);
}
function getQuizScore(id) { return parseInt(localStorage.getItem('gsp_quiz_' + id) || '-1', 10); }
function setQuizScore(id, s) {
  const old = getQuizScore(id);
  if (s > old) localStorage.setItem('gsp_quiz_' + id, String(s));
  return Math.max(old, s);
}

/* ---------- 语音常量（TTS固定为童声，音色选择已按要求移除） ---------- */
const TTS_VOICE = { pitch: 1.35, rate: 0.85 };
const VOL = { s: 0.45, m: 0.75, l: 1.0 };
const BGMVOL = { s: 0.22, m: 0.38, l: 0.6 };
const SPEED = { s: 0.72, m: 0.9, l: 1.08 };

/* ---------- 朗读器（原文：预录音频 + BGM） ---------- */
const Reader = {
  audio: null, bgm: null, poem: null, timer: null, currentLine: -1,
  speaking: false,

  play(poem) {
    this.stop(true);
    this.poem = poem;
    // 音频已按"题目 → 朝代+作者 → 正文"顺序预录，直接播放
    this.playAudio(poem);

    // 同步启动BGM（按诗意曲风）
    const bgmUrl = BGM_FILES[poem.category] || BGM_FILES[1];
    const bgm = new Audio(bgmUrl);
    bgm.loop = true;
    bgm.volume = BGMVOL[settings.bgmVol] * 0.7; // 朗读时略微压低，保持背景感
    this.bgm = bgm;
    bgm.play().catch(() => {});
  },

  playAudio(poem) {
    if (this._bodyPlaying) return;
    this._bodyPlaying = true;
    const url = 'audio/poem-' + poem.id + '.wav';
    const a = new Audio();
    a.src = url;
    a.volume = VOL[settings.readVol];
    a.loop = settings.loop;
    this.audio = a;

    let started = false;
    const onCanPlay = () => {
      if (started) return;
      started = true;
      a.play().catch(() => {
        // 音频播放失败 → 回退TTS
        this.stop(true);
        this.speakTTS(poem);
      });
      this.startHighlight(a, poem);
    };
    a.addEventListener('loadedmetadata', onCanPlay, { once: true });
    a.addEventListener('canplay', onCanPlay, { once: true });
    a.addEventListener('error', () => {
      if (!started) {
        this.stop(true);
        this.speakTTS(poem);
      }
    });
    a.addEventListener('ended', () => {
      this._bodyPlaying = false;
      if (settings.loop) {
        a.currentTime = 0; a.play().catch(() => {});
      } else {
        this.stopAll();
      }
    });
    this.speaking = true;
    UI.refreshReadBtn(poem.id, true);
  },

  startHighlight(a, poem) {
    const lines = poem.content;
    // 音频开头含"题目+朝代+作者"前导，先算出前导时长偏移，再对正文逐行高亮
    const leading = countHan(poem.title) + countHan(poem.dynasty) + countHan(poem.author);
    const bodyChars = lines.reduce((s, l) => s + countHan(l), 0);
    const totalChars = leading + bodyChars;
    // 优先用内置时长（WAV 在部分浏览器 duration 解析为 Infinity 导致高亮失效）
    const dur = (AUDIO_DURS && AUDIO_DURS[poem.id] > 0) ? AUDIO_DURS[poem.id]
      : ((isFinite(a.duration) && a.duration > 0) ? a.duration : 20);
    const offset = leading / totalChars * dur;
    const cum = [offset];
    let acc = offset;
    lines.forEach((l, i) => { acc += countHan(l) / totalChars * dur; cum.push(acc); });
    cum[cum.length - 1] = dur;
    this.highlight = { lines, cum };
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      if (!this.audio) return;
      const t = this.audio.currentTime;
      // 前导（题目+朝代+作者）期间不高亮任何行
      let idx = -1;
      for (let i = 0; i < cum.length - 1; i++) {
        if (t >= cum[i] && t < cum[i + 1]) { idx = i; break; }
      }
      if (idx !== this.currentLine) {
        this.currentLine = idx;
        UI.highlightLine(poem.id, idx);
      }
    }, 200);
  },

  /* TTS 兜底：原文朗读（带多音字校准） */
  speakTTS(poem) {
    const u = new SpeechSynthesisUtterance(poem.content.join(''));
    u.lang = 'zh-CN';
    u.rate = TTS_VOICE.rate * SPEED[settings.speed];
    u.pitch = TTS_VOICE.pitch;
    u.volume = VOL[settings.readVol];
    u.text = fixTTS(poem.content.join(''));
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
    this.speaking = true;
    UI.refreshReadBtn(poem.id, true);
    this.highlight = { lines: poem.content, cum: null };
    this.timer = setInterval(() => {
      if (!speechSynthesis.speaking) { this.stopAll(); }
    }, 300);
    u.onend = () => { this.stopAll(); };
  },

  /* 解析/作者简介 TTS（无BGM） */
  speakSection(text, id) {
    this.stopAll();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN';
    u.rate = TTS_VOICE.rate * SPEED[settings.speed];
    u.pitch = TTS_VOICE.pitch;
    u.volume = VOL[settings.readVol];
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  },

  stop(keepBgm) {
    if (this.audio) { this.audio.pause(); this.audio.src = ''; this.audio = null; }
    this._bodyPlaying = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.currentLine = -1;
    speechSynthesis.cancel();
    if (this.speaking && this.poem) UI.refreshReadBtn(this.poem.id, false);
    this.speaking = false;
    if (!keepBgm && this.bgm) { this.stopBgm(); }
  },

  stopBgm() {
    if (this.bgm) {
      try { this.bgm.pause(); this.bgm.src = ''; } catch (e) {}
      this.bgm = null;
    }
  },
  stopAll() { this.stop(false); }
};

/* TTS多音字校准：同音字替换保证读音正确 */
function fixTTS(text) {
  return text
    .replace(/斜/g, '霞')
    .replace(/还/g, '环')
    .replace(/骑/g, '寄')
    .replace(/燕/g, '烟')
    .replace(/荷/g, '贺')
    .replace(/重/g, '虫')
    .replace(/长/g, '掌')
    .replace(/为/g, '唯')
    .replace(/属/g, '鼠')
    .replace(/乘/g, '成')
    .replace(/遗/g, '未')
    .replace(/令/g, '另')
    .replace(/应/g, '英')
    .replace(/朝/g, '招')
    .replace(/论/g, '轮')
    .replace(/将/g, '江')
    .replace(/看/g, '刊')
    .replace(/地/g, '第')
    .replace(/曲/g, '取')
    .replace(/度/g, '渡');
}

/* ---------- 工具 ---------- */
/* 离线语音识别（Whisper tiny，浏览器本地运行，不依赖在线服务） */
let whisperPipe = null, whisperLoading = false, whisperFailed = false;

async function loadWhisper() {
  if (whisperPipe) return whisperPipe;
  if (whisperFailed) return null;
  if (whisperLoading) { while (whisperLoading) await new Promise(r => setTimeout(r, 300)); return whisperPipe; }
  whisperLoading = true;
  try {
    let mod = window.__transformersModule;
    if (!mod) {
      mod = await import('./js/transformers.js');
      window.__transformersModule = mod;
    }
    const { pipeline, env } = mod;
    env.allowLocalModels = true;
    env.localModelPath = 'models/';
    env.backends.onnx.wasm.wasmPaths = 'js/ort/';
    env.backends.onnx.wasm.numThreads = 1; // 静态托管无 COOP/COEP，禁用多线程
    whisperPipe = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny', { quantized: true, local_files_only: true });
  } catch (e) {
    console.error('whisper load failed:', e);
    whisperPipe = null;
    whisperFailed = true;
  } finally {
    whisperLoading = false;
  }
  return whisperPipe;
}

/* 录音 blob → 文本（16kHz 重采样后喂给 Whisper） */
async function whisperTranscribe(blob) {
  const pipe = await loadWhisper();
  if (!pipe) return '';
  try {
    const arrayBuf = await blob.arrayBuffer();
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const actx = new Ctx();
    const audioBuf = await actx.decodeAudioData(arrayBuf);
    await actx.close();
    const src = audioBuf.getChannelData(0);
    const ratio = audioBuf.sampleRate / 16000;
    const len = Math.round(src.length / ratio);
    const out = new Float32Array(len);
    for (let i = 0; i < len; i++) out[i] = src[Math.floor(i * ratio)];
    const res = await pipe(out, { language: 'zh', task: 'transcribe' });
    return (res && res.text) ? res.text : '';
  } catch (e) {
    console.error('whisper transcribe failed:', e);
    return '';
  }
}

const isHan = ch => /[\u4e00-\u9fff]/.test(ch);
function countHan(s) { let n = 0; for (const ch of s) if (isHan(ch)) n++; return n; }
/* 最长公共子序列匹配数（带同音比较器），用于背诵逐字评分 */
function lcsMatch(a, b, eq) {
  const m = a.length, n = b.length;
  if (m === 0 || n === 0) return 0;
  let prev = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    const cur = new Array(n + 1).fill(0);
    const ai = a[i - 1];
    for (let j = 1; j <= n; j++) {
      cur[j] = eq(ai, b[j - 1], i - 1, j - 1) ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[n];
}
const TONE_MAP = { 'ā': 'a', 'á': 'a', 'ǎ': 'a', 'à': 'a', 'ē': 'e', 'é': 'e', 'ě': 'e', 'è': 'e', 'ī': 'i', 'í': 'i', 'ǐ': 'i', 'ì': 'i', 'ō': 'o', 'ó': 'o', 'ǒ': 'o', 'ò': 'o', 'ū': 'u', 'ú': 'u', 'ǔ': 'u', 'ù': 'u', 'ǖ': 'v', 'ǘ': 'v', 'ǚ': 'v', 'ǜ': 'v', 'ü': 'v' };
function stripTone(py) { return Array.from(py || '').map(c => TONE_MAP[c] || c).join(''); }
/* 构建某首诗"字→无声调古诗音"映射 */
function buildPoemPyMap(p) {
  const m = {};
  p.content.forEach((line, li) => {
    const pys = (POEM_PINYIN[p.id] || [])[li] || [];
    let pi = 0;
    for (const ch of line) {
      if (isHan(ch)) { m[ch] = stripTone(pys[pi] || ''); pi++; }
    }
  });
  return m;
}
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function stars(score) {
  if (score < 0) return '';
  const n = score >= 90 ? 5 : score >= 80 ? 4 : score >= 70 ? 3 : score >= 60 ? 2 : 1;
  return '★'.repeat(n) + '☆'.repeat(5 - n);
}

/* ---------- 渲染工具 ---------- */
function renderPoemLines(poem) {
  const pys = POEM_PINYIN[poem.id] || [];
  return poem.content.map((line, li) => {
    const pysLine = pys[li] || [];
    let pi = 0;
    const chars = Array.from(line).map(ch => {
      if (isHan(ch)) {
        const p = pysLine[pi] || '';
        pi++;
        return `<span class="py-char"><span class="py">${esc(p)}</span><span class="ch">${esc(ch)}</span></span>`;
      }
      return `<span class="py-char punct"><span class="py"></span><span class="ch">${esc(ch)}</span></span>`;
    }).join('');
    return `<div class="line" data-line="${li}">${chars}</div>`;
  }).join('');
}

/* ---------- 页面渲染 ---------- */
const UI = {
  app: document.getElementById('app'),

  topbar(title, sub, withBack) {
    return `<header class="topbar">
      ${withBack ? `<button class="back-btn" onclick="location.hash='#/'">‹</button>` : ''}
      <div style="flex:1;text-align:${withBack ? 'center' : 'left'}">
        <div class="title">${esc(title)}</div>
        ${sub ? `<div class="sub">${esc(sub)}</div>` : ''}
      </div>
      <button class="gear" onclick="location.hash='#/settings'">⚙️</button>
    </header>`;
  },

  tabs(active, vol) {
    return `<div class="tabs">
      <button class="tab-btn ${active === 1 ? 'active' : ''}" onclick="location.hash='#/${vol === 2 ? 'recite' : ''}'" data-vol="1">三年级上</button>
      <button class="tab-btn ${active === 2 ? 'active' : ''}" onclick="location.hash='#/${vol === 2 ? 'recite' : ''}'" data-vol="2">三年级下</button>
    </div>`;
  },

  /* 首页 */
  home() {
    const vol = parseInt(location.hash.replace('#/', '') || '1', 10) || 1;
    const list = POEMS.filter(p => p.vol === vol);
    const html = this.topbar('背古诗词搭子', '共60首 · 上下册', false) + this.tabs(vol, 1) +
      `<div class="poem-list">` + list.map(p => `
        <div class="poem-item" onclick="location.hash='#/poem/${p.id}'">
          <div class="idx">${p.id}</div>
          <div class="info">
            <div class="p-title">${esc(p.title)}</div>
            <div class="p-author">${esc(p.dynasty)} · ${esc(p.author)}</div>
          </div>
          <div class="p-count">已读 <b>${getViews(p.id)}</b> 次</div>
        </div>`).join('') + `</div>`;
    this.render(html);
    this.setNav('home');
  },

  /* 详情页 */
  detail(id) {
    const p = POEMS.find(x => x.id === id);
    if (!p) { location.hash = '#/'; return; }
    addView(id);
    const btnLabel = Reader.speaking && Reader.poem && Reader.poem.id === id ? '⏸ 停止朗读' : '🔊 朗读古诗';
    const html = this.topbar('古诗详情', '', true) + `<div class="detail">
      <div class="poem-head">
        <h2>${esc(p.title)}</h2>
        <div class="author-line">${esc(p.dynasty)} · ${esc(p.author)}</div>
      </div>
      <div class="read-btn-row">
        <button class="read-btn" id="read-main-btn" onclick="App.readPoem(${id})">${btnLabel}</button>
      </div>
      <div class="poem-card" id="poem-lines">${renderPoemLines(p)}</div>
      <div class="section open" id="sec-trans">
        <div class="sec-head" onclick="this.parentNode.classList.toggle('open')">
          <span class="t">📝 古诗解析</span>
          <span class="ha"><button class="sec-read" onclick="event.stopPropagation();App.readSection(${id}, 'trans')">🔊 听讲解</button><span class="arrow">▸</span></span>
        </div>
        <div class="sec-body">
          <div class="block"><div class="b-title">白话译文</div><p>${esc(p.translation)}</p></div>
          <div class="block"><div class="b-title">赏析</div><p>${esc(p.analysis)}</p></div>
        </div>
      </div>
      <div class="section open" id="sec-bg">
        <div class="sec-head" onclick="this.parentNode.classList.toggle('open')">
          <span class="t">🏯 创作背景</span>
          <span class="ha"><button class="sec-read" onclick="event.stopPropagation();App.readSection(${id}, 'bg')">🔊 听创作背景</button><span class="arrow">▸</span></span>
        </div>
        <div class="sec-body">
          <p>${esc(p.background)}</p>
        </div>
      </div>
      <div class="section open" id="sec-bio">
        <div class="sec-head" onclick="this.parentNode.classList.toggle('open')">
          <span class="t">👤 作者生平简介</span>
          <span class="ha"><button class="sec-read" onclick="event.stopPropagation();App.readSection(${id}, 'bio')">🔊 听古诗简介</button><span class="arrow">▸</span></span>
        </div>
        <div class="sec-body">
          <p>${esc(p.bio)}</p>
        </div>
      </div>
    </div>`;
    this.render(html);
    this.setNav('home');
  },

  highlightLine(poemId, idx) {
    const box = document.getElementById('poem-lines');
    if (!box) return;
    box.querySelectorAll('.line').forEach((el, i) => {
      el.classList.toggle('hl', i === idx);
    });
  },

  refreshReadBtn(id, playing) {
    const btn = document.getElementById('read-main-btn');
    if (btn) btn.innerHTML = playing ? '⏸ 停止朗读' : '🔊 朗读古诗';
  },

  /* 背诵列表 */
  reciteList() {
    const vol = parseInt(location.hash.replace('#/recite', '').replace('/', '') || '1', 10) || 1;
    const list = POEMS.filter(p => p.vol === vol);
    const html = this.topbar('背诵考核', '背诵 + 字词考试', false) + this.tabs(vol, 2) +
      `<div class="poem-list">` + list.map(p => {
        const rs = getReciteScore(p.id);
        const qs = getQuizScore(p.id);
        return `<div class="recite-item">
          <div class="info">
            <div class="p-title">${esc(p.title)}</div>
            <div class="p-author">${esc(p.dynasty)} · ${esc(p.author)}</div>
          </div>
          <div class="actions">
            <div class="status-row">
              <div class="status">${rs >= 0 ? `背诵 <b>${rs}</b>分 ${stars(rs)}` : '背诵未考'}</div>
              <div class="status">${qs >= 0 ? `字词 <b>${qs}</b>分 ${stars(qs)}` : '字词未考'}</div>
            </div>
            <div class="btn-row">
              <button class="btn recite" onclick="location.hash='#/recite/${p.id}'">🎤背诵</button>
              <button class="btn quiz" onclick="location.hash='#/quiz/${p.id}'">✏️字词</button>
            </div>
          </div>
        </div>`;
      }).join('') + `</div>`;
    this.render(html);
    this.setNav('recite');
  },

  /* 背诵详情（录音） */
  reciteDetail(id) {
    const p = POEMS.find(x => x.id === id);
    if (!p) { location.hash = '#/recite'; return; }
    const best = getReciteScore(id);
    const html = this.topbar('背诵考试', '', true) + `<div class="recite-detail">
      <div class="rd-title">${esc(p.title)}</div>
      <div class="rd-sub">${esc(p.dynasty)} · ${esc(p.author)} · 隐藏原文开始背诵吧</div>
      <div class="mic-wrap"><button class="mic-btn" id="mic-btn" onclick="App.toggleRecord(${id})">🎤</button></div>
      <div class="rec-timer" id="rec-timer">0.0 秒</div>
      <div class="rec-actions">
        <button class="btn play" id="play-rec" onclick="App.playRecording()" disabled>▶ 回放</button>
        <button class="btn toggle" id="toggle-orig" onclick="App.toggleOrig(${id})">👁 显示原文</button>
      </div>
      <div class="score-box hidden" id="score-box"></div>
      <div class="orig-box hidden" id="orig-box"></div>
    </div>`;
    this.render(html);
    this.setNav('recite');
  },

  /* 字词考试 */
  quiz(id) {
    const p = POEMS.find(x => x.id === id);
    if (!p || !p.quiz || !p.quiz.length) { location.hash = '#/recite'; return; }
    window.__quizState = { poem: p, idx: 0, score: 0, done: false };
    this.render(this.topbar('字词考试', esc(p.title), true) + `<div class="quiz-detail"><div class="q-card" id="q-card"></div></div>`);
    this.setNav('recite');
    App.renderQuizQ();
  },

  /* 设置 */
  settings() {
    const seg = (name, opts, val, isVol) => `<div class="seg">
      ${opts.map((o, i) => `<button class="seg-btn ${val === o.v ? 'active' : ''}" onclick="App.setSetting('${name}','${o.v}')">${o.label}</button>`).join('')}
    </div>`;
    const html = this.topbar('设置', '', true) + `<div class="settings">
      <div class="set-group">
        <div class="sg-title">🔊 朗读设置</div>
        <div class="set-row toggle-row"><div class="label">循环播放</div>
          <label class="switch"><input type="checkbox" ${settings.loop ? 'checked' : ''} onchange="App.setLoop(this.checked)"><span class="slider"></span></label>
        </div>
        <div class="set-row"><div class="label">朗读音量</div>${seg('readVol', [
          { label: '小', v: 's' }, { label: '中', v: 'm' }, { label: '大', v: 'l' }
        ], settings.readVol)}</div>
        <div class="set-row"><div class="label">背景音乐音量</div>${seg('bgmVol', [
          { label: '小', v: 's' }, { label: '中', v: 'm' }, { label: '大', v: 'l' }
        ], settings.bgmVol)}</div>
        <div class="set-row"><div class="label">朗读语速</div>${seg('speed', [
          { label: '慢', v: 's' }, { label: '中', v: 'm' }, { label: '快', v: 'l' }
        ], settings.speed)}</div>
      </div>
      <div class="set-group">
        <div class="sg-title">🎨 显示设置</div>
        <div class="set-row"><div class="label">页面字体大小</div>${seg('size', [
          { label: '小', v: 's' }, { label: '中', v: 'm' }, { label: '大', v: 'l' }
        ], settings.size)}</div>
        <div class="set-row"><div class="label">页面配色</div>${seg('theme', [
          { label: '绿色系', v: 'green' }, { label: '蓝色系', v: 'blue' }, { label: '黄色系', v: 'yellow' }
        ], settings.theme)}</div>
      </div>
      <div class="set-group">
        <div class="sg-title">📊 数据</div>
        <div class="set-row"><button class="btn" style="width:100%;padding:12px;border:none;border-radius:12px;background:#e74c3c;color:#fff;font-size:.95em;font-weight:700;cursor:pointer" onclick="App.clearData()">清空所有学习数据</button></div>
      </div>
    </div>`;
    this.render(html);
    this.setNav('settings');
  },

  render(html) { this.app.innerHTML = html; },
  setNav(active) {
    document.querySelectorAll('.nav-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.nav === active);
    });
  }
};

/* ---------- 应用入口 ---------- */
const App = {
  /* 朗读古诗原文 */
  readPoem(id) {
    const p = POEMS.find(x => x.id === id);
    if (!p) return;
    if (Reader.speaking && Reader.poem && Reader.poem.id === id) { Reader.stopAll(); return; }
    Reader.play(p);
  },

  readSection(id, kind) {
    const p = POEMS.find(x => x.id === id);
    if (!p) return;
    const text = kind === 'trans' ? (p.translation + '。' + p.analysis) : kind === 'bg' ? p.background : p.bio;
    Reader.speakSection(text, id);
  },

  /* 录音 */
  mediaRecorder: null, chunks: [], recStart: 0, recTimer: null, recUrl: null, recBlob: null,
  recognizer: null, recText: '', asrActive: false,

  toggleRecord(id) {
    const btn = document.getElementById('mic-btn');
    if (this.mediaRecorder && this.mediaRecorder.state === 'recording') { this.stopRecord(); return; }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      // 预加载本地语音识别（后台并行，录音结束前完成）
      loadWhisper().catch(() => {});
      const mr = new MediaRecorder(stream);
      this.mediaRecorder = mr;
      this.chunks = [];
      this.recStart = Date.now();
      mr.ondataavailable = e => { if (e.data.size) this.chunks.push(e.data); };
      mr.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(this.chunks, { type: mr.mimeType || 'audio/webm' });
        this.recUrl = URL.createObjectURL(blob);
        this.recBlob = blob;
        const dur = (Date.now() - this.recStart) / 1000;
        await this.finishRecord(id, dur);
      };
      mr.start();
      btn.classList.add('recording');
      btn.textContent = '⏹';
      this.startTimer();
      document.getElementById('play-rec').disabled = true;
      this.startAsr();
    }).catch(() => alert('无法访问麦克风，请检查浏览器权限设置'));
  },

  /* 语音识别：边录边识别，用于逐字正确率评分 */
  startAsr() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { this.asrActive = false; return; }
    try {
      const rec = new SR();
      rec.lang = 'zh-CN';
      rec.continuous = true;
      rec.interimResults = true;
      this.recognizer = rec;
      this.recText = '';
      this.asrActive = true;
      rec.onresult = e => {
        let final = '';
        for (let i = 0; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) final += r[0].transcript;
        }
        if (final) this.recText = final;
      };
      rec.onerror = () => { this.asrActive = false; };
      rec.onend = () => {
        // 连续识别中断时尝试重启（若仍在录音）
        if (this.mediaRecorder && this.mediaRecorder.state === 'recording' && this.asrActive) {
          try { rec.start(); } catch (e) {}
        }
      };
      rec.start();
    } catch (e) { this.asrActive = false; }
  },

  stopRecord() {
    if (this.mediaRecorder) { this.mediaRecorder.stop(); this.mediaRecorder = null; }
    if (this.recognizer) { try { this.recognizer.stop(); } catch (e) {} this.recognizer = null; }
    clearInterval(this.recTimer);
    const btn = document.getElementById('mic-btn');
    if (btn) { btn.classList.remove('recording'); btn.textContent = '🎤'; }
  },

  startTimer() {
    clearInterval(this.recTimer);
    const el = document.getElementById('rec-timer');
    this.recTimer = setInterval(() => {
      const t = ((Date.now() - this.recStart) / 1000);
      if (el) el.textContent = t.toFixed(1) + ' 秒';
    }, 100);
  },

  async finishRecord(id, dur) {
    const p = POEMS.find(x => x.id === id);
    const hanText = p.content.join('').replace(/[^\u4e00-\u9fff]/g, '');
    const totalHan = countHan(hanText);
    const box = document.getElementById('score-box');
    let score, mode;
    // ① 在线语音识别结果
    let transcript = (this.recText || '').replace(/[^\u4e00-\u9fff]/g, '');
    let asrOk = this.asrActive && transcript.length >= Math.max(4, totalHan * 0.25);
    if (!asrOk && this.recBlob && !whisperFailed) {
      // ② 在线识别不可用 → 离线 Whisper 本地识别（不依赖网络服务）
      if (box) {
        box.classList.remove('hidden');
        box.innerHTML = '<div class="big">⏳</div><div class="msg">正在本地语音识别（首次需加载约 40MB 模型，请稍候）…</div>';
      }
      const wtext = await whisperTranscribe(this.recBlob);
      const wclean = (wtext || '').replace(/[^\u4e00-\u9fff]/g, '');
      if (wclean.length >= Math.max(4, totalHan * 0.25)) {
        transcript = wclean;
        asrOk = true;
      }
    }
    if (asrOk) {
      // 逐字正确率评分（含同音容错）：原文用古诗音，识别文本用通用音
      const pyMap = buildPoemPyMap(p);
      const origChars = Array.from(hanText);
      const recChars = Array.from(transcript);
      const match = lcsMatch(origChars, recChars, (a, b) => {
        if (a === b) return true;
        const ap = pyMap[a] || (PY_MAP && PY_MAP[a]) || '';
        const bp = (PY_MAP && PY_MAP[b]) || '';
        return !!ap && !!bp && ap === bp;
      });
      score = Math.round(match / totalHan * 100);
      score = Math.max(0, Math.min(100, score));
      mode = (this.asrActive && this.recText) ? 'asr-online' : 'asr-local';
    } else {
      // ③ 降级：按朗读时长估算
      const ref = totalHan * 0.55;
      const dev = Math.abs(dur - ref) / ref;
      score = Math.round(100 - dev * 35);
      score = Math.max(55, Math.min(100, score));
      mode = 'time';
    }
    const best = setReciteScore(id, score);
    box.classList.remove('hidden');
    const modeTxt = mode === 'asr-online'
      ? '逐字正确率评分（在线语音识别）'
      : mode === 'asr-local'
        ? '逐字正确率评分（本地语音识别）'
        : '未能识别语音，按时长估算（请靠近麦克风清晰朗读）';
    box.innerHTML = `<div class="big">${score} 分</div>
      <div class="stars">${stars(score)}</div>
      <div class="msg">${score >= 90 ? '太棒了！背得又快又准！🎉' : score >= 80 ? '非常好！继续加油！' : score >= 70 ? '不错哦，再练几次会更好！' : '多听几遍朗读，你会背得更好！'}</div>
      <div class="msg" style="margin-top:6px;font-size:.8em">${modeTxt} · 用时 ${dur.toFixed(1)}秒 · 最佳成绩 ${best}分</div>`;
    const playBtn = document.getElementById('play-rec');
    playBtn.disabled = false;
  },

  playRecording() {
    if (!this.recUrl) return;
    const a = new Audio(this.recUrl);
    a.play().catch(() => alert('回放失败'));
  },

  toggleOrig(id) {
    const p = POEMS.find(x => x.id === id);
    const box = document.getElementById('orig-box');
    if (box.classList.contains('hidden')) {
      box.classList.remove('hidden');
      box.innerHTML = `<div class="ob-head">📜 原文对照</div><div class="poem-card" style="box-shadow:none;padding:8px 0">${renderPoemLines(p)}</div>`;
    } else {
      box.classList.add('hidden');
    }
  },

  /* 考试 */
  renderQuizQ() {
    const st = window.__quizState;
    if (!st) return;
    const card = document.getElementById('q-card');
    if (st.done) {
      const pct = st.score;
      card.innerHTML = `<div class="quiz-result">
        <div class="big">${pct} 分</div>
        <div class="stars">${stars(pct)}</div>
        <div class="msg">答对 ${st.correct} / ${st.total} 题 · ${pct >= 90 ? '太厉害了！' : pct >= 80 ? '非常棒！' : pct >= 60 ? '不错，再试试！' : '多学习几次再来挑战！'}</div>
        <button class="btn" onclick="location.hash='#/quiz/${st.poem.id}'">再考一次</button>
      </div>`;
      return;
    }
    const q = st.poem.quiz[st.idx];
    const total = st.poem.quiz.length;
    const prog = (st.idx / total * 100).toFixed(0);
    card.innerHTML = `<div class="q-progress">第 ${st.idx + 1} / ${total} 题
        <div class="bar"><i style="width:${prog}%"></i></div></div>
      <div class="q-text">${esc(q.q)}</div>
      <div class="q-opts">${q.opts.map((o, i) => `<button class="q-opt" data-i="${i}" onclick="App.answer(${i})">${esc(o)}</button>`).join('')}</div>
      <div class="q-feedback" id="q-fb"></div>
      <div class="q-next hidden" id="q-next"><button class="btn" onclick="App.nextQ()">下一题 ➡</button></div>`;
  },

  answer(i) {
    const st = window.__quizState;
    if (!st || st.locked) return;
    st.locked = true;
    const q = st.poem.quiz[st.idx];
    const opts = document.querySelectorAll('.q-opt');
    opts.forEach((el, j) => {
      el.disabled = true;
      if (j === q.a) el.classList.add('correct');
      else if (j === i) el.classList.add('wrong');
    });
    const fb = document.getElementById('q-fb');
    if (i === q.a) {
      st.score += Math.round(100 / st.poem.quiz.length);
      fb.className = 'q-feedback ok';
      fb.textContent = '✅ 答对了！真棒！';
    } else {
      fb.className = 'q-feedback no';
      fb.textContent = '❌ 答错了，正确答案是：' + q.opts[q.a];
    }
    document.getElementById('q-next').classList.remove('hidden');
  },

  nextQ() {
    const st = window.__quizState;
    st.idx++;
    st.locked = false;
    if (st.idx >= st.poem.quiz.length) {
      st.done = true;
      st.correct = Math.round(st.score / (100 / st.poem.quiz.length));
      st.total = st.poem.quiz.length;
      setQuizScore(st.poem.id, st.score);
      this.renderQuizQ();
    } else {
      this.renderQuizQ();
    }
  },

  /* 设置 */
  setSetting(name, val) {
    settings[name] = val;
    saveSettings();
    UI.settings();
    if (Reader.bgm) Reader.bgm.volume = BGMVOL[settings.bgmVol] * 0.6;
    if (Reader.audio) Reader.audio.volume = VOL[settings.readVol];
  },
  setLoop(v) { settings.loop = v; saveSettings(); if (Reader.audio) Reader.audio.loop = v; },
  clearData() {
    if (!confirm('确定清空所有学习数据吗？')) return;
    Object.keys(localStorage).forEach(k => { if (k.indexOf('gsp_') === 0) localStorage.removeItem(k); });
    location.hash = '#/';
    location.reload();
  },

  route() {
    const h = location.hash.replace(/^#/, '') || '/';
    if (h === '/' ) { UI.home(); }
    else if (/^\/poem\/(\d+)$/.test(h)) { UI.detail(parseInt(h.match(/^\/poem\/(\d+)$/)[1], 10)); }
    else if (h === '/recite' || /^\/recite\/$/.test(h)) { UI.reciteList(); }
    else if (/^\/recite\/(\d+)$/.test(h)) { UI.reciteDetail(parseInt(h.match(/^\/recite\/(\d+)$/)[1], 10)); }
    else if (/^\/quiz\/(\d+)$/.test(h)) { UI.quiz(parseInt(h.match(/^\/quiz\/(\d+)$/)[1], 10)); }
    else if (h === '/settings') { UI.settings(); }
    else { location.hash = '#/'; }
    window.scrollTo(0, 0);
  }
};

/* ---------- 启动 ---------- */
saveSettings();
window.addEventListener('hashchange', () => { Reader.stopAll(); App.route(); });
document.querySelectorAll('.nav-btn').forEach(b => {
  b.addEventListener('click', () => {
    Reader.stopAll();
    location.hash = '#' + (b.dataset.nav === 'home' ? '/' : b.dataset.nav === 'recite' ? '/recite' : '/settings');
  });
});
window.App = App;
App.route();
})();
