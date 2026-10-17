/* Jazz's Lyric Snips — browser version glue.
   The interface is the same page the desktop app uses; there it talks to a small local server.
   Here every one of those requests is answered inside the browser instead, by LyricEngine. */
(function () {
"use strict";
const E = () => window.LyricEngine;
const KEY = "lyricsnips.state.v1";
const DEFAULTS = { start: null, end: null, look: "film", text_style: "whisper", text_color: "#ffffff", pace: "auto", footage: "auto",
  lyric_offset: -0.2, seed: 1, framing: 0.5, audio_source: "song", edit_style: "cinematic", text_effect: "shadow", text_size: "medium", text_position: "center" };

// ---------------------------------------------------------------- saved state (lyrics, taps, settings, fonts)
function load() {
  let s = {}; try { s = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (_) {}
  s.settings = { ...DEFAULTS, ...(s.settings || {}) }; s.songs = s.songs || {}; s.custom_fonts = s.custom_fonts || []; s.mode = s.mode || null;
  return s;
}
function store(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (_) {} }
let ST = load();

// files only live for this visit: browsers don't let a page reopen files after a reload
const F = { song: null, clips: [], performance: null };
const cache = { analysis: null, analysisFor: null, scans: new Map(), sync: null, syncFor: null, renders: [] };
const songKey = () => F.song ? `${F.song.name}|${F.song.size}` : (ST.songKey || "");
const entry = () => (ST.songs[songKey()] ||= { lyrics: "", timings: [] });

// ---------------------------------------------------------------- fonts kept in the browser (IndexedDB)
function db() {
  return new Promise((res, rej) => { const r = indexedDB.open("lyricsnips", 1); r.onupgradeneeded = () => r.result.createObjectStore("fonts"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
async function fontPut(id, blob) { const d = await db(); return new Promise((res, rej) => { const t = d.transaction("fonts", "readwrite"); t.objectStore("fonts").put(blob, id); t.oncomplete = res; t.onerror = () => rej(t.error); }); }
async function fontGet(id) { const d = await db(); return new Promise(res => { const r = d.transaction("fonts").objectStore("fonts").get(id); r.onsuccess = () => res(r.result); r.onerror = () => res(null); }); }
async function fontDel(id) { const d = await db(); return new Promise(res => { const t = d.transaction("fonts", "readwrite"); t.objectStore("fonts").delete(id); t.oncomplete = res; }); }
const fontURLs = {};
async function registerFont(f) {
  const blob = await fontGet(f.id); if (!blob) return false;
  fontURLs[f.file] = URL.createObjectURL(blob);
  try { const ff = new FontFace(f.family_ass, await blob.arrayBuffer()); await ff.load(); document.fonts.add(ff); } catch (_) { return false; }
  return true;
}
const fontsReady = (async () => { for (const f of ST.custom_fonts) await registerFont(f); })();

// ---------------------------------------------------------------- picking files
function pick({ accept, multiple, folder }) {
  return new Promise(resolve => {
    const inp = document.createElement("input"); inp.type = "file";
    if (accept) inp.accept = accept; if (multiple) inp.multiple = true; if (folder) { inp.webkitdirectory = true; inp.multiple = true; }
    let done = false; const finish = v => { if (!done) { done = true; resolve(v); } };
    inp.addEventListener("change", () => finish([...inp.files]));
    inp.addEventListener("cancel", () => finish(null));
    window.addEventListener("focus", () => setTimeout(() => { if (!inp.files.length) finish(null); }, 800), { once: true });
    inp.click();
  });
}
const VIDEO = /\.(mov|mp4|m4v|webm|mkv)$/i;

// clips are scanned in the background so they're ready by the time lyrics are synced
const scan = { running: false, msg: "" };
async function prescan() {
  if (scan.running) return; scan.running = true;
  try {
    for (let i = 0; i < F.clips.length; i++) {
      const c = F.clips[i], key = `${c.name}|${c.size}|${c.lastModified}`;
      if (cache.scans.has(key)) continue;
      scan.msg = `Scanning clips for good moments (${i + 1} of ${F.clips.length})`;
      try { cache.scans.set(key, await E().scanClip(c)); } catch (e) { cache.scans.set(key, null); }
    }
  } finally { scan.running = false; scan.msg = ""; }
}
async function scannedClips(progress) {
  if (scan.running) { progress && progress("Waiting for the clip scan to finish", 0.05); while (scan.running) await new Promise(r => setTimeout(r, 300)); }
  await prescan();
  const out = [];
  F.clips.forEach(c => { const s = cache.scans.get(`${c.name}|${c.size}|${c.lastModified}`); if (s && s.samples.length) out.push({ ...s, file: c }); });
  return out;
}
async function analysis() {
  if (!F.song) throw new Error("Choose a song first.");
  if (cache.analysisFor !== F.song) { cache.analysis = await E().analyzeSong(F.song); cache.analysisFor = F.song; }
  return cache.analysis;
}
async function perfSync() {
  if (!F.performance || !F.song) throw new Error("Choose a song and a performance video first.");
  const k = F.performance.name + F.performance.size + "|" + F.song.name + F.song.size;
  if (cache.syncFor !== k) { cache.sync = await E().syncPerformance(F.performance, F.song); cache.syncFor = k; }
  return cache.sync;
}

// ---------------------------------------------------------------- lyrics import
function clean(text) {
  return text.replace(/\r\n?|[\u2028\u2029\v\f]/g, "\n").replace(/[\u200b-\u200d\ufeff]/g, "").replace(/[\u00a0\t]/g, " ")
    .split("\n").map(l => l.replace(/ {2,}/g, " ").trim()).filter(Boolean).join("\n");
}
async function readLyricsFile(file) {
  const ext = (file.name.match(/\.[^.]+$/) || [""])[0].toLowerCase();
  if ([".txt", ".md"].includes(ext)) return clean(await file.text());
  if (ext === ".docx") {
    const zip = await window.JSZip.loadAsync(file), xml = await zip.file("word/document.xml").async("string");
    const doc = new DOMParser().parseFromString(xml, "application/xml"), W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main", out = [];
    for (const p of doc.getElementsByTagNameNS(W, "p")) {
      let line = "";
      for (const n of p.getElementsByTagNameNS(W, "*")) { if (n.localName === "t") line += n.textContent; else if (n.localName === "br" || n.localName === "cr") line += "\n"; else if (n.localName === "tab") line += " "; }
      out.push(line);
    }
    return clean(out.join("\n"));
  }
  if (ext === ".rtf") { const t = await file.text(); return clean(t.replace(/\\par[d]?/g, "\n").replace(/\{\\[^{}]*\}|\\[a-z]+-?\d* ?|[{}]/gi, "")); }
  throw new Error("In the browser, lyrics can come from a Word (.docx) or text (.txt) file. You can also paste them.");
}

// ---------------------------------------------------------------- render jobs
const jobs = {};
async function runRender(id, settings) {
  const job = jobs[id], say = (msg, frac) => Object.assign(job, { msg, frac: Math.round(frac * 1000) / 1000 });
  try {
    const p = { ...ST.settings, ...settings, mode: ST.mode || "clips", custom_fonts: ST.custom_fonts };
    say("Analyzing the song", 0.01);
    p.analysis = await analysis();
    const e = entry(); p.lines = e.lyrics.split("\n").map(l => l.trim()).filter(Boolean); p.timings = e.timings;
    if (p.mode === "performance") { p.performanceFile = F.performance; p.sync = await perfSync(); }
    else { p.clips = await scannedClips(say); if (!p.clips.length) throw new Error("No usable clips. Choose a folder of video clips in Setup."); }
    await fontsReady;
    const r = await E().render(p, say);
    const base = (F.song.name.replace(/\.[^.]+$/, "").replace(/[_]+/g, " ").replace(/[^\w\- ]+/g, "").trim() || "video");
    const d = new Date(), stamp = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}.${String(d.getMinutes()).padStart(2, "0")}.${String(d.getSeconds()).padStart(2, "0")}`;
    const name = `${base} – ${p.mode === "performance" ? "performance" : p.look} ${String(p.text_style).replace(/^custom:.*/, "custom")} – ${stamp}.mp4`;
    cache.renders.unshift({ name, mtime: Date.now(), url: URL.createObjectURL(r.blob), blob: r.blob });
    download(cache.renders[0]);
    Object.assign(job, { status: "done", frac: 1, result: { name, start: r.start, length: r.length, shots: r.shots, folder: "your Downloads" } });
  } catch (e) { Object.assign(job, { status: "error", error: String(e && e.message || e) }); console.error(e); }
}
function download(r) { const a = document.createElement("a"); a.href = r.url; a.download = r.name; document.body.appendChild(a); a.click(); a.remove(); }

// ---------------------------------------------------------------- the "server"
function json(obj, status = 200) { return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } }); }
const fail = (m, s = 400) => json({ error: m }, s);
async function handle(url, init) {
  const u = new URL(url, location.href), p = u.pathname.replace(/^.*?(\/api\/|\/fonts\/)/, "$1"), q = u.searchParams;
  const body = init && typeof init.body === "string" ? JSON.parse(init.body || "{}") : {};
  switch (p) {
    case "/api/state": {
      const e = entry(), styles = Object.keys(E().STYLES);
      return json({ song: F.song ? F.song.name : (ST.songName ? ST.songName + " (choose it again)" : ""), song_ok: !!F.song,
        clips: F.clips.length ? (F.clips[0].webkitRelativePath.split("/")[0] || `${F.clips.length} clips`) : "", clip_files: F.clips.map(c => c.name), clips_error: "",
        scan: scan.running ? { running: true, msg: scan.msg } : null, lyrics: e.lyrics, timings: e.timings, settings: ST.settings,
        mode: ST.mode, performance: F.performance ? F.performance.name : "", performance_ok: !!F.performance, custom_fonts: ST.custom_fonts,
        edition: "web", styles, output_dir: "", output_is_default: true });
    }
    case "/api/save": {
      const e = entry();
      if ("lyrics" in body) e.lyrics = body.lyrics; if ("timings" in body) e.timings = body.timings;
      if (body.settings) ST.settings = { ...ST.settings, ...body.settings };
      if (body.mode) ST.mode = body.mode;
      store(ST); return json({ ok: true });
    }
    case "/api/choose": {
      const k = body.kind;
      if (k === "song") { const f = await pick({ accept: "audio/*,.wav,.mp3,.m4a,.aif,.aiff,.flac" }); if (!f) return json({ cancelled: true });
        F.song = f[0]; ST.songName = F.song.name; ST.songKey = songKey(); store(ST); return json({ path: F.song.name }); }
      if (k === "clips") { const f = await pick({ folder: true }); if (!f) return json({ cancelled: true });
        F.clips = f.filter(x => VIDEO.test(x.name) && !x.name.startsWith(".")); prescan(); return json({ path: "clips" }); }
      if (k === "performance") { const f = await pick({ accept: "video/*,.mov,.mp4,.m4v" }); if (!f) return json({ cancelled: true });
        F.performance = f[0]; return json({ path: F.performance.name }); }
      return json({ cancelled: true });
    }
    case "/api/song": {
      try { const a = await analysis(); const peak = {}; for (const n of [15, 30, 45, 60]) peak[n] = E().bestSection(a, n);
        return json({ duration: a.duration, bpm: a.bpm, energy: a.energy, beats: a.beats, peak }); }
      catch (e) { return fail(F.song ? "Couldn't read that song: " + e.message : "Choose a song first.", F.song ? 500 : 400); }
    }
    case "/api/perf-sync": try { return json(await perfSync()); } catch (e) { return fail(e.message); }
    case "/api/render": {
      if (!F.song) return fail("Choose a song first (browsers forget files when the page reloads).");
      if ((ST.mode || "clips") === "performance" ? !F.performance : !F.clips.length) return fail(ST.mode === "performance" ? "Choose a performance video first." : "Choose a clips folder first.");
      if (Object.values(jobs).some(j => j.status === "running")) return fail("A video is already being made. Hang on a moment.", 409);
      const id = Math.random().toString(36).slice(2, 10); jobs[id] = { status: "running", msg: "Starting", frac: 0 };
      runRender(id, body.settings || {}); return json({ id });
    }
    case "/api/job": return json(jobs[q.get("id")] || { status: "missing" });
    case "/api/renders": return json(cache.renders.map(r => ({ name: r.name, mtime: r.mtime / 1000 })));
    case "/api/reveal": { const r = cache.renders.find(x => x.name === body.name) || cache.renders[0]; if (r) download(r); return json({ ok: true }); }
    case "/api/output/default": return json({ output_dir: "" });
    case "/api/frame": {
      try {
        let blob;
        if ((ST.mode || "clips") === "performance" && F.performance) { const s = await perfSync(); blob = await E().previewFrame(F.performance, Math.max(0, +q.get("t") + s.offset + 1), +q.get("framing")); }
        else { if (!F.clips.length) return fail("no clips"); const n = +q.get("n") || 0, c = F.clips[n % F.clips.length], sc = cache.scans.get(`${c.name}|${c.size}|${c.lastModified}`);
          let t = 1; if (sc && sc.samples.length) { const good = sc.samples.filter(x => x[2] > 30); const pickS = (good.length ? good : sc.samples)[(n * 7919) % (good.length || sc.samples.length)]; t = pickS[0] + 0.2; }
          blob = await E().previewFrame(c, t, +q.get("framing")); }
        return new Response(blob, { headers: { "Content-Type": "image/jpeg" } });
      } catch (e) { return fail(e.message); }
    }
    case "/api/lyrics/upload": { try { return json({ lyrics: await readLyricsFile(init.body) }); } catch (e) { return fail(e.message); } }
    case "/api/lyrics/clean": return json({ lyrics: clean(body.text || "") });
    case "/api/lyrics/gdoc": {
      const m = (body.url || "").match(/docs\.google\.com\/document\/(?:u\/\d+\/)?d\/([\w-]{20,})/);
      if (!m) return fail("That doesn't look like a Google Doc link. It should look like https://docs.google.com/document/d/…/edit");
      try { const r = await fetch(`https://docs.google.com/document/d/${m[1]}/export?format=txt`); if (!r.ok) throw 0; return json({ lyrics: clean(await r.text()) }); }
      catch (_) { return fail("Your browser won't let this page read Google Docs directly. In the doc, press ⌘A (Ctrl+A) then ⌘C (Ctrl+C), and paste the lyrics here."); }
    }
    case "/api/fonts/upload": {
      const file = init.body, ext = (file.name.match(/\.[^.]+$/) || [""])[0].toLowerCase();
      if (![".ttf", ".otf", ".woff", ".woff2"].includes(ext)) return fail("That isn't a font file. Use a .ttf, .otf, .woff or .woff2 file.");
      const buf = await file.arrayBuffer(); let h = 0; const v = new Uint8Array(buf); for (let i = 0; i < v.length; i += 97) h = (h * 31 + v[i]) >>> 0;
      const id = (h.toString(36) + v.length.toString(36)).slice(0, 10), f = { id, name: file.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " "), family_ass: "UF" + id, file: "user-" + id + ext, straight_quotes: false, missing_letters: 0 };
      try { const ff = new FontFace(f.family_ass, buf); await ff.load(); document.fonts.add(ff); } catch (_) { return fail("Couldn't read that font file. It may be damaged or in an unusual format."); }
      await fontPut(id, new Blob([buf])); fontURLs[f.file] = URL.createObjectURL(new Blob([buf]));
      ST.custom_fonts = ST.custom_fonts.filter(x => x.id !== id).concat(f); store(ST); return json(f);
    }
    case "/api/fonts/remove": {
      ST.custom_fonts = ST.custom_fonts.filter(x => x.id !== String(body.id)); if (ST.settings.text_style === "custom:" + body.id) ST.settings.text_style = "whisper";
      await fontDel(String(body.id)); store(ST); return json({ ok: true });
    }
    case "/api/vocals/status": return json({ state: "none" });
    case "/api/vocals/start": case "/api/vocals/snap": return fail("Snapping to the vocals needs the desktop app (download it further down this page).");
    case "/api/vocals/wave": {
      const a = cache.analysis; if (!a) return fail("no song");
      const t0 = +q.get("t0"), t1 = +q.get("t1"), pts = 400, lo0 = Math.floor(t0 * 100), hi0 = Math.min(a.loud.length, Math.floor(t1 * 100));
      const seg = a.loud.slice(lo0, hi0); const sorted = Array.from(seg).sort((x, y) => x - y), lo = sorted[Math.floor(sorted.length * 0.03)] || -60, hi = sorted[sorted.length - 1] || 0;
      const mix = []; for (let i = 0; i < pts; i++) { const v = seg[Math.floor(i * (seg.length - 1) / (pts - 1))]; mix.push(+(Math.min(1, Math.max(0, (v - lo) / Math.max(6, hi - lo))) * 0.92 + 0.04).toFixed(3)); }
      return json({ t0, t1, mix });
    }
  }
  return fail("not available in the browser version", 404);
}

const realFetch = window.fetch.bind(window);
window.fetch = (url, init) => {
  const s = typeof url === "string" ? url : url.url;
  if (/^\/(api|fonts)\//.test(s)) return handle(s, init);
  return realFetch(url, init);
};
window.mediaURL = p => {
  if (p.startsWith("/audio")) return F.song ? (F.song._url ||= URL.createObjectURL(F.song)) : "";
  if (p.startsWith("/perfvideo")) return F.performance ? (F.performance._url ||= URL.createObjectURL(F.performance)) : "";
  if (p.startsWith("/video/")) { const n = decodeURIComponent(p.slice(7)), r = cache.renders.find(x => x.name === n); return r ? r.url : ""; }
  if (p.startsWith("/fonts/user-")) return fontURLs[p.slice(7)] || "";
  if (p.startsWith("/fonts/")) return "fonts/" + p.slice(7);
  return "";
};
window.setImageFrom = async (img, p) => { const r = await handle(p); if (r.ok) img.src = URL.createObjectURL(await r.blob()); else img.style.display = "none"; };
window.LyricWeb = { files: F, state: () => ST, cache, setSong: f => { F.song = f; ST.songName = f.name; ST.songKey = songKey(); store(ST); }, setClips: fs => { F.clips = fs; prescan(); }, setPerformance: f => { F.performance = f; } };
})();
