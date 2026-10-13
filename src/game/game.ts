// Game: world loading, main loop, physics stepping, rendering, HUD wiring.

import { loadManifest, Projection, pointInRing, distToRing, type Manifest } from '../world/manifest';
import { TileCache, type View } from '../render/tileCache';
import { LabelLayer, abbreviate } from '../render/labels';
import { drawCar, drawPin, drawPuck, drawRoute, drawOverpasses, Skids, Smoke, CAR_COLORS } from '../render/carDraw';
import { Car, type SurfaceParams } from './car';
import { VEHICLES, vehicleById } from './vehicles';
import { THEMES } from '../render/style';
import { Camera } from './camera';
import { Input } from './input';
import { WorldQuery, neighborhoodAt, type RoadHit, type Hood, type HoodArea } from './worldQuery';
import { loadSettings, saveSettings, type Settings } from './settings';
import { LF, LK } from '../world/codes';
import { RoadGraph, type Route } from '../nav/graph';
import { RouteFollower } from '../nav/follow';
import { Search } from '../nav/search';
import { Hud, fmtDist, fmtDur, iconSvg } from '../ui/hud';
import { FullMap } from '../ui/fullmap';
import { setCacheVersion, setBinSuffix, pruneOldCaches } from '../world/fetchCache';

const MPS_TO_MPH = 2.2369363;

// soft top speed per road class (m/s) — highways are much faster than side streets
const TOP: Record<number, number> = {
  [LK.motorway]: 58, [LK.trunk]: 42, [LK.primary]: 32, [LK.secondary]: 29, [LK.tertiary]: 26,
  [LK.residential]: 21, [LK.minor]: 20, [LK.service]: 15, [LK.serviceMinor]: 12, [LK.roadUnknown]: 15,
};

export class Game {
  manifest!: Manifest;
  proj!: Projection;
  cache!: TileCache;
  labels = new LabelLayer();
  wq!: WorldQuery;
  car = new Car();
  cam = new Camera();
  input!: Input;
  settings: Settings = loadSettings();
  hud!: Hud;
  map!: FullMap;
  search = new Search();
  follower = new RouteFollower();
  graph: RoadGraph | null = null;
  private graphLoading: Promise<RoadGraph> | null = null;
  dest: { x: number; y: number } | null = null;

  private canvas = document.getElementById('view') as HTMLCanvasElement;
  private ctx = this.canvas.getContext('2d', { alpha: false })!;
  private mm = document.getElementById('minimap') as HTMLCanvasElement;
  private mmCtx = this.mm.getContext('2d', { alpha: false })!;
  private skids = new Skids();
  private smoke = new Smoke();
  private region!: Float32Array;
  private hoods: Hood[] = [];
  private hoodAreas: HoodArea[] = [];
  private road: RoadHit | null = null;
  private surface: 'road' | 'paved' | 'offroad' = 'road';
  private topSpeed = 21;
  private acc = 0;
  private time = 0;
  private last = 0;
  private hudT = 0;
  private paused = false;
  private rerouting = false;
  private hintT = 14;
  private debug = false;
  private fpsN = 0;
  private fpsT = 0;
  private fps = 0;

