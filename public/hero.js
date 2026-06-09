(async () => {
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

  // Fragment shader lives in /hero.frag for syntax highlighting + easy editing.
  let FRAG;
  try {
    const res = await fetch("/hero.frag", { cache: "no-cache" });
    if (!res.ok) throw new Error(`hero.frag: ${res.status}`);
    FRAG = await res.text();
  } catch (e) {
    console.warn(e);
    heroEl.classList.add("no-gl");
    return;
  }

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
  const uBg = gl.getUniformLocation(prog, "u_bg");
  const uSeed = gl.getUniformLocation(prog, "u_seed");

  // Per-session random seed — shifts the shader's hash stream so the
  // animation starts in a different state on every page load. Combines
  // Math.random() with the current wall-clock time so the seed is
  // guaranteed to vary even if Math.random() repeats.
  gl.uniform1f(
    uSeed,
    Math.random() * 1000.0 + ((Date.now() / 1000.0) % 100000.0),
  );

  // Pull background color from the CSS custom property so the shader
  // follows the theme.
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
    gl.uniform3fv(uBg, readColor("--bg", [0.043, 0.051, 0.071]));
  }
  refreshColors();

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
    mouse.x += (mouse.tx - mouse.x) * 0.035;
    mouse.y += (mouse.ty - mouse.y) * 0.035;
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
