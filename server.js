const express = require('express');
const cors = require('cors');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' })); // посты с картинками весят больше, увеличиваем лимит

const DB_FILE = './users.json';
const POSTS_FILE = './posts.json';

let users = {};
if (fs.existsSync(DB_FILE)) {
  try { users = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { users = {}; }
}
function saveUsers() { fs.writeFileSync(DB_FILE, JSON.stringify(users)); }

let posts = [];
if (fs.existsSync(POSTS_FILE)) {
  try { posts = JSON.parse(fs.readFileSync(POSTS_FILE, 'utf8')); } catch (e) { posts = []; }
}
function savePosts() { fs.writeFileSync(POSTS_FILE, JSON.stringify(posts)); }

// ===== Пользователи (регистрация / поиск по нику) =====
app.post('/users/register', (req, res) => {
  const { id, nick, avatar, status } = req.body;
  if (!id || !nick) return res.status(400).json({ error: 'id and nick required' });
  users[id] = { id, nick, avatar: avatar || null, status: status || 'online', updatedAt: Date.now() };
  saveUsers();
  res.json({ ok: true });
});

app.get('/users/search', (req, res) => {
  const term = (req.query.nick || '').toLowerCase();
  if (!term) return res.json([]);
  const results = Object.values(users).filter(u => u.nick.toLowerCase().includes(term));
  res.json(results.slice(0, 30));
});

// ===== Посты (видны всем, кто открыл приложение — не только тем, кто был онлайн одновременно) =====
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
    if (posts.length > 500) posts = posts.slice(-500); // не даём файлу расти бесконечно
    savePosts();
  }
  res.json({ ok: true });
});

app.get('/posts', (req, res) => {
  const sorted = [...posts].sort((a, b) => b.timestamp - a.timestamp);
  res.json(sorted.slice(0, 200));
});

app.delete('/posts/:id', (req, res) => {
  const { id } = req.params;
  const { authorId } = req.query;
  const idx = posts.findIndex(p => p.id === id);
  if (idx === -1) return res.json({ ok: true }); // уже удалён — считаем успехом
  if (posts[idx].authorId !== authorId) return res.status(403).json({ error: 'not owner' });
  posts.splice(idx, 1);
  savePosts();
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log('User directory server running on port ' + PORT));