/*
 Simple mobile-friendly city builder.
 - Grid-based placement
 - Roads, houses, apartments, factories
 - Bulldozer to remove
 - Money, population, income per second
 - Pan and zoom, tap to place
*/

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d', { alpha: false });

const moneyEl = document.getElementById('money');
const popEl = document.getElementById('pop');
const incomeEl = document.getElementById('income');
const tools = Array.from(document.querySelectorAll('.tool'));
const clearBtn = document.getElementById('clear');

let devicePixelRatio = Math.max(1, window.devicePixelRatio || 1);

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.round(rect.width * devicePixelRatio);
  canvas.height = Math.round(rect.height * devicePixelRatio);
  ctx.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0);
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

/* World parameters */
const GRID_SIZE = 32; // tile pixel size at scale = 1
const WORLD_W = 32;
const WORLD_H = 20;

/* camera */
let cam = { x: (WORLD_W*GRID_SIZE)/2 - canvas.width/2/devicePixelRatio, y: (WORLD_H*GRID_SIZE)/2 - canvas.height/2/devicePixelRatio, scale: 1 };
const clamp = (v,a,b)=>Math.max(a,Math.min(b,v));

function worldToScreen(wx, wy){
  return { x: (wx - cam.x)*cam.scale, y: (wy - cam.y)*cam.scale };
}
function screenToWorld(sx, sy){
  return { x: sx/cam.scale + cam.x, y: sy/cam.scale + cam.y };
}

/* grid data */
const EMPTY = 0, ROAD = 1, HOUSE = 2, APT = 3, FACTORY = 4;
let grid = new Array(WORLD_H).fill(0).map(()=>new Array(WORLD_W).fill(EMPTY));

/* player */
let state = {
  money: 10000,
  pop: 0,
  incomePerSec: 0,
  tool: 'road',
};

/* building properties */
const PROPS = {
  road:{cost:50},
  house:{cost:500, pop:4, income:5},
  apt:{cost:2000, pop:20, income:30},
  factory:{cost:3000, pop:0, income:80},
};

/* Input: pan, zoom, place */
let isPanning = false;
let lastPointer = null;
let pointerDown = false;

canvas.addEventListener('pointerdown', (e)=>{
  canvas.setPointerCapture(e.pointerId);
  pointerDown = true;
  lastPointer = {x:e.clientX, y:e.clientY};
  if (e.button === 1) { isPanning = true; }
});

canvas.addEventListener('pointermove', (e)=>{
  if (!pointerDown) return;
  const dx = (e.clientX - lastPointer.x)/cam.scale;
  const dy = (e.clientY - lastPointer.y)/cam.scale;
  if (isPanning || e.buttons === 4 || e.buttons === 2) {
    cam.x -= dx;
    cam.y -= dy;
    constrainCam();
    lastPointer = {x:e.clientX, y:e.clientY};
    render();
  } else {
    // dragging: interpret as continuous placement
    tryPlaceAtPointer(e);
  }
});

canvas.addEventListener('pointerup', (e)=>{
  pointerDown = false;
  isPanning = false;
  // single click placement
  tryPlaceAtPointer(e, true);
  lastPointer = null;
  canvas.releasePointerCapture && canvas.releasePointerCapture(e.pointerId);
});

canvas.addEventListener('wheel', (e)=>{
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const mouse = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  const before = screenToWorld(mouse.x, mouse.y);
  cam.scale *= Math.exp(-e.deltaY * 0.0015);
  cam.scale = clamp(cam.scale, 0.6, 2.4);
  const after = screenToWorld(mouse.x, mouse.y);
  cam.x += (before.x - after.x);
  cam.y += (before.y - after.y);
  constrainCam();
  render();
}, { passive:false });

