// SmartWin-Intro: Das Radar-Logo erscheint, die Kurslinie wird zur Elfenbein-Viper, die nach oben zuschlägt,
// danach fliegt das Logo in die Kopfzeile. Läuft einmal pro Sitzung, Klick/Taste überspringt,
// bei „weniger Bewegung“ (prefers-reduced-motion) und im Retro-Modus gar nicht. Die Seite lädt dahinter normal weiter.
(() => {
  try {
    const de = document.documentElement;
    if (de.dataset.mode === 'retro' || /nointro/.test(location.hash) || document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (sessionStorage.getItem('rr:intro')) return;
    sessionStorage.setItem('rr:intro', '1');
  } catch { return; }
  const de = document.documentElement;
  const st = document.createElement('style');
  st.textContent = '.rr-intro header .logo{visibility:hidden}#rrIntro{position:fixed;inset:0;z-index:2147483000;cursor:pointer;-webkit-tap-highlight-color:transparent}#rrIntro .bg{position:absolute;inset:0;background:var(--bg,#f3eee5)}';
  document.head.appendChild(st);
  const ov = document.createElement('div');
  ov.id = 'rrIntro'; ov.setAttribute('aria-hidden', 'true');
  ov.innerHTML = '<div class="bg"></div>' + `<svg id="ri-logo" viewBox="0 0 120 120" style="position:fixed;overflow:visible;transform-origin:50% 50%;opacity:0">
  <circle cx="60" cy="60" r="50" fill="#2f5d50"/>
  <circle cx="60" cy="60" r="34" fill="none" stroke="#4f8a74" stroke-width="2"/>
  <circle cx="60" cy="60" r="18" fill="none" stroke="#4f8a74" stroke-width="2"/>
  <path id="ri-sweep" d="M60 60 L60 10 A50 50 0 0 1 103 35 Z" fill="#f4c27a" opacity=".55"/>
  <path id="ri-redraw" d="M26 76 L44 64 L58 70 L76 46 L92 52" fill="none" stroke="#fffdf8" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" pathLength="1" stroke-dasharray="1" stroke-dashoffset="1"/>
  <circle id="ri-dot" cx="92" cy="52" r="5" fill="#c2410c" opacity="0"/>
  <defs><linearGradient id="ri-skin" x1="0" x2="1"><stop offset="0" stop-color="#fffdf8"/><stop offset="1" stop-color="#e3d8c5"/></linearGradient>
  <filter id="ri-glow" x="-1" y="-1" width="3" height="3"><feGaussianBlur stdDeviation="1.6"/></filter><filter id="ri-soft" x="-.5" y="-.5" width="2" height="2"><feGaussianBlur stdDeviation="1.3"/></filter></defs>
  <path id="ri-trailGlow" fill="none" stroke="#f4c27a" stroke-width="5" stroke-linecap="round" filter="url(#ri-soft)"/>
  <path id="ri-trail" fill="none" stroke="#fff3d6" stroke-width="1.6" stroke-linecap="round"/>
  <path id="ri-line" fill="none" stroke="#fffdf8" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
  <path id="ri-body" fill="url(#ri-skin)" stroke="#a89a82" stroke-width=".6" stroke-linejoin="round"/>
  <path id="ri-scales" fill="none" stroke="#d29a3c" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/>
  <g id="ri-head">
    <path id="ri-tongue" d="M10 0 L16 0 M16 0 L19 -2.2 M16 0 L19 2.2" stroke="#c2410c" stroke-width="1.1" stroke-linecap="round" fill="none"/>
    <path d="M11 0 L6 -3.2 L-1 -6 L-6 -5.6 L-7.5 -2.4 L-6.5 0 L-7.5 2.4 L-6 5.6 L-1 6 L6 3.2 Z" fill="url(#ri-skin)" stroke="#a89a82" stroke-width=".6" stroke-linejoin="round"/>
    <path d="M7 -2 L.5 -4.6 L-5 -4.2 M7 2 L.5 4.6 L-5 4.2 M-2 -1.6 L-6 0 L-2 1.6" fill="none" stroke="#d29a3c" stroke-width=".9" stroke-linejoin="round" stroke-linecap="round"/>
    
    <g id="ri-eyeGlow" filter="url(#ri-glow)" opacity="0"><ellipse cx="1.8" cy="-3.3" rx="2.8" ry="1.6" fill="#ff4a2a" transform="rotate(-22 1.8 -3.3)"/><ellipse cx="1.8" cy="3.3" rx="2.8" ry="1.6" fill="#ff4a2a" transform="rotate(22 1.8 3.3)"/></g>
    <ellipse cx="1.8" cy="-3.3" rx="2.1" ry="1.05" fill="#e0412a" transform="rotate(-22 1.8 -3.3)"/><ellipse cx="1.8" cy="3.3" rx="2.1" ry="1.05" fill="#e0412a" transform="rotate(22 1.8 3.3)"/>
    <ellipse cx="2" cy="-3.3" rx=".3" ry="1" fill="#2b0b05"/><ellipse cx="2" cy="3.3" rx=".3" ry="1" fill="#2b0b05"/>
  </g>
</svg>`;
  (document.body || de).appendChild(ov);
  de.classList.add('rr-intro');
  const cache = {}, $ = id => cache[id] || (cache[id] = ov.querySelector('#ri-' + id));
  const logo = $('logo'), bg = ov.querySelector('.bg');
  const size = Math.round(Math.min(220, innerWidth * 0.55));
  Object.assign(logo.style, { left: '50%', top: '50%', width: size + 'px', height: size + 'px', margin: `${-size/2}px 0 0 ${-size/2}px` });
  // Ziel: Mitte und Größe des Logos in der Kopfzeile (Kreis füllt dort die ganze Fläche, im Intro 100/120 der Breite)
  let target = null;
  const flyTarget = () => {
    const el = document.querySelector('header .logo'), r = el && el.getBoundingClientRect();
    if (!r || !r.width) return { x: 44 - innerWidth/2, y: 44 - innerHeight/2, s: 0.2 };
    return { x: r.left + r.width/2 - innerWidth/2, y: r.top + r.height/2 - innerHeight/2, s: r.width / (size * 100/120) };
  };

  const CH = [[26,76],[44,64],[58,70],[76,46],[92,52]];       // Kurslinie im Logo
  const segLen = CH.slice(1).map((p,i)=>Math.hypot(p[0]-CH[i][0], p[1]-CH[i][1])), total = segLen.reduce((a,b)=>a+b,0);
  const S0 = 0.35;                                            // Anteil der Bahn, der die Kurslinie ist
  const ease = x => x<.5 ? 4*x*x*x : 1-Math.pow(-2*x+2,3)/2;
  const clamp = (x,a=0,b=1)=>Math.max(a,Math.min(b,x));
  // Bahn P(s): erst entlang der Kurslinie, dann in Schlangenbogen nach oben aus dem Kreis
  function Praw(s, wig) {
    if (s <= S0) {
      let d = s / S0 * total;
      for (let i = 0; i < segLen.length; i++) { if (d <= segLen[i] || i === segLen.length-1) { const f = d/segLen[i]; return [CH[i][0]+(CH[i+1][0]-CH[i][0])*f, CH[i][1]+(CH[i+1][1]-CH[i][1])*f]; } d -= segLen[i]; }
    }
    const q = s - S0;
    return [92 + 13*Math.sin(q*7)*wig - q*30, 52 - q*150];
  }
  // geglättete Bahn: Ecken der Kurslinie und der Übergang nach oben werden zu weichen Bögen (Chaikin), dann nach Bogenlänge parametrisiert
  const SMAX = 2.2, SM = (() => {
    let p = []; for (let s = 0; s <= SMAX + 1e-9; s += 0.01) p.push(Praw(s, 1));
    for (let it = 0; it < 4; it++) { const q = [p[0]]; for (let i = 0; i < p.length-1; i++) { const a = p[i], b = p[i+1]; q.push([a[0]*.75+b[0]*.25, a[1]*.75+b[1]*.25], [a[0]*.25+b[0]*.75, a[1]*.25+b[1]*.75]); } q.push(p.at(-1)); p = q; }
    const cum = [0]; for (let i = 1; i < p.length; i++) cum.push(cum[i-1] + Math.hypot(p[i][0]-p[i-1][0], p[i][1]-p[i-1][1]));
    // Bogenlänge der Rohbahn, damit s auf beiden Bahnen ungefähr dieselbe Stelle meint
    const raw = [0]; let prev = Praw(0,1); for (let s = 0.01; s <= SMAX + 1e-9; s += 0.01) { const c = Praw(s,1); raw.push(raw.at(-1) + Math.hypot(c[0]-prev[0], c[1]-prev[1])); prev = c; }
    return { p, cum, raw, rawTot: raw.at(-1), tot: cum.at(-1) };
  })();
  function Psm(s) {
    const fi = clamp(s/0.01, 0, SM.raw.length-1), i0 = Math.floor(fi), rl = SM.raw[i0] + ((SM.raw[Math.min(i0+1, SM.raw.length-1)] - SM.raw[i0]) * (fi - i0));
    const target = rl / SM.rawTot * SM.tot; let lo = 0, hi = SM.cum.length-1;
    while (hi - lo > 1) { const m = (lo+hi) >> 1; if (SM.cum[m] < target) lo = m; else hi = m; }
    const f = (target - SM.cum[lo]) / ((SM.cum[hi] - SM.cum[lo]) || 1), a = SM.p[lo], b = SM.p[hi];
    return [a[0]+(b[0]-a[0])*f, a[1]+(b[1]-a[1])*f];
  }
  // Punkt der Schlange: von eckiger Kurslinie zu weicher Bahn überblenden, dazu eine sanfte Schlängelwelle quer zur Bahn
  function P(s, time, wig) {
    const r = Praw(s, wig), m = Psm(s), k = wig, base = [r[0]+(m[0]-r[0])*k, r[1]+(m[1]-r[1])*k];
    const a = Psm(Math.max(0, s-0.01)), b = Psm(s+0.01), dx = b[0]-a[0], dy = b[1]-a[1], n = Math.hypot(dx, dy) || 1;
    const amp = k * (0.6 + 1.6*clamp((s-S0)/0.4)), w = amp * Math.sin(s*26 - time*0.009);
    return [base[0] - dy/n*w, base[1] + dx/n*w];
  }
  const L = S0;                                               // Länge der Schlange = Länge der Kurslinie
  function render(t) {
    // 1) Erscheinen
    const a = ease(clamp(t/350));
    // 4) zum Logo in der Kopfzeile fliegen
    const f = ease(clamp((t-1950)/420));
    if (f > 0 && !target) target = flyTarget();
    const tg = target || { x: 0, y: 0, s: 1 }, sc = (0.85 + 0.15*a) * (1 - f) + tg.s * f;
    logo.style.opacity = a;
    logo.style.transform = `translate(${f*tg.x}px,${f*tg.y}px) scale(${sc})`;
    // 2) Radarstrahl dreht einmal
    const r = ease(clamp((t-300)/550))*360;
    $('sweep').setAttribute('transform', `rotate(${r} 60 60)`);
    // 3) Kurslinie wird zur Schlange: erst lauern (langsam), dann Zuschlag nach oben (schnell)
    const k3 = clamp((t-800)/1000);
    const morph = clamp((t-800)/250);                      // Linie -> Schlangenkörper
    const sine = x => 0.5 - 0.5*Math.cos(Math.PI*x);
    const prog = k3 < .5 ? 0.19*sine(k3/.5) : k3 < .62 ? 0.19 - 0.035*sine((k3-.5)/.12) : 0.155 + ((k3-.62)/.38)**2.6 * 1.35;
    const u = S0 + prog;
    const wig = sine(clamp((t-820)/300));
    const N = 80, pts = [];
    for (let k = 0; k <= N; k++) { const sp = u - L + L*k/N; if (sp >= 0) pts.push(P(sp, t, wig)); }
    // Körper mit Dicke: Schwanz spitz, Bauch kräftig, Hals etwas schmaler
    const left = [], right = [];
    pts.forEach((p, i) => {
      const a = pts[Math.max(0, i-1)], b = pts[Math.min(pts.length-1, i+1)];
      const dx = b[0]-a[0], dy = b[1]-a[1], len = Math.hypot(dx, dy) || 1;
      const f = i/(pts.length-1);
      const w = (0.5 + 4.6*Math.sin(Math.min(1, f*1.15)*Math.PI*0.55)**1.4 - (f > .9 ? (f-.9)*14 : 0)) * morph;
      left.push([p[0] - dy/len*w, p[1] + dx/len*w]); right.push([p[0] + dy/len*w, p[1] - dx/len*w]);
    });
    const poly = [...left, ...right.reverse()];
    $('body').setAttribute('d', poly.length ? 'M' + poly.map(p => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join('L') + 'Z' : '');
    const center = pts.slice(Math.floor(pts.length*.12), Math.floor(pts.length*.92));
    // Zickzack in festen Abständen entlang des Körpers (nicht pro Messpunkt, sonst wird es zu dicht)
    const zig = []; let acc = 0, side = 1;
    for (let i = 1; i < center.length; i++) {
      const a = center[i-1], b = center[i], d = Math.hypot(b[0]-a[0], b[1]-a[1]); acc += d;
      if (acc >= 2.6 || i === 1) { acc = 0; side = -side;
        const n = d || 1, f = i/(center.length-1), w = side*2.2*Math.sin(Math.min(1, f*1.3)*Math.PI*.55)*morph;
        zig.push([b[0] - (b[1]-a[1])/n*w, b[1] + (b[0]-a[0])/n*w]); }
    }
    $('scales').setAttribute('d', zig.map((p,i)=>`${i?'L':'M'}${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(''));
    // goldene Leuchtspur hinter dem Schwanz
    const tailS = u - L, tr = [];
    if (tailS > S0) for (let k = 0; k <= 30; k++) tr.push(P(S0 + (tailS - S0)*k/30, t, wig));
    const trd = tr.length ? tr.map((p,i)=>`${i?'L':'M'}${p[0].toFixed(2)},${p[1].toFixed(2)}`).join('') : '';
    const trO = 1 - clamp((t-1750)/350);
    ['trail','trailGlow'].forEach(id => { const e = $(id); e.setAttribute('d', trd); e.setAttribute('opacity', trO*(id==='trail'?1:.8)); });
    // Augen glühen beim Zuschlag
    $('eyeGlow').setAttribute('opacity', clamp((k3-.5)/.15));
    $('scales').setAttribute('opacity', morph);
    // weiße Kurslinie blendet zur Schlange über
    $('line').setAttribute('d', pts.map((p,i)=>`${i?'L':'M'}${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(''));
    $('line').setAttribute('opacity', 1 - morph);
    const h = pts.at(-1), h2 = pts.at(-7) || pts[0], ang = Math.atan2(h[1]-h2[1], h[0]-h2[0]);
    const hs = 0.35 + 1.0*morph;
    $('head').setAttribute('transform', `translate(${h[0]},${h[1]}) rotate(${ang*180/Math.PI}) scale(${hs})`);
    // Zunge züngelt zweimal, während sie lauert
    const tf = (t > 1000 && t < 1180) || (t > 1260 && t < 1420);
    $('tongue').setAttribute('opacity', tf ? 1 : 0);
    // nach dem Aufstieg: frische Kurslinie zeichnet sich nach, damit das Logo in der Ecke vollständig ist
    // Seite einblenden
    const pg = clamp((t-2050)/350);
    const rd = ease(clamp((t-1650)/350));
    $('redraw').setAttribute('stroke-dashoffset', 1-rd);
    $('dot').setAttribute('opacity', clamp((t-1950)/100));
    bg.style.opacity = 1 - pg;
  }
  
  const END = 2450;
  let t0 = null, done = false;
  const finish = () => { if (done) return; done = true; ov.remove(); st.remove(); de.classList.remove('rr-intro'); };
  const tick = now => {
    if (done) return;
    if (t0 === null) t0 = now;
    const t = now - t0;
    try { render(Math.min(t, END)); } catch { return finish(); }
    if (t >= END) finish(); else requestAnimationFrame(tick);
  };
  // Überspringen: direkt zum Schluss (Logo fliegt in die Ecke, Seite blendet ein)
  const skip = () => { if (t0 !== null && performance.now() - t0 < 1950) t0 = performance.now() - 1950; else if (t0 === null) finish(); };
  ov.addEventListener('pointerdown', skip);
  addEventListener('keydown', skip, { once: true });
  setTimeout(finish, 5000);            // Sicherheitsnetz, falls der Browser keine Bilder zeichnet
  requestAnimationFrame(tick);
})();
