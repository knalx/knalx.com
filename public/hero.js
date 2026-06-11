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
  const uOrbit = gl.getUniformLocation(prog, "u_orbit");
  const uDetail = gl.getUniformLocation(prog, "u_detail");
  const uMotion = gl.getUniformLocation(prog, "u_motion");

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

  // resolution: cap DPR + adaptive `quality` for slower GPUs
  let quality = 1.0;
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
  const VMAX = 6.0;

  heroEl.addEventListener("pointerdown", (e) => {
    dragging = true;
    lastX = curX = e.clientX;
    lastY = curY = e.clientY;
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
    },
    { passive: true },
  );
  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
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
  }

  const t0 = performance.now();
  let prev = t0;
  let emaDt = 1 / 60;
  let lastQChange = 0;
  // smoothness comes from LOCKING to the display refresh rate, not raw fps.
  // Estimate the refresh once warmed up, then trade resolution until locked.
  let refresh = 60;
  let rateSamples = [];
  let qCeil = 1.0;
  let lastUp = 0;
  let ceilSetAt = 0;

  let lastRox = 1e9;
  let lastRoy = 1e9;
  let detail = 1.0;
  function frame(now) {
    if (!running) return;
    const dt = Math.min((now - prev) / 1000, 0.05);
    prev = now;

    if (rateSamples !== null && now - t0 > 1500) {
      rateSamples.push(dt);
      if (rateSamples.length >= 40) {
        rateSamples.sort((a, b) => a - b);
        const est = 1 / rateSamples[2]; // 3rd-fastest: outlier-proof
        const rates = [60, 75, 90, 120, 144, 165, 240];
        refresh = rates.reduce(
          (b, r) => (Math.abs(r - est) < Math.abs(b - est) ? r : b),
          60,
        );
        if (est < 54) refresh = 60;
        rateSamples = null;
      }
    }

    emaDt += (dt - emaDt) * 0.05;
    const scrolling = now - lastWheel < 1200;
    if (now - t0 > 2000 && now - lastQChange > 2500 && rateSamples === null) {
      if (emaDt > 1 / (0.92 * refresh) && quality > 0.45 && !scrolling) {
        if (now - lastUp < 8000) {
          qCeil = quality;
          ceilSetAt = now;
        }
        quality *= 0.85;
        lastQChange = now;
        emaDt = 1 / refresh;
        resize();
      } else if (emaDt < 1 / (0.97 * refresh)) {
        if (now - ceilSetAt > 60000) qCeil = 1.0;
        const next = Math.min(quality / 0.85, 1.0);
        if (next <= qCeil + 1e-3 && next > quality) {
          quality = next;
          lastUp = now;
          lastQChange = now;
          emaDt = 1 / refresh;
          resize();
        }
      }
    }

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
      gl.uniform1f(uTime, reduced ? 40.0 : ((now - t0) / 1000) % 5120);
      gl.uniform2f(uOrbit, rox, roy);
      gl.uniform1f(uDetail, detail);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
