<script>
  import Benchmark from './Benchmark.svelte';

  const install = 'npm i github:Typogram/paper.js#dist-only';
  let copied = $state(false);

  async function copyInstall() {
    try {
      await navigator.clipboard.writeText(install);
      copied = true;
      setTimeout(() => (copied = false), 1600);
    } catch {
      /* clipboard blocked - the command is right there to select */
    }
  }
</script>

<svelte:head>
  <title>Paper.js, rendered as SVG</title>
  <meta
    name="description"
    content="Paper.js with an SVG renderer: the same API, mirrored into a native SVG DOM tree instead of redrawn into a canvas every frame. Panning a 100,000-item document costs one attribute."
  />
</svelte:head>

<div class="page">
  <header class="masthead">
    <div class="eyebrow">@typogram/paper.js</div>
    <h1>Paper.js, rendered as SVG</h1>
    <p class="dek">
      Stock Paper.js redraws the whole scene into a canvas on every frame, so panning a document
      with tens of thousands of items costs a full scene traversal per frame. This fork adds a
      second renderer that mirrors the scene graph into a native SVG DOM tree and keeps one node per
      item alive. Moving the camera then costs a single
      <code>transform</code> attribute — no matter how many items there are.
    </p>
    <div class="install">
      <code>{install}</code>
      <button type="button" onclick={copyInstall}>{copied ? 'Copied' : 'Copy'}</button>
      <a href="https://github.com/Typogram/paper.js" rel="noreferrer">Source on GitHub →</a>
    </div>
    <p class="sub">
      Upstream Paper.js 0.12.18 plus the renderer. Same API, same items, same hit-testing, same
      events — a drop-in replacement for the <code>paper</code> package, and it installs under that
      name, so nothing that imports <code>paper</code> has to change.
    </p>
  </header>

  <section>
    <h2 class="section-title">See it</h2>
    <p class="section-note">
      The same scene and the same auto-pan through both renderers, one at a time so each is measured
      on its own frames. Drag to pan, scroll to zoom, or switch Drag to Select and click an item —
      hit-testing and selection handles work the same either way.
    </p>
    <Benchmark />
  </section>

  <section>
    <h2 class="section-title">Use it</h2>
    <div class="cols">
      <div class="col">
        <h3>Nothing to rewrite</h3>
        <pre><code
            >{`import paper from 'paper';

paper.setup(canvas);
new paper.Path.Circle({
  center: [80, 50],
  radius: 35,
  fillColor: 'red'
});`}</code
          ></pre>
        <p>
          Items, styles, tools, events, <code>hitTest()</code>, import and export are all upstream
          Paper.js. The renderer is the only thing that changed.
        </p>
      </div>
      <div class="col">
        <h3>Opting out</h3>
        <pre><code
            >{`// per scope, before setup()
paper.settings.renderer = 'canvas';

// or per view
<canvas data-paper-renderer="canvas">`}</code
          ></pre>
        <p>
          SVG is the default here. A view that needs the canvas back — to read its pixels, say — opts
          out on its own, and everything else keeps rendering as SVG.
        </p>
      </div>
    </div>
  </section>

  <section>
    <h2 class="section-title">How it works</h2>
    <div class="notes">
      <div class="note">
        <h3>The scene becomes DOM once</h3>
        <p>
          One node per item, kept alive and updated in place. The view learns what changed through
          Paper.js's own change tracking, so an update touches the items that actually changed
          rather than walking the scene.
        </p>
      </div>
      <div class="note">
        <h3>Panning is one attribute</h3>
        <p>
          The view matrix lives on the root <code>&lt;g&gt;</code>. A pan or zoom writes
          <code>transform="matrix(…)"</code> and nothing else — no item is visited, no path rebuilt.
          The browser keeps the rasterized geometry and skips what is off screen.
        </p>
      </div>
      <div class="note">
        <h3>What it costs instead</h3>
        <p>
          Setup time and memory: 100,000 live nodes is a real burden, and changing every item in one
          frame is more expensive here than a redraw. It trades per-frame work for per-change work,
          which is the trade an editor wants.
        </p>
      </div>
    </div>
  </section>

  <section>
    <h2 class="section-title">Know this before you switch</h2>
    <ul class="caveats">
      <li>
        <strong>The element is swapped.</strong> Handed a <code>&lt;canvas&gt;</code>, the view replaces
        it with an <code>&lt;svg&gt;</code> and puts the original back on
        <code>remove()</code>. Code holding its own reference to that canvas — a framework ref, listeners
        bound to it, or <code>canvas.toDataURL()</code> for a thumbnail — should render an
        <code>&lt;svg&gt;</code> element itself, or opt that view out. To read pixels, go through
        <code>Item#rasterize()</code>, which makes its own canvas either way.
      </li>
      <li>
        <strong>Five blend modes render as normal.</strong>
        <code>add</code> maps to CSS <code>plus-lighter</code> and the other 15 map to the CSS mode of
        the same name, but <code>subtract</code>, <code>average</code>, <code>pin-light</code> and
        <code>negation</code> have no CSS equivalent — Paper.js emulates those in JavaScript for the canvas
        renderer, which a DOM tree cannot do.
      </li>
      <li>
        <strong>Text measurement still uses a canvas.</strong> SVG cannot measure text without laying
        it out, so an offscreen 1×1 context is kept for <code>PointText</code> bounds. It is the only
        canvas left in the rendering path.
      </li>
    </ul>
  </section>

  <footer>
    <span class="mono">@typogram/paper.js · MIT</span>
    <span>
      Frame times on this page are measured between animation frames, so the browser's own layout
      and paint are counted too, not just Paper.js. 60fps is the display's ceiling, not the
      renderer's.
    </span>
  </footer>
