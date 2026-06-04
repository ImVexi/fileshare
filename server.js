const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const os = require('os');
const mime = require('mime-types');
const { spawn, execSync } = require('child_process');

const app = express();
app.set('trust proxy', true);
app.use(express.json());

// Basic CORS for local network access
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  // Allow localhost, local IPs, and the configured public URL
  if (origin && (origin.startsWith('http://localhost') || origin.startsWith('http://10.0.') || origin.startsWith('http://192.168.') || origin.startsWith('http://172.') || origin === PUBLIC_URL)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, HEAD, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Browser-Id, X-Upload-Password, Upload-Length, Upload-Offset, Upload-Metadata, Upload-Defer-Length, Tus-Resumable');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  if (req.method === 'OPTIONS' && !req.path.startsWith('/api/tus')) return res.sendStatus(204);
  next();
});

const LOG_FILE = path.join(__dirname, 'request.log');
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

app.use((req, res, next) => {
  const start = Date.now();
  const size = req.headers['content-length'] || '-';
  log(`→ ${req.method} ${req.url} (${size}B) ${req.headers['user-agent'] || ''}`);
  res.on('finish', () => {
    const ms = Date.now() - start;
    if (req.method === 'POST' || res.statusCode >= 400) {
      log(`← ${res.statusCode} ${req.method} ${req.url} (${ms}ms)`);
    }
  });
  next();
});

const PORT = process.env.PORT || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '8762';
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const DATA_DIR = path.join(__dirname, 'data');
const FILES_DB = path.join(DATA_DIR, 'files.json');
const TOKENS_DB = path.join(DATA_DIR, 'tokens.json');
const CLIENTS_DB = path.join(DATA_DIR, 'clients.json');
const LIMIT_CODES_DB = path.join(DATA_DIR, 'limit-codes.json');
const IP_LOG_FILE = path.join(DATA_DIR, 'ip-log.jsonl');

const CHUNKS_DIR = path.join(DATA_DIR, 'chunks');
const TUS_DIR = path.join(DATA_DIR, 'tus');
const EMBED_DIR = path.join(__dirname, 'EMBED');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(CHUNKS_DIR, { recursive: true });
fs.mkdirSync(TUS_DIR, { recursive: true });
fs.mkdirSync(EMBED_DIR, { recursive: true });

// FFmpeg for video conversion
const FFMPEG_PATH = process.env.FFMPEG_PATH || (() => {
  try { return execSync('where ffmpeg').toString().trim().split('\n')[0]; } catch {}
  const candidates = [
    'C:\\Users\\Jayden\\AppData\\Local\\ffmpeg\\ffmpeg-8.1.1-essentials_build\\bin\\ffmpeg.exe',
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
    'ffmpeg.exe'
  ];
  for (const c of candidates) { if (fs.existsSync(c)) return c; }
  return 'ffmpeg';
})();
const CONVERT_FORMATS = ['.avi', '.wmv', '.flv', '.mkv', '.mov', '.3gp', '.mpeg', '.mpg', '.vob', '.webm'];
const H265_CODECS = ['hevc', 'h265', 'libx265', 'mpeg4', 'msmpeg4v2', 'msmpeg4v3', 'vp8', 'vp9', 'av1'];

// Transcode job tracking
function createTranscodeJob(fileId, filename, step) {
  const existing = transcodeJobs.get(fileId);
  const job = existing || { id: fileId, filename, steps: [], createdAt: Date.now() };
  const stepEntry = { name: step, status: 'running', startedAt: Date.now(), output: [] };
  job.steps.push(stepEntry);
  job.filename = filename;
  job.updatedAt = Date.now();
  transcodeJobs.set(fileId, job);
  return stepEntry;
}

function updateTranscodeStep(step, data) {
  if (!step) return;
  Object.assign(step, data);
  if (data.status === 'done' || data.status === 'error') step.finishedAt = Date.now();
}

function appendTranscodeOutput(step, text) {
  if (!step) return;
  step.output.push(text);
  if (step.output.length > 200) step.output.splice(0, step.output.length - 200);
}

function getTranscodeJobs() {
  const now = Date.now();
  for (const [id, job] of transcodeJobs) {
    if (now - (job.updatedAt || job.createdAt) > TRANSCODE_JOB_TTL) transcodeJobs.delete(id);
  }
  return Array.from(transcodeJobs.values()).map(j => ({
    ...j,
    steps: j.steps.map(s => ({
      ...s,
      output: s.output.slice(-50)
    }))
  }));
}

const PUBLIC_SIZE_LIMIT = 1 * 1024 * 1024 * 1024;
const PUBLIC_DAILY_BYTES = Number(process.env.PUBLIC_DAILY_BYTES || 10 * 1024 * 1024 * 1024);
const PUBLIC_DAILY_FILES = Number(process.env.PUBLIC_DAILY_FILES || 500);
const PUBLIC_UPLOAD_WINDOW_MS = Number(process.env.PUBLIC_UPLOAD_WINDOW_MS || 10 * 60 * 1000);
const PUBLIC_UPLOAD_WINDOW_COUNT = Number(process.env.PUBLIC_UPLOAD_WINDOW_COUNT || 20);
const PUBLIC_ALLOWED_MIME_PREFIXES = ['image/', 'video/'];
const PUBLIC_ALLOWED_MIME = new Set(['image/heic', 'image/heif']);
const PUBLIC_ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.heic', '.heif', '.mp4', '.mov', '.m4v', '.webm', '.avi', '.wmv', '.flv', '.mkv', '.3gp', '.mpeg', '.mpg', '.vob']);
const ADMIN_PASSWORDS = new Set([ADMIN_PASSWORD]);
const rateBuckets = new Map();
const tusCompletions = new Map();
const transcodeJobs = new Map();
const TRANSCODE_JOB_TTL = 30 * 60 * 1000;
let tusServer = null;
log(`FFmpeg: ${FFMPEG_PATH}`);

function needsConvert(filename, mimeType) {
  const ext = path.extname(filename).toLowerCase();
  return CONVERT_FORMATS.includes(ext) || ['video/x-msvideo', 'video/x-ms-wmv', 'video/x-flv', 'video/x-matroska', 'video/quicktime', 'video/3gpp', 'video/mpeg', 'video/mp2t'].includes(mimeType);
}

function isPublicAllowedMedia(filename, mimeType) {
  const ext = path.extname(filename || '').toLowerCase();
  const detected = mime.lookup(filename || '') || '';
  return PUBLIC_ALLOWED_EXT.has(ext) && (
    PUBLIC_ALLOWED_MIME_PREFIXES.some(p => (mimeType || '').startsWith(p) || detected.startsWith(p)) ||
    PUBLIC_ALLOWED_MIME.has(mimeType) ||
    PUBLIC_ALLOWED_MIME.has(detected)
  );
}

function getClientIp(req) {
  const raw = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.ip || req.connection?.remoteAddress || '';
  return String(Array.isArray(raw) ? raw[0] : raw).split(',')[0].trim().replace(/^::ffff:/, '');
}

function getBrowserId(req) {
  return String(req.headers['x-browser-id'] || req.body?.browserId || req.query?.browserId || '').trim().slice(0, 80);
}

function nowIso() {
  return new Date().toISOString();
}

function appendIpLog(event) {
  try { fs.appendFileSync(IP_LOG_FILE, JSON.stringify({ at: nowIso(), ...event }) + '\n'); } catch {}
}

function loadClients() {
  const data = readDB(CLIENTS_DB);
  return Array.isArray(data) ? data : [];
}

function saveClients(clients) {
  writeDB(CLIENTS_DB, clients);
}

function findOrCreateClient(browserId, ip, ua) {
  const clients = loadClients();
  const id = browserId || `ip:${ip || 'unknown'}`;
  let client = clients.find(c => c.id === id);
  if (!client) {
    client = { id, nickname: '', firstSeen: nowIso(), uploadedBytes: 0, uploadedFiles: 0, banned: false, ips: [], userAgents: [], files: [], avgSpeed: 0 };
    clients.push(client);
  }
  client.lastSeen = nowIso();
  if (ip && !client.ips.includes(ip)) client.ips.unshift(ip);
  if (ua && !client.userAgents.includes(ua)) client.userAgents.unshift(ua.slice(0, 180));
  client.ips = client.ips.slice(0, 12);
  client.userAgents = client.userAgents.slice(0, 8);
  saveClients(clients);
  return client;
}

