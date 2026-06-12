#version 300 es
precision highp float;

out vec4 fragColor;

uniform vec2  u_res;
uniform float u_time;
uniform vec2  u_orbit;   // accumulated surface rotation (drag + orbital drift)
uniform float u_detail;  // 0.6..1.0 — step budget, lowered during fast motion
uniform float u_motion;  // 1 = animate, 0 = reduced motion
uniform float u_view;    // 0 = normal palette, 1 = view-mode hue spread + drift

/* ---------- noise ---------- */
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
uniform sampler2D u_noise;  // 256x256 white-noise lattice, REPEAT + LINEAR

/* value noise via ONE texture fetch: the cubic correction on f makes
   hardware bilinear filtering reproduce exactly the smoothstep-blended
   lattice the old arithmetic version computed with 4 hashes + 3 mixes.
   This is the single biggest perf lever in the whole shader. */
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return texture(u_noise, (i + f + 0.5) / 256.0).r;
}

/* ---------- 3D scene ----------
   A real camera floats above a real sphere. The aurora lives in a thin
   spherical shell [R+ALT0 .. R+ALT0+ALTH] and is ray-marched, so curtains
   physically stand on the planet, converge to the horizon, and pile up
   at the limb — true perspective and scale. */
const float R     = 1.0;      // planet radius
const float ALT0  = 0.012;    // aurora base altitude
const float ALTH  = 0.105;    // aurora band thickness
const int   STEPS = 40;

// Interleaved Gradient Noise — structured dither for the march offset.
// Unlike white noise it distributes sampling error evenly, so smooth
// gradients don't show grain.
float ign(vec2 px) {
  return fract(52.9829189 * fract(dot(px, vec2(0.06711056, 0.00583715))));
}

// ray vs sphere centered at origin -> (tNear, tFar), or (-1,-1) on miss
vec2 sphere(vec3 ro, vec3 rd, float rr) {
  float b = dot(ro, rd);
  float h = b * b - (dot(ro, ro) - rr * rr);
  if (h < 0.0) return vec2(-1.0);
  h = sqrt(h);
  return vec2(-b - h, -b + h);
}

// build a camera ray for screen point px
vec3 makeRay(vec2 px, float yaw, float pitch, float roll) {
  float cr = cos(roll), sr = sin(roll);
  px = mat2(cr, -sr, sr, cr) * px;
  vec3 rd = normalize(vec3(px, 1.35));            // 1.35 = focal length (FOV)
  float cp = cos(pitch), sp = sin(pitch);          // pitch > 0 looks down
  rd = vec3(rd.x, rd.y * cp - rd.z * sp, rd.y * sp + rd.z * cp);
  float cy = cos(yaw), sy = sin(yaw);
  rd = vec3(rd.x * cy + rd.z * sy, rd.y, -rd.x * sy + rd.z * cy);
  return rd;
}

/* curtain pattern on the ground coordinates g (the sphere surface).
   Sheets are elongated along g.y = depth, so they run away from the
   camera and converge in perspective.
   Returns vec3(sharp lanes, soft glowing fog, hue variation). */
vec3 curtain(vec2 g, float t) {
  // curling flow: a time-animated domain warp folds and swirls the sheets
  // NOTE: every g/t coefficient is on a 0.1 / 0.05 grid, making the whole
  // field periodic — the orbit wraps at 2560 and time at 5120 with zero
  // seam, so float precision can never decay over long sessions
  vec2 wp = vec2(vnoise(g * 0.50 + vec2(0.0,  t * 0.10)),
                 vnoise(g * 0.50 + vec2(7.3, -t * 0.05)));
  g += (wp - 0.5) * 2.2;

  // slow large-scale bending of the sheets
  float b = vnoise(g * 0.30 + vec2(t * 0.05, 0.0));
  float x = g.x + b * 2.6;

  // the sheet itself — long in depth, thin across, hard contrast
  float line = pow(vnoise(vec2(x * 1.6 + t * 0.25, g.y * 0.20)), 6.0) * 3.1;
  // pow(,6) makes most samples negligible — skip the striation noises there
  if (line > 0.02) {
    // two octaves of striations: coarse bundles + fine crisp filaments
    line *= 0.45 + 0.80 * vnoise(vec2(x * 4.5  - t * 0.50, g.y * 0.8));
    line *= 0.50 + 0.80 * vnoise(vec2(x * 11.0 + t * 0.85, g.y * 1.7));
  }
  // patchy global activity so it is not uniform everywhere
  float act = vnoise(g * 0.20 + vec2(3.7, t * 0.05));
  line *= 0.35 + 0.95 * act;

  // soft luminous haze hugging the lanes — it shares the same warped
  // domain, so it curls with the curtains instead of flattening them
  float fog = pow(vnoise(vec2(x * 0.8 + t * 0.15, g.y * 0.30)), 2.0)
            * (0.25 + 0.75 * act);
  return vec3(line, fog, act);   // act doubles as a slow hue drift per region
}