</div>

<style>
  .page {
    max-width: 900px;
    margin: 0 auto;
    padding-block: 40px 56px;
    padding-left: 24px;
    padding-right: 24px;
    display: flex;
    flex-direction: column;
    gap: 40px;
  }

  .masthead {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .eyebrow {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: var(--text-dim);
  }
  h1 {
    margin: 0;
    font-family: 'IBM Plex Mono', ui-monospace, monospace;
    font-weight: 600;
    font-size: clamp(26px, 4vw, 38px);
    letter-spacing: -0.015em;
    text-wrap: balance;
  }
  .dek {
    margin: 6px 0 0;
    max-width: 66ch;
    color: var(--text-dim);
    font-size: 15px;
    line-height: 1.6;
  }
  .dek code,
  .sub code {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 0.92em;
    color: var(--text);
  }
  .sub {
    margin: 0;
    max-width: 66ch;
    font-size: 13px;
    color: var(--text-dim);
  }

  .install {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    margin: 14px 0 6px;
    padding: 12px 14px;
    background: var(--ink-900);
    border: 1px solid var(--line);
    border-left: 2px solid var(--svg);
    border-radius: 4px;
  }
  .install code {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 13.5px;
    color: var(--text);
  }
  .install button {
    font: inherit;
    font-family: 'IBM Plex Mono', monospace;
    font-size: 11.5px;
    font-weight: 600;
    color: var(--text-dim);
    background: var(--ink-800);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 4px 10px;
    cursor: pointer;
  }
  .install button:hover {
    color: var(--text);
  }
  .install a {
    margin-left: auto;
    font-size: 13px;
    color: var(--svg);
    text-decoration: none;
  }
  .install a:hover {
    text-decoration: underline;
  }

  section {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .section-title {
    margin: 0;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-dim);
  }
  .section-note {
    margin: 0 0 4px;
    max-width: 66ch;
    font-size: 14px;
    line-height: 1.55;
    color: var(--text-dim);
  }

  .cols,
  .notes {
    display: grid;
    gap: 16px;
  }
  .cols {
    grid-template-columns: repeat(2, 1fr);
  }
  .notes {
    grid-template-columns: repeat(3, 1fr);
    padding: 18px 20px;
    background: var(--ink-900);
    border: 1px solid var(--line);
    border-radius: 12px;
  }
  @media (max-width: 720px) {
    .cols,
    .notes {
      grid-template-columns: 1fr;
    }
  }

  .col {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 16px 18px;
    background: var(--ink-900);
    border: 1px solid var(--line);
    border-radius: 12px;
  }
  .col h3,
  .note h3 {
    margin: 0;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-dim);
  }
  .col p,
  .note p {
    margin: 0;
    font-size: 13.5px;
    line-height: 1.55;
    color: var(--text);
  }
  pre {
    margin: 0;
    padding: 12px 14px;
    background: var(--ink-800);
    border: 1px solid var(--line);
    border-radius: 8px;
    overflow-x: auto;
  }
  code {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 12.5px;
    line-height: 1.6;
  }
  p code,
  li code {
    background: var(--ink-800);
    border: 1px solid var(--line);
    border-radius: 4px;
    padding: 0.05em 0.35em;
    font-size: 0.92em;
  }

  .caveats {
    margin: 0;
    padding: 18px 20px 18px 38px;
    background: var(--ink-900);
    border: 1px solid var(--line);
    border-radius: 12px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .caveats li {
    font-size: 13.5px;
    line-height: 1.6;
    color: var(--text);
    max-width: 78ch;
  }
  .caveats strong {
    font-weight: 600;
  }

  footer {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
    font-size: 12px;
    color: var(--text-dim);
    padding-top: 8px;
    border-top: 1px solid var(--line);
  }
  .mono {
    font-family: 'IBM Plex Mono', monospace;
  }
</style>
