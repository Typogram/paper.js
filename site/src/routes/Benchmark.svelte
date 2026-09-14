<script>
  /**
   * The same scene, the same auto-pan, rendered by both backends - one at a
   * time, so each is measured on its own frames. Paper.js is loaded in the
   * browser only: the bundle is a browser UMD, and this page is prerendered.
   */
  import { onMount, onDestroy } from 'svelte';

  const STEPS = [0, 100, 500, 1000, 2500, 5000, 10000, 20000, 35000, 50000, 75000, 100000];
  const COLORS = ['#5ec8d8', '#ff8a3d', '#9d7bf0', '#7bd88f', '#ff6b6b', '#f5c451'];
  const CHUNK = 2500;

  /** @type {any} paper.js, loaded in the browser only - see onMount */
  let paper = $state(null);
  /** @type {any} */
  let stage = $state(null);

  let renderer = $state('svg');
  let countIndex = $state(6);
  let count = $derived(STEPS[countIndex]);
  let panning = $state(true);
  let tool = $state('pan');
  let building = $state(false);
  let progress = $state(0);

  let fps = $state('–');
  let frame = $state('–');
  let updateMs = $state('–');
  let buildMs = $state('–');
  let violations = $state(0);
  /** @type {{id: string, stamp: string, who: string, ms: string, ctx: string, renderer: string}[]} */
  let violationLog = $state([]);
  let wire = $state('–');
  let hit = $state('Switch Drag to Select, then click an item.');
  let hitIdle = $state(true);

  /** @type {any} */ let view = null;
  /** @type {any} */ let project = null;
  /** @type {any} */ let element = null;
  /** @type {number[]} */ let frames = [];
  /** @type {number[]} */ let updates = [];
  let lastFrame = 0;
  let rafId = 0;
  let generation = 0;
  let seed = 20260914;
  let mounted = false;

  /** @param {number} n */
  const format = (n) => n.toLocaleString('en-US');

  /** @param {number} value */
  function makeRandom(value) {
    let s = value >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  /** @param {number[]} list */
  function median(list) {
    if (!list.length) return 0;
    const sorted = [...list].sort((a, b) => a - b);
    return sorted[sorted.length >> 1];
  }

  function teardown() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    if (view) view.remove();
    if (project) project.remove();
    view = project = null;
    if (element?.parentNode) element.parentNode.removeChild(element);
    element = null;
  }

  function build() {
    if (!paper || !stage || !mounted) return;
    teardown();
    const run = ++generation;
    const rect = stage.getBoundingClientRect();
    const width = Math.max(320, Math.round(rect.width));
    const height = Math.max(240, Math.round(rect.height));

    element =
      renderer === 'svg'
        ? document.createElementNS('http://www.w3.org/2000/svg', 'svg')
        : document.createElement('canvas');
    // SVG is the default, so the canvas tab has to opt out - otherwise paper
    // takes the <canvas> over and replaces it with an <svg>, and this would
    // quietly be an SVG-vs-SVG comparison.
    element.setAttribute('data-paper-renderer', renderer);
    element.setAttribute('width', String(width));
    element.setAttribute('height', String(height));
    element.style.display = 'block';
    element.style.width = '100%';
    element.style.height = '100%';
    stage.insertBefore(element, stage.firstChild);

    paper.setup(element);
    project = paper.project;
    view = paper.view;
    // Updates are driven by the measuring loop below, not by Paper.js itself.
    view.autoUpdate = false;

    frames = [];
    updates = [];
    lastFrame = 0;
    fps = frame = updateMs = buildMs = '–';
    violations = 0;
    hitIdle = true;
    hit = tool === 'select' ? 'Click an item to select it.' : 'Switch Drag to Select, then click an item.';

    const total = count;
    let made = 0;
    const random = makeRandom(seed);
    const world = { w: width * 6, h: height * 6, x: -width * 2.5, y: -height * 2.5 };
    const started = performance.now();

    building = total > CHUNK;
    progress = 0;

    const chunk = () => {
      if (run !== generation) return;
      const end = Math.min(made + CHUNK, total);
      for (; made < end; made++) {
        const x = world.x + random() * world.w;
        const y = world.y + random() * world.h;
        const r = 3 + random() * 10;
        let item;
        switch (made % 4) {
          case 0:
            item = new paper.Path.Circle(new paper.Point(x, y), r);
            break;
          case 1:
            item = new paper.Path.Rectangle({
              point: [x, y],
              size: [r * 2.2, r * 1.5],
              radius: r / 3
            });
            break;
          case 2:
            item = new paper.Path.RegularPolygon(new paper.Point(x, y), 3, r);
            break;
          default:
            item = new paper.Path.Star(new paper.Point(x, y), 5, r * 0.45, r);
            break;
        }
        item.fillColor = COLORS[made % COLORS.length];
        // One in eight is an outline, so the scene has strokes to render too.
        if (made % 8 === 7) {
          item.fillColor = null;
          item.strokeColor = COLORS[made % COLORS.length];
          item.strokeWidth = 1.5;
        }
      }
      progress = total ? (made / total) * 100 : 100;
      if (made < total) {
        requestAnimationFrame(chunk);
        return;
      }
      requestAnimationFrame(() => {
        if (run !== generation) return;
        view.update();
        buildMs = Math.round(performance.now() - started) + 'ms';
        building = false;
        lastFrame = 0;
        rafId = requestAnimationFrame(loop);
      });
    };
    chunk();
  }

  /** @param {number} now */
  function loop(now) {
    rafId = requestAnimationFrame(loop);
    if (!view) return;
    if (panning) {
      const t = now / 1000;
      view.center = view.center.add(new paper.Point(Math.cos(t / 7) * 6, Math.sin(t / 11) * 6));
    }
    const before = performance.now();
    view.update();
    updates.push(performance.now() - before);
    if (updates.length > 60) updates.shift();

    if (lastFrame) {
      const delta = now - lastFrame;
      frames.push(delta);
      if (frames.length > 60) frames.shift();
      if (delta > 50) logViolation(delta);
    }
    lastFrame = now;
    render();
  }

  let lastRender = 0;
  function render() {
    const now = performance.now();
    if (now - lastRender < 250) return;
    lastRender = now;
    const frameMs = median(frames);
    const update = median(updates);
    fps = frameMs ? (1000 / frameMs).toFixed(0) : '–';
    frame = frameMs ? frameMs.toFixed(1) + 'ms' : '–';
    updateMs = updates.length ? (update < 1 ? update.toFixed(2) : update.toFixed(1)) + 'ms' : '–';
    wire = wireText();
  }

  function wireText() {
    if (!view) return '–';
    const values = view.matrix.values.map(
      /** @param {number} v */ (v) => Math.round(v * 100) / 100
    );
    if (renderer === 'svg') {
      return (
        `<g transform="matrix(${values.join(',')})"> — ` +
        (count ? `1 attribute, ${format(count)} nodes untouched` : 'nothing else')
      );
    }
    return `ctx.clearRect() → setTransform(${values.join(',')}) → ${format(count)} × _draw()`;
  }

  /** @param {number} ms */
  function logViolation(ms) {
    violations++;
    violationLog = [
      {
        id: violations + '-' + Math.round(ms),
        stamp: new Date().toTimeString().slice(0, 8),
        who: renderer === 'svg' ? 'SvgView' : 'CanvasView',
        ms: ms.toFixed(0) + 'ms',
        ctx: format(count) + ' items',
        renderer
      },
      ...violationLog
    ].slice(0, 60);
  }

  /** @param {'svg' | 'canvas'} next */
  function selectRenderer(next) {
    renderer = next;
    build();
  }

  /** @param {'pan' | 'select'} next */
  function selectTool(next) {
    tool = next;
    if (next === 'select' && panning) panning = false;
    hitIdle = true;
    hit = next === 'select' ? 'Click an item to select it.' : 'Switch Drag to Select, then click an item.';
  }

  /** @param {number} clientX @param {number} clientY @param {boolean} add */
  function selectAt(clientX, clientY, add) {
    if (!view || !project) return;
    const rect = stage.getBoundingClientRect();
    const point = view.viewToProject(new paper.Point(clientX - rect.left, clientY - rect.top));
    // The same Project#hitTest() both renderers share: it walks the scene
    // graph and tests geometry, never the rendered pixels or the DOM.
    const started = performance.now();
    const result = project.hitTest(point, {
      fill: true,
      stroke: true,
      segments: true,
      tolerance: 8 / view.zoom
    });
    const ms = performance.now() - started;
    if (!add) project.deselectAll();
    if (result?.item) result.item.selected = !add || !result.item.selected;
    const selected = project.selectedItems.length;
    hitIdle = false;
    hit = result?.item
      ? `hitTest() → ${result.item.className} #${result.item.id} (${result.type}) in ` +
        `${ms.toFixed(1)}ms · ${format(selected)} selected`
      : `hitTest() → nothing here (searched ${format(count)} items in ${ms.toFixed(1)}ms)`;
  }

  let dragging = false;
  /** @type {{x: number, y: number} | null} */ let lastPoint = null;
  /** @type {{x: number, y: number} | null} */ let downPoint = null;
  let moved = 0;
  let downShift = false;
  let interacted = $state(false);

  /** @param {PointerEvent} event */
  function onPointerDown(event) {
    if (!view) return;
    dragging = true;
    moved = 0;
    downShift = event.shiftKey || event.metaKey;
    lastPoint = downPoint = { x: event.clientX, y: event.clientY };
    interacted = true;
    stage.setPointerCapture(event.pointerId);
  }

  /** @param {PointerEvent} event */
  function onPointerMove(event) {
    if (!dragging || !view || !lastPoint) return;
    const zoom = view.zoom;
    moved += Math.abs(event.clientX - lastPoint.x) + Math.abs(event.clientY - lastPoint.y);
    view.center = view.center.subtract(
      new paper.Point((event.clientX - lastPoint.x) / zoom, (event.clientY - lastPoint.y) / zoom)
    );
    lastPoint = { x: event.clientX, y: event.clientY };
  }

  /** @param {PointerEvent} event */
  function endDrag(event) {
    if (!dragging) return;
    dragging = false;
    if (event.pointerId != null && stage.hasPointerCapture(event.pointerId))
      stage.releasePointerCapture(event.pointerId);
    // A press that did not travel is a click, not a pan.
    if (tool === 'select' && moved < 5 && downPoint)
      selectAt(downPoint.x, downPoint.y, downShift || event.shiftKey);
  }

  /** @param {WheelEvent} event */
  function onWheel(event) {
    if (!view) return;
    event.preventDefault();
    interacted = true;
    const rect = stage.getBoundingClientRect();
    const point = view.viewToProject(
      new paper.Point(event.clientX - rect.left, event.clientY - rect.top)
    );
    let factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
    const zoom = Math.min(24, Math.max(0.05, view.zoom * factor));
    factor = zoom / view.zoom;
    view.zoom = zoom;
    view.center = view.center.add(point.subtract(view.center).multiply(1 - 1 / factor));
  }

  /** @type {any} */ let resizeTimer;
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(build, 300);
  }

  onMount(async () => {
    mounted = true;
    paper = (await import('$lib/index.js')).default;
    build();
  });

  onDestroy(() => {
    if (!mounted) return;
    mounted = false;
    clearTimeout(resizeTimer);
    teardown();
  });
