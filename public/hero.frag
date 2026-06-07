#version 300 es
precision highp float;

out vec4 outColor;

uniform vec2  u_res;
uniform float u_time;
uniform vec2  u_mouse;   // 0..1 in viewport space
uniform vec3  u_bg;

// -------- hashing & noise --------

float hash11(float n) {
    return fract(sin(n) * 43758.5453123);
}

float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}

float vnoise1(float x) {
    float i = floor(x);
    float f = fract(x);
    float u = f * f * (3.0 - 2.0 * f);
    return mix(hash11(i), hash11(i + 1.0), u);
}

float fbm1(float x) {
    float s = 0.0, a = 0.5, f = 1.0;
    for (int i = 0; i < 4; i++) {
        s += a * vnoise1(x * f);
        f *= 2.07;
        a *= 0.5;
    }
    return s;
}

float vnoise2(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// -------- aurora colour ramp (cyan -> violet -> magenta) --------

vec3 auroraRamp(float alt) {
    vec3 cyan    = vec3(0.20, 0.85, 1.00);
    vec3 violet  = vec3(0.55, 0.20, 0.90);
    vec3 magenta = vec3(1.00, 0.30, 0.75);
    vec3 c = mix(cyan,   violet,  smoothstep(0.00, 0.45, alt));
    c     = mix(c,       magenta, smoothstep(0.35, 1.00, alt));
    return c;
}

// Single 3D-dynamic aurora ribbon. The defining feature is `zWave` —
// a per-pixel pseudo-z coordinate that varies with both screen-x and
// time. From it we derive a local perspective scale and "nearness"
// value, which then drive amplitudes, height, baseline-y, color and
// brightness across the ribbon. As `t` advances, the z-wave drifts
// through screen-x, so different sections continuously slide toward
// and away from the camera — the ribbon is a single shape, but it
// reads as moving and folding through 3D space.
vec3 curtain(vec2 p, float t, int idx) {
    // idx 0 = back (small, dim, cool-cyan tint, sits higher / hazier),
    // idx 1 = middle (the original ribbon),
    // idx 2 = front (big, bright, warm-magenta tint, sits lower / vivid).
    // Per-ribbon: depthBias shifts zPersp baseline so the whole ribbon
    // reads as close or far; phase de-syncs their motion; tint and
    // brightMult finish the look.
    float depthBias, brightMult, driftSpeed, phase;
    vec3  tint;
    if (idx == 0) {           // BACK
        depthBias  = 0.55;
        brightMult = 1.6;
        driftSpeed = 0.045;
        phase      = 7.3;
        tint       = vec3(0.70, 1.10, 1.30);
    } else if (idx == 2) {    // FRONT
        depthBias  = -0.40;
        brightMult = 3.2;
        driftSpeed = 0.075;
        phase      = 3.1;
        tint       = vec3(1.25, 0.85, 1.10);
    } else {                  // MIDDLE
        depthBias  = 0.0;
        brightMult = 2.5;
        driftSpeed = 0.06;
        phase      = 0.0;
        tint       = vec3(1.0);
    }
    float drift = t * driftSpeed + phase;

    // 3D depth wave. Three harmonics of (p.x, t) give organic,
    // non-repeating folds toward and away from the camera. Higher
    // zWave ⇒ farther; lower ⇒ closer.
    float zArg1 = p.x * 0.45 + t * 0.18 + phase;
    float zArg2 = p.x * 0.80 - t * 0.13 + 3.7 + phase * 0.7;
    float zArg3 = p.x * 1.30 + t * 0.10 - 1.1 + phase * 1.3;
    float zWave = 0.45 * sin(zArg1)
                + 0.35 * sin(zArg2)
                + 0.20 * sin(zArg3);
    float zPersp = 1.0 + zWave * 0.55 + depthBias;
    // near01: 1 when ribbon section is close, 0 when it's far. Computed
    // with edges in ascending order (smoothstep is undefined otherwise).
    float near01 = 1.0 - smoothstep(0.45, 1.55, zPersp);

    // Bounded depth scalings for geometry — full scaleZ ranged up to
    // ~2.9× which threw the bottom edge entirely off-screen at peak.
    float ampZ    = mix(0.60, 1.40, near01);
    float heightZ = mix(0.70, 1.45, near01);

    // Bottom curve. Three harmonics, the middle phase-modulated by a
    // slower sine for uneven fold spacing, plus a small noise term.
    // Amplitudes scale with local depth so close folds swing larger.
    float a1 = 0.32 * ampZ, a2 = 0.17 * ampZ, a3 = 0.08 * ampZ;
    float f1 = 0.06875, f2 = 0.15625, f3 = 0.325;
    float ph1 = drift, ph2 = -drift * 1.3, ph3 = drift * 1.7;

    float pmFreq = 0.325, pmAmp = 0.28;
    float pmArg  = p.x * pmFreq + drift * 0.25;
    float pm     = pmAmp * sin(pmArg);

    float nArg   = p.x * 1.75 + drift * 0.4;
    float nDetail = vnoise1(nArg) - 0.5;

    // Baseline shifts with local depth: close sections hang lower
    // toward the foreground, far sections lift toward the horizon.
    float yBase = 0.05 - 0.20 * near01;

    float yBot = yBase
               + a1 * sin(p.x * f1 + ph1)
               + a2 * sin(p.x * f2 + ph2 + pm)
               + a3 * sin(p.x * f3 + ph3)
               + 0.06 * nDetail;

    float alt = p.y - yBot;

    // Height scaled by depth — close sections rise higher into the
    // sky than far ones (perspective foreshortening).
    float hN1 = vnoise1(p.x * 0.4 + drift * 0.08);
    float hN2 = vnoise1(p.x * 1.375 - drift * 0.12 + 7.0);
    float heightVar = 0.65 + 0.85 * (hN1 * 0.65 + hN2 * 0.35);
    float height = 0.55 * heightVar * heightZ;
    float bottomFade = smoothstep(-0.04, 0.02, alt);
    float tail       = exp(-max(alt, 0.0) * 2.0 / max(0.001, height));
    float topCap     = 1.0 - smoothstep(height * 0.6, height * 1.4, alt);
    float vert = bottomFade * tail * topCap;

    float hot = exp(-alt * alt * 1100.0) * 0.45 * bottomFade;

    float rays = vnoise1(p.x * 6.0 + drift * 0.6 - alt * 0.35);
    rays = mix(0.40, 1.30, rays);

    // Vibration stripes are parallel, but tilted on a single axis to
    // convey the "viewed from below and slightly to the side" angle.
    // Projecting p onto (1, 0.35) gives stripes leaning ~19° from
    // vertical — all parallel to each other, none converging.
    float stripeAxis = p.x + p.y * 0.35;
    float vibCarrier = vnoise1(stripeAxis * 32.0 + drift * 0.8);
    float vibPatch   = smoothstep(0.55, 0.78,
                                  vnoise1(stripeAxis * 1.5 + drift * 0.15 + 11.0));
    rays *= mix(1.0, mix(0.55, 2.10, vibCarrier), vibPatch);

    float n1 = vnoise1(p.x * 0.35 + drift * 0.3);
    float n2 = vnoise1(p.x * 0.85 - drift * 0.5 + alt * 1.8);
    float patches = mix(0.65, 1.30, n1 * n2 * 1.6 + 0.10);

    // Up to 3 shadow wells per ribbon, each with its own fade-in /
    // fade-out lifecycle. When a well fades fully out, its slot
    // rehashes a new random position and width for the next cycle —
    // so the ribbon sees a rolling 1–3 shadow count over time.
    // Cycle periods are staggered so all three slots never go invisible
    // simultaneously (off region is only ~5% of each cycle).
    float cyc0 = mod(t * 0.10  + phase,        1.0);
    float cyc1 = mod(t * 0.075 + phase + 0.30, 1.0);
    float cyc2 = mod(t * 0.055 + phase + 0.65, 1.0);

    // Presence envelope: 0 → 1 over 5–20% of cycle, plateaus at 1,
    // 1 → 0 over 80–95% of cycle, fully off in the final 5%.
    float pres0 = smoothstep(0.05, 0.20, cyc0)
                * (1.0 - smoothstep(0.80, 0.95, cyc0));
    float pres1 = smoothstep(0.05, 0.20, cyc1)
                * (1.0 - smoothstep(0.80, 0.95, cyc1));
    float pres2 = smoothstep(0.05, 0.20, cyc2)
                * (1.0 - smoothstep(0.80, 0.95, cyc2));

    // Rehash position + width once per cycle. Each slot's `iter`
    // increments at the same time its presence hits 0, so the position
    // jump is invisible.
    float iter0 = floor(t * 0.10  + phase);
    float iter1 = floor(t * 0.075 + phase + 0.30);
    float iter2 = floor(t * 0.055 + phase + 0.65);

    // Each shadow drifts across its lifetime: random start position
    // plus a random drift direction/distance scaled by cycle progress.
    // The shadow appears, slides across the ribbon, then fades out at
    // its end position before the slot rehashes for the next cycle.
    float c0_base = -1.7 + 3.4 * hash11(iter0 * 7.3 +  1.1);
    float c1_base = -1.7 + 3.4 * hash11(iter1 * 7.3 +  5.7);
    float c2_base = -1.7 + 3.4 * hash11(iter2 * 7.3 + 11.3);
    float c0_dir  = (hash11(iter0 * 7.3 + 31.7) - 0.5) * 4.8;
    float c1_dir  = (hash11(iter1 * 7.3 + 47.3) - 0.5) * 4.8;
    float c2_dir  = (hash11(iter2 * 7.3 + 61.9) - 0.5) * 4.8;
    float c0 = c0_base + c0_dir * cyc0;
    float c1 = c1_base + c1_dir * cyc1;
    float c2 = c2_base + c2_dir * cyc2;

    // Width hashed in [0.80, 1.20] — pulled back to a more compact
    // footprint after the previous min was too dominant.
    float w0 = 0.80 + 0.40 * hash11(iter0 * 11.7 +  2.1);
    float w1 = 0.80 + 0.40 * hash11(iter1 * 11.7 +  7.7);
    float w2 = 0.80 + 0.40 * hash11(iter2 * 11.7 + 13.3);

    // Appear animation: width snaps open from ~0 to its target over
    // the first 10% of the cycle, so each shadow "pops" into existence
    // before settling at full size for the bulk of its life.
    float wScale0 = smoothstep(0.0, 0.10, cyc0);
    float wScale1 = smoothstep(0.0, 0.10, cyc1);
    float wScale2 = smoothstep(0.0, 0.10, cyc2);
    float effW0 = mix(0.001, w0, wScale0);
    float effW1 = mix(0.001, w1, wScale1);
    float effW2 = mix(0.001, w2, wScale2);

    // Shadow depth scales with presence so it fades in / fades out.
    float s0 = 1.0 - pres0 * exp(-pow((p.x - c0) / effW0, 2.0));
    float s1 = 1.0 - pres1 * exp(-pow((p.x - c1) / effW1, 2.0));
    float s2 = 1.0 - pres2 * exp(-pow((p.x - c2) / effW2, 2.0));
    float dropout = s0 * s1 * s2;

    // Fold-like brightening at steep parts of the bottom curve.
    float dpm  = pmAmp * pmFreq * cos(pmArg);
    float dydx = a1 * f1 * cos(p.x * f1 + ph1)
               + a2 * (f2 + dpm) * cos(p.x * f2 + ph2 + pm)
               + a3 * f3 * cos(p.x * f3 + ph3);
    float foldBoost = 1.0 + abs(dydx) * 0.30;

    // Wide horizontal envelope — single ribbon spans most of the sky.
    float xT    = p.x / 4.0;
    float xFall = exp(-xT * xT * 0.20);

    float altN = clamp(alt / max(0.05, height), 0.0, 1.0);
    vec3 col = auroraRamp(altN);

    float hueN = vnoise1(p.x * 0.175 + drift * 0.3) - 0.5;
    col *= vec3(1.0 + hueN * 0.40,
                1.0 - hueN * 0.10,
                1.0 - hueN * 0.40);

    // Depth shading from the same `near01` that drives geometry, so
    // colour saturation and brightness lock-step with the perspective
    // folds — near sections are vivid; far sections are hazy / dim.
    // Floor kept high so far sections are still clearly visible.
    col = mix(vec3(dot(col, vec3(0.33))) * 0.75, col,
              mix(0.70, 1.00, near01));
    col *= mix(0.85, 1.35, near01);

    // Independent green-tint wells — parallel to the shadow system
    // (random fade-in / drift / fade-out lifecycle) but layered on
    // colour instead of brightness. Different cycle periods and
    // hash seeds so the green spots have no relation to the shadows.
    float gcyc0 = mod(t * 0.080 + phase + 1.7, 1.0);
    float gcyc1 = mod(t * 0.065 + phase + 4.5, 1.0);
    float gcyc2 = mod(t * 0.090 + phase + 7.1, 1.0);

    float gp0 = smoothstep(0.05, 0.20, gcyc0) * (1.0 - smoothstep(0.80, 0.95, gcyc0));
    float gp1 = smoothstep(0.05, 0.20, gcyc1) * (1.0 - smoothstep(0.80, 0.95, gcyc1));
    float gp2 = smoothstep(0.05, 0.20, gcyc2) * (1.0 - smoothstep(0.80, 0.95, gcyc2));

    float gi0 = floor(t * 0.080 + phase + 1.7);
    float gi1 = floor(t * 0.065 + phase + 4.5);
    float gi2 = floor(t * 0.090 + phase + 7.1);

    float gc0 = -1.7 + 3.4 * hash11(gi0 * 5.7 +  3.3)
              + (hash11(gi0 * 5.7 + 23.1) - 0.5) * 4.8 * gcyc0;
    float gc1 = -1.7 + 3.4 * hash11(gi1 * 5.7 +  9.1)
              + (hash11(gi1 * 5.7 + 33.3) - 0.5) * 4.8 * gcyc1;
    float gc2 = -1.7 + 3.4 * hash11(gi2 * 5.7 + 15.7)
              + (hash11(gi2 * 5.7 + 43.9) - 0.5) * 4.8 * gcyc2;

    float gw0 = mix(0.001, 0.80 + 0.40 * hash11(gi0 * 9.1 +  4.1),
                    smoothstep(0.0, 0.10, gcyc0));
    float gw1 = mix(0.001, 0.80 + 0.40 * hash11(gi1 * 9.1 + 11.3),
                    smoothstep(0.0, 0.10, gcyc1));
    float gw2 = mix(0.001, 0.80 + 0.40 * hash11(gi2 * 9.1 + 17.7),
                    smoothstep(0.0, 0.10, gcyc2));

    float gAmt = max(max(gp0 * exp(-pow((p.x - gc0) / gw0, 2.0)),
                         gp1 * exp(-pow((p.x - gc1) / gw1, 2.0))),
                         gp2 * exp(-pow((p.x - gc2) / gw2, 2.0)));
    col = mix(col, col * vec3(0.50, 1.65, 0.70), gAmt);

    // Apply per-ribbon hue tint and brightness.
    return col * tint * (vert * rays * patches + hot) * xFall * foldBoost * dropout * brightMult;
}

// -------- starfield --------
// Three layers of decreasing density and increasing size:
//   1. fine pinpoints — sharp, static
//   2. midweight stars with small halo — only ~12% briefly blink
//   3. rare hero stars with soft glow — steady
// Disks are AA'd with fwidth so they read as crisp points, not blurry
// blobs or sub-pixel squares. Jitter is kept small enough that the star
// always fits inside its cell (no edge clipping).
vec3 stars(vec2 p, float t) {
    vec3 acc = vec3(0.0);
    float aaP = fwidth(p.x);

    // L1 — sharp pinpoints.
    {
        const float DEN = 40.0;
        vec2 g = p * DEN;
        vec2 i = floor(g);
        vec2 f = fract(g) - 0.5;
        float h = hash21(i);
        if (h > 0.981) {
            float t01 = (h - 0.981) / 0.019;
            vec2 jit = (vec2(hash21(i + 13.0), hash21(i + 71.0)) - 0.5) * 0.55;
            float d  = length(f - jit);
            float r  = mix(0.020, 0.028, t01);
            float aa = aaP * DEN;
            float disk = 1.0 - smoothstep(max(0.0, r - aa), r + aa, d);
            vec3 tint = mix(vec3(0.80, 0.88, 1.00),
                            vec3(1.00, 0.95, 0.82),
                            hash21(i + 5.0));
            acc += tint * disk;
        }
    }

    // L2 — midweight + tiny halo; rare twinklers.
    {
        const float DEN = 26.0;
        vec2 g = p * DEN + vec2(3.7, 17.3);
        vec2 i = floor(g);
        vec2 f = fract(g) - 0.5;
        float h = hash21(i);
        if (h > 0.981) {
            float t01 = (h - 0.981) / 0.019;
            vec2 jit = (vec2(hash21(i + 5.0), hash21(i + 19.0)) - 0.5) * 0.45;
            vec2 ff  = f - jit;
            float d  = length(ff);
            float r  = mix(0.025, 0.035, t01);
            float aa = aaP * DEN;
            float disk = 1.0 - smoothstep(max(0.0, r - aa), r + aa, d);
            float halo = (1.0 - smoothstep(r, r * 1.7, d)) * 0.05;

            float ht     = hash21(i + 47.0);
            float doBlink = step(0.88, ht);
            float bSeed  = hash21(i + 91.0);
            float period = 6.0 + 9.0 * bSeed;
            float phase  = bSeed * 13.7;
            float u      = mod(t + phase, period) / period;
            float bump   = exp(-pow((u - 0.5) * 25.0, 2.0));
            float bright = 1.0 + doBlink * bump * 0.6;

            vec3 tint = mix(vec3(0.85, 0.92, 1.00),
                            vec3(1.00, 0.92, 0.78),
                            hash21(i + 9.0) * 0.7);
            acc += tint * (disk + halo) * bright;
        }
    }

    // L3 — rare hero stars; soft glow, steady.
    {
        const float DEN = 10.0;
        vec2 g = p * DEN + vec2(91.3, 7.7);
        vec2 i = floor(g);
        vec2 f = fract(g) - 0.5;
        float h = hash21(i);
        if (h > 0.990) {
            float t01 = (h - 0.990) / 0.010;
            vec2 jit = (vec2(hash21(i + 21.0), hash21(i + 83.0)) - 0.5) * 0.35;
            vec2 ff  = f - jit;
            float d  = length(ff);
            float r  = mix(0.020, 0.028, t01);
            float aa = aaP * DEN;
            float disk = 1.0 - smoothstep(max(0.0, r - aa), r + aa, d);
            float glow = (1.0 - smoothstep(r, r * 2.2, d)) * 0.06;
            vec3 tint = mix(vec3(0.92, 0.96, 1.00),
                            vec3(1.00, 0.94, 0.82),
                            hash21(i + 51.0));
            acc += tint * (disk * 1.10 + glow);
        }
    }

    return acc;
}

void main() {
    vec2 uv = (gl_FragCoord.xy * 2.0 - u_res.xy) / u_res.y;
    vec2 m  = u_mouse - 0.5;
    float t = u_time;

    // Night sky.
    float topDarken = smoothstep(-0.9, 0.9, uv.y);
    vec3 sky = mix(u_bg * 1.15, u_bg * 0.55, topDarken);
    sky += vec3(0.10, 0.04, 0.16) * smoothstep(-1.0, 0.2, -uv.y) * 0.55;

    float skyMask = smoothstep(-0.2, 0.4, uv.y);

    vec3 col = sky;

    // Three 3D-dynamic ribbons. Each has its own perspective baseline,
    // hue tint and drift phase; parallax shift scales with depth so the
    // back ribbon barely moves with the mouse and the front one shifts
    // significantly. Order: back → middle → front for natural overlap.
    col += curtain(uv + vec2(-m.x * 0.16, -m.y * 0.05), t, 0);
    col += curtain(uv + vec2(-m.x * 0.32, -m.y * 0.10), t, 1);
    col += curtain(uv + vec2(-m.x * 0.52, -m.y * 0.16), t, 2);

    // Soft brand-violet glow on the lower band ("aurora-lit ground").
    float groundGlow = smoothstep(-1.2, -0.35, -uv.y);
    col += vec3(0.18, 0.06, 0.22) * groundGlow * 0.22;

    // Tonemap emissive accumulation.
    col = vec3(1.0) - exp(-col * 1.35);

    // Vignette.
    float v = smoothstep(1.45, 0.45, length(vec2(uv.x * 0.60, uv.y * 0.95)));
    col = mix(u_bg * 0.6, col, 0.55 + 0.45 * v);

    // Stars sit on top — full opacity, unaffected by vignette/tonemap.
    col += stars(uv + vec2(0.21, -0.07), t) * skyMask;

    // Film grain.
    float g = (hash21(gl_FragCoord.xy + u_time) - 0.5) * 0.025;
    col += g;

    outColor = vec4(col, 1.0);
}
