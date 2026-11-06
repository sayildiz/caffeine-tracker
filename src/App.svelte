<script lang="ts">
  type Dose = { id: string; name: string; volume: number; mg: number; at: number };
  type Store = { doses: Dose[]; halfLife: number };

  const PRESETS = [
    { name: "Energy Drink", volume: 250, mg100: 32, tint: "#c9f24d" },
    { name: "Energy Drink", volume: 330, mg100: 32, tint: "#c9f24d" },
    { name: "Energy Drink", volume: 500, mg100: 32, tint: "#c9f24d" },
    { name: "Club-Mate", volume: 500, mg100: 20, tint: "#8fe08a" },
    { name: "fritz-kola", volume: 330, mg100: 25, tint: "#ff9d6b" },
  ];

  const KEY = "caffeine-tracker-v1";
  const HOUR = 3_600_000;
  const GUIDELINE = 400;

  function loadStore(): Store {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return { doses: [], halfLife: 5 };
      const p = JSON.parse(raw) as Store;
      const cutoff = Date.now() - 36 * HOUR;
      const doses = (p.doses ?? []).filter((d) => d.at > cutoff);
      return { doses, halfLife: p.halfLife ?? 5 };
    } catch {
      return { doses: [], halfLife: 5 };
    }
  }

  const initial = loadStore();

  let doses = $state<Dose[]>(initial.doses);
  let halfLife = $state<number>(initial.halfLife);
  let now = $state(Date.now());
  let toast = $state("");
  let toastTimer: ReturnType<typeof setTimeout>;

  let cName = $state("");
  let cVol = $state<number | "">("");
  let cMg = $state<number | "">("");

  // ---- persistence
  $effect(() => {
    const data: Store = { doses, halfLife };
    localStorage.setItem(KEY, JSON.stringify(data));
  });

  // ---- clock
  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 50);
    return () => clearInterval(t);
  });

  // ---- math
  function remaining(d: Dose, t: number) {
    const h = (t - d.at) / HOUR;
    if (h < 0) return 0;
    return d.mg * Math.pow(0.5, h / halfLife);
  }

  const total = $derived(doses.reduce((s, d) => s + remaining(d, now), 0));
  const perHour = $derived((total * Math.LN2) / halfLife);

  const startOfDay = $derived.by(() => {
    const d = new Date(now);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  });
  const todayMg = $derived(doses.filter((d) => d.at >= startOfDay).reduce((s, d) => s + d.mg, 0));

  const bits = $derived(total.toFixed(2).split("."));

  function atTime(mg: number, target: number) {
    if (mg <= target) return now;
    return now + (halfLife * Math.log(mg / target) / Math.LN2) * HOUR;
  }
  const halfAt = $derived(atTime(total, total / 2 || 0.01));
  const clearAt = $derived(atTime(total, 20));

  function fmtTime(ts: number) {
    const d = new Date(ts);
    const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const sameDay = new Date(ts).toDateString() === new Date(now).toDateString();
    return sameDay ? hm : "tmrw " + hm;
  }

  function ago(ts: number) {
    const m = Math.max(0, Math.round((now - ts) / 60000));
    if (m < 1) return "just now";
    if (m < 60) return m + " min ago";
    const h = Math.floor(m / 60);
    return h + " h " + (m % 60) + " min ago";
  }

  // ---- chart
  const HORIZON = 12;
  const chart = $derived.by(() => {
    const W = 640, H = 150, padB = 18, top = 8;
    const ymax = Math.max(total * 1.02, 5);
    const x = (h: number) => (h / HORIZON) * W;
    const y = (mg: number) => top + (1 - mg / ymax) * (H - padB - top);
    const pts: string[] = [];
    const N = 120;
    for (let i = 0; i <= N; i++) {
      const h = (i / N) * HORIZON;
      const mg = total * Math.pow(0.5, h / halfLife);
      pts.push(`${x(h).toFixed(1)},${y(mg).toFixed(1)}`);
    }
    const line = "M" + pts.join(" L");
    const area = `${line} L${W},${H - padB} L0,${H - padB} Z`;
    const grid = [0.25, 0.5, 0.75].map((f) => ({ y: y(ymax * f), mg: ymax * f }));
    return { W, H, padB, line, area, grid, y0: y(0), x, y, ymax, dotY: y(total) };
  });

  // ---- chart hover readout
  let hover = $state<null | { h: number; mg: number; ts: number; frac: number; vx: number; vy: number }>(null);

  function onHover(e: PointerEvent) {
    const el = e.currentTarget as SVGSVGElement;
    const r = el.getBoundingClientRect();
    if (!r.width) return;
    const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const h = frac * HORIZON;
    const mg = total * Math.pow(0.5, h / halfLife);
    hover = { h, mg, ts: now + h * HOUR, frac, vx: chart.x(h), vy: chart.y(mg) };
  }

  function hoverWhen(h: number) {
    if (h < 1 / 60) return "now";
    const m = Math.round(h * 60);
    return m < 60 ? `in ${m} min` : `in ${Math.floor(m / 60)} h ${m % 60} min`;
  }

  // ---- actions
  // crypto.randomUUID only exists in secure contexts (https/localhost),
  // so plain-http LAN access needs a fallback id.
  function uid() {
    const c = globalThis.crypto as any;
    if (typeof c?.randomUUID === "function") return c.randomUUID() as string;
    return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  function addDrink(name: string, volume: number, mg100: number) {
    const mg = Math.round((volume / 100) * mg100 * 10) / 10;
    doses = [...doses, { id: uid(), name, volume, mg, at: Date.now() }];
    toast = `+${mg.toFixed(1)} mg · ${name} ${volume} ml`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = ""), 2200);
  }

  function remove(id: string) {
    doses = doses.filter((d) => d.id !== id);
  }

  function clearAll() {
    doses = [];
  }

  const customValid = $derived(
    cName.trim().length > 0 && Number(cVol) > 0 && Number(cMg) > 0
  );

  function addCustom() {
    if (!customValid) return;
    addDrink(cName.trim(), Number(cVol), Number(cMg));
    cName = "";
    cVol = "";
    cMg = "";
  }

  const sorted = $derived([...doses].sort((a, b) => b.at - a.at));
  const overLimit = $derived(todayMg > GUIDELINE);
