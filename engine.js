/* Jazz's Lyric Snips — browser engine.
   The same steps as the desktop app (app/engine.py), done in the browser: song analysis, clip scanning,
   beat-synced cut planning, lyrics, looks, performance sync and MP4 rendering with WebCodecs.
   Nothing is uploaded: every file stays on the visitor's computer. */
(function () {
"use strict";
const W = 1080, H = 1920, FPS = 30;
const SR = 22050, HOP = 512, NFFT = 2048;

// ---------------------------------------------------------------- small helpers
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function hann(n) { const w = new Float32Array(n); for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)); return w; }
function mean(a, i0 = 0, i1 = a.length) { let s = 0; for (let i = i0; i < i1; i++) s += a[i]; return s / Math.max(1, i1 - i0); }
function percentile(arr, p) { const a = Array.from(arr).sort((x, y) => x - y); if (!a.length) return 0; const k = (a.length - 1) * p / 100, f = Math.floor(k), c = Math.min(a.length - 1, f + 1); return a[f] + (a[c] - a[f]) * (k - f); }
function seeded(seed) { let t = (seed >>> 0) + 0x6D2B79F5; return () => { t += 0x6D2B79F5; let r = Math.imul(t ^ (t >>> 15), 1 | t); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; }; }
const choice = (rng, a) => a[Math.floor(rng() * a.length)];
function shuffle(rng, a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

// in-place radix-2 FFT on (re, im)
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2, tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

// ---------------------------------------------------------------- audio
async function decodeFile(file) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  try { return await ctx.decodeAudioData(await file.arrayBuffer()); } finally { ctx.close(); }
}
async function toMono(buffer, rate = SR) {
  const off = new OfflineAudioContext(1, Math.ceil(buffer.duration * rate), rate);
  const src = off.createBufferSource(); src.buffer = buffer; src.connect(off.destination); src.start();
  return (await off.startRendering()).getChannelData(0);
}
function stftMags(y, onFrame) {
  const win = hann(NFFT), n = Math.floor((y.length - NFFT) / HOP) + 1;
  const re = new Float32Array(NFFT), im = new Float32Array(NFFT);
  for (let f = 0; f < n; f++) {
    const o = f * HOP;
    for (let i = 0; i < NFFT; i++) { re[i] = y[o + i] * win[i]; im[i] = 0; }
    fft(re, im);
    onFrame(f, re, im);
  }
  return n;
}
function onsetEnvelope(y) {
  const half = NFFT / 2 + 1;
  let prev = null;
  const flux = [], rms = [];
  stftMags(y, (f, re, im) => {
    const mag = new Float32Array(half);
    for (let k = 0; k < half; k++) mag[k] = Math.log1p(100 * Math.hypot(re[k], im[k]));
    let s = 0; if (prev) for (let k = 0; k < half; k++) { const d = mag[k] - prev[k]; if (d > 0) s += d; }
    flux.push(s); prev = mag;
    let e = 0; const o = f * HOP; for (let i = 0; i < NFFT; i++) e += y[o + i] * y[o + i]; rms.push(Math.sqrt(e / NFFT));
  });
  const n = flux.length, env = new Float32Array(n);
  for (let i = 0; i < n; i++) { const a = Math.max(0, i - 8), b = Math.min(n, i + 8); env[i] = Math.max(0, flux[i] - mean(flux, a, b)); }
  let m = mean(env), sd = 0; for (const v of env) sd += (v - m) ** 2; sd = Math.sqrt(sd / n) + 1e-9;
  for (let i = 0; i < n; i++) env[i] /= sd;
  return { env, rms: Float32Array.from(rms) };
}
function estimateTempo(env, fps) {
  const n = env.length, m = mean(env); let best = -Infinity, bestLag = 1;
  for (let lag = Math.ceil(60 * fps / 180); lag <= Math.floor(60 * fps / 60); lag++) {
    let s = 0; for (let i = 0; i + lag < n; i++) s += (env[i] - m) * (env[i + lag] - m);
    const bpm = 60 * fps / lag, w = Math.exp(-0.5 * (Math.log2(bpm / 110) / 0.9) ** 2);
    if (s * w > best) { best = s * w; bestLag = lag; }
  }
  return 60 * fps / bestLag;
}
function trackBeats(env, fps, bpm, tightness = 100) {
  const period = 60 * fps / bpm, n = env.length, score = Float32Array.from(env), back = new Int32Array(n).fill(-1);
  const lo = Math.round(-2 * period), hi = Math.round(-period / 2), offs = [], pen = [];
  for (let o = lo; o <= hi; o++) { offs.push(o); pen.push(-tightness * Math.log(-o / period) ** 2); }
  for (let i = 0; i < n; i++) {
    let best = -Infinity, bj = -1;
    for (let k = 0; k < offs.length; k++) { const p = i + offs[k]; if (p < 0) continue; const c = score[p] + pen[k]; if (c > best) { best = c; bj = p; } }
    if (bj >= 0) { score[i] = env[i] + best; back[i] = bj; }
  }
  const P = Math.floor(period); let i = n - P, mx = -Infinity;
  for (let k = n - P; k < n; k++) if (score[k] > mx) { mx = score[k]; i = k; }
  const beats = []; while (i >= 0) { beats.push(i); i = back[i]; }
  return beats.reverse();
}
async function analyzeSong(file, progress) {
  progress && progress("Reading the song", 0.05);
  const buffer = await decodeFile(file);
  progress && progress("Finding the beats", 0.3);
  await sleep(0);
  const y = await toMono(buffer);
  const fps = SR / HOP, { env, rms } = onsetEnvelope(y);
  const bpm = estimateTempo(env, fps);
  const beats = trackBeats(env, fps, bpm).map(b => +(b / fps).toFixed(3));
  const sec = Math.floor(y.length / SR), perSec = [];
  for (let s = 0; s < sec; s++) perSec.push(mean(rms, Math.floor(s * fps), Math.floor((s + 1) * fps)));
  const smooth = perSec.map((_, i) => mean(perSec, Math.max(0, i - 4), Math.min(sec, i + 4)));
  const lo = Math.min(...smooth), hi = Math.max(...smooth);
  const energy = smooth.map(v => +((v - lo) / (hi - lo + 1e-9)).toFixed(3));
  // loudness every 10 ms for the fine-tune view
  const step = Math.round(buffer.sampleRate / 100), ch = buffer.getChannelData(0), ch2 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : ch;
  const loud = new Float32Array(Math.floor(ch.length / step));
  for (let f = 0; f < loud.length; f++) { let e = 0; for (let i = f * step; i < (f + 1) * step; i++) { const v = (ch[i] + ch2[i]) / 2; e += v * v; } loud[f] = 20 * Math.log10(Math.sqrt(e / step) + 1e-6); }
  return { duration: buffer.duration, bpm: +bpm.toFixed(1), beats, energy, buffer, loud };
}
function bestSection(a, length) {
  const e = a.energy, n = Math.max(1, Math.min(e.length, Math.round(length)));
  if (n >= e.length) return 0;
  let s = 0; for (let i = 0; i < n; i++) s += e[i];
  let best = s, bi = 0;
  for (let i = 1; i + n <= e.length; i++) { s += e[i + n - 1] - e[i - 1]; if (s > best) { best = s; bi = i; } }
  return snapToBeat(a, bi);
}
function snapToBeat(a, t) { return a.beats.length ? a.beats.reduce((b, x) => Math.abs(x - t) < Math.abs(b - t) ? x : b, a.beats[0]) : t; }
function section(project, a) {
  const dur = a.duration; let s = project.start, e = project.end;
  if (s == null || s === "auto" || e == null || e === "auto") { s = bestSection(a, Math.min(30, dur)); e = s + Math.min(30, dur); }
  s = clamp(+s, 0, dur - 1); e = clamp(+e, s + 1, dur);
  return [s, e - s];
}

