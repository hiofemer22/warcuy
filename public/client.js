'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────
const TILE     = 64;
const TANK_SZ  = 60;   // max dimension; aspect ratio is preserved from the image
const MAP_COLS = 40;
const MAP_ROWS = 28;
const ZOOM     = 1.6;
const MEDALS   = ['🥇','🥈','🥉'];
const HOLD_MS  = 200;  // ms before tap becomes hold

// Ajuste de dirección visual del tanque.
// Cambia este valor si el tanque apunta en dirección incorrecta respecto a la bala/movimiento:
//   0   → imagen original apunta a la DERECHA
//   90  → imagen original apunta ARRIBA  (sprites top-down clásicos) ← valor por defecto
//  180  → imagen original apunta a la IZQUIERDA
//  -90  → imagen original apunta ABAJO
const TANK_ANGLE_OFFSET = -90;

// ─── Assets ───────────────────────────────────────────────────────────────────
const IMG = {}, SFX = {};

function loadAssets() {
  const imgs = {
    pasto01:'pasto01.png', pasto02:'pasto02.png', pasto03:'pasto03.png',
    rock:'piedra.png', bullet:'bala.png',
    t0:'tanque01.png', t1:'tanque02.png', t2:'tanque03.png',
    t3:'tanque04.png', t4:'tanque05.png', t5:'tanque06.png',
    t6:'tanque07.png', t7:'tanque08.png', t8:'tanque09.png',
  };
  return new Promise(res => {
    let n = Object.keys(imgs).length;
    for (const [k,src] of Object.entries(imgs)) {
      const el = new Image(); IMG[k] = el;
      el.onload = el.onerror = () => --n===0 && res();
      el.src = src;
    }
    const sfxs = { menu:'musicamenu.mp3', game:'musicapartida.mp3', shoot:'sonidodisparo.MP3', explode:'sonidoexplosion.MP3', tank:'sonidotanque.MP3' };
    for (const [k,src] of Object.entries(sfxs)) {
      const a = new Audio(src); a.preload='auto'; SFX[k]=a;
    }
    SFX.menu.loop = true; SFX.game.loop = true; SFX.tank.loop = true;
  });
}

let currentMusic = null;
function playMusic(key) {
  if (currentMusic === key && !SFX[key].paused) return; // already playing, don't restart
  SFX.menu.pause(); SFX.game.pause();
  SFX[key].currentTime = 0;
  SFX[key].play().catch(()=>{});
  currentMusic = key;
}
function playSFX(key) {
  try {
    const a = new Audio(SFX[key].src);
    a.volume = 0.7;
    a.play().catch(() => {});
  } catch(_) {}
}

// ─── State ────────────────────────────────────────────────────────────────────
let ws, myId, myUsername, mySlot=-1;
let roomCode=null, isHost=false;
let gs=null, mapTiles=null;
let lobbyMode='create';
let isHeld=false, holdTimer=null;
let raf;

// ─── DOM ──────────────────────────────────────────────────────────────────────
const $   = id => document.getElementById(id);
const canvas = $('canvas');
const ctx    = canvas.getContext('2d');
const screens = ['username','menu','lobby','game','gameover'].reduce((o,k)=>(o[k]=$('screen-'+k),o),{});
const bg = $('bg');

// ─── Screen management ────────────────────────────────────────────────────────
function show(name) {
  Object.values(screens).forEach(s=>s.classList.remove('active'));
  screens[name].classList.add('active');
  bg.className = (['game','gameover'].includes(name)) ? 'hidden'
               : (['lobby'].includes(name))           ? 'dim' : '';
}

// ─── WebSocket ────────────────────────────────────────────────────────────────
function connect() {
  const proto = location.protocol==='https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}`);
  ws.onmessage = e => onMsg(JSON.parse(e.data));
  ws.onclose   = () => setTimeout(connect, 2000);
  ws.onerror   = () => ws.close();
}
function emit(msg) { ws && ws.readyState===1 && ws.send(JSON.stringify(msg)); }