</script>

<div class="wrap">
  <header>
    <div class="brand"><b>caffeine</b><span class="dot">·</span>live</div>
    <div class="live"><i></i> tracking</div>
  </header>

  <section class="hero">
    <div class="heroTop">
      <span class="label">in your body right now</span>
      <span class="label">{doses.length} drink{doses.length === 1 ? "" : "s"} active</span>
    </div>

    <div class="readout">
      <span class="int">{bits[0]}</span><span class="frac">.{bits[1]}</span><span class="unit">mg</span>
    </div>

    <div class="sub">
      {#if total > 0.01}
        falling at <b>{perHour.toFixed(2)} mg/h</b> · half-life {halfLife.toFixed(1)} h
      {:else}
        nothing in your system — tap a drink below
      {/if}
    </div>

    <div class="stats">
      <div class="stat"><span>50% gone</span><strong>{total > 0.01 ? fmtTime(halfAt) : "—"}</strong></div>
      <div class="stat"><span>under 20 mg</span><strong>{total > 0.01 ? fmtTime(clearAt) : "—"}</strong></div>
      <div class="stat"><span>consumed today</span><strong>{todayMg.toFixed(0)} mg</strong></div>
    </div>
  </section>

  <div class="card">
    <div class="cardHead">
      <span class="label">next 12 hours</span>
      <span class="label">peak {total.toFixed(0)} mg</span>
    </div>
    <div class="chartWrap">
    <svg class="chart" viewBox="0 0 {chart.W} {chart.H}" preserveAspectRatio="none"
         onpointermove={onHover} onpointerdown={onHover} onpointerleave={() => (hover = null)}>
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#c9f24d" stop-opacity="0.28" />
          <stop offset="100%" stop-color="#c9f24d" stop-opacity="0" />
        </linearGradient>
      </defs>
      {#each chart.grid as g}
        <line x1="0" x2={chart.W} y1={g.y} y2={g.y} stroke="#20261f" stroke-width="1" />
        <text x="2" y={g.y - 4}>{g.mg.toFixed(0)}</text>
      {/each}
      <line x1="0" x2={chart.W} y1={chart.y0} y2={chart.y0} stroke="#2c342a" stroke-width="1" />
      <path d={chart.area} fill="url(#g)" />
      <path d={chart.line} fill="none" stroke="#c9f24d" stroke-width="2" stroke-linecap="round" />
      <circle cx="0" cy={chart.dotY} r="4.5" fill="#c9f24d" />
      <circle cx="0" cy={chart.dotY} r="9" fill="#c9f24d" opacity="0.18" />
      <text x="0" y={chart.H - 4}>now</text>
      <text x={chart.W * 0.25} y={chart.H - 4} text-anchor="middle">+3h</text>
      <text x={chart.W * 0.5} y={chart.H - 4} text-anchor="middle">+6h</text>
      <text x={chart.W * 0.75} y={chart.H - 4} text-anchor="middle">+9h</text>
      <text x={chart.W} y={chart.H - 4} text-anchor="end">+12h</text>
      {#if hover}
        <line x1={hover.vx} x2={hover.vx} y1="0" y2={chart.H - chart.padB}
              stroke="#c9f24d" stroke-width="1" opacity="0.4" stroke-dasharray="3 3" />
        <line x1="0" x2={chart.W} y1={hover.vy} y2={hover.vy}
              stroke="#c9f24d" stroke-width="1" opacity="0.22" stroke-dasharray="3 3" />
        <circle cx={hover.vx} cy={hover.vy} r="4.5" fill="#0a0c0b" stroke="#c9f24d" stroke-width="2" />
      {/if}
    </svg>
    {#if hover}
      <div class="tip" style="left: clamp(64px, {hover.frac * 100}%, calc(100% - 64px))">
        <b>{hover.mg.toFixed(1)} mg</b>
        <span>{fmtTime(hover.ts)} · {hoverWhen(hover.h)}</span>
      </div>
    {/if}
    </div>
  </div>

  <div class="card limit">
    <div class="limitRow">
      <span>today vs. 400 mg guideline</span>
      <span>{todayMg.toFixed(0)} / {GUIDELINE} mg · {Math.round((todayMg / GUIDELINE) * 100)}%</span>
    </div>
    <div class="track">
      <div class="fill {overLimit ? 'over' : ''}" style="width: {Math.min(100, (todayMg / GUIDELINE) * 100)}%"></div>
    </div>
  </div>

  <h2>add a drink</h2>
  <div class="grid">
    {#each PRESETS as p}
      <button class="drink" onclick={() => addDrink(p.name, p.volume, p.mg100)}>
        <div class="nm"><span class="swatch" style="background:{p.tint}"></span>{p.name}</div>
        <div class="sz">{p.volume} ml · {p.mg100} mg / 100 ml</div>
        <div class="mg">{((p.volume / 100) * p.mg100).toFixed(1)}<small>mg</small></div>
        <div class="ratio">caffeine added</div>
      </button>
    {/each}
  </div>

  <h2>custom</h2>
  <div class="custom">
    <input placeholder="drink name" bind:value={cName} />
    <input type="number" placeholder="ml" bind:value={cVol} min="1" />
    <input type="number" placeholder="mg / 100 ml" bind:value={cMg} min="1" step="0.1" />
    <button class="primary" disabled={!customValid} onclick={addCustom}>Add</button>
  </div>

  <h2>log</h2>
  <div class="card log">
    {#if sorted.length === 0}
      <div class="empty">No drinks logged yet. Pick a preset above and watch the number fall.</div>
    {:else}
      {#each sorted as d (d.id)}
        <div class="entry">
          <div class="t">{fmtTime(d.at)}</div>
          <div class="d">
            <b>{d.name} · {d.volume} ml</b>
            <span>{d.mg.toFixed(1)} mg taken · {ago(d.at)}</span>
          </div>
          <div class="now">{remaining(d, now).toFixed(2)} <small>mg left</small></div>
          <button class="iconbtn" title="remove" onclick={() => remove(d.id)}>✕</button>
        </div>
      {/each}
    {/if}
  </div>

  <div class="card">
    <div class="row">
      <span>half-life <b>{halfLife.toFixed(1)} h</b></span>
      <input type="range" min="3" max="8" step="0.5" bind:value={halfLife} />
    </div>
    <div class="hint">
      Caffeine decays exponentially: every {halfLife.toFixed(1)} h the amount in your body halves.
      3–4 h is fast metabolism, 5–6 h typical, 7–8 h slow / pregnancy / some medications.
    </div>
    {#if doses.length}
      <div class="row" style="margin-top:14px">
        <span>saved locally in this browser</span>
        <button class="iconbtn" style="width:auto;padding:0 10px;height:26px;font-size:11.5px" onclick={clearAll}>reset</button>
      </div>
    {/if}
  </div>

  <footer>
    Estimates only — not medical advice. Nicotine, hormonal birth control and grapefruit slow clearance.
  </footer>
</div>

<div class="toast {toast ? 'show' : ''}">{toast}</div>