/* ---------- HSV helpers (Iñigo Quílez) ----------
   Used by view mode to rotate the hue of the aurora palette per-region
   and over time, so the curtains drift through a wider spectrum than
   the green/teal/magenta default. */
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 p  = (gl_FragCoord.xy - 0.5 * u_res) / u_res.y;
  float t = u_time * u_motion;

  /* ---------- camera ---------- */
  vec3 ro = vec3(0.0, R + 0.13, 0.0);              // ~800 km up
  vec3 rd = makeRay(p, 0.0, 0.55, -0.06);

  /* ---------- geometry ---------- */
  vec2 hOut = sphere(ro, rd, R + ALT0 + ALTH);     // aurora shell
  vec2 hPl  = sphere(ro, rd, R);                   // planet
  bool hitPlanet = hPl.x > 0.0;

  float b1   = dot(ro, rd);
  float dmin = (b1 < 0.0) ? sqrt(max(dot(ro, ro) - b1 * b1, 0.0)) : length(ro);
  float lx   = dmin - R;                           // grazing height above surface

  // analytic anti-aliasing of the silhouette: a ~1px soft coverage mask
  float edgeW   = max(fwidth(lx), 1e-5);
  float skyMask = smoothstep(-edgeW, edgeW, lx);   // 0 = planet, 1 = sky

  vec3 col = vec3(0.0);

  /* ---------- volumetric aurora ---------- */
  if (hOut.y > 0.0) {
    float t0 = max(hOut.x, 0.0);
    // pixels straddling the silhouette march the FULL shell and occlude
    // each sample softly, so the aurora has no hard step at the edge
    bool nearEdge = abs(lx) < edgeW * 2.5;
    float tP = hitPlanet ? hPl.x : 1e9;
    // planet-hitting rays: stop at the aurora BASE shell, not the surface —
    // every step in the empty gap below the band was wasted work
    float t1;
    if (hitPlanet && !nearEdge) {
      vec2 hIn = sphere(ro, rd, R + ALT0);
      t1 = (hIn.x > 0.0) ? hIn.x : hPl.x;
    } else {
      t1 = hOut.y;
    }
    // adaptive sampling: short steep paths (most of the screen) need far
    // fewer steps than long grazing paths at the horizon; u_detail trims
    // the budget during fast rotation, when motion masks the difference
    float span = t1 - t0;
    int   n    = int(clamp(span * 55.0 * u_detail, 14.0, float(STEPS) * u_detail));
    float stepLen = span / float(n);
    float tc = t0 + stepLen * ign(gl_FragCoord.xy);      // ordered jitter, no grain
    // distance fade computed incrementally: one exp per RAY, not per step
    float fexp  = exp(-(tc - t0) * 1.1);
    float fmul  = exp(-stepLen * 1.1);
    vec3 acc = vec3(0.0);
    for (int i = 0; i < STEPS; i++) {
      if (i >= n) break;
      vec3 w = ro + rd * tc;
      float wl = length(w);
      float a = (wl - (R + ALT0)) / ALTH;                // 0..1 inside the band
      if (a > 0.0 && a < 1.0) {
        vec3 cf = curtain(w.xz * (16.0 / wl) + u_orbit, t);
        // lanes: hard bright base, long fading top
        float densL = cf.x * smoothstep(0.0, 0.10, a) * exp(-a * 3.2);
        // fog: stays low, hugging the base of the curtains
        float densF = cf.y * smoothstep(0.0, 0.18, a) * exp(-a * 5.5) * 0.42;
        float fade = 0.25 + 0.75 * fexp;                     // distance dims
        fade *= (tc < tP) ? 1.0 : skyMask;                   // soft planet occlusion
        // palette: per-region hue drift between teal and yellow-green...
        vec3 ac = mix(vec3(0.03, 0.85, 0.50), vec3(0.22, 1.00, 0.16), cf.z);
        // ...a violet nitrogen skirt at the very base of the curtains...
        ac += vec3(0.35, 0.10, 0.90) * smoothstep(0.10, 0.0, a) * 0.38;
        // ...pink transition; high-activity regions become magenta pillars
        float pinkAmt = smoothstep(0.30, 0.62, a)
                      * (0.35 + 0.85 * smoothstep(0.55, 0.95, cf.z));
        ac = mix(ac, vec3(1.00, 0.28, 0.72), min(pinkAmt, 1.0) * 0.65);
        // ...deep crimson-magenta at the tops
        ac = mix(ac, vec3(0.62, 0.04, 0.28), smoothstep(0.55, 0.95, a));
        vec3 fc = mix(vec3(0.03, 0.55, 0.22), vec3(0.04, 0.45, 0.42), cf.z);
        // view mode: rotate the hue of each curtain by a region-varying,
        // slowly-cycling angle. cf.z gives each region a different base
        // offset so neighbouring curtains take different colours, and a
        // few sin terms at distinct frequencies keep the palette
        // drifting through the whole wheel without ever looping
        // visibly. Saturation gets a small bump so the new hues read.
        if (u_view > 0.001) {
          // toned-down spread: per-region offset (cf.z) gives
          // neighbouring curtains different hues, with only a small
          // time-cycling term so colors don't sweep the whole sky and
          // mask different star groups as they slide.
          float hueOff = cf.z * 0.22
                      + 0.05 * sin(t * 0.13 + cf.z * 6.28)
                      + 0.03 * sin(t * 0.07);
          vec3 hsv = rgb2hsv(ac);
          hsv.x = fract(hsv.x + u_view * hueOff);
          hsv.y = clamp(hsv.y * (1.0 + 0.08 * u_view), 0.0, 1.0);
          ac = hsv2rgb(hsv);
          vec3 fhsv = rgb2hsv(fc);
          fhsv.x = fract(fhsv.x + u_view * hueOff);
          fc = hsv2rgb(fhsv);
        }
        acc += (ac * densL + fc * densF) * fade;
      }
      tc += stepLen;
      fexp *= fmul;
    }
    // fade the aurora's reach into the deep sky: full brightness near
    // the limb (lx → 0), zero by lx = 0.18. The curtain shape is
    // animated so when curtains extend up they mask whole patches of
    // stars and the user sees "groups appearing/disappearing" as the
    // ribbons move. Containing the aurora to the limb keeps the upper
    // sky a clean star field.
    float skyFade = smoothstep(0.18, 0.02, lx);
    col += acc * stepLen * 29.0 * skyFade;   // grazing rays cross more shell = bright limb
  }

  /* ---------- planet night side & sky, blended across the soft edge ---------- */
  col += vec3(0.004, 0.007, 0.011) * (1.0 - skyMask);
  if (skyMask > 0.0) {
    // Stars are drawn in a separate GL_POINTS pass (see hero.js) over
    // the real HYG catalog; no procedural starfield here.
    // crimson-magenta sky filling the space above the limb, like the
    // reference: two tones blended by static noise, fading with height.
    // The time-shift is intentionally removed — the noise cells are
    // ~14° across, big enough that when they slide they brighten or
    // dim wide patches of sky and the stars inside read as appearing
    // and disappearing in groups.
    float wn = vnoise(vec2(rd.x, rd.y) * 4.0);
    vec3 skyTone = mix(vec3(0.085, 0.004, 0.030),    // deep crimson
                       vec3(0.095, 0.006, 0.085),    // magenta
                       wn);
    col += skyTone * exp(-max(lx - 0.01, 0.0) * 4.5)
         * smoothstep(0.0, 0.02, lx) * (0.55 + 0.6 * wn) * skyMask;
  }

  /* ---------- amber airglow: the warm band hugging the WHOLE limb ---------- */
  // independent of the sunrise — this is the atmosphere's own faint glow
  col += vec3(0.90, 0.48, 0.13)
       * (exp(-abs(lx - 0.004) * 120.0) * 0.34     // the band itself
        + exp(-max(lx, 0.0) * 30.0) * 0.075);      // soft tail bleeding upward

  /* ---------- atmospheric limb (the blue arc) ---------- */
  float sun = smoothstep(-0.7, 0.95, p.x);          // sunrise to the right
  vec3 limbCol = mix(vec3(0.12, 0.38, 1.00), vec3(0.92, 0.97, 1.00), sun * sun);
  // the bright core line is thinner than a pixel at some resolutions and
  // would shimmer — widen its falloff to >= 1px, conserving total energy
  float s1 = 1.0 / 260.0, w1 = max(s1, edgeW);
  float s3 = 1.0 / 420.0, w3 = max(s3, edgeW);
  col += limbCol * (exp(-abs(lx) / w1) * (s1 / w1) * 2.6
                  + exp(-max(lx, 0.0) * 55.0) * 0.30)
       * (0.18 + 1.8 * sun * sun);
  // warm scatter just under the limb
  col += vec3(1.0, 0.45, 0.12) * exp(-abs(lx + 0.004) / w3) * (s3 / w3)
       * sun * sun * 0.8;

  /* ---------- finish ---------- */
  col = 1.0 - exp(-col * 1.20);                       // soft tone map
  col = pow(col, vec3(1.35));                         // contrast: deepen the darks
  col *= 1.12;                                        // recover highlight punch
  float vig = 1.0 - 0.45 * dot(uv - 0.5, uv - 0.5);   // vignette
  col *= vig;
  col += (hash21(gl_FragCoord.xy + fract(u_time)) - 0.5) / 255.0; // de-banding

  fragColor = vec4(col, 1.0);
}
