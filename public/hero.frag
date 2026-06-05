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
    for (int i = 0; i < 5; i++) {
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

float fbm2(vec2 p) {
    float s = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) {
        s += a * vnoise2(p);
        p *= 2.03;
        a *= 0.5;
    }
    return s;
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

// One aurora curtain. Returns premultiplied emissive colour.
vec3 curtain(vec2 p, float t, int idx) {
    float seed = float(idx) * 17.31;

    // Slow horizontal drift of the entire curtain.
    float drift = t * (0.030 + 0.020 * hash11(seed + 0.7));

    // The bottom edge of the curtain wanders horizontally.
    float spineX = p.x * (0.55 + 0.30 * hash11(seed + 2.1)) + drift + seed;
    float bottomY = -0.30
                  + (hash11(seed + 0.5) - 0.5) * 0.65
                  + 0.22 * sin(spineX * 0.9 + t * 0.18 + seed)
                  + 0.14 * fbm1(spineX * 1.6 + t * 0.22);

    float alt = p.y - bottomY;

    // Horizontal feather: each curtain only emits over part of the screen,
    // with soft edges.
    float widthCenter = (hash11(seed + 4.4) - 0.5) * 2.6;
    float widthSize   = 0.90 + 0.70 * hash11(seed + 5.5);
    float dx          = (p.x - widthCenter) / widthSize;
    float horizFeather = exp(-dx * dx * 1.3);

    // Vertical envelope: hot at bottom edge, fades upward.
    float fadeTop  = 0.70 + 0.25 * hash11(seed + 3.7);
    float bottomFade = smoothstep(-0.04, 0.04, alt);
    float topFade    = 1.0 - smoothstep(0.0, fadeTop, alt);
    float vertical   = bottomFade * topFade;

    // Vertical streaks — anisotropic FBM gives the silky, fibrous look.
    float streak = fbm2(vec2(p.x * 7.5 + t * 0.04 + seed,
                              alt * 1.6 - t * 0.07));
    streak = mix(0.55, 1.20, streak);

    // Bright thin edge line right at the bottom of the curtain.
    float hotline = smoothstep(0.05, 0.0, abs(alt - 0.005)) * 0.55;

    float intensity = vertical * streak + hotline;
    intensity *= horizFeather;

    if (intensity <= 0.0) return vec3(0.0);

    vec3 col = auroraRamp(clamp(alt / fadeTop, 0.0, 1.0));
    return col * intensity;
}

// -------- starfield --------
// Three layers of decreasing density and increasing size:
//   1. fine pinpoints — sharp, static
//   2. midweight stars with small halo — only ~22% twinkle gently
//   3. rare hero stars with soft glow — slow individual pulse
// Disks are AA'd with fwidth so they read as crisp points, not blurry
// blobs or sub-pixel squares. Jitter is kept small enough that the star
// always fits inside its cell (no edge clipping).
vec3 stars(vec2 p, float t) {
    vec3 acc = vec3(0.0);
    float aaP = fwidth(p.x);              // pixel size in p-space

    // L1 — sharp pinpoints (~0.5–1.1 px).
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
            float r  = mix(0.020, 0.040, t01);
            float aa = aaP * DEN;
            float disk = 1.0 - smoothstep(max(0.0, r - aa), r + aa, d);
            vec3 tint = mix(vec3(0.80, 0.88, 1.00),
                            vec3(1.00, 0.95, 0.82),
                            hash21(i + 5.0));
            acc += tint * disk;
        }
    }

    // L2 — midweight + tiny halo; rare twinklers (~1–2 px).
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
            float r  = mix(0.025, 0.050, t01);
            float aa = aaP * DEN;
            float disk = 1.0 - smoothstep(max(0.0, r - aa), r + aa, d);
            float halo = (1.0 - smoothstep(r, r * 1.7, d)) * 0.05;

            // ~12% of L2 stars briefly blink. Period 6–15s per star,
            // each blink is a narrow gaussian bump (~0.4s) over a steady
            // base — sparse and asynchronous, never a constant pulse.
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

    // L3 — rare hero stars; soft glow + slow pulse (~2–4 px).
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
            float r  = mix(0.020, 0.040, t01);
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

    // Night sky: darker at top, a touch of brand violet near the horizon.
    float topDarken = smoothstep(-0.9, 0.9, uv.y);
    vec3 sky = mix(u_bg * 1.15, u_bg * 0.55, topDarken);
    sky += vec3(0.10, 0.04, 0.16) * smoothstep(-1.0, 0.2, -uv.y) * 0.55;

    float skyMask = smoothstep(-0.2, 0.4, uv.y);

    vec3 col = sky;

    // Six layered curtains. Closer (higher depth) ones get more parallax
    // and slightly stronger emission for an atmospheric effect.
    const int N_CURTAINS = 6;
    for (int i = 0; i < N_CURTAINS; i++) {
        float depth = float(i) / float(N_CURTAINS - 1);   // 0 far .. 1 near
        vec2 px = uv + vec2(-m.x * 0.40 * depth,
                            -m.y * 0.12 * depth);
        vec3 c = curtain(px, t, i);
        // Far curtains slightly desaturated for atmospheric haze.
        c = mix(vec3(dot(c, vec3(0.33))), c, mix(0.55, 1.0, depth));
        col += c * mix(0.55, 1.05, depth);
    }

    // Soft brand-violet glow on the lower band ("aurora-lit ground").
    float groundGlow = smoothstep(-1.2, -0.35, -uv.y);
    col += vec3(0.18, 0.06, 0.22) * groundGlow * 0.22;

    // Tonemap: emissive accumulation can blow out — compress it.
    col = vec3(1.0) - exp(-col * 1.35);

    // Vignette.
    float v = smoothstep(1.45, 0.45, length(vec2(uv.x * 0.60, uv.y * 0.95)));
    col = mix(u_bg * 0.6, col, 0.55 + 0.45 * v);

    // Stars sit on top — they're point lights, not affected by vignette
    // or aurora tonemapping.
    col += stars(uv + vec2(0.21, -0.07), t) * skyMask;

    // Film grain.
    float g = (hash21(gl_FragCoord.xy + u_time) - 0.5) * 0.025;
    col += g;

    outColor = vec4(col, 1.0);
}
