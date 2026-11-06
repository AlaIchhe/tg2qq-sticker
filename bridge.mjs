#!/usr/bin/env node
/**
 * tg2qq-sticker — Telegram 贴纸 → QQ 收藏表情
 *
 * TG 侧：你私聊自己的 bot（Bot API 长轮询），发贴纸/图片过来
 * QQ 侧：本机 NapCat 的 OneBot WS，调 add_custom_face 存进收藏
 *
 * 输出格式（由 config.format 决定，默认 gif）：
 *   .webp 静态     -> PNG
 *   .webm 视频贴纸 -> GIF 240x240 / 50fps（保留透明）
 *   .tgs  Lottie   -> rlottie 逐帧渲染 -> GIF 240x240 / 50fps
 *
 * 为什么动态图默认用 GIF 而不是 APNG/WebP：
 *   QQ 播放 APNG / 动态 WebP 时每帧固定约 100ms（等于压到 10fps），
 *   只有 GIF 的帧延时（1/100 秒，最小 2cs）会被精确执行。
 *   详见 docs/qq-format-compatibility.md
 *
 * 已知 QQ 行为：
 *   - 相同 md5 重复 add 会被静默忽略（retcode 仍为 0，数量不变）
 *   - fetch_custom_face_detail 返回顺序是「最新在前」，list[0] 是最新一张
 *   - set_custom_face_desc 需要 emoji_id / res_id / md5 / desc 四项齐全
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.TGQQ_HOME || HERE;
const TOKEN_FILE = path.join(ROOT, 'token');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const STATE_FILE = path.join(ROOT, 'state.json');
const SEEN_FILE = path.join(ROOT, 'seen.json');
const TMP = path.join(ROOT, 'tmp');
const RENDER_PY = path.join(ROOT, 'render-tgs.py');

function log(...a) { console.log(new Date().toISOString(), ...a); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function loadJSON(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } }
function saveJSON(f, o) { fs.writeFileSync(f, JSON.stringify(o, null, 2) + '\n'); }
function readToken() {
  let t = '';
  try { t = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch {}
  if (!t) t = process.env.TG_BOT_TOKEN || '';
  return t.replace(/\s+/g, '');
}
function md5hex(buf) { return crypto.createHash('md5').update(buf).digest('hex').toUpperCase(); }
function nowStr() { return new Date().toISOString().slice(0, 19).replace('T', ' '); }

const DEFAULTS = {
  onebot: { ws: 'ws://127.0.0.1:3001' },
  allowUsers: [],
  size: 240,
  fps: 20,
  descMode: 'emoji',
  format: 'gif',
  // 收到贴纸时的默认模式：single=只存这一张，group=导入整个表情包
  mode: 'single',
  // 收藏上传用的临时目录：宿主机路径 + NapCat 容器内能看到同一目录的路径
  favHostDir: '/root/work/wakaba/tgqq-tmp',
  favContainerDir: '/data/wakaba/tgqq-tmp',
  // rlottie 渲染器（独立 venv，避免污染系统 python）
  lottiePython: process.env.LOTTIE_PY || '/opt/lottie-venv/bin/python',
};
const cfg = Object.assign({}, DEFAULTS, loadJSON(CONFIG_FILE, {}));

const FAV_HOST_DIR = cfg.favHostDir;
const FAV_CONTAINER_DIR = cfg.favContainerDir;
const VENV_PY = cfg.lottiePython;
const state = Object.assign({ offset: 0 }, loadJSON(STATE_FILE, {}));
let stickerMode = ['group', 'send', 'zip'].includes(cfg.mode) ? cfg.mode : 'single';
const seen = loadJSON(SEEN_FILE, {});

let chain = Promise.resolve();
function serialize(fn) { const p = chain.then(fn); chain = p.catch(() => {}); return p; }

// ---------------- OneBot ----------------
class OneBot {
  constructor(url) { this.url = url; this.ws = null; this.seq = 0; this.pending = new Map(); this.connecting = null; this.closed = false; }
  connect() {
    if (this.ws && this.ws.readyState === 1) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      const to = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('napcat ws timeout')); }, 15000);
      ws.addEventListener('open', () => { clearTimeout(to); this.ws = ws; this.connecting = null; log('[onebot] connected'); resolve(); });
      ws.addEventListener('message', ev => {
        let d; try { d = JSON.parse(ev.data.toString()); } catch { return; }
        if (d.echo && this.pending.has(d.echo)) { this.pending.get(d.echo)(d); this.pending.delete(d.echo); }
      });
      const dead = () => {
        clearTimeout(to); this.ws = null; this.connecting = null;
        for (const [, r] of this.pending) r({ retcode: -1, message: 'napcat disconnected' });
        this.pending.clear();
        if (!this.closed) setTimeout(() => this.connect().catch(() => {}), 3000);
      };
      ws.addEventListener('close', dead);
      ws.addEventListener('error', () => { clearTimeout(to); this.connecting = null; reject(new Error('napcat ws error')); });
    });
    return this.connecting;
  }
  async call(action, params = {}, timeoutMs = 60000) {
    await this.connect();
    const echo = 'f' + (++this.seq);
    return new Promise((resolve, reject) => {
      this.pending.set(echo, resolve);
      try { this.ws.send(JSON.stringify({ action, params, echo })); }
      catch (e) { this.pending.delete(echo); return reject(e); }
      setTimeout(() => { if (this.pending.has(echo)) { this.pending.delete(echo); reject(new Error('timeout ' + action)); } }, timeoutMs);
    });
  }
}
const ob = new OneBot(cfg.onebot.ws);

// ---------------- Telegram ----------------
function makeTG(token) {
  const base = 'https://api.telegram.org/bot' + token;
  async function raw(method, params) {
    for (let i = 0; i < 6; i++) {
      try {
        const r = await fetch(base + '/' + method, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(params), signal: AbortSignal.timeout(120000),
        });
        const j = await r.json().catch(() => ({ ok: false, description: 'bad json' }));
        if (!j.ok) {
          if (j.error_code === 401) throw new Error('token 无效 (401)');
          if (j.error_code === 409) { await sleep(3000); continue; }
          if (j.error_code === 429) {
            const wait = Math.min(60, (j.parameters && j.parameters.retry_after) || 3);
            log('[tg] 429 rate limited, retry in ' + wait + 's');
            await sleep(wait * 1000);
            continue;
          }
          throw new Error(method + ': ' + (j.description || JSON.stringify(j)));
        }
        return j.result;
      } catch (e) {
        if (e.message.includes('token 无效')) throw e;
        if (i === 3) throw e;
        await sleep(2000 * (i + 1));
      }
    }
  }
  return {
    api: raw,
    getUpdates: (offset) => raw('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] }),
    sendMessage: (chat_id, text) => raw('sendMessage', { chat_id, text, link_preview_options: { is_disabled: true } }),
    getFile: (file_id) => raw('getFile', { file_id }),
    download: async (file_path) => {
      const r = await fetch('https://api.telegram.org/file/bot' + token + '/' + file_path, { signal: AbortSignal.timeout(120000) });
      if (!r.ok) throw new Error('download ' + r.status);
      return Buffer.from(await r.arrayBuffer());
    },
    // multipart 上传（Bot API 只接受 multipart 发文件，raw() 的 JSON 通道不行）
    sendDocument: async (chat_id, filePath, caption) => {
      const form = new FormData();
      form.append('chat_id', String(chat_id));
      if (caption) form.append('caption', caption);
      form.append('document', new Blob([fs.readFileSync(filePath)]), path.basename(filePath));
      const r = await fetch(base + '/sendDocument', { method: 'POST', body: form, signal: AbortSignal.timeout(600000) });
      const j = await r.json().catch(() => ({ ok: false, description: 'bad json' }));
      if (!j.ok) throw new Error('sendDocument: ' + (j.description || JSON.stringify(j)));
      return j.result;
    },
  };
}

// ---------------- ffmpeg ----------------
function run(cmd, args, timeoutMs = 120000, cwd = undefined) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => { err += d.toString(); });
    const to = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(cmd + ' timeout')); }, timeoutMs);
    p.on('error', e => { clearTimeout(to); reject(e); });
    p.on('close', code => { clearTimeout(to); code === 0 ? resolve() : reject(new Error(cmd + ' exit ' + code + ': ' + err.slice(-400))); });
  });
}

const SIZE = cfg.size || 240;
const FPS = cfg.fps || 20; // QQ 按固定 ~50ms/帧 播放，20fps 才能对上它的节奏

async function webmToApng(inPath, outPath) {
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-c:v', 'libvpx-vp9', '-i', inPath,
    '-vf', 'fps=' + FPS + ',scale=' + SIZE + ':' + SIZE + ':flags=lanczos',
    '-plays', '0', '-f', 'apng', '-pix_fmt', 'rgba', outPath]);
}

async function tgsToApng(inPath, outPath) {
  const frameDir = path.join(TMP, 'frames_' + Date.now());
  fs.rmSync(frameDir, { recursive: true, force: true });
  fs.mkdirSync(frameDir, { recursive: true });
  try {
    await run(VENV_PY, [RENDER_PY, inPath, frameDir, String(SIZE), String(FPS)], 300000);
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS),
      '-i', path.join(frameDir, 'f_%04d.png'), '-plays', '0', '-f', 'apng', '-pix_fmt', 'rgba', outPath]);
  } finally {
    fs.rmSync(frameDir, { recursive: true, force: true });
  }
}

// 实测结论（2026-11-02，用数字计时器贴纸测出来的）：
//   - GIF：QQ 严格按 1/100 秒的帧延时播放，最小 2cs(20ms) 也认 → 可到 50fps。
//   - APNG：QQ 每帧固定/至少约 100ms（等于把动画压到 ≤10fps），文件里写 1/60、
//     2/100 都一样。所以帧数越多播得越久：10 帧≈1s、50 帧≈5s、72 帧≈7s。
//   - 推论：APNG 在 QQ 里最顺也只能 10fps，且时长会失真；GIF 能到 50fps 且时长准确。
//     动态贴纸统一用 GIF 50fps。
const GIF_FPS = 50; // 每帧 20ms，GIF 延时单位 1/100 秒

async function webmToGif(inPath, outPath) {
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-c:v', 'libvpx-vp9', '-i', inPath,
    '-vf', 'fps=' + GIF_FPS + ',scale=' + SIZE + ':' + SIZE +
      ':flags=lanczos,split[a][b];[a]palettegen=reserve_transparent=1:stats_mode=diff[p];[b][p]paletteuse=alpha_threshold=128:dither=none',
    '-loop', '0', outPath]);
}

async function tgsToGif(inPath, outPath) {
  const frameDir = path.join(TMP, 'giframes_' + Date.now());
  fs.rmSync(frameDir, { recursive: true, force: true });
  fs.mkdirSync(frameDir, { recursive: true });
  try {
    await run(VENV_PY, [RENDER_PY, inPath, frameDir, String(SIZE), String(GIF_FPS)], 300000);
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(GIF_FPS),
      '-i', path.join(frameDir, 'f_%04d.png'),
      '-vf', 'split[a][b];[a]palettegen=reserve_transparent=1:stats_mode=diff[p];[b][p]paletteuse=alpha_threshold=128:dither=none',
      '-loop', '0', outPath]);
  } finally {
    fs.rmSync(frameDir, { recursive: true, force: true });
  }
}

async function toPng(inPath, outPath) {
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', inPath, '-frames:v', '1', outPath]);
}

// ---------------- 收藏 ----------------
function extOf(p, def) { const m = /\.([a-z0-9]+)$/i.exec(p || ''); return m ? m[1].toLowerCase() : def; }

async function favList() {
  const r = await ob.call('fetch_custom_face_detail', { count: 1000 }, 60000);
  if (r.retcode !== 0) throw new Error('fetch_custom_face_detail ' + r.retcode + ' ' + (r.message || ''));
  return Array.isArray(r.data) ? r.data : [];
}

async function setDesc(item, desc) {
  if (!desc || !item) return false;
  const r = await ob.call('set_custom_face_desc', {
    emoji_id: item.emoId ?? 0, res_id: item.resId, md5: item.md5, desc,
  }, 30000);
  if (r.retcode !== 0) { log('[desc] fail', r.retcode, r.message || r.wording || ''); return false; }
  return true;
}

async function evalAdd(buf, ext, fmt, desc = '') {
  const md5 = md5hex(buf);
  const before = await favList();
  if (before.some(x => (x.md5 || '').toUpperCase() === md5)) {
    return { status: 'exists', md5, count: before.length };
  }
  fs.mkdirSync(FAV_HOST_DIR, { recursive: true });
  const name = 'tg_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex') + '.' + ext;
  const hostPath = path.join(FAV_HOST_DIR, name);
  fs.writeFileSync(hostPath, buf);
  let r;
  try {
    r = await ob.call('add_custom_face', { file: FAV_CONTAINER_DIR + '/' + name, is_origin: true }, 90000);
  } finally {
    try { fs.unlinkSync(hostPath); } catch {}
  }
  if (r.retcode !== 0) throw new Error('add_custom_face retcode=' + r.retcode + ' ' + (r.message || r.wording || ''));

  const after = await favList();
  const added = after.find(x => (x.md5 || '').toUpperCase() === md5);
  let descOk = false;
  if (added && desc) descOk = await setDesc(added, desc);
  seen[md5] = { resId: added ? added.resId : null, fmt, desc: desc || '', at: nowStr() };
  const keys = Object.keys(seen);
  if (keys.length > 3000) for (const k of keys.slice(0, keys.length - 3000)) delete seen[k];
  saveJSON(SEEN_FILE, seen);
  return { status: added ? 'added' : 'unknown', md5, count: after.length, resId: added ? added.resId : null, desc, descOk };
}

async function deleteNewest() {
  const list = await favList();
  if (!list.length) return { status: 'empty' };
  // 只删「我们加过、且现在还存在的」最近一张；绝不盲删用户原有的收藏
  const ours = Object.entries(seen)
    .filter(([, v]) => v.resId)
    .sort((a, b) => String(b[1].at).localeCompare(String(a[1].at)));
  let target = null, key = null;
  for (const [md5, v] of ours) {
    const hit = list.find(x => x.resId === v.resId);
    if (hit) { target = hit; key = md5; break; }
  }
  if (!target) return { status: 'none-tracked', count: list.length };
  const r = await ob.call('delete_custom_face', { ids: [target.resId] }, 60000);
  if (r.retcode !== 0) throw new Error('delete_custom_face ' + r.retcode + ' ' + (r.message || ''));
  if (key) { delete seen[key]; saveJSON(SEEN_FILE, seen); }
  const after = await favList();
  return { status: 'deleted', md5: (target.md5 || '').toUpperCase(), resId: target.resId, count: after.length };
}

async function deleteFavorites(ids) {
  let deleted = 0;
  const failed = [];
  for (let i = 0; i < ids.length; i += 40) {
    const batch = ids.slice(i, i + 40);
    const r = await ob.call('delete_custom_face', { ids: batch }, 120000);
    if (r.retcode === 0) deleted += batch.length;
    else failed.push((r.message || r.wording || ('retcode ' + r.retcode)));
    await sleep(600); // 给 QQ 侧留点喘息时间
  }
  await sleep(800);
  const after = await favList();
  return { deleted, failed, count: after.length };
}

async function deleteAllFavorites() {
  const list = await favList();
  const ids = list.map(x => x.resId).filter(Boolean);
  if (!ids.length) return { status: 'empty', count: 0 };
  const r = await deleteFavorites(ids);
  // 记录过的一并清掉，避免 /del 指向已删除的 resId
  const alive = new Set((await favList()).map(x => x.resId));
  let dropped = 0;
  for (const k of Object.keys(seen)) {
    if (!seen[k] || !seen[k].resId || !alive.has(seen[k].resId)) { delete seen[k]; dropped++; }
  }
  if (dropped) saveJSON(SEEN_FILE, seen);
  return Object.assign({ status: 'deleted', total: ids.length }, r);
}

// ---------------- 交互 ----------------
function parsePackArg(text) {
  const arg = text.split(/\s+/).slice(1).join(' ').trim();
  if (!arg) return '';
  const link = arg.match(/t\.me\/addstickers\/([A-Za-z0-9_]+)/i);
  if (link) return link[1];
  const bare = arg.match(/^([A-Za-z][A-Za-z0-9_]{2,})$/);
  if (bare) return bare[1];
  return '';
}

let deleteAllArmedAt = 0;
function helpText() {
  return [
    'TG → QQ 收藏表情',
    '',
    '发贴纸 → 按当前模式存进 QQ 收藏表情（不往 QQ 发任何消息）',
    '  single 模式：每张单独存；group 模式：自动导入整包',
    '  /single 或 /group 切换模式（会记住）',
    '  静态 .webp  → PNG',
    '  动态 .webm  → GIF 240×240 50fps（保留透明）',
    '  动态 .tgs   → rlottie 渲染成 GIF（保留透明）',
    '相同内容只会存一份，重复发会被识别出来。',
    '',
    '模式（会记住，直到下次切换）：',
    '  /single → 之后发贴纸，只存这一张（默认）',
    '  /group  → 之后发贴纸，自动导入它所在的整个表情包',
    '  /group t.me/addstickers/包名 → 立即导入指定包（同时切到 group）',
    '  /send <QQ号> → 之后发贴纸，全部转发给这个好友，不写收藏',
    '  /zip → 之后发贴纸，把整包转换后打成一个 zip 发回来（不写收藏）',
    '（single / group 不带斜杠也认）',
    '',
    'QQ 只认 GIF 的帧延时，APNG 会被按固定短间隔播放（变快），所以动态贴纸一律转 GIF 50fps',
    '',
    '/send <QQ号>  切到 send 模式：之后每张贴纸都转发给该好友（不写收藏）',
    '/zip  切到 zip 模式：之后发一张贴纸，把它所在整包转成 zip 发回来',
    '/count  当前收藏数量',
    '/delete_all  删除收藏里全部表情（需再发 /delete_all confirm 确认，60 秒内有效）',
    '/del    删掉最近存进去的一张',
    '/id     看自己的 TG id',
    '/help',
  ].join('\n');
}

const packTitleCache = new Map();
async function packTitle(tg, setName) {
  if (!setName) return '';
  if (packTitleCache.has(setName)) return packTitleCache.get(setName);
  let title = '';
  try {
    const s = await tg.api('getStickerSet', { name: setName });
    title = s.title || '';
  } catch (e) { log('[pack] title fail', setName, e.message); }
  packTitleCache.set(setName, title);
  return title;
}

const DESC_MODES = ['emoji', 'pack', 'both', 'none'];
async function buildDesc(tg, st) {
  const mode = DESC_MODES.includes(cfg.descMode) ? cfg.descMode : 'emoji';
  const parts = [];
  if (mode === 'emoji' || mode === 'both') { if (st.emoji) parts.push(st.emoji); }
  if (mode === 'pack' || mode === 'both') {
    const t = await packTitle(tg, st.set_name);
    if (t) parts.push(t);
  }
  return parts.join(' ').trim();
}

async function renderSticker(tg, st) {
  const kind = st.is_video ? 'webm' : st.is_animated ? 'tgs' : 'webp';
  if ((st.file_size || 0) > 10 * 1024 * 1024) throw new Error('文件超过 10MB');

  const file = await tg.getFile(st.file_id);
  const src = await tg.download(file.file_path);

  fs.mkdirSync(TMP, { recursive: true });
  const ts = Date.now();
  const inPath = path.join(TMP, 'in_' + ts + '.' + kind);
  const outPath = path.join(TMP, 'out_' + ts + '.png');
  fs.writeFileSync(inPath, src);

  const wantGif = (cfg.format || 'gif') === 'gif'; // GIF 的帧延时 QQ 认得，APNG 的不认
  const dynExt = wantGif ? 'gif' : 'png';
  const dynPath = outPath.replace(/\.png$/, '.' + dynExt);
  let outBuf, fmt, outExt;
  try {
    if (kind === 'tgs') {
      if (wantGif) { await tgsToGif(inPath, dynPath); fmt = 'GIF 动态'; }
      else { await tgsToApng(inPath, dynPath); fmt = 'APNG 动态'; }
    } else if (kind === 'webm') {
      if (wantGif) { await webmToGif(inPath, dynPath); fmt = 'GIF 动态'; }
      else { await webmToApng(inPath, dynPath); fmt = 'APNG 动态'; }
    } else {
      // 静态贴纸一律输出真 PNG：ffmpeg 按输出扩展名选编码器，
      // 若沿用它会因 dynPath 以 .gif 结尾而写成 GIF（GIF 只有 1-bit 透明，
      // 半透明像素会被抹平），随后又按 .png 发送 —— 之前半透明丢失就是这个。
      await toPng(inPath, outPath); fmt = 'PNG 静态';
      outExt = 'png';
    }
    outBuf = fs.readFileSync(outExt === 'png' ? outPath : dynPath);
    outExt = outExt || dynExt;
  } finally {
    for (const p of [inPath, outPath, dynPath]) { try { fs.unlinkSync(p); } catch {} }
  }

  return { buf: outBuf, ext: outExt, fmt };
}

async function saveOne(tg, st) {
  const { buf, ext, fmt } = await renderSticker(tg, st);
  const desc = await buildDesc(tg, st);
  const r = await evalAdd(buf, ext, fmt, desc);
  return Object.assign({}, r, { fmt, bytes: buf.length, desc });
}

// 单张转发给好友：只发图片消息，不碰收藏。
// QQ 的"表情"消息（mface）只认商店表情的 emoji_package_id/emoji_id/key，
// 收藏表情的 emoId 恒为 0，所以只能以图片形式发出（透明 GIF 在聊天里就是动图）。
async function sendStickerToFriend(tg, st, uin) {
  const { buf, ext, fmt } = await renderSticker(tg, st);
  fs.mkdirSync(FAV_HOST_DIR, { recursive: true });
  const name = 'tgsend_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex') + '.' + ext;
  const hostPath = path.join(FAV_HOST_DIR, name);
  fs.writeFileSync(hostPath, buf);
  try {
    const r = await ob.call('send_private_msg', {
      user_id: Number(uin),
      message: [{ type: 'image', data: { file: FAV_CONTAINER_DIR + '/' + name } }],
    }, 60000);
    if (r.retcode !== 0) throw new Error('retcode=' + r.retcode + ' ' + (r.message || r.wording || ''));
    return { status: 'sent', fmt, bytes: buf.length, messageId: r.data && r.data.message_id };
  } finally {
    try { fs.unlinkSync(hostPath); } catch {}
  }
}

function formatOne(r) {
  if (r.status === 'exists') return '这张已经在收藏里了（' + r.fmt + '，重复添加会被 QQ 忽略）。\n收藏总数：' + r.count;
  const note = r.bytes > 5 * 1048576 ? '（' + (r.bytes / 1048576).toFixed(1) + 'MB，偏大）' : '';
  const descLine = r.desc ? '\n备注：' + r.desc + (r.descOk === false ? '（写入失败）' : '') : '';
  return '已存进 QQ 收藏：' + r.fmt + '，' + (r.bytes / 1024).toFixed(0) + 'KB' + note + descLine + '\n收藏总数：' + r.count + (r.status === 'unknown' ? '\n（提示：没在列表里找到它，可能被 QQ 拒收了）' : '');
}

async function saveSticker(tg, st, reply) {
  return reply(formatOne(await saveOne(tg, st)));
}

async function savePack(tg, setName, reply) {
  log('[pack] import start:', setName);
  const set = await tg.api('getStickerSet', { name: setName });
  const list = set.stickers || [];
  log('[pack]', setName, 'title=', set.title || '?', 'stickers=', list.length);
  if (!list.length) return reply('这个表情包里没有贴纸。');

  const status = await reply('开始导入「' + set.title + '」，共 ' + list.length + ' 张…\n（动态贴纸要逐张渲染，可能需要几分钟）');
  const mid = status && status.message_id;
  const chatId = status && status.chat && status.chat.id;

  let added = 0, exists = 0;
  const failed = [];
  let lastEdit = 0;
  for (let i = 0; i < list.length; i++) {
    const st = list[i];
    try {
      const r = await saveOne(tg, st);
      if (r.status === 'added') added++;
      else if (r.status === 'exists') exists++;
      else failed.push((st.emoji || '?') + ': 未确认');
    } catch (e) {
      failed.push((st.emoji || '?') + ': ' + String(e.message).slice(0, 60));
      log('[pack] item fail', i, e.message);
    }
    const now = Date.now();
    if (mid && chatId && (now - lastEdit > 4000 || i === list.length - 1)) {
      lastEdit = now;
      await tg.api('editMessageText', {
        chat_id: chatId, message_id: mid,
        text: '导入中 ' + (i + 1) + '/' + list.length + '：新增 ' + added + '，跳过 ' + exists + '，失败 ' + failed.length,
      }).catch(() => {});
    }
    await sleep(400); // 给 QQ 侧留点喘息时间
  }

  const total = (await favList()).length;
  const failLine = failed.length ? '\n失败前几条：\n' + failed.slice(0, 6).join('\n') + (failed.length > 6 ? '\n…' : '') : '';
  return reply('完成：「' + set.title + '」\n新增 ' + added + ' 张，跳过 ' + exists + ' 张，失败 ' + failed.length + ' 张' + failLine + '\n当前收藏总数：' + total);
}

function safeName(s) {
  return String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24);
}

// 整包打包：沿用 renderSticker 的格式映射（静态 webp→PNG，动态 webm/tgs→GIF），
// 逐张转换后塞进一个 zip，再用 sendDocument 发回来。
async function packZip(tg, setName, reply) {
  const set = await tg.api('getStickerSet', { name: setName });
  const list = set.stickers || [];
  log('[zip] set', setName, 'title=', set.title || '?', 'count=', list.length);
  if (!list.length) return reply('这个表情包里没有贴纸。');

  const status = await reply('开始转换「' + set.title + '」，共 ' + list.length + ' 张…\n（动态贴纸逐张渲染，可能要几分钟）');
  const mid = status && status.message_id;
  const chatId = status && status.chat && status.chat.id;

  fs.mkdirSync(TMP, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TMP, 'zip_'));
  const manifest = ['set: ' + set.name, 'title: ' + set.title, 'count: ' + list.length, ''];
  const failed = [];
  const files = [];
  let ok = 0;
  let lastEdit = 0;
  let zipPath = null;
  try {
    for (let i = 0; i < list.length; i++) {
      const st = list[i];
      try {
        const { buf, ext, fmt } = await renderSticker(tg, st);
        const name = String(i + 1).padStart(3, '0') + (st.emoji ? '_' + safeName(st.emoji) : '') + '.' + ext;
        fs.writeFileSync(path.join(dir, name), buf);
        files.push(name);
        manifest.push(name + '\t' + fmt + '\t' + (st.emoji || '') + '\t' + buf.length + ' bytes');
        ok++;
      } catch (e) {
        failed.push((i + 1) + ': ' + String(e.message).slice(0, 80));
        log('[zip] item fail', i, e.message);
      }
      const now = Date.now();
      if (mid && chatId && (now - lastEdit > 4000 || i === list.length - 1)) {
        lastEdit = now;
        await tg.api('editMessageText', {
          chat_id: chatId, message_id: mid,
          text: '转换中 ' + (i + 1) + '/' + list.length + '：成功 ' + ok + '，失败 ' + failed.length,
        }).catch(() => {});
      }
    }
    if (!files.length) {
      return reply('「' + set.title + '」一张都没转换成功。\n' + failed.slice(0, 5).join('\n'));
    }
    fs.writeFileSync(path.join(dir, 'manifest.txt'), manifest.join('\n') + '\n');
    zipPath = path.join(TMP, 'pack_' + Date.now() + '.zip');
    await run('zip', ['-q', '-9', zipPath, ...files, 'manifest.txt'], 600000, dir);
    const size = fs.statSync(zipPath).size;
    if (size > 48 * 1048576) {
      return reply('转换完成，但压缩包 ' + (size / 1048576).toFixed(1) + 'MB，超过 Bot API 的 50MB 上限，发不出去。\n（可以改用 /group 直接导入收藏，或者告诉我按分包发。）');
    }
    const cap = '「' + set.title + '」共 ' + list.length + ' 张：成功 ' + ok + '，失败 ' + failed.length + '\n' + (size / 1048576).toFixed(2) + 'MB';
    await tg.sendDocument(chatId, zipPath, cap);
    log('[zip] sent', setName, size);
    return null;
  } finally {
    try { if (zipPath) fs.unlinkSync(zipPath); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function saveImage(tg, msg, reply) {
  let fileId, suggested;
  if (msg.photo && msg.photo.length) fileId = msg.photo[msg.photo.length - 1].file_id;
  else if (msg.document) { fileId = msg.document.file_id; suggested = msg.document.file_name; }
  else if (msg.animation) { fileId = msg.animation.file_id; suggested = msg.animation.file_name; }
  if (!fileId) return reply('这个类型不支持。');

  const file = await tg.getFile(fileId);
  const src = await tg.download(file.file_path);
  const srcExt = extOf(suggested || file.file_path, 'jpg');

  let outBuf, ext, fmt;
  if (['gif', 'webp', 'png'].includes(srcExt)) {
    outBuf = src; ext = srcExt; fmt = srcExt.toUpperCase();
  } else {
    fs.mkdirSync(TMP, { recursive: true });
    const ts = Date.now();
    const inPath = path.join(TMP, 'img_' + ts + '.' + srcExt);
    const outPath = path.join(TMP, 'img_' + ts + '.png');
    fs.writeFileSync(inPath, src);
    try { await toPng(inPath, outPath); outBuf = fs.readFileSync(outPath); }
    finally { for (const p of [inPath, outPath]) { try { fs.unlinkSync(p); } catch {} } }
    ext = 'png'; fmt = 'PNG 静态';
  }

  const r = await evalAdd(outBuf, ext, fmt);
  if (r.status === 'exists') return reply('这张已经在收藏里了。\n收藏总数：' + r.count);
  return reply('已存进 QQ 收藏：' + fmt + '，' + (outBuf.length / 1024).toFixed(0) + 'KB\n收藏总数：' + r.count + (r.status === 'unknown' ? '\n（提示：没在列表里找到它，可能被 QQ 拒收了）' : ''));
}

async function onMessage(tg, msg) {
  const from = msg.from || {};
  const chat = msg.chat || {};
  const uid = from.id;
  const reply = t => tg.sendMessage(chat.id, t).catch(e => { log('[reply fail]', e.message); return null; });

  if (chat.type !== 'private') { log('[skip] non-private', chat.type); return; }

  if (!cfg.allowUsers.includes(uid)) {
    if (cfg.allowUsers.length === 0) {
      cfg.allowUsers.push(uid);
      saveJSON(CONFIG_FILE, cfg);
      log('[bind] first user', uid, from.username || '');
      await reply('已绑定到你的 TG 账号（' + uid + '）。\n\n' + helpText());
      return;
    }
    log('[deny] unauthorised', uid);
    await reply('没有权限，owner 是 ' + cfg.allowUsers.join(',') + '，你是 ' + uid);
    return;
  }

  const text = (msg.text || msg.caption || '').trim();
  let cmd = text.startsWith('/') ? text.split(/\s+/)[0].toLowerCase().replace(/@.*$/, '') : '';
  if (!cmd) {
    const bare = text.toLowerCase();
    if (['single', 'group', 'pack', 'zip', 'count', 'del', 'help', 'id', 'start'].includes(bare)) cmd = '/' + bare;
  }

  try {
    if (msg.sticker) {
      if (stickerMode === 'send') {
        const target = String(cfg.sendTo || '');
        if (!/^\d{5,12}$/.test(target)) {
          return void await reply('send 模式还没设目标好友。发 /send <好友QQ号> 设一个，或者 /single 切回收藏模式。');
        }
        return void await serialize(async () => {
          try {
            const r = await sendStickerToFriend(tg, msg.sticker, target);
            return void await reply('已转发给 ' + target + '：' + r.fmt + '，' + (r.bytes / 1024).toFixed(0) + 'KB');
          } catch (e) {
            return void await reply('转发失败：' + e.message + '\n（对方不是好友、或设置了不接受私聊）');
          }
        });
      }
      if (stickerMode === 'zip') {
        if (!msg.sticker.set_name) {
          return void await reply('当前是 zip 模式，但这张贴纸不在公开表情包里（自定义表情没有 set_name），打不了包。\n发 /single 切回单张模式。');
        }
        return void await serialize(() => packZip(tg, msg.sticker.set_name, reply));
      }
      if (stickerMode === 'group') {
        if (!msg.sticker.set_name) {
          return void await reply('当前是 group 模式，但这张贴纸不在公开表情包里（自定义表情没有 set_name），导不了整包。\n发 /single 切回单张模式。');
        }
        return void await serialize(() => savePack(tg, msg.sticker.set_name, reply));
      }
      return void await serialize(() => saveSticker(tg, msg.sticker, reply));
    }
    if (msg.photo || msg.document || msg.animation) return void await serialize(() => saveImage(tg, msg, reply));

    const replied = msg.reply_to_message || msg.external_reply || null;
    const repliedSticker = replied && replied.sticker ? replied.sticker : null;

    function setMode(next) {
      stickerMode = next;
      cfg.mode = next;
      saveJSON(CONFIG_FILE, cfg);
    }

    if (cmd === '/group' || cmd === '/pack') {
      setMode('group');
      const argName = parsePackArg(text) || (repliedSticker && repliedSticker.set_name) || '';
      if (!argName) {
        return void await reply([
          '✅ 已切到 group 模式',
          '之后你发任意一张贴纸，我都会把它所在的**整个表情包**导进收藏（已存在的自动跳过）。',
          '',
          '想立即导某个包，也可以：/group t.me/addstickers/包名',
          '切回单张：/single',
        ].join('\n'));
      }
      return void await serialize(() => savePack(tg, argName, reply));
    }
    if (cmd === '/single') {
      setMode('single');
      if (repliedSticker) return void await serialize(() => saveSticker(tg, repliedSticker, reply));
      return void await reply([
        '✅ 已切到 single 模式',
        '之后你发贴纸，只单独存这一张。',
        '',
        '切到整包：/group',
      ].join('\n'));
    }

    if (cmd === '/send') {
      const arg = (text.split(/\s+/)[1] || '').trim();
      if (arg && !/^\d{5,12}$/.test(arg)) {
        return void await reply('用法：/send <好友QQ号> —— 之后你发的每张贴纸都会转发给对方，直到 /single 或 /group 切回来。');
      }
      if (arg) {
        cfg.sendTo = arg;
        setMode('send');
        return void await reply([
          '✅ 已切到 send 模式，目标好友：' + arg,
          '之后你发任意一张贴纸，我都会把它转发给这个好友（**不写收藏**）。',
          '换目标：/send <另一个QQ号>',
          '切回收藏：/single 或 /group',
        ].join('\n'));
      }
      if (cfg.sendTo) {
        setMode('send');
        return void await reply('✅ 已切到 send 模式，目标好友：' + cfg.sendTo + '（上次用的目标）\n发贴纸即转发；换目标 /send <QQ号>，切回收藏 /single 或 /group。');
      }
      return void await reply('用法：/send <好友QQ号>\n设置后，你发的每张贴纸都会转发给该好友，直到 /single 或 /group 切回收藏模式。');
    }

    if (cmd === '/zip') {
      setMode('zip');
      const argName = parsePackArg(text) || (repliedSticker && repliedSticker.set_name) || '';
      if (argName) return void await serialize(() => packZip(tg, argName, reply));
      return void await reply([
        '✅ 已切到 zip 模式',
        '之后你发任意一张贴纸，我会把它所在的整个表情包按统一格式转换，打成一个 zip 发回来：',
        '  静态 .webp → PNG，动态 .webm/.tgs → GIF 240×240 50fps（保留透明）',
        '也可以直接点名：/zip t.me/addstickers/包名',
        '切回单张：/single',
      ].join('\n'));
    }

    if (cmd === '/start' || cmd === '/help') return void await reply(helpText());
    if (cmd === '/id') return void await reply('tg user id: ' + uid);
    if (cmd === '/count') {
      const modeText = stickerMode === 'group' ? 'group（发贴纸自动导入整包）'
        : stickerMode === 'send' ? 'send（发贴纸转发给 ' + (cfg.sendTo || '?') + '，不写收藏）'
        : stickerMode === 'zip' ? 'zip（发贴纸把整包打成 zip 发回）'
        : 'single（发贴纸只存单张）';
      return void await reply('QQ 收藏表情总数：' + (await favList()).length + '\n当前模式：' + modeText);
    }
    if (cmd === '/delete_all' || cmd === '/deleteall') {
      const arg = (text.split(/\s+/)[1] || '').toLowerCase();
      if (arg !== 'confirm') {
        const list = await favList();
        if (!list.length) return void await reply('收藏是空的，没什么可删。');
        deleteAllArmedAt = Date.now();
        return void await reply('⚠️ 这会删除收藏里全部 ' + list.length + ' 张表情，且不可恢复。\n60 秒内发送 /delete_all confirm 确认，其他任何输入都会取消。');
      }
      if (!deleteAllArmedAt || Date.now() - deleteAllArmedAt > 60000) {
        return void await reply('确认已过期或未发起。请先发送 /delete_all，再发 /delete_all confirm。');
      }
      deleteAllArmedAt = 0;
      const r = await deleteAllFavorites();
      if (r.status === 'empty') return void await reply('收藏是空的。');
      const failLine = r.failed.length ? '\n失败：' + r.failed.slice(0, 3).join('；') : '';
      return void await reply('已删除 ' + r.deleted + '/' + r.total + ' 张，剩余 ' + r.count + ' 张。' + failLine);
    }
    if (cmd === '/del') {
      const t = await deleteNewest();
      if (t.status === 'empty') return void await reply('收藏是空的。');
      if (t.status === 'none-tracked') return void await reply('找不到由我添加过的收藏记录，为避免误删你原有的 ' + t.count + ' 张，这次没有删除。');
      return void await reply('已删除最近一张：' + (t.md5 || t.resId) + '\n剩余：' + t.count);
    }
    if (text) return void await reply('我只负责存收藏，不转发文字。发贴纸或图片给我即可。\n\n' + helpText());
  } catch (e) {
    log('[error]', e.stack || e.message);
    await reply('出错：' + e.message);
  }
}

// ---------------- Telegram 命令菜单 ----------------
// Telegram 客户端的 "/" 菜单来自 setMyCommands，不是从消息内容推断的；
// 不注册的话命令照样能用，但聊天界面里看不到列表。
const TG_COMMANDS = [
  { command: 'single', description: '单张模式：之后发贴纸只存这一张' },
  { command: 'group', description: '整包模式：发贴纸导入整包，可跟 t.me/addstickers/包名' },
  { command: 'send', description: 'send 模式：之后发的贴纸都转发给指定好友' },
  { command: 'zip', description: 'zip 模式：发一张贴纸，得到它所在整包的压缩包' },
  { command: 'count', description: '查看收藏表情总数和当前模式' },
  { command: 'del', description: '删除最新添加的那一张收藏' },
  { command: 'delete_all', description: '清空收藏（需再发 confirm 确认）' },
  { command: 'id', description: '查看你的 Telegram user id' },
  { command: 'help', description: '显示完整用法说明' },
];

async function registerTelegramCommands(tg) {
  try {
    await tg.api('setMyCommands', { commands: TG_COMMANDS });
    log('[tg] 命令菜单已注册（' + TG_COMMANDS.length + ' 条）');
  } catch (e) {
    log('[tg] 命令菜单注册失败：' + e.message);
  }
}

// ---------------- 主循环 ----------------
async function main() {
  const token = readToken();
  if (!token) { log('[fatal] 缺 token，写进 ' + TOKEN_FILE); process.exit(0); }
  const tg = makeTG(token);
  let me;
  try { me = await tg.api('getMe', {}); }
  catch (e) { log('[fatal] getMe 失败：' + e.message); process.exit(1); }
  log('[tg] bot @' + me.username + ' (' + me.id + ') 就绪，模式=只存收藏');
  await registerTelegramCommands(tg);
  await ob.connect().catch(e => log('[onebot] 连接失败：' + e.message));

  let backoff = 1000;
  while (true) {
    try {
      const updates = await tg.getUpdates(state.offset);
      backoff = 1000;
      for (const u of updates) {
        state.offset = u.update_id + 1;
        saveJSON(STATE_FILE, state);
        const msg = u.message;
        if (!msg) continue;
        await onMessage(tg, msg).catch(e => log('[handler]', e.message));
      }
    } catch (e) {
      log('[poll] ' + e.message + '，' + backoff + 'ms 后重试');
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 30000);
    }
  }
}

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) main();

export { webmToApng, tgsToApng, webmToGif, tgsToGif, toPng, evalAdd, favList, deleteNewest, deleteFavorites, deleteAllFavorites, makeTG, md5hex, saveSticker, savePack, saveOne, formatOne, setDesc, parsePackArg, packZip, renderSticker, onMessage };