function updateClientUpload(browserId, ip, ua, entry, speedBytesPerSec) {
  const clients = loadClients();
  const id = browserId || `ip:${ip || 'unknown'}`;
  let client = clients.find(c => c.id === id);
  if (!client) {
    client = { id, nickname: '', firstSeen: nowIso(), uploadedBytes: 0, uploadedFiles: 0, banned: false, ips: [], userAgents: [], files: [], avgSpeed: 0 };
    clients.push(client);
  }
  client.lastSeen = nowIso();
  if (ip && !client.ips.includes(ip)) client.ips.unshift(ip);
  if (ua && !client.userAgents.includes(ua.slice(0, 180))) client.userAgents.unshift(ua.slice(0, 180));
  client.uploadedBytes = (client.uploadedBytes || 0) + (entry.size || 0);
  client.uploadedFiles = (client.uploadedFiles || 0) + 1;
  if (speedBytesPerSec && speedBytesPerSec > 0) {
    client.avgSpeed = client.avgSpeed ? Math.round((client.avgSpeed + speedBytesPerSec) / 2) : Math.round(speedBytesPerSec);
  }
  client.files = [{ id: entry.id, filename: entry.filename, size: entry.size, mime: entry.mime, uploadedAt: entry.uploadedAt }, ...(client.files || [])].slice(0, 200);
  client.ips = client.ips.slice(0, 12);
  client.userAgents = client.userAgents.slice(0, 8);
  saveClients(clients);
}

function getUsageFor(browserId, ip) {
  const clients = loadClients();
  const ids = new Set([browserId, ip ? `ip:${ip}` : ''].filter(Boolean));
  const files = readDB(FILES_DB);
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  let uploadedBytes = 0;
  let uploadedFiles = 0;
  for (const f of files) {
    if (!f.trashed && (ids.has(f.browserId) || ids.has(f.clientKey))) {
      const uploadedAt = f.uploadedAt ? Date.parse(f.uploadedAt) : 0;
      if (uploadedAt >= dayAgo) {
        uploadedBytes += f.originalSize || f.size || 0;
        uploadedFiles++;
      }
    }
  }
  const client = clients.find(c => c.id === browserId) || clients.find(c => c.id === `ip:${ip}`);
  const effectiveLimitBytes = client?.quotaOverrideBytes || PUBLIC_DAILY_BYTES;
  const effectiveLimitFiles = client?.quotaOverrideFiles || PUBLIC_DAILY_FILES;
  return { uploadedBytes, uploadedFiles, banned: !!client?.banned, limitBytes: effectiveLimitBytes, limitFiles: effectiveLimitFiles };
}

function validateLimitCode(code) {
  if (!code) return null;
  const codes = readDB(LIMIT_CODES_DB);
  const found = codes.find(c => c.code === code && c.enabled !== false && (!c.expiresAt || Date.parse(c.expiresAt) > Date.now()));
  return found || null;
}

function isAdminOverride(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ') && sessionTokens.has(auth.slice(7))) return true;
  const pw = req.headers['x-admin-password'] || '';
  if (pw === ADMIN_PASSWORD) return true;
  return false;
}

function hasUploadOverride(req) {
  return isAdminOverride(req) || !!validateLimitCode(req.headers['x-upload-password'] || req.body?.uploadPassword || req.query?.uploadPassword);
}

function publicUploadGuard(req, fileInfo) {
  if (isAdminOverride(req)) return;
  const ip = getClientIp(req);
  const browserId = getBrowserId(req);
  const ua = req.headers['user-agent'] || '';
  const client = findOrCreateClient(browserId, ip, ua);
  if (client.banned) throw { status: 403, message: 'This browser is banned from uploading' };
  if (!isPublicAllowedMedia(fileInfo.filename, fileInfo.mime)) throw { status: 415, message: 'Only image and video uploads are allowed' };
  const override = hasUploadOverride(req);
  const size = Number(fileInfo.size || 0);
  if (!override && size > PUBLIC_SIZE_LIMIT) throw { status: 413, message: 'File exceeds the 1GB public limit' };
  const usage = getUsageFor(browserId, ip);
  if (!override && usage.uploadedBytes + size > usage.limitBytes) throw { status: 429, message: 'Upload quota reached. Ask for an upload password.' };
  if (!override && usage.uploadedFiles >= usage.limitFiles) throw { status: 429, message: 'File count limit reached. Ask for an upload password.' };

  const bucketKey = browserId || ip || 'unknown';
  const now = Date.now();
  const bucket = (rateBuckets.get(bucketKey) || []).filter(t => now - t < PUBLIC_UPLOAD_WINDOW_MS);
  if (!override && bucket.length >= PUBLIC_UPLOAD_WINDOW_COUNT) throw { status: 429, message: 'Too many uploads. Slow down and try again soon.' };
  bucket.push(now);
  rateBuckets.set(bucketKey, bucket);
}

function rejectUpload(res, err, cleanupPath) {
  if (cleanupPath) { try { fs.unlinkSync(cleanupPath); } catch {} }
  const status = err.status || err.status_code || 400;
  return res.status(status).json({ error: err.message || err.body || 'Upload rejected' });
}

