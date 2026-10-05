// Flowdeck hero loop: a silent, text-free, seamless 12-second loop for the landing page background.
// A corridor of liquidity walls made of light strands (cool bids on the left, warm asks on the right) recedes to a
// vanishing point; a mid-price line runs down the middle with trades drifting along it. Locked-off camera.
// Every motion is periodic in the loop phase uT (0..1), so frame 360 equals frame 0 and the loop has no seam.
// window.renderFrame(n) draws frame n of LOOP_FRAMES at 30 fps.
import {
  AdditiveBlending, BufferAttribute, BufferGeometry, DoubleSide, Mesh, PerspectiveCamera, PlaneGeometry, Points, Scene,
  ShaderMaterial, WebGLRenderer,
} from 'three'

const W = 1920
const H = 1080
const LOOP_FRAMES = 360 // 12 s at 30 fps
const Z0 = 12 // near end of the corridor
const Z1 = -120 // far end
const STRAND = 0.2
const PR = Number(new URLSearchParams(location.search).get('pr') || '1') // pixel ratio: ?pr=2 renders 3840 x 2160

const canvas = document.getElementById('gl') as HTMLCanvasElement
const renderer = new WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true })
renderer.setPixelRatio(PR)
renderer.setSize(W, H, false)
renderer.setClearColor('#000000', 1)
const scene = new Scene()
const camera = new PerspectiveCamera(38, W / H, 0.1, 400)
camera.position.set(0, 1.35, 16)
camera.lookAt(0, 6.4, -60)

const COMMON = /* glsl */ `
  const float TAU = 6.2831853;
  float hash1(float n) { return fract(sin(n * 127.1 + 311.7) * 43758.5453); }
  float ss(float a, float b, float x) { float q = clamp((x - a) / (b - a), 0.0, 1.0); return q * q * (3.0 - 2.0 * q); }
  vec3 heat(float p) {
    vec3 c = mix(vec3(0.22, 0.04, 0.02), vec3(0.62, 0.17, 0.05), smoothstep(0.0, 0.3, p));
    c = mix(c, vec3(1.0, 0.42, 0.15), smoothstep(0.3, 0.55, p));
    c = mix(c, vec3(1.0, 0.71, 0.28), smoothstep(0.55, 0.8, p));
    c = mix(c, vec3(1.0, 0.89, 0.63), smoothstep(0.8, 1.05, p));
    return mix(c, vec3(1.0, 0.97, 0.93), smoothstep(1.05, 1.45, p));
  }
  vec3 cool(float p) {
    vec3 c = mix(vec3(0.02, 0.05, 0.16), vec3(0.06, 0.2, 0.55), smoothstep(0.0, 0.3, p));
    c = mix(c, vec3(0.18, 0.48, 1.0), smoothstep(0.3, 0.55, p));
    c = mix(c, vec3(0.34, 0.84, 1.0), smoothstep(0.55, 0.8, p));
    c = mix(c, vec3(0.78, 0.95, 1.0), smoothstep(0.8, 1.05, p));
    return mix(c, vec3(0.97, 0.99, 1.0), smoothstep(1.05, 1.45, p));
  }`

// ------------------------------------------------------------------------------------------- walls
interface WallDef { x: number; h: number; seed: number; pull?: [number, number, number, number]; pulse: number }
// pull: [z near, z far, phase pulled, phase rebuilt]
const walls: WallDef[] = [
  { x: -4.6, h: 2.6, seed: 1.3, pull: [-14, -30, 0.25, 0.62], pulse: 0.1 },
  { x: -8.8, h: 4.4, seed: 2.9, pulse: 0.45 },
  { x: -14.5, h: 7.4, seed: 4.2, pulse: 0.8 },
  { x: 4.6, h: 2.8, seed: 5.7, pulse: 0.3 },
  { x: 9.2, h: 4.6, seed: 7.1, pull: [-34, -52, 0.7, 0.08], pulse: 0.62 },
  { x: 15.0, h: 7.8, seed: 8.6, pulse: 0.95 },
]

const WALL_VERT = /* glsl */ `varying vec3 vW; varying float vDepth;
  void main() { vec4 wp = modelMatrix * vec4(position, 1.0); vW = wp.xyz; vec4 mv = viewMatrix * wp; vDepth = -mv.z; gl_Position = projectionMatrix * mv; }`