  async start(status: (s: string) => void) {
    status('Loading map manifest…');
    this.manifest = await loadManifest();
    const m = this.manifest;
    setCacheVersion(m.generated);
    setBinSuffix((m as any).binSuffix);
    pruneOldCaches();
    this.proj = new Projection(m.projection.lat0, m.projection.lon0);
    this.region = new Float32Array((m as any).region ?? m.perimeter);
    this.cache = new TileCache(m, this.renderDpr());
    this.applyTheme();
    this.wq = new WorldQuery(m);
    this.input = new Input(this.canvas);
    this.input.enabled = false; // until Play is pressed
    status('Loading labels…');
    await this.labels.load(m.labelChunks, m.labelChunkSize);
    this.hoods = this.labels.global.hoods;
    this.hoodAreas = this.labels.global.hoodAreas;
    this.car.scale = this.settings.carScale;
    this.car.setHandling(vehicleById(this.settings.vehicle).h);
    this.cam.mode = this.settings.cameraMode;
    this.car.place(m.spawn.x, m.spawn.y, m.spawn.heading);
    this.cam.snapTo(this.car);
    status('Loading streets around Peachtree & 10th…');
    await this.wq.waitFor(this.car.x, this.car.y);
    this.hud = new Hud();
    this.map = new FullMap(this);
    this.bindUi();
    this.resize();
    window.addEventListener('resize', () => this.resize());
    // warm up the first screen of tiles before revealing
    status('Drawing Midtown…');
    const t0 = performance.now();
    await new Promise<void>((resolve) => {
      const tick = () => {
        this.cache.beginFrame();
        const ok = this.cache.draw(this.ctx, this.mainView(), 0, false);
        this.cache.pump();
        if (ok || performance.now() - t0 > 9000) resolve();
        else setTimeout(tick, 60);
      };
      tick();
    });
    this.last = performance.now();
    requestAnimationFrame((t) => this.frame(t));
    // load the routing graph in the background
    setTimeout(() => this.ensureGraph(), 1500);
  }

  renderDpr() {
    const d = window.devicePixelRatio || 1;
    // keep the backing store under ~9 MP so huge 4K/5K screens stay smooth
    const cap = Math.sqrt(9e6 / Math.max(1, window.innerWidth * window.innerHeight));
    return Math.max(1, Math.min(d, this.settings.quality >= 2 ? 2 : 1, cap));
  }

  private resize() {
    const dpr = this.renderDpr();
    const w = window.innerWidth, h = window.innerHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    const mw = this.mm.clientWidth || 178;
    this.mm.width = Math.round(mw * dpr);
    this.mm.height = Math.round(mw * dpr);
    this.cache?.setPxScale(dpr);
    // keep enough tiles for a full screen at two zoom levels (+ minimap)
    if (this.cache) this.cache.maxTiles = Math.min(340, Math.max(140, Math.ceil((w * dpr * h * dpr) / (512 * 512)) * 5 + 60));
  }

  mainView(): View {
    const [sx, sy] = this.cam.shakeOffset(this.car.impact);
    return {
      cx: this.cam.x + sx / this.cam.scale, cy: this.cam.y + sy / this.cam.scale,
      scale: this.cam.scale, rot: this.cam.rot,
      w: window.innerWidth, h: window.innerHeight, dpr: this.renderDpr(),
    };
  }

  /** called when the player presses Play */
  begin() {
    this.input.enabled = true;
    this.hintT = 14;
    (document.getElementById('hint') as HTMLElement).style.opacity = '1';
  }

  hoodName(x: number, y: number) { return neighborhoodAt(x, y, this.hoods, this.hoodAreas).hood; }

  // ------------------------------------------------------------- routing --
  ensureGraph(): Promise<RoadGraph> {
    if (this.graph) return Promise.resolve(this.graph);
    if (!this.graphLoading) this.graphLoading = RoadGraph.load().then((g) => (this.graph = g));
    return this.graphLoading;
  }

  async setDestination(x: number, y: number): Promise<{ route: Route; roadName: string | null } | null> {
    const g = await this.ensureGraph();
    const b = g.snap(x, y, 500, undefined, true, true) ?? g.snap(x, y, 500);
    if (!b) return null;
    this.dest = { x: b.x, y: b.y };
    const r = this.computeRoute(g, b);
    if (!r) { this.follower.set(null); return null; }
    this.follower.set(r);
    this.updateEmphasis();
    return { route: r, roadName: g.name(b.edge) };
  }

  private computeRoute(g: RoadGraph, b: ReturnType<RoadGraph['snap']>): Route | null {
    if (!b) return null;
    const onMotor = this.road && this.road.kind <= LK.trunk && this.road.dist < 15;
    const a = g.snap(this.car.x, this.car.y, 300, this.car.heading, !onMotor) ?? g.snap(this.car.x, this.car.y, 600);
    if (!a) return null;
    return g.route(a, b, this.car.speed > 1 ? this.car.heading : this.car.heading);
  }

  clearRoute() {
    this.follower.set(null);
    this.dest = null;
    this.labels.emphasize = new Set();
  }

