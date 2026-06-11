#version 300 es
precision highp float;

out vec4 fragColor;

uniform vec2  u_res;
uniform float u_time;
uniform vec2  u_orbit;   // accumulated surface rotation (drag + orbital drift)
uniform float u_detail;  // 0.6..1.0 — step budget, lowered during fast motion
uniform float u_motion;  // 1 = animate, 0 = reduced motion

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

/* one layer of stars on the sky direction grid.
   A photographic star is not a disc: it is a tiny white-hot core (pushed
   over 1.0 so the tone map saturates it), a wider gaussian halo that
   carries the color tint, and — on the brightest few — a faint
   diffraction cross. Brightness follows a power law: many dim, few
   brilliant. Dim stars twinkle more than bright ones. */
vec3 starLayer(vec2 g, float thresh, float t) {
  vec2 id = floor(g);
  vec2 f  = fract(g) - 0.5;
  float h = hash21(id);
  if (h < thresh) return vec3(0.0);
  float h2 = hash21(id + 17.13);
  float h3 = hash21(id + 41.71);
  // random position inside the cell (margin keeps it from clipping)
  vec2 pos = (vec2(h2, fract(h2 * 57.31)) - 0.5) * 0.6;
  vec2 d  = f - pos;
  float r2 = dot(d, d);
  // power-law brightness: mostly faint, occasionally brilliant
  float br = pow((h - thresh) / (1.0 - thresh), 5.0) * 0.95 + 0.05;
  // white-hot point core, intensity well above 1 -> tone map clips it white
  float core = exp(-r2 * (900.0 - 500.0 * br)) * (1.5 + 6.0 * br);
  // gaussian halo carrying the color, grows with brightness
  float halo = exp(-r2 * (90.0 - 40.0 * br)) * br * br * 0.55;
  // faint diffraction cross, brightest stars only
  float sp = 0.0;
  if (br > 0.5) {
    sp = (exp(-abs(d.x) * 12.0) * exp(-abs(d.y) * 80.0)
        + exp(-abs(d.y) * 12.0) * exp(-abs(d.x) * 80.0))
       * (br - 0.5) * 0.55 * exp(-r2 * 14.0);
  }
  // twinkle: each star has its own rate/phase; dim ones flicker more
  float tw = 1.0 - (0.45 - 0.33 * br)
           * (0.5 + 0.5 * sin(t * (1.5 + h3 * 3.5) + h3 * 80.0));
  // color temperature: icy blue-white .. warm yellow-white
  vec3 tint = mix(vec3(0.62, 0.74, 1.00), vec3(1.00, 0.86, 0.70), h3);
  // core is near-white (stays only slightly tinted); halo + cross carry color
  return (mix(vec3(1.0), tint, 0.35) * core + tint * (halo + sp)) * tw;
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
        acc += (ac * densL + fc * densF) * fade;
      }
      tc += stepLen;
      fexp *= fmul;
    }
    col += acc * stepLen * 29.0;   // grazing rays cross more shell = bright limb
  }

  /* ---------- planet night side & sky, blended across the soft edge ---------- */
  col += vec3(0.004, 0.007, 0.011) * (1.0 - skyMask);
  if (skyMask > 0.0) {
    // stars: two depths — a dense faint field plus sparse bright ones
    vec2 sp = vec2(atan(rd.x, rd.z), rd.y);
    vec3 st = starLayer(sp * 240.0, 0.962, t) * 0.55       // fine, dim field
            + starLayer(sp * 95.0 + 31.7, 0.985, t) * 1.5; // sparse, brilliant
    col += st * smoothstep(0.005, 0.05, lx) * skyMask;
    // crimson-magenta sky filling the space above the limb, like the
    // reference: two tones blended by slow noise, fading with height
    float wn = vnoise(vec2(rd.x, rd.y) * 4.0 - vec2(t * 0.05));
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