// ─── Messages ─────────────────────────────────────────────────────────────────
function onMsg(msg) {
  switch (msg.type) {

    case 'welcome': myId = msg.playerId; break;

    case 'roomCreated':
      roomCode=msg.code; isHost=true; lobbyMode='create';
      showLobby(msg.players, msg.code);
      break;

    case 'joinedRoom':
      roomCode=msg.code; isHost=(msg.host===myId);
      if (msg.state==='playing') {
        mapTiles=msg.tiles;
        gs={ tanks:msg.tanks||[], bullets:[], explosions:[] };
        mySlot=(gs.tanks.find(t=>t.pid===myId)||{}).slot??-1;
        startRendering(); show('game');
        return;
      }
      lobbyMode='joined';
      showLobby(msg.players, msg.code);
      break;

    case 'lobbyUpdate':
      isHost=(msg.host===myId);
      renderPlayerList(msg.players);
      updateStartBtn(msg.players.length);
      break;

    case 'countdown': showCountdown(msg.n); break;

    case 'gameStart':
      mapTiles=msg.tiles;
      gs={ tanks:msg.tanks, bullets:[], explosions:[] };
      mySlot=(msg.tanks.find(t=>t.pid===myId)||{}).slot??-1;
      hideCountdown();
      setupCanvas();
      show('game');
      startRendering();
      playMusic('game');
      break;

    case 'gs':
      if (!gs) return;
      gs.tanks   = msg.tanks;
      gs.bullets = msg.bullets;
      for (const ev of (msg.events||[])) {
        if (ev.type==='impact') {
          playSFX('explode');
          addExplosion(ev.x, ev.y);
        }
      }
      break;

    case 'gameOver':
      stopRendering();
      showGameOver(msg.ranking);
      break;

    case 'shot':
      playSFX('shoot');
      break;

    case 'error': toast(msg.msg); break;
  }
}

// ─── Countdown ────────────────────────────────────────────────────────────────
let cdTimer=null;
function showCountdown(n) {
  const ol=$('countdown-overlay'), nm=$('countdown-num');
  ol.classList.add('visible');
  nm.textContent = n;
  nm.style.animation='none'; void nm.offsetWidth; nm.style.animation='cdpop .45s ease-out';
}
function hideCountdown() {
  const ol=$('countdown-overlay'), nm=$('countdown-num');
  nm.textContent='¡YA!';
  nm.style.animation='none'; void nm.offsetWidth; nm.style.animation='cdpop .45s ease-out';
  clearTimeout(cdTimer);
  cdTimer = setTimeout(()=>ol.classList.remove('visible'), 700);
}

// ─── Lobby UI ─────────────────────────────────────────────────────────────────
function showLobby(players, code) {
  show('lobby');
  $('lobby-title').textContent = isHost ? 'Tu sala' : 'Sala de batalla';
  $('room-code-display').textContent = code||'------';
  $('section-code').style.display = (lobbyMode!=='joining') ? 'block' : 'none';
  $('section-join').style.display = (lobbyMode==='joining') ? 'flex' : 'none';
  $('btn-start').style.display    = isHost ? 'block' : 'none';
  renderPlayerList(players);
  updateStartBtn(players.length);
}

function renderPlayerList(players) {
  const list=$('player-list'); list.innerHTML='';
  players.forEach(p=>{
    const div=document.createElement('div'); div.className='player-item';
    const img=document.createElement('img'); img.src=`tanque0${p.slot+1}.png`; img.alt='';
    const span=document.createElement('span'); span.className='pname'; span.textContent=p.username||'Jugador';
    div.appendChild(img); div.appendChild(span);
    if (p.id===myId) { const y=document.createElement('span'); y.className='you'; y.textContent='(Tú)'; div.appendChild(y); }
    list.appendChild(div);
  });
}

