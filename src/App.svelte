<script lang="ts">
  import {
    snapshot,
    packQr,
    unpackQr,
    parseJson,
    qrSvg,
    mergeDoses,
    downloadJson,
    type Snapshot,
  } from "./share";

  type Dose = { id: string; name: string; volume: number; mg: number; at: number };
  type Store = { doses: Dose[]; halfLife: number; horizon: number };

  const PRESETS = [
    { name: "Coffee", volume: 240, mg100: 40, tint: "#a16207" },
    { name: "Energy Drink", volume: 250, mg100: 32, tint: "#c4b5fd" },
    { name: "Energy Drink", volume: 330, mg100: 32, tint: "#c4b5fd" },
    { name: "Energy Drink", volume: 500, mg100: 32, tint: "#c4b5fd" },
    { name: "Club-Mate", volume: 500, mg100: 20, tint: "#5eead4" },
    { name: "fritz-kola", volume: 330, mg100: 25, tint: "#fb923c" },
    { name: "Cola", volume: 330, mg100: 10.3, tint: "#f87171" },
  ];

  const KEY = "caffeine-tracker-v1";
  const HOUR = 3_600_000;
  const GUIDELINE = 400;
  const KEEP_DAYS = 40;

  function loadStore(): Store {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return { doses: [], halfLife: 5, horizon: 12 };
      const p = JSON.parse(raw) as Store;
      const cutoff = Date.now() - KEEP_DAYS * 24 * HOUR;
      const doses = (p.doses ?? []).filter((d) => d.at > cutoff);
      return { doses, halfLife: p.halfLife ?? 5, horizon: p.horizon === 24 ? 24 : 12 };
    } catch {
      return { doses: [], halfLife: 5, horizon: 12 };
    }
  }

  const initial = loadStore();

  let doses = $state<Dose[]>(initial.doses);
  let halfLife = $state<number>(initial.halfLife);
  let horizon = $state<number>(initial.horizon);
  let now = $state(Date.now());
  let toast = $state("");
  let toastTimer: ReturnType<typeof setTimeout>;

  let cName = $state("");
  let cVol = $state<number | "">("");
  let cMg = $state<number | "">("");

  // ---- move the state between devices
  let qrCode = $state<null | { svg: string; text: string }>(null);
  let qrBusy = $state(false);
  let qrNote = $state("");
  let fileInput: HTMLInputElement;
  let camOpen = $state(false);
  let camErr = $state("");
  let videoEl: HTMLVideoElement;
  let camStream: MediaStream | null = null;
  let camRaf = 0;
  // the qr decoder is ~120 kB, only pull it in when someone actually scans
  type Decoder = (data: Uint8ClampedArray, w: number, h: number, o?: any) => { data: string } | null;
  let decoder: Promise<Decoder> | null = null;
  const getDecoder = () =>
    (decoder ??= import("jsqr").then((m) => m.default as unknown as Decoder));

  // ---- log time: defaults to now, can be set back in time
  function toLocalInput(ts: number) {
    const d = new Date(ts);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  let whenStr = $state(toLocalInput(Date.now()));
  let whenCustom = $state(false);

  function resetWhen() {
    whenCustom = false;
    whenStr = toLocalInput(Date.now());
  }

  function whenAt(): number {
    if (!whenCustom) return Date.now();
    const t = new Date(whenStr).getTime();
    if (isNaN(t)) return Date.now();
    return Math.min(t, Date.now());
  }

  // ---- persistence
  let storeWarned = false;
  $effect(() => {
    const data: Store = { doses, halfLife, horizon };
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
    } catch {
      // private mode / full quota / storage disabled: keep the session usable and
      // say it once instead of throwing on every tap
      if (!storeWarned) {
        storeWarned = true;
        say("this browser refused local storage — drinks will be lost on reload", 5000);
      }
    }
  });

  // ---- clock
  $effect(() => {
    const t = setInterval(() => {
      now = Date.now();
      if (!whenCustom) {
        const v = toLocalInput(now);
        if (v !== whenStr) whenStr = v;
      }
    }, 50);
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

  // clocks follow the 12 h / 24 h preference
  function clock(ts: number) {
    return new Date(ts).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      hour12: horizon !== 24,
    });
  }

  function fmtTime(ts: number) {
    const d = new Date(ts);
    const hm = clock(ts);
    const day = d.toDateString();
    if (day === new Date(now).toDateString()) return hm;
    if (day === new Date(now - 24 * HOUR).toDateString()) return "yest " + hm;
    if (day === new Date(now + 24 * HOUR).toDateString()) return "tmrw " + hm;
    return d.toLocaleDateString([], { month: "short", day: "2-digit" }) + " " + hm;
  }

  function ago(ts: number) {
    const m = Math.max(0, Math.round((now - ts) / 60000));
    if (m < 1) return "just now";
    if (m < 60) return m + " min ago";
    const h = Math.floor(m / 60);
    return h + " h " + (m % 60) + " min ago";
  }

  // ---- chart
  const chart = $derived.by(() => {
    const W = 640, H = 150, padB = 18, top = 8;
    // snap the ceiling to a round step so edits (add / remove a drink) visibly
    // move the line instead of every re-render rescaling it to the same shape
    const raw = Math.max(total * 1.02, 5);
    const step = [5, 10, 20, 25, 50, 100, 200, 400].find((s) => raw <= s * 5) ?? 500;
    const ymax = Math.ceil(raw / step) * step;
    const x = (h: number) => (h / horizon) * W;
    const y = (mg: number) => top + (1 - mg / ymax) * (H - padB - top);
    const pts: string[] = [];
    const N = 120;
    for (let i = 0; i <= N; i++) {
      const h = (i / N) * horizon;
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
    const h = frac * horizon;
    const mg = total * Math.pow(0.5, h / halfLife);
    hover = { h, mg, ts: now + h * HOUR, frac, vx: chart.x(h), vy: chart.y(mg) };
  }

  function hoverWhen(h: number) {
    if (h < 1 / 60) return "now";
    const m = Math.round(h * 60);
    return m < 60 ? `in ${m} min` : `in ${Math.floor(m / 60)} h ${m % 60} min`;
  }

  function amountAt(t: number) {
    let s = 0;
    for (const d of doses) {
      if (d.at > t) continue;
      s += d.mg * Math.pow(0.5, (t - d.at) / HOUR / halfLife);
    }
    return s;
  }

  // ---- history windows + peaks
  const RANGES = [
    { key: "1d", label: "1 day", ms: 24 * HOUR },
    { key: "3d", label: "3 days", ms: 3 * 24 * HOUR },
    { key: "7d", label: "7 days", ms: 7 * 24 * HOUR },
    { key: "30d", label: "1 month", ms: 30 * 24 * HOUR },
  ] as const;
  type RangeKey = (typeof RANGES)[number]["key"];
  let rangeKey = $state<RangeKey>("1d");
  const range = $derived(RANGES.find((r) => r.key === rangeKey)!);

  function fmtDur(h: number) {
    const m = Math.round(h * 60);
    if (m < 60) return `${m} min`;
    const rest = m % 60;
    return rest ? `${Math.floor(m / 60)} h ${rest} min` : `${Math.floor(m / 60)} h`;
  }

  function fmtHistTime(ts: number, withDay = false) {
    const d = new Date(ts);
    const hm = clock(d.getTime());
    // a 1-day window still reaches into yesterday: the peaks list says so, or a
    // 3:30 PM row appears to come after this morning's
    if (range.ms <= 24.5 * HOUR)
      return withDay && d.toDateString() !== new Date().toDateString() ? `yest ${hm}` : hm;
    if (range.ms <= 8 * 24 * HOUR) {
      return d.toLocaleDateString([], { weekday: "short" }) + " " + hm;
    }
    return d.toLocaleDateString([], { day: "2-digit", month: "short" });
  }

  const hist = $derived.by(() => {
    const ms = range.ms;
    const start = now - ms;
    const W = 640, H = 170, padB = 18, top = 8;

    const inWin = doses.filter((d) => d.at >= start && d.at <= now);
    const peaks = inWin
      .map((d) => {
        const mg = amountAt(d.at);
        const next = doses
          .filter((x) => x.at > d.at + 1000)
          .sort((a, b) => a.at - b.at)[0];
        // trough = the level just *before* the next drink, so it is that drink's
        // starting point rather than its peak (a dose at exactly troughAt would be counted)
        const troughAt = next ? next.at - 1 : now;
        const troughMg = amountAt(troughAt);
        return {
          id: d.id,
          at: d.at,
          mg,
          name: d.name,
          volume: d.volume,
          troughMg,
          dur: (troughAt - d.at) / HOUR,
          troughAt,
          // the newest drink has no next dose yet, so its "drop" is just the level now
          live: !next,
        };
      })
      .sort((a, b) => a.at - b.at);

    const maxPeak = peaks.reduce((m, p) => Math.max(m, p.mg), 0);
    const ymax = Math.max(5, maxPeak * 1.08);
    const x = (t: number) => ((t - start) / ms) * W;
    const y = (mg: number) => top + (1 - mg / ymax) * (H - padB - top);

    // sample a uniform grid, plus the step edge at every dose so peaks are not missed
    const tsSet = new Set<number>();
    const N = 140;
    for (let i = 0; i <= N; i++) tsSet.add(start + (i / N) * ms);
    for (const d of doses) {
      if (d.at > start && d.at <= now) {
        tsSet.add(Math.max(start, d.at - 60000));
        tsSet.add(d.at);
      }
    }
    const times = [...tsSet].filter((t) => t >= start && t <= now).sort((a, b) => a - b);
    const pts = times.map((t) => `${x(t).toFixed(1)},${y(amountAt(t)).toFixed(1)}`);
    const line = "M" + pts.join(" L");
    const area = `${line} L${W},${H - padB} L0,${H - padB} Z`;
    const grid = [0.25, 0.5, 0.75, 1].map((f) => ({ y: y(ymax * f), mg: ymax * f }));
    const totalMg = inWin.reduce((s, d) => s + d.mg, 0);
    const days = ms / (24 * HOUR);

    return { W, H, padB, top, line, area, grid, y0: y(0), x, y, ymax, start, ms, peaks, maxPeak, totalMg, days };
  });

  let histHover = $state<null | { frac: number; mg: number; ts: number; vx: number; vy: number }>(null);

  function onHistHover(e: PointerEvent) {
    const el = e.currentTarget as SVGSVGElement;
    const r = el.getBoundingClientRect();
    if (!r.width) return;
    const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const ts = hist.start + frac * hist.ms;
    const mg = amountAt(ts);
    histHover = { frac, mg, ts, vx: hist.x(ts), vy: hist.y(mg) };
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
    const at = whenAt();
    doses = [...doses, { id: uid(), name, volume, mg, at }];
    // the undo bar owns the toast slot while it is up, so a new drink would be
    // confirmed silently; drop the pending undo and show the add instead
    undoDose = null;
    clearTimeout(undoTimer);
    const past = Date.now() - at > 60000;
    toast = `+${mg.toFixed(1)} mg · ${name} ${volume} ml${past ? " · " + clock(at) : ""}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = ""), 2200);
  }

  // removing a drink can be a misclick, so keep the last one around for an undo
  let undoDose = $state<Dose | null>(null);
  let undoTimer: ReturnType<typeof setTimeout>;

  function remove(id: string) {
    const gone = doses.find((d) => d.id === id);
    if (!gone) return;
    doses = doses.filter((d) => d.id !== id);
    undoDose = gone;
    toast = "";
    clearTimeout(toastTimer);
    clearTimeout(undoTimer);
    undoTimer = setTimeout(() => (undoDose = null), 7000);
  }

  function undoRemove() {
    if (!undoDose) return;
    doses = [...doses, undoDose];
    undoDose = null;
    clearTimeout(undoTimer);
  }

  function clearAll() {
    undoDose = null;
    doses = [];
  }

  // ---- export / import: json file or qr code
  function say(msg: string, ms = 2600) {
    toast = msg;
    undoDose = null;
    clearTimeout(undoTimer);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = ""), ms);
  }

  function currentSnap() {
    return snapshot(doses, halfLife, horizon);
  }

  function exportFile() {
    const name = downloadJson(currentSnap());
    say(`exported ${doses.length} drinks · ${name}`, 3400);
  }

  async function toggleQr() {
    if (qrCode) {
      qrCode = null;
      return;
    }
    qrBusy = true;
    qrNote = "";
    const text = await packQr(currentSnap());
    const svg = await qrSvg(text);
    qrBusy = false;
    if (!svg) {
      qrNote = `${doses.length} drinks is too much for one QR code — use the json file`;
      return;
    }
    qrCode = { svg, text };
  }

  // a fresh device takes the sender's settings; an existing one keeps its own
  function adopt(snap: Snapshot) {
    if (doses.length === 0) {
      halfLife = snap.halfLife;
      horizon = snap.horizon;
    }
  }

  function applySnap(snap: Snapshot, verb: string) {
    if (!snap.doses.length) {
      say(`${verb} file has no drinks`);
      return;
    }
    const merged = mergeDoses(doses, snap.doses, uid);
    doses = merged.doses;
    const skipped = snap.doses.length - merged.added;
    say(`${verb} ${merged.added} new drink${merged.added === 1 ? "" : "s"}${skipped ? ` · ${skipped} already here` : ""}`, 3400);
  }

  async function onFile(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const f = input.files?.[0];
    input.value = "";
    if (!f) return;
    const snap = parseJson(await f.text());
    if (!snap) {
      say("that file is not a caffeine export");
      return;
    }
    adopt(snap);
    applySnap(snap, "imported");
  }

  async function openCam() {
    camErr = "";
    camOpen = true;
    if (!navigator.mediaDevices?.getUserMedia) {
      camErr = "this browser has no camera API — import the json file instead";
      return;
    }
    try {
      const jsQR = await getDecoder();
      camStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      });
      videoEl.srcObject = camStream;
      await videoEl.play();
      camLoop(jsQR);
    } catch {
      camErr = "no camera — allow access and use https (or import the json file)";
    }
  }

  function closeCam() {
    cancelAnimationFrame(camRaf);
    camStream?.getTracks().forEach((t) => t.stop());
    camStream = null;
    camOpen = false;
    camErr = "";
  }

  function camLoop(jsQR: Decoder) {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    const step = () => {
      if (!camOpen) return;
      if (videoEl?.readyState >= 2 && videoEl.videoWidth) {
        const scale = Math.min(1, 720 / videoEl.videoWidth);
        canvas.width = Math.round(videoEl.videoWidth * scale);
        canvas.height = Math.round(videoEl.videoHeight * scale);
        ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const hit = jsQR(img.data, img.width, img.height, { inversionAttempts: "attemptBoth" });
        if (hit?.data) {
          unpackQr(hit.data).then((snap) => {
            if (!snap) {
              camErr = "that QR is not a caffeine code";
              camRaf = requestAnimationFrame(step);
              return;
            }
            adopt(snap);
            applySnap(snap, "scanned");
            closeCam();
          });
          return;
        }
      }
      camRaf = requestAnimationFrame(step);
    };
    camRaf = requestAnimationFrame(step);
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
    <div class="brand"><span class="mark"></span>caffeine<span class="k">live</span></div>
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
      <div class="headLeft">
        <span class="label">next {horizon} hours</span>
        <div class="tabs">
          {#each [12, 24] as h}
            <button class="tab {horizon === h ? 'on' : ''}" onclick={() => (horizon = h)}>{h}h</button>
          {/each}
        </div>
      </div>
      <span class="label">peak {total.toFixed(0)} mg</span>
    </div>
    <div class="chartWrap">
    <svg class="chart" viewBox="0 0 {chart.W} {chart.H}" preserveAspectRatio="none"
         onpointermove={onHover} onpointerdown={onHover} onpointerleave={() => (hover = null)}>
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.28" />
          <stop offset="100%" stop-color="var(--accent)" stop-opacity="0" />
        </linearGradient>
      </defs>
      {#each chart.grid as g}
        <line x1="0" x2={chart.W} y1={g.y} y2={g.y} stroke="var(--line)" stroke-width="1" />
        <text x="2" y={g.y - 4}>{g.mg.toFixed(0)}</text>
      {/each}
      <line x1="0" x2={chart.W} y1={chart.y0} y2={chart.y0} stroke="var(--line2)" stroke-width="1" />
      <path d={chart.area} fill="url(#g)" />
      <path d={chart.line} fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" />
      <circle cx="0" cy={chart.dotY} r="4.5" fill="var(--accent)" />
      <circle cx="0" cy={chart.dotY} r="9" fill="var(--accent)" opacity="0.18" />
      <text x="0" y={chart.H - 4}>now</text>
      {#each [0.25, 0.5, 0.75] as f}
        <text x={chart.W * f} y={chart.H - 4} text-anchor="middle">+{horizon * f}h</text>
      {/each}
      <text x={chart.W} y={chart.H - 4} text-anchor="end">+{horizon}h</text>
      {#if hover}
        <line x1={hover.vx} x2={hover.vx} y1="0" y2={chart.H - chart.padB}
              stroke="var(--accent)" stroke-width="1" opacity="0.4" stroke-dasharray="3 3" />
        <line x1="0" x2={chart.W} y1={hover.vy} y2={hover.vy}
              stroke="var(--accent)" stroke-width="1" opacity="0.22" stroke-dasharray="3 3" />
        <circle cx={hover.vx} cy={hover.vy} r="4.5" fill="#141020" stroke="var(--accent)" stroke-width="2" />
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

  <div class="card hist">
    <div class="cardHead">
      <span class="label">history</span>
      <div class="tabs">
        {#each RANGES as r}
          <button class="tab {rangeKey === r.key ? 'on' : ''}" onclick={() => (rangeKey = r.key)}>
            {r.label}
          </button>
        {/each}
      </div>
    </div>

    {#if hist.peaks.length === 0}
      <div class="empty">No drinks in the last {range.label}. Set a log time below to add one in the past.</div>
    {:else}
      <div class="chartWrap">
        <svg class="chart chart-h" viewBox="0 0 {hist.W} {hist.H}" preserveAspectRatio="none"
             onpointermove={onHistHover} onpointerdown={onHistHover} onpointerleave={() => (histHover = null)}>
          <defs>
            <linearGradient id="gh" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.24" />
              <stop offset="100%" stop-color="var(--accent)" stop-opacity="0" />
            </linearGradient>
          </defs>
          {#each hist.grid as g}
            <line x1="0" x2={hist.W} y1={g.y} y2={g.y} stroke="var(--line)" stroke-width="1" />
            <text x="2" y={g.y - 4}>{g.mg.toFixed(0)}</text>
          {/each}
          <line x1="0" x2={hist.W} y1={hist.y0} y2={hist.y0} stroke="var(--line2)" stroke-width="1" />
          <path d={hist.area} fill="url(#gh)" />
          <path d={hist.line} fill="none" stroke="var(--accent)" stroke-width="1.8" stroke-linecap="round" />
          {#each hist.peaks as p (p.id)}
            <line x1={hist.x(p.at)} x2={hist.x(p.at)} y1={hist.y(p.mg)} y2={hist.y0}
                  stroke="var(--accent)" stroke-width="1" opacity="0.16" stroke-dasharray="2 3" />
            <circle cx={hist.x(p.at)} cy={hist.y(p.mg)} r="3" fill="#141020" stroke="var(--accent)" stroke-width="1.6" />
          {/each}
          {#if histHover}
            <line x1={histHover.vx} x2={histHover.vx} y1="0" y2={hist.H - hist.padB}
                  stroke="var(--accent)" stroke-width="1" opacity="0.4" stroke-dasharray="3 3" />
            <circle cx={histHover.vx} cy={histHover.vy} r="4.5" fill="#141020" stroke="var(--accent)" stroke-width="2" />
          {/if}
          <text x="0" y={hist.H - 4}>{fmtHistTime(hist.start)}</text>
          <text x={hist.W * 0.5} y={hist.H - 4} text-anchor="middle">{fmtHistTime(hist.start + hist.ms * 0.5)}</text>
          <text x={hist.W} y={hist.H - 4} text-anchor="end">now</text>
        </svg>
        {#if histHover}
          <div class="tip" style="left: clamp(64px, {histHover.frac * 100}%, calc(100% - 64px))">
            <b>{histHover.mg.toFixed(1)} mg</b>
            <span>{fmtHistTime(histHover.ts)}</span>
          </div>
        {/if}
      </div>

      <div class="stats histStats">
        <div class="stat"><span>highest peak</span><strong>{hist.maxPeak.toFixed(0)} mg</strong></div>
        <div class="stat"><span>peaks</span><strong>{hist.peaks.length}</strong></div>
        <div class="stat"><span>taken in {range.label}</span><strong>{hist.totalMg.toFixed(0)} mg</strong></div>
      </div>

      <div class="peaks">
        {#each [...hist.peaks].reverse().slice(0, 8) as p (p.id)}
          <div class="peak">
            <span class="t">{fmtHistTime(p.at, true)}</span>
            <b>{p.mg.toFixed(1)} mg</b>
            <span class="drop">{p.name} {p.volume} ml · {p.live
                ? `now ${p.troughMg.toFixed(1)} mg`
                : `falls to ${p.troughMg.toFixed(1)} mg by ${clock(p.troughAt)}`}</span>
          </div>
        {/each}
        {#if hist.peaks.length > 8}
          <div class="peak more">+{hist.peaks.length - 8} older peaks</div>
        {/if}
      </div>
    {/if}
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
  <div class="when">
    <span class="label">log time</span>
    <input type="datetime-local" bind:value={whenStr} max={toLocalInput(Date.now())}
           oninput={() => (whenCustom = true)} />
    {#if whenCustom}
      <button class="tab on" onclick={resetWhen}>now</button>
    {:else}
      <span class="whendim">watching the clock</span>
    {/if}
  </div>
  <div class="grid">
    {#each PRESETS as p}
      <button class="drink" onclick={() => addDrink(p.name, p.volume, p.mg100)}>
        <span class="plus">+</span>
        <div class="nm"><span class="swatch" style="background:{p.tint}"></span>{p.name}</div>
        <div class="sz">{p.volume} ml · {p.mg100} mg/100 ml</div>
        <div class="mgrow">
          <span class="mg">{((p.volume / 100) * p.mg100).toFixed(1)}</span>
          <span class="unit2">mg</span>
        </div>
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
          <button class="iconbtn rm" title="remove this drink" aria-label="remove {d.name}" onclick={() => remove(d.id)}>✕</button>
        </div>
      {/each}
    {/if}
  </div>

  <h2>move between devices</h2>
  <div class="card sync">
    <div class="syncRow">
      <button class="tab" onclick={exportFile}>export json</button>
      <button class="tab" onclick={toggleQr} disabled={qrBusy}>{qrCode ? "hide qr" : qrBusy ? "building…" : "show qr"}</button>
      <button class="tab" onclick={() => fileInput.click()}>import json</button>
      <button class="tab" onclick={openCam}>scan qr</button>
      <input class="filehide" type="file" accept=".json,application/json" bind:this={fileInput} onchange={onFile} />
    </div>
    {#if qrCode}
      <div class="qrBox">
        <div class="qrPic">{@html qrCode.svg}</div>
        <p class="hint">{doses.length} drinks · {qrCode.text.length} characters. Point the other device's
          camera at it, or import the json file. Nothing leaves the browser.</p>
      </div>
    {/if}
    {#if qrNote}<p class="hint warn">{qrNote}</p>{/if}
    <p class="hint">import merges: drinks you already have here are not doubled, and this
      device keeps its own half-life and clock setting unless it is empty.</p>
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

<div class="scan {camOpen ? 'on' : ''}">
  <div class="scanCard">
    <video bind:this={videoEl} playsinline muted></video>
    <div class="scanHint">{camErr || "point the camera at the qr code"}</div>
    <button class="tab" onclick={closeCam}>close</button>
  </div>
</div>

<div class="toast {toast || undoDose ? 'show' : ''} {undoDose ? 'undoing' : ''}">
  {#if undoDose}
    <span>removed {undoDose.name} · {undoDose.volume} ml</span>
    <button class="undoBtn" onclick={undoRemove}>undo</button>
  {:else}
    {toast}
  {/if}
</div>
