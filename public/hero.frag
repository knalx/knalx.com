#version 300 es
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

    vec2 m = u_mouse - 0.5;
    m.x *= u_res.x / u_res.y;
    vec2 d = p - m;

    // Uniform global drift — pattern flows on its own at constant speed.
    vec2 U = vec2(0.12, 0.05);
    vec2 sp = p - U * u_time * 0.35;

    // Cursor proximity slightly speeds up the *temporal* evolution.
    // Broad falloff (2.5) keeps it from forming a visible disc; small
    // amplitude (0.025 on a 0.05 base) keeps motion gentle.
    float k = exp(-dot(d, d) * 3.0);
    float t = u_time * (0.05 + 0.04 * k);

    vec2 q = vec2(fbm(sp * 1.6 + t), fbm(sp * 1.6 - t + 4.2));
    vec2 s = vec2(fbm(sp * 1.6 + q + vec2(1.7, 9.2) + t),
                  fbm(sp * 1.6 + q + vec2(8.3, 2.8) - t));
    float n = fbm(sp * 1.8 + s);

    // Gentle centered vignette so edges fall off slightly.
    float v = smoothstep(1.2, 0.35, length(p));

    vec3 col = mix(u_colB, u_colA, smoothstep(0.25, 0.85, n));
    col = mix(u_bg, col, 0.85 + 0.15 * v);

    // subtle film grain
    float g = (hash(gl_FragCoord.xy + u_time) - 0.5) * 0.04;
    col += g;

    outColor = vec4(col, 1.0);
}
