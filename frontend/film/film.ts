// Flowdeck film: a 60-second, frame-exact motion piece rendered in the browser and captured frame by frame.
// window.renderFrame(n) draws frame n (30 fps). Everything is a pure function of time, except the order-book
// simulation, which steps forward one frame at a time (and is rebuilt from scratch on a backwards seek).
import '@fontsource-variable/big-shoulders-display' // display: tall condensed caps; the weight axis is animated
import '@fontsource-variable/geist' // supporting text, as on the website
import '@fontsource-variable/bricolage-grotesque' // the Flowdeck wordmark, as on the website
import {
  AdditiveBlending, BoxGeometry, BufferAttribute, BufferGeometry, Color, DataTexture, DoubleSide, Group,
  LinearMipmapLinearFilter, LinearFilter, Mesh, MeshBasicMaterial, MeshStandardMaterial,
  PlaneGeometry, Points, RingGeometry, RGBAFormat, ShaderMaterial, Texture, TextureLoader, Vector3,
} from 'three'
import { BookSim, Terrain } from '../src/shared/terrain'
import cuesJson from './cues.json'

const W = 1920
const H = 1080
const FPS = 30
const DUR = 60
const cues = cuesJson as { i: number; sec: string; text: string; start: number; end: number }[]
const cs = (i: number) => cues[i].start
const ce = (i: number) => cues[i].end

// ------------------------------------------------------------------------------------------- math
const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x))
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const range = (t: number, a: number, b: number) => clamp((t - a) / (b - a))
const ease = {
  outCubic: (x: number) => 1 - Math.pow(1 - x, 3),
  inOutCubic: (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
  outExpo: (x: number) => (x >= 1 ? 1 : 1 - Math.pow(2, -10 * x)),
  inExpo: (x: number) => (x <= 0 ? 0 : Math.pow(2, 10 * x - 10)),
  outBack: (x: number) => { const c1 = 1.5, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2) },
  inOutSine: (x: number) => -(Math.cos(Math.PI * x) - 1) / 2,
}
/** 0 before a, rises over [a, a+fi], 1 until b, falls over [b, b+fo]. */
const env = (t: number, a: number, b: number, fi = 0.4, fo = 0.4) =>
  Math.min(ease.inOutSine(range(t, a, a + fi)), 1 - ease.inOutSine(range(t, b, b + fo)))

/** Monotone cubic (Fritsch-Carlson) through keyframes: smooth, C1, never overshoots a hold. */
class Track {
  ts: number[]
  vs: number[][]
  ms: number[][]
  constructor(keys: [number, number[]][]) {
    keys.sort((a, b) => a[0] - b[0])
    this.ts = keys.map((k) => k[0])
    this.vs = keys.map((k) => k[1])
    const n = keys.length
    const dims = this.vs[0].length
    this.ms = this.vs.map(() => new Array(dims).fill(0))
    for (let c = 0; c < dims; c++) {
      const d: number[] = []
      for (let k = 0; k < n - 1; k++) d.push((this.vs[k + 1][c] - this.vs[k][c]) / (this.ts[k + 1] - this.ts[k]))
      this.ms[0][c] = 0
      this.ms[n - 1][c] = 0
      for (let k = 1; k < n - 1; k++) {
        if (d[k - 1] * d[k] <= 0) { this.ms[k][c] = 0; continue }
        const h0 = this.ts[k] - this.ts[k - 1]
        const h1 = this.ts[k + 1] - this.ts[k]
        this.ms[k][c] = (3 * (h0 + h1)) / ((2 * h1 + h0) / d[k - 1] + (h1 + 2 * h0) / d[k])
      }
    }
  }
  at(t: number): number[] {
    const { ts, vs, ms } = this
    if (t <= ts[0]) return vs[0].slice()
    if (t >= ts[ts.length - 1]) return vs[vs.length - 1].slice()
    let k = 0
    while (t > ts[k + 1]) k++
    const h = ts[k + 1] - ts[k]
    const s = (t - ts[k]) / h
    const h00 = 2 * s ** 3 - 3 * s ** 2 + 1, h10 = s ** 3 - 2 * s ** 2 + s, h01 = -2 * s ** 3 + 3 * s ** 2, h11 = s ** 3 - s ** 2
    return vs[k].map((v, c) => h00 * v + h10 * h * ms[k][c] + h01 * vs[k + 1][c] + h11 * h * ms[k + 1][c])
  }
}

// ------------------------------------------------------------------------------------------- 3D setup
const canvas = document.getElementById('gl') as HTMLCanvasElement
const T3 = new Terrain(canvas, { cols: 220, rows: 96, width: 70, depth: 26, height: 1.7, pixelRatio: 1, antialias: true, preserveDrawingBuffer: true, seed: 7, stepsPerSecond: 14 })
const renderer = T3.renderer
const scene = T3.scene
const camera = T3.camera
renderer.setClearColor('#04050a', 1)
renderer.setSize(W, H, false)
camera.fov = 38
camera.near = 0.1
camera.far = 700
camera.aspect = W / H
camera.updateProjectionMatrix()
const TU = T3.mat.uniforms
TU.uFadeNear.value = 70
TU.uFadeFar.value = 150

const terrain = new Group()
scene.remove(T3.mesh, T3.line, T3.glow, T3.bubbles)
terrain.add(T3.mesh, T3.line, T3.glow, T3.bubbles)
scene.add(terrain)
const lineMat = T3.line.material as MeshBasicMaterial
const glowMat = T3.glow.material as MeshBasicMaterial
const bubbleMat = T3.bubbles.material as MeshStandardMaterial
lineMat.transparent = true
bubbleMat.transparent = true