function convertToMp4(inputPath, outputPath, transcodeStep) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_PATH, [
      '-i', inputPath,
      '-map_metadata', '-1',
      '-vf', 'scale=w=min(iw\\,1920):h=min(ih\\,1080):force_original_aspect_ratio=decrease',
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '28',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '96k',
      '-movflags', '+faststart',
      '-y',
      outputPath
    ]);
    let stderr = '';
    proc.stderr.on('data', d => {
      const chunk = d.toString();
      stderr += chunk;
      appendTranscodeOutput(transcodeStep, chunk);
    });
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg exit code ${code}: ${stderr.slice(-200)}`));
    });
    proc.on('error', reject);
  });
}

function reencodeImage(inputPath, outputPath, transcodeStep) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_PATH, [
      '-i', inputPath,
      '-map_metadata', '-1',
      '-vf', 'scale=w=min(iw\\,1920):h=min(ih\\,1920):force_original_aspect_ratio=decrease',
      '-q:v', '7',
      '-y',
      outputPath
    ]);
    let stderr = '';
    proc.stderr.on('data', d => {
      const chunk = d.toString();
      stderr += chunk;
      appendTranscodeOutput(transcodeStep, chunk);
    });
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`Image encode failed (exit ${code}): ${stderr.slice(-200)}`)));
    proc.on('error', reject);
  });
}

function getVideoCodec(filePath) {
  return new Promise((resolve) => {
    const proc = spawn(FFMPEG_PATH, ['-i', filePath, '-hide_banner', '-f', 'null', '-']);
    let stderr = '';
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('close', () => {
      const m = stderr.match(/Video:\s+(\w+)/);
      resolve(m ? m[1].toLowerCase() : '');
    });
    proc.on('error', () => resolve(''));
  });
}

async function reencodeMedia(inputPath, originalName, inputMime, fileId) {
  const ext = path.extname(originalName || '').toLowerCase();
  const isVideo = (inputMime || '').startsWith('video/') || needsConvert(originalName, inputMime);
  const isImage = (inputMime || '').startsWith('image/');
  if (isVideo || ext === '.gif') {
    const out = path.join(UPLOAD_DIR, fileId + '.mp4');
    await convertToMp4(inputPath, out);
    return { path: out, storedName: fileId + '.mp4', mime: 'video/mp4', size: fs.statSync(out).size };
  }
  if (isImage) {
    const out = path.join(UPLOAD_DIR, fileId + '.jpg');
    await reencodeImage(inputPath, out);
    return { path: out, storedName: fileId + '.jpg', mime: 'image/jpeg', size: fs.statSync(out).size };
  }
  if ((inputMime || '').startsWith('video/mp4') && ext === '.mp4') {
    const codec = await getVideoCodec(inputPath);
    if (H265_CODECS.includes(codec)) {
      log(`RECODE_H265: ${originalName} codec=${codec}, converting to H.264`);
      const out = path.join(UPLOAD_DIR, fileId + '.mp4');
      await convertToMp4(inputPath, out);
      return { path: out, storedName: fileId + '.mp4', mime: 'video/mp4', size: fs.statSync(out).size };
    }
  }
  return null;
}

const EMBED_TARGET = 25 * 1024 * 1024;
const EMBED_THRESHOLD = 5 * 1024 * 1024;

function hasEmbed(fileId) {
  const embedPath = path.join(EMBED_DIR, fileId + '.mp4');
  return fs.existsSync(embedPath);
}

function compressForEmbed(inputPath, fileId, duration, transcodeStep) {
  const outputPath = path.join(EMBED_DIR, fileId + '.mp4');
  const totalBitrate = Math.round((EMBED_TARGET * 8) / duration);
  const audioBitrate = 96 * 1000;
  let videoBitrate = Math.max(100 * 1000, totalBitrate - audioBitrate);
  videoBitrate = Math.min(50 * 1000 * 1000, videoBitrate);

  return new Promise((resolve, reject) => {
    log(`EMBED_COMPRESS: ${fileId} → ${(videoBitrate / 1e6).toFixed(1)}Mb/s (H.264), duration ${duration}s`);
    const proc = spawn(FFMPEG_PATH, [
      '-i', inputPath,
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-b:v', String(videoBitrate),
      '-maxrate', String(Math.round(videoBitrate * 1.2)),
      '-bufsize', String(Math.round(videoBitrate * 2)),
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '96k',
      '-movflags', '+faststart',
      '-y',
      outputPath
    ]);
    let stderr = '';
    proc.stderr.on('data', d => {
      const chunk = d.toString();
      stderr += chunk;
      appendTranscodeOutput(transcodeStep, chunk);
    });
    proc.on('close', code => {
      if (code === 0) {
        const newSize = fs.statSync(outputPath).size;
        log(`EMBED_OK: ${fileId} (${newSize}B)`);
        resolve(true);
      } else {
        reject(new Error(`Embed compression failed (exit ${code}): ${stderr.slice(-200)}`));
      }
    });
    proc.on('error', reject);
  });
}

function getVideoDuration(filePath) {
  return new Promise((resolve) => {
    const proc = spawn(FFMPEG_PATH, ['-i', filePath, '-f', 'null', '-']);
    let stderr = '';
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('close', () => {
      const m = stderr.match(/Duration: (\d+):(\d+):(\d+)\.(\d+)/);
      if (m) resolve(parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]));
      else resolve(0);
    });
    proc.on('error', () => resolve(0));
  });
}

function stripMetadata(filePath, mime, transcodeStep) {
  const ext = path.extname(filePath).toLowerCase();
  const tmpPath = filePath + '.tmp';
  const isVideo = mime.startsWith('video/') || ['.mp4', '.mov', '.avi', '.mkv', '.wmv', '.flv'].includes(ext);
  const isImage = mime.startsWith('image/') || ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext);
  if (!isVideo && !isImage) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const args = isVideo
      ? ['-i', filePath, '-map_metadata', '-1', '-c', 'copy', '-movflags', '+faststart', '-y', tmpPath]
      : ['-i', filePath, '-map_metadata', '-1', '-y', tmpPath];
    const proc = spawn(FFMPEG_PATH, args);
    let stderr = '';
    proc.stderr.on('data', d => {
      const chunk = d.toString();
      stderr += chunk;
      appendTranscodeOutput(transcodeStep, chunk);
    });
    proc.on('close', code => {
      if (code === 0 && fs.existsSync(tmpPath)) {
        fs.renameSync(tmpPath, filePath);
        resolve();
      } else {
        try { fs.unlinkSync(tmpPath); } catch {}
        reject(new Error(`Strip metadata failed (exit ${code}): ${stderr.slice(-200)}`));
      }
    });
    proc.on('error', reject);
  });
}

function readDB(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
}
function writeDB(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '';
    cb(null, uuidv4() + ext);
  }
});
const upload = multer({ storage });

// In-memory session tokens
const sessionTokens = new Map();
const TOKEN_EXPIRY = 24 * 60 * 60 * 1000;

// Auth middleware: supports Bearer token (from login page) and Basic auth (direct)
function auth(req, res, next) {
  const header = req.headers.authorization || '';

  // Try Bearer token first
  if (header.startsWith('Bearer ')) {
    const token = header.slice(7);
    if (sessionTokens.has(token)) {
      const createdAt = sessionTokens.get(token);
      if (Date.now() - createdAt < TOKEN_EXPIRY) {
        sessionTokens.set(token, Date.now());
        return next();
      }
      sessionTokens.delete(token);
    }
    return res.status(401).json({ error: 'Session expired, please login again' });
  }

  // Fall back to Basic auth
  const b64 = header.split(' ')[1] || '';
  const [user, pass] = Buffer.from(b64, 'base64').toString().split(':');
  if (pass === ADMIN_PASSWORD) {
    const token = uuidv4();
    sessionTokens.set(token, Date.now());
    res.set('X-Session-Token', token);
    return next();
  }

  return res.status(401).json({ error: 'Unauthorized' });
}

// --- Login ---
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (password === ADMIN_PASSWORD) {
    const token = uuidv4();
    sessionTokens.set(token, Date.now());
    return res.json({ token });
  }
  res.status(401).json({ error: 'Invalid password' });
});

// --- API Routes ---

async function finalizeStoredUpload({ req, res, sourcePath, originalName, originalMime, originalSize, token, id, speedBps }) {
  log(`FINALIZE_START: ${id || '?'} name=${originalName} mime=${originalMime} size=${originalSize}`);
  const ip = getClientIp(req);
  const browserId = getBrowserId(req);
  const ua = req.headers['user-agent'] || '';
  const fileId = id || uuidv4();
  let fileMime = originalMime || mime.lookup(originalName || '') || 'application/octet-stream';
  let fileSize = Number(originalSize || 0);
  let storedName = '';
  let filePath = '';

  // Step 1: Move source file to uploads as the original
  if (sourcePath.startsWith(TUS_DIR)) {
    const srcExt = path.extname(originalName || '') || (mime.extension(fileMime) ? '.' + mime.extension(fileMime) : '');
    storedName = fileId + '_original' + srcExt;
    let origDestPath = path.join(UPLOAD_DIR, storedName);
    try {
      fs.renameSync(sourcePath, origDestPath);
      log(`MOVE_ORIG: ${sourcePath} -> ${origDestPath}`);
    } catch (e) {
      try {
        fs.copyFileSync(sourcePath, origDestPath);
        fs.unlinkSync(sourcePath);
        log(`MOVE_ORIG: ${sourcePath} -> ${origDestPath} (copy+delete)`);
      } catch (e2) {
        log(`MOVE_ORIG_ERR: ${sourcePath} -> ${origDestPath}: ${e2.message}`);
        origDestPath = sourcePath;
        storedName = path.basename(sourcePath);
      }
    }
    filePath = origDestPath;
  } else {
    filePath = sourcePath;
    storedName = path.basename(sourcePath);
  }
  if (!fileSize || fileSize === 0) fileSize = fs.statSync(filePath).size;

  if (!isAdminOverride(req)) {
    try { publicUploadGuard(req, { filename: originalName || storedName, mime: fileMime, size: fileSize }); }
    catch (e) { log(`FINALIZE_REJECTED: ${fileId} ${e.message}`); return rejectUpload(res, e, filePath); }
  }

  // Save entry immediately so the file is accessible right away
  const entry = {
    id: fileId,
    filename: originalName || storedName,
    storedName,
    previewName: null,
    size: fileSize,
    originalSize: Number(originalSize || fileSize),
    mime: fileMime,
    originalMime: fileMime,
    token,
    browserId: browserId || null,
    clientKey: browserId || (ip ? `ip:${ip}` : null),
    ip,
    userAgent: (ua || '').slice(0, 180),
    uploadedAt: nowIso(),
    downloads: 0
  };
  const files = readDB(FILES_DB);
  files.push(entry);
  writeDB(FILES_DB, files);
  updateClientUpload(browserId, ip, ua, entry, speedBps);
  appendIpLog({ event: 'upload_saved', ip, browserId, filename: entry.filename, size: entry.size, originalSize: entry.originalSize, mime: entry.mime, id: entry.id, speedBps: speedBps || 0 });
  log(`SAVED: ${entry.id} -> ${entry.filename} (${entry.size}B, ${entry.mime}) ip=${ip} browser=${browserId || '-'}`);

  // Send response NOW — file is saved and accessible
  res.json({ success: true, file: entry, url: `/f/${fileId}` });

  // Step 2+: Transcode in background (after response is sent)
  processInBackground(fileId, filePath, storedName, originalName || storedName, fileMime, fileSize);
}

async function processInBackground(fileId, filePath, storedName, originalName, fileMime, fileSize) {
  const step = createTranscodeJob(fileId, originalName, 'analyze');
  try {
    const needsPreview = (() => {
      const ext = path.extname(originalName || '').toLowerCase();
      const mime = (fileMime || '');
      const isImage = mime.startsWith('image/');
      const needsConvertCheck = needsConvert(originalName || '', fileMime);
      if (ext === '.gif') return 'video';
      if (isImage) return 'image';
      if (mime.startsWith('video/mp4') && ext === '.mp4' && !needsConvertCheck) return 'check-codec';
      if (mime.startsWith('video/') || needsConvertCheck) return 'video';
      return null;
    })();

    let previewName = null;
    let previewPath = null;
    let previewMime = fileMime;
    let previewSize = fileSize;

    log(`BG_PROCESS: ${fileId} needsPreview=${needsPreview}`);
    updateTranscodeStep(step, { status: 'running', name: `preview (${needsPreview || 'none'})` });

    if (needsPreview === 'video' || needsPreview === 'check-codec') {
      let shouldEncode = needsPreview === 'video';
      if (needsPreview === 'check-codec') {
        const codec = await getVideoCodec(filePath);
        if (H265_CODECS.includes(codec)) {
          log(`CODEC_DETECT: ${originalName} is ${codec}, will create H264 preview`);
          shouldEncode = true;
        }
      }
      if (shouldEncode) {
        updateTranscodeStep(step, { name: 'convert to H.264' });
        const out = path.join(UPLOAD_DIR, fileId + '.mp4');
        try {
          await convertToMp4(filePath, out, step);
          if (fs.existsSync(out) && fs.statSync(out).size > 0) {
            previewName = fileId + '.mp4';
            previewPath = out;
            previewMime = 'video/mp4';
            previewSize = fs.statSync(out).size;
            log(`PREVIEW_OK: ${originalName} -> ${previewName} (${previewSize}B)`);
          } else {
            log(`PREVIEW_FAIL: ${originalName} produced empty file`);
            try { if (fs.existsSync(out)) fs.unlinkSync(out); } catch {}
          }
        } catch (e) {
          updateTranscodeStep(step, { status: 'error', error: e.message });
          log(`PREVIEW_ERR: ${originalName} - ${e.message}`);
          try { if (fs.existsSync(out)) fs.unlinkSync(out); } catch {}
        }
      }
    } else if (needsPreview === 'image') {
      updateTranscodeStep(step, { name: 're-encode image' });
      const out = path.join(UPLOAD_DIR, fileId + '.jpg');
      try {
        await reencodeImage(filePath, out, step);
        if (fs.existsSync(out) && fs.statSync(out).size > 0) {
          previewName = fileId + '.jpg';
          previewPath = out;
          previewMime = 'image/jpeg';
          previewSize = fs.statSync(out).size;
          log(`PREVIEW_OK: ${originalName} -> ${previewName} (${previewSize}B)`);
        } else {
          log(`PREVIEW_FAIL: ${originalName} produced empty image`);
          try { if (fs.existsSync(out)) fs.unlinkSync(out); } catch {}
        }
      } catch (e) {
        updateTranscodeStep(step, { status: 'error', error: e.message });
        log(`PREVIEW_ERR: ${originalName} - ${e.message}`);
        try { if (fs.existsSync(out)) fs.unlinkSync(out); } catch {}
      }
    }

    // Strip metadata on original if no preview was created
    if (!previewName) {
      updateTranscodeStep(step, { name: 'strip metadata' });
      try {
        await stripMetadata(filePath, fileMime, step);
        const newStat = fs.statSync(filePath);
        if (newStat.size !== fileSize) {
          fileSize = newStat.size;
          log(`STRIP_META_OK: ${storedName} (${fileSize}B)`);
        }
      } catch (e) {
        log(`STRIP_META_SKIP: ${storedName} - ${e.message}`);
      }
    }

    // Generate Discord embed preview for videos
    const embedSize = previewPath ? previewSize : fileSize;
    const embedMime = previewName ? previewMime : fileMime;
    const embedInput = previewPath || filePath;
    if ((embedMime || '').startsWith('video/')) {
      if (embedSize > EMBED_THRESHOLD) {
        updateTranscodeStep(step, { name: 'generate embed' });
        try {
          const dur = await getVideoDuration(embedInput);
          if (dur > 0) await compressForEmbed(embedInput, fileId, dur, step);
          log(`EMBED_DONE: ${fileId}`);
        } catch (e) {
          updateTranscodeStep(step, { status: 'error', error: e.message });
          log(`EMBED_ERR: ${fileId} — ${e.message}`);
        }
      } else {
        log(`EMBED_SKIP_SMALL: ${fileId} (${embedSize}B < ${EMBED_THRESHOLD}B), no embed needed`);
      }
    }

    // Update DB entry with preview info
    if (previewName) {
      const allFiles = readDB(FILES_DB);
      const idx = allFiles.findIndex(f => f.id === fileId);
      if (idx >= 0) {
        allFiles[idx].previewName = previewName;
        allFiles[idx].size = previewSize;
        allFiles[idx].mime = previewMime;
        if (!allFiles[idx].originalMime) allFiles[idx].originalMime = fileMime;
        writeDB(FILES_DB, allFiles);
        log(`BG_UPDATED: ${fileId} previewName=${previewName} size=${previewSize}`);
      }
    } else if (!previewName) {
      const allFiles = readDB(FILES_DB);
      const idx = allFiles.findIndex(f => f.id === fileId);
      if (idx >= 0 && allFiles[idx].size !== fileSize) {
        allFiles[idx].size = fileSize;
        writeDB(FILES_DB, allFiles);
        log(`BG_UPDATED: ${fileId} stripped size=${fileSize}`);
      }
    }

    updateTranscodeStep(step, { status: 'done' });
  } catch (e) {
    updateTranscodeStep(step, { status: 'error', error: e.message });
    log(`BG_ERR: ${fileId} — ${e.message}\n${e.stack || ''}`);
  }
}

async function handleUpload(req, res, token) {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });
  return finalizeStoredUpload({
    req,
    res,
    sourcePath: req.file.path,
    originalName: req.file.originalname,
    originalMime: req.file.mimetype,
    originalSize: req.file.size,
    token,
    id: path.basename(req.file.filename, path.extname(req.file.filename))
  });
}

function uploadMiddleware(req, res, next) {
  log(`UPLOAD_START: ${req.headers['content-length'] || '?'}B`);
  upload.single('file')(req, res, (err) => {
    if (err) {
      log(`UPLOAD_ERR: ${err.code || 'MULTER_ERROR'} — ${err.message}`);
      return res.status(400).json({ error: err.message });
    }
    if (req.file) {
      log(`UPLOAD_OK: ${req.file.originalname} (${req.file.size}B, ${req.file.mimetype}) → ${req.file.filename}`);
    }
    next();
  });
}

// Upload file (public)
app.post('/api/upload', uploadMiddleware, (req, res, next) => {
  handleUpload(req, res, req.body.token || null).catch(next);
});

// Admin: upload (no size cap)
app.post('/api/admin/upload', auth, uploadMiddleware, (req, res, next) => {
  req.isAdmin = true;
  handleUpload(req, res, req.body.token || 'admin').catch(next);
});

// List files (admin)
app.get('/api/admin/files', auth, (req, res) => {
  let files = readDB(FILES_DB);
  const { search, type, dir, trash } = req.query;
  let filtered = files;

  // Filter by trash/active
  if (trash === '1') {
    filtered = filtered.filter(f => f.trashed);
  } else {
    filtered = filtered.filter(f => !f.trashed);
  }

  // Filter by folder
  if (dir !== undefined) {
    filtered = filtered.filter(f => (f.dir || '') === dir);
  }

  if (search) {
    const q = search.toLowerCase();
    filtered = filtered.filter(f => f.filename.toLowerCase().includes(q) || (f.token && f.token.toLowerCase().includes(q)));
  }
  if (type === 'image') filtered = filtered.filter(f => f.mime.startsWith('image/'));
  if (type === 'video') filtered = filtered.filter(f => f.mime.startsWith('video/'));
  if (type === 'other') filtered = filtered.filter(f => !f.mime.startsWith('image/') && !f.mime.startsWith('video/'));

  const base = baseUrl(req);
  res.json(filtered.reverse().map(f => ({
    ...f,
    dir: f.dir || '',
    uploadedBy: f.browserId || f.clientKey || f.ip || '',
    savedBytes: Math.max(0, (f.originalSize || f.size || 0) - (f.size || 0)),
    exists: fs.existsSync(path.join(UPLOAD_DIR, f.storedName)),
    embed: hasEmbed(f.id),
    links: {
      view: `${base}/f/${f.id}`,
      raw: `${base}/f/${f.id}/raw`,
      embed: hasEmbed(f.id) ? `${base}/f/${f.id}/embed` : null,
      delete: `/api/admin/files/${f.id}`
    }
  })));
});

// Get trash count
app.get('/api/admin/trash/count', auth, (req, res) => {
  const files = readDB(FILES_DB);
  const count = files.filter(f => f.trashed).length;
  res.json({ count });
});

// Scan and reconcile filesystem with database
app.post('/api/admin/scan', auth, (req, res) => {
  const files = readDB(FILES_DB);
  const diskFiles = new Set();
  const report = { added: [], removed: [], missing: 0 };

  // Check all DB entries against disk
  for (let i = files.length - 1; i >= 0; i--) {
    const f = files[i];
    const fpath = path.join(UPLOAD_DIR, f.storedName);
    if (!fs.existsSync(fpath)) {
      files.splice(i, 1);
      report.missing++;
    } else {
      diskFiles.add(f.storedName);
    }
  }

  // Scan disk for files not in DB
  try {
    const dirFiles = fs.readdirSync(UPLOAD_DIR);
    for (const storedName of dirFiles) {
      if (diskFiles.has(storedName)) continue;
      const fpath = path.join(UPLOAD_DIR, storedName);
      const stat = fs.statSync(fpath);
      if (!stat.isFile()) continue;
      const ext = path.extname(storedName);
      const id = path.basename(storedName, ext);
      const entry = {
        id,
        filename: storedName,
        storedName,
        size: stat.size,
        mime: mime.lookup(storedName) || 'application/octet-stream',
        token: 'recovered',
        uploadedAt: stat.mtime.toISOString(),
        downloads: 0
      };
      files.push(entry);
      report.added.push(entry.filename);
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  writeDB(FILES_DB, files);
  res.json(report);
});

// Legacy chunk endpoints are blocked now that tus resumable uploads are enabled.
app.post('/api/upload/chunk', (req, res) => res.status(410).json({ error: 'Use tus uploads at /api/tus instead.' }));
app.post('/api/admin/upload/chunk', auth, (req, res) => res.status(410).json({ error: 'Use tus uploads at /api/tus instead.' }));

// Generate embed previews for existing large files
app.post('/api/admin/gen-embeds', auth, async (req, res) => {
  const files = readDB(FILES_DB);
  const report = { generated: 0, skipped: 0, errors: 0, details: [] };

  for (const file of files) {
    const filePath = path.join(UPLOAD_DIR, file.storedName);
    if (!fs.existsSync(filePath)) continue;
    const stat = fs.statSync(filePath);
    if (stat.size <= 50 * 1024 * 1024) { report.skipped++; continue; }
    if (!file.mime.startsWith('video/') && file.mime !== 'image/gif') { report.skipped++; continue; }
    if (hasEmbed(file.id)) { report.skipped++; continue; }

    try {
      const dur = await getVideoDuration(filePath);
      if (dur <= 0) { report.errors++; report.details.push(`${file.filename}: could not read duration`); continue; }

      let embedInput = filePath;
      let cleanup = false;
      if (file.mime === 'image/gif') {
        const gifMp4 = path.join(UPLOAD_DIR, file.id + '.embed.mp4');
        await convertToMp4(filePath, gifMp4);
        embedInput = gifMp4;
        cleanup = true;
      }
      await compressForEmbed(embedInput, file.id, dur);
      if (cleanup) fs.unlinkSync(embedInput);
      report.generated++;
      report.details.push(`${file.filename} → embed generated`);
    } catch (e) {
      report.errors++;
      report.details.push(`${file.filename}: ${e.message}`);
      log(`EMBED_GEN_ERR: ${file.filename} — ${e.message}`);
    }
  }

  res.json(report);
});

// Strip metadata from all existing files
app.post('/api/admin/strip-all-metadata', auth, async (req, res) => {
  const files = readDB(FILES_DB);
  const report = { stripped: 0, skipped: 0, errors: [], total: 0 };
  const mediaFiles = files.filter(f => !f.trashed && (f.mime.startsWith('image/') || f.mime.startsWith('video/')));
  report.total = mediaFiles.length;

  // Stream progress via SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  for (const file of mediaFiles) {
    const filePath = path.join(UPLOAD_DIR, file.storedName);
    if (!fs.existsSync(filePath)) { report.skipped++; continue; }
    send({ status: 'progress', file: file.filename, stripped: report.stripped, total: report.total });
    try {
      await stripMetadata(filePath, file.mime);
      const newSize = fs.statSync(filePath).size;
      // Update stored size in DB
      file.size = newSize;
      report.stripped++;
    } catch (e) {
      report.errors.push(`${file.filename}: ${e.message}`);
      report.skipped++;
    }
  }

  writeDB(FILES_DB, files);
  send({ status: 'done', ...report });
  res.end();
});

// Rename file
app.put('/api/admin/files/:id', auth, (req, res) => {
  let files = readDB(FILES_DB);
  const file = files.find(f => f.id === req.params.id);
  if (!file) return res.status(404).json({ error: 'File not found' });
  if (req.body.filename) file.filename = req.body.filename;
  if (req.body.dir !== undefined) file.dir = req.body.dir;
  writeDB(FILES_DB, files);
  res.json({ success: true, file });
});

// Move file to folder
app.put('/api/admin/files/:id/move', auth, (req, res) => {
  let files = readDB(FILES_DB);
  const file = files.find(f => f.id === req.params.id);
  if (!file) return res.status(404).json({ error: 'File not found' });
  file.dir = req.body.dir || '';
  writeDB(FILES_DB, files);
  res.json({ success: true });
});

// Trash file (soft delete)
app.post('/api/admin/files/:id/trash', auth, (req, res) => {
  let files = readDB(FILES_DB);
  const file = files.find(f => f.id === req.params.id);
  if (!file) return res.status(404).json({ error: 'File not found' });
  file.trashed = true;
  file.trashedAt = new Date().toISOString();
  writeDB(FILES_DB, files);
  res.json({ success: true });
});

// Restore file from trash
app.post('/api/admin/files/:id/restore', auth, (req, res) => {
  let files = readDB(FILES_DB);
  const file = files.find(f => f.id === req.params.id);
  if (!file) return res.status(404).json({ error: 'File not found' });
  file.trashed = false;
  delete file.trashedAt;
  writeDB(FILES_DB, files);
  res.json({ success: true });
});

// Permanent delete (single file)
app.delete('/api/admin/files/:id', auth, (req, res) => {
  let files = readDB(FILES_DB);
  const idx = files.findIndex(f => f.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'File not found' });
  const file = files[idx];
  try { fs.unlinkSync(path.join(UPLOAD_DIR, file.storedName)); } catch {}
  try { fs.unlinkSync(path.join(EMBED_DIR, file.id + '.mp4')); } catch {}
  files.splice(idx, 1);
  writeDB(FILES_DB, files);
  res.json({ success: true });
});

// Batch delete (permanent)
app.post('/api/admin/files/batch-delete', auth, (req, res) => {
  const ids = req.body.ids || [];
  let files = readDB(FILES_DB);
  let deleted = 0;
  for (const id of ids) {
    const idx = files.findIndex(f => f.id === id);
    if (idx === -1) continue;
    const file = files[idx];
    try { fs.unlinkSync(path.join(UPLOAD_DIR, file.storedName)); } catch {}
    files.splice(idx, 1);
    deleted++;
  }
  writeDB(FILES_DB, files);
  res.json({ success: true, deleted });
});

// Batch trash
app.post('/api/admin/files/batch-trash', auth, (req, res) => {
  const ids = req.body.ids || [];
  let files = readDB(FILES_DB);
  let trashed = 0;
  for (const id of ids) {
    const file = files.find(f => f.id === id);
    if (!file || file.trashed) continue;
    file.trashed = true;
    file.trashedAt = new Date().toISOString();
    trashed++;
  }
  writeDB(FILES_DB, files);
  res.json({ success: true, trashed });
});

// Empty trash
app.post('/api/admin/trash/empty', auth, (req, res) => {
  let files = readDB(FILES_DB);
  let purged = 0;
  for (let i = files.length - 1; i >= 0; i--) {
    if (files[i].trashed) {
      try { fs.unlinkSync(path.join(UPLOAD_DIR, files[i].storedName)); } catch {}
      files.splice(i, 1);
      purged++;
    }
  }
  writeDB(FILES_DB, files);
  res.json({ success: true, purged });
});

// --- Directory / Folder Management ---
const DIRS_DB = path.join(DATA_DIR, 'dirs.json');

app.get('/api/admin/dirs', auth, (req, res) => {
  const dirs = readDB(DIRS_DB);
  res.json(dirs);
});

app.post('/api/admin/dirs', auth, (req, res) => {
  const dirs = readDB(DIRS_DB);
  const dir = {
    id: uuidv4().slice(0, 8),
    name: req.body.name || 'New Folder',
    parent: req.body.parent || '',
    createdAt: new Date().toISOString()
  };
  dirs.push(dir);
  writeDB(DIRS_DB, dirs);
  res.json(dir);
});

app.put('/api/admin/dirs/:id', auth, (req, res) => {
  let dirs = readDB(DIRS_DB);
  const dir = dirs.find(d => d.id === req.params.id);
  if (!dir) return res.status(404).json({ error: 'Folder not found' });
  if (req.body.name) dir.name = req.body.name;
  if (req.body.parent !== undefined) dir.parent = req.body.parent;
  writeDB(DIRS_DB, dirs);
  res.json(dir);
});

app.delete('/api/admin/dirs/:id', auth, (req, res) => {
  let dirs = readDB(DIRS_DB);
  const id = req.params.id;
  dirs = dirs.filter(d => d.id !== id && d.parent !== id); // remove subfolders too
  writeDB(DIRS_DB, dirs);
  // Move files in deleted folder to root
  let files = readDB(FILES_DB);
  for (const f of files) {
    if (f.dir === id) f.dir = '';
  }
  writeDB(FILES_DB, files);
  res.json({ success: true });
});

// Stats
app.get('/api/admin/stats', auth, (req, res) => {
  const files = readDB(FILES_DB);
  const tokens = readDB(TOKENS_DB);
  const activeFiles = files.filter(f => !f.trashed);
  const trashedFiles = files.filter(f => f.trashed);
  const totalSize = activeFiles.reduce((s, f) => s + f.size, 0);
  const totalDownloads = activeFiles.reduce((s, f) => s + (f.downloads || 0), 0);
  const clients = loadClients();
  const bannedClients = clients.filter(c => c.banned).length;
  const publicBytes = activeFiles.filter(f => f.token !== 'admin').reduce((s, f) => s + (f.size || 0), 0);
  const dirs = readDB(DIRS_DB);
  res.json({
    totalFiles: activeFiles.length,
    trashedFiles: trashedFiles.length,
    totalSize,
    totalDownloads,
    publicBytes,
    clients: clients.length,
    bannedClients,
    activeTokens: tokens.filter(t => t.enabled).length,
    folders: dirs.length,
    server: {
      hostname: os.hostname(),
      platform: os.platform(),
      uptime: os.uptime(),
      freemem: os.freemem(),
      totalmem: os.totalmem()
    }
  });
});

// --- Token Management ---
app.get('/api/admin/tokens', auth, (req, res) => {
  const tokens = readDB(TOKENS_DB);
  const base = baseUrl(req);
  res.json(tokens.reverse().map(t => ({
    ...t,
    link: `${base}/upload/${t.id}`
  })));
});

app.post('/api/admin/tokens', auth, (req, res) => {
  const tokens = readDB(TOKENS_DB);
  const token = {
    id: uuidv4().slice(0, 8),
    name: req.body.name || 'Unnamed',
    enabled: true,
    createdAt: new Date().toISOString()
  };
  tokens.push(token);
  writeDB(TOKENS_DB, tokens);
  const base = baseUrl(req);
  res.json({ ...token, link: `${base}/upload/${token.id}` });
});

app.get('/api/admin/clients', auth, (req, res) => {
  const files = readDB(FILES_DB);
  const clients = loadClients().map(c => {
    const uploaded = files.filter(f => !f.trashed && (f.browserId === c.id || f.clientKey === c.id));
    return {
      ...c,
      uploadedFiles: uploaded.length || c.uploadedFiles || 0,
      uploadedBytes: uploaded.reduce((s, f) => s + (f.size || 0), 0) || c.uploadedBytes || 0,
      recentFiles: uploaded.slice(-20).reverse().map(f => ({ id: f.id, filename: f.filename, size: f.size, mime: f.mime, uploadedAt: f.uploadedAt, url: `/f/${f.id}` }))
    };
  }).sort((a, b) => (b.uploadedBytes || 0) - (a.uploadedBytes || 0));
  res.json(clients);
});

app.put('/api/admin/clients/:id', auth, (req, res) => {
  const clients = loadClients();
  const client = clients.find(c => c.id === req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  if (req.body.banned !== undefined) client.banned = !!req.body.banned;
  client.note = req.body.note || client.note || '';
  if (req.body.quotaOverrideBytes !== undefined) client.quotaOverrideBytes = Number(req.body.quotaOverrideBytes) || 0;
  if (req.body.quotaOverrideFiles !== undefined) client.quotaOverrideFiles = Number(req.body.quotaOverrideFiles) || 0;
  saveClients(clients);
  appendIpLog({ event: client.banned ? 'client_banned' : 'client_unbanned', clientId: client.id });
  res.json(client);
});

app.get('/api/admin/transcodes', auth, (req, res) => {
  res.json(getTranscodeJobs());
});

app.get('/api/admin/limit-codes', auth, (req, res) => {
  res.json(readDB(LIMIT_CODES_DB).slice().reverse());
});

app.post('/api/admin/limit-codes', auth, (req, res) => {
  const codes = readDB(LIMIT_CODES_DB);
  const days = Math.max(1, Number(req.body.days || 7));
  const code = {
    code: uuidv4().replace(/-/g, '').slice(0, 16),
    label: req.body.label || 'Upload password',
    enabled: true,
    createdAt: nowIso(),
    expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
  };
  codes.push(code);
  writeDB(LIMIT_CODES_DB, codes);
  res.json(code);
});

app.put('/api/admin/limit-codes/:code', auth, (req, res) => {
  const codes = readDB(LIMIT_CODES_DB);
  const code = codes.find(c => c.code === req.params.code);
  if (!code) return res.status(404).json({ error: 'Code not found' });
  if (req.body.enabled !== undefined) code.enabled = !!req.body.enabled;
  writeDB(LIMIT_CODES_DB, codes);
  res.json(code);
});

app.delete('/api/admin/tokens/:id', auth, (req, res) => {
  let tokens = readDB(TOKENS_DB);
  tokens = tokens.filter(t => t.id !== req.params.id);
  writeDB(TOKENS_DB, tokens);
  res.json({ success: true });
});

app.put('/api/admin/tokens/:id', auth, (req, res) => {
  let tokens = readDB(TOKENS_DB);
  const token = tokens.find(t => t.id === req.params.id);
  if (!token) return res.status(404).json({ error: 'Token not found' });
  if (req.body.name !== undefined) token.name = req.body.name;
  if (req.body.enabled !== undefined) token.enabled = req.body.enabled;
  writeDB(TOKENS_DB, tokens);
  res.json(token);
});

// --- Public Routes ---

// File view with Discord embeds
app.get('/f/:id', (req, res) => {
  const files = readDB(FILES_DB);
  const file = files.find(f => f.id === req.params.id);
  if (!file) return res.status(404).send('File not found');

  file.downloads = (file.downloads || 0) + 1;
  writeDB(FILES_DB, files);

  const base = baseUrl(req);
  const rawUrl = `${base}/f/${file.id}/raw`;
  const fileUrl = `${base}/f/${file.id}`;
  const embedUrl = `${base}/f/${file.id}/embed`;
  const isImage = file.mime.startsWith('image/');
  const isVideo = file.mime.startsWith('video/');
  const isAudio = file.mime.startsWith('audio/');
  const isGif = file.mime === 'image/gif';
  const sizeStr = formatSize(file.size);
  const originalSizeStr = formatSize(file.originalSize || file.size);
  const hasPreview = !!file.previewName;
  const hasEmbedPreview = hasEmbed(file.id);
  const processingVideo = isVideo && !hasPreview && !hasEmbedPreview;
  const embeddableVideo = isVideo && !file.mime.includes('x-msvideo') && !file.mime.includes('ms-wmv') && !processingVideo;
  // Preview URL: use preview (H264 re-encoded) for playback, raw for download
  const previewSrc = hasPreview ? `${fileUrl}/preview` : (hasEmbedPreview ? embedUrl : rawUrl);

  let embedMeta = '';
  if (isImage && !isGif) {
    embedMeta = `
      <meta property="og:title" content="${escapeHtml(file.filename)}" />
      <meta property="og:type" content="website" />
      <meta property="og:image" content="${rawUrl}" />
      <meta property="og:image:type" content="${file.originalMime || file.mime}" />
      <meta property="og:description" content="Size: ${originalSizeStr} — Image" />
      <meta property="twitter:card" content="summary_large_image" />
      <meta property="twitter:image" content="${rawUrl}" />`;
  } else if (isGif) {
    const gifUrl = hasEmbedPreview ? embedUrl : rawUrl;
    embedMeta = `
      <meta property="og:title" content="${escapeHtml(file.filename)}" />
      <meta property="og:type" content="video.other" />
      <meta property="og:video" content="${gifUrl}" />
      <meta property="og:video:type" content="${hasEmbedPreview ? 'video/mp4' : 'image/gif'}" />
      <meta property="og:image" content="${rawUrl}" />
      <meta property="og:image:type" content="image/gif" />
      <meta property="og:description" content="Size: ${originalSizeStr} — GIF" />
      <meta property="twitter:card" content="player" />
      <meta property="twitter:player" content="${fileUrl}" />`;
  } else if (embeddableVideo) {
    const videoUrl = hasEmbedPreview ? embedUrl : rawUrl;
    embedMeta = `
      <meta property="og:title" content="${escapeHtml(file.filename)}" />
      <meta property="og:type" content="video.other" />
      <meta property="og:video" content="${videoUrl}" />
      <meta property="og:video:secure_url" content="${videoUrl}" />
      <meta property="og:video:type" content="video/mp4" />
      <meta property="og:video:width" content="1280" />
      <meta property="og:video:height" content="720" />
      <meta property="og:description" content="Size: ${originalSizeStr} — Video" />
      <meta property="twitter:card" content="player" />
      <meta property="twitter:player" content="${fileUrl}" />`;
  } else if (isAudio) {
    embedMeta = `
      <meta property="og:title" content="${escapeHtml(file.filename)}" />
      <meta property="og:type" content="music.song" />
      <meta property="og:audio" content="${rawUrl}" />
      <meta property="og:audio:type" content="${file.mime}" />
      <meta property="og:description" content="Size: ${originalSizeStr} — Audio" />
      <meta property="twitter:card" content="summary" />`;
  } else {
    embedMeta = `
      <meta property="og:title" content="${escapeHtml(file.filename)}" />
      <meta property="og:type" content="object" />
      <meta property="og:description" content="Size: ${originalSizeStr} — Click to download" />
      <meta property="twitter:card" content="summary" />`;
  }

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta property="og:url" content="${fileUrl}" />
  <meta property="og:site_name" content="Fileshare" />
  ${embedMeta}
  <title>${escapeHtml(file.filename)} - Fileshare</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #1a1a2e; color: #e0e0e0; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; }
    .container { max-width: 900px; width: 100%; padding: 2rem; }
    .card { background: #16213e; border-radius: 12px; padding: 2rem; box-shadow: 0 8px 32px rgba(0,0,0,0.3); }
    .file-name { font-size: 1.3rem; font-weight: 600; margin-bottom: 0.5rem; word-break: break-word; }
    .file-meta { color: #888; font-size: 0.9rem; margin-bottom: 1.5rem; }
    .file-meta span { margin-right: 1rem; }
    .preview { margin-bottom: 1.5rem; border-radius: 8px; overflow: hidden; background: #0f3460; }
    .preview img, .preview video { max-width: 100%; max-height: 70vh; display: block; margin: 0 auto; }
    .preview audio { width: 100%; padding: 1rem; }
    .actions { display: flex; gap: 0.75rem; flex-wrap: wrap; }
    .btn { display: inline-flex; align-items: center; gap: 0.5rem; padding: 0.75rem 1.5rem; border-radius: 8px; text-decoration: none; font-size: 0.95rem; font-weight: 500; transition: all 0.2s; cursor: pointer; border: none; }
    .btn-primary { background: #0f3460; color: white; }
    .btn-primary:hover { background: #1a4a7a; transform: translateY(-1px); }
    .btn-secondary { background: #2d2d44; color: #e0e0e0; }
    .btn-secondary:hover { background: #3d3d55; }
    .btn-success { background: #1b5e20; color: white; }
    .btn-success:hover { background: #2e7d32; }
    .back-link { margin-top: 2rem; text-align: center; }
    .back-link a { color: #888; text-decoration: none; }
    .back-link a:hover { color: #ccc; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="file-name">${escapeHtml(file.filename)}</div>
      <div class="file-meta">
        <span>${originalSizeStr}</span>
        <span>${file.originalMime || file.mime}</span>
        <span>${new Date(file.uploadedAt).toLocaleDateString()}</span>
        ${hasPreview && file.size !== file.originalSize ? `<span style="color:#3fb950">Optimized: ${sizeStr}</span>` : ''}
      </div>
      ${isImage ? `<div class="preview"><img src="${rawUrl}" alt="${escapeHtml(file.filename)}" /></div>` : ''}
      ${embeddableVideo ? `<div class="preview"><video controls preload="metadata"><source src="${previewSrc}" type="video/mp4"></video></div>` : ''}
      ${processingVideo ? `<div class="preview" style="padding:2rem;text-align:center;color:#888;"><p>&#9203; This video is being transcoded for browser playback.</p><p style="margin-top:0.5rem;font-size:0.85rem;">Download the file and check back soon.</p></div>` : ''}
      ${isVideo && !embeddableVideo && !processingVideo ? `<div class="preview" style="padding:2rem;text-align:center;color:#888;"><p>This video format cannot be previewed in your browser.</p><p style="margin-top:0.5rem;font-size:0.85rem;">Use the download button below.</p></div>` : ''}
      ${isAudio ? `<div class="preview"><audio controls preload="metadata"><source src="${rawUrl}" type="${file.mime}"></audio></div>` : ''}
      <div class="actions">
        <a href="${rawUrl}" class="btn btn-primary" download="${escapeHtml(file.filename)}">Download (${originalSizeStr})</a>
        ${hasPreview && file.size !== file.originalSize ? `<a href="${fileUrl}/preview" class="btn btn-success" download="${escapeHtml(file.filename)}.mp4">Download Compressed (${sizeStr})</a>` : ''}
        <button class="btn btn-secondary" onclick="navigator.clipboard.writeText('${rawUrl}').then(() => { this.textContent = 'Copied!'; setTimeout(() => { this.textContent = 'Copy Link'; }, 2000); })">Copy Link</button>
      </div>
    </div>
    <div class="back-link"><a href="/">&larr; Fileshare</a></div>
  </div>