const WALL_FRAG = /* glsl */ `
  uniform float uT, uH, uSeed, uSide, uPulse, uHasPull, uPZ0, uPZ1, uPA, uPB;
  varying vec3 vW; varying float vDepth;
  ${COMMON}
  float prof(float z) {
    float p = 0.55 + 0.24 * sin(z * 0.17 + uSeed * 1.7) + 0.15 * sin(z * 0.53 + uSeed * 4.1) + 0.06 * sin(z * 1.7 + uSeed * 2.3);
    return clamp(p, 0.05, 1.45);
  }
  // how far up a pulled section stands at loop phase t (1 = full, 0 = pulled), plus its cold flash
  vec2 pullState(float t, float a, float b) {
    float d = fract(b - a);
    float q = fract(t - a);
    float fall = q < 0.035 ? 1.0 - (q <= 0.0 ? 0.0 : pow(2.0, 10.0 * (q / 0.035) - 10.0)) : 0.0;
    float r = clamp((q - d) / 0.06, 0.0, 1.0);
    float rm = r - 1.0;
    float rise = max(0.0, 1.0 + 2.70158 * rm * rm * rm + 1.70158 * rm * rm);
    float up = q < 0.035 ? fall : (q < d ? 0.0 : rise);
    float flash = q < 0.035 ? 1.0 - q / 0.035 * 0.3 : (q < 0.06 ? 0.7 * (1.0 - (q - 0.035) / 0.025) : 0.0);
    return vec2(up, flash);
  }
  void main() {
    float yy = abs(vW.y);
    bool refl = vW.y < 0.0;
    float u = (${Z0.toFixed(1)} - vW.z) / ${STRAND.toFixed(2)};
    float id = floor(u);
    float zc = ${Z0.toFixed(1)} - (id + 0.5) * ${STRAND.toFixed(2)};
    float j = hash1(id + uSeed * 91.0);
    float ice = step(0.986, hash1(id * 1.37 + uSeed * 13.0)) * step(0.55, prof(zc));
    float p = clamp(prof(zc) + (j - 0.5) * 0.08 + ice * 0.34, 0.0, 1.5);
    float breathe = 1.0 + 0.05 * sin(TAU * uT + zc * 0.15 + uSeed);
    float up = 1.0, flash = 0.0, ghost = 0.0;
    if (uHasPull > 0.5 && zc < uPZ0 && zc > uPZ1) {
      float k = (uPZ0 - zc) / (uPZ0 - uPZ1);
      vec2 st = pullState(uT, uPA + k * 0.02, uPB + k * 0.02);
      up = st.x; flash = st.y;
      ghost = (1.0 - up) * 0.5;
    }
    // a light pulse runs down each wall once per loop
    float zp = ${Z0.toFixed(1)} - ${(Z0 - Z1).toFixed(1)} * fract(uT + uPulse);
    float bump = exp(-pow((zc - zp) / 3.5, 2.0));
    float full = uH * p * breathe;
    float h = full * up;
    float on = step(0.02, h);
    float fu = abs(fract(u) - 0.5);
    float px = fwidth(u);
    float cov = 1.0 - smoothstep(0.26 - px, 0.26 + px, fu);
    cov = mix(cov, 0.52, ss(0.3, 0.7, px));
    float fill = 0.2 + 0.8 * cov;
    float y01 = clamp(yy / max(h, 1e-3), 0.0, 1.0);
    float inside = step(yy, h);
    float levels = 0.82 + 0.18 * ss(0.3, 0.5, abs(fract(yy * 3.0) - 0.5));
    float body = inside * (0.05 + 0.95 * pow(y01, 2.4)) * levels;
    float edge = exp(-abs(yy - h) * 24.0) * on * (1.0 + 1.6 * bump);
    float halo = exp(-max(yy - h, 0.0) * 1.3) * (1.0 - inside) * on;
    float lv = mix(0.08, p + 0.18 + 0.25 * bump, pow(y01, 1.3));
    vec3 col = uSide > 0.0 ? heat(lv) : cool(lv);
    vec3 cap = uSide > 0.0 ? heat(p + 0.5 + 0.3 * bump) : cool(p + 0.5 + 0.3 * bump);
    vec3 white = vec3(0.9, 0.97, 1.0);
    col = mix(col, white, flash * 0.8);
    cap = mix(cap, white, flash);
    vec3 c = col * body * fill * 1.35 + cap * edge * (0.35 + 0.65 * cov) * 1.7 + (uSide > 0.0 ? heat(max(p, 0.6)) : cool(max(p, 0.6))) * halo * 0.1;
    float beam = ice * on * (1.0 - inside) * exp(-max(yy - h, 0.0) * 0.8) * exp(-pow(fu / 0.4, 2.0));
    c += cap * beam * 0.55;
    c += white * exp(-abs(yy - full) * 34.0) * cov * ghost * 0.6;
    c *= exp(-max(vDepth - 14.0, 0.0) * 0.017);
    if (refl) c *= 0.2 * exp(-yy * 0.7);
    gl_FragColor = vec4(c, 1.0);
  }`