function updateStartBtn(count) {
  const btn=$('btn-start');
  btn.disabled = count<2 || !isHost;
  btn.textContent = count<2
    ? `Esperando jugadores... (${count}/2 mín.)`
    : `⚔ ¡Iniciar Juego! (${count} jugadores)`;
}

// ─── Canvas / Camera ──────────────────────────────────────────────────────────
function setupCanvas() {
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
  canvas.style.width  = '100%';
  canvas.style.height = '100%';
  canvas.style.left   = '0';
  canvas.style.top    = '0';
}
window.addEventListener('resize', ()=>{ if(screens.game.classList.contains('active')) setupCanvas(); });

function getCamera() {
  const myTank = gs && gs.tanks.find(t=>t.pid===myId&&t.alive);
  const worldW = MAP_COLS*TILE, worldH = MAP_ROWS*TILE;
  const viewW = canvas.width/ZOOM, viewH = canvas.height/ZOOM;
  let cx = myTank ? myTank.x - viewW/2 : worldW/2 - viewW/2;
  let cy = myTank ? myTank.y - viewH/2 : worldH/2 - viewH/2;
  return {
    x: Math.max(0, Math.min(cx, worldW-viewW)),
    y: Math.max(0, Math.min(cy, worldH-viewH)),
  };
}

// ─── Explosions ───────────────────────────────────────────────────────────────
function addExplosion(x, y) {
  gs.explosions = gs.explosions||[];
  gs.explosions.push({ x, y, t:0, max:45 });
}

// ─── Render ───────────────────────────────────────────────────────────────────
function startRendering() { stopRendering(); loop(); }
function stopRendering()  { if(raf) { cancelAnimationFrame(raf); raf=null; } }
function loop() { raf=requestAnimationFrame(loop); render(); }