// --- S1: the dark book, a field of resting orders as points
const ptsGeo = new BufferGeometry()
{
  const pos: number[] = []
  const seed: number[] = []
  let s = 3
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647)
  for (let x = -35; x <= 35; x += 0.42) {
    for (let z = -13; z <= 13; z += 0.36) {
      pos.push(x + (rnd() - 0.5) * 0.08, 0.02, z)
      seed.push(rnd())
    }
  }
  ptsGeo.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
  ptsGeo.setAttribute('aSeed', new BufferAttribute(new Float32Array(seed), 1))
}
const ptsMat = new ShaderMaterial({
  transparent: true, depthWrite: false, blending: AdditiveBlending,
  uniforms: { uTime: { value: 0 }, uAlpha: { value: 1 }, uWake: { value: 0 } },
  vertexShader: /* glsl */ `
    attribute float aSeed; uniform float uTime, uWake; varying float vB; varying float vS;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      float tw = pow(0.5 + 0.5 * sin(uTime * (0.7 + aSeed * 2.3) + aSeed * 61.0), 6.0);
      float wake = 1.0 - smoothstep(uWake - 8.0, uWake, position.x + 35.0 + aSeed * 6.0);
      vB = (0.32 + 0.68 * tw) * wake;
      vS = aSeed;
      gl_PointSize = (1.8 + 4.0 * tw) * (30.0 / -mv.z);
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */ `
    uniform float uAlpha; varying float vB; varying float vS;
    void main() {
      vec2 p = gl_PointCoord - 0.5; float d = length(p);
      float a = smoothstep(0.5, 0.0, d);
      vec3 c = mix(vec3(0.16, 0.42, 1.0), vec3(0.34, 0.86, 1.0), vS);
      if (vS > 0.985) c = vec3(1.0, 0.72, 0.28);
      gl_FragColor = vec4(c * vB, a * vB * uAlpha);
    }`,
})
const pts = new Points(ptsGeo, ptsMat)
terrain.add(pts)

// --- S2: liquidity walls. A wall is a price level: a dense row of thin light strands (one per resting order),
// heat-coloured by size and rising in a wave. Each wall has a glowing skyline, beams over its iceberg orders and a
// reflection in the glossy floor. Pulled walls flash cold, drop away in a wave and leave a fading outline.
interface WallDef { z: number; x0: number; x1: number; h: number; built: number; pulled: number | null; seed: number }
const walls: WallDef[] = [
  { z: -12.0, x0: -17, x1: 34, h: 6.2, built: cs(1) - 0.14, pulled: null, seed: 1.3 },
  { z: -6.0, x0: -22, x1: 28, h: 4.6, built: cs(1) + 0.06, pulled: cs(2) + 0.1, seed: 2.9 },
  { z: -0.2, x0: -26, x1: 31, h: 5.2, built: cs(1) + 0.26, pulled: null, seed: 4.2 },
  { z: 5.4, x0: -21, x1: 22, h: 3.6, built: cs(1) + 0.46, pulled: cs(2) + 0.36, seed: 5.7 },
]
const PITCH = 0.5 // floor-pool sampling and sparks
const STRAND = 0.16 // one light strand per resting order
const MAXC = 128
const sstep = (a: number, b: number, x: number) => { const q = clamp((x - a) / (b - a)); return q * q * (3 - 2 * q) }
// size profile along a wall; the shader evaluates the same function per strand
const profile = (w: WallDef, x: number) =>
  clamp((0.56 + 0.25 * Math.sin(x * 0.19 + w.seed * 1.7) + 0.16 * Math.sin(x * 0.57 + w.seed * 4.1) + 0.06 * Math.sin(x * 1.63 + w.seed * 2.3))
    * sstep(0, 6, x - w.x0) * sstep(0, 2.5, w.x1 - x), 0.03, 1.45)
interface Col { w: number; k: number; x: number; p: number; tb: number; tc: number }
const cols: Col[] = []
walls.forEach((w, wi) => {
  const n = Math.floor((w.x1 - w.x0) / PITCH)
  for (let k = 0; k < n; k++) {
    const x = w.x0 + (k + 0.5) * PITCH
    const u = k / n
    cols.push({ w: wi, k, x, p: profile(w, x), tb: w.built + u * 0.62, tc: w.pulled == null ? Infinity : w.pulled + 0.12 + (1 - u) * 0.42 })
  }
})
const HEAT_GLSL = /* glsl */ `
  vec3 heat(float p) {
    vec3 c = mix(vec3(0.29, 0.06, 0.02), vec3(0.66, 0.19, 0.05), smoothstep(0.0, 0.3, p));
    c = mix(c, vec3(1.0, 0.42, 0.15), smoothstep(0.3, 0.55, p));
    c = mix(c, vec3(1.0, 0.71, 0.28), smoothstep(0.55, 0.8, p));
    c = mix(c, vec3(1.0, 0.89, 0.63), smoothstep(0.8, 1.05, p));
    return mix(c, vec3(1.0, 0.97, 0.93), smoothstep(1.05, 1.45, p));
  }`
// per-column live state for the floor pools: R height/4, G cold flash, B heat/1.5
const wallData = new Uint8Array(MAXC * 8 * 4)
const wallTex = new DataTexture(wallData, MAXC, 8, RGBAFormat)
wallTex.magFilter = LinearFilter
wallTex.minFilter = LinearFilter
wallTex.needsUpdate = true

const STRAND_FRAG = /* glsl */ `
  uniform float uTime, uX0, uX1, uH, uSeed, uBuilt, uPulled, uUnseen, uSink, uOpacity;
  varying vec3 vW; varying float vDepth;
  ${HEAT_GLSL}
  float hash1(float n) { return fract(sin(n * 127.1 + 311.7) * 43758.5453); }
  float ss(float a, float b, float x) { float q = clamp((x - a) / (b - a), 0.0, 1.0); return q * q * (3.0 - 2.0 * q); }
  float prof(float x) {
    float p = 0.56 + 0.25 * sin(x * 0.19 + uSeed * 1.7) + 0.16 * sin(x * 0.57 + uSeed * 4.1) + 0.06 * sin(x * 1.63 + uSeed * 2.3);
    return clamp(p * ss(0.0, 6.0, x - uX0) * ss(0.0, 2.5, uX1 - x), 0.03, 1.45);
  }
  void main() {
    float yy = abs(vW.y);
    bool refl = vW.y < 0.0;
    float u = (vW.x - uX0) / ${STRAND.toFixed(3)};
    float id = floor(u);
    float xc = uX0 + (id + 0.5) * ${STRAND.toFixed(3)};
    float u01 = (xc - uX0) / (uX1 - uX0);
    if (u01 < 0.0 || u01 > 1.0) discard;
    float j = hash1(id + uSeed * 91.0);
    float ice = step(0.982, hash1(id * 1.37 + uSeed * 13.0)) * step(0.5, prof(xc));
    float p = clamp(prof(xc) + (j - 0.5) * 0.09 + ice * 0.36, 0.0, 1.5);
    // build: each strand shoots up (ease-out-back) in a wave from the left
    float tb = uBuilt + u01 * 0.62 + j * 0.05;
    float r = clamp((uTime - tb) / 0.55, 0.0, 1.0);
    float rm = r - 1.0; // (pow() is undefined for negative bases in GLSL)
    float rise = max(0.0, 1.0 + 2.70158 * rm * rm * rm + 1.70158 * rm * rm) * step(0.0001, r);
    float fall = 1.0, flash = 0.0, ghost = 0.0;
    if (uPulled > 0.0) {
      float tc = uPulled + 0.12 + (1.0 - u01) * 0.42;
      float q = clamp((uTime - tc) / 0.24, 0.0, 1.0);
      fall = 1.0 - (q <= 0.0 ? 0.0 : pow(2.0, 10.0 * q - 10.0));
      flash = clamp((uTime - uPulled) / 0.12, 0.0, 1.0);
      ghost = ss(tc + 0.05, tc + 0.25, uTime) * (1.0 - ss(tc + 0.5, tc + 1.6, uTime));
    }
    float full = uH * p * uSink;
    float h = full * rise * fall;
    float on = step(0.015, h);
    // strand coverage, anti-aliased; far away the strands melt into an even glow
    float fu = abs(fract(u) - 0.5);
    float px = fwidth(u);
    float cov = 1.0 - smoothstep(0.26 - px, 0.26 + px, fu);
    cov = mix(cov, 0.52, ss(0.3, 0.7, px));
    float fill = 0.22 + 0.78 * cov; // a faint glass panel between the strands
    float y01 = clamp(yy / max(h, 1e-3), 0.0, 1.0);
    float inside = step(yy, h);
    float levels = 0.82 + 0.18 * ss(0.3, 0.5, abs(fract(yy * 3.0) - 0.5)); // stacked price levels
    float body = inside * (0.06 + 0.94 * pow(y01, 2.4)) * levels;
    float head = 1.0 + 2.6 * (1.0 - ss(0.0, 0.9, r)) * step(0.0001, r); // white-hot tip while rising
    float edge = exp(-abs(yy - h) * 26.0) * on * head;
    float halo = exp(-max(yy - h, 0.0) * 1.4) * (1.0 - inside) * on;
    vec3 cold = vec3(0.6, 0.92, 1.0);
    vec3 col = mix(heat(mix(0.1, p + 0.18, pow(y01, 1.3))), cold, flash * 0.85);
    vec3 cap = mix(heat(p + 0.5), vec3(0.88, 0.98, 1.0), flash);
    vec3 c = col * body * fill * 1.45 + cap * edge * (0.35 + 0.65 * cov) * 1.8 + mix(heat(max(p, 0.6)), cold, flash) * halo * 0.12;
    // iceberg orders throw a beam of light upward
    float beam = ice * on * (1.0 - inside) * exp(-max(yy - h, 0.0) * 0.85) * exp(-pow(fu / 0.4, 2.0));
    c += cap * beam * 0.6;
    // outline left behind by a pulled wall
    c += cold * exp(-abs(yy - full) * 34.0) * cov * ghost * 0.55;
    // "unseen": the colour drains out
    float g = dot(c, vec3(0.3, 0.5, 0.2));
    c = mix(c, vec3(0.32, 0.38, 0.54) * g * 1.1, uUnseen * 0.88);
    c *= exp(-max(vDepth - 28.0, 0.0) * 0.022);
    if (refl) c *= 0.2 * exp(-yy * 0.75);
    gl_FragColor = vec4(c, uOpacity);
  }`
const STRAND_VERT = /* glsl */ `varying vec3 vW; varying float vDepth;
  void main() { vec4 wp = modelMatrix * vec4(position, 1.0); vW = wp.xyz; vec4 mv = viewMatrix * wp; vDepth = -mv.z; gl_Position = projectionMatrix * mv; }`

const WALL_VERT = /* glsl */ `varying vec3 vW; void main() { vec4 wp = modelMatrix * vec4(position, 1.0); vW = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp; }`
const WALL_SAMPLE = /* glsl */ `
  uniform sampler2D uH; uniform float uRow, uX0, uN, uOpacity; varying vec3 vW;
  ${HEAT_GLSL}
  vec4 sampleWall() {
    float u = (vW.x - uX0) / ${PITCH.toFixed(2)} / ${MAXC.toFixed(1)};
    float inr = step(0.0, u) * step(u, uN / ${MAXC.toFixed(1)});
    vec4 s = texture2D(uH, vec2(u, uRow));
    return vec4(s.r * 4.0 * inr, s.g, s.b * 1.5, inr);
  }`
interface WallFx { strands: Mesh; sm: ShaderMaterial; floor: Mesh; fm: ShaderMaterial }
const wallFx: WallFx[] = walls.map((w, wi) => {
  const n = Math.floor((w.x1 - w.x0) / PITCH)
  const common = () => ({ uH: { value: wallTex }, uRow: { value: (wi + 0.5) / 8 }, uX0: { value: w.x0 }, uN: { value: n }, uOpacity: { value: 1 } })
  const sm = new ShaderMaterial({
    transparent: true, depthWrite: false, blending: AdditiveBlending, side: DoubleSide, vertexShader: STRAND_VERT, fragmentShader: STRAND_FRAG,
    uniforms: {
      uTime: { value: 0 }, uX0: { value: w.x0 }, uX1: { value: w.x1 }, uH: { value: w.h }, uSeed: { value: w.seed }, uBuilt: { value: w.built },
      uPulled: { value: w.pulled ?? -1 }, uUnseen: { value: 0 }, uSink: { value: 1 }, uOpacity: { value: 1 },
    },
  })
  const top = w.h * 1.5 + 4
  const bottom = -w.h * 1.6
  const strands = new Mesh(new PlaneGeometry(w.x1 - w.x0, top - bottom, 1, 1), sm)
  strands.position.set((w.x0 + w.x1) / 2, (top + bottom) / 2, w.z)
  strands.renderOrder = 2
  const fm = new ShaderMaterial({
    transparent: true, depthWrite: false, blending: AdditiveBlending, vertexShader: WALL_VERT,
    uniforms: { ...common(), uZ: { value: w.z }, uDraw: { value: 0 }, uLine: { value: 1 }, uCold: { value: 0 } },
    fragmentShader: /* glsl */ `${WALL_SAMPLE}
      uniform float uZ, uDraw, uLine, uCold;
      void main() {
        vec4 s = sampleWall();
        float dz = abs(vW.z - uZ);
        float pool = exp(-dz * 0.9) * s.x * 0.11;
        float span = uN * ${PITCH.toFixed(2)};
        float drawn = 1.0 - smoothstep(uX0 + uDraw * span - 1.5, uX0 + uDraw * span, vW.x);
        float fadeEnds = smoothstep(uX0 - 1.0, uX0 + 4.0, vW.x) * smoothstep(uX0 + span + 1.0, uX0 + span - 1.0, vW.x);
        float line = (exp(-dz * 26.0) * 0.9 + exp(-dz * 5.0) * 0.12) * drawn * fadeEnds * uLine;
        vec3 col = mix(heat(max(s.z, 0.75)), vec3(0.45, 0.88, 1.0), max(s.y, uCold));
        gl_FragColor = vec4(col, (pool + line) * uOpacity);
      }`,
  })
  const floor = new Mesh(new PlaneGeometry(w.x1 - w.x0 + 4, 8), fm)
  floor.rotation.x = -Math.PI / 2
  floor.position.set((w.x0 + w.x1) / 2, 0.035, w.z)
  terrain.add(strands, floor)
  return { strands, sm, floor, fm }
})

// sparks from pulled walls: pure function of time (spawn time per particle = its column's collapse time)
const sparkGeo = new BufferGeometry()
{
  const pos: number[] = [], vel: number[] = [], t0: number[] = [], life: number[] = [], seed: number[] = []
  let s = 19
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647)
  for (const c of cols) {
    const w = walls[c.w]
    if (w.pulled == null) continue
    const per = Math.round(3 + c.p * 7)
    for (let j = 0; j < per; j++) {
      const y01 = 0.55 + 0.45 * rnd()
      pos.push(c.x + (rnd() - 0.5) * 0.5, y01 * w.h * c.p, w.z + (rnd() - 0.5) * 0.3)
      vel.push((rnd() - 0.5) * 0.9 - 0.4, 0.9 + rnd() * 2.2, (rnd() - 0.5) * 0.9 + 0.3)
      t0.push(c.tc + y01 * 0.08 + rnd() * 0.05)
      life.push(0.9 + rnd() * 1.1)
      seed.push(rnd())
    }
  }
  sparkGeo.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
  sparkGeo.setAttribute('aVel', new BufferAttribute(new Float32Array(vel), 3))
  sparkGeo.setAttribute('aT0', new BufferAttribute(new Float32Array(t0), 1))
  sparkGeo.setAttribute('aLife', new BufferAttribute(new Float32Array(life), 1))
  sparkGeo.setAttribute('aSeed', new BufferAttribute(new Float32Array(seed), 1))
}
const sparkMat = new ShaderMaterial({
  transparent: true, depthWrite: false, blending: AdditiveBlending, uniforms: { uTime: { value: 0 } },
  vertexShader: /* glsl */ `
    uniform float uTime; attribute vec3 aVel; attribute float aT0, aLife, aSeed; varying float vA; varying float vS;
    void main() {
      float age = uTime - aT0; float a = max(age, 0.0); float k = clamp(age / aLife, 0.0, 1.0);
      vec3 p = position + aVel * (1.0 - exp(-2.2 * a)) / 2.2 + vec3(0.0, 0.45 * a * a, 0.0);
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      vA = (age < 0.0 || age > aLife) ? 0.0 : pow(1.0 - k, 1.5);
      vS = aSeed;
      gl_PointSize = (1.6 + 3.4 * aSeed) * (1.0 - 0.45 * k) * (34.0 / -mv.z);
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */ `
    varying float vA; varying float vS;
    void main() {
      float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.05, d);
      vec3 c = vS > 0.78 ? vec3(1.0, 0.72, 0.36) : mix(vec3(0.9, 0.98, 1.0), vec3(0.34, 0.84, 1.0), vS / 0.78);
      gl_FragColor = vec4(c, a * vA);
    }`,
})
const sparks = new Points(sparkGeo, sparkMat)
sparks.frustumCulled = false
terrain.add(sparks)

// --- screen cards (rounded, cover-fit, two textures that can cross-fade)
const loader = new TextureLoader()
const solid = (hex: string) => {
  const c = new Color(hex)
  const t = new DataTexture(new Uint8Array([c.r * 255, c.g * 255, c.b * 255, 255]), 1, 1, RGBAFormat)
  t.needsUpdate = true
  return t
}
const loading: Promise<unknown>[] = []
const tex = (name: string) => {
  const t = loader.load(`./assets/${name}.jpg`)
  t.anisotropy = renderer.capabilities.getMaxAnisotropy()
  t.minFilter = LinearMipmapLinearFilter
  t.magFilter = LinearFilter
  loading.push(new Promise((res, rej) => { const chk = () => (t.image && t.image.complete && t.image.naturalWidth ? res(null) : setTimeout(chk, 30)); chk(); setTimeout(() => rej(new Error('load ' + name)), 20000) }))
  return t
}
const TX = {
  dash: tex('dashboard'), fp: tex('footprint'), delta: tex('delta'), prof: tex('profile'), heat: tex('heatmap'), gamma: tex('gamma'),
  acc: tex('accuracy'), mobile: tex('mobile'), landing: tex('landing'), signup: tex('signup'), signup2: tex('signup_filled'), trades: tex('trades'),
}
const ASP: Record<string, number> = { dash: 1600 / 900, fp: 1256 / 804, delta: 1256 / 546, prof: 1256 / 804, heat: 1256 / 672, gamma: 1537 / 672, acc: 344 / 848, mobile: 780 / 1688, landing: 16 / 9, signup: 16 / 9, signup2: 16 / 9, trades: 2 }

const CARD_FRAG = /* glsl */ `
  uniform sampler2D mapA, mapB; uniform float uMix, uRadius, uOpacity, uDim, uAspA, uAspB, uRim; uniform vec2 uSize;
  varying vec2 vUv;
  vec2 cover(vec2 uv, float ac, float at) { if (ac > at) uv.y = (uv.y - 0.5) * (at / ac) + 0.5; else uv.x = (uv.x - 0.5) * (ac / at) + 0.5; return uv; }
  float sdRound(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
  void main() {
    float ac = uSize.x / uSize.y;
    vec3 a = texture2D(mapA, cover(vUv, ac, uAspA)).rgb;
    vec3 b = texture2D(mapB, cover(vUv, ac, uAspB)).rgb;
    vec3 col = mix(a, b, uMix) * uDim;
    vec2 p = (vUv - 0.5) * uSize;
    float d = sdRound(p, uSize * 0.5, uRadius);
    float aa = fwidth(d) * 1.2;
    float alpha = 1.0 - smoothstep(-aa, aa, d);
    float rim = 1.0 - smoothstep(0.0, aa * 2.0 + 0.03, abs(d + 0.025));
    col += vec3(0.55, 0.75, 1.0) * rim * uRim;
    gl_FragColor = vec4(col, alpha * uOpacity);
  }`
const CARD_VERT = /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`
const SHADOW_FRAG = /* glsl */ `
  uniform vec2 uSize; uniform float uRadius, uOpacity, uSoft; uniform vec3 uColor; varying vec2 vUv;
  float sdRound(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
  void main() { vec2 p = (vUv - 0.5) * (uSize + uSoft * 2.0); float d = sdRound(p, uSize * 0.5, uRadius);
    float a = 1.0 - smoothstep(-uSoft * 0.3, uSoft, d); gl_FragColor = vec4(uColor, a * uOpacity); }`

class Card {
  group = new Group()
  mesh: Mesh
  mat: ShaderMaterial
  shadow: Mesh
  smat: ShaderMaterial
  w: number
  h: number
  constructor(a: Texture, aspA: number, w: number, h: number, radius = 0.55, b?: Texture, aspB?: number) {
    this.w = w
    this.h = h
    this.mat = new ShaderMaterial({
      vertexShader: CARD_VERT, fragmentShader: CARD_FRAG, transparent: true, side: DoubleSide,
      uniforms: {
        mapA: { value: a }, mapB: { value: b ?? a }, uMix: { value: 0 }, uRadius: { value: radius }, uOpacity: { value: 1 }, uDim: { value: 1 },
        uAspA: { value: aspA }, uAspB: { value: aspB ?? aspA }, uRim: { value: 0.35 }, uSize: { value: [w, h] },
      },
    })
    this.mesh = new Mesh(new PlaneGeometry(1, 1), this.mat)
    this.smat = new ShaderMaterial({
      vertexShader: CARD_VERT, fragmentShader: SHADOW_FRAG, transparent: true, depthWrite: false,
      uniforms: { uSize: { value: [w, h] }, uRadius: { value: radius }, uOpacity: { value: 0.55 }, uSoft: { value: 2.2 }, uColor: { value: new Color('#000000') } },
    })
    this.shadow = new Mesh(new PlaneGeometry(1, 1), this.smat)
    this.shadow.position.set(0.4, -0.7, -0.35)
    this.shadow.renderOrder = -1
    this.group.add(this.shadow, this.mesh)
    this.size(w, h)
    scene.add(this.group)
  }
  size(w: number, h: number) {
    this.w = w
    this.h = h
    this.mesh.scale.set(w, h, 1)
    this.mat.uniforms.uSize.value = [w, h]
    const s = this.smat.uniforms.uSoft.value as number
    this.shadow.scale.set(w + s * 2, h + s * 2, 1)
    this.smat.uniforms.uSize.value = [w, h]
  }
  set opacity(o: number) {
    this.mat.uniforms.uOpacity.value = o
    this.smat.uniforms.uOpacity.value = o * 0.55
    this.group.visible = o > 0.002
  }
}

const dash = new Card(TX.dash, ASP.dash, 28, 15.75, 0.6)
const tools = [
  { key: 'fp', card: new Card(TX.fp, ASP.fp, 22, 14.08), x: 32 },
  { key: 'delta', card: new Card(TX.delta, ASP.delta, 27, 11.74), x: 58 },
  { key: 'prof', card: new Card(TX.prof, ASP.prof, 22, 14.08), x: 84 },
  { key: 'heat', card: new Card(TX.heat, ASP.heat, 25, 13.38), x: 110 },
  { key: 'gamma', card: new Card(TX.gamma, ASP.gamma, 29, 12.68), x: 138 },
]
tools.forEach((c) => c.card.group.position.set(c.x, 8, 0))
const accCard = new Card(TX.acc, ASP.acc, 6.2, 15.3, 0.45)
accCard.group.position.set(177, 8, -4)
accCard.group.rotation.y = -0.38

// accuracy ring
const ringBase = new Mesh(new RingGeometry(4.75, 5.05, 128), new MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.08, side: DoubleSide }))
const ringFill = new Mesh(new RingGeometry(4.7, 5.1, 128, 1, Math.PI / 2, 0.001), new MeshBasicMaterial({ color: '#ffb547', transparent: true, side: DoubleSide }))
const ringGlow = new Mesh(new RingGeometry(4.3, 5.6, 128, 1, Math.PI / 2, 0.001), new MeshBasicMaterial({ color: '#ffb547', transparent: true, opacity: 0.18, blending: AdditiveBlending, depthWrite: false, side: DoubleSide }))
const ring = new Group()
ring.add(ringBase, ringGlow, ringFill)
ringBase.position.z = -0.06 // keep the three rings off one plane: no z-fighting
ringGlow.position.z = -0.03
ringFill.renderOrder = 2
ring.position.set(164, 8, 0)
scene.add(ring)
let ringProg = -1
const setRing = (p: number) => {
  const q = Math.round(p * 400) / 400
  if (q === ringProg) return
  ringProg = q
  const len = Math.max(0.001, q * Math.PI * 2)
  ringFill.geometry.dispose()
  ringGlow.geometry.dispose()
  ringFill.geometry = new RingGeometry(4.7, 5.1, 128, 1, Math.PI / 2, -len)
  ringGlow.geometry = new RingGeometry(4.3, 5.6, 128, 1, Math.PI / 2, -len)
}

// laptop + phone
const laptop = new Group()
laptop.position.set(205, 0, 0)
scene.add(laptop)
const alu = new MeshStandardMaterial({ color: '#1b2234', metalness: 0.65, roughness: 0.32, transparent: true })
const base = new Mesh(new BoxGeometry(18, 0.42, 11.8), alu)
base.position.set(0, 0.21, 5.9)
const deck = new Mesh(new BoxGeometry(16.6, 0.02, 7.2), new MeshStandardMaterial({ color: '#0d1220', roughness: 0.8, transparent: true }))
deck.position.set(0, 0.43, 4.6)
const pad = new Mesh(new BoxGeometry(5.6, 0.02, 3.3), new MeshStandardMaterial({ color: '#232c42', roughness: 0.5, metalness: 0.3, transparent: true }))
pad.position.set(0, 0.43, 9.6)
const lid = new Group()
lid.position.set(0, 0.42, 0)
lid.rotation.x = -0.16
const lidBack = new Mesh(new BoxGeometry(18, 10.9, 0.3), alu)
lidBack.position.set(0, 5.45, -0.16)
const lapScreen = new Card(TX.dash, ASP.dash, 16.8, 9.45, 0.25)
scene.remove(lapScreen.group)
lapScreen.group.position.set(0, 5.45, 0.02)
lapScreen.shadow.visible = false
lid.add(lidBack, lapScreen.group)
laptop.add(base, deck, pad, lid)
const floorMat = new ShaderMaterial({
  transparent: true, depthWrite: false, blending: AdditiveBlending, uniforms: { uOpacity: { value: 1 } },
  vertexShader: CARD_VERT,
  fragmentShader: /* glsl */ `uniform float uOpacity; varying vec2 vUv; void main() { float d = length(vUv - 0.5) * 2.0;
    vec3 c = mix(vec3(0.18, 0.48, 1.0), vec3(1.0, 0.6, 0.2), smoothstep(0.0, 1.0, vUv.x)); gl_FragColor = vec4(c, (1.0 - smoothstep(0.0, 1.0, d)) * 0.22 * uOpacity); }`,
})
const floor = new Mesh(new PlaneGeometry(60, 40), floorMat)
floor.rotation.x = -Math.PI / 2
floor.position.set(205, 0.01, 4)
scene.add(floor)
const phone = new Card(TX.dash, ASP.dash, 16.8, 9.45, 0.25, TX.mobile, ASP.mobile)
const bezel = new Card(solid('#0b0f1a'), 1, 7, 14, 1.0)
bezel.mat.uniforms.uRim.value = 0.6

// trial flow
const landingCard = new Card(TX.landing, ASP.landing, 18, 10.125, 0.4)
landingCard.group.position.set(250.5, 8, 0)
const signupCard = new Card(TX.signup, ASP.signup, 18, 10.125, 0.4, TX.signup2, ASP.signup2)
signupCard.group.position.set(250.5, 8, -20)
const dash2 = new Card(TX.dash, ASP.dash, 18, 10.125, 0.4)
dash2.group.position.set(250.5, 8, -40)

// floating dust for depth on every camera move
const dustGeo = new BufferGeometry()
{
  const pos: number[] = []
  const col: number[] = []
  let s = 11
  const rnd = () => ((s = (s * 48271) % 2147483647) / 2147483647)
  for (let i = 0; i < 1800; i++) {
    pos.push(-50 + rnd() * 320, -6 + rnd() * 34, -70 + rnd() * 95)
    col.push(rnd())
  }
  dustGeo.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
  dustGeo.setAttribute('aSeed', new BufferAttribute(new Float32Array(col), 1))
}
const dustMat = new ShaderMaterial({
  transparent: true, depthWrite: false, blending: AdditiveBlending, uniforms: { uTime: { value: 0 }, uAlpha: { value: 0 } },
  vertexShader: /* glsl */ `attribute float aSeed; uniform float uTime; varying float vS;
    void main() { vec3 p = position; p.y += sin(uTime * 0.25 + aSeed * 30.0) * 0.6; p.x += cos(uTime * 0.18 + aSeed * 20.0) * 0.5;
      vec4 mv = modelViewMatrix * vec4(p, 1.0); vS = aSeed; gl_PointSize = (1.5 + aSeed * 3.5) * (40.0 / -mv.z); gl_Position = projectionMatrix * mv; }`,
  fragmentShader: /* glsl */ `uniform float uAlpha; varying float vS; void main() { float d = length(gl_PointCoord - 0.5);
    vec3 c = vS > 0.8 ? vec3(1.0, 0.7, 0.35) : vec3(0.4, 0.75, 1.0); gl_FragColor = vec4(c, smoothstep(0.5, 0.0, d) * 0.35 * uAlpha); }`,
})
scene.add(new Points(dustGeo, dustMat))

// ------------------------------------------------------------------------------------------- camera path
const K = (t: number, p: number[], l: number[]): [number, number[]] => [t, [...p, ...l]]
const cam = new Track([
  K(0, [-36, 2.4, 10], [-18, 0.2, -1]),
  K(cs(1) - 0.3, [-31, 1.2, 13.5], [-6, 3.9, -3]),
  K(cs(2) + 0.2, [-26.5, 1.4, 15.5], [-1, 3.9, -3.5]),
  K(cs(3), [-21, 3.2, 20], [2, 2.6, -3]),
  K(cs(4), [-5, 10, 22], [1, 1, -3]),
  K(cs(5), [5, 12, 25], [1, 0.5, -4]),
  K(16.2, [13, 6.5, 15], [3, 0, -2]),
  K(17.5, [3, 21, 8], [0, 0, 0]),
  K(18.2, [0, 29, 0.8], [0, 0.4, 0]),
  K(cs(6), [0, 8.4, 26], [0, 8, 0]),
  K(cs(6) + 1.55, [-5.4, 10.3, 10.5], [-6.8, 10.9, 0]),
  K(cs(7) - 0.1, [-5.0, 10.2, 9.8], [-6.6, 10.8, 0]),
  K(cs(7) + 0.2, [32, 8, 20], [32, 8, 0]),
  K(cs(8) - 0.05, [33, 8.2, 18.6], [32.4, 8, 0]),
  K(cs(8) + 0.22, [58, 8, 20], [58, 8, 0]),
  K(cs(9) - 0.05, [59, 8.2, 18.8], [58.4, 8, 0]),
  K(cs(9) + 0.22, [84, 8, 20], [84, 8, 0]),
  K(cs(10) - 0.05, [85.4, 8.4, 17.8], [84.6, 8, 0]),
  K(cs(10) + 0.22, [110, 8, 20], [110, 8, 0]),
  K(cs(11) - 0.1, [110.8, 8.2, 17.6], [110.4, 8, 0]),
  K(cs(11) + 0.35, [138, 8, 22], [138, 8, 0]),
  K(cs(12) - 0.2, [139.6, 8.6, 18.4], [138.6, 8, 0]),
  K(cs(12) + 0.45, [164, 8, 30], [164, 8, 0]),
  K(cs(15) - 0.3, [165.5, 8.3, 27], [164.6, 8, 0]),
  K(cs(15) + 0.45, [190, 9.5, 27], [205, 5.9, 0]),
  K(cs(17), [221, 8.5, 22], [205, 5.6, 0]),
  K(cs(18) + 0.2, [205, 7.2, 24.5], [205, 5.6, 0]),
  K(cs(19) + 0.6, [209.5, 7.4, 24.5], [210.5, 6.8, 3]),
  K(cs(20) - 0.25, [210, 7.5, 23.5], [210.8, 6.9, 3]),
  K(cs(20) + 0.25, [246, 8, 22], [246, 8, 0]),
  K(cs(20) + 1.3, [249.9, 7.3, 4.0], [249.9, 7.3, -10]),
  K(cs(21) + 0.1, [246, 8, 2], [246, 8, -20]),
  K(cs(21) + 1.5, [246.1, 8, 0.5], [246.1, 8, -20]),
  K(cs(21) + 2.4, [246, 8, -18], [246, 8, -40]),
  K(cs(22) - 0.6, [246.1, 8.2, -19.5], [246.1, 8, -40]),
  K(cs(22) + 0.6, [245, 15, -4], [245, 1, -62]),
  K(DUR, [246, 17.5, -1], [245, 1, -62]),
])

// ------------------------------------------------------------------------------------------- kinetic type (DOM)
const ui = document.getElementById('ui')!
const css = document.createElement('style')
css.textContent = `
  #ui { font-family: 'Geist Variable', sans-serif; color: #edf1f8; }
  .kt { position: absolute; white-space: nowrap; will-change: transform, opacity, filter; }
  .kt .wd { display: inline-block; overflow: hidden; vertical-align: top; padding: 0 0.04em 0.24em; margin-bottom: -0.24em; }
  .kt .wd > span, .kt .ch { display: inline-block; }
  .disp { font-family: 'Big Shoulders Display Variable', sans-serif; text-transform: uppercase; letter-spacing: 0.005em; line-height: 0.9; }
  .disp .wd { padding: 0.06em 0.04em 0.36em; margin: -0.06em 0 -0.36em; }
  .brand { font-family: 'Bricolage Grotesque Variable', sans-serif; letter-spacing: -0.035em; line-height: 0.98; }
  .grad-hot { background: linear-gradient(92deg, #ffd65c, #ff922e 45%, #ff4d4a); -webkit-background-clip: text; background-clip: text; color: transparent; }
  .grad-cold { background: linear-gradient(92deg, #56d6ff, #2f7bff); -webkit-background-clip: text; background-clip: text; color: transparent; }
  .pill { padding: 14px 26px; border-radius: 999px; background: #ffb547; color: #1f1404; font-weight: 600; box-shadow: 0 10px 40px -10px rgba(255,160,50,.8); }
  .chip { padding: 12px 20px; border-radius: 999px; background: rgba(12,16,28,.78); border: 1px solid rgba(255,255,255,.18); font-weight: 500; }
  .fx { position: absolute; inset: 0; pointer-events: none; }
`
document.head.appendChild(css)

interface KT {
  t0: number; t1: number; text: string; x: number; y: number; size: number
  cls?: string; weight?: number; color?: string; align?: 'left' | 'center' | 'right'
  anim?: 'rise' | 'letters' | 'blur' | 'stamp' | 'fade'; stagger?: number; dur?: number; out?: number
  count?: [number, number, number, number] // from, to, t start, t end
  maxW?: number // widest the line may be (px)
  anchor?: () => [number, number]
  el?: HTMLElement; parts?: HTMLElement[]
}

const texts: KT[] = []
const kt = (o: KT) => { texts.push(o); return o }
const L = 150 // left margin

// A: the dark book
kt({ t0: cs(0) + 0.1, t1: ce(0) + 0.3, text: 'Every second,', x: L, y: 330, size: 46, weight: 500, color: '#9aa3b5', anim: 'rise' })
kt({ t0: cs(0) + 0.55, t1: ce(0) + 0.35, text: 'thousands of orders', x: L, y: 392, size: 200, weight: 850, cls: 'disp', anim: 'rise' })
kt({ t0: cs(0) + 1.7, t1: ce(0) + 0.4, text: 'wait in the dark.', x: L, y: 572, size: 200, weight: 850, cls: 'disp', color: '#3d465c', anim: 'rise' })
// B: walls
kt({ t0: cs(1) + 0.05, t1: cs(2) - 0.05, text: 'Built.', x: L, y: 56, size: 290, weight: 900, cls: 'disp grad-hot', anim: 'letters' })
kt({ t0: cs(2) + 0.05, t1: cs(3) - 0.05, text: 'Pulled.', x: W - L, y: 56, size: 290, weight: 900, cls: 'disp grad-cold', align: 'right', anim: 'letters' })
kt({ t0: cs(3) + 0.35, t1: ce(3) + 0.25, text: 'Unseen.', x: W / 2, y: 370, size: 330, weight: 900, cls: 'disp', color: '#5a6378', align: 'center', anim: 'blur' })
// C: logo (the wordmark is set as on the website)
const logoBars = document.createElement('div')
logoBars.className = 'kt'
logoBars.innerHTML = [['#2f7bff', 0.48], ['#56d6ff', 0.76], ['#ffb547', 1], ['#ff3a34', 0.68]].map(([c, h]) =>
  `<i style="display:inline-block;width:30px;margin-right:12px;border-radius:7px;background:${c};height:${(h as number) * 150}px;transform-origin:bottom;vertical-align:bottom"></i>`).join('')
ui.appendChild(logoBars)
const logoWord = kt({ t0: cs(4) + 0.35, t1: cs(5) - 0.1, text: 'Flowdeck', x: W / 2 + 70, y: 380, size: 200, weight: 800, cls: 'brand', align: 'center', anim: 'letters', stagger: 0.045 })
kt({ t0: cs(4) + 1.25, t1: cs(5) - 0.05, text: 'The order book, in light.', x: W / 2, y: 625, size: 46, weight: 500, color: '#9aa3b5', align: 'center', anim: 'blur' })
// D: heatmap
kt({ t0: cs(5) + 0.4, t1: 17.4, text: 'Live liquidity heatmap', x: L, y: 104, size: 116, weight: 850, cls: 'disp', anim: 'rise' })
kt({ t0: cs(5) + 0.8, t1: 17.4, text: 'Binance BTCUSDT perpetual, redrawn four times a second', x: L, y: 228, size: 30, weight: 500, color: '#c3cad8', anim: 'fade' })
kt({ t0: 15.6, t1: 17.4, text: 'Every resting order.', x: W - L, y: 818, size: 160, weight: 900, cls: 'disp', align: 'right', anim: 'rise' })
// E: tools (bottom-left word list)
const toolWord = (t0: number, t1: number, text: string, hot = false) =>
  kt({ t0, t1, text, x: L, y: 800, size: 210, weight: 900, cls: 'disp' + (hot ? ' grad-hot' : ''), anim: 'rise', out: 0.25 })
toolWord(cs(6) + 0.05, cs(7) + 0.05, 'Big trades')
toolWord(cs(7) + 0.2, cs(8) + 0.12, 'Footprint')
toolWord(cs(8) + 0.24, cs(9) + 0.12, 'Delta')
toolWord(cs(9) + 0.24, cs(10) + 0.12, 'Volume profile')
toolWord(cs(10) + 0.24, cs(11) + 0.2, 'Tick by tick.', true)
// F: gamma
kt({ t0: cs(11) + 0.4, t1: ce(11) + 0.3, text: 'Gamma levels', x: L, y: 800, size: 210, weight: 900, cls: 'disp', anim: 'rise', maxW: 860 })
;['Call wall', 'Put wall', 'Gamma flip', 'Max pain'].forEach((s, i) =>
  kt({ t0: cs(11) + 1.3 + i * 0.35, t1: ce(11) + 0.3, text: s, x: 1110 + i * 0 , y: 0, size: 30, cls: 'chip', anim: 'fade',
    anchor: () => [1060 + [0, 196, 376, 586][i], 905] }))
// G: accuracy
const ringScreen = () => project(new Vector3(164, 8, 0))
kt({ t0: cs(12) + 0.15, t1: cs(13) + 0.25, text: 'Checked against the exchange.', x: W / 2, y: 84, size: 130, weight: 900, cls: 'disp', align: 'center', anim: 'rise' })
kt({ t0: cs(13) - 0.1, t1: ce(14) + 0.7, text: '0', x: 0, y: 0, size: 300, weight: 900, cls: 'disp', align: 'center', anim: 'stamp',
  count: [0, 24, cs(13) + 0.1, cs(13) + 1.9], anchor: () => { const [x, y] = ringScreen(); return [x - 30, y - 140] } })
kt({ t0: cs(13) + 0.5, t1: ce(14) + 0.7, text: '/24', x: 0, y: 0, size: 120, weight: 800, cls: 'disp', color: '#677087', anim: 'fade', anchor: () => { const [x, y] = ringScreen(); return [x + 118, y - 2] } })
kt({ t0: cs(13) + 0.55, t1: ce(14) + 0.7, text: "minutes identical to Binance's own trade record", x: W / 2, y: 140, size: 40, weight: 500, color: '#c3cad8', align: 'center', anim: 'rise' })
;[['0 missing trades', -560, -120], ['0 wrong order-book sizes', 560, -150], ['64 ms from Binance', 600, 60]].forEach(([s, dx, dy], i) =>
  kt({ t0: cs(12) + 0.9 + i * 0.45, t1: ce(14) + 0.7, text: s as string, x: 0, y: 0, size: 30, cls: 'chip', align: 'center', anim: 'fade',
    anchor: () => { const [x, y] = ringScreen(); return [x + (dx as number), y + (dy as number)] } }))
kt({ t0: cs(14) - 0.05, t1: ce(14) + 0.7, text: 'Identical.', x: W / 2, y: 860, size: 190, weight: 900, cls: 'disp', color: '#2ee6a0', align: 'center', anim: 'stamp' })
// H: devices
kt({ t0: cs(15) + 0.05, t1: cs(17) + 0.2, text: 'No downloads.', x: L, y: 40, size: 118, weight: 900, cls: 'disp', anim: 'rise' })
kt({ t0: cs(16) + 0.05, t1: cs(17) + 0.3, text: 'No 8 GB installs.', x: L, y: 150, size: 118, weight: 900, cls: 'disp', color: '#677087', anim: 'rise' })
kt({ t0: cs(17) + 0.05, t1: ce(19) + 0.3, text: 'A browser tab.', x: L, y: 800, size: 210, weight: 900, cls: 'disp grad-hot', anim: 'rise' })
kt({ t0: cs(18) + 0.05, t1: cs(19) - 0.05, text: 'On your desk.', x: L, y: 96, size: 128, weight: 900, cls: 'disp', anim: 'rise', out: 0.2 })
kt({ t0: cs(19) + 0.05, t1: ce(19) + 0.3, text: 'In your pocket.', x: L, y: 96, size: 128, weight: 900, cls: 'disp', anim: 'rise' })
// I: trial
kt({ t0: cs(20) + 0.05, t1: cs(20) + 0.95, text: 'Start', x: 100, y: 300, size: 196, weight: 900, cls: 'disp', anim: 'rise', out: 0.3, maxW: 470 })
kt({ t0: cs(20) + 0.22, t1: cs(20) + 0.95, text: 'free.', x: 100, y: 478, size: 196, weight: 900, cls: 'disp', anim: 'rise', out: 0.3, maxW: 470 })
kt({ t0: cs(20) + 1.35, t1: ce(21) + 0.25, text: '3 days', x: 100, y: 300, size: 196, weight: 900, cls: 'disp grad-hot', anim: 'rise', maxW: 450 })
kt({ t0: cs(20) + 1.5, t1: ce(21) + 0.25, text: 'free', x: 100, y: 478, size: 196, weight: 900, cls: 'disp grad-hot', anim: 'rise', maxW: 450 })
kt({ t0: cs(21) + 0.3, t1: ce(21) + 0.25, text: 'then ₹499', x: 100, y: 680, size: 124, weight: 900, cls: 'disp', anim: 'rise', maxW: 450 })
kt({ t0: cs(21) + 0.55, t1: ce(21) + 0.25, text: 'a month', x: 100, y: 806, size: 58, weight: 700, cls: 'disp', color: '#9aa3b5', anim: 'rise' })
// J: end card
const endBars = document.createElement('div')
endBars.className = 'kt'
endBars.innerHTML = logoBars.innerHTML
ui.appendChild(endBars)
const endWord = kt({ t0: cs(22) - 0.05, t1: 99, text: 'Flowdeck', x: W / 2 + 60, y: 330, size: 180, weight: 800, cls: 'brand', align: 'center', anim: 'letters', stagger: 0.04 })
kt({ t0: cs(23) + 0.05, t1: 99, text: 'See where the size is sitting.', x: W / 2, y: 548, size: 104, weight: 850, cls: 'disp', align: 'center', anim: 'rise' })
kt({ t0: ce(23) + 0.3, t1: 99, text: 'Start your 3-day free trial', x: W / 2, y: 700, size: 32, cls: 'pill', align: 'center', anim: 'stamp' })
kt({ t0: ce(23) + 0.9, t1: 99, text: '₹499 / month after the trial. No card needed.', x: W / 2, y: 800, size: 26, weight: 500, color: '#9aa3b5', align: 'center', anim: 'fade' })

// overlays: scrims, vignette, grain, fade
const scrimL = document.createElement('div'); scrimL.className = 'fx'
scrimL.style.background = 'linear-gradient(90deg, rgba(4,5,10,.92) 0%, rgba(4,5,10,.7) 30%, rgba(4,5,10,0) 62%)'
const scrimB = document.createElement('div'); scrimB.className = 'fx'
scrimB.style.background = 'linear-gradient(0deg, rgba(4,5,10,.94) 0%, rgba(4,5,10,.6) 26%, rgba(4,5,10,0) 46%)'
const scrimT = document.createElement('div'); scrimT.className = 'fx'
scrimT.style.background = 'linear-gradient(180deg, rgba(4,5,10,.9) 0%, rgba(4,5,10,.5) 22%, rgba(4,5,10,0) 40%)'
const scrimC = document.createElement('div'); scrimC.className = 'fx'
scrimC.style.background = 'radial-gradient(48% 46% at 50% 46%, rgba(4,5,10,.82), rgba(4,5,10,.55) 55%, rgba(4,5,10,0) 100%)'
const vignette = document.createElement('div'); vignette.className = 'fx'
vignette.style.background = 'radial-gradient(120% 95% at 50% 50%, rgba(0,0,0,0) 55%, rgba(0,0,0,.55) 100%)'
const grain = document.createElement('canvas'); grain.width = 256; grain.height = 256
{
  const g = grain.getContext('2d')!
  const id = g.createImageData(256, 256)
  let s = 5
  for (let i = 0; i < id.data.length; i += 4) { s = (s * 16807) % 2147483647; const v = (s / 2147483647) * 255; id.data[i] = id.data[i + 1] = id.data[i + 2] = v; id.data[i + 3] = 255 }
  g.putImageData(id, 0, 0)
}
const grainLayer = document.createElement('div'); grainLayer.className = 'fx'
grainLayer.style.cssText += `inset:-256px;background-image:url(${grain.toDataURL()});opacity:.045;mix-blend-mode:overlay`
const black = document.createElement('div'); black.className = 'fx'; black.style.background = '#000'
const flash = document.createElement('div'); flash.className = 'fx'; flash.style.background = 'radial-gradient(60% 60% at 50% 50%, rgba(255,214,120,.55), rgba(255,140,40,0) 70%)'; flash.style.mixBlendMode = 'screen'
ui.prepend(scrimC, scrimL, scrimB, scrimT)
ui.append(vignette, grainLayer, flash, black)

function build(k: KT) {
  const el = document.createElement('div')
  el.className = 'kt ' + (k.cls ?? '')
  el.style.fontSize = `${k.size}px`
  if (k.weight) el.style.fontWeight = String(k.weight)
  if (k.color) el.style.color = k.color
  const parts: HTMLElement[] = []
  const anim = k.anim ?? 'rise'
  if (anim === 'rise') {
    k.text.split(' ').forEach((w, i) => {
      const wd = document.createElement('span'); wd.className = 'wd'
      const inner = document.createElement('span'); inner.textContent = w
      if (k.cls?.includes('grad')) inner.className = k.cls.split(' ').filter((c) => c.startsWith('grad')).join(' ')
      wd.appendChild(inner); el.appendChild(wd)
      if (i < k.text.split(' ').length - 1) el.appendChild(document.createTextNode(' '))
      parts.push(inner)
    })
    if (k.cls?.includes('grad')) el.className = 'kt ' + k.cls.split(' ').filter((c) => !c.startsWith('grad')).join(' ')
  } else if (anim === 'letters') {
    for (const ch of k.text) {
      const s = document.createElement('span'); s.className = 'ch'; s.textContent = ch
      if (k.cls?.includes('grad')) s.className += ' ' + k.cls.split(' ').filter((c) => c.startsWith('grad')).join(' ')
      el.appendChild(s); parts.push(s)
    }
    if (k.cls?.includes('grad')) el.className = 'kt ' + k.cls.split(' ').filter((c) => !c.startsWith('grad')).join(' ')
  } else {
    el.textContent = k.text
  }
  ui.insertBefore(el, vignette)
  k.el = el
  k.parts = parts
  // never let a line run off the frame: shrink it to the space its alignment leaves (wide type is wide)
  if (!k.anchor) {
    const w = el.getBoundingClientRect().width
    const avail = Math.min(k.maxW ?? Infinity, k.align === 'center' ? 2 * Math.min(k.x, W - k.x) - 220 : k.align === 'right' ? k.x - 110 : W - k.x - 110)
    if (w > avail) {
      k.size = Math.floor((k.size * avail) / w)
      el.style.fontSize = `${k.size}px`
    }
  }
}

function place(k: KT, x: number, y: number) {
  const tx = k.align === 'center' ? '-50%' : k.align === 'right' ? '-100%' : '0'
  k.el!.style.left = `${x}px`
  k.el!.style.top = `${y}px`
  return `translateX(${tx})`
}

function drawText(k: KT, t: number) {
  const el = k.el!
  const out = k.out ?? 0.45
  if (t < k.t0 - 0.02 || t > k.t1 + out + 0.02) { el.style.display = 'none'; return }
  el.style.display = 'block'
  const [x, y] = k.anchor ? k.anchor() : [k.x, k.y]
  const base = place(k, x, y)
  const e = ease.inOutCubic(range(t, k.t1, k.t1 + out))
  const anim = k.anim ?? 'rise'
  const stagger = k.stagger ?? (anim === 'letters' ? 0.035 : 0.075)
  const dur = k.dur ?? (anim === 'letters' ? 0.6 : 0.8)
  el.style.opacity = String(1 - e)
  el.style.filter = e > 0 ? `blur(${(e * 14).toFixed(2)}px)` : 'none'
  let tr = `${base} translateY(${(-e * 34).toFixed(1)}px)`
  const wide = k.cls?.includes('disp') ?? false
  const fin = k.weight ?? 800
  if (anim === 'rise') {
    k.parts!.forEach((p, i) => {
      const q = ease.outExpo(range(t, k.t0 + i * stagger, k.t0 + i * stagger + dur))
      p.style.transform = `translateY(${((1 - q) * 112).toFixed(2)}%) rotate(${((1 - q) * 5).toFixed(2)}deg)`
      // display words land thin and fill out to heavy, tracking in as they do; they thin out again as they leave
      if (wide) {
        const g = 1 - Math.pow(1 - range(t, k.t0 + i * stagger + 0.04, k.t0 + i * stagger + dur * 0.7), 4)
        p.style.fontWeight = String(Math.round(lerp(160, fin, g) - e * 500))
        p.style.letterSpacing = `${lerp(0.14, 0.005, g).toFixed(3)}em`
      }
    })
  } else if (anim === 'letters') {
    k.parts!.forEach((p, i) => {
      const q = ease.outCubic(range(t, k.t0 + i * stagger, k.t0 + i * stagger + dur))
      p.style.opacity = String(q)
      p.style.transform = `translateY(${((1 - q) * 40).toFixed(1)}px) scale(${(1 + (1 - q) * 0.45).toFixed(3)})`
      p.style.filter = q < 1 ? `blur(${((1 - q) * 16).toFixed(2)}px)` : 'none'
      if (wide) p.style.fontWeight = String(Math.round(lerp(100, fin, ease.outExpo(range(t, k.t0 + i * stagger, k.t0 + i * stagger + dur * 1.4))) - e * 600))
    })
  } else if (anim === 'blur') {
    const q = ease.outCubic(range(t, k.t0, k.t0 + 1.1))
    el.style.opacity = String(q * (1 - e))
    el.style.filter = `blur(${((1 - q) * 22 + e * 14).toFixed(2)}px)`
    el.style.letterSpacing = `${((1 - q) * 0.25 + (wide ? 0.005 : -0.005)).toFixed(3)}em`
  } else if (anim === 'stamp') {
    const q = range(t, k.t0, k.t0 + 0.55)
    tr += ` scale(${(1 + (1 - ease.outBack(q)) * 0.5).toFixed(3)})`
    el.style.opacity = String(Math.min(1, q * 3) * (1 - e))
  } else if (anim === 'fade') {
    const q = ease.outCubic(range(t, k.t0, k.t0 + 0.6))
    el.style.opacity = String(q * (1 - e))
    tr += ` translateY(${((1 - q) * 18).toFixed(1)}px)`
  }
  el.style.transform = tr
  if (k.count) {
    const [a, b, s0, s1] = k.count
    el.textContent = String(Math.round(lerp(a, b, ease.outCubic(range(t, s0, s1)))))
  }
}

const tmp = new Vector3()
function project(v: Vector3): [number, number] {
  tmp.copy(v).project(camera)
  return [(tmp.x + 1) / 2 * W, (1 - tmp.y) / 2 * H]
}

// ------------------------------------------------------------------------------------------- per-frame scene state
let simFrame = -1
function stepSimTo(f: number) {
  if (f < simFrame) { // backwards seek: rebuild the book from the start
    T3.sim = new BookSim(220, 96, 7)
    ;(T3.tex.image as { data: Uint8Array }).data = T3.sim.data
    T3.tex.needsUpdate = true
    T3.acc = 0
    simFrame = -1
  }
  while (simFrame < f) {
    T3.update(1 / FPS)
    simFrame++
  }
}

function scenes(t: number) {
  // camera
  const v = cam.at(t)
  camera.position.set(v[0], v[1], v[2])
  camera.lookAt(v[3], v[4], v[5])

  dustMat.uniforms.uTime.value = t
  dustMat.uniforms.uAlpha.value = env(t, 1.5, 58.5, 2.0, 1.0)

  // --- terrain area (S1-S4)
  const inTerrain = t < 20.2 || t > cs(21) + 1.6
  terrain.visible = inTerrain
  if (t > cs(21) + 1.6) { terrain.position.set(245, -2, -62); terrain.scale.setScalar(1.25) } else { terrain.position.set(0, 0, 0); terrain.scale.setScalar(1) }
  ptsMat.uniforms.uTime.value = t
  ptsMat.uniforms.uWake.value = lerp(0, 84, ease.outCubic(range(t, 0.2, 3.6)))
  ptsMat.uniforms.uAlpha.value = (1 - 0.7 * ease.inOutCubic(range(t, cs(3) + 0.4, cs(3) + 1.6))) * (1 - ease.inOutCubic(range(t, cs(4) - 0.2, cs(4) + 1.4)))
  pts.visible = t < cs(4) + 1.5

  // walls: build wave, cold flash + collapse for pulled ones, fade to grey ("unseen"), then sink into the surface
  const wallsOn = t > cs(1) - 0.6 && t < cs(4) + 1.4
  const unseen = ease.inOutCubic(range(t, cs(3) + 0.25, cs(3) + 1.4))
  const sink = 1 - ease.inOutCubic(range(t, cs(4) - 0.1, cs(4) + 1.1))
  sparks.visible = wallsOn
  sparkMat.uniforms.uTime.value = t
  if (wallsOn) {
    cols.forEach((col) => {
      const w = walls[col.w]
      const rise = Math.max(0, ease.outBack(range(t, col.tb, col.tb + 0.55)))
      const fall = col.tc < Infinity ? 1 - ease.inExpo(range(t, col.tc, col.tc + 0.24)) : 1
      const h = w.h * col.p * rise * fall * sink
      const flash = w.pulled != null ? range(t, w.pulled, w.pulled + 0.12) : 0
      const o = (col.w * MAXC + col.k) * 4
      wallData[o] = Math.round(clamp(h / 4) * 255)
      wallData[o + 1] = Math.round(flash * 255)
      wallData[o + 2] = Math.round(clamp(col.p / 1.5) * 255)
      wallData[o + 3] = 255
    })
    wallTex.needsUpdate = true
  }
  walls.forEach((w, wi) => {
    const fx = wallFx[wi]
    fx.strands.visible = fx.floor.visible = wallsOn
    const su = fx.sm.uniforms
    su.uTime.value = t
    su.uUnseen.value = unseen
    su.uSink.value = sink
    su.uOpacity.value = 1 - 0.55 * unseen
    fx.fm.uniforms.uOpacity.value = (1 - 0.7 * unseen) * sink
    fx.fm.uniforms.uDraw.value = ease.outCubic(range(t, w.built - 0.35, w.built + 0.25))
    fx.fm.uniforms.uCold.value = w.pulled != null ? range(t, w.pulled, w.pulled + 0.12) : 0
    fx.fm.uniforms.uLine.value = w.pulled != null ? 1 - 0.8 * ease.inOutCubic(range(t, w.pulled + 0.35, w.pulled + 1.3)) : 1
  })

  const rev = ease.inOutCubic(range(t, cs(4) - 0.15, cs(4) + 1.9))
  TU.uReveal.value = t < cs(4) - 0.15 ? -0.05 : rev >= 1 ? 1.1 : lerp(-0.05, 1.05, rev)
  const flatten = ease.inOutCubic(range(t, 17.2, 18.3))
  TU.uHeight.value = t > 30 ? 1.7 : lerp(0.35, 1.7, ease.outCubic(range(t, cs(4) + 0.2, cs(4) + 2.2))) * (1 - 0.85 * flatten)
  TU.uOpacity.value = t > 30 ? env(t, cs(21) + 1.7, 99, 1.4) : 1 - ease.inOutCubic(range(t, 18.6, 19.8))
  const ov = (t > 30 ? env(t, cs(22) - 0.5, 99, 1.2) : range(t, cs(4) + 1.4, cs(4) + 2.2) * (1 - range(t, 17.0, 17.8)))
  lineMat.opacity = ov
  glowMat.opacity = 0.28 * ov
  bubbleMat.opacity = ov
  T3.line.visible = T3.glow.visible = T3.bubbles.visible = ov > 0.01

  // --- dashboard card: lies on the terrain, stands up, then the camera pushes into its bubbles
  {
    const up = ease.inOutCubic(range(t, 18.15, 19.1))
    dash.group.position.set(0, lerp(0.45, 8, up), 0)
    dash.group.rotation.set(lerp(-Math.PI / 2, 0, up), 0, 0)
    dash.opacity = ease.inOutCubic(range(t, 17.1, 17.9)) * (1 - range(t, 22.6, 23.0))
    dash.mat.uniforms.uDim.value = 1 - 0.5 * ease.inOutCubic(range(t, cs(7) - 0.1, cs(7) + 0.35))
  }
  // --- tool cards: lit when the camera is in front of them
  for (const c of tools) {
    const dx = Math.abs(camera.position.x - c.x)
    c.card.opacity = env(t, 19.3, 32.2, 0.6, 0.6)
    c.card.mat.uniforms.uDim.value = 1 - 0.6 * clamp((dx - 3) / 22)
    c.card.group.rotation.y = clamp((c.x - camera.position.x) / 60, -0.4, 0.4) * -0.6
  }
  // --- accuracy
  accCard.opacity = env(t, cs(12) + 0.2, cs(15) - 0.2, 0.8, 0.6) * 0.75
  accCard.mat.uniforms.uDim.value = 0.75
  const ringP = ease.outCubic(range(t, cs(13) + 0.1, cs(13) + 1.9))
  setRing(ringP)
  const ok = range(t, cs(14) - 0.05, cs(14) + 0.3)
  ;(ringFill.material as MeshBasicMaterial).color.set(ok > 0 ? '#2ee6a0' : '#ffb547')
  ;(ringGlow.material as MeshBasicMaterial).color.set(ok > 0 ? '#2ee6a0' : '#ffb547')
  ;(ringGlow.material as MeshBasicMaterial).opacity = 0.18 + 0.5 * (1 - range(t, cs(14), cs(14) + 0.8)) * (ok > 0 ? 1 : 0)
  const ringO = env(t, cs(12) + 0.3, cs(15) - 0.2, 0.8, 0.6)
  ring.visible = ringO > 0.01
  ;(ringBase.material as MeshBasicMaterial).opacity = 0.1 * ringO
  ;(ringFill.material as MeshBasicMaterial).opacity = ringO
  ring.scale.setScalar(1 + 0.04 * Math.sin(t * 1.3))

  // --- laptop, then the screen lifts off and becomes a phone
  const lapO = env(t, cs(15) - 0.3, cs(20) - 0.3, 0.8, 0.6)
  laptop.visible = lapO > 0.01
  floor.visible = laptop.visible
  floorMat.uniforms.uOpacity.value = lapO
  for (const m of [alu, deck.material as MeshStandardMaterial, pad.material as MeshStandardMaterial]) m.opacity = lapO
  const morph = ease.inOutCubic(range(t, cs(19) - 0.35, cs(19) + 0.75))
  const lift = morph > 0
  lapScreen.opacity = lapO * (lift ? 0 : 1)
  lapScreen.mat.uniforms.uRim.value = 0.25
  {
    const from = new Vector3(205, 0.42 + Math.cos(0.16) * 5.45, -Math.sin(0.16) * 5.45 + 0.02)
    const to = new Vector3(213.5, 6.9, 6)
    phone.group.position.lerpVectors(from, to, morph)
    phone.group.rotation.set(lerp(-0.16, 0, morph), lerp(0, -0.22, morph), lerp(0, 0.05, morph))
    const w = lerp(16.8, 4.6, morph)
    const h = lerp(9.45, 9.96, morph)
    phone.size(w, h)
    phone.mat.uniforms.uRadius.value = lerp(0.25, 0.85, morph)
    phone.mat.uniforms.uMix.value = ease.inOutCubic(range(t, cs(19) - 0.1, cs(19) + 0.45))
    phone.opacity = lift ? lapO : 0
    phone.shadow.visible = morph > 0.5
    bezel.group.position.copy(phone.group.position).add(new Vector3(0, 0, -0.06))
    bezel.group.rotation.copy(phone.group.rotation)
    bezel.size(w + 0.45, h + 0.45)
    bezel.mat.uniforms.uRadius.value = lerp(0.3, 1.1, morph)
    bezel.opacity = lift ? lapO * ease.inOutCubic(range(morph, 0.2, 0.7)) : 0
    laptop.position.x = 205 - 4 * morph
    lid.rotation.x = -0.16
  }

  // --- trial flow: landing -> sign up -> dashboard
  landingCard.opacity = env(t, cs(20) - 0.4, cs(20) + 0.95, 0.5, 0.35)
  landingCard.mat.uniforms.uDim.value = 1 - 0.35 * ease.inOutCubic(range(t, cs(20) + 0.5, cs(20) + 0.9))
  signupCard.opacity = env(t, cs(20) + 0.9, cs(21) + 1.85, 0.5, 0.35)
  signupCard.mat.uniforms.uMix.value = ease.inOutCubic(range(t, cs(21) + 0.5, cs(21) + 1.2))
  dash2.opacity = env(t, cs(21) + 1.6, cs(22) + 0.1, 0.5, 0.9)
}

function overlays(t: number) {
  scrimL.style.opacity = String(Math.max(env(t, 0.6, ce(0) + 0.5, 0.6, 0.6), env(t, cs(20) - 0.1, ce(21) + 0.3, 0.5, 0.5)))
  scrimB.style.opacity = String(Math.max(env(t, cs(6) - 0.2, ce(11) + 0.4, 0.4, 0.5), env(t, cs(17) - 0.1, ce(19) + 0.4, 0.4, 0.5), env(t, 15.4, 17.4, 0.4, 0.4)))
  scrimT.style.opacity = String(Math.max(env(t, cs(1) - 0.2, cs(3) + 0.2, 0.4, 0.4) * 0.85, env(t, cs(5) + 0.2, 17.4, 0.4, 0.5), env(t, cs(15) - 0.2, cs(17) + 0.4, 0.4, 0.5), env(t, cs(18) - 0.1, ce(19) + 0.3, 0.3, 0.4) * 0.6))
  scrimC.style.opacity = String(Math.max(env(t, cs(4) + 0.1, cs(5), 0.5, 0.5), env(t, cs(22) - 0.4, 99, 0.9, 1), env(t, cs(3) + 0.2, ce(3) + 0.3, 0.5, 0.4) * 0.6))
  flash.style.opacity = String(Math.max(0.9 * (1 - range(t, cs(4) + 0.35, cs(4) + 1.1)) * (t > cs(4) + 0.35 ? 1 : 0), 0.6 * (1 - range(t, cs(14) - 0.05, cs(14) + 0.6)) * (t > cs(14) - 0.05 ? 1 : 0)))
  flash.style.background = t > 30 ? 'radial-gradient(50% 50% at 50% 50%, rgba(46,230,160,.5), rgba(46,230,160,0) 70%)' : 'radial-gradient(60% 60% at 50% 50%, rgba(255,214,120,.55), rgba(255,140,40,0) 70%)'
  black.style.opacity = String(Math.max(1 - range(t, 0, 0.9), range(t, DUR - 1.1, DUR - 0.05)))
  const g = Math.floor(t * FPS)
  grainLayer.style.transform = `translate(${(g * 73) % 256}px, ${(g * 151) % 256}px)`

  // logo bars grow under the wordmark (C and J)
  const bars = (el: HTMLElement, word: KT, size: number) => {
    const t0 = word.t0
    const show = t >= t0 - 0.05 && t <= word.t1 + 0.5
    el.style.display = show ? 'block' : 'none'
    if (!show) return
    const wr = word.el!.getBoundingClientRect()
    el.style.left = `${wr.left - size * (168 / 150) - 26}px`
    el.style.top = `${wr.top + wr.height * 0.12}px`
    el.style.height = `${size}px`
    el.style.transform = `scale(${size / 150})`
    el.style.transformOrigin = '0 0'
    const e = ease.inOutCubic(range(t, word.t1, word.t1 + 0.45))
    el.style.opacity = String(1 - e)
    Array.from(el.children).forEach((b, i) => {
      const q = ease.outBack(range(t, t0 + i * 0.07, t0 + i * 0.07 + 0.6))
      ;(b as HTMLElement).style.transform = `scaleY(${Math.max(0, q).toFixed(3)})`
    })
  }
  bars(logoBars, logoWord, 172)
  bars(endBars, endWord, 156)
}

// ------------------------------------------------------------------------------------------- frame render (with motion blur on fast camera moves)
const blurCanvas = document.createElement('canvas')
blurCanvas.width = W
blurCanvas.height = H
blurCanvas.style.cssText = 'position:absolute;inset:0;width:1920px;height:1080px;display:none'
canvas.after(blurCanvas)
const bctx = blurCanvas.getContext('2d')!

function camSpeed(t: number) {
  const a = cam.at(t)
  const b = cam.at(t + 1 / FPS)
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) + 0.6 * Math.hypot(b[3] - a[3], b[4] - a[4], b[5] - a[5])
}

let built = false
async function renderFrame(f: number) {
  if (!built) { texts.forEach(build); built = true }
  stepSimTo(f)
  const t = f / FPS
  const speed = camSpeed(t)
  const n = speed > 0.9 ? Math.min(12, Math.ceil(speed / 0.45)) : 1
  if (n > 1) {
    // 180-degree shutter: average n sub-frames across half the frame interval
    bctx.globalCompositeOperation = 'source-over'
    for (let k = 0; k < n; k++) {
      const ts = t + (k / (n - 1) - 0.5) * (0.5 / FPS)
      scenes(ts)
      renderer.render(scene, camera)
      bctx.globalAlpha = 1 / (k + 1)
      bctx.drawImage(canvas, 0, 0)
    }
    bctx.globalAlpha = 1
    blurCanvas.style.display = 'block'
    scenes(t)
  } else {
    blurCanvas.style.display = 'none'
    scenes(t)
    renderer.render(scene, camera)
  }
  texts.forEach((k) => drawText(k, t))
  overlays(t)
  return n
}

;(window as any).renderFrame = renderFrame
;(window as any).filmReady = Promise.all([
  document.fonts.load('800 100px "Big Shoulders Display Variable"'), document.fonts.load('500 30px "Geist Variable"'),
  document.fonts.load('800 100px "Bricolage Grotesque Variable"'), document.fonts.load('500 30px "Geist Variable"', '₹'),
  document.fonts.load('800 100px "Big Shoulders Display Variable"', '₹'), ...loading,
]).then(() => document.fonts.ready).then(() => renderFrame(0)).then(() => true)
;(window as any).FRAMES = DUR * FPS
