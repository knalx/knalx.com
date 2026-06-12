(async () => {
  const canvas = document.getElementById("hero-gl");
  const heroEl = document.getElementById("hero");
  if (!canvas || !heroEl) return;

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const gl = canvas.getContext("webgl2", { antialias: false, alpha: false });
  if (!gl) {
    heroEl.classList.add("no-gl");
    return;
  }

  const VERT = `#version 300 es
  in vec2 a_pos;
  void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`;

  let FRAG;
  try {
    const res = await fetch("/hero.frag", { cache: "default" });
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
  const uOrbit = gl.getUniformLocation(prog, "u_orbit");
  const uDetail = gl.getUniformLocation(prog, "u_detail");
  const uMotion = gl.getUniformLocation(prog, "u_motion");
  const uView = gl.getUniformLocation(prog, "u_view");

  // 256x256 white-noise lattice texture — feeds the shader's vnoise()
  // with one hardware-filtered fetch instead of 4 arithmetic hashes
  {
    const N = 256;
    const data = new Uint8Array(N * N);
    let s = 0x9e3779b9; // deterministic mulberry32
    for (let i = 0; i < data.length; i++) {
      s |= 0;
      s = (s + 0x6d2b79f5) | 0;
      let z = Math.imul(s ^ (s >>> 15), 1 | s);
      z = (z + Math.imul(z ^ (z >>> 7), 61 | z)) ^ z;
      data[i] = ((z ^ (z >>> 14)) >>> 0) & 255;
    }
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, N, N, 0, gl.RED, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.uniform1i(gl.getUniformLocation(prog, "u_noise"), 0);
  }

  gl.uniform1f(uMotion, reduced ? 0.0 : 1.0);

  /* ---------- catalog stars (GL_POINTS pass) ----------
     Real HYG catalog rendered as point sprites. Each star is one
     vertex; the vertex shader projects (RA, Dec) → world direction →
     camera screen position with the same focal/pitch/roll as
     makeRay(), and the fragment shader renders a NASA-orbital-style
     splat (sharp core + tight halo + screen-aligned diffraction cross
     on the brightest dozen stars) using gl_PointCoord. Drawn
     additively after the aurora pass. */
  const STAR_VS = `#version 300 es
  precision highp float;
  in vec4 a_star;          // (raDeg, decDeg, mag, bv)
  uniform vec2  u_res;
  uniform mat3  u_skyRot;
  out float v_br;
  out vec3  v_tint;
  out float v_h3;
  out float v_isBright;

  void main() {
    float ra  = radians(a_star.x);
    float dec = radians(a_star.y);
    float mag = a_star.z;
    float bv  = a_star.w;

    // celestial direction → world direction (transpose = inverse for
    // an orthogonal rotation; u_skyRot maps world → catalog frame)
    vec3 starDir = vec3(cos(dec) * cos(ra), sin(dec), cos(dec) * sin(ra));
    vec3 wd = transpose(u_skyRot) * starDir;

    // mirror makeRay's pitch/roll/focal exactly (yaw is 0)
    const float pitch = 0.55;
    const float roll  = -0.06;
    const float focal = 1.35;

    // undo pitch (rotateX by -pitch)
    float cp = cos(pitch), sp = sin(pitch);
    vec3 rdCam = vec3(
      wd.x,
      wd.y * cp + wd.z * sp,
      -wd.y * sp + wd.z * cp
    );
    if (rdCam.z <= 0.001) { gl_Position = vec4(2, 2, 2, 1); return; }

    // planet occlusion: skip stars whose ray-from-camera comes too
    // close to the planet. Camera at (0, R+0.13, 0), R = 1. The
    // discard margin grows with brightness because bright stars have
    // bigger sprites — when their centre sits just above the limb the
    // bottom half of the sprite would otherwise visibly cut into the
    // dark planet surface.
    vec3 camPos = vec3(0.0, 1.13, 0.0);
    float dotcw = dot(camPos, wd);
    if (dotcw < 0.0) {
      float dmin2 = dot(camPos, camPos) - dotcw * dotcw;
      // mag ≤ 0 → ~14% margin (~10° angular), mag ≥ 4 → ~4% (~5°).
      // The base 4% is what hides the sprite *tail* of dim stars at
      // the limb — without it the lower half of a 10-15 px sprite
      // would peek into the dark planet area below the bright arc.
      float occMargin = 0.04 + max(0.0, 4.0 - mag) * 0.025;
      float occR = 1.0 + occMargin;
      if (dmin2 < occR * occR) { gl_Position = vec4(2, 2, 2, 1); return; }
    }

    // project camera-space dir to the view plane, then undo roll
    vec2 pp = rdCam.xy / rdCam.z * focal;
    float cr = cos(roll), sr = sin(roll);
    vec2 p = vec2(pp.x * cr + pp.y * sr, -pp.x * sr + pp.y * cr);

    // p was originally formed via /u_res.y (height-normalised) → NDC
    float aspect = u_res.x / u_res.y;
    gl_Position = vec4(p.x * 2.0 / aspect, p.y * 2.0, 0.0, 1.0);

    // brightness curve (linear-in-mag — perception is already log).
    // Mapped so mag 0 ≈ 1.0 and mag 6.5 ≈ 0.10, the naked-eye limit
    // we include in the catalogue. Floor at 0.08 keeps the dimmest
    // catalog entries faintly visible without saturating to flat.
    v_br = clamp(0.10 + (6.5 - mag) * 0.14, 0.08, 1.0);

    // B-V color index → cool-to-warm RGB tint. Endpoints pushed
    // further so the colour stamp on each star is unmistakable:
    // hot stars are clearly blue, cool stars clearly orange-red.
    float bvT = clamp((bv + 0.4) / 2.5, 0.0, 1.0);
    v_tint = mix(vec3(0.30, 0.50, 1.00), vec3(1.00, 0.55, 0.25), bvT);

    // per-star twinkle hash from (ra, dec)
    v_h3 = fract(sin(dot(vec2(ra, dec), vec2(127.1, 311.7))) * 43758.5453);

    // diffraction cross only on the ~12 brightest stars in the sky
    // (mag ≤ 1.0 ≈ Sirius, Canopus, Arcturus, Vega, Capella, Rigel,
    // Procyon, Achernar, Betelgeuse, Hadar, Altair, Aldebaran). All
    // others render as clean dots, as in NASA orbital imagery.
    v_isBright = step(mag, 1.0);

    // larger sprites for brighter stars (browser caps PointSize, but
    // anything below 64 is safe everywhere)
    // NASA orbital-footage look: tight sprites, dim stars stay
    // pinpoint, brights modest. Real cameras above the atmosphere
    // don't bloom stars into big halos.
    gl_PointSize = mix(4.0, 28.0, pow(v_br, 1.6));
  }`;

  const STAR_FS = `#version 300 es
  precision highp float;
  uniform float u_time;
  in float v_br;
  in vec3  v_tint;
  in float v_h3;
  in float v_isBright;
  out vec4 fragColor;

  void main() {
    vec2 d = gl_PointCoord - vec2(0.5);
    float r2 = dot(d, d);

    // NASA orbital look: sharp white-hot core, tight modest halo,
    // dead-still (no atmospheric scintillation).
    float core = exp(-r2 * 600.0) * (1.0 + 9.0 * v_br);
    float halo = exp(-r2 * 100.0) * pow(v_br, 2.0) * 0.7;

    // diffraction cross — only on the dozen brightest stars, and
    // tighter / dimmer than the photography-style version
    float sp = 0.0;
    if (v_isBright > 0.5) {
      sp = (exp(-abs(d.x) * 16.0) * exp(-abs(d.y) * 100.0)
          + exp(-abs(d.y) * 16.0) * exp(-abs(d.x) * 100.0))
         * v_br * 0.35 * exp(-r2 * 18.0);
    }

    // No twinkle: from orbit there is no atmosphere to scintillate
    // the light, so stars are perfectly steady in real space photos.
    // Colour lives in the halo + cross; core stays mostly white-hot.
    vec3 col = mix(vec3(1.0), v_tint, 0.15) * core
             + v_tint * (halo + sp);
    // tone map so additive blend with the already-tone-mapped aurora
    // pass stays in the same dynamic range (bright stars don't burn
    // a flat white square into the buffer)
    col = 1.0 - exp(-col * 1.20);
    fragColor = vec4(col, 1.0);
  }`;

  const starProg = (() => {
    const v = compile(gl.VERTEX_SHADER, STAR_VS);
    const f = compile(gl.FRAGMENT_SHADER, STAR_FS);
    if (!v || !f) return null;
    const p = gl.createProgram();
    gl.attachShader(p, v);
    gl.attachShader(p, f);
    gl.bindAttribLocation(p, 0, "a_star");
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      console.warn("star program link error:", gl.getProgramInfoLog(p));
      return null;
    }
    return p;
  })();
  const uStarRes = starProg && gl.getUniformLocation(starProg, "u_res");
  const uStarSkyRot = starProg && gl.getUniformLocation(starProg, "u_skyRot");
  const uStarTime = starProg && gl.getUniformLocation(starProg, "u_time");
  let starVbo = null;
  let starCount = 0;

  // Sky orientation: place the celestial north pole (Polaris) in the
  // upper part of the visible sky patch above the limb. The catalog
  // uses starDir = (cos(Dec)cos(RA), sin(Dec), cos(Dec)sin(RA)), so
  // its polar axis is +y. Build a rotation R = transpose(u_skyRot)
  // that maps catalog (0, 1, 0) → a world direction lying inside the
  // camera's visible cone. With the camera pitched down by 0.55 rad
  // and an FOV-y of about 40°, we aim Polaris at screen position
  // p ≈ (0, 0.5) — top centre of the patch. Constellations near
  // Polaris (Ursa Minor, parts of Ursa Major and Cassiopeia) then sit
  // around it in the natural sky orientation.
  function buildSkyRot() {
    const pitch = 0.55;
    const cp = Math.cos(pitch),
      sp = Math.sin(pitch);
    // target Polaris screen position
    const py = 0.5,
      pz = 1.35;
    const len = Math.hypot(py, pz);
    const vy = py / len,
      vz = pz / len; // camera-frame direction for Polaris
    // rotate back through pitch to get world direction
    const wpy = vy * cp - vz * sp;
    const wpz = vy * sp + vz * cp;
    // R columns: col 0 keeps catalog +x at world +x, col 1 is the
    // world direction of Polaris, col 2 = col0 × col1
    const c0x = 1,
      c0y = 0,
      c0z = 0;
    const c1x = 0,
      c1y = wpy,
      c1z = wpz;
    const c2x = c0y * c1z - c0z * c1y;
    const c2y = c0z * c1x - c0x * c1z;
    const c2z = c0x * c1y - c0y * c1x;
    // u_skyRot = transpose(R); columns of u_skyRot = rows of R
    return new Float32Array([
      c0x, c1x, c2x,
      c0y, c1y, c2y,
      c0z, c1z, c2z,
    ]);
  }
  const skyRotMat = buildSkyRot();

  async function loadStarCatalog() {
    if (!starProg) return;
    let ab;
    try {
      const res = await fetch("/stars.bin", { cache: "force-cache" });
      if (!res.ok) throw new Error(`stars.bin: ${res.status}`);
      ab = await res.arrayBuffer();
    } catch (e) {
      console.warn("star catalog unavailable, stars skipped", e);
      return;
    }
    const view = new DataView(ab);
    const n = (ab.byteLength / 8) | 0;
    const data = new Float32Array(n * 4);
    function unq(raw, lo, hi) {
      return lo + (raw / 65535) * (hi - lo);
    }
    for (let i = 0; i < n; i++) {
      data[i * 4 + 0] = unq(view.getUint16(i * 8 + 0, true), 0, 360); // RA deg
      data[i * 4 + 1] = unq(view.getUint16(i * 8 + 2, true), -90, 90); // Dec
      data[i * 4 + 2] = unq(view.getUint16(i * 8 + 4, true), -2, 6.5); // mag
      data[i * 4 + 3] = unq(view.getUint16(i * 8 + 6, true), -0.5, 2.5); // BV
    }
    starVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, starVbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    starCount = n;
    // restore ARRAY_BUFFER + attrib config so the aurora pass on the
    // very next frame reads from `buf` (fullscreen triangle), not from
    // the freshly-uploaded starVbo
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    forceDraw = true;
  }
  loadStarCatalog();

  // resolution: cap DPR at 1.75. Quality stays at 1.0 — the previous
  // adaptive governor would resize the canvas every 2.5s when frame
  // time sat near the threshold, and each resize shifted the procedural
  // star cells' sub-pixel positions, making stars blink between two
  // alternating states. Modern hardware handles 1.0 fine.
  const quality = 1.0;
  let forceDraw = true;
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.75) * quality;
    const rect = heroEl.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
      gl.uniform2f(uRes, w, h);
      forceDraw = true;
    }
  }
  let resizeT = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(resize, 100);
  });
  resize();

  /* ---- globe rotation ----
     Press inside the hero and drag to rotate. Velocity is measured in
     ground-units/second from real event timing, so releasing mid-swipe
     throws the globe with true momentum that damps out exponentially. */
  let orbX = 0;
  let orbY = 0;
  let rox = 0;
  let roy = 0;
  let velX = 0;
  let velY = 0;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let lastT = 0;
  let curX = 0;
  let curY = 0;
  let curT = 0;
  // Once a drag moves past this distance from the press point, we
  // consider the user to be "rotating" the globe — tagged on <body> so
  // CSS can fade the hero copy + header out of the way. The class
  // sticks until the About section scrolls into view (handled below),
  // at which point we clear it so the chrome reappears. A pure click
  // (no movement) stays below the threshold and leaves the chrome alone.
  let dragStartX = 0;
  let dragStartY = 0;
  const ROTATE_THRESHOLD = 8;
  const VMAX = 6.0;

  heroEl.addEventListener("pointerdown", (e) => {
    dragging = true;
    lastX = curX = dragStartX = e.clientX;
    lastY = curY = dragStartY = e.clientY;
    lastT = curT = e.timeStamp;
    velX = velY = 0;
    document.documentElement.style.cursor = "grabbing";
  });
  window.addEventListener(
    "pointermove",
    (e) => {
      if (!dragging) return;
      curX = e.clientX;
      curY = e.clientY;
      curT = e.timeStamp;
      if (
        !document.body.classList.contains("is-rotating") &&
        Math.hypot(curX - dragStartX, curY - dragStartY) > ROTATE_THRESHOLD
      ) {
        document.body.classList.add("is-rotating");
      }
    },
    { passive: true },
  );
  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    // NOTE: we intentionally do NOT clear `body.is-rotating` here.
    // Once the user starts exploring the sphere the chrome stays out
    // of the way. The IntersectionObserver on #about (below) clears
    // the class when they scroll down to the About section, bringing
    // the chrome back.
    document.documentElement.style.cursor = "";
    if (e.timeStamp - curT > 120) {
      velX = velY = 0;
    }
    const v = Math.hypot(velX, velY);
    if (v > VMAX) {
      velX *= VMAX / v;
      velY *= VMAX / v;
    }
  }
  window.addEventListener("pointerup", endDrag);
  window.addEventListener("pointercancel", endDrag);
  canvas.style.cursor = "grab";
  canvas.style.touchAction = "none";

  let running = true;
  document.addEventListener("visibilitychange", () => {
    running = !document.hidden;
    if (running) {
      prev = performance.now();
      requestAnimationFrame(frame);
    }
  });

  // page scroll rotates the globe: scrolling down nudges orbY forward,
  // scrolling back up unwinds it. Adds to the target only, so the
  // follow-spring smooths it and momentum stays separate.
  let lastScroll = window.scrollY;
  window.addEventListener(
    "scroll",
    () => {
      const dy = window.scrollY - lastScroll;
      lastScroll = window.scrollY;
      orbY -= dy * 0.005;
    },
    { passive: true },
  );

  // scroll gestures keep the compositor busy, not our shader — track them
  // so the quality governor doesn't blame us for transient hitches
  let lastWheel = -1e9;
  window.addEventListener(
    "wheel",
    () => {
      lastWheel = performance.now();
    },
    { passive: true },
  );

  // stop drawing entirely when the hero scrolls out of view
  let onScreen = true;
  if (typeof IntersectionObserver !== "undefined") {
    new IntersectionObserver((es) => {
      onScreen = es[0].isIntersecting;
    }).observe(heroEl);

    // exit "view mode" when the About section comes into view: the
    // user has clearly moved past the hero, so bring chrome back
    const aboutEl = document.getElementById("about");
    if (aboutEl) {
      new IntersectionObserver((es) => {
        if (es[0].isIntersecting) {
          document.body.classList.remove("is-rotating");
        }
      }).observe(aboutEl);
    }
  }

  const t0 = performance.now();
  let prev = t0;

  let lastRox = 1e9;
  let lastRoy = 1e9;
  let viewLevel = 0; // 0..1, eased toward 1 in view mode for palette shift
  let detail = 1.0;
  function frame(now) {
    if (!running) return;
    const dt = Math.min((now - prev) / 1000, 0.05);
    prev = now;

    // apply the coalesced drag delta — once per frame, not per event
    if (dragging && (curX !== lastX || curY !== lastY)) {
      const kk = 5.0 / heroEl.getBoundingClientRect().height;
      const ds = Math.max(curT - lastT, 1) / 1000;
      const gx = -(curX - lastX) * kk;
      const gy = (curY - lastY) * kk;
      orbX += gx;
      orbY += gy;
      velX += (gx / ds - velX) * 0.3;
      velY += (gy / ds - velY) * 0.3;
      lastX = curX;
      lastY = curY;
      lastT = curT;
    }

    if (!dragging) {
      orbX += velX * dt;
      orbY += velY * dt;
      const damp = Math.exp(-dt * 1.25);
      velX *= damp;
      velY *= damp;
      if (!reduced) orbY += dt * 0.1; // steady orbital flyover drift
    }
    const FOLLOW = 3.2;
    const k = 1 - Math.exp(-dt * FOLLOW);
    const pRox = rox;
    const pRoy = roy;
    rox += (orbX - rox) * k;
    roy += (orbY - roy) * k;

    // motion-adaptive detail
    const speed = Math.hypot(rox - pRox, roy - pRoy) / Math.max(dt, 1e-4);
    let dTarget = 1.0 - 0.4 * Math.min(speed / 3.0, 1.0);
    if (now - lastWheel < 250) dTarget = Math.min(dTarget, 0.6);
    const dRate = dTarget < detail ? 12 : 3;
    detail += (dTarget - detail) * Math.min(dt * dRate, 1);

    // keep coordinates small forever (noise field is periodic at 2560)
    if (Math.abs(orbX) > 1280) {
      const s = orbX > 0 ? 2560 : -2560;
      orbX -= s;
      rox -= s;
      lastRox -= s;
    }
    if (Math.abs(orbY) > 1280) {
      const s = orbY > 0 ? 2560 : -2560;
      orbY -= s;
      roy -= s;
      lastRoy -= s;
    }

    const moved = Math.abs(rox - lastRox) + Math.abs(roy - lastRoy) > 1e-4;
    if (onScreen && (!reduced || moved || forceDraw)) {
      lastRox = rox;
      lastRoy = roy;
      forceDraw = false;
      // ease view-mode level toward 1 when the user is exploring the
      // sphere (body.is-rotating) and back toward 0 otherwise
      const viewTarget = document.body.classList.contains("is-rotating")
        ? 1
        : 0;
      const viewK = 1 - Math.exp(-dt * 2.5);
      viewLevel += (viewTarget - viewLevel) * viewK;
      const tNow = reduced ? 40.0 : ((now - t0) / 1000) % 5120;
      gl.uniform1f(uTime, tNow);
      gl.uniform2f(uOrbit, rox, roy);
      gl.uniform1f(uDetail, detail);
      gl.uniform1f(uView, viewLevel);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // catalog stars (GL_POINTS, additive on top of the aurora pass)
      if (starVbo && starCount > 0) {
        gl.useProgram(starProg);
        gl.uniform2f(uStarRes, canvas.width, canvas.height);
        gl.uniformMatrix3fv(uStarSkyRot, false, skyRotMat);
        gl.uniform1f(uStarTime, tNow);
        gl.bindBuffer(gl.ARRAY_BUFFER, starVbo);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE); // additive
        gl.drawArrays(gl.POINTS, 0, starCount);
        gl.disable(gl.BLEND);
        // restore for next frame
        gl.useProgram(prog);
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      }
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
