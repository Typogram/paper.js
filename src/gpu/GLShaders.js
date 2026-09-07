/*
 * Paper.js - The Swiss Army Knife of Vector Graphics Scripting.
 * http://paperjs.org/
 *
 * Copyright (c) 2011 - 2020, Jürg Lehni & Jonathan Puckey
 * http://juerglehni.com/ & https://puckey.studio/
 *
 * Distributed under the MIT license. See LICENSE file for details.
 *
 * All rights reserved.
 */

/**
 * @name GLShaders
 * @class The GLSL sources used by {@link GLContext}.
 *
 * All geometry is submitted in device pixels with a y-down origin, matching
 * Canvas2D, and converted to clip space in the vertex shader. Every fragment
 * shader emits premultiplied alpha, which is what the ONE / ONE_MINUS_SRC_ALPHA
 * blend function set up by GLDevice expects.
 *
 * @private
 */
var GLShaders = /** @lends GLShaders */{
    vertex: [
        '#version 300 es',
        'layout(location = 0) in vec2 a_position;',
        'uniform vec2 u_resolution;',
        // The item's transform. Geometry cached across frames is stored in the
        // space it was recorded in, so a moving or rotating item costs one
        // uniform update here instead of a full re-tessellation on the CPU.
        // Draws that submit device-space coordinates pass the identity.
        'uniform mat3 u_matrix;',
        'out vec2 v_position;',
        'void main() {',
        '    vec2 pos = (u_matrix * vec3(a_position, 1.0)).xy;',
        // Gradients sample in device space, so v_position must be the
        // transformed position, not the raw attribute.
        '    v_position = pos;',
        '    vec2 clip = pos / u_resolution * 2.0 - 1.0;',
        '    gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);',
        '}'
    ].join('\n'),

    // Batched geometry arrives already in device space, with one colour per
    // vertex so that many shapes with different paints can share a single
    // draw call. The identity transform of the shader above would do, but
    // carrying the colour needs its own attribute layout either way.
    batchVertex: [
        '#version 300 es',
        'layout(location = 0) in vec2 a_position;',
        'layout(location = 1) in vec4 a_color;',
        'uniform vec2 u_resolution;',
        'out vec4 v_color;',
        'void main() {',
        '    v_color = a_color;',
        '    vec2 clip = a_position / u_resolution * 2.0 - 1.0;',
        '    gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);',
        '}'
    ].join('\n'),

    batchSolid: [
        '#version 300 es',
        'precision highp float;',
        // Already premultiplied on the CPU, alongside globalAlpha.
        'in vec4 v_color;',
        'out vec4 fragColor;',
        'void main() {',
        '    fragColor = v_color;',
        '}'
    ].join('\n'),

    // Used by the stencil passes, which have colour writes masked off.
    none: [
        '#version 300 es',
        'precision highp float;',
        'out vec4 fragColor;',
        'void main() {',
        '    fragColor = vec4(0.0);',
        '}'
    ].join('\n'),

    solid: [
        '#version 300 es',
        'precision highp float;',
        // Premultiplied, with globalAlpha already folded in.
        'uniform vec4 u_color;',
        'out vec4 fragColor;',
        'void main() {',
        '    fragColor = u_color;',
        '}'
    ].join('\n'),

    gradient: [
        '#version 300 es',
        'precision highp float;',
        'uniform sampler2D u_ramp;',
        'uniform float u_alpha;',
        // 0 = linear, 1 = radial.
        'uniform int u_radial;',
        // Linear: start and end point. Radial: focal point and centre.
        'uniform vec2 u_p0;',
        'uniform vec2 u_p1;',
        'uniform float u_radius;',
        'in vec2 v_position;',
        'out vec4 fragColor;',
        'void main() {',
        '    float t;',
        '    vec2 d = v_position - u_p0;',
        '    vec2 f = u_p1 - u_p0;',
        '    if (u_radial == 0) {',
        '        float len = dot(f, f);',
        '        t = len > 0.0 ? dot(d, f) / len : 0.0;',
        '    } else {',
        // Focal radial gradient: find the offset s at which the point lies on
        // the circle centred at p0 + s * f with radius s * radius.
        '        float a = dot(f, f) - u_radius * u_radius;',
        '        float b = -2.0 * dot(d, f);',
        '        float c = dot(d, d);',
        '        if (abs(a) < 1e-6) {',
        '            t = b != 0.0 ? -c / b : 0.0;',
        '        } else {',
        '            float disc = b * b - 4.0 * a * c;',
        '            if (disc < 0.0) discard;',
        '            float sq = sqrt(disc);',
        '            t = max((-b + sq) / (2.0 * a), (-b - sq) / (2.0 * a));',
        '        }',
        '    }',
        // The ramp is sampled with LINEAR filtering, so inset by half a texel
        // to keep the first and last stops exact.
        '    t = clamp(t, 0.0, 1.0) * (255.0 / 256.0) + (0.5 / 256.0);',
        '    vec4 color = texture(u_ramp, vec2(t, 0.5));',
        '    float alpha = color.a * u_alpha;',
        '    fragColor = vec4(color.rgb * alpha, alpha);',
        '}'
    ].join('\n'),

    image: [
        '#version 300 es',
        'precision highp float;',
        'uniform sampler2D u_image;',
        'uniform float u_alpha;',
        // Maps device-space position to texture coordinates, so that textured
        // quads can use the same 2-component vertex format as everything else.
        'uniform mat3 u_uvMatrix;',
        'in vec2 v_position;',
        'out vec4 fragColor;',
        'void main() {',
        '    vec2 uv = (u_uvMatrix * vec3(v_position, 1.0)).xy;',
        '    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;',
        '    vec4 color = texture(u_image, uv);',
        // Textures are uploaded unpremultiplied; premultiply on the way out.
        '    float alpha = color.a * u_alpha;',
        '    fragColor = vec4(color.rgb * alpha, alpha);',
        '}'
    ].join('\n')
};