// ---------------------------------------------------------------- video helpers
function videoFor(file) {
  const v = document.createElement("video");
  v.muted = true; v.playsInline = true; v.preload = "auto"; v.crossOrigin = "anonymous";
  v.src = file._url || (file._url = URL.createObjectURL(file));
  return v;
}
function once(el, ev, ms = 15000) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => { el.removeEventListener(ev, h); rej(new Error("timeout waiting for " + ev)); }, ms);
    const h = () => { clearTimeout(t); res(); };
    el.addEventListener(ev, h, { once: true });
  });
}
async function ready(v) { if (v.readyState < 1) await once(v, "loadedmetadata", 30000); return v; }
async function seek(v, t) { t = clamp(t, 0, Math.max(0, (v.duration || 0) - 0.05)); if (Math.abs(v.currentTime - t) < 0.001 && v.readyState >= 2) return; v.currentTime = t; await once(v, "seeked", 20000); }
// crop rectangle (source pixels) for a 9:16 frame; framing 0 = left .. 1 = right
function cropRect(v, framing) {
  const vw = v.videoWidth, vh = v.videoHeight, cw = Math.min(vw, vh * 9 / 16), ch = Math.min(vh, vw * 16 / 9);
  return [(vw - cw) * clamp(framing, 0, 1), (vh - ch) / 2, cw, ch];
}

