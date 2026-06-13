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
     camera screen position with the same focal/pitch/roll as makeRay(),
     rotates the whole sphere with the globe (u_orbit), and fades stars
     smoothly at the planet limb and frame edges. The fragment shader
     draws a plain flat dot via gl_PointCoord. Drawn additively after
     the aurora pass. The sphere is oriented so the Big Dipper (Ursa
     Major) sits framed above the limb at startup (see buildSkyRot). */
  const STAR_VS = `#version 300 es
  precision highp float;
  in vec4 a_star;          // (raDeg, decDeg, mag, bv)
  uniform vec2  u_res;
  uniform mat3  u_skyRot;
  uniform vec2  u_orbit;   // (rox, roy) — shared globe rotation
  out float v_br;
  out vec3  v_tint;

  void main() {
    float ra  = radians(a_star.x);
    float dec = radians(a_star.y);
    float mag = a_star.z;
    float bv  = a_star.w;

    // hide the faintest stars: their sprites are only a few px wide, so
    // during rotation their sub-pixel position shifts and they flicker.
    // The catalog runs to mag 6.5; culling everything fainter than this
    // cutoff removes the blinking swarm and keeps the recognizable sky.
    // Set to 5.5 for a denser field like the orbital reference — the soft
    // glow core steadies faint sprites enough to keep flicker in check.
    const float STAR_MAG_CUTOFF = 5.5;
    if (mag > STAR_MAG_CUTOFF) { gl_Position = vec4(2, 2, 2, 1); return; }

    // celestial direction → world direction (transpose = inverse for
    // an orthogonal rotation; u_skyRot maps world → catalog frame)
    vec3 starDir = vec3(cos(dec) * cos(ra), sin(dec), cos(dec) * sin(ra));
    vec3 wd = transpose(u_skyRot) * starDir;

    // share the globe's motion: the aurora/surface scrolls by u_orbit
    // under a fixed camera, so to move *with* it the celestial sphere
    // rotates instead — orbital drift + scroll (u_orbit.y) pitches the
    // sky about world-X, horizontal drag (u_orbit.x) yaws it about
    // world-Y. ORBIT_SCALE = 2π/160 makes the orbit's 2560-unit wrap
    // (see the JS frame loop) exactly 16 turns, so the field wraps
    // seamlessly in lockstep with the aurora — no visible jump. The
    // sign is negated so the sphere turns *with* the scrolling surface
    // rather than against it (the aurora offsets its texture by +u_orbit,
    // which slides features the opposite way a positive rotation would).
    const float ORBIT_SCALE = -0.0392699082;
    float ax = u_orbit.x * ORBIT_SCALE;
    float ay = u_orbit.y * ORBIT_SCALE;
    float cax = cos(ax), sax = sin(ax);
    wd = vec3(wd.x * cax + wd.z * sax, wd.y, -wd.x * sax + wd.z * cax);
    float cay = cos(ay), say = sin(ay);
    wd = vec3(wd.x, wd.y * cay - wd.z * say, wd.y * say + wd.z * cay);

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

    // planet occlusion. Camera at (0, R+0.13, 0), R = 1. Rather than a
    // hard cull at the limb — which makes a star pop out/in within one
    // frame as the sky rotates — fade its brightness smoothly over a
    // small band as it crosses the limb. occR is just above the planet
    // radius; the star is fully hidden below it and fully lit a little
    // above, with a soft ramp between so it dissolves rather than blinks.
    float occFade = 1.0;
    vec3 camPos = vec3(0.0, 1.13, 0.0);
    float dotcw = dot(camPos, wd);
    if (dotcw < 0.0) {
      float dmin = sqrt(max(dot(camPos, camPos) - dotcw * dotcw, 0.0));
      // fade sits just above the limb (R = 1): stars stay lit close to
      // the horizon, then dissolve in a thin band before they reach the
      // bright planet edge, so none bleed onto the surface.
      float occR = 1.0 + 0.02;
      occFade = smoothstep(occR, occR + 0.03, dmin);
      if (occFade <= 0.0) { gl_Position = vec4(2, 2, 2, 1); return; }
    }

    // project camera-space dir to the view plane, then undo roll.
    // makeRay() rotates screen coords by R(-roll) to build its ray, so
    // the world→screen inverse here must apply R(+roll). (The previous
    // signs applied R(-roll), tilting the star field ~2·roll off the
    // planet and misaligning the occlusion shadow.)
    vec2 pp = rdCam.xy / rdCam.z * focal;
    float cr = cos(roll), sr = sin(roll);
    vec2 p = vec2(pp.x * cr - pp.y * sr, pp.x * sr + pp.y * cr);

    // p was originally formed via /u_res.y (height-normalised) → NDC
    float aspect = u_res.x / u_res.y;
    vec2 ndc = vec2(p.x * 2.0 / aspect, p.y * 2.0);
    gl_Position = vec4(ndc, 0.0, 1.0);

    // edge fade: a GL_POINTS sprite is clipped the instant its centre
    // crosses the NDC border, so without this a star blinks out at the
    // frame edge. Ramp brightness to zero just before the border so it
    // dims away instead of popping.
    float edgeFade = 1.0 - smoothstep(0.88, 1.0, max(abs(ndc.x), abs(ndc.y)));

    // brightness curve (linear-in-mag — perception is already log).
    // Mapped so mag 0 ≈ 1.0 and mag 6.5 ≈ 0.10, the naked-eye limit
    // we include in the catalogue. Floor at 0.08 keeps the dimmest
    // catalog entries faintly visible without saturating to flat.
    v_br = clamp(0.18 + (6.5 - mag) * 0.16, 0.12, 1.0) * occFade * edgeFade;

    // B-V color index → cool-to-warm RGB tint. Endpoints pushed
    // further so the colour stamp on each star is unmistakable:
    // hot stars are clearly blue, cool stars clearly orange-red.
    float bvT = clamp((bv + 0.4) / 2.5, 0.0, 1.0);
    v_tint = mix(vec3(0.30, 0.50, 1.00), vec3(1.00, 0.55, 0.25), bvT);

    // larger sprites for brighter stars (browser caps PointSize, but
    // anything below 64 is safe everywhere). The fragment shader draws a
    // tight core + soft halo, so brights need extra sprite pixels for the
    // glow to bloom into while dim stars stay near-pinpoint.
    gl_PointSize = mix(3.0, 13.0, pow(v_br, 1.4));
  }`;

  const STAR_FS = `#version 300 es
  precision highp float;
  in float v_br;
  in vec3  v_tint;
  out vec4 fragColor;

  void main() {
    // photographic star: a tight bright core fading into a soft halo, the
    // way a camera exposure from orbit records a point of light (no spike,
    // no twinkle). Additive blend (ONE,ONE), so we output colour × luminance.
    float d = length(gl_PointCoord - vec2(0.5)) * 2.0; // 0 centre → 1 edge
    float core = 1.0 - smoothstep(0.0, 0.32, d);       // bright centre
    float halo = exp(-d * 3.0) * 0.65;                 // soft falloff tail
    float intensity = core + halo;
    vec3 col = mix(vec3(1.0), v_tint, 0.4);            // mostly white, faint tint
    fragColor = vec4(col * v_br * intensity, 1.0);
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
  const uStarOrbit = starProg && gl.getUniformLocation(starProg, "u_orbit");
  let starVbo = null;
  let starCount = 0;

  // Sky orientation: frame the Big Dipper (Ursa Major) horizontally in
  // the thin sky band above the limb at startup. The catalog uses
  // starDir = (cos(Dec)cos(RA), sin(Dec), cos(Dec)sin(RA)); u_skyRot is
  // transpose(R) where R maps catalog → world. Because the camera looks
  // down (pitch 0.55), only a ~15°×67° strip of sky is visible and
  // unoccluded, and the projection stretches hard near the top — so the
  // pole region and Ursa Minor can't share the frame with the Dipper.
  // This matrix was solved numerically to seat the seven Dipper stars
  // (Dubhe→Alkaid) centred and roughly level in that band; see
  // scripts/ for the solver. Stars rotate from here via u_orbit (drift
  // + drag), so this is just the initial pose.
  function buildSkyRot() {
    // column-major u_skyRot = transpose(R)
    return new Float32Array([
      -0.016374, 0.404540, 0.914374,
      0.966463, 0.240797, -0.089246,
      -0.256283, 0.882248, -0.394912,
    ]);
  }
  const skyRotMat = buildSkyRot();

  let running = true;
  let looping = false;
  let prev = 0;
  // (re)start the rAF loop if it has parked itself. In reduced-motion
  // mode the scene is static, so frame() stops scheduling once
  // everything has settled (see its tail); any input that changes the
  // scene must call wake() to resume drawing. In normal motion the loop
  // never parks, so wake() is a no-op there.
  function wake() {
    if (looping || !running) return;
    looping = true;
    prev = performance.now();
    requestAnimationFrame(frame);
  }

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
    wake();
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
      wake();
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
    wake();
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

  document.addEventListener("visibilitychange", () => {
    running = !document.hidden;
    if (running) wake();
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
      wake();
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
      wake();
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
          wake();
        }
      }).observe(aboutEl);
    }
  }

  const t0 = performance.now();
  prev = t0;

  let lastRox = 1e9;
  let lastRoy = 1e9;
  let viewLevel = 0; // 0..1, eased toward 1 in view mode for palette shift
  let detail = 1.0;
  function frame(now) {
    if (!running) {
      looping = false;
      return;
    }
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
        gl.uniform2f(uStarOrbit, rox, roy);
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

    // Normal motion always animates. Reduced motion is static, so park
    // the loop once nothing is still in flight — drag, momentum, the
    // follow-spring, detail/view easing — and let wake() resume it.
    if (!reduced) {
      requestAnimationFrame(frame);
      return;
    }
    const viewTarget = document.body.classList.contains("is-rotating")
      ? 1
      : 0;
    const settling =
      dragging ||
      Math.abs(velX) > 1e-3 ||
      Math.abs(velY) > 1e-3 ||
      Math.abs(orbX - rox) > 1e-4 ||
      Math.abs(orbY - roy) > 1e-4 ||
      Math.abs(detail - 1.0) > 1e-3 ||
      Math.abs(viewLevel - viewTarget) > 1e-3;
    if (settling) requestAnimationFrame(frame);
    else looping = false;
  }
  wake();
})();