function render() {
  ctx.clearRect(0,0,canvas.width,canvas.height);
  if (!gs||!mapTiles) return;

  const cam = getCamera();
  ctx.save();
  ctx.scale(ZOOM, ZOOM);
  ctx.translate(-cam.x, -cam.y);

  // Visible tile range
  const sc = Math.max(0, Math.floor(cam.x/TILE));
  const ec = Math.min(MAP_COLS, Math.ceil((cam.x+canvas.width/ZOOM)/TILE)+1);
  const sr = Math.max(0, Math.floor(cam.y/TILE));
  const er = Math.min(MAP_ROWS, Math.ceil((cam.y+canvas.height/ZOOM)/TILE)+1);

  // Pass 1: grass base everywhere
  for (let r=sr;r<er;r++) for (let c=sc;c<ec;c++) {
    const base = (r+c)%2===0 ? IMG.pasto01 : IMG.pasto02;
    if (base) ctx.drawImage(base, c*TILE, r*TILE, TILE, TILE);
  }
  // Pass 2: overlays (pasto03 and rock on top of grass)
  for (let r=sr;r<er;r++) for (let c=sc;c<ec;c++) {
    const tile = mapTiles[r]&&mapTiles[r][c];
    if (tile==='pasto03' && IMG.pasto03) ctx.drawImage(IMG.pasto03, c*TILE, r*TILE, TILE, TILE);
    if (tile==='rock'    && IMG.rock)    ctx.drawImage(IMG.rock,    c*TILE, r*TILE, TILE, TILE);
  }

  // Bullets
  for (const b of (gs.bullets||[])) {
    if (IMG.bullet) ctx.drawImage(IMG.bullet, b.x-8, b.y-8, 16, 16);
    else { ctx.fillStyle='#FFD700'; ctx.beginPath(); ctx.arc(b.x,b.y,5,0,Math.PI*2); ctx.fill(); }
  }

  // Tanks
  const now = Date.now();
  for (const t of (gs.tanks||[])) {
    if (!t.alive) continue;
    // Immunity blink: invisible every other 150ms
    if (t.immune && Math.floor(now/150)%2===0) continue;

    const img = IMG['t'+t.slot];
    if (img && img.naturalWidth) {
      // Preserve original aspect ratio: scale so the longest dimension = TANK_SZ
      const scale = TANK_SZ / Math.max(img.naturalWidth, img.naturalHeight);
      const dw = img.naturalWidth  * scale;
      const dh = img.naturalHeight * scale;
      ctx.save();
      ctx.translate(t.x, t.y);
      ctx.rotate((t.angle + TANK_ANGLE_OFFSET) * Math.PI / 180);
      ctx.drawImage(img, -dw/2, -dh/2, dw, dh);
      ctx.restore();
    }

    // Name tag
    ctx.save();
    ctx.font = 'bold 13px Arial';
    ctx.textAlign = 'center';
    const isMe = t.pid===myId;
    ctx.fillStyle = isMe ? '#FFD700' : '#fff';
    ctx.strokeStyle = 'rgba(0,0,0,.85)'; ctx.lineWidth=3;
    const nameY = t.y - TANK_SZ/2 - 10;
    ctx.strokeText(t.username, t.x, nameY);
    ctx.fillText(t.username, t.x, nameY);
    ctx.restore();

    // Life pips
    const pip = 6, gap = 14;
    const startX = t.x - ((t.lives-1)*gap)/2;
    for (let i=0;i<t.lives;i++) {
      ctx.fillStyle='#e00'; ctx.strokeStyle='#600'; ctx.lineWidth=1;
      ctx.beginPath(); ctx.arc(startX+i*gap, t.y+TANK_SZ/2+10, pip, 0, Math.PI*2);
      ctx.fill(); ctx.stroke();
    }
  }

  // Explosions
  const exps = gs.explosions||[];
  for (let i=exps.length-1;i>=0;i--) {
    const ex=exps[i]; ex.t++;
    const p=ex.t/ex.max;
    ctx.save(); ctx.globalAlpha=(1-p)*.95;
    const grd=ctx.createRadialGradient(ex.x,ex.y,0, ex.x,ex.y,p*90);
    grd.addColorStop(0,'#fff'); grd.addColorStop(.25,'#FFF000'); grd.addColorStop(.6,'#FF6600'); grd.addColorStop(1,'rgba(150,30,0,0)');
    ctx.fillStyle=grd;
    ctx.beginPath(); ctx.arc(ex.x,ex.y,p*90,0,Math.PI*2); ctx.fill();
    ctx.restore();
    if (ex.t>=ex.max) exps.splice(i,1);
  }

  ctx.restore();
  renderHUD();
  renderMinimap(cam);
}