  private updateEmphasis() {
    const r = this.follower.route;
    this.labels.emphasize = new Set(r ? r.steps.map((s) => s.road).filter(Boolean) : []);
  }

  private async reroute() {
    if (this.rerouting || !this.dest || !this.graph) return;
    this.rerouting = true;
    const g = this.graph;
    const b = g.snap(this.dest.x, this.dest.y, 50);
    const r = this.computeRoute(g, b);
    if (r) { this.follower.set(r); this.updateEmphasis(); this.hud.toast('Rerouting…', 1.4); }
    this.rerouting = false;
  }

  // ------------------------------------------------------------------- UI --
  private bindUi() {
    const menu = document.getElementById('menu')!;
    document.getElementById('btn-menu')!.onclick = () => this.togglePause();
    document.getElementById('menu-resume')!.onclick = () => this.togglePause(false);
    document.getElementById('btn-map')!.onclick = () => this.map.toggle();
    this.mm.onclick = () => this.map.show();
    document.getElementById('btn-compass')!.onclick = () => this.toggleCamera();
    document.getElementById('nav-end')!.onclick = () => this.clearRoute();
    menu.addEventListener('click', (e) => { if (e.target === menu) this.togglePause(false); });
    // segmented settings
    document.querySelectorAll<HTMLElement>('.seg').forEach((seg) => {
      const key = seg.dataset.key as keyof Settings;
      seg.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
        b.onclick = () => {
          const v = b.dataset.v!;
          (this.settings as any)[key] = typeof this.settings[key] === 'string' ? v : Number(v);
          this.applySettings();
        };
      });
    });
    this.syncUi();
    const sw = document.getElementById('swatches')!;
    for (const [k, c] of Object.entries(CAR_COLORS)) {
      const d = document.createElement('div');
      d.className = 'swatch' + (this.settings.color === k ? ' on' : '');
      d.style.background = c.body;
      d.title = k;
      d.onclick = () => {
        this.settings.color = k;
        sw.querySelectorAll('.swatch').forEach((s) => s.classList.remove('on'));
        d.classList.add('on');
        saveSettings(this.settings);
        this.syncUi();
      };
      sw.appendChild(d);
    }
    document.getElementById('menu-about')!.innerHTML =
      `Every street, building, park and waterway here is real map data from <b>OpenStreetMap</b> contributors ` +
      `(distributed by the Overture Maps Foundation, release ${this.manifest.source.match(/\d{4}-\d{2}-\d{2}\.\d/)?.[0] ?? ''}). ` +
      `The world is clipped to the actual I-285 perimeter. Game speed compresses time; the speedometer shows true road speed.`;
  }

  private applySettings() {
    const s = this.settings;
    this.cam.mode = s.cameraMode;
    this.car.scale = s.carScale;
    this.car.setHandling(vehicleById(s.vehicle).h);
    this.applyTheme();
    saveSettings(s);
    this.resize();
    this.syncUi();
  }

  private applyTheme() {
    const th = THEMES[this.settings.mapStyle] ?? THEMES.map;
    this.cache.setTheme(th.id);
    this.labels.theme = th;
    document.documentElement.dataset.mapStyle = th.id;
  }

  /** reflect settings in every segmented control and vehicle picker */
  private syncUi() {
    document.querySelectorAll<HTMLElement>('.seg').forEach((seg) => {
      const key = seg.dataset.key as keyof Settings;
      seg.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.classList.toggle('on', String(this.settings[key]) === b.dataset.v));
    });
    for (const id of ['menu-vehicles', 'title-vehicles']) this.renderVehicles(document.getElementById(id));
  }

  private renderVehicles(el: HTMLElement | null) {
    if (!el) return;
    if (!el.dataset.built) {
      el.dataset.built = '1';
      for (const v of VEHICLES) {
        const b = document.createElement('button');
        b.className = 'vcard';
        b.dataset.id = v.id;
        b.title = v.blurb;
        const bar = (label: string, n: number) => `<div class="vstat"><span>${label}</span><div class="vbar"><i style="width:${n * 20}%"></i></div></div>`;
        b.innerHTML = `<canvas width="240" height="68"></canvas><div class="vn">${v.name}</div>${bar('Speed', v.stats.speed)}${bar('Accel', v.stats.accel)}${bar('Control', v.stats.control)}`;
        b.onclick = () => { this.settings.vehicle = v.id; this.applySettings(); };
        el.appendChild(b);
      }
      const blurb = document.createElement('div');
      blurb.className = 'vblurb';
      el.after(blurb);
    }
    el.querySelectorAll<HTMLButtonElement>('.vcard').forEach((b) => {
      b.classList.toggle('on', b.dataset.id === this.settings.vehicle);
      const cv = b.querySelector('canvas')!;
      const g = cv.getContext('2d')!;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, cv.width, cv.height);
      const v = vehicleById(b.dataset.id!);
      const c = new Car(v.h);
      c.scale = 1;
      c.place(0, 0, 0);
      const k = Math.min(200 / 7.4, 52 / 2.6); // same scale for all, so sizes compare
      g.setTransform(k, 0, 0, k, cv.width / 2, cv.height / 2);
      drawCar(g, c, this.settings.color, 0, k, v.body);
    });
    const blurb = el.nextElementSibling as HTMLElement | null;
    if (blurb?.classList.contains('vblurb')) blurb.textContent = vehicleById(this.settings.vehicle).blurb;
  }

  private cycleVehicle() {
    const i = VEHICLES.findIndex((v) => v.id === this.settings.vehicle);
    const v = VEHICLES[(i + 1) % VEHICLES.length];
    this.settings.vehicle = v.id;
    this.applySettings();
    this.hud.toast(`${v.name} — ${v.blurb}`, 2.2);
  }

  private toggleStyle() {
    this.settings.mapStyle = this.settings.mapStyle === 'map' ? 'real' : 'map';
    this.applySettings();
    this.hud.toast(this.settings.mapStyle === 'real' ? 'Map style: realistic' : 'Map style: cartographic', 1.4);
  }

  private toggleCamera() {
    this.settings.cameraMode = this.settings.cameraMode === 'north' ? 'car' : 'north';
    this.applySettings();
    document.querySelectorAll<HTMLElement>('.seg[data-key="cameraMode"] button').forEach((b) => b.classList.toggle('on', b.dataset.v === this.settings.cameraMode));
    this.hud.toast(this.settings.cameraMode === 'car' ? 'Camera: car up' : 'Camera: north up', 1.2);
  }

  private togglePause(force?: boolean) {
    this.paused = force ?? !this.paused;
    document.getElementById('menu')!.classList.toggle('hidden', !this.paused);
  }

  private resetCar() {
    const r = this.wq.nearestRoad(this.car.x, this.car.y, 250, null, this.car.heading);
    if (!r) { this.car.place(this.manifest.spawn.x, this.manifest.spawn.y, this.manifest.spawn.heading); }
    else {
      let hd = Math.atan2(r.diry, r.dirx);
      const fwd = Math.cos(hd - this.car.heading) >= 0;
      if (r.flags & LF.oneway) { /* geometry direction */ }
      else if (r.flags & LF.onewayRev) hd += Math.PI;
      else if (!fwd) hd += Math.PI;
      this.car.place(r.px, r.py, hd);
    }
    this.hud.toast('Car reset', 1.2);
  }

  // ----------------------------------------------------------------- loop --
  private frame(t: number) {
    const rdt = Math.min(0.05, Math.max(0.0001, (t - this.last) / 1000));
    this.last = t;
    try {
      this.handleKeys();
      if (this.map.open) {
        this.cache.beginFrame();
        this.map.frame(rdt);
        this.cache.pump();
        this.hud.tick(rdt);
      } else {
        if (!this.paused) this.simulate(rdt);
        this.render(rdt);
      }
    } catch (e) {
      console.error(e);
    }
    this.input.endFrame();
    requestAnimationFrame((tt) => this.frame(tt));
  }

  private handleKeys() {
    const inp = this.input;
    if (!inp.enabled) return; // title screen
    if (inp.hit('m')) this.map.toggle();
    if (inp.hit('Escape')) {
      if (this.map.open) this.map.hide();
      else this.togglePause();
    }
    if (this.map.open) return;
    if (inp.hit('r')) this.resetCar();
    if (inp.hit('c')) this.toggleCamera();
    if (inp.hit('v')) this.cycleVehicle();
    if (inp.hit('t')) this.toggleStyle();
    if (inp.hit('F3') || inp.hit('`')) {
      this.debug = !this.debug;
      document.getElementById('debug')!.classList.toggle('hidden', !this.debug);
    }
    if (inp.wheel && !this.paused) this.cam.zoomBy(Math.exp(-inp.wheel * 0.0016));
    if (inp.hit('=') || inp.hit('+')) this.cam.zoomBy(1.25);
    if (inp.hit('-')) this.cam.zoomBy(0.8);
  }

  private surfaceParams(): SurfaceParams {
    if (this.surface === 'road' && this.road) {
      let top = TOP[this.road.kind] ?? 18;
      if (this.road.flags & LF.link) top = Math.min(top, this.road.kind <= LK.trunk ? 31 : 22);
      return { topSpeed: top, grip: 1, drag: 0 };
    }
    if (this.surface === 'paved') return { topSpeed: 14, grip: 0.95, drag: 0.2 };
    return { topSpeed: 17, grip: 0.74, drag: 0.8 };
  }

  private simulate(rdt: number) {
    const car = this.car;
    const inp = this.input.read(rdt);
    // road & surface detection (once per frame)
    this.wq.prefetch(car.x, car.y);
    const prev = this.road ? { name: this.road.name, level: this.road.level } : null;
    this.road = this.wq.nearestRoad(car.x, car.y, 30, prev, car.heading);
    this.surface = this.wq.surfaceAt(car.x, car.y, this.road);
    const sp = this.surfaceParams();
    this.topSpeed += (sp.topSpeed - this.topSpeed) * (1 - Math.exp(-rdt * 1.5));
    sp.topSpeed = this.topSpeed;

    const ts = this.settings.timeScale;
    this.acc += rdt * ts;
    const H = 1 / 120;
    let steps = 0;
    while (this.acc >= H && steps < 16) {
      car.step(H, inp, sp, H / ts);
      this.collide();
      this.acc -= H;
      steps++;
      this.time += H;
    }
    // effects
    const slide = Math.abs(car.vLat);
    const skid = (slide > 2.6 && car.speed > 4) || (inp.handbrake && car.speed > 5) || (car.braking && inp.brake > 0.9 && car.speed > 14);
    this.skids.add(car, this.time, skid, Math.min(1, slide / 6 + (inp.handbrake ? 0.5 : 0.3)));
    if (slide > 4.5 || (inp.handbrake && car.speed > 12)) {
      const fx = Math.cos(car.heading), fy = Math.sin(car.heading);
      for (const s of [-1, 1]) {
        const bx = car.x - fx * car.length * 0.32 - fy * s * car.width * 0.4;
        const by = car.y - fy * car.length * 0.32 + fx * s * car.width * 0.4;
        if (Math.random() < 0.6) this.smoke.emit(bx, by, car.vx, car.vy, car.width * 0.32);
      }
    }
    this.smoke.update(rdt * ts);
    const v = this.mainView();
    this.cam.update(rdt, car, v.w, v.h, !!this.settings.lookAhead, !!this.settings.speedZoom);

    // navigation
    if (this.follower.route) {
      const st = this.follower.update(car.x, car.y, rdt);
      if (st === 'arrived') { this.hud.toast('You have arrived', 3); this.clearRoute(); }
      else if (st === 'off') this.reroute();
    }
  }

  private collide() {
    const car = this.car;
    for (const c of car.circles()) {
      const hit = this.wq.collideCircle(c.x, c.y, c.r);
      if (hit) {
        car.x += hit.dx; car.y += hit.dy;
        car.bounce(hit.nx, hit.ny);
      }
    }
    // keep the car inside the I-285 world
    if (!pointInRing(car.x, car.y, this.region)) {
      const d = distToRing(car.x, car.y, this.region);
      const nx = d.nx - car.x, ny = d.ny - car.y, L = Math.hypot(nx, ny) || 1;
      car.x = d.nx + (nx / L) * 0.5; car.y = d.ny + (ny / L) * 0.5;
      car.bounce(nx / L, ny / L);
    }
  }

  private render(rdt: number) {
    const ctx = this.ctx;
    const v = this.mainView();
    const car = this.car;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.labels.theme.land;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.cache.beginFrame();
    this.cache.draw(ctx, v, 0);
    // world-space overlays
    TileCache.applyView(ctx, v);
    const b = TileCache.viewBounds(v, 60);
    this.skids.draw(ctx, this.time, 0.32 * car.scale, b);
    if (this.follower.route) drawRoute(ctx, this.follower.route, this.follower.along, v.scale, b);
    // labels (screen space) under the car
    const carS = this.toScreen(v, car.x, car.y);
    const rr = Math.max(14, car.length * v.scale * 0.7);
    const reserve = v.scale > 0.6 ? [[carS[0] - rr, carS[1] - rr, carS[0] + rr, carS[1] + rr]] : [];
    this.labels.draw(ctx, v, { reserve });
    // destination pin
    if (this.dest) {
      const p = this.toScreen(v, this.dest.x, this.dest.y);
      ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
      drawPin(ctx, p[0], p[1]);
    }
    // car
    const pxLen = car.length * v.scale;
    if (pxLen >= 11) {
      TileCache.applyView(ctx, v);
      this.smoke.draw(ctx);
      drawCar(ctx, car, this.settings.color, v.rot, v.scale, vehicleById(this.settings.vehicle).body);
      const lvl = Math.max(0, this.road && this.road.dist < this.road.halfWidth + 4 ? this.road.level : 0);
      drawOverpasses(ctx, this.wq.linesAbove(car.x, car.y, car.length + 6, lvl), v.scale, this.labels.theme);
    } else {
      ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
      drawPuck(ctx, carS[0], carS[1], car.heading + v.rot);
    }
    this.drawVignette(ctx);
    this.renderMinimap();
    this.cache.pump();
    this.updateHud(rdt);
  }

  private vignette: HTMLCanvasElement | null = null;
  /** soft warm ambient vignette — pre-rendered once per canvas size */
  private drawVignette(ctx: CanvasRenderingContext2D) {
    const W = this.canvas.width, H = this.canvas.height;
    if (!this.vignette || this.vignette.width !== W || this.vignette.height !== H) {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const g = c.getContext('2d')!;
      const grad = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.hypot(W, H) * 0.62);
      grad.addColorStop(0, 'rgba(90,70,50,0)');
      grad.addColorStop(1, 'rgba(90,70,50,0.13)');
      g.fillStyle = grad;
      g.fillRect(0, 0, W, H);
      this.vignette = c;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.vignette, 0, 0);
  }

  private toScreen(v: View, x: number, y: number): [number, number] {
    const dx = (x - v.cx) * v.scale, dy = (y - v.cy) * v.scale;
    const c = Math.cos(v.rot), s = Math.sin(v.rot);
    return [v.w / 2 + dx * c - dy * s, v.h / 2 + dx * s + dy * c];
  }

  private renderMinimap() {
    const ctx = this.mmCtx;
    const size = this.mm.clientWidth || 178;
    const dpr = this.renderDpr();
    const v: View = {
      cx: this.car.x, cy: this.car.y, scale: Math.max(0.06, Math.min(0.55, this.cam.scale * 0.16)), rot: this.cam.rot,
      w: size, h: size, dpr,
    };
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.labels.theme.land;
    ctx.fillRect(0, 0, this.mm.width, this.mm.height);
    this.cache.draw(ctx, v, 8, false);
    TileCache.applyView(ctx, v);
    if (this.follower.route) drawRoute(ctx, this.follower.route, this.follower.along, v.scale * 0.6, TileCache.viewBounds(v, 50));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.dest) {
      let dx = (this.dest.x - v.cx) * v.scale, dy = (this.dest.y - v.cy) * v.scale;
      const c = Math.cos(v.rot), s = Math.sin(v.rot);
      let px = dx * c - dy * s, py = dx * s + dy * c;
      const L = Math.hypot(px, py), R = size / 2 - 12;
      if (L > R) { px *= R / L; py *= R / L; }
      ctx.beginPath();
      ctx.arc(size / 2 + px, size / 2 + py, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#3F78F0'; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke();
      void dx; void dy;
    }
    drawPuck(ctx, size / 2, size / 2, this.car.heading + v.rot, 0.85);
  }

  private updateHud(rdt: number) {
    const car = this.car;
    this.fpsN++; this.fpsT += rdt;
    if (this.fpsT >= 0.5) { this.fps = this.fpsN / this.fpsT; this.fpsN = 0; this.fpsT = 0; }
    if (this.debug && this.hudT <= 0) {
      const st = this.cache.stats();
      const r = this.road;
      document.getElementById('debug')!.textContent = [
        `fps        ${this.fps.toFixed(0)}`,
        `tiles      ${st.tiles} cached · ${st.inflight} rendering · ${st.queued} queued`,
        `raster     ${st.ms.toFixed(1)} ms/tile avg · ${st.workers} workers`,
        `zoom       ${this.cam.scale.toFixed(2)} px/m · tile z${this.cache.zoomFor(this.mainView())}`,
        `chunks     ${this.wq.loadedChunks} L0 near car`,
        `pos        ${car.x.toFixed(1)}, ${car.y.toFixed(1)} m`,
        `road       ${r ? `${r.name ?? '—'} k${r.kind} lvl${r.level} d${r.dist.toFixed(1)}m` : '—'}`,
        `surface    ${this.surface} · top ${(this.topSpeed * MPS_TO_MPH).toFixed(0)} mph`,
        `slip       ${car.vLat.toFixed(2)} m/s`,
      ].join('\n');
    }
    const mph = car.speed * MPS_TO_MPH;
    this.hud.setSpeed(mph, car.vLong < -0.3 ? 'R' : car.speed < 0.3 ? 'P' : 'D');
    this.hud.setCompass(this.cam.rot);
    this.hud.tick(rdt);
    this.hudT -= rdt;
    if (this.hintT > 0) {
      this.hintT -= rdt;
      if (this.hintT <= 0) (document.getElementById('hint') as HTMLElement).style.opacity = '0';
    }
    if (this.hudT > 0) return;
    this.hudT = 0.12;
    const r = this.road;
    const off = this.surface === 'offroad' && (!r || r.dist > r.halfWidth + 6);
    this.hud.setRoad(r && r.dist < r.halfWidth + 8 ? r.name : null, r && r.dist < r.halfWidth + 8 ? r.ref : null,
      r && r.dist < r.halfWidth + 8 ? r.kind : null, off);
    const { hood, city } = neighborhoodAt(car.x, car.y, this.hoods, this.hoodAreas);
    this.hud.setPlace(hood, city);
    if (this.settings.showCoords) {
      const [lon, lat] = this.proj.inverse(car.x, car.y);
      this.hud.setCoords(`${lat.toFixed(5)}° N   ${Math.abs(lon).toFixed(5)}° W`);
    } else this.hud.setCoords('');
    // navigation card
    const nav = document.getElementById('nav')!;
    if (this.follower.route) {
      nav.classList.remove('hidden');
      const st = this.follower.nextStep();
      if (st) {
        const d = st.along - this.follower.along;
        document.getElementById('nav-dist')!.textContent = fmtDist(Math.max(0, d));
        document.getElementById('nav-text')!.textContent = abbreviate(st.text);
        const icon = document.getElementById('nav-icon')!;
        if (icon.dataset.icon !== st.icon) { icon.innerHTML = iconSvg(st.icon); icon.dataset.icon = st.icon; }
      }
      const rem = this.follower.remaining();
      const eta = new Date(Date.now() + (rem.time / this.settings.timeScale) * 1000);
      document.getElementById('nav-eta')!.textContent =
        `${fmtDur(rem.time / this.settings.timeScale)} · ${fmtDist(rem.dist)} · ${eta.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    } else nav.classList.add('hidden');
  }
}
