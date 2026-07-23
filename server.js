const express = require('express');
const cors = require('cors');
const fs = require('fs');
const nodemailer = require('nodemailer');

const app = express();
app.use(cors());
app.use(express.json({ limit: '8mb' }));

// ======================== ХРАНИЛИЩА (простые JSON-файлы на диске) ========================
const DB_FILE = './users.json';
const POSTS_FILE = './posts.json';
const GROUPS_FILE = './groups.json';
const ACCOUNTS_FILE = './accounts.json';

let users = {};
if (fs.existsSync(DB_FILE)) { try { users = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { users = {}; } }
function saveUsers() { fs.writeFileSync(DB_FILE, JSON.stringify(users)); }

let posts = [];
if (fs.existsSync(POSTS_FILE)) { try { posts = JSON.parse(fs.readFileSync(POSTS_FILE, 'utf8')); } catch (e) { posts = []; } }
function savePosts() { fs.writeFileSync(POSTS_FILE, JSON.stringify(posts)); }

let groups = {};
if (fs.existsSync(GROUPS_FILE)) { try { groups = JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf8')); } catch (e) { groups = {}; } }
function saveGroups() { fs.writeFileSync(GROUPS_FILE, JSON.stringify(groups)); }

// Аккаунты (логин/пароль/почта/2FA) — отдельно от "users" (публичные профили для поиска),
// потому что это чувствительные данные аутентификации
let accounts = {};
if (fs.existsSync(ACCOUNTS_FILE)) { try { accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')); } catch (e) { accounts = {}; } }
function saveAccounts() { fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts)); }

// Одноразовые коды (2FA / сброс пароля) — в памяти, живут 10 минут.
// Если сервер перезапустится (Render иногда так делает после "сна") — коды
// станут недействительными, пользователь просто запросит новый.
const pendingCodes = {}; // login -> { code, purpose, expiresAt }

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function mask(email) {
  if (!email) return '';
  const [a, b] = email.split('@');
  if (!b) return email;
  return a.slice(0, 2) + '***@' + b;
}

async function verifyTurnstile(token, ip) {
  if (!process.env.TURNSTILE_SECRET_KEY) return true; // не настроено — не блокируем (режим разработки без капчи)
  if (!token) return false;
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: process.env.TURNSTILE_SECRET_KEY, response: token, remoteip: ip || '' })
    });
    const data = await res.json();
    return data.success === true;
  } catch (e) { return false; }
}

// Отправка почты через твой личный Gmail-аккаунт (пароль приложения, не основной пароль).
// Транспорт создаём один раз и переиспользуем — так быстрее, чем открывать
// новое SMTP-соединение на каждое письмо.
let mailTransporter = null;
function getMailTransporter() {
  if (mailTransporter) return mailTransporter;
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    throw new Error('GMAIL_USER / GMAIL_APP_PASSWORD не настроены в Environment Variables на Render');
  }
  mailTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD
    }
  });
  return mailTransporter;
}

async function sendEmailCode(toEmail, code) {
  const transporter = getMailTransporter();
  await transporter.sendMail({
    from: `"heartfelt-crumble" <${process.env.GMAIL_USER}>`,
    to: toEmail,
    subject: 'Ваш код подтверждения',
    html: `<p>Ваш код: <b style="font-size:22px;">${code}</b></p><p>Код действителен 10 минут. Если это были не вы — просто проигнорируйте письмо.</p>`
  });
}
// ===== АУТЕНТИФИКАЦИЯ =====

// Регистрация — принимает уже хешированный пароль (клиент хеширует SHA-256,
// как и раньше — сырой пароль на сервер не уходит вообще)
app.post('/auth/register', async (req, res) => {
  const { login, passwordHash, turnstileToken } = req.body;
  const ok = await verifyTurnstile(turnstileToken, req.ip);
  if (!ok) return res.status(403).json({ error: 'Проверка на бота не пройдена' });
  if (!login || !passwordHash) return res.status(400).json({ error: 'Заполните логин и пароль' });
  if (accounts[login]) return res.status(409).json({ error: 'Такой логин уже существует' });
  accounts[login] = { login, passwordHash, email: null, twoFAEnabled: false };
  saveAccounts();
  res.json({ ok: true });
});

// Шаг 1 входа: проверяем пароль, сообщаем нужна ли 2FA
app.post('/auth/login', async (req, res) => {
  const { login, passwordHash, turnstileToken } = req.body;
  const ok = await verifyTurnstile(turnstileToken, req.ip);
  if (!ok) return res.status(403).json({ error: 'Проверка на бота не пройдена' });
  const acc = accounts[login];
  if (!acc) return res.status(404).json({ error: 'Аккаунт не найден' });
  if (acc.passwordHash !== passwordHash) return res.status(401).json({ error: 'Неверный пароль' });
  if (acc.twoFAEnabled) {
    return res.json({ ok: true, needs2FA: true, maskedEmail: mask(acc.email) });
  }
  res.json({ ok: true, needs2FA: false });
});

// Отправка кода на почту — используется и для 2FA при входе, и для сброса пароля
app.post('/auth/send-code', async (req, res) => {
  const { login, purpose } = req.body; // purpose: '2fa' | 'reset'
  const acc = accounts[login];
  if (!acc) return res.status(404).json({ error: 'Аккаунт не найден' });
  if (!acc.email) return res.status(400).json({ error: 'К аккаунту не привязана почта — восстановление недоступно' });

  const code = generateCode();
  pendingCodes[login] = { code, purpose, expiresAt: Date.now() + 10 * 60 * 1000 };

  try {
    await sendEmailCode(acc.email, code);
    res.json({ ok: true, maskedEmail: mask(acc.email) });
  } catch (e) {
    res.status(500).json({ error: 'Не удалось отправить письмо: ' + e.message });
  }
});

