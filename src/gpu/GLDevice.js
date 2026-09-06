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
 * @name GLDevice
 * @class The GLDevice wraps a WebGL2 rendering context and owns all the
 *     resources that outlive a single frame: compiled programs, the dynamic
 *     vertex buffer and the global pipeline state.
 *
 * It deliberately knows nothing about paths, styles or the scene graph. All
 * Canvas2D emulation lives in {@link GLContext}, so that a second device
 * implementation (WebGPU) can be dropped in behind the same interface.
 *
 * @private
 */
var GLDevice = Base.extend(/** @lends GLDevice# */{
    _class: 'GLDevice',

    /**
     * @param {HTMLCanvasElement} canvas
     * @param {Object} [options]
     */
    initialize: function GLDevice(canvas, options) {
        var attributes = Base.set({
                alpha: true,
                depth: false,
                stencil: true,
                // We rely on the multisampled default framebuffer for
                // antialiasing, which keeps the stencil-then-cover passes free
                // of an explicit resolve blit.
                antialias: true,
                premultipliedAlpha: true,
                preserveDrawingBuffer: false,
                powerPreference: 'high-performance'
            }, options || {}),
            gl = canvas.getContext('webgl2', attributes);
        if (!gl)
            throw new Error('WebGL2 is not available');
        this.canvas = canvas;
        this.gl = gl;
        this._programs = {};
        this._buffer = gl.createBuffer();
        this._vao = gl.createVertexArray();
        // Grow-only scratch array for vertex data, to avoid per-draw
        // allocations. See #reserve().
        this._data = new Float32Array(4096);
        this._width = 0;
        this._height = 0;
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.CULL_FACE);
        gl.enable(gl.BLEND);
        // Paper.js composites in premultiplied alpha, matching Canvas2D's
        // default 'source-over'.
        gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA,
                gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    },

    /**
     * Returns a scratch Float32Array of at least the requested length. The
     * returned array is reused between calls and must not be retained.
     */
    reserve: function(length) {
        var data = this._data;
        if (data.length < length) {
            var size = data.length;
            while (size < length)
                size *= 2;
            data = this._data = new Float32Array(size);
        }
        return data;
    },

    /**
     * Compiles and links a program, caching it under the given name.
     */
    getProgram: function(name, vertexSource, fragmentSource) {
        var programs = this._programs,
            entry = programs[name];
        if (!entry) {
            var gl = this.gl,
                program = gl.createProgram();
            gl.attachShader(program, this._compile(gl.VERTEX_SHADER,
                    vertexSource));
            gl.attachShader(program, this._compile(gl.FRAGMENT_SHADER,
                    fragmentSource));
            gl.linkProgram(program);
            if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
                var info = gl.getProgramInfoLog(program);
                gl.deleteProgram(program);
                throw new Error('Unable to link program ' + name + ': ' + info);
            }
            entry = programs[name] = {
                program: program,
                uniforms: {}
            };
        }
        return entry;
    },

    _compile: function(type, source) {
        var gl = this.gl,
            shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            var info = gl.getShaderInfoLog(shader);
            gl.deleteShader(shader);
            throw new Error('Unable to compile shader: ' + info + '\n' + source);
        }
        return shader;
    },

    /**
     * Activates a program and returns a helper for setting its uniforms, with
     * locations cached across frames.
     */
    useProgram: function(entry) {
        var gl = this.gl;
        gl.useProgram(entry.program);
        return entry;
    },

    getUniform: function(entry, name) {
        var location = entry.uniforms[name];
        if (location === undefined) {
            location = entry.uniforms[name] =
                    this.gl.getUniformLocation(entry.program, name);
        }
        return location;
    },

    /**
     * Uploads `count` vertices worth of interleaved 2-component data from the
     * scratch array and binds it to attribute location 0.
     */
    upload: function(data, count) {
        var gl = this.gl;
        gl.bindVertexArray(this._vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this._buffer);
        // Orphan the previous store so the driver never stalls on a buffer
        // that is still in flight.
        gl.bufferData(gl.ARRAY_BUFFER, count * 2 * 4, gl.STREAM_DRAW);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, count * 2);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    },

    setSize: function(width, height) {
        if (width !== this._width || height !== this._height) {
            this._width = width;
            this._height = height;
            this.gl.viewport(0, 0, width, height);
        }
    },

    getSize: function() {
        return { width: this._width, height: this._height };
    },

    clear: function() {
        var gl = this.gl;
        gl.disable(gl.SCISSOR_TEST);
        gl.clearColor(0, 0, 0, 0);
        gl.clearStencil(0);
        gl.stencilMask(0xff);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    },

    remove: function() {
        var gl = this.gl;
        for (var name in this._programs)
            gl.deleteProgram(this._programs[name].program);
        gl.deleteBuffer(this._buffer);
        gl.deleteVertexArray(this._vao);
        this._programs = {};
        this.gl = null;
    },

    statics: /** @lends GLDevice */{
        /**
         * Returns true if the environment can create a WebGL2 context.
         */
        isSupported: function() {
            var supported = GLDevice._supported;
            if (supported === undefined) {
                supported = false;
                try {
                    // Deliberately not CanvasProvider.getCanvas(): a canvas
                    // can only ever hand out one kind of context, and pooled
                    // canvases have usually served a 2D one already, which
                    // would make getContext('webgl2') return null here.
                    supported = !!document.createElement('canvas')
                            .getContext('webgl2');
                } catch (e) {}
                GLDevice._supported = supported;
            }
            return supported;
        }
    }
});
