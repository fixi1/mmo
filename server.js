const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { db, hashPassword, verifyPassword } = require('./database');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static('.'));

const players = {};
const LOGIN_RATE_LIMIT = {};
const MOVE_RATE_LIMIT = {};

const MAP_WIDTH = 800;
const MAP_HEIGHT = 600;
const VIEW_DISTANCE = 300;

function distance(p1, p2) {
  return Math.sqrt((p1.x - p2.x) ** 2 + (p1.y - p2.y) ** 2);
}

function getNearbyPlayers(playerId) {
  const me = players[playerId];
  if (!me) return [];
  return Object.values(players).filter(p => p.id !== playerId && distance(me, p) <= VIEW_DISTANCE);
}

function broadcastToNearby(data, playerId) {
  const nearby = getNearbyPlayers(playerId);
  nearby.forEach(p => {
    const client = p.ws;
    if (client && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

function now() {
  return Date.now();
}

app.post('/register', (req, res) => {
  const { username, password } = req.body;
  const ip = req.ip || req.connection.remoteAddress;

  if (!username || !password || username.length < 3 || password.length < 6) {
    return res.status(400).json({ error: 'Invalid username or password' });
  }

  if (LOGIN_RATE_LIMIT[ip] && now() - LOGIN_RATE_LIMIT[ip] < 5000) {
    return res.status(429).json({ error: 'Too many requests' });
  }
  LOGIN_RATE_LIMIT[ip] = now();

  db.get('SELECT id FROM users WHERE username = ?', [username], (err, row) => {
    if (row) return res.status(409).json({ error: 'Username taken' });
    const hashed = hashPassword(password);
    db.run('INSERT INTO users (username, password) VALUES (?, ?)', [username, hashed], function(err) {
      if (err) return res.status(500).json({ error: 'DB error' });
      res.json({ success: true });
    });
  });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const ip = req.ip || req.connection.remoteAddress;

  if (!username || !password) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  if (LOGIN_RATE_LIMIT[ip] && now() - LOGIN_RATE_LIMIT[ip] < 3000) {
    return res.status(429).json({ error: 'Too many requests' });
  }
  LOGIN_RATE_LIMIT[ip] = now();

  db.get('SELECT * FROM users WHERE username = ?', [username], (err, user) => {
    if (!user || !verifyPassword(password, user.password)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    res.json({
      success: true,
      user: { id: user.id, username: user.username, x: user.x, y: user.y, map: user.map, inventory: JSON.parse(user.inventory) }
    });
  });
});

wss.on('connection', (ws, req) => {
  let playerId = null;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      const ip = req.socket.remoteAddress;

      if (msg.type === 'auth') {
        const { token } = msg;
        db.get('SELECT * FROM users WHERE id = ?', [token], (err, user) => {
          if (!user) return ws.close();
          playerId = user.id.toString();
          players[playerId] = {
            id: playerId,
            x: user.x,
            y: user.y,
            map: user.map,
            username: user.username,
            ws: ws
          };
          ws.send(JSON.stringify({ type: 'init', playerId, x: user.x, y: user.y }));
          broadcastToNearby({ type: 'playerJoined', player: players[playerId] }, playerId);
        });
      }

      else if (msg.type === 'move') {
        if (!playerId || !players[playerId]) return;
        if (MOVE_RATE_LIMIT[playerId] && now() - MOVE_RATE_LIMIT[playerId] < 100) return;
        MOVE_RATE_LIMIT[playerId] = now();

        let { x, y } = msg;
        x = Math.max(0, Math.min(MAP_WIDTH - 30, x));
        y = Math.max(0, Math.min(MAP_HEIGHT - 30, y));

        players[playerId].x = x;
        players[playerId].y = y;

        db.run('UPDATE users SET x = ?, y = ? WHERE id = ?', [x, y, playerId]);

        broadcastToNearby({ type: 'move', id: playerId, x, y }, playerId);
      }
    } catch (e) {
      ws.close();
    }
  });

  ws.on('close', () => {
    if (playerId && players[playerId]) {
      broadcastToNearby({ type: 'playerLeft', id: playerId }, playerId);
      delete players[playerId];
    }
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});