</body>
</html>`);
});

// Raw file (original, not preview)
app.get('/f/:id/raw', (req, res) => {
  const files = readDB(FILES_DB);
  const file = files.find(f => f.id === req.params.id);
  if (!file) return res.status(404).send('File not found');
  const filePath = path.join(UPLOAD_DIR, file.storedName);
  if (!fs.existsSync(filePath)) return res.status(404).send('File not found on disk');
  const rawMime = file.originalMime || file.mime;
  res.set('Content-Type', rawMime);
  res.set('Content-Disposition', `inline; filename="${file.filename}"`);
  res.set('Cache-Control', 'public, max-age=31536000');
  res.set('Accept-Ranges', 'bytes');
  res.sendFile(filePath);
});

// Embed preview (compressed version for Discord embeds)
app.get('/f/:id/embed', (req, res) => {
  const files = readDB(FILES_DB);
  const file = files.find(f => f.id === req.params.id);
  if (!file) return res.status(404).send('File not found');
  const embedPath = path.join(EMBED_DIR, file.id + '.mp4');
  if (fs.existsSync(embedPath)) {
    res.set('Content-Type', 'video/mp4');
    res.set('Cache-Control', 'public, max-age=31536000');
    res.set('Accept-Ranges', 'bytes');
    return res.sendFile(embedPath);
  }
  if (file.previewName) {
    const previewPath = path.join(UPLOAD_DIR, file.previewName);
    if (fs.existsSync(previewPath)) {
      res.set('Content-Type', 'video/mp4');
      res.set('Cache-Control', 'public, max-age=31536000');
      res.set('Accept-Ranges', 'bytes');
      return res.sendFile(previewPath);
    }
  }
  res.status(404).send('No embed preview available');
});

// Preview file (re-encoded browser-friendly version)
app.get('/f/:id/preview', (req, res) => {
  const files = readDB(FILES_DB);
  const file = files.find(f => f.id === req.params.id);
  if (!file) return res.status(404).send('File not found');
  if (!file.previewName) return res.redirect(`/f/${file.id}/raw`);
  const previewPath = path.join(UPLOAD_DIR, file.previewName);
  if (!fs.existsSync(previewPath)) return res.redirect(`/f/${file.id}/raw`);
  const previewMime = file.previewName.endsWith('.mp4') ? 'video/mp4' : file.previewName.endsWith('.jpg') ? 'image/jpeg' : file.mime;
  res.set('Content-Type', previewMime);
  res.set('Content-Disposition', `inline; filename="${file.filename}"`);
  res.set('Cache-Control', 'public, max-age=31536000');
  res.set('Accept-Ranges', 'bytes');
  res.sendFile(previewPath);
});

// Upload page for a specific token
app.get('/upload/:token', (req, res) => {
  const tokens = readDB(TOKENS_DB);
  const token = tokens.find(t => t.id === req.params.token && t.enabled);
  if (!token) return res.status(404).send('Invalid or disabled upload link');
  res.sendFile(path.join(__dirname, 'public', 'upload.html'));
});

// Admin login page (no auth required)
app.get('/admin/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'login.html'));
});

// Local network detection
app.get('/api/local-check', (req, res) => {
  const clientIp = req.headers['cf-connecting-ip'] || req.ip || req.connection.remoteAddress || '';
  const cleanIp = clientIp.replace(/^::ffff:/, '');
  const interfaces = os.networkInterfaces();
  const localIPs = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        localIPs.push(iface.address);
      }
    }
  }
  const isLocal = localIPs.some(ip => {
    if (!cleanIp) return false;
    const parts = ip.split('.');
    const clientParts = cleanIp.split('.');
    return parts[0] === clientParts[0] && parts[1] === clientParts[1];
  });
  res.json({
    local: isLocal,
    localUrl: localIPs.length > 0 ? `http://${localIPs[0]}:${PORT}` : null,
    localIPs
  });
});