function constrainCam(){
  const worldWpx = WORLD_W*GRID_SIZE;
  const worldHpx = WORLD_H*GRID_SIZE;
  const viewW = canvas.width/devicePixelRatio / cam.scale;
  const viewH = canvas.height/devicePixelRatio / cam.scale;
  cam.x = clamp(cam.x, -viewW*0.2, worldWpx - viewW + viewW*0.2);
  cam.y = clamp(cam.y, -viewH*0.2, worldHpx - viewH + viewH*0.2);
}

/* placement */
function tryPlaceAtPointer(e, single=false){
  const rect = canvas.getBoundingClientRect();
  const sx = (e.clientX - rect.left);
  const sy = (e.clientY - rect.top);
  const wpos = screenToWorld(sx, sy);
  const gx = Math.floor(wpos.x / GRID_SIZE);
  const gy = Math.floor(wpos.y / GRID_SIZE);
  if (gx < 0 || gy < 0 || gx >= WORLD_W || gy >= WORLD_H) return;
  const tool = state.tool;
  if (tool === 'bulldozer'){
    if (grid[gy][gx] !== EMPTY){
      // sell partial value
      const sel = grid[gy][gx];
      let refund = 0;
      if (sel === ROAD) refund = Math.floor(PROPS.road.cost*0.5);
      if (sel === HOUSE) refund = Math.floor(PROPS.house.cost*0.6);
      if (sel === APT) refund = Math.floor(PROPS.apt.cost*0.6);
      if (sel === FACTORY) refund = Math.floor(PROPS.factory.cost*0.6);
      state.money += refund;
      grid[gy][gx] = EMPTY;
      recalc();
      render();
    }
    return;
  }
  // cost and placement rules
  const prop = PROPS[tool];
  if (!prop) return;

  if (grid[gy][gx] !== EMPTY) return; // cannot stack
  if (state.money < prop.cost) return;

  // simple rule: houses/apts require adjacency to road (orthogonal)
  const needsRoad = (tool === 'house' || tool === 'apt');
  if (needsRoad){
    const adj = [
      [0,1],[0,-1],[1,0],[-1,0]
    ];
    let ok=false;
    for (const [dx,dy] of adj){
      const nx = gx+dx, ny = gy+dy;
      if (nx>=0&&ny>=0&&nx<WORLD_W&&ny<WORLD_H){
        if (grid[ny][nx] === ROAD) { ok=true; break; }
      }
    }
    if (!ok) return;
  }

  // place
  let type = EMPTY;
  if (tool === 'road') type = ROAD;
  if (tool === 'house') type = HOUSE;
  if (tool === 'apt') type = APT;
  if (tool === 'factory') type = FACTORY;

  grid[gy][gx] = type;
  state.money -= prop.cost;
  recalc();
  render();

  // if not dragging, only single place
  if (single) return;
}

function recalc(){
  let pop = 0;
  let income = 0;
  for (let y=0;y<WORLD_H;y++){
    for (let x=0;x<WORLD_W;x++){
      const v = grid[y][x];
      if (v===HOUSE){ pop += PROPS.house.pop; income += PROPS.house.income; }
      if (v===APT){ pop += PROPS.apt.pop; income += PROPS.apt.income; }
      if (v===FACTORY){ income += PROPS.factory.income; }
    }
  }
  state.pop = pop;
  state.incomePerSec = income;
  moneyEl.textContent = state.money.toFixed(0);
  popEl.textContent = state.pop;
  incomeEl.textContent = state.incomePerSec.toFixed(0);
}

/* UI: toolbar */
tools.forEach(btn=>{
  btn.addEventListener('click', ()=>{
    tools.forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    state.tool = btn.dataset.tool;
  });
});
// default active
tools.find(t=>t.dataset.tool==='road').classList.add('active');

clearBtn.addEventListener('click', ()=>{
  grid = new Array(WORLD_H).fill(0).map(()=>new Array(WORLD_W).fill(EMPTY));
  recalc();
  render();
});

