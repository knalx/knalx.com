#version 300 es
precision highp float;

out vec4 outColor;

uniform vec2  u_res;
uniform float u_time;
uniform vec2  u_mouse;   // 0..1 in viewport space
uniform vec3  u_bg;

float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}

// 3D ribbon centerline (vertical component): a slow wandering spine.
float spine(float x, float t) {
    return  0.260 * sin(x * 0.32 + t * 0.110)
          + 0.135 * sin(x * 0.78 - t * 0.075 + 1.7)
          + 0.060 * sin(x * 1.70 + t * 0.160 + 0.4)
          + 0.025 * sin(x * 3.00 - t * 0.215);
}

// Twist angle around the ribbon's tangent: rotates the width direction
// from in-screen (theta=0) to depth-axis (theta=pi/2), so stripes
// physically rotate through 3D space as they flow. Amplitudes sum to
// ~1.15 rad (66°) — kept below pi/2 so the ribbon never fully goes
// edge-on (which would collapse all stripes onto the centerline).
float twistAngle(float x, float t) {
    return  0.70 * sin(x * 0.19 + t * 0.12)
          + 0.30 * sin(x * 0.48 - t * 0.18 + 1.7)
          + 0.15 * sin(x * 1.00 + t * 0.07);
}

const int N_HALF = 16;     // 33 stripes total

void main() {
    vec2 uv = (gl_FragCoord.xy * 2.0 - u_res.xy) / u_res.y;
    vec2 m  = u_mouse - 0.5;

    // Slight diagonal flow.
    float a = 0.18;
    float ca = cos(a), sa = sin(a);
    vec2 p = vec2(ca * uv.x - sa * uv.y, sa * uv.x + ca * uv.y);

    float t = u_time;

    // Mouse rotates the entire light rig as a rigid sphere around the
    // ribbon — relative positions of the three lights are preserved, the
    // whole constellation just spins. Yaw from cursor x, pitch from
    // cursor y (Rx * Ry, applied to the constant light positions).
    float yaw   = m.x * 2.0;
    float pitch = m.y * 1.5;
    float cy = cos(yaw),   sy = sin(yaw);
    float cp = cos(pitch), sp = sin(pitch);
    mat3 lightRig = mat3(
        vec3( cy,     sp * sy, -cp * sy),
        vec3( 0.0,    cp,       sp     ),
        vec3( sy,    -sp * cy,  cp * cy)
    );

    // Ribbon orientation at this column.
    // Approximation: tangent ~ +x (we ignore spine slope here for
    // orthographic mapping in x). Width direction rotates around tangent
    // by theta, so it goes from (0,1,0) at theta=0 to (0,0,1) at pi/2.
    float ys = spine(p.x, t);
    float th = twistAngle(p.x, t);
    float sn = sin(th), cn = cos(th);

    // Ribbon surface normal (T x W) — same for all stripes at this column.
    vec3 N = vec3(0.0, -sn, cn);

    // Three point lights mounted on a rigid rig that the mouse spins
    // around the ribbon. Per-stripe inverse-square attenuation against
    // three distinct tones produces the depth-banded coloured gradient.
    //   key  (front-right, above): orange-red
    //   fill (front-left, below):  azure
    //   rim  (behind,      above): magenta — lights the back side
    const vec3 KEY_COL  = vec3(1.00, 0.25, 0.05);
    const vec3 FILL_COL = vec3(0.05, 0.45, 1.00);
    const vec3 RIM_COL  = vec3(1.00, 0.05, 0.85);

    vec3 KEY_POS  = lightRig * vec3( 0.95,  0.60,  1.30);
    vec3 FILL_POS = lightRig * vec3(-1.20, -0.25,  1.00);
    vec3 RIM_POS  = lightRig * vec3( 0.10,  0.55, -1.10);

    // Perspective foreshortening — closer stripes bigger, farther smaller.
    float focal   = 2.0;
    float spacing = 0.045;
    float aa      = fwidth(p.y);
    float lwBase  = 1.4 * aa;

    float along = smoothstep(-1.7, -0.6, p.x)
                * (1.0 - smoothstep(0.7, 1.8, p.x));

    vec3 col = u_bg;

    // Iterate stripes back-to-front: march from negative z (behind) to
    // positive z (in front), so closer stripes alpha-composite *over*
    // farther ones — real occlusion in 3D.
    for (int kk = 0; kk <= 2 * N_HALF; kk++) {
        int k = (sn >= 0.0) ? (kk - N_HALF) : (N_HALF - kk);

        float uk = float(k) * spacing;

        // 3D position of this stripe at this column.
        float yk = ys + uk * cn;
        float zk = uk * sn;
        vec3  P3 = vec3(p.x, yk, zk);

        // Perspective projection.
        float w    = max(1.0 - zk / focal, 0.05);
        float scrY = yk / w;
        float d    = abs(p.y - scrY);

        float lwk  = lwBase / w;
        float core = 1.0 - smoothstep(lwk - aa, lwk + aa, d);
        float halo = (1.0 - smoothstep(lwk, lwk * 3.0, d)) * 0.18;
        float l    = clamp(core + halo, 0.0, 1.0) * along;

        float bandT = abs(float(k)) / float(N_HALF);
        l *= pow(1.0 - bandT, 1.4);

        // ---- Per-stripe 3D lighting from three positional lights -----
        vec3 V = vec3(0.0, 0.0, 1.0);

        // Key (warm, front-right-above): main diffuse + tight specular.
        vec3  dK    = KEY_POS - P3;
        float distK = length(dK);
        vec3  Lk    = dK / distK;
        float attK  = 1.0 / (1.0 + 0.10 * distK * distK);
        float diffK = abs(dot(N, Lk));
        float specK = pow(max(0.0, abs(dot(N, normalize(Lk + V)))), 28.0);

        // Fill (cool, front-left-below): softer diffuse, mild specular.
        vec3  dF    = FILL_POS - P3;
        float distF = length(dF);
        vec3  Lf    = dF / distF;
        float attF  = 1.0 / (1.0 + 0.15 * distF * distF);
        float diffF = abs(dot(N, Lf));
        float specF = pow(max(0.0, abs(dot(N, normalize(Lf + V)))), 22.0);

        // Rim (accent, behind): catches stripes whose back face is angled
        // toward the rear — adds a coloured halo along silhouettes.
        vec3  dR    = RIM_POS - P3;
        float distR = length(dR);
        vec3  Lr    = dR / distR;
        float attR  = 1.0 / (1.0 + 0.20 * distR * distR);
        float diffR = abs(dot(N, Lr));
        float specR = pow(max(0.0, abs(dot(N, normalize(Lr + V)))), 18.0);

        float ambient = 0.04;

        // White material: lights' colours come through unchanged.
        vec3 stripeCol =
              vec3(ambient)
            + KEY_COL  * diffK * attK * 1.05
            + FILL_COL * diffF * attF * 0.55
            + RIM_COL  * diffR * attR * 0.65
            + KEY_COL  * specK * attK * 0.85
            + FILL_COL * specF * attF * 0.30
            + RIM_COL  * specR * attR * 0.45;

        // Composite over what's behind.
        col = mix(col, stripeCol, l * 0.88);
    }

    // Gentle vignette.
    float v = smoothstep(1.35, 0.45, length(vec2(uv.x * 0.55, uv.y)));
    col = mix(u_bg, col, 0.55 + 0.45 * v);

    // Subtle film grain.
    float g = (hash(gl_FragCoord.xy + u_time) - 0.5) * 0.025;
    col += g;

    outColor = vec4(col, 1.0);
}