// Ping endpoint for local network detection
app.get('/api/ping', (req, res) => res.json({ ok: true }));

app.get('/api/me', (req, res) => {
  const ip = getClientIp(req);
  const browserId = getBrowserId(req);
  const usage = getUsageFor(browserId, ip);
  const clients = loadClients();
  const client = clients.find(c => c.id === browserId) || clients.find(c => c.id === `ip:${ip}`);
  res.json({
    browserId,
    nickname: client?.nickname || '',
    ip,
    usedBytes: usage.uploadedBytes,
    uploadedFiles: usage.uploadedFiles,
    limitBytes: usage.limitBytes,
    limitFiles: usage.limitFiles,
    banned: usage.banned,
    avgSpeed: client?.avgSpeed || 0
  });
});

app.put('/api/me/nickname', (req, res) => {
  const ip = getClientIp(req);
  const browserId = getBrowserId(req);
  if (!browserId) return res.status(400).json({ error: 'Browser ID required' });
  const nickname = String(req.body.nickname || '').trim().slice(0, 30);
  const clients = loadClients();
  let client = clients.find(c => c.id === browserId);
  if (!client) {
    client = { id: browserId, nickname, firstSeen: nowIso(), uploadedBytes: 0, uploadedFiles: 0, banned: false, ips: [ip], userAgents: [], files: [], avgSpeed: 0 };
    clients.push(client);
  } else {
    client.nickname = nickname;
  }
  saveClients(clients);
  res.json({ success: true, nickname });
});