/* Simulation tick: add income each second */
let accumulator = 0;
let lastTime = performance.now();
function tick(now){
  const dt = (now - lastTime) / 1000;
  lastTime = now;
  accumulator += dt;
  if (accumulator >= 1){
    const secs = Math.floor(accumulator);
    accumulator -= secs;
    state.money += state.incomePerSec * secs;
    moneyEl.textContent = state.money.toFixed(0);
  }
}

/* Rendering */
function drawGrid(){
  ctx.clearRect(0,0,canvas.width/devicePixelRatio,canvas.height/devicePixelRatio);
  // background
  ctx.fillStyle = '#cfe9a8';
  ctx.fillRect(0,0,canvas.width/devicePixelRatio,canvas.height/devicePixelRatio);

  // draw tiles (with visible empty "plots")
  for (let y=0;y<WORLD_H;y++){
    for (let x=0;x<WORLD_W;x++){
      const wx = x*GRID_SIZE, wy = y*GRID_SIZE;
      const s = worldToScreen(wx, wy);
      const size = GRID_SIZE * cam.scale;
      // cull
      if (s.x + size < -50 || s.y + size < -50 || s.x > canvas.width/devicePixelRatio + 50 || s.y > canvas.height/devicePixelRatio + 50) continue;
      ctx.save();
      ctx.translate(s.x, s.y);

      const tile = grid[y][x];

      // draw base for every tile (plots visible for empties)
      if (tile === EMPTY){
        // plot ground
        ctx.fillStyle = '#e6f0c9';
        ctx.fillRect(0,0,size,size);
        // subtle tilled lines to indicate a plot
        ctx.strokeStyle = 'rgba(60,80,40,0.08)';
        ctx.lineWidth = Math.max(1, size * 0.03);
        // vertical furrows
        const cols = 3;
        for (let i=1;i<cols;i++){
          const px = (size * i) / cols;
          ctx.beginPath();
          ctx.moveTo(px, size*0.08);
          ctx.lineTo(px, size*0.92);
          ctx.stroke();
        }
        // small center marker
        ctx.fillStyle = 'rgba(60,80,40,0.06)';
        ctx.fillRect(size*0.42, size*0.42, size*0.16, size*0.16);
      } else {
        // non-empty base
        ctx.fillStyle = '#d6eac0';
        ctx.fillRect(0,0,size,size);
      }

      if (tile === ROAD){
        // draw road as dark strip
        ctx.fillStyle = '#6b6b6b';
        ctx.fillRect(0, size*0.45, size, size*0.1);
      } else if (tile === HOUSE){
        // small house
        ctx.fillStyle = '#fff6e0';
        ctx.fillRect(size*0.1, size*0.25, size*0.8, size*0.5);
        ctx.fillStyle = '#b3523a';
        ctx.beginPath();
        ctx.moveTo(size*0.1, size*0.25);
        ctx.lineTo(size*0.5, size*0.05);
        ctx.lineTo(size*0.9, size*0.25);
        ctx.closePath();
        ctx.fill();
      } else if (tile === APT){
        ctx.fillStyle = '#e8f2ff';
        ctx.fillRect(size*0.05, size*0.05, size*0.9, size*0.9);
        ctx.fillStyle = '#7aa3ff';
        for (let i=0;i<3;i++){
          for (let j=0;j<3;j++){
            ctx.fillRect(size*0.12 + j*size*0.26, size*0.12 + i*size*0.26, size*0.18, size*0.12);
          }
        }
      } else if (tile === FACTORY){
        ctx.fillStyle = '#e9e9e9';
        ctx.fillRect(size*0.05, size*0.2, size*0.9, size*0.6);
        ctx.fillStyle = '#a0a0a0';
        ctx.fillRect(size*0.12, size*0.12, size*0.18, size*0.12);
        ctx.fillStyle = '#333';
        ctx.fillRect(size*0.6, size*0.05, size*0.15, size*0.25);
      }

      // tile border
      ctx.strokeStyle = 'rgba(0,0,0,0.06)';
      ctx.strokeRect(0,0,size,size);

      ctx.restore();
    }
  }

  // grid lines
  ctx.save();
  ctx.strokeStyle = 'rgba(0,0,0,0.06)';
  ctx.lineWidth = 1;
  // verticals
  for (let i=0;i<=WORLD_W;i++){
    const wx = i*GRID_SIZE;
    const s = worldToScreen(wx, 0);
    ctx.beginPath();
    ctx.moveTo(s.x + 0.5, 0);
    ctx.lineTo(s.x + 0.5, canvas.height/devicePixelRatio);
    ctx.stroke();
  }
  // horizontals
  for (let j=0;j<=WORLD_H;j++){
    const wy = j*GRID_SIZE;
    const s = worldToScreen(0, wy);
    ctx.beginPath();
    ctx.moveTo(0, s.y + 0.5);
    ctx.lineTo(canvas.width/devicePixelRatio, s.y + 0.5);
    ctx.stroke();
  }
  ctx.restore();

  // hint: draw ghost tile under cursor if tool selected
  if (lastPointer){
    // convert lastPointer (client) to canvas local
    const rect = canvas.getBoundingClientRect();
    const sx = lastPointer.x - rect.left;
    const sy = lastPointer.y - rect.top;
    const wpos = screenToWorld(sx, sy);
    const gx = Math.floor(wpos.x / GRID_SIZE);
    const gy = Math.floor(wpos.y / GRID_SIZE);
    if (gx>=0&&gy>=0&&gx<WORLD_W&&gy<WORLD_H){
      const s = worldToScreen(gx*GRID_SIZE, gy*GRID_SIZE);
      const size = GRID_SIZE * cam.scale;
      ctx.save();
      ctx.globalAlpha = 0.7;
      ctx.fillStyle = getToolColor(state.tool);
      ctx.fillRect(s.x, s.y, size, size);
      ctx.globalAlpha = 1;
      ctx.restore();
    }
  }
}

