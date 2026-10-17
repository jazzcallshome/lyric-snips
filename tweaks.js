/* Browser-version touches on the shared interface. */
(function () {
  const $ = s => document.querySelector(s);
  // videos download straight to the visitor's Downloads folder
  const rv = $("#revealBtn"); if (rv) rv.textContent = "⬇ Download again";
  const sb = $(".savebox"); if (sb) sb.style.display = "none";
  // vocal separation needs the desktop app
  const snap = $("#snapBtn"); if (snap) snap.style.display = "none";
  const note = $("#snapNote");
  if (note) {
    note.innerHTML = "Tip: <b>Snap taps to vocals</b> (it lines every tap up with the singing automatically) is in the desktop app. You can download it further down this page. Here, click a line to fine-tune it by hand.";
    new MutationObserver(() => { if (!note.querySelector("b")) note.innerHTML = "Tip: <b>Snap taps to vocals</b> (it lines every tap up with the singing automatically) is in the desktop app. You can download it further down this page. Here, click a line to fine-tune it by hand."; }).observe(note, { childList: true, characterData: true, subtree: true });
  }
  // browsers forget picked files after a reload
  const songInfo = $("#songInfo");
  // a heads-up when the browser can't make videos
  if (!(window.LyricEngine && window.LyricEngine.support())) {
    const bar = document.createElement("div");
    bar.style.cssText = "background:#2a2010;color:#fff1a6;border-bottom:1px solid #4a3a18;padding:.6rem 1.2rem;font-size:.85rem;text-align:center";
    bar.textContent = "This browser can't make videos yet. Please use a recent Chrome, Edge or Safari, or download the desktop app.";
    document.body.insertBefore(bar, document.body.firstChild);
  }
  // font credits for the bundled typefaces
  const foot = $(".foot");
  if (foot) { const c = document.createElement("span"); c.style.cssText = "flex-basis:100%;font-size:.68rem;opacity:.7"; c.innerHTML = 'Runs entirely in your browser: your songs and clips never leave your computer. · Fonts: DotGothic16 (SIL OFL), IBM VGA 8x16 by VileR / <a href="https://int10h.org/oldschool-pc-fonts/" target="_blank" rel="noopener" style="color:inherit">int10h.org</a> (CC BY-SA 4.0)'; foot.appendChild(c); }
})();