app.get('/api/tus/:id/result', (req, res) => {
  const done = tusCompletions.get(req.params.id);
  if (done) return res.json(done);
  const files = readDB(FILES_DB);
  const file = files.find(f => f.id === req.params.id);
  if (file) return res.json({ success: true, file, url: `/f/${file.id}` });
  res.status(202).json({ pending: true });
});

app.all('/api/tus*', (req, res) => {
  if (!tusServer) return res.status(503).json({ error: 'Tus server is starting' });
  tusServer.handle(req, res);
});

app.get('/vendor/tus.min.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules', 'tus-js-client', 'dist', 'tus.min.js'));
});

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Start server
async function setupTus() {
  const { Server } = await import('@tus/server');
  const { FileStore } = await import('@tus/file-store');
  tusServer = new Server({
    path: '/api/tus',
    datastore: new FileStore({ directory: TUS_DIR }),
    maxSize: (req) => {
      const nodeReq = req.runtime?.node?.req;
      const headers = nodeReq?.headers || {};
      const override = headers['authorization'] || headers['x-admin-password'] === ADMIN_PASSWORD || validateLimitCode(headers['x-upload-password']);
      return override ? 20 * PUBLIC_SIZE_LIMIT : PUBLIC_SIZE_LIMIT;
    },
    allowedHeaders: ['Authorization', 'X-Browser-Id', 'X-Upload-Password'],
    exposedHeaders: ['Location', 'Upload-Offset', 'Upload-Length'],
    respectForwardedHeaders: true,
    relativeLocation: true,
    async onIncomingRequest(webReq) {
      const nodeReq = webReq.runtime?.node?.req;
      if (!nodeReq) return;
      const ip = getClientIp(nodeReq);
      const browserId = getBrowserId(nodeReq);
      const client = findOrCreateClient(browserId, ip, nodeReq.headers['user-agent'] || '');
      if (!isAdminOverride(nodeReq) && client.banned) {
        const err = new Error('This browser is banned from uploading');
        err.status_code = 403;
        err.body = err.message;
        throw err;
      }
    },
    async onUploadCreate(webReq, upload) {
      const nodeReq = webReq.runtime?.node?.req;
      if (!nodeReq) return {};
      const meta = upload.metadata || {};
      const filename = meta.filename || 'upload';
      const fileMime = meta.filetype || mime.lookup(filename) || 'application/octet-stream';
      const size = Number(upload.size || upload.upload_length || 0);
      if (!isAdminOverride(nodeReq)) {
        try { publicUploadGuard(nodeReq, { filename, mime: fileMime, size }); }
        catch (e) {
          const err = new Error(e.message || 'Upload rejected');
          err.status_code = e.status || 400;
          err.body = err.message;
          throw err;
        }
      }
      return { metadata: { ...meta, filetype: fileMime, browserId: getBrowserId(nodeReq), ip: getClientIp(nodeReq) } };
    },
    async onResponseError(webReq, err) {
      log(`TUS_ERROR: ${err.status_code || err.status || 500} — ${err.message || err.body || 'Unknown error'}`);
      if (err.stack) log(`TUS_ERROR_STACK: ${err.stack.slice(0, 500)}`);
      if (err.status_code || err.status) {
        return { status_code: err.status_code || err.status, body: err.body || err.message || 'Upload rejected' };
      }
      return { status_code: 500, body: err.message || 'Internal server error' };
    },
    async onUploadFinish(webReq, upload) {
      const nodeReq = webReq.runtime?.node?.req;
      if (!nodeReq) {
        log(`TUS_FINISH_ERR: no node req for upload ${upload?.id || '?'}`);
        return {};
      }
      const id = path.basename(upload.id);
      const sourcePath = path.join(TUS_DIR, id);
      const meta = upload.metadata || {};
      const elapsed = upload.creation_date ? (Date.now() - new Date(upload.creation_date).getTime()) / 1000 : 0;
      const speedBps = elapsed > 0 ? Math.round((Number(upload.size || 0)) / elapsed) : 0;
      const result = {};
      try {
        await finalizeStoredUpload({
          req: nodeReq,
          res: {
            json(payload) {
              Object.assign(result, payload);
              tusCompletions.set(id, payload);
              setTimeout(() => tusCompletions.delete(id), 30 * 60 * 1000);
            },
            status(code) {
              return { json(payload) {
                Object.assign(result, { ...payload, status: code });
                tusCompletions.set(id, { ...payload, status: code });
                setTimeout(() => tusCompletions.delete(id), 30 * 60 * 1000);
              }};
            }
          },
          sourcePath,
          originalName: meta.filename || id,
          originalMime: meta.filetype || mime.lookup(meta.filename || id) || 'application/octet-stream',
          originalSize: Number(upload.size || fs.statSync(sourcePath).size),
          token: meta.token || (isAdminOverride(nodeReq) ? 'admin' : null),
          id,
          speedBps
        });
      } catch (e) {
        log(`TUS_FINISH_ERR: ${id} — ${e.message || e}\n${e.stack || ''}`);
        if (fs.existsSync(sourcePath)) {
          const recoveredPath = path.join(UPLOAD_DIR, id + '_recovered' + (path.extname(meta.filename || id) || '.mp4'));
          try {
            fs.renameSync(sourcePath, recoveredPath);
            const tusJson = sourcePath + '.json';
            if (fs.existsSync(tusJson)) fs.unlinkSync(tusJson);
            log(`TUS_RECOVERED: ${id} -> ${recoveredPath}`);
          } catch (e2) {
            log(`TUS_RECOVERY_FAIL: ${id} — ${e2.message}`);
          }
        }
      }
      return { headers: { 'X-File-Id': id, 'X-File-Url': `/f/${id}` } };
    }
  });
}