function getToolColor(tool){
  if (tool === 'road') return 'rgba(80,80,80,0.4)';
  if (tool === 'house') return 'rgba(179,82,58,0.35)';
  if (tool === 'apt') return 'rgba(122,163,255,0.25)';
  if (tool === 'factory') return 'rgba(90,90,90,0.25)';
  if (tool === 'bulldozer') return 'rgba(255,80,80,0.25)';
  return 'rgba(0,0,0,0.2)';
}

function render(){
  drawGrid();
}

/* animate loop */
function loop(now){
  tick(now);
  render();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

/* Touch helpers: pinch to zoom */
let pinch = { active:false, id1:null, id2:null, startDist:0, startScale:1 };
canvas.addEventListener('pointerdown', (e)=>{
  if (e.isPrimary) return;
});
canvas.addEventListener('pointercancel', (e)=>{});
let activePointers = {};
canvas.addEventListener('pointerdown', (e)=>{ activePointers[e.pointerId]=e; });
canvas.addEventListener('pointerup', (e)=>{ delete activePointers[e.pointerId]; pinch.active=false; });
canvas.addEventListener('pointermove', (e)=>{
  activePointers[e.pointerId]=e;
  const keys = Object.keys(activePointers);
  if (keys.length === 2){
    // pinch
    const p1 = activePointers[keys[0]];
    const p2 = activePointers[keys[1]];
    const dx = p1.clientX - p2.clientX;
    const dy = p1.clientY - p2.clientY;
    const dist = Math.hypot(dx,dy);
    if (!pinch.active){
      pinch.active = true;
      pinch.startDist = dist;
      pinch.startScale = cam.scale;
    } else {
      const factor = dist / pinch.startDist;
      cam.scale = clamp(pinch.startScale * factor, 0.6, 2.4);
    }
    constrainCam();
  }
});



/* Prevent context menu on long press */
canvas.addEventListener('contextmenu', e=>e.preventDefault());

/* initial render */
recalc();
render();