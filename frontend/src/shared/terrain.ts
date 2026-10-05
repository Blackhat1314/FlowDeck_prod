// "Liquidity terrain": a simulated order book drawn as a 3D landscape. Price levels run front to back, time runs
// left to right, and the height and colour of the ground is the size resting at that price. Walls build, get pulled
// or eaten, the price threads through as a glowing line and trades pop as bubbles.
// It is an illustration of what the dashboard shows, not market data. Deterministic for a given seed, so the same
// code drives the landing page (real time) and the film (frame by frame).
import {
  AdditiveBlending, AmbientLight, BufferAttribute, BufferGeometry, Color, DataTexture, DirectionalLight, DoubleSide,
  DynamicDrawUsage, InstancedMesh, LinearFilter, Mesh, MeshBasicMaterial, MeshStandardMaterial, Object3D,
  PerspectiveCamera, PlaneGeometry, RedFormat, RepeatWrapping, RGBAFormat, Scene, ShaderMaterial, SphereGeometry,
  UnsignedByteType, Vector3, WebGLRenderer,
} from 'three'

// cold -> hot. Brighter and more saturated than the dashboard so it reads at a distance.
export const RAMP: [number, [number, number, number]][] = [
  [0.0, [8, 12, 26]],
  [0.14, [14, 32, 74]],
  [0.3, [24, 74, 170]],
  [0.44, [44, 140, 236]],
  [0.56, [86, 214, 255]],
  [0.64, [210, 236, 240]],
  [0.72, [255, 214, 92]],
  [0.84, [255, 146, 46]],
  [1.0, [255, 58, 52]],
]

function rampTexture() {
  const data = new Uint8Array(256 * 4)
  for (let i = 0; i < 256; i++) {
    const x = i / 255
    let k = 0
    while (k < RAMP.length - 2 && x > RAMP[k + 1][0]) k++
    const [x0, c0] = RAMP[k]
    const [x1, c1] = RAMP[k + 1]
    const f = Math.min(1, Math.max(0, (x - x0) / (x1 - x0)))
    for (let j = 0; j < 3; j++) data[i * 4 + j] = Math.round(c0[j] + (c1[j] - c0[j]) * f)
    data[i * 4 + 3] = 255
  }
  const t = new DataTexture(data, 256, 1, RGBAFormat, UnsignedByteType)
  t.magFilter = LinearFilter
  t.minFilter = LinearFilter
  t.needsUpdate = true
  return t
}

function mulberry(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Wall { row: number; size: number; target: number; age: number; fate: 'hold' | 'pull' | 'eat'; gone: boolean }
export interface Trade { step: number; row: number; size: number; buy: boolean }

/** The order book simulation: one column per step, R price rows. */
export class BookSim {
  C: number
  R: number
  data: Uint8Array
  rowLiq: Float32Array
  price: Float32Array // price row per column (ring, same index as data)
  head = 0
  steps = 0
  mid: number
  vel = 0
  walls: Wall[] = []
  trades: Trade[] = []
  rnd: () => number
  noise: Float32Array

  constructor(C: number, R: number, seed = 11) {
    this.C = C
    this.R = R
    this.data = new Uint8Array(C * R)
    this.rowLiq = new Float32Array(R)
    this.price = new Float32Array(C)
    this.mid = R * 0.5
    this.rnd = mulberry(seed)
    this.noise = new Float32Array(R)
    for (let r = 0; r < R; r++) this.noise[r] = this.rnd()
    for (let i = 0; i < 7; i++) this.spawn(true)
    for (let i = 0; i < C; i++) this.step()
  }

  gauss() {
    return (this.rnd() + this.rnd() + this.rnd() - 1.5) * 1.15
  }

  spawn(initial = false) {
    const side = this.rnd() < 0.5 ? -1 : 1
    const dist = 4 + this.rnd() * this.R * 0.36
    const row = Math.round(this.mid + side * dist)
    if (row < 2 || row > this.R - 3) return
    if (this.walls.some((w) => !w.gone && Math.abs(w.row - row) < 3)) return
    const big = this.rnd()
    const target = 0.3 + big * big * 0.66
    const f = this.rnd()
    this.walls.push({ row, size: initial ? target : 0, target, age: 0, fate: f < 0.42 ? 'hold' : f < 0.72 ? 'pull' : 'eat', gone: false })
  }

  step() {
    const { R } = this
    // price: momentum random walk, pulled gently to the middle of the window, bounced by walls that hold
    this.vel = this.vel * 0.9 + this.gauss() * 0.09 + (R * 0.5 - this.mid) * 0.0016
    for (const w of this.walls) {
      if (w.gone || w.fate !== 'hold' || w.size < 0.4) continue
      const d = w.row - this.mid
      if (Math.abs(d) < 2.2 && Math.sign(d) === Math.sign(this.vel)) this.vel = -this.vel * 0.6
    }
    this.mid = Math.min(R - 6, Math.max(5, this.mid + this.vel))

    // walls: build up, then hold, get pulled as price approaches, or get eaten when price trades into them
    for (const w of this.walls) {
      if (w.gone) continue
      w.age++
      const d = Math.abs(w.row - this.mid)
      if (w.fate === 'pull' && d < 6 && w.age > 30) w.target = 0
      if (w.fate === 'eat' && d < 1.6) {
        w.target = 0
        w.size *= 0.9
        if (this.rnd() < 0.7) this.trades.push({ step: this.steps, row: w.row, size: 0.5 + this.rnd() * 1.6, buy: w.row > this.mid })
      }
      w.size += (w.target - w.size) * (w.target === 0 && w.fate === 'pull' ? 0.35 : 0.06)
      if (w.target === 0 && w.size < 0.02) w.gone = true
      if (w.age > 260 && this.rnd() < 0.006) w.target = 0
    }
    this.walls = this.walls.filter((w) => !w.gone)
    if (this.walls.length < 10 && this.rnd() < 0.08) this.spawn()

    // a new column of resting liquidity
    const col = this.head = (this.head + 1) % this.C
    this.steps++
    const t = this.steps
    for (let r = 0; r < R; r++) {
      const d = Math.abs(r - this.mid)
      let target = 0.05 + 0.15 * Math.min(1, d / (R * 0.45)) + 0.05 * Math.sin(r * 0.9 + this.noise[r] * 6 + t * 0.004)
      target += 0.06 * (this.noise[(r * 7 + (t >> 6)) % R] - 0.5)
      for (const w of this.walls) {
        const k = Math.abs(w.row - r)
        if (k < 2.5) target += w.size * (k < 0.5 ? 1 : k < 1.5 ? 0.42 : 0.12)
      }
      target *= Math.min(1, Math.max(0, (d - 0.6) / 2.2)) // the spread is empty
      const v = this.rowLiq[r] = this.rowLiq[r] * 0.82 + target * 0.18
      this.data[r * this.C + col] = Math.max(0, Math.min(255, Math.round((v + (this.rnd() - 0.5) * 0.025) * 255)))
    }
    this.price[col] = this.mid

    // market orders around the price; some are big enough to draw as bubbles
    const n = this.rnd() < 0.35 ? 1 : 0
    for (let i = 0; i < n; i++) {
      const s = Math.pow(this.rnd(), 4) * 2.6 + 0.15
      this.trades.push({ step: t, row: this.mid + (this.rnd() - 0.5) * 1.2, size: s, buy: this.vel + this.gauss() * 0.05 > 0 })
    }
    while (this.trades.length && this.trades[0].step < t - this.C + 4) this.trades.shift()
  }

  /** Liquidity 0..1 at a column (0 = newest, counting back) and fractional row. */
  at(back: number, row: number) {
    const c = (((this.head - back) % this.C) + this.C) % this.C
    const r = Math.max(0, Math.min(this.R - 1, Math.round(row)))
    return this.data[r * this.C + c] / 255
  }
}

const VERT = /* glsl */ `
uniform sampler2D uTex;
uniform float uHead, uFrac, uC, uR, uHeight;
varying float vV;
varying vec2 vUv;
varying vec3 vN;
varying float vDepth;
float lv(vec2 uv) {
  float s = (uHead + 3.0 + uv.x * (uC - 4.0) + uFrac + 0.5) / uC;
  float t = (uv.y * (uR - 1.0) + 0.5) / uR;
  return texture2D(uTex, vec2(s, t)).r;
}
float hgt(float v) { return pow(v, 1.7) * uHeight; }
void main() {
  vUv = uv;
  float v = lv(uv);
  vV = v;
  vec3 p = position;
  p.z += hgt(v);                       // plane is in XY before the mesh is rotated flat
  float dx = 1.0 / (uC - 4.0), dy = 1.0 / (uR - 1.0);
  float hx = hgt(lv(uv + vec2(dx, 0.0))) - hgt(lv(uv - vec2(dx, 0.0)));
  float hy = hgt(lv(uv + vec2(0.0, dy))) - hgt(lv(uv - vec2(0.0, dy)));
  vN = normalize(mat3(modelMatrix) * normalize(vec3(-hx / (2.0 * dx * WIDTH), -hy / (2.0 * dy * DEPTH), 1.0)));
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}`

const FRAG = /* glsl */ `
uniform sampler2D uRamp;
uniform float uR, uFadeNear, uFadeFar, uGlow, uReveal, uOpacity;
varying float vV;
varying vec2 vUv;
varying vec3 vN;
varying float vDepth;
void main() {
  vec3 n = normalize(vN);
  vec3 L = normalize(vec3(0.35, 0.9, 0.4));
  float diff = clamp(dot(n, L), 0.0, 1.0);
  float x = clamp(vV * 1.08, 0.0, 1.0);
  vec3 c = texture2D(uRamp, vec2(x, 0.5)).rgb;
  float f = fract(vUv.y * (uR - 1.0));
  float rowLine = mix(0.62, 1.0, smoothstep(0.0, 0.14, f) * smoothstep(1.0, 0.86, f));
  vec3 col = c * (0.38 + 0.72 * diff) * rowLine + c * smoothstep(0.55, 0.95, x) * uGlow;
  float edge = smoothstep(0.0, 0.22, vUv.x) * smoothstep(0.0, 0.08, vUv.y) * smoothstep(1.0, 0.92, vUv.y);
  float fade = 1.0 - smoothstep(uFadeNear, uFadeFar, vDepth);
  // reveal sweep (film): visible behind the front, with a bright seam at the front
  float rv = 1.0 - smoothstep(uReveal - 0.015, uReveal, vUv.x);
  float seam = (1.0 - smoothstep(0.0, 0.03, abs(vUv.x - uReveal))) * step(uReveal, 0.999);
  col += vec3(0.55, 0.85, 1.0) * seam * 1.4;
  gl_FragColor = vec4(col, max(rv, seam) * edge * fade * uOpacity);
}`

export interface TerrainOptions {
  cols?: number
  rows?: number
  seed?: number
  width?: number
  depth?: number
  height?: number
  stepsPerSecond?: number
  pixelRatio?: number
  antialias?: boolean
  preserveDrawingBuffer?: boolean
}

/** Renders a BookSim as a 3D landscape into a canvas. Drive it with update(dt) + render(). */
export class Terrain {
  sim: BookSim
  renderer: WebGLRenderer
  scene = new Scene()
  camera: PerspectiveCamera
  mesh: Mesh
  mat: ShaderMaterial
  tex: DataTexture
  W: number
  D: number
  H: number
  sps: number
  acc = 0
  line: Mesh
  glow: Mesh
  lineGeo: BufferGeometry
  bubbles: InstancedMesh
  dummy = new Object3D()
  colBuy = new Color('#2ee6a0')
  colSell = new Color('#ff4d6a')

  constructor(canvas: HTMLCanvasElement, o: TerrainOptions = {}) {
    const C = o.cols ?? 200
    const R = o.rows ?? 96
    this.W = o.width ?? 44
    this.D = o.depth ?? 24
    this.H = o.height ?? 1.7
    this.sps = o.stepsPerSecond ?? 14
    this.sim = new BookSim(C, R, o.seed ?? 11)
    this.renderer = new WebGLRenderer({ canvas, antialias: o.antialias ?? true, alpha: true, preserveDrawingBuffer: o.preserveDrawingBuffer ?? false, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(o.pixelRatio ?? Math.min(window.devicePixelRatio || 1, 1.75))
    this.renderer.setClearColor(0x000000, 0)
    this.camera = new PerspectiveCamera(34, 1, 0.1, 200)

    this.tex = new DataTexture(this.sim.data, C, R, RedFormat, UnsignedByteType)
    this.tex.wrapS = RepeatWrapping
    this.tex.magFilter = LinearFilter
    this.tex.minFilter = LinearFilter
    this.tex.needsUpdate = true

    const geo = new PlaneGeometry(this.W, this.D, C - 4, R - 1)
    this.mat = new ShaderMaterial({
      vertexShader: VERT.replace('WIDTH', this.W.toFixed(2)).replace('DEPTH', this.D.toFixed(2)),
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: true,
      side: DoubleSide,
      uniforms: {
        uTex: { value: this.tex }, uRamp: { value: rampTexture() },
        uHead: { value: 0 }, uFrac: { value: 0 }, uC: { value: C }, uR: { value: R }, uHeight: { value: this.H },
        uFadeNear: { value: 30 }, uFadeFar: { value: 70 }, uGlow: { value: 0.55 }, uReveal: { value: 1.1 }, uOpacity: { value: 1 },
      },
    })
    this.mesh = new Mesh(geo, this.mat)
    this.mesh.rotation.x = -Math.PI / 2 // XY plane -> ground; +y of the plane (price up) points away from the camera
    this.scene.add(this.mesh)

    // price line: a flat ribbon plus a wider additive glow
    const n = C - 3
    this.lineGeo = new BufferGeometry()
    const pos = new Float32Array(n * 2 * 3)
    const idx: number[] = []
    for (let i = 0; i < n - 1; i++) {
      const a = i * 2
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
    }
    this.lineGeo.setAttribute('position', new BufferAttribute(pos, 3).setUsage(DynamicDrawUsage))
    this.lineGeo.setIndex(idx)
    this.line = new Mesh(this.lineGeo, new MeshBasicMaterial({ color: '#f4fbff', side: DoubleSide }))
    const glowGeo = this.lineGeo.clone()
    this.glow = new Mesh(glowGeo, new MeshBasicMaterial({ color: '#56d6ff', transparent: true, opacity: 0.28, blending: AdditiveBlending, depthWrite: false, side: DoubleSide }))
    this.scene.add(this.glow, this.line)

    this.bubbles = new InstancedMesh(new SphereGeometry(1, 20, 14), new MeshStandardMaterial({ roughness: 0.32, metalness: 0.05, emissive: '#000000' }), 160)
    this.bubbles.instanceMatrix.setUsage(DynamicDrawUsage)
    this.bubbles.count = 0
    this.scene.add(this.bubbles)
    this.scene.add(new AmbientLight('#7d92c9', 1.1))
    const sun = new DirectionalLight('#ffffff', 2.4)
    sun.position.set(6, 14, 10)
    this.scene.add(sun)

    this.camera.position.set(10, 22, 30)
    this.camera.lookAt(new Vector3(2, 0, -2))
    this.syncUniforms()
    this.rebuildOverlays()
  }

  /** World x of a column `back` steps behind the newest, including the sub-step scroll. */
  xOf(back: number) {
    const n = this.sim.C - 3
    const i = n - back - this.frac() // vertex index from the old edge; back = 1 sits on the front edge at frac 0
    return -this.W / 2 + (i / (n - 1)) * this.W
  }
  /** World z of a price row (row 0 at the front edge). */
  zOf(row: number) {
    return this.D / 2 - (row / (this.sim.R - 1)) * this.D
  }
  heightAt(back: number, row: number) {
    return Math.pow(this.sim.at(back, row), 1.7) * this.H
  }
  frac() {
    return Math.min(0.999, this.acc * this.sps)
  }

  syncUniforms() {
    const u = this.mat.uniforms
    u.uHead.value = this.sim.head
    u.uFrac.value = this.frac()
  }

  rebuildOverlays() {
    const s = this.sim
    const n = s.C - 3
    const pos = this.lineGeo.getAttribute('position') as BufferAttribute
    const gpos = this.glow.geometry.getAttribute('position') as BufferAttribute
    const w = 0.07
    const gw = 0.34
    for (let i = 0; i < n; i++) {
      const back = n - i
      const c = (((s.head - back) % s.C) + s.C) % s.C
      const row = s.price[c]
      const x = this.xOf(back)
      const z = this.zOf(row)
      const y = Math.max(this.heightAt(back, row), 0.05) + 0.12
      pos.setXYZ(i * 2, x, y, z - w)
      pos.setXYZ(i * 2 + 1, x, y, z + w)
      gpos.setXYZ(i * 2, x, y - 0.02, z - gw)
      gpos.setXYZ(i * 2 + 1, x, y - 0.02, z + gw)
    }
    pos.needsUpdate = true
    gpos.needsUpdate = true

    let k = 0
    for (const t of s.trades) {
      const back = s.steps - t.step
      if (back < 1 || back > n - 2) continue
      if (t.size < 0.8 || k >= 160) continue
      const r = 0.1 + Math.cbrt(t.size) * 0.24
      this.dummy.position.set(this.xOf(back), this.heightAt(back, t.row) + r * 0.9 + 0.1, this.zOf(t.row))
      const pop = Math.min(1, back / 4)
      this.dummy.scale.setScalar(r * (0.4 + 0.6 * pop))
      this.dummy.updateMatrix()
      this.bubbles.setMatrixAt(k, this.dummy.matrix)
      this.bubbles.setColorAt(k, t.buy ? this.colBuy : this.colSell)
      k++
    }
    this.bubbles.count = k
    this.bubbles.instanceMatrix.needsUpdate = true
    if (this.bubbles.instanceColor) this.bubbles.instanceColor.needsUpdate = true
  }

  update(dt: number) {
    this.acc += dt
    const stepDt = 1 / this.sps
    let stepped = false
    while (this.acc >= stepDt) {
      this.acc -= stepDt
      this.sim.step()
      stepped = true
    }
    if (stepped) this.tex.needsUpdate = true
    this.syncUniforms()
    this.rebuildOverlays()
  }

  setSize(w: number, h: number) {
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  render() {
    this.renderer.render(this.scene, this.camera)
  }

  dispose() {
    this.renderer.dispose()
  }
}

/** Landing-page wrapper: sizes to its canvas, animates while visible, follows the pointer a little. */
export function mountTerrain(canvas: HTMLCanvasElement, o: TerrainOptions & { still?: boolean; cam?: number[]; look?: number[] } = {}) {
  let t: Terrain
  try {
    t = new Terrain(canvas, o)
  } catch {
    return null // no WebGL: the CSS background stays
  }
  const look = new Vector3(o.look?.[0] ?? 2, o.look?.[1] ?? 0, o.look?.[2] ?? -2)
  const base = new Vector3(o.cam?.[0] ?? 10, o.cam?.[1] ?? 22, o.cam?.[2] ?? 30)
  let px = 0
  let py = 0
  let tx = 0
  let ty = 0
  let last = performance.now()
  let raf = 0
  let visible = true
  const start = performance.now()
  const resize = () => {
    const r = canvas.getBoundingClientRect()
    t.setSize(Math.max(1, Math.round(r.width)), Math.max(1, Math.round(r.height)))
    // keep the landscape filling narrow screens
    const a = r.width / Math.max(1, r.height)
    t.camera.fov = a < 0.8 ? 52 : a < 1.3 ? 42 : 34
    t.camera.updateProjectionMatrix()
  }
  const place = (now: number) => {
    const s = (now - start) / 1000
    px += (tx - px) * 0.04
    py += (ty - py) * 0.04
    t.camera.position.set(base.x + Math.sin(s * 0.07) * 2.2 + px * 2.4, base.y + Math.sin(s * 0.11) * 0.6 - py * 1.4, base.z + Math.cos(s * 0.07) * 1.4)
    t.camera.lookAt(look)
  }
  const frame = (now: number) => {
    raf = 0
    if (!visible || document.hidden) return
    const dt = Math.min(0.05, (now - last) / 1000)
    last = now
    t.update(dt)
    place(now)
    t.render()
    raf = requestAnimationFrame(frame)
  }
  const kick = () => {
    if (!raf && visible && !document.hidden && !o.still) {
      last = performance.now()
      raf = requestAnimationFrame(frame)
    }
  }
  new ResizeObserver(() => { resize(); if (o.still) { place(performance.now()); t.render() } }).observe(canvas)
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; kick() }).observe(canvas)
  document.addEventListener('visibilitychange', kick)
  addEventListener('pointermove', (e) => {
    tx = e.clientX / innerWidth - 0.5
    ty = e.clientY / innerHeight - 0.5
  }, { passive: true })
  resize()
  place(performance.now())
  t.render()
  kick()
  return t
}