</script>

<svelte:window on:resize={onResize} />

<section class="benchmark">
  <div class="tabs" role="tablist" aria-label="Renderer">
    <button
      class="tab"
      role="tab"
      aria-selected={renderer === 'svg'}
      style="--accent: var(--svg)"
      onclick={() => selectRenderer('svg')}
    >
      <span class="dot"></span>SVG DOM <span class="sub">this package</span>
    </button>
    <button
      class="tab"
      role="tab"
      aria-selected={renderer === 'canvas'}
      style="--accent: var(--stock)"
      onclick={() => selectRenderer('canvas')}
    >
      <span class="dot"></span>Canvas2D <span class="sub">stock</span>
    </button>
  </div>

  <div class="toolbar" role="group" aria-label="Scene controls">
    <div class="control">
      <label for="count">Items</label>
      <input
        id="count"
        type="range"
        min="0"
        max={STEPS.length - 1}
        step="1"
        bind:value={countIndex}
        onchange={build}
      />
      <span class="readout">{format(count)}</span>
    </div>
    <div class="control">
      <span class="label" id="toolLabel">Drag</span>
      <span class="segmented" role="group" aria-labelledby="toolLabel">
        <button type="button" aria-pressed={tool === 'pan'} onclick={() => selectTool('pan')}>
          Pan
        </button>
        <button type="button" aria-pressed={tool === 'select'} onclick={() => selectTool('select')}>
          Select
        </button>
      </span>
    </div>
    <div class="spacer"></div>
    <button type="button" onclick={() => (panning = !panning)}>
      {panning ? 'Pause auto-pan' : 'Resume auto-pan'}
    </button>
    <button
      type="button"
      title="Scatter a new set of items"
      onclick={() => {
        seed = (Math.random() * 0xffffff) >>> 0;
        build();
      }}
    >
      ↻ New scene
    </button>
  </div>

  <div class="panel" style="--accent: {renderer === 'svg' ? 'var(--svg)' : 'var(--stock)'}">
    <div class="panel-head">
      <span class="dot"></span>
      <span class="panel-name">{renderer === 'svg' ? 'SvgView' : 'CanvasView'}</span>
      <span class="chip">{renderer}</span>
    </div>

    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="stage"
      class:selecting={tool === 'select'}
      class:busy={building}
      class:interacted
      bind:this={stage}
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={endDrag}
      onpointercancel={endDrag}
      onwheel={onWheel}
    >
      <div class="hint">
        {tool === 'select'
          ? 'click to select · shift-click to add · drag to pan'
          : 'drag to pan · scroll to zoom'}
      </div>
      {#if building}
        <div class="building">
          <span>Building {format(count)} items</span>
          <span class="bar"><span style="width: {progress}%"></span></span>
        </div>
      {/if}
    </div>

    <div class="wire">
      <div class="wire-row">
        <span class="k">Per frame</span>
        <span class="v">{wire}</span>
      </div>
      <div class="wire-row">
        <span class="k">Hit test</span>
        <span class="v" class:idle={hitIdle}>{hit}</span>
      </div>
    </div>

    <div class="stats">
      <div class="stat">
        <span class="k">FPS</span>
        <span class="v" class:good={+fps >= 50} class:bad={fps !== '–' && +fps < 25}>{fps}</span>
      </div>
      <div class="stat"><span class="k">Frame</span><span class="v">{frame}</span></div>
      <div class="stat">
        <span class="k">In update()</span>
        <span class="v" class:good={updateMs !== '–' && parseFloat(updateMs) < 1}>{updateMs}</span>
      </div>
      <div class="stat"><span class="k">Build</span><span class="v muted">{buildMs}</span></div>
      <div class="stat">
        <span class="k">Viol.</span>
        <span class="v" class:bad={violations > 0}>{format(violations)}</span>
      </div>
    </div>
  </div>

  <div class="violations">
    <div class="violations-head">
      <span class="title">Frame violations</span>
      <span class="note">
        &gt;50ms between frames — the threshold Chrome's own "'requestAnimationFrame' handler took
        Nms" warning uses. Only one renderer runs at a time; the log keeps earlier runs, each entry
        named by the renderer that produced it.
      </span>
      <button type="button" onclick={() => { violationLog = []; violations = 0; }}>Clear</button>
    </div>
    <div class="violations-list">
      {#if violationLog.length === 0}
        <div class="violations-empty">
          None yet — try raising the item count, or dragging the scene around fast.
        </div>
      {:else}
        {#each violationLog as entry (entry.id + entry.stamp)}
          <div class="violation-entry {entry.renderer}">
            <span class="stamp">{entry.stamp}</span>
            <span class="who">{entry.who}</span>
            <span>{entry.ms}</span>
            <span class="ctx">{entry.ctx}</span>
          </div>
        {/each}
      {/if}
    </div>
  </div>
</section>

<style>
  .benchmark {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .tabs {
    display: flex;
    gap: 4px;
    padding: 4px;
    background: var(--ink-900);
    border: 1px solid var(--line);
    border-radius: 11px;
  }
  .tab {
    flex: 1 1 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 10px;
    border-radius: 8px;
    border: 1px solid transparent;
    background: none;
    cursor: pointer;
    font-family: 'IBM Plex Mono', monospace;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-dim);
  }
  .tab .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent);
    flex: none;
  }
  .tab[aria-selected='true'] {
    background: var(--ink-800);
    border-color: var(--line);
    color: var(--text);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 30%, transparent) inset;
  }
  .tab .sub {
    font-weight: 400;
    color: var(--text-dim);
    font-size: 11px;
  }

  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px 22px;
    padding: 14px 18px;
    background: var(--ink-900);
    border: 1px solid var(--line);
    border-radius: 10px;
  }
  .control {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .control label,
  .control .label {
    font-size: 12px;
    font-weight: 500;
    color: var(--text-dim);
    white-space: nowrap;
  }
  .readout {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 12.5px;
    color: var(--text);
    min-width: 4.4em;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  input[type='range'] {
    appearance: none;
    -webkit-appearance: none;
    width: 150px;
    height: 3px;
    border-radius: 2px;
    background: var(--line);
    outline: none;
  }
  input[type='range']::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--text);
    border: 2px solid var(--ink-900);
    box-shadow: 0 0 0 1px var(--line);
    cursor: pointer;
  }
  input[type='range']::-moz-range-thumb {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--text);
    border: 2px solid var(--ink-900);
    box-shadow: 0 0 0 1px var(--line);
    cursor: pointer;
  }
  input[type='range']:focus-visible {
    outline: 2px solid var(--text);
    outline-offset: 4px;
  }

  button {
    font: inherit;
    font-family: 'IBM Plex Mono', monospace;
    font-size: 12.5px;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: var(--text);
    background: var(--ink-800);
    border: 1px solid var(--line);
    border-radius: 7px;
    padding: 8px 14px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 7px;
  }
  button:hover {
    border-color: color-mix(in srgb, var(--text) 30%, var(--line));
  }
  button:focus-visible {
    outline: 2px solid var(--text);
    outline-offset: 2px;
  }
  button:active {
    transform: translateY(1px);
  }
  .spacer {
    flex: 1 1 auto;
  }

  .segmented {
    display: flex;
    gap: 2px;
    padding: 2px;
    background: var(--ink-800);
    border: 1px solid var(--line);
    border-radius: 8px;
  }
  .segmented button {
    background: none;
    border: 1px solid transparent;
    border-radius: 6px;
    padding: 5px 11px;
    color: var(--text-dim);
    font-size: 12px;
  }
  .segmented button[aria-pressed='true'] {
    background: var(--ink-900);
    border-color: var(--line);
    color: var(--text);
  }

  .panel {
    background: var(--ink-900);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    box-shadow: var(--shadow);
  }
  .panel-head {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .panel-head .dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    flex: none;
    background: var(--accent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
  }
  .panel-name {
    font-family: 'IBM Plex Mono', monospace;
    font-weight: 600;
    font-size: 14px;
  }
  .chip {
    margin-left: auto;
    font-family: 'IBM Plex Mono', monospace;
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    padding: 3px 8px;
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--line));
    color: var(--accent);
  }

  .stage {
    position: relative;
    background: var(--ink-800);
    border: 1px solid var(--line);
    border-radius: 8px;
    aspect-ratio: 4 / 3;
    overflow: hidden;
    touch-action: none;
    cursor: grab;
  }
  .stage.selecting {
    cursor: crosshair;
  }
  .stage :global(canvas),
  .stage :global(svg) {
    display: block;
    width: 100%;
    height: 100%;
  }

  .hint {
    position: absolute;
    left: 10px;
    bottom: 10px;
    padding: 4px 9px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--ink-950) 72%, transparent);
    border: 1px solid var(--line);
    color: var(--text-dim);
    font-size: 10.5px;
    font-family: 'IBM Plex Mono', monospace;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.4s ease 1.2s;
  }
  .stage:not(.interacted) .hint {
    opacity: 1;
    transition-delay: 0s;
  }

  .building {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    background: color-mix(in srgb, var(--ink-950) 82%, transparent);
    font-family: 'IBM Plex Mono', monospace;
    font-size: 12px;
    color: var(--text-dim);
  }
  .bar {
    width: min(240px, 60%);
    height: 3px;
    background: var(--line);
    border-radius: 2px;
    overflow: hidden;
  }
  .bar span {
    display: block;
    height: 100%;
    background: var(--accent);
  }

  .wire {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 9px 11px;
    background: var(--ink-800);
    border: 1px solid var(--line);
    border-radius: 8px;
    font-family: 'IBM Plex Mono', monospace;
    font-size: 12px;
  }
  .wire-row {
    display: flex;
    align-items: baseline;
    gap: 10px;
    overflow-x: auto;
  }
  .wire-row + .wire-row {
    padding-top: 6px;
    border-top: 1px solid var(--line);
  }
  .wire .k {
    flex: none;
    width: 5.6em;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: var(--text-dim);
  }
  .wire .v {
    white-space: nowrap;
    color: var(--accent);
  }
  .wire .v.idle {
    color: var(--text-dim);
  }

  .stats {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 8px;
  }
  @media (max-width: 560px) {
    .stats {
      grid-template-columns: repeat(2, 1fr);
    }
  }
  .stat {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 9px 10px;
    background: var(--ink-800);
    border: 1px solid var(--line);
    border-radius: 8px;
  }
  .stat .k {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: var(--text-dim);
  }
  .stat .v {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 15.5px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .stat .v.good {
    color: var(--state-good);
  }
  .stat .v.bad {
    color: var(--state-bad);
  }
  .stat .v.muted {
    color: var(--text-dim);
  }

  .violations {
    background: var(--ink-900);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .violations-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }
  .violations-head .title {
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-dim);
  }
  .violations-head .note {
    font-size: 11.5px;
    color: var(--text-dim);
    max-width: 62ch;
  }
  .violations-list {
    max-height: 168px;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 1px;
    font-family: 'IBM Plex Mono', monospace;
    font-size: 12px;
  }
  .violations-empty {
    color: var(--text-dim);
    font-family: 'IBM Plex Sans', sans-serif;
    font-size: 13px;
    padding: 6px 2px;
  }
  .violation-entry {
    display: grid;
    grid-template-columns: 7.6em 8.4em 5.2em 8em;
    gap: 10px;
    padding: 3px 6px;
    border-radius: 4px;
    white-space: nowrap;
    min-width: max-content;
  }
  .violation-entry:nth-child(odd) {
    background: var(--ink-800);
  }
  .violation-entry .stamp {
    color: var(--text-dim);
  }
  .violation-entry .who {
    font-weight: 600;
  }
  .violation-entry.canvas .who {
    color: var(--stock);
  }
  .violation-entry.svg .who {
    color: var(--svg);
  }
  .violation-entry .ctx {
    color: var(--text-dim);
  }
</style>
