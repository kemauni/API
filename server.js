// 🎮 Freestyle Mobile Game API
// Run: npm install && npm start
// In-memory storage (swap the Maps for a real DB like Postgres/Redis when you go live)

const express = require("express");
const crypto = require("crypto");

const app = express();
app.use(express.json());

// ---------- "Database" ----------
const players = new Map();   // id -> player
const tokens = new Map();    // token -> playerId
const usernames = new Map(); // username(lowercase) -> playerId
const queue = [];            // matchmaking queue [{playerId, joinedAt}]
const matches = new Map();   // matchId -> match

// ---------- Game config ----------
const SHOP = {
  sword_wood:  { name: "Wooden Sword", price: 100 },
  sword_iron:  { name: "Iron Sword",   price: 500 },
  shield_basic:{ name: "Basic Shield", price: 300 },
  potion_hp:   { name: "Health Potion",price: 50, stackable: true },
  skin_neon:   { name: "Neon Skin",    price: 1500 },
};
const DAILY_REWARDS = [50, 75, 100, 150, 200, 300, 500]; // 7-day streak
const XP_PER_LEVEL = 1000;
const DAY = 24 * 60 * 60 * 1000;

// ---------- Helpers ----------
const uid = (p = "") => p + crypto.randomBytes(6).toString("hex");
const hash = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString("hex");
const levelFor = (xp) => Math.floor(xp / XP_PER_LEVEL) + 1;

const publicProfile = (p) => ({
  id: p.id, username: p.username, level: levelFor(p.xp), xp: p.xp,
  highScore: p.highScore, wins: p.wins, losses: p.losses,
});

const privateProfile = (p) => ({
  ...publicProfile(p), coins: p.coins, gems: p.gems,
  inventory: p.inventory, streak: p.streak, createdAt: p.createdAt,
});

// ---------- Auth middleware ----------
function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  const pid = token && tokens.get(token);
  const player = pid && players.get(pid);
  if (!player) return res.status(401).json({ error: "Unauthorized" });
  req.player = player;
  next();
}

// ---------- Basic per-IP rate limit (60 req/min) ----------
const hits = new Map();
app.use((req, res, next) => {
  const now = Date.now();
  const rec = hits.get(req.ip) || { count: 0, reset: now + 60000 };
  if (now > rec.reset) { rec.count = 0; rec.reset = now + 60000; }
  rec.count++;
  hits.set(req.ip, rec);
  if (rec.count > 60) return res.status(429).json({ error: "Slow down, champ 🐢" });
  next();
});

// ---------- Health ----------
app.get("/", (_, res) => res.json({ game: "Freestyle Quest", status: "online", players: players.size }));

// ---------- Auth routes ----------
app.post("/auth/register", (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "username and password required" });
  if (!/^[a-zA-Z0-9_]{3,16}$/.test(username)) return res.status(400).json({ error: "username: 3-16 chars, letters/numbers/_" });
  if (password.length < 6) return res.status(400).json({ error: "password must be 6+ chars" });
  if (usernames.has(username.toLowerCase())) return res.status(409).json({ error: "username taken" });

  const salt = crypto.randomBytes(8).toString("hex");
  const player = {
    id: uid("p_"), username, salt, passHash: hash(password, salt),
    coins: 200, gems: 5, xp: 0, highScore: 0, wins: 0, losses: 0,
    inventory: {}, streak: 0, lastDaily: 0, createdAt: Date.now(),
  };
  players.set(player.id, player);
  usernames.set(username.toLowerCase(), player.id);

  const token = uid("t_");
  tokens.set(token, player.id);
  res.status(201).json({ token, player: privateProfile(player) });
});

app.post("/auth/login", (req, res) => {
  const { username, password } = req.body || {};
  const pid = usernames.get(String(username || "").toLowerCase());
  const player = pid && players.get(pid);
  if (!player || hash(password || "", player.salt) !== player.passHash)
    return res.status(401).json({ error: "invalid credentials" });
  const token = uid("t_");
  tokens.set(token, player.id);
  res.json({ token, player: privateProfile(player) });
});

app.post("/auth/logout", auth, (req, res) => {
  tokens.delete(req.headers.authorization.slice(7));
  res.json({ ok: true });
});

// ---------- Profile ----------
app.get("/me", auth, (req, res) => res.json(privateProfile(req.player)));

app.get("/players/:id", (req, res) => {
  const p = players.get(req.params.id);
  if (!p) return res.status(404).json({ error: "not found" });
  res.json(publicProfile(p));
});

// ---------- Scores & leaderboard ----------
app.post("/scores", auth, (req, res) => {
  const { score, durationSec } = req.body || {};
  if (!Number.isInteger(score) || score < 0 || score > 1_000_000)
    return res.status(400).json({ error: "invalid score" });
  // naive anti-cheat: cap points-per-second
  if (durationSec && score / Math.max(durationSec, 1) > 500)
    return res.status(422).json({ error: "score rejected (suspicious)" });

  const p = req.player;
  const newBest = score > p.highScore;
  if (newBest) p.highScore = score;

  const xpGain = Math.floor(score / 10);
  const before = levelFor(p.xp);
  p.xp += xpGain;
  const coinGain = Math.floor(score / 50);
  p.coins += coinGain;

  res.json({ newBest, xpGain, coinGain, leveledUp: levelFor(p.xp) > before, player: privateProfile(p) });
});