// Проверка кода — используется и для 2FA, и для сброса пароля
app.post('/auth/verify-code', (req, res) => {
  const { login, code, purpose } = req.body;
  const entry = pendingCodes[login];
  if (!entry || entry.purpose !== purpose) return res.status(400).json({ error: 'Код не запрошен' });
  if (Date.now() > entry.expiresAt) { delete pendingCodes[login]; return res.status(400).json({ error: 'Код истёк, запросите новый' }); }
  if (entry.code !== code) return res.status(400).json({ error: 'Неверный код' });
  delete pendingCodes[login];
  res.json({ ok: true });
});

// Сброс пароля — вызывается ТОЛЬКО после успешной проверки кода с purpose='reset'
app.post('/auth/reset-password', (req, res) => {
  const { login, newPasswordHash } = req.body;
  const acc = accounts[login];
  if (!acc) return res.status(404).json({ error: 'Аккаунт не найден' });
  acc.passwordHash = newPasswordHash;
  saveAccounts();
  res.json({ ok: true });
});

// Привязка почты и включение/выключение 2FA — со страницы настроек.
// Включить 2FA можно только если почта уже привязана.
app.post('/auth/update-security', (req, res) => {
  const { login, email, twoFAEnabled } = req.body;
  const acc = accounts[login];
  if (!acc) return res.status(404).json({ error: 'Аккаунт не найден' });
  if (email !== undefined) acc.email = email;
  if (twoFAEnabled !== undefined) {
    if (twoFAEnabled && !acc.email) return res.status(400).json({ error: 'Сначала привяжите почту' });
    acc.twoFAEnabled = twoFAEnabled;
  }
  saveAccounts();
  res.json({ ok: true });
});

app.get('/auth/security-status/:login', (req, res) => {
  const acc = accounts[req.params.login];
  if (!acc) return res.status(404).json({ error: 'not found' });
  res.json({ email: acc.email, maskedEmail: mask(acc.email), twoFAEnabled: acc.twoFAEnabled });
});

// ===== ПОЛЬЗОВАТЕЛИ (публичные профили — для поиска по нику) =====
app.post('/users/register', (req, res) => {
  const { accountId, peerId, nick, avatar, status } = req.body;
  if (!accountId || !nick) return res.status(400).json({ error: 'accountId and nick required' });
  users[accountId] = { accountId, peerId: peerId || null, nick, avatar: avatar || null, status: status || 'online', updatedAt: Date.now() };
  saveUsers();
  res.json({ ok: true });
});

app.get('/users/search', (req, res) => {
  const term = (req.query.nick || '').toLowerCase();
  if (!term) return res.json([]);
  const results = Object.values(users).filter(u => u.nick.toLowerCase().includes(term));
  res.json(results.slice(0, 30));
});

app.get('/users/by-account/:accountId', (req, res) => {
  const u = users[req.params.accountId];
  if (!u) return res.status(404).json({ error: 'not found' });
  res.json(u);
});

// ===== ПОСТЫ =====
app.post('/posts', (req, res) => {
  const { id, authorId, authorNick, authorAvatar, text, image, timestamp } = req.body;
  if (!id || !authorId) return res.status(400).json({ error: 'id and authorId required' });
  if (!posts.some(p => p.id === id)) {
    posts.push({
      id, authorId,
      authorNick: authorNick || 'Неизвестный',
      authorAvatar: authorAvatar || null,
      text: text || '',
      image: image || null,
      timestamp: timestamp || Date.now()
    });
    if (posts.length > 500) posts = posts.slice(-500);
    savePosts();
  }
  res.json({ ok: true });
});

app.get('/posts', (req, res) => {
  res.json([...posts].sort((a, b) => b.timestamp - a.timestamp).slice(0, 200));
});

app.delete('/posts/:id', (req, res) => {
  const { id } = req.params;
  const { authorId } = req.query;
  const idx = posts.findIndex(p => p.id === id);
  if (idx === -1) return res.json({ ok: true });
  if (posts[idx].authorId !== authorId) return res.status(403).json({ error: 'not owner' });
  posts.splice(idx, 1);
  savePosts();
  res.json({ ok: true });
});

// ===== ГРУППЫ =====
app.post('/groups', (req, res) => {
  const { id, name, avatar, createdBy, members } = req.body;
  if (!id || !name || !createdBy || !Array.isArray(members)) return res.status(400).json({ error: 'bad payload' });
  groups[id] = { id, name, avatar: avatar || null, createdBy, members, updatedAt: Date.now() };
  saveGroups();
  res.json({ ok: true, group: groups[id] });
});

app.get('/groups/member/:accountId', (req, res) => {
  const list = Object.values(groups).filter(g => g.members.includes(req.params.accountId));
  res.json(list);
});

app.get('/groups/:id', (req, res) => {
  const g = groups[req.params.id];
  if (!g) return res.status(404).json({ error: 'not found' });
  res.json(g);
});

app.put('/groups/:id', (req, res) => {
  const g = groups[req.params.id];
  if (!g) return res.status(404).json({ error: 'not found' });
  const { name, avatar, members, requesterId } = req.body;
  if (requesterId !== g.createdBy) return res.status(403).json({ error: 'only creator can edit' });
  if (name) g.name = name;
  if (avatar !== undefined) g.avatar = avatar;
  if (Array.isArray(members)) g.members = members;
  g.updatedAt = Date.now();
  saveGroups();
  res.json({ ok: true, group: g });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log('heartfelt-crumble server running on port ' + PORT));