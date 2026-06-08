const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ── Persistence ──────────────────────────────
const DATA_DIR  = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');
let sessions = {};

function loadData() {
  try { sessions = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { sessions = {}; }
}

function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(sessions, null, 2));
}

loadData();

// ── Helpers ──────────────────────────────────
const THEMES = [
  { bg: 'rgba(139,92,246,0.12)', border: 'rgba(139,92,246,0.4)', accent: '#a78bfa' },
  { bg: 'rgba(59,130,246,0.12)', border: 'rgba(59,130,246,0.4)', accent: '#60a5fa' },
  { bg: 'rgba(16,185,129,0.12)', border: 'rgba(16,185,129,0.4)', accent: '#34d399' },
  { bg: 'rgba(236,72,153,0.12)', border: 'rgba(236,72,153,0.4)', accent: '#f472b6' },
  { bg: 'rgba(245,158,11,0.12)', border: 'rgba(245,158,11,0.4)', accent: '#fbbf24' },
  { bg: 'rgba(6,182,212,0.12)', border: 'rgba(6,182,212,0.4)', accent: '#22d3ee' },
  { bg: 'rgba(239,68,68,0.12)', border: 'rgba(239,68,68,0.4)', accent: '#f87171' },
  { bg: 'rgba(52,211,153,0.12)', border: 'rgba(52,211,153,0.4)', accent: '#6ee7b7' },
];

function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// 오전 6시 이전이면 전날 날짜를 활성 세션으로 사용
function activeSessionDate() {
  const now = new Date();
  if (now.getHours() < 6) {
    return dateKey(new Date(now - 24 * 60 * 60 * 1000));
  }
  return dateKey(now);
}

function dateLabel(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('ko-KR', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'short',
  });
}

function getOrCreateSession(date) {
  if (!sessions[date]) {
    sessions[date] = { date, label: dateLabel(date), themeIdx: 0, cards: {} };
    saveData();
  }
  return sessions[date];
}

function getSessionList() {
  const active = activeSessionDate();
  return Object.keys(sessions).sort().reverse().map(date => ({
    date,
    label: sessions[date].label,
    cardCount: Object.keys(sessions[date].cards).length,
    isActive: date === active,
  }));
}

function nowTime() {
  return new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
}

// ── 오전 6시 자동 종료 ─────────────────────────
function scheduleSessionEnd() {
  const now = new Date();
  const next6AM = new Date(now);
  next6AM.setHours(6, 0, 0, 0);
  if (now.getHours() >= 6) next6AM.setDate(next6AM.getDate() + 1);

  const delay = next6AM.getTime() - now.getTime();
  console.log(`🌅 다음 세션 종료 예약: ${next6AM.toLocaleString('ko-KR')} (${Math.round(delay/60000)}분 후)`);

  setTimeout(() => {
    const newDate = activeSessionDate(); // 이제 6시 이후이므로 오늘 날짜
    getOrCreateSession(newDate);
    io.emit('session_ended', {
      newDate,
      sessions: getSessionList(),
    });
    scheduleSessionEnd(); // 다음 날 재예약
  }, delay);
}

scheduleSessionEnd();

// ── Socket ───────────────────────────────────
io.on('connection', (socket) => {
  const active = activeSessionDate();
  const session = getOrCreateSession(active);

  socket.emit('init', {
    activeDate: active,
    cards: Object.values(session.cards).sort((a, b) => a.ts - b.ts),
    sessions: getSessionList(),
  });

  socket.on('view_session', (date) => {
    const s = sessions[date];
    if (!s) return;
    socket.emit('session_data', {
      date,
      label: s.label,
      cards: Object.values(s.cards).sort((a, b) => a.ts - b.ts),
      isActive: date === activeSessionDate(),
    });
  });

  socket.on('rejoin', ({ cardId }) => {
    const s = getOrCreateSession(activeSessionDate());
    if (cardId && s.cards[cardId]) {
      socket.emit('my_card_id', cardId);
    } else {
      socket.emit('card_not_found');
    }
  });

  socket.on('create_card', (data) => {
    const { name: rawName, emoji: rawEmoji } = data;
    if (!rawName || !rawName.trim()) return;
    let name = rawName.trim().slice(0, 20);
    const active = activeSessionDate();
    const session = getOrCreateSession(active);
    if (Object.values(session.cards).some(c => c.name === name)) {
      socket.emit('name_taken');
      return;
    }
    const emoji = (typeof rawEmoji === 'string' && [...rawEmoji].length === 1) ? rawEmoji : '😎';
    const card = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name, emoji, checkin: null, checkout: null, todos: [], comments: [],
      theme: THEMES[session.themeIdx++ % THEMES.length],
      ts: Date.now(),
    };
    session.cards[card.id] = card;
    saveData();
    socket.emit('my_card_id', card.id);
    io.emit('card_created', { card, date: active });
    io.emit('sessions_updated', getSessionList());
  });

  function writeCard(cardId, mutate) {
    const active = activeSessionDate();
    const session = getOrCreateSession(active);
    const card = session.cards[cardId];
    if (!card) return;
    mutate(card);
    saveData();
    io.emit('card_updated', { card, date: active });
  }

  socket.on('change_emoji', ({ cardId, emoji }) => {
    if (typeof emoji === 'string' && [...emoji].length === 1)
      writeCard(cardId, c => { c.emoji = emoji; });
  });

  socket.on('checkin',     ({ cardId }) => writeCard(cardId, c => { if (!c.checkin) c.checkin = nowTime(); }));
  socket.on('checkout',    ({ cardId }) => writeCard(cardId, c => { if (c.checkin && !c.checkout) c.checkout = nowTime(); }));
  socket.on('toggle_todo', ({ cardId, todoId }) => writeCard(cardId, c => { const t = c.todos.find(t => t.id === todoId); if (t) t.done = !t.done; }));
  socket.on('delete_todo', ({ cardId, todoId }) => writeCard(cardId, c => { c.todos = c.todos.filter(t => t.id !== todoId); }));

  socket.on('add_todo', ({ cardId, text }) => {
    if (!text || !text.trim()) return;
    writeCard(cardId, c => {
      c.todos.push({ id: Date.now().toString(), text: text.trim().slice(0, 100), done: false });
    });
  });

  socket.on('add_comment', ({ cardId, author, text }) => {
    if (!author || !text || !text.trim()) return;
    writeCard(cardId, c => {
      c.comments.push({
        id: Date.now().toString(),
        author: author.trim().slice(0, 20),
        text: text.trim().slice(0, 200),
        time: nowTime(),
      });
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🌙 Admin Night: http://localhost:${PORT}`);
});
