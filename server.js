const express = require('express');
const cors = require('cors');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const DB_FILE = './users.json';
let users = {};
if (fs.existsSync(DB_FILE)) {
  try { users = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { users = {}; }
}
function save() { fs.writeFileSync(DB_FILE, JSON.stringify(users)); }

// Регистрация / обновление профиля (вызывается автоматически при входе и сохранении настроек)
app.post('/users/register', (req, res) => {
  const { id, nick, avatar, status } = req.body;
  if (!id || !nick) return res.status(400).json({ error: 'id and nick required' });
  users[id] = { id, nick, avatar: avatar || null, status: status || 'online', updatedAt: Date.now() };
  save();
  res.json({ ok: true });
});

// Поиск по нику (частичное совпадение, без учёта регистра)
app.get('/users/search', (req, res) => {
  const term = (req.query.nick || '').toLowerCase();
  if (!term) return res.json([]);
  const results = Object.values(users).filter(u => u.nick.toLowerCase().includes(term));
  res.json(results.slice(0, 30));
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log('User directory server running on port ' + PORT));