// ─── Minimap ──────────────────────────────────────────────────────────────────
function renderMinimap(cam) {
  if (!gs || !mapTiles) return;

  const MM   = 150;  // tamaño del minimapa en píxeles de pantalla
  const PAD  = 14;
  const mX   = PAD;
  const mY   = canvas.height - MM - PAD;
  const scW  = MM / (MAP_COLS * TILE);
  const scH  = MM / (MAP_ROWS * TILE);

  ctx.save();

  // Fondo
  ctx.fillStyle   = 'rgba(0,0,0,0.70)';
  ctx.strokeStyle = 'rgba(200,162,0,0.75)';
  ctx.lineWidth   = 1.5;
  ctx.fillRect(mX - 4, mY - 4, MM + 8, MM + 8);
  ctx.strokeRect(mX - 4, mY - 4, MM + 8, MM + 8);

  // Tiles: pasto base + piedras
  for (let r = 0; r < MAP_ROWS; r++) {
    for (let c = 0; c < MAP_COLS; c++) {
      const tile = mapTiles[r] && mapTiles[r][c];
      const tx = mX + c * scW;
      const ty = mY + r * scH;
      const tw = scW + 0.6;
      const th = scH + 0.6;
      if (tile === 'rock') {
        ctx.fillStyle = 'rgba(100,80,40,0.95)';
        ctx.fillRect(tx, ty, tw, th);
      } else if (tile === 'pasto03') {
        ctx.fillStyle = 'rgba(60,80,30,0.6)';
        ctx.fillRect(tx, ty, tw, th);
      } else {
        ctx.fillStyle = (r+c)%2===0 ? 'rgba(40,80,30,0.5)' : 'rgba(50,90,35,0.5)';
        ctx.fillRect(tx, ty, tw, th);
      }
    }
  }

  // Rectángulo de viewport actual
  const vx = mX + (cam.x / (MAP_COLS * TILE)) * MM;
  const vy = mY + (cam.y / (MAP_ROWS * TILE)) * MM;
  const vw = (canvas.width  / ZOOM) / (MAP_COLS * TILE) * MM;
  const vh = (canvas.height / ZOOM) / (MAP_ROWS * TILE) * MM;
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth   = 1;
  ctx.strokeRect(vx, vy, vw, vh);

  // Tanques
  for (const t of (gs.tanks || [])) {
    if (!t.alive) continue;
    const tx = mX + (t.x / (MAP_COLS * TILE)) * MM;
    const ty = mY + (t.y / (MAP_ROWS * TILE)) * MM;
    const isMe = t.pid === myId;

    ctx.fillStyle   = isMe ? '#FFD700' : '#ff4444';
    ctx.strokeStyle = isMe ? '#000'    : '#800';
    ctx.lineWidth   = 0.8;
    const r = isMe ? 4 : 3;
    ctx.beginPath(); ctx.arc(tx, ty, r, 0, Math.PI*2);
    ctx.fill(); ctx.stroke();

    // Flecha de dirección en el tanque propio
    if (isMe) {
      const rad = (t.angle + TANK_ANGLE_OFFSET) * Math.PI / 180;
      ctx.strokeStyle = '#FFD700';
      ctx.lineWidth   = 1.5;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(tx + Math.cos(rad)*7, ty + Math.sin(rad)*7);
      ctx.stroke();
    }
  }

  ctx.restore();
}

function renderHUD() {
  if (!gs) return;
  const myTank = gs.tanks.find(t=>t.pid===myId);
  const livesEl=$('hud-lives'); livesEl.innerHTML='';
  const lives = myTank ? myTank.lives : 0;
  for (let i=0;i<3;i++) {
    const sp=document.createElement('span');
    sp.className='heart'+(i<lives ? '' : ' empty');
    sp.textContent='❤'; livesEl.appendChild(sp);
  }
  const alive=(gs.tanks||[]).filter(t=>t.alive).length;
  $('hud-alive').textContent=`${alive} en pie`;
}

// ─── Input (tap = fire only, hold = move straight) ────────────────────────────
function setupInput() {
  const onDown = () => {
    if (!screens.game.classList.contains('active')) return;
    if (isHeld) return;
    isHeld = true;
    emit({ type:'fire' });
    holdTimer = setTimeout(() => {
      if (!isHeld) return;
      emit({ type:'holdStart' });
      // Sonido de movimiento en loop
      SFX.tank.currentTime = 0;
      SFX.tank.volume = 0.6;
      SFX.tank.play().catch(() => {});
    }, HOLD_MS);
  };
  const onUp = () => {
    if (!isHeld) return;
    isHeld = false;
    clearTimeout(holdTimer); holdTimer = null;
    emit({ type:'holdEnd' });
    // Detener sonido de movimiento
    SFX.tank.pause();
    SFX.tank.currentTime = 0;
  };
  window.addEventListener('pointerdown', onDown);
  window.addEventListener('pointerup',   onUp);
  window.addEventListener('pointercancel', onUp);
  window.addEventListener('keydown', e => { if(e.code==='Space'||e.code==='Enter'){e.preventDefault();onDown();} });
  window.addEventListener('keyup',   e => { if(e.code==='Space'||e.code==='Enter') onUp(); });
}

