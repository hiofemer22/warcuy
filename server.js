'use strict';
const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

// ─── Constants ────────────────────────────────────────────────────────────────
const TICK_MS     = 1000 / 30;
const MAP_COLS    = 40;
const MAP_ROWS    = 28;
const TILE        = 64;
const TANK_R      = 22;
const BULLET_SPD  = 16;
const TANK_SPD    = 5.5;
const ROT_SPD     = 4.0;    // deg/tick (faster rotation)
const FIRE_CD     = 250;    // ms between shots
const IMMUNITY_MS = 3000;
const MAX_PLAYERS = 9;

// ─── Static map ───────────────────────────────────────────────────────────────
const ROCK_CELLS = new Set();
(function buildRocks() {
  for (let c = 0; c < MAP_COLS; c++) { ROCK_CELLS.add(`${c},0`); ROCK_CELLS.add(`${c},${MAP_ROWS-1}`); }
  for (let r = 0; r < MAP_ROWS; r++) { ROCK_CELLS.add(`0,${r}`); ROCK_CELLS.add(`${MAP_COLS-1},${r}`); }
  for (const k of [
    // Corner clusters
    '5,5','6,5','5,6','6,6',
    '33,5','34,5','33,6','34,6',
    '5,21','6,21','5,22','6,22',
    '33,21','34,21','33,22','34,22',
    // Side pillars
    '3,13','3,14','36,13','36,14',
    // Top/bottom center walls
    '17,5','18,5','19,5','20,5','21,5','22,5',
    '17,22','18,22','19,22','20,22','21,22','22,22',
    // Center block
    '19,12','20,12','19,13','20,13',
    // Mid clusters (4 positions)
    '10,10','11,10','10,11','11,11',
    '28,10','29,10','28,11','29,11',
    '10,16','11,16','10,17','11,17',
    '28,16','29,16','28,17','29,17',
    // Additional walls for variety
    '14,7','15,7','24,7','25,7',
    '14,20','15,20','24,20','25,20',
  ]) ROCK_CELLS.add(k);
})();

const DIRT_CELLS = new Set([
  '8,4','32,4','8,23','32,23',
  '16,3','23,3','16,24','23,24',
  '7,14','32,14','19,9','19,18',
  '12,7','27,7','12,20','27,20',
  '4,8','35,8','4,19','35,19',
]);

function buildTiles() {
  const t = [];
  for (let r = 0; r < MAP_ROWS; r++) {
    t[r] = [];
    for (let c = 0; c < MAP_COLS; c++) {
      const k = `${c},${r}`;
      if (ROCK_CELLS.has(k))      t[r][c] = 'rock';
      else if (DIRT_CELLS.has(k)) t[r][c] = 'pasto03';
      else                        t[r][c] = (r+c)%2===0 ? 'pasto01' : 'pasto02';
    }
  }
  return t;
}
const TILES = buildTiles();

const SPAWNS = [
  [4,4],[35,4],[4,23],[35,23],
  [19,3],[19,24],
  [4,13],[35,13],
  [19,9],
];

function randomSpawn(tanks) {
  const used = new Set(tanks.filter(t=>t.alive).map(t=>`${Math.floor(t.x/TILE)},${Math.floor(t.y/TILE)}`));
  const free = SPAWNS.filter(([c,r]) => !ROCK_CELLS.has(`${c},${r}`) && !used.has(`${c},${r}`));
  const pick = free.length ? free[Math.floor(Math.random()*free.length)] : SPAWNS[Math.floor(Math.random()*SPAWNS.length)];
  return { x: pick[0]*TILE + TILE/2, y: pick[1]*TILE + TILE/2 };
}

// ─── HTTP static server ───────────────────────────────────────────────────────
const MIME = {
  '.html':'text/html','.js':'application/javascript','.css':'text/css',
  '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg',
  '.mp3':'audio/mpeg','.MP3':'audio/mpeg',
};

// Solo se sirve la carpeta public/: así server.js, package.json o cualquier llave
// que esté junto al servidor nunca quedan expuestos.
const PUBLIC_DIR = path.join(__dirname, 'public');