app.get("/leaderboard", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 10, 100);
  const top = [...players.values()]
    .sort((a, b) => b.highScore - a.highScore)
    .slice(0, limit)
    .map((p, i) => ({ rank: i + 1, username: p.username, highScore: p.highScore, level: levelFor(p.xp) }));
  res.json(top);
});

// ---------- Daily reward ----------
app.post("/rewards/daily", auth, (req, res) => {
  const p = req.player;
  const since = Date.now() - p.lastDaily;
  if (since < DAY) {
    return res.status(429).json({ error: "already claimed", nextClaimInMs: DAY - since });
  }
  p.streak = since < 2 * DAY ? (p.streak % 7) + 1 : 1; // miss a day = reset
  const coins = DAILY_REWARDS[p.streak - 1];
  p.coins += coins;
  if (p.streak === 7) p.gems += 5;
  p.lastDaily = Date.now();
  res.json({ streak: p.streak, coins, bonusGems: p.streak === 7 ? 5 : 0, player: privateProfile(p) });
});

// ---------- Shop & inventory ----------
app.get("/shop", (_, res) => res.json(SHOP));

app.post("/shop/buy", auth, (req, res) => {
  const { itemId, qty = 1 } = req.body || {};
  const item = SHOP[itemId];
  if (!item) return res.status(404).json({ error: "no such item" });
  if (!Number.isInteger(qty) || qty < 1 || (!item.stackable && qty > 1))
    return res.status(400).json({ error: "bad quantity" });

  const p = req.player;
  if (!item.stackable && p.inventory[itemId]) return res.status(409).json({ error: "already owned" });
  const cost = item.price * qty;
  if (p.coins < cost) return res.status(402).json({ error: "not enough coins", need: cost, have: p.coins });

  p.coins -= cost;
  p.inventory[itemId] = (p.inventory[itemId] || 0) + qty;
  res.json({ bought: item.name, qty, player: privateProfile(p) });
});

app.get("/inventory", auth, (req, res) => res.json(req.player.inventory));

// ---------- Matchmaking (1v1) ----------
app.post("/match/join", auth, (req, res) => {
  const p = req.player;
  if (queue.some((q) => q.playerId === p.id)) return res.json({ status: "queued" });

  // already in an active match?
  for (const m of matches.values())
    if (m.status === "active" && m.players.includes(p.id)) return res.json({ status: "matched", match: m });

  // pair with closest-level waiting player
  const myLvl = levelFor(p.xp);
  queue.sort((a, b) => Math.abs(levelFor(players.get(a.playerId).xp) - myLvl) -
                       Math.abs(levelFor(players.get(b.playerId).xp) - myLvl));
  const opp = queue.shift();
  if (!opp) {
    queue.push({ playerId: p.id, joinedAt: Date.now() });
    return res.json({ status: "queued" });
  }
  const match = { id: uid("m_"), players: [opp.playerId, p.id], status: "active", scores: {}, createdAt: Date.now() };
  matches.set(match.id, match);
  res.json({ status: "matched", match });
});

app.get("/match/status", auth, (req, res) => {
  const p = req.player;
  for (const m of matches.values())
    if (m.status === "active" && m.players.includes(p.id)) return res.json({ status: "matched", match: m });
  res.json({ status: queue.some((q) => q.playerId === p.id) ? "queued" : "idle" });
});

app.post("/match/leave", auth, (req, res) => {
  const i = queue.findIndex((q) => q.playerId === req.player.id);
  if (i >= 0) queue.splice(i, 1);
  res.json({ ok: true });
});

app.post("/match/:id/submit", auth, (req, res) => {
  const m = matches.get(req.params.id);
  const p = req.player;
  const { score } = req.body || {};
  if (!m || !m.players.includes(p.id)) return res.status(404).json({ error: "match not found" });
  if (m.status !== "active") return res.status(409).json({ error: "match finished" });
  if (!Number.isInteger(score) || score < 0) return res.status(400).json({ error: "invalid score" });

  m.scores[p.id] = score;
  if (Object.keys(m.scores).length < 2) return res.json({ status: "waiting_for_opponent" });

  const [a, b] = m.players;
  m.status = "finished";
  m.winner = m.scores[a] === m.scores[b] ? null : m.scores[a] > m.scores[b] ? a : b;
  for (const id of m.players) {
    const pl = players.get(id);
    if (m.winner === null) { pl.xp += 50; }
    else if (m.winner === id) { pl.wins++; pl.xp += 150; pl.coins += 100; }
    else { pl.losses++; pl.xp += 40; pl.coins += 20; }
  }
  res.json({ status: "finished", winner: m.winner, scores: m.scores });
});

// ---------- 404 + error handler ----------
app.use((_, res) => res.status(404).json({ error: "route not found" }));
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "server error" });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) app.listen(PORT, () => console.log(`🎮 Game API running on :${PORT}`));
module.exports = app;