const wallMats: ShaderMaterial[] = []
for (const w of walls) {
  const m = new ShaderMaterial({
    transparent: true, depthWrite: false, blending: AdditiveBlending, side: DoubleSide, vertexShader: WALL_VERT, fragmentShader: WALL_FRAG,
    uniforms: {
      uT: { value: 0 }, uH: { value: w.h }, uSeed: { value: w.seed }, uSide: { value: Math.sign(w.x) }, uPulse: { value: w.pulse },
      uHasPull: { value: w.pull ? 1 : 0 }, uPZ0: { value: w.pull?.[0] ?? 0 }, uPZ1: { value: w.pull?.[1] ?? 0 },
      uPA: { value: w.pull?.[2] ?? 0 }, uPB: { value: w.pull?.[3] ?? 0 },
    },
  })
  const top = w.h * 1.6 + 3
  const bottom = -w.h * 1.6
  const mesh = new Mesh(new PlaneGeometry(Z0 - Z1, top - bottom), m)
  mesh.rotation.y = Math.PI / 2
  mesh.position.set(w.x, (top + bottom) / 2, (Z0 + Z1) / 2)
  scene.add(mesh)
  wallMats.push(m)
}

// ------------------------------------------------------------------------------------------- floor: resting orders as points
const floorGeo = new BufferGeometry()
{
  const pos: number[] = []
  const seed: number[] = []
  let s = 3
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647)
  for (let x = -22; x <= 22; x += 0.55) {
    for (let z = Z1; z <= Z0; z += 0.5) {
      pos.push(x + (rnd() - 0.5) * 0.1, 0.02, z)
      seed.push(rnd())
    }
  }
  floorGeo.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
  floorGeo.setAttribute('aSeed', new BufferAttribute(new Float32Array(seed), 1))
}
const floorMat = new ShaderMaterial({
  transparent: true, depthWrite: false, blending: AdditiveBlending, uniforms: { uT: { value: 0 }, uPR: { value: PR } },
  vertexShader: /* glsl */ `
    attribute float aSeed; uniform float uT, uPR; varying float vB; varying float vS;
    const float TAU = 6.2831853;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      float k = 1.0 + floor(aSeed * 3.0);
      float tw = pow(0.5 + 0.5 * sin(TAU * uT * k + aSeed * 61.0), 6.0);
      float side = smoothstep(1.2, 4.0, abs(position.x)); // keep the mid-price lane clean
      vB = (0.22 + 0.6 * tw) * exp(-max(-mv.z - 14.0, 0.0) * 0.02) * (0.35 + 0.65 * side);
      vS = aSeed;
      gl_PointSize = (1.6 + 3.0 * tw) * (30.0 / -mv.z) * uPR;
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */ `
    varying float vB; varying float vS;
    void main() {
      float d = length(gl_PointCoord - 0.5);
      float a = smoothstep(0.5, 0.0, d);
      vec3 c = mix(vec3(0.16, 0.42, 1.0), vec3(0.34, 0.86, 1.0), vS);
      if (vS > 0.985) c = vec3(1.0, 0.72, 0.28);
      gl_FragColor = vec4(c * vB, a * vB);
    }`,
})
scene.add(new Points(floorGeo, floorMat))

// ------------------------------------------------------------------------------------------- mid-price line
const lineMat = new ShaderMaterial({
  transparent: true, depthWrite: false, blending: AdditiveBlending, uniforms: { uT: { value: 0 } },
  vertexShader: WALL_VERT,
  fragmentShader: /* glsl */ `
    uniform float uT; varying vec3 vW; varying float vDepth;
    const float TAU = 6.2831853;
    void main() {
      float dx = abs(vW.x);
      float core = exp(-dx * 55.0) * 0.85 + exp(-dx * 7.0) * 0.12 + exp(-dx * 1.4) * 0.03;
      float shimmer = 0.85 + 0.15 * sin(TAU * uT * 2.0 - vW.z * 0.35);
      vec3 c = mix(vec3(1.0, 0.82, 0.55), vec3(0.95, 0.97, 1.0), 0.5);
      float fade = exp(-max(vDepth - 14.0, 0.0) * 0.02) * smoothstep(${(Z0 - 6).toFixed(1)}, ${(Z0 - 40).toFixed(1)}, vW.z);
      gl_FragColor = vec4(c * core * shimmer * fade, 1.0);
    }`,
})
const line = new Mesh(new PlaneGeometry(6, Z0 - Z1), lineMat)
line.rotation.x = -Math.PI / 2
line.position.set(0, 0.03, (Z0 + Z1) / 2)
scene.add(line)

// ------------------------------------------------------------------------------------------- trades drifting down the line
const tradeGeo = new BufferGeometry()
{
  const seed: number[] = []
  const pos: number[] = []
  let s = 29
  const rnd = () => ((s = (s * 48271) % 2147483647) / 2147483647)
  for (let i = 0; i < 70; i++) { seed.push(rnd(), rnd(), rnd()); pos.push(0, 0, 0) }
  tradeGeo.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
  tradeGeo.setAttribute('aSeed', new BufferAttribute(new Float32Array(seed), 3))
}
const tradeMat = new ShaderMaterial({
  transparent: true, depthWrite: false, blending: AdditiveBlending, uniforms: { uT: { value: 0 }, uPR: { value: PR } },
  vertexShader: /* glsl */ `
    attribute vec3 aSeed; uniform float uT, uPR; varying float vA; varying float vBuy;
    void main() {
      float k = aSeed.z > 0.5 ? 2.0 : 1.0;
      float f = fract(uT * k + aSeed.x);
      float z = ${Z0.toFixed(1)} - 6.0 - ${(Z0 - Z1 - 6).toFixed(1)} * f;
      float size = pow(aSeed.y, 3.0);
      vec3 p = vec3((aSeed.y - 0.5) * 0.7, 0.1 + size * 0.25, z);
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      vA = smoothstep(0.0, 0.06, f) * (1.0 - smoothstep(0.85, 1.0, f)) * exp(-max(-mv.z - 14.0, 0.0) * 0.02);
      vBuy = step(0.5, fract(aSeed.x * 7.0 + aSeed.y * 3.0));
      gl_PointSize = (3.0 + 16.0 * size) * (30.0 / -mv.z) * uPR;
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */ `
    varying float vA; varying float vBuy;
    void main() {
      float d = length(gl_PointCoord - 0.5);
      float a = smoothstep(0.5, 0.1, d);
      vec3 c = vBuy > 0.5 ? vec3(0.18, 0.9, 0.63) : vec3(1.0, 0.3, 0.42);
      c = mix(c, vec3(1.0), smoothstep(0.25, 0.0, d) * 0.5);
      gl_FragColor = vec4(c, a * vA * 0.9);
    }`,
})
const trades = new Points(tradeGeo, tradeMat)
trades.frustumCulled = false
scene.add(trades)

// ------------------------------------------------------------------------------------------- dust
const dustGeo = new BufferGeometry()
{
  const pos: number[] = []
  const seed: number[] = []
  let s = 11
  const rnd = () => ((s = (s * 48271) % 2147483647) / 2147483647)
  for (let i = 0; i < 1400; i++) { pos.push(-24 + rnd() * 48, rnd() * 14, -110 + rnd() * 124); seed.push(rnd()) }
  dustGeo.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
  dustGeo.setAttribute('aSeed', new BufferAttribute(new Float32Array(seed), 1))
}
const dustMat = new ShaderMaterial({
  transparent: true, depthWrite: false, blending: AdditiveBlending, uniforms: { uT: { value: 0 }, uPR: { value: PR } },
  vertexShader: /* glsl */ `attribute float aSeed; uniform float uT, uPR; varying float vS; varying float vF;
    const float TAU = 6.2831853;
    void main() { vec3 p = position; p.y += sin(TAU * uT + aSeed * 30.0) * 0.5; p.x += cos(TAU * uT + aSeed * 20.0) * 0.4;
      vec4 mv = modelViewMatrix * vec4(p, 1.0); vS = aSeed; vF = exp(-max(-mv.z - 10.0, 0.0) * 0.02);
      gl_PointSize = (1.4 + aSeed * 3.0) * (36.0 / -mv.z) * uPR; gl_Position = projectionMatrix * mv; }`,
  fragmentShader: /* glsl */ `varying float vS; varying float vF; void main() { float d = length(gl_PointCoord - 0.5);
    vec3 c = vS > 0.8 ? vec3(1.0, 0.7, 0.35) : vec3(0.4, 0.75, 1.0); gl_FragColor = vec4(c, smoothstep(0.5, 0.0, d) * 0.3 * vF); }`,
})
scene.add(new Points(dustGeo, dustMat))

// ------------------------------------------------------------------------------------------- frame
function renderFrame(f: number) {
  const t = (((f % LOOP_FRAMES) + LOOP_FRAMES) % LOOP_FRAMES) / LOOP_FRAMES
  for (const m of wallMats) m.uniforms.uT.value = t
  floorMat.uniforms.uT.value = t
  lineMat.uniforms.uT.value = t
  tradeMat.uniforms.uT.value = t
  dustMat.uniforms.uT.value = t
  renderer.render(scene, camera)
  return 1
}
;(window as any).renderFrame = renderFrame
;(window as any).filmReady = Promise.resolve().then(() => renderFrame(0)).then(() => true)
