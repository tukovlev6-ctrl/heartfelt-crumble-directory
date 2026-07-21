const express = require('express');
const cors = require('cors');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json({ limit: '8mb' }));

const DB_FILE = './users.json';
const POSTS_FILE = './posts.json';
const GROUPS_FILE = './groups.json';

// Пользователи теперь хранятся по accountId (= логин, никогда не меняется),
// а не по PeerJS ID (он текучий и раньше плодил "призраков" одного и того же человека)
let users = {};
if (fs.existsSync(DB_FILE)) { try { users = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { users = {}; } }
function saveUsers() { fs.writeFileSync(DB_FILE, JSON.stringify(users)); }

let posts = [];
if (fs.existsSync(POSTS_FILE)) { try { posts = JSON.parse(fs.readFileSync(POSTS_FILE, 'utf8')); } catch (e) { posts = []; } }
function savePosts() { fs.writeFileSync(POSTS_FILE, JSON.stringify(posts)); }

let groups = {};
if (fs.existsSync(GROUPS_FILE)) { try { groups = JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf8')); } catch (e) { groups = {}; } }
function saveGroups() { fs.writeFileSync(GROUPS_FILE, JSON.stringify(groups)); }

// ===== Пользователи =====
app.post('/users/register', (req, res) => {
  const { accountId, peerId, nick, avatar, status } = req.body;
  if (!accountId || !nick) return res.status(400).json({ error: 'accountId and nick required' });
  users[accountId] = {
    accountId,
    peerId: peerId || null,
    nick,
    avatar: avatar || null,
    status: status || 'online',
    updatedAt: Date.now()
  };
  saveUsers();
  res.json({ ok: true });
});

app.get('/users/search', (req, res) => {
  const term = (req.query.nick || '').toLowerCase();
  if (!term) return res.json([]);
  const results = Object.values(users).filter(u => u.nick.toLowerCase().includes(term));
  res.json(results.slice(0, 30));
});

// Получить текущий (свежий) PeerJS ID человека по его стабильному accountId —
// нужно перед подключением, чтобы не пытаться соединиться по устаревшему ID
app.get('/users/by-account/:accountId', (req, res) => {
  const u = users[req.params.accountId];
  if (!u) return res.status(404).json({ error: 'not found' });
  res.json(u);
});

// ===== Посты =====
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

// ===== Группы =====
app.post('/groups', (req, res) => {
  const { id, name, avatar, createdBy, members } = req.body;
  if (!id || !name || !createdBy || !Array.isArray(members)) return res.status(400).json({ error: 'bad payload' });
  groups[id] = { id, name, avatar: avatar || null, createdBy, members, updatedAt: Date.now() };
  saveGroups();
  res.json({ ok: true, group: groups[id] });
});

// Все группы, где состоит этот accountId — вызывается при запуске приложения
app.get('/groups/member/:accountId', (req, res) => {
  const list = Object.values(groups).filter(g => g.members.includes(req.params.accountId));
  res.json(list);
});

app.get('/groups/:id', (req, res) => {
  const g = groups[req.params.id];
  if (!g) return res.status(404).json({ error: 'not found' });
  res.json(g);
});

// Редактировать (имя/аватар/состав) может только создатель
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
app.listen(PORT, () => console.log('User directory server running on port ' + PORT));