// ─── Game Over ────────────────────────────────────────────────────────────────
function showGameOver(ranking) {
  SFX.game.pause();
  SFX.tank.pause(); SFX.tank.currentTime = 0;
  currentMusic = null;
  const list=$('ranking'); list.innerHTML='';
  ranking.forEach(e=>{
    const row=document.createElement('div');
    row.className=`rank-row${e.rank<=3?' r'+e.rank:''}`;
    row.innerHTML=`<span class="rank-medal">${MEDALS[e.rank-1]||'#'+e.rank}</span>
      <img src="tanque0${e.slot+1}.png" alt="">
      <span class="rank-name">${escHtml(e.username)}</span>
      <span class="rank-lives">${'❤'.repeat(e.lives)}${'♡'.repeat(3-e.lives)}</span>`;
    list.appendChild(row);
  });
  show('gameover');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
let toastTimer;
function toast(msg) {
  const el=$('toast'); el.textContent=msg; el.classList.add('visible');
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>el.classList.remove('visible'),3000);
}
const escHtml = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  await loadAssets();
  connect();
  show('username');

  // Intentar autoplay inmediato; si el navegador lo bloquea, esperar primer gesto
  currentMusic = 'menu';
  SFX.menu.play().catch(() => {
    // Bloqueado por política del navegador — suena en el primer evento del usuario
    const unlock = () => {
      SFX.menu.play().catch(() => {});
      document.removeEventListener('keydown',     unlock, true);
      document.removeEventListener('pointerdown', unlock, true);
      document.removeEventListener('touchstart',  unlock, true);
    };
    document.addEventListener('keydown',     unlock, { once: true, capture: true });
    document.addEventListener('pointerdown', unlock, { once: true, capture: true });
    document.addEventListener('touchstart',  unlock, { once: true, capture: true });
  });

  // Username submit
  const submitUsername = () => {
    const name = $('inp-username').value.trim();
    if (!name) { $('inp-username').focus(); return; }
    myUsername = name;
    emit({ type:'setUsername', username:name });
    // playMusic('menu') no necesario: ya está sonando
    show('menu');
  };
  $('btn-username').addEventListener('click', submitUsername);
  $('inp-username').addEventListener('keydown', e => e.key==='Enter' && submitUsername());

  // Menu
  $('btn-create').addEventListener('click', ()=>{ lobbyMode='create'; emit({type:'createRoom'}); });
  $('btn-join').addEventListener('click', ()=>{
    lobbyMode='joining';
    show('lobby');
    $('lobby-title').textContent='Ingresar a sala';
    $('section-code').style.display='none';
    $('section-join').style.display='flex';
    $('btn-start').style.display='none';
    $('player-list').innerHTML='';
    $('inp-join-code').value='';
    setTimeout(()=>$('inp-join-code').focus(), 60);
  });

  // Lobby – join confirm
  const joinConfirm = () => {
    const code=$('inp-join-code').value.trim().toUpperCase();
    if (code.length<4) { toast('Ingresa un código válido'); return; }
    emit({ type:'joinRoom', code });
  };
  $('btn-join-confirm').addEventListener('click', joinConfirm);
  $('inp-join-code').addEventListener('keydown', e=>e.key==='Enter'&&joinConfirm());

  // Lobby – copy code
  $('btn-copy').addEventListener('click', ()=>{
    navigator.clipboard.writeText(roomCode||'').catch(()=>{});
    $('btn-copy').textContent='¡Copiado!';
    setTimeout(()=>$('btn-copy').textContent='Copiar código', 1500);
  });

  $('btn-start').addEventListener('click', ()=>emit({type:'startGame'}));
  $('btn-back').addEventListener('click', ()=>show('menu'));

  $('btn-play-again').addEventListener('click', ()=>{
    gs=null; mapTiles=null; roomCode=null; stopRendering();
    playMusic('menu');
    show('menu');
  });

  setupInput();
}

init();