// ---------------------------------------------------------------- clips
async function scanClip(file, progress) {
  const v = await ready(videoFor(file));
  const dur = v.duration, c = document.createElement("canvas"); c.width = 96; c.height = 54;
  const g = c.getContext("2d", { willReadFrequently: true }), samples = [];
  const stepS = dur > 240 ? 0.75 : 0.5;
  for (let t = 0; t < dur - 0.2; t += stepS) {
    await seek(v, t);
    g.drawImage(v, 0, 0, 96, 54);
    const d = g.getImageData(0, 0, 96, 54).data, hist = new Uint32Array(256); let sum = 0;
    for (let i = 0; i < d.length; i += 4) { const y = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0; hist[y]++; sum += y; }
    const n = d.length / 4; let acc = 0, lo = 0, hi = 255;
    for (let k = 0; k < 256; k++) { acc += hist[k]; if (acc >= n * 0.1) { lo = k; break; } }
    acc = 0; for (let k = 255; k >= 0; k--) { acc += hist[k]; if (acc >= n * 0.1) { hi = k; break; } }
    samples.push([+t.toFixed(2), +(sum / n).toFixed(1), hi - lo]);
    if (progress && samples.length % 20 === 0) progress(t / dur);
  }
  v.removeAttribute("src"); v.load();
  return { duration: dur, width: v.videoWidth, height: v.videoHeight, samples };
}
function quality(clip) {
  const s = clip.samples, times = s.map(x => x[0]), contrast = s.map(x => x[2]);
  const thr = Math.max(22, percentile(contrast, 62));
  return { times, ok: s.map(x => x[2] >= thr && x[1] >= 12) };
}
function windowOk(q, t, dur) {
  const idx = []; q.times.forEach((x, i) => { if (x >= t - 0.15 && x <= t + dur) idx.push(i); });
  if (!idx.length) return false;
  if (!q.ok[idx[0]] || (idx[1] != null && !q.ok[idx[1]])) return false;
  return idx.filter(i => q.ok[i]).length / idx.length >= 0.75;
}
function goodStarts(clip, q, dur) {
  let s = q.times.filter((t, i) => q.ok[i] && t + dur < clip.duration - 0.2 && windowOk(q, t, dur));
  if (!s.length) s = q.times.filter((t, i) => q.ok[i] && t + dur < clip.duration);
  return s.length ? s : [0];
}
const CUT_BEATS = { slow: 8, medium: 4, fast: 2 };
function planCuts(a, start, length, pace = "auto") {
  const end = start + length, beats = a.beats.filter(b => b >= start - 0.01 && b < end - 0.25), e = a.energy, bounds = [start];
  let i = 0;
  while (i < beats.length) {
    const step = pace === "auto" ? (() => { const v = e[Math.min(e.length - 1, Math.floor(beats[i]))]; return v < 0.45 ? 8 : v < 0.8 ? 4 : 2; })() : (CUT_BEATS[pace] || 4);
    i += step;
    if (i < beats.length && beats[i] - bounds[bounds.length - 1] > 0.3) bounds.push(beats[i]);
  }
  bounds.push(end);
  if (bounds.length > 2 && bounds[bounds.length - 1] - bounds[bounds.length - 2] < 0.5) bounds.splice(bounds.length - 2, 1);
  return bounds;
}
function planShots(clips, bounds, mode = "auto", seed = 0) {
  const rng = seeded(seed * 7919 + 13), durs = clips.map(c => c.duration);
  if (mode === "auto") mode = (Math.max(...durs) - Math.min(...durs) < 1 && clips.length > 1) ? "flow" : "mix";
  const qs = clips.map(quality), shots = [], used = [];
  let prev = null, pos = null, flowStart = null;
  const fresh = st => { const far = st.filter(g => used.every(u => Math.abs(g - u[1]) > 10)); return choice(rng, far.length ? far : st); };
  for (let k = 0; k + 1 < bounds.length; k++) {
    const a = bounds[k], b = bounds[k + 1], dur = b - a;
    let choices = clips.map((_, i) => i).filter(i => i !== prev); if (!choices.length) choices = [0];
    shuffle(rng, choices);
    let ci, t;
    if (mode === "flow" && pos != null && a - flowStart > 5 + rng() * 3) {
      const st = goodStarts(clips[choices[0]], qs[choices[0]], dur).filter(g => Math.abs(g - pos) > 12);
      if (st.length) { pos = fresh(st); flowStart = a; }
    }
    if (flowStart == null) flowStart = a;
    if (mode === "flow") {
      ci = choices.find(i => pos != null && pos + dur < durs[i] - 0.2 && windowOk(qs[i], pos, dur));
      if (ci == null) {
        ci = choices[0];
        const st = goodStarts(clips[ci], qs[ci], dur), later = st.filter(g => pos != null && g > pos && g < pos + 3);
        pos = later.length ? later[0] : fresh(st); flowStart = a;
      }
      t = pos; pos += dur; used.push([ci, t]);
    } else {
      ci = choices[0];
      const st = goodStarts(clips[ci], qs[ci], dur), c = st.filter(g => used.every(([uc, u]) => !(durs[uc] === durs[ci] || uc === ci) || Math.abs(g - u) > 4));
      t = choice(rng, c.length ? c : st); used.push([ci, t]);
    }
    shots.push({ clip: ci, src: +t.toFixed(3), start: a, end: b, zoom: rng() < 0.5 ? 1 : -1 });
    prev = ci;
  }
  return shots;
}

