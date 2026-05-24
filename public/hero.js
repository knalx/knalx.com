(() => {
  const canvas = document.getElementById("hero-gl");
  const heroEl = document.getElementById("hero");
  if (!canvas || !heroEl) return;

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const gl = canvas.getContext("webgl2", { antialias: false, alpha: false });

  if (!gl || reduced) {
    heroEl.classList.add("no-gl");
    return;
  }

  const VERT = `#version 300 es
  in vec2 a_pos;
  void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`;

  // Mouse-reactive flow-field noise.
  // Two color stops come from CSS custom properties (read in JS, sent as uniforms).
  const FRAG = `#version 300 es
  precision highp float;

  out vec4 outColor;

  uniform vec2  u_res;
  uniform float u_time;
  uniform vec2  u_mouse;   // 0..1 in viewport space
  uniform vec3  u_colA;
  uniform vec3  u_colB;
  uniform vec3  u_bg;

  // hash + value noise (cheap, good enough for a hero background)
  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
  }

  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 5; i++) {
      v += a * noise(p);
      p *= 2.02;
      a *= 0.5;
    }
    return v;
  }

  void main() {
    vec2 uv = gl_FragCoord.xy / u_res.xy;
    vec2 p = uv - 0.5;
    p.x *= u_res.x / u_res.y;

    // mouse warp
    vec2 m = u_mouse - 0.5;
    m.x *= u_res.x / u_res.y;
    vec2 d = p - m;
    float r = length(d);
    float pull = exp(-r * 2.5) * 0.35;
    p += normalize(d + 0.0001) * pull;

    float t = u_time * 0.08;
    vec2 q = vec2(fbm(p * 1.6 + t), fbm(p * 1.6 - t + 4.2));
    vec2 s = vec2(fbm(p * 1.6 + q + vec2(1.7, 9.2) + t),
                  fbm(p * 1.6 + q + vec2(8.3, 2.8) - t));
    float n = fbm(p * 1.8 + s);

    // soft vignette pulled toward the mouse
    float v = smoothstep(1.1, 0.25, length(p - m * 0.5));

    vec3 col = mix(u_colA, u_colB, smoothstep(0.25, 0.85, n));
    col = mix(u_bg, col, v * 0.95);

    // subtle film grain
    float g = (hash(gl_FragCoord.xy + u_time) - 0.5) * 0.04;
    col += g;

    outColor = vec4(col, 1.0);
  }`;

  function compile(type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.warn("shader compile error:", gl.getShaderInfoLog(sh));
      return null;
    }
    return sh;
  }

  const vs = compile(gl.VERTEX_SHADER, VERT);
  const fs = compile(gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) {
    heroEl.classList.add("no-gl");
    return;
  }

  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.bindAttribLocation(prog, 0, "a_pos");
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.warn("program link error:", gl.getProgramInfoLog(prog));
    heroEl.classList.add("no-gl");
    return;
  }
  gl.useProgram(prog);

  // fullscreen triangle
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 3, -1, -1, 3]),
    gl.STATIC_DRAW,
  );
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const uRes = gl.getUniformLocation(prog, "u_res");
  const uTime = gl.getUniformLocation(prog, "u_time");
  const uMouse = gl.getUniformLocation(prog, "u_mouse");
  const uColA = gl.getUniformLocation(prog, "u_colA");
  const uColB = gl.getUniformLocation(prog, "u_colB");
  const uBg = gl.getUniformLocation(prog, "u_bg");

  // Pull colors from CSS custom properties so the shader follows the theme.
  function readColor(name, fallback) {
    const v = getComputedStyle(document.documentElement)
      .getPropertyValue(name)
      .trim();
    return hexOrRgbToVec3(v) || fallback;
  }

  function hexOrRgbToVec3(s) {
    if (!s) return null;
    if (s.startsWith("#")) {
      const h = s.slice(1);
      const n =
        h.length === 3
          ? h
              .split("")
              .map((c) => c + c)
              .join("")
          : h;
      const r = parseInt(n.slice(0, 2), 16) / 255;
      const g = parseInt(n.slice(2, 4), 16) / 255;
      const b = parseInt(n.slice(4, 6), 16) / 255;
      return [r, g, b];
    }
    const m = s.match(/rgba?\(([^)]+)\)/);
    if (m) {
      const p = m[1].split(",").map((x) => parseFloat(x));
      return [p[0] / 255, p[1] / 255, p[2] / 255];
    }
    return null;
  }

  function refreshColors() {
    gl.uniform3fv(uColA, readColor("--accent-a", [1.0, 0.36, 0.23]));
    gl.uniform3fv(uColB, readColor("--accent-b", [0.42, 0.36, 0.91]));
    gl.uniform3fv(uBg, readColor("--bg", [0.043, 0.051, 0.071]));
  }
  refreshColors();
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", refreshColors);

  let dpr = Math.min(window.devicePixelRatio || 1, 2);
  let w = 0;
  let h = 0;
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = heroEl.getBoundingClientRect();
    w = Math.max(1, Math.floor(rect.width * dpr));
    h = Math.max(1, Math.floor(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.uniform2f(uRes, w, h);
  }

  let resizeT = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(resize, 100);
  });
  resize();

  // Mouse (normalized 0..1, smoothed)
  const mouse = { x: 0.5, y: 0.5, tx: 0.5, ty: 0.5 };
  heroEl.addEventListener("pointermove", (e) => {
    const rect = heroEl.getBoundingClientRect();
    mouse.tx = (e.clientX - rect.left) / rect.width;
    mouse.ty = 1.0 - (e.clientY - rect.top) / rect.height;
  });
  heroEl.addEventListener("pointerleave", () => {
    mouse.tx = 0.5;
    mouse.ty = 0.5;
  });

  let raf = 0;
  let t0 = performance.now();
  let running = true;

  function frame(now) {
    if (!running) return;
    const t = (now - t0) / 1000;
    mouse.x += (mouse.tx - mouse.x) * 0.06;
    mouse.y += (mouse.ty - mouse.y) * 0.06;
    gl.uniform1f(uTime, t);
    gl.uniform2f(uMouse, mouse.x, mouse.y);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      running = false;
      cancelAnimationFrame(raf);
    } else if (!running) {
      running = true;
      t0 = performance.now() - 1000;
      raf = requestAnimationFrame(frame);
    }
  });
})();