setupTus().then(async () => {
  // Recover stuck tus uploads from previous crashes/restarts
  try {
    const files = readDB(FILES_DB);
    const existingIds = new Set(files.map(f => f.id));
    const tusFiles = fs.readdirSync(TUS_DIR).filter(f => !f.endsWith('.json'));
    let recovered = 0;
    for (const id of tusFiles) {
      if (existingIds.has(id)) { try { fs.unlinkSync(path.join(TUS_DIR, id)); fs.unlinkSync(path.join(TUS_DIR, id + '.json')); } catch {} continue; }
      const jsonPath = path.join(TUS_DIR, id + '.json');
      if (!fs.existsSync(jsonPath)) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        const sourcePath = path.join(TUS_DIR, id);
        const srcSize = fs.statSync(sourcePath).size;
        const expectedSize = Number(meta.size || 0);
        if (expectedSize > 0 && srcSize < expectedSize) continue;
        const filename = meta.metadata?.filename || id;
        const fileMime = meta.metadata?.filetype || mime.lookup(filename) || 'application/octet-stream';
        const browserId = meta.metadata?.browserId || '';
        const ip = meta.metadata?.ip || '';
        const token = meta.metadata?.token || null;

        log(`TUS_RECOVERY_PROCESSING: ${id} (${filename}, ${srcSize}B)`);
        await finalizeStoredUpload({
          req: { headers: { 'x-browser-id': browserId, 'x-admin-password': ADMIN_PASSWORD, ...(meta.metadata || {}) }, ip, connection: { remoteAddress: ip } },
          res: { json(p) { return p; }, status(c) { return { json(p) { return p; } }; } },
          sourcePath,
          originalName: filename,
          originalMime: fileMime,
          originalSize: expectedSize || srcSize,
          token: token || 'admin',
          id,
          speedBps: 0
        });
        recovered++;
      } catch (e) { log(`TUS_RECOVERY_ERR: ${id} - ${e.message}\n${e.stack || ''}`); }
    }
    if (recovered > 0) { log(`TUS_RECOVERY: ${recovered} stuck uploads recovered with transcoding`); }
  } catch (e) { log(`TUS_RECOVERY_ERR: ${e.message}`); }

  app.listen(PORT, () => {
    console.log(`Fileshare running on http://localhost:${PORT}`);
    console.log(`Admin panel: http://localhost:${PORT}/admin`);
    console.log(`Password: ${ADMIN_PASSWORD === '8762' ? '8762 (default)' : '(custom)'}`);
  });
}).catch(err => {
  console.error('Failed to start tus server', err);
  process.exit(1);
});

// --- Helpers ---

// Generate embed preview asynchronously after upload response is sent
function baseUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL.replace(/\/+$/, '');
  return `${req.protocol}://${req.headers.host || `localhost:${PORT}`}`;
}

function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function escapeHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// General error handler
app.use((err, req, res, next) => {
  log(`ERROR: ${err.message}\n${err.stack}`);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Internal server error' });
});