// ---------------------------------------------------------------- lyrics
const FONT_STACK = {
  whisper: "Baskerville, 'Libre Baskerville', Georgia, serif",
  bold: "Futura, Jost, 'Century Gothic', sans-serif",
  typewriter: "'American Typewriter', 'Special Elite', 'Courier New', monospace",
  clean: "'Avenir Next', Figtree, 'Segoe UI', sans-serif",
  arial: "Arial, Arimo, 'Helvetica Neue', sans-serif",
  led: "DotGothic16, monospace",
  dos: "'Px437 IBM VGA 8x16', monospace",
};
const STYLES = {
  whisper: { size: 86, italic: 1, bold: 0, kase: "lower", spacing: 1, effect: "shadow" },
  bold: { size: 82, italic: 0, bold: 1, kase: "upper", spacing: 4, effect: "shadow" },
  typewriter: { size: 68, italic: 0, bold: 0, kase: "lower", spacing: 0, effect: "shadow", typewriter: true },
  clean: { size: 66, italic: 0, bold: 1, kase: "as-is", spacing: 1, effect: "shadow" },
  arial: { size: 80, italic: 0, bold: 1, kase: "as-is", spacing: 0, effect: "outline" },
  led: { size: 86, italic: 0, bold: 0, kase: "upper", spacing: 4, effect: "glow" },
  dos: { size: 80, italic: 0, bold: 0, kase: "as-is", spacing: 0, effect: "shadow", typewriter: true },
};
const SIZES = { small: 0.8, medium: 1, large: 1.25 };
function styleFor(name, customFonts) {
  if (name && name.startsWith("custom:")) {
    const f = (customFonts || []).find(c => c.id === name.slice(7));
    if (f) return { size: 80, italic: 0, bold: 0, kase: "as-is", spacing: 0, effect: "shadow", family: `"${f.family_ass}", sans-serif`, straight: f.straight_quotes };
  }
  const st = STYLES[name] || STYLES.whisper;
  return { ...st, family: FONT_STACK[name] || FONT_STACK.whisper };
}
function lyricEvents(lines, timings, start, length, style, offset) {
  const ev = [];
  lines.forEach((line, i) => {
    const tm = timings[i]; if (!tm || tm.start == null) return;
    let s = tm.start + offset, e = tm.end;
    if (e == null) { let nxt = null; for (let j = i + 1; j < timings.length; j++) if (timings[j] && timings[j].start != null) { nxt = timings[j].start; break; } e = nxt != null ? nxt + offset : start + length; }  // until the next line; the last one until the end else e += offset;
    s -= start; e -= start;
    if (e <= 0 || s >= length) return;
    s = Math.max(0, s); e = Math.min(length, e); if (e - s < 0.15) return;
    let txt = style.kase === "lower" ? line.toLowerCase() : style.kase === "upper" ? line.toUpperCase() : line;
    if (style.straight) txt = txt.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
    ev.push({ s, e, txt });
  });
  return ev;
}
function hexRGB(h) { const n = parseInt((h || "#ffffff").slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; }
function wrap(ctx, text, maxW) {
  const words = text.split(/\s+/), out = []; let line = "";
  for (const w of words) { const t = line ? line + " " + w : w; if (ctx.measureText(t).width > maxW && line) { out.push(line); line = w; } else line = t; }
  if (line) out.push(line); return out;
}
function drawLyric(ctx, ev, t, opt) {
  const { style, color, effect, size, position } = opt;
  const fs = Math.round(style.size * (SIZES[size] || 1)), k = fs / 80;
  const [r, g, b] = hexRGB(color), dark = (0.299 * r + 0.587 * g + 0.114 * b) < 100;
  ctx.save();
  ctx.font = `${style.italic ? "italic " : ""}${style.bold ? "700 " : "400 "}${fs}px ${style.family}`;
  if ("letterSpacing" in ctx) ctx.letterSpacing = style.spacing + "px";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  let text = ev.txt;
  let alpha = 1;
  if (style.typewriter) {
    const per = Math.min(0.045, Math.max(0.015, (ev.e - ev.s) * 0.35 / Math.max(1, text.length)));
    text = text.slice(0, Math.min(text.length, Math.floor((t - ev.s) / per) + 1));
    alpha = clamp((ev.e - t) / 0.18, 0, 1);
  } else alpha = Math.min(clamp((t - ev.s) / 0.06, 0, 1), clamp((ev.e - t) / 0.15, 0, 1));
  const full = wrap(ctx, ev.txt, W - 220), lineH = fs * 1.25;
  // lay out the full line so typed text doesn't jump around
  let lines = full;
  if (style.typewriter) { let left = text.length; lines = full.map(l => { const part = l.slice(0, Math.max(0, left)); left -= l.length + 1; return part; }); }
  const blockH = full.length * lineH;
  let y0 = position === "top" ? 300 : position === "bottom" ? H - 560 - blockH : (H - blockH) / 2;
  ctx.globalAlpha = alpha;
  const fill = `rgb(${r},${g},${b})`;
  full.forEach((fl, i) => {
    const l = lines[i]; if (!l) return;
    const y = y0 + lineH * (i + 0.5), x = W / 2;
    // typed text: anchor at the full line's left edge
    let drawX = x, align = "center";
    if (style.typewriter) { const fw = ctx.measureText(fl).width; drawX = x - fw / 2; align = "left"; }
    ctx.textAlign = align;
    if (effect === "box") {
      const w = ctx.measureText(l).width, pad = 14 * k, bx = align === "left" ? drawX - pad : x - w / 2 - pad;
      ctx.fillStyle = dark ? "rgba(255,255,255,.81)" : "rgba(0,0,0,.75)";
      ctx.fillRect(bx, y - lineH / 2 + 2, w + pad * 2, lineH);
    }
    if (effect === "outline") { ctx.lineJoin = "round"; ctx.lineWidth = Math.max(2, 5 * k) * 2; ctx.strokeStyle = dark ? "#fff" : "#000"; ctx.strokeText(l, drawX, y); }
    if (effect === "shadow" || effect === "glow") {
      ctx.shadowColor = effect === "glow" ? `rgba(${r},${g},${b},.75)` : (dark ? "rgba(255,255,255,.6)" : "rgba(0,0,0,.6)");
      ctx.shadowBlur = (effect === "glow" ? 16 : 14) * k;
      ctx.fillStyle = fill; ctx.fillText(l, drawX, y); ctx.fillText(l, drawX, y);
      ctx.shadowBlur = 0; ctx.shadowColor = "transparent";
    }
    ctx.fillStyle = fill; ctx.fillText(l, drawX, y);
  });
  ctx.restore();
}

// ---------------------------------------------------------------- looks
const LOOKS = {
  film: { filter: "contrast(1.06) saturate(0.92) brightness(0.985) sepia(0.05)", vignette: 0.42, grain: 0.07 },
  dreamy: { filter: "contrast(0.97) saturate(0.85) brightness(1.02)", vignette: 0.32, grain: 0.05, glow: 0.32 },
  punchy: { filter: "contrast(1.15) saturate(1.12)", vignette: 0.4, grain: 0.04 },
  raw: { filter: "none", vignette: 0, grain: 0 },
};
function makeOverlays() {
  const vig = document.createElement("canvas"); vig.width = W; vig.height = H;
  const g = vig.getContext("2d"), grad = g.createRadialGradient(W / 2, H / 2, H * 0.25, W / 2, H / 2, H * 0.62);
  grad.addColorStop(0, "rgba(0,0,0,0)"); grad.addColorStop(1, "rgba(0,0,0,1)");
  g.fillStyle = grad; g.fillRect(0, 0, W, H);
  const grains = [0, 1, 2, 3].map(() => {
    const c = document.createElement("canvas"); c.width = 540; c.height = 960;
    const x = c.getContext("2d"), img = x.createImageData(540, 960);
    for (let i = 0; i < img.data.length; i += 4) { const v = (Math.random() * 255) | 0; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255; }
    x.putImageData(img, 0, 0); return c;
  });
  const glow = document.createElement("canvas"); glow.width = 270; glow.height = 480;
  return { vig, grains, glow };
}
function applyLook(ctx, canvas, look, ov, frameNo) {
  const L = LOOKS[look] || LOOKS.film;
  if (L.glow) {
    const gx = ov.glow.getContext("2d"); gx.filter = "blur(7px)"; gx.drawImage(canvas, 0, 0, 270, 480); gx.filter = "none";
    ctx.save(); ctx.globalCompositeOperation = "screen"; ctx.globalAlpha = L.glow; ctx.drawImage(ov.glow, 0, 0, W, H); ctx.restore();
  }
  if (L.vignette) { ctx.save(); ctx.globalAlpha = L.vignette; ctx.drawImage(ov.vig, 0, 0); ctx.restore(); }
  if (L.grain) { ctx.save(); ctx.globalCompositeOperation = "overlay"; ctx.globalAlpha = L.grain; ctx.drawImage(ov.grains[frameNo % 4], 0, 0, W, H); ctx.restore(); }
}

// ---------------------------------------------------------------- performance sync
function bandFeatures(y) {
  const half = NFFT / 2 + 1, edges = []; for (let i = 0; i <= 24; i++) edges.push(80 * Math.pow(100, i / 24));
  const bins = edges.map(f => Math.round(f / (SR / NFFT))), rows = [];
  stftMags(y, (f, re, im) => {
    const row = new Float32Array(24);
    for (let b = 0; b < 24; b++) { let s = 0; for (let k = bins[b]; k < Math.min(half, bins[b + 1]); k++) s += Math.hypot(re[k], im[k]); row[b] = Math.log1p(s * 10); }
    rows.push(row);
  });
  const n = rows.length, F = rows.map((r, i) => r.map((v, b) => v - (i ? rows[i - 1][b] : v)));
  const m = new Float32Array(24); F.forEach(r => r.forEach((v, b) => m[b] += v / n));
  F.forEach(r => { let nn = 0; for (let b = 0; b < 24; b++) { r[b] -= m[b]; nn += r[b] * r[b]; } nn = Math.sqrt(nn) + 1e-6; for (let b = 0; b < 24; b++) r[b] /= nn; });
  return F;
}
async function syncPerformance(videoFile, songFile, progress) {
  progress && progress("Listening to the video", 0.2);
  const yv = await toMono(await decodeFile(videoFile));
  const ys = await toMono(await decodeFile(songFile));
  progress && progress("Lining it up with the song", 0.6);
  const V = bandFeatures(yv), S = bandFeatures(ys), nv = V.length, ns = S.length;
  let n = 1; while (n < nv + ns) n <<= 1;
  const acc = new Float64Array(n);
  for (let b = 0; b < 24; b++) {
    const ar = new Float32Array(n), ai = new Float32Array(n), br = new Float32Array(n), bi = new Float32Array(n);
    for (let i = 0; i < nv; i++) ar[i] = V[i][b]; for (let i = 0; i < ns; i++) br[i] = S[i][b];
    fft(ar, ai); fft(br, bi);
    // a * conj(b), then inverse via conj-fft-conj
    for (let k = 0; k < n; k++) { const r = ar[k] * br[k] + ai[k] * bi[k], im = ai[k] * br[k] - ar[k] * bi[k]; ar[k] = r; ai[k] = -im; }
    fft(ar, ai); for (let k = 0; k < n; k++) acc[k] += ar[k] / n;
  }
  const fps = SR / HOP, score = new Float64Array(n).fill(-Infinity);
  for (let k = 0; k < n; k++) {
    const lag = k > n / 2 ? k - n : k, ov = Math.min(nv, ns + lag) - Math.max(0, lag);
    if (ov > Math.min(nv, ns) * 0.6) score[k] = acc[k] / ov;
  }
  let best = 0; for (let k = 1; k < n; k++) if (score[k] > score[best]) best = k;
  const y1 = score[best], y0 = score[(best - 1 + n) % n], y2 = score[(best + 1) % n], den = y0 - 2 * y1 + y2;
  const frac = isFinite(den) && den !== 0 ? 0.5 * (y0 - y2) / den : 0;
  const lag = best > n / 2 ? best - n : best, offset = (lag + frac) / fps;
  let second = -Infinity; for (let k = 0; k < n; k++) { const d = Math.min(Math.abs(k - best), n - Math.abs(k - best)); if (d > fps && score[k] > second) second = score[k]; }
  const ratio = second > 0 ? y1 / second : 10, vd = yv.length / SR, sd = ys.length / SR;
  return { offset: +offset.toFixed(3), score: +y1.toFixed(3), ratio: +ratio.toFixed(2), confident: ratio > 1.4 && y1 > 0.1,
           duration: vd, covers: [+Math.max(0, -offset).toFixed(3), +Math.min(sd, vd - offset).toFixed(3)] };
}

// ---------------------------------------------------------------- preview frame
async function previewFrame(file, t, framing) {
  const v = await ready(videoFor(file)); await seek(v, t);
  const c = document.createElement("canvas"); c.width = 540; c.height = 960;
  const [sx, sy, sw, sh] = cropRect(v, framing); c.getContext("2d").drawImage(v, sx, sy, sw, sh, 0, 0, 540, 960);
  v.removeAttribute("src"); v.load();
  return await new Promise(r => c.toBlob(r, "image/jpeg", 0.8));
}

// ---------------------------------------------------------------- render
function support() {
  return typeof VideoEncoder !== "undefined" && typeof VideoFrame !== "undefined" && typeof AudioEncoder !== "undefined";
}
async function pickCodecs(sampleRate) {
  const vCands = ["avc1.640028", "avc1.4d0028", "avc1.42002a"];
  let video = null;
  for (const c of vCands) { const cfg = { codec: c, width: W, height: H, bitrate: 12_000_000, framerate: FPS }; if ((await VideoEncoder.isConfigSupported(cfg)).supported) { video = cfg; break; } }
  let audio = { codec: "mp4a.40.2", sampleRate, numberOfChannels: 2, bitrate: 192000 }, aMux = "aac";
  if (!(await AudioEncoder.isConfigSupported(audio)).supported) { audio = { codec: "opus", sampleRate: 48000, numberOfChannels: 2, bitrate: 160000 }; aMux = "opus"; }
  return { video, audio, aMux };
}
async function resampleStereo(buffer, s, len, rate) {
  const off = new OfflineAudioContext(2, Math.ceil(len * rate), rate);
  const src = off.createBufferSource(); src.buffer = buffer; src.connect(off.destination); src.start(0, s, len);
  return await off.startRendering();
}
// play a clip from `from` and hand back one picture per output frame (frames repeat if the computer falls behind)
async function playFrames(v, from, nFrames, onFrame) {
  await seek(v, from);
  let emitted = 0;
  if (!("requestVideoFrameCallback" in HTMLVideoElement.prototype)) {
    for (; emitted < nFrames; emitted++) { await seek(v, from + emitted / FPS); await onFrame(emitted); }
    return;
  }
  await new Promise((resolve, reject) => {
    let busy = false, done = false;
    const finish = async () => { if (done) return; done = true; v.pause(); while (emitted < nFrames) { await onFrame(emitted); emitted++; } resolve(); };
    const step = async (now, md) => {
      if (done) return;
      const t = md.mediaTime - from;
      if (!busy) {
        busy = true;
        try { while (emitted < nFrames && emitted / FPS <= t + 0.5 / FPS) { await onFrame(emitted); emitted++; } } catch (e) { done = true; reject(e); return; }
        busy = false;
      }
      if (emitted >= nFrames) finish(); else v.requestVideoFrameCallback(step);
    };
    v.onended = finish;
    v.requestVideoFrameCallback(step);
    v.play().catch(reject);
  });
  v.onended = null;
}

async function render(p, progress) {
  if (!support()) throw new Error("This browser can't make videos. Use a recent Chrome, Edge or Safari, or the desktop app.");
  const say = (m, f) => progress && progress(m, f);
  const a = p.analysis;
  const [start, length] = section(p, a);
  const framing = p.framing ?? 0.5, perf = p.mode === "performance", superclean = !perf && p.edit_style === "superclean";
  const { video: vcfg, audio: acfg, aMux } = await pickCodecs(a.buffer.sampleRate);
  if (!vcfg) throw new Error("This browser can't encode HD video. Try Chrome or Edge, or the desktop app.");
  const { Muxer, ArrayBufferTarget } = await import("https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.1/build/mp4-muxer.mjs");
  const muxer = new Muxer({ target: new ArrayBufferTarget(), fastStart: "in-memory", firstTimestampBehavior: "offset",
    video: { codec: "avc", width: W, height: H, frameRate: FPS }, audio: { codec: aMux, numberOfChannels: 2, sampleRate: acfg.sampleRate } });
  let encErr = null;
  const venc = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: e => encErr = e }); venc.configure(vcfg);
  const aenc = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: e => encErr = e }); aenc.configure(acfg);

  // ---- audio: the song (or the performance video's own sound), faded in and out
  say("Preparing the sound", 0.02);
  let srcBuf = a.buffer, srcStart = start;
  if (perf && p.audio_source === "video") { srcBuf = await decodeFile(p.performanceFile); srcStart = start + p.sync.offset; }
  const audio = await resampleStereo(srcBuf, Math.max(0, srcStart), length, acfg.sampleRate);
  const L = audio.getChannelData(0), R = audio.getChannelData(1), sr = acfg.sampleRate;
  for (let i = 0; i < L.length; i++) { const t = i / sr, g = Math.min(1, t / 0.15, (length - t) / 1.2); L[i] *= Math.max(0, g); R[i] *= Math.max(0, g); }
  for (let i = 0; i < L.length; i += 1024) {
    const n = Math.min(1024, L.length - i), data = new Float32Array(n * 2); data.set(L.subarray(i, i + n), 0); data.set(R.subarray(i, i + n), n);
    const ad = new AudioData({ format: "f32-planar", sampleRate: sr, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round(i / sr * 1e6), data });
    aenc.encode(ad); ad.close();
  }

  // ---- pictures
  const canvas = document.createElement("canvas"); canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d", { alpha: false }), ov = makeOverlays(), look = LOOKS[p.look] || LOOKS.film;
  const canFilter = "filter" in ctx;
  const style = styleFor(p.text_style, p.custom_fonts), events = lyricEvents(p.lines, p.timings, start, length, style, +(p.lyric_offset ?? -0.2));
  try { await document.fonts.load(`${style.bold ? 700 : 400} 40px ${style.family}`); } catch (_) {}
  const textOpt = { style, color: p.text_color || "#ffffff", effect: p.text_effect || style.effect, size: p.text_size || "medium", position: p.text_position || "center" };
  const total = Math.round(length * FPS);
  let frameNo = 0, nShots = 0;
  const drawOut = async (v, crop, zoomAt) => {
    if (encErr) throw encErr;
    const t = frameNo / FPS;
    ctx.save(); ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);
    if (canFilter) ctx.filter = look.filter;
    const z = zoomAt ? zoomAt(t) : 1, dw = W * z, dh = H * z;
    if (v && v.readyState >= 2) ctx.drawImage(v, crop[0], crop[1], crop[2], crop[3], (W - dw) / 2, (H - dh) / 2, dw, dh);
    ctx.restore();
    applyLook(ctx, canvas, p.look, ov, frameNo);
    for (const ev of events) if (t >= ev.s && t < ev.e) drawLyric(ctx, ev, t, textOpt);
    if (!superclean) { const fade = Math.min(1, t / 0.35, (length - t) / 0.6); if (fade < 1) { ctx.fillStyle = `rgba(0,0,0,${1 - Math.max(0, fade)})`; ctx.fillRect(0, 0, W, H); } }
    const vf = new VideoFrame(canvas, { timestamp: Math.round(frameNo * 1e6 / FPS), duration: Math.round(1e6 / FPS) });
    venc.encode(vf, { keyFrame: frameNo % 60 === 0 }); vf.close();
    frameNo++;
    while (venc.encodeQueueSize > 8) await sleep(4);
    if (frameNo % 15 === 0) say(`Making the video: ${Math.round(t)}s of ${Math.round(length)}s`, 0.1 + 0.85 * frameNo / total);
  };

  if (perf) {
    const v = await ready(videoFor(p.performanceFile)), crop = cropRect(v, framing);
    await playFrames(v, Math.max(0, start + p.sync.offset), total, () => drawOut(v, crop));
    v.removeAttribute("src"); v.load();
  } else {
    const bounds = planCuts(a, start, length, p.pace || "auto"), shots = planShots(p.clips, bounds, p.footage || "auto", +p.seed || 0);
    nShots = shots.length;
    const vids = new Map();
    for (const sh of shots) {
      const f0 = Math.round((sh.start - start) * FPS), f1 = Math.round((sh.end - start) * FPS), n = f1 - f0;
      if (n <= 0) continue;
      const file = p.clips[sh.clip].file;
      if (!vids.has(file)) vids.set(file, await ready(videoFor(file)));
      const v = vids.get(file), crop = cropRect(v, framing), dur = n / FPS;
      const zoomAt = superclean ? null : (sh.zoom > 0 ? (t => 1 + 0.06 * ((t - f0 / FPS) / dur)) : (t => 1.06 - 0.06 * ((t - f0 / FPS) / dur)));
      await playFrames(v, sh.src, n, () => drawOut(v, crop, zoomAt));
    }
    vids.forEach(v => { v.removeAttribute("src"); v.load(); });
    while (frameNo < total) await drawOut(null, [0, 0, 1, 1]);
  }
  say("Finishing the file", 0.97);
  await venc.flush(); await aenc.flush();
  if (encErr) throw encErr;
  muxer.finalize();
  return { blob: new Blob([muxer.target.buffer], { type: "video/mp4" }), start, length, shots: nShots };
}

window.LyricEngine = { analyzeSong, bestSection, section, scanClip, planCuts, planShots, syncPerformance, previewFrame, render, support, STYLES, FONT_STACK, decodeFile };
})();