const server = http.createServer((req, res) => {
  let p = req.url.split('?')[0]; if (p === '/') p = '/index.html';
  let fp;
  try { fp = path.resolve(PUBLIC_DIR, '.' + decodeURIComponent(p)); }
  catch { res.writeHead(400); res.end(); return; }
  // Bloquea rutas que intentan salir de public/ (p. ej. /..%2fserver.js)
  if (!fp.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(404); res.end(); return; }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ─── State ────────────────────────────────────────────────────────────────────
const rooms   = new Map();
const clients = new Map();

function mkCode() { let c; do { c=Math.random().toString(36).slice(2,8).toUpperCase(); } while(rooms.has(c)); return c; }

// ─── WebSocket ────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

wss.on('connection', ws => {
  const id = Math.random().toString(36).slice(2,10);
  clients.set(ws, { id, username:'Jugador', roomCode:null });
  send(ws, { type:'welcome', playerId:id });
  ws.on('message', raw => { try { handle(ws, JSON.parse(raw)); } catch(_){} });
  ws.on('close', () => disconnect(ws));
});

const send  = (ws, m) => ws.readyState===ws.OPEN && ws.send(JSON.stringify(m));
const bcast = (room, m) => { const s=JSON.stringify(m); room.players.forEach(p=>p.ws.readyState===p.ws.OPEN&&p.ws.send(s)); };
const plist = room => room.players.map((p,i) => ({ id:p.id, username:p.username, slot:i }));

// ─── Messages ─────────────────────────────────────────────────────────────────
function handle(ws, msg) {
  const cl = clients.get(ws);
  switch (msg.type) {

    case 'setUsername':
      cl.username = String(msg.username||'').slice(0,20).trim()||'Jugador';
      break;

    case 'createRoom': {
      const code = mkCode();
      const room = { code, host:cl.id, players:[{...cl,ws}], state:'lobby', gs:null, timer:null };
      rooms.set(code, room); cl.roomCode = code;
      send(ws, { type:'roomCreated', code, players:plist(room), host:cl.id });
      break;
    }

    case 'joinRoom': {
      const code = String(msg.code||'').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) { send(ws, { type:'error', msg:'Sala no encontrada' }); return; }
      if (room.state==='lobby' && room.players.length>=MAX_PLAYERS) { send(ws, { type:'error', msg:'Sala llena (máx 9)' }); return; }
      cl.roomCode = code;
      room.players.push({...cl,ws});
      if (room.state==='playing') {
        send(ws, { type:'joinedRoom', code, players:plist(room), host:room.host, state:'playing', tiles:TILES });
        return;
      }
      bcast(room, { type:'lobbyUpdate', players:plist(room), host:room.host });
      send(ws, { type:'joinedRoom', code, players:plist(room), host:room.host, state:room.state });
      break;
    }

    case 'startGame': {
      const room = rooms.get(cl.roomCode);
      if (!room || room.host!==cl.id || room.players.length<2) return;
      doCountdown(room);
      break;
    }

    case 'fire': {
      const room = rooms.get(cl.roomCode);
      if (!room || room.state!=='playing') break;
      const tank = room.gs.tanks.find(t=>t.pid===cl.id);
      if (!tank || !tank.alive) break;
      const fired = fireBullet(tank, room.gs);
      if (fired) bcast(room, { type:'shot' }); // todos los jugadores oyen el disparo
      if (!tank.hasInteracted) { tank.hasInteracted=true; tank.rotDir=1; }
      else tank.rotDir *= -1;
      tank.rotating = false; // pausa inmediata; el ángulo queda fijo hasta soltar
      break;
    }

    case 'holdStart': {
      const room = rooms.get(cl.roomCode);
      if (!room || room.state!=='playing') break;
      const tank = room.gs.tanks.find(t=>t.pid===cl.id);
      if (tank && tank.alive) { tank.moving=true; tank.rotating=false; }
      break;
    }

    case 'holdEnd': {
      const room = rooms.get(cl.roomCode);
      if (!room || room.state!=='playing') break;
      const tank = room.gs.tanks.find(t=>t.pid===cl.id);
      if (tank) { tank.moving=false; if (tank.hasInteracted) tank.rotating=true; }
      break;
    }
  }
}

// ─── Game logic ───────────────────────────────────────────────────────────────
function fireBullet(tank, gs) {
  const now = Date.now();
  if (now - tank.lastFire < FIRE_CD) return false;
  tank.lastFire = now;
  const rad = tank.angle * Math.PI / 180;
  gs.bullets.push({ x:tank.x+Math.cos(rad)*TANK_R, y:tank.y+Math.sin(rad)*TANK_R,
                    dx:Math.cos(rad)*BULLET_SPD, dy:Math.sin(rad)*BULLET_SPD,
                    owner:tank.pid, alive:true });
  return true;
}

function wallHit(x, y) {
  const r = TANK_R - 3;
  for (const [dx,dy] of [[-r,-r],[r,-r],[-r,r],[r,r]])
    if (ROCK_CELLS.has(`${Math.floor((x+dx)/TILE)},${Math.floor((y+dy)/TILE)}`)) return true;
  return false;
}

function doCountdown(room) {
  room.state = 'countdown'; let n = 3;
  bcast(room, { type:'countdown', n });
  const iv = setInterval(() => { n--; n>0 ? bcast(room,{type:'countdown',n}) : (clearInterval(iv), startGame(room)); }, 1000);
}

function startGame(room) {
  room.state = 'playing';
  const now  = Date.now();
  const tanks = room.players.map((p,i) => {
    const [sc,sr] = SPAWNS[i % SPAWNS.length];
    return { pid:p.id, username:p.username, slot:i,
             x:sc*TILE+TILE/2, y:sr*TILE+TILE/2,
             angle:90, rotDir:1, rotating:false, moving:false, hasInteracted:false,
             lives:3, alive:true, lastFire:0, deathOrder:0,
             immuneUntil: now + IMMUNITY_MS };
  });
  room.gs = { tanks, bullets:[], deathCtr:0 };
  bcast(room, { type:'gameStart', tiles:TILES, tanks:pub(tanks) });
  room.timer = setInterval(() => tick(room), TICK_MS);
}

function tick(room) {
  const gs = room.gs;
  const events = [];

  // Update tanks
  for (const t of gs.tanks) {
    if (!t.alive) continue;
    if (t.rotating) t.angle = ((t.angle + ROT_SPD*t.rotDir)%360+360)%360;
    if (t.moving) {
      const rad = t.angle * Math.PI / 180;
      const nx = t.x + Math.cos(rad)*TANK_SPD;
      const ny = t.y + Math.sin(rad)*TANK_SPD;
      if (!wallHit(nx, ny)) { t.x=nx; t.y=ny; }
    }
  }

  // Update bullets
  const now = Date.now();
  for (const b of gs.bullets) {
    if (!b.alive) continue;
    b.x += b.dx; b.y += b.dy;
    if (b.x<0||b.x>MAP_COLS*TILE||b.y<0||b.y>MAP_ROWS*TILE) { b.alive=false; continue; }
    if (ROCK_CELLS.has(`${Math.floor(b.x/TILE)},${Math.floor(b.y/TILE)}`)) { b.alive=false; continue; }
    for (const t of gs.tanks) {
      if (!t.alive || t.pid===b.owner) continue;
      if (t.immuneUntil && now < t.immuneUntil) continue;
      if (Math.hypot(b.x-t.x, b.y-t.y) < TANK_R+8) {
        b.alive = false;
        const ox = t.x, oy = t.y;
        t.lives--;
        if (t.lives <= 0) {
          t.alive = false; t.deathOrder = ++gs.deathCtr;
          events.push({ type:'impact', pid:t.pid, slot:t.slot, lives:0, x:ox, y:oy, fatal:true });
        } else {
          // Instant respawn at random position
          const pos = randomSpawn(gs.tanks);
          t.x = pos.x; t.y = pos.y;
          t.rotating = false; t.moving = false; t.hasInteracted = false;
          t.immuneUntil = now + IMMUNITY_MS;
          events.push({ type:'impact', pid:t.pid, slot:t.slot, lives:t.lives, x:ox, y:oy, fatal:false });
        }
        break;
      }
    }
  }
  gs.bullets = gs.bullets.filter(b=>b.alive);

  // Check win
  const alive = gs.tanks.filter(t=>t.alive);
  if (alive.length <= 1) {
    const ranking = [...gs.tanks]
      .sort((a,b) => a.alive!==b.alive ? (a.alive?-1:1) : b.deathOrder-a.deathOrder)
      .map((t,i) => ({ rank:i+1, pid:t.pid, username:t.username, slot:t.slot, lives:t.lives }));
    bcast(room, { type:'gameOver', ranking });
    clearInterval(room.timer); room.state='finished';
    return;
  }

  bcast(room, { type:'gs', tanks:pub(gs.tanks), bullets:gs.bullets.map(b=>({x:b.x,y:b.y})), events });
}

const pub = tanks => tanks.map(t => ({
  pid:t.pid, username:t.username, slot:t.slot,
  x:t.x, y:t.y, angle:t.angle, lives:t.lives, alive:t.alive,
  immune: !!(t.immuneUntil && Date.now() < t.immuneUntil),
}));

// ─── Disconnect ───────────────────────────────────────────────────────────────
function disconnect(ws) {
  const cl = clients.get(ws);
  if (!cl) return;
  if (cl.roomCode) {
    const room = rooms.get(cl.roomCode);
    if (room) {
      room.players = room.players.filter(p=>p.id!==cl.id);
      if (!room.players.length) { if(room.timer) clearInterval(room.timer); rooms.delete(room.code); }
      else {
        if (room.host===cl.id) room.host = room.players[0].id;
        if (room.state==='playing'&&room.gs) {
          const t = room.gs.tanks.find(t=>t.pid===cl.id);
          if (t) { t.alive=false; t.deathOrder=++room.gs.deathCtr; }
        }
        bcast(room, { type:'lobbyUpdate', players:plist(room), host:room.host });
      }
    }
  }
  clients.delete(ws);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Warcuy en http://localhost:${PORT}`));
