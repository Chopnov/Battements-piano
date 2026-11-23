(function () {
  var $ = function (id) { return document.getElementById(id); };
  var NOMS = Bat.NOMS, IV = Bat.INTERVALLES;
  var ac = null, voix = null, raf = 0, stopTimer = 0, pairTimer = 0;

  // ---------- Piano enregistré ----------
  var DATA = typeof DATA_REEL !== 'undefined' ? DATA_REEL : null, bufs = null, chargement = null, reelEchec = false;
  function reelOk() { return !!DATA && !reelEchec && $('mode').value === 'reel'; }
  function SR() { return reelOk() ? Bat.reel(DATA, la4()) : null; }
  function calcAff(mb, iv) { var s = SR(); return s ? s.calc(mb, iv) : Bat.calc(mb, iv, la4(), inh()); }
  function battAff(mb, iv, dc) { var s = SR(); return s ? s.battement(mb, iv, dc) : Bat.battement(mb, iv, la4(), inh(), dc); }
  function chargerReel() {
    if (bufs) return Promise.resolve(bufs);
    if (chargement) return chargement;
    var cles = Object.keys(DATA.samples);
    chargement = Promise.all(cles.map(function (k) {
      return fetch('piano/s' + k + '.mp3').then(function (r) { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
        .then(function (ab) { return new Promise(function (ok, ko) { ctxAudio().decodeAudioData(ab, ok, ko); }); });
    })).then(function (arr) {
      bufs = {}; cles.forEach(function (k, i) { bufs[k] = arr[i]; }); return bufs;
    }, function (e) {
      reelEchec = true; chargement = null; rendre(); throw e;
    });
    return chargement;
  }
  // Une note enregistrée (échantillon le plus proche, ajusté à la hauteur exacte, dc en cents)
  function noteReelle(a, dest, S, note, dc, t0, opts) {
    opts = opts || {};
    var rate = S.rapport(note) * Math.pow(2, (dc || 0) / 1200);
    var o = { dur: opts.dur, gain: S.gain(note) };
    if (opts.faible) o.faible = { freq: S.partiel(note, opts.faible.n) * Math.pow(2, (dc || 0) / 1200), db: opts.faible.db };
    return Bat.echantillon(a, bufs[S.proche(note)], dest, rate, t0, o);
  }

  // ---------- Réglages ----------
  function la4() { var v = parseFloat($('la4').value); return v > 400 && v < 480 ? v : 440; }
  function inh() { var v = parseFloat($('inh').value); return (v >= 0 && v <= 30 ? v : 0) * 1e-4; }
  function fmt(h) { return h < 10 ? h.toFixed(2) : h.toFixed(1); }
  function midiBas() { return parseInt($('selNote').value, 10); }

  try {
    var s = localStorage.getItem('bat.la4'); if (s) $('la4').value = s;
    var b = localStorage.getItem('bat.inh'); if (b) $('inh').value = b;
  } catch (e) {}

  // Notes de la partition : Fa3 (MIDI 53) à Fa4 (MIDI 65)
  var PART_MIN = 53, PART_MAX = 65;
  for (var m = PART_MIN; m < PART_MAX; m++) { var o = document.createElement('option'); o.value = m; o.textContent = Bat.nomNote(m); $('selNote').appendChild(o); }
  $('selNote').value = 57; // La3
  IV.forEach(function (iv, i) {
    var o = document.createElement('option'); o.value = i;
    o.textContent = iv.nom + '  (' + iv.n + ':' + iv.m + ')'; $('selIv').appendChild(o);
  });
  $('selIv').value = 3; // tierce majeure

  // ---------- Rendu ----------
  function sensHtml(r) {
    var cls = r.sens === 'large' ? 'large' : r.sens === 'étroit' ? 'etroit' : '';
    return '<div class="sens ' + cls + '">' + r.sens + (Math.abs(r.cents) > 0.005 ? ' (' + (r.cents > 0 ? '+' : '') + r.cents.toFixed(1) + ' ct)' : '') + '</div>';
  }

  function rendreListe() {
    var mb = midiBas(), h = '';
    IV.forEach(function (iv, i) {
      if (mb + iv.k > PART_MAX) return;
      var r = calcAff(mb, iv);
      var cle = mb + '-' + i;
      h += '<div class="carte' + (voix && voix.cle === cle ? ' joue' : '') + '" data-mb="' + mb + '" data-i="' + i + '">' +
        '<div><div class="nom">' + iv.nom + '</div>' +
        '<div class="sous">' + Bat.nomNote(mb) + ' → ' + Bat.nomNote(mb + iv.k) +
        '<br>partiel ' + iv.n + ' de ' + Bat.nomNote(mb) + ' contre partiel ' + iv.m + ' de ' + Bat.nomNote(mb + iv.k) + '</div></div>' +
        '<div class="val"><div class="hz">' + fmt(r.hz) + '<small> Hz</small></div>' + sensHtml(r) +
        '<div class="sens">≈ ' + (r.hz * 10).toFixed(r.hz * 10 < 100 ? 1 : 0) + ' en 10 s</div></div></div>';
    });
    $('liste').innerHTML = h;
  }

  function rendreTableau() {
    var i = parseInt($('selIv').value, 10), iv = IV[i];
    $('infoIv').textContent = iv.nom + ' : battement entre le partiel ' + iv.n + ' de la note grave et le partiel ' + iv.m +
      ' de la note aiguë. Notes de la partition : Fa3 à Fa4.';
    var h = '<table><tr><th>Note grave</th><th>Note aiguë</th><th style="text-align:right">Battement</th><th>Sens</th></tr>';
    for (var mb = PART_MIN; mb + iv.k <= PART_MAX; mb++) {
      var r = calcAff(mb, iv);
      var cle = mb + '-' + i;
      h += '<tr class="ligne-t' + (voix && voix.cle === cle ? ' joue' : '') +
        '" data-mb="' + mb + '" data-i="' + i + '"><td>' + Bat.nomNote(mb) + '</td><td>' + Bat.nomNote(mb + iv.k) +
        '</td><td class="num">' + fmt(r.hz) + ' Hz</td><td>' + r.sens + '</td></tr>';
    }
    $('tableau').innerHTML = h + '</table>';
  }

  function rendre() { rendreListe(); rendreTableau(); }

  // ---------- Audio ----------
  function ctxAudio() {
    ac = ac || new (window.AudioContext || window.webkitAudioContext)();
    if (ac.state === 'suspended') ac.resume();
    return ac;
  }

  function arreter(garder) {
    clearTimeout(stopTimer); cancelAnimationFrame(raf); if (!garder) clearTimeout(pairTimer);
    if (voix && ac) {
      var v = voix, t = ac.currentTime;
      v.g.gain.cancelScheduledValues(t);
      v.g.gain.setValueAtTime(v.g.gain.value, t);
      v.g.gain.linearRampToValueAtTime(0, t + 0.08);
      v.oscs.forEach(function (o) { try { o.stop(t + 0.1); } catch (e) {} });
    }
    voix = null;
    $('barre').hidden = true;
    document.querySelectorAll('.joue').forEach(function (e) { e.classList.remove('joue'); });
  }

  // Attend le chargement des enregistrements, puis relance fn (avec le modèle si le chargement échoue)
  function attente(fn) {
    $('barreTexte').textContent = 'Chargement du piano…';
    $('pouls').style.visibility = 'hidden';
    $('barre').hidden = false;
    chargerReel().then(fn, fn);
  }

  function jouer(mb, i) {
    var cle = mb + '-' + i;
    if (voix && voix.cle === cle) { arreter(); return; }
    arreter();
    if (reelOk() && !bufs) { attente(function () { jouer(mb, i); }); return; }
    var iv = IV[i], B = inh(), r = calcAff(mb, iv), S = SR();
    var a = ctxAudio();
    var g = a.createGain(); g.gain.value = 0; g.connect(a.destination);
    var oscs = [];
    function ajoute(f, amp) {
      if (f < 15 || f > 16000) return;
      var o = a.createOscillator(); o.type = 'sine'; o.frequency.value = f;
      var gg = a.createGain(); gg.gain.value = amp;
      o.connect(gg); gg.connect(g); o.start(); oscs.push(o);
    }
    if ($('mode').value === 'partiels') {
      ajoute(r.p1, 0.5); ajoute(r.p2, 0.5);
    } else if (S) {
      var tr = a.currentTime + 0.02;
      oscs = oscs.concat(noteReelle(a, g, S, mb, 0, tr, { dur: 10 }), noteReelle(a, g, S, mb + iv.k, 0, tr, { dur: 10 }));
    } else {
      var t1 = a.currentTime + 0.02;
      oscs = oscs.concat(Bat.piano(a, g, r.f1, B, t1, { dur: 12 }), Bat.piano(a, g, r.f2, B, t1, { dur: 12 }));
    }
    var t = a.currentTime;
    g.gain.linearRampToValueAtTime(0.5, t + 0.06);
    voix = { g: g, oscs: oscs, cle: cle, hz: r.hz, t0: t };

    $('barreTexte').innerHTML = Bat.nomNote(mb) + ' + ' + Bat.nomNote(mb + iv.k) + ' · ' + iv.nom +
      '<br><b>' + fmt(r.hz) + ' battements/s</b>' + (r.hz > 20 ? ' (trop rapide : rugosité)' : '');
    $('pouls').style.visibility = '';
    $('barre').hidden = false;
    rendre();
    animer();
    stopTimer = setTimeout(arreter, $('mode').value === 'partiels' ? 30000 : 11000);
  }

  // Le voyant s'allume au rythme exact du battement
  function animer() {
    if (!voix) return;
    var t = ac.currentTime - voix.t0;
    var v = voix.hz > 20 ? 0.6 : Math.abs(Math.cos(Math.PI * voix.hz * t));
    $('pouls').style.opacity = 0.12 + 0.88 * v;
    raf = requestAnimationFrame(animer);
  }

  // ---------- Test : tierces majeures de la partition ----------
  var IV_TM = IV.findIndex(function (x) { return x.k === 4; });
  var TM_MIN = PART_MIN, TM_MAX = PART_MAX - 4;
  var Q = { mb: 0, hz: 0, repondu: false, n: 0, ok: 0, pm: 0 };

  (function () {
    var h = '';
    for (var m = TM_MIN; m <= TM_MAX; m++) h += '<button class="rep" data-q="' + m + '">' + Bat.nomNote(m) + '–' + Bat.nomNote(m + 4) + '</button>';
    $('quizRep').innerHTML = h;
  })();

  // Battement neutre : deux sinus vers 1 kHz, écartés de hz. Même sensation, aucun indice sur la note.
  function jouerBattement(hz, etiquette, voyant) {
    arreter();
    var a = ctxAudio();
    var g = a.createGain(); g.gain.value = 0; g.connect(a.destination);
    var oscs = [];
    [1000, 1000 + hz].forEach(function (f) {
      var o = a.createOscillator(); o.type = 'sine'; o.frequency.value = f;
      var gg = a.createGain(); gg.gain.value = 0.4; o.connect(gg); gg.connect(g); o.start(); oscs.push(o);
    });
    var t = a.currentTime;
    g.gain.linearRampToValueAtTime(0.5, t + 0.06);
    voix = { g: g, oscs: oscs, cle: 'test', hz: hz, t0: t };
    $('barreTexte').textContent = etiquette ? 'Test : ' + etiquette : 'Test : écoute le battement';
    $('pouls').style.visibility = (voyant === undefined ? $('quizVitesse').checked : voyant) ? '' : 'hidden';
    $('barre').hidden = false;
    animer();
    stopTimer = setTimeout(arreter, 30000);
  }

  function quizAffiche() {
    var vu = Q.repondu || $('quizVitesse').checked;
    $('quizHz').textContent = vu ? fmt(Q.hz) + ' Hz' : '? Hz';
    if (voix && voix.cle === 'test') $('pouls').style.visibility = $('quizVitesse').checked ? '' : 'hidden';
    $('quizScore').textContent = Q.n
      ? 'Juste : ' + Q.ok + ' sur ' + Q.n + ' · à ±1 demi-ton : ' + (Q.ok + Q.pm) + ' sur ' + Q.n
      : 'Pas encore de réponse.';
  }

  function quizNouvelle(son) {
    arreter();
    var m;
    do { m = TM_MIN + Math.floor(Math.random() * (TM_MAX - TM_MIN + 1)); } while (m === Q.mb);
    Q.mb = m; Q.repondu = false;
    Q.hz = calcAff(m, IV[IV_TM]).hz;
    document.querySelectorAll('#quizRep .rep').forEach(function (b) { b.classList.remove('bon', 'mauvais'); });
    $('quizRetour').textContent = '';
    $('quizSuite').hidden = true;
    quizAffiche();
    if (son) jouerBattement(Q.hz);
  }

  $('quizRep').addEventListener('click', function (e) {
    var b = e.target.closest('[data-q]');
    if (!b || Q.repondu) return;
    var rep = parseInt(b.getAttribute('data-q'), 10), ecart = Math.abs(rep - Q.mb);
    Q.repondu = true; Q.n++;
    if (ecart === 0) Q.ok++; else if (ecart === 1) Q.pm++;
    var vrai = calcAff(Q.mb, IV[IV_TM]), dit = calcAff(rep, IV[IV_TM]);
    var nom = function (m) { return Bat.nomNote(m) + '–' + Bat.nomNote(m + 4); };
    document.querySelector('#quizRep [data-q="' + Q.mb + '"]').classList.add('bon');
    if (ecart) b.classList.add('mauvais');
    $('quizRetour').innerHTML = ecart === 0
      ? '<b>Juste.</b> ' + nom(Q.mb) + ' bat à ' + fmt(vrai.hz) + ' Hz.'
      : '<b>Réponse : ' + nom(Q.mb) + '</b> (' + fmt(vrai.hz) + ' Hz). Ta réponse ' + nom(rep) + ' bat à ' + fmt(dit.hz) + ' Hz' + (ecart === 1 ? ' : tout près.' : '.');
    $('quizSuite').hidden = false;
    quizAffiche();
    jouer(Q.mb, IV_TM);
  });
  $('quizSuite').addEventListener('click', function () { quizNouvelle(true); });
  $('quizEcoute').addEventListener('click', function () {
    arreter();
    if (Q.repondu) jouer(Q.mb, IV_TM); else jouerBattement(Q.hz);
  });
  $('quizVitesse').addEventListener('change', quizAffiche);

  // ---------- Exercices à deux sons ----------
  var P = { type: '', sonA: null, sonB: null, vrai: '', question: '', detail: '', retour: '', repondu: false, n: 0, ok: 0 };
  // Écarts entre A et B (en logarithme népérien du rapport des vitesses, ~ pourcentage)
  var NIVEAUX = {
    facile:    { pareil: 0.03, min: 0.12, max: 9,    cents: [3, 4, 6], oct: 3 },
    moyen:     { pareil: 0.03, min: 0.06, max: 0.12, cents: [1.5, 2],  oct: 2 },
    difficile: { pareil: 0.02, min: 0.03, max: 0.06, cents: [0.5, 1],  oct: 1 }
  };
  function niveau() { return NIVEAUX[$('exoNiveau').value] || NIVEAUX.moyen; }
  function ivDe(k) { return IV.filter(function (x) { return x.k === k; })[0]; }
  function nomIv(m, iv) { return Bat.nomNote(m) + '–' + Bat.nomNote(m + iv.k); }
  function alea(n) { return Math.floor(Math.random() * n); }

  // A puis B, avec un silence entre les deux. Piano (modèle) ou battement neutre.
  function jouerPaire(seul) {
    if (typeof seul !== 'string') seul = '';
    arreter();
    var a = ctxAudio();
    if (P.type === 'octave' || $('exoSon').value === 'piano') {
      if (reelOk() && !bufs) { attente(function () { jouerPaire(seul); }); return; }
      var t = a.currentTime + 0.05, B = inh(), oscs = [], S = SR();
      var g = a.createGain(); g.gain.value = 0.5; g.connect(a.destination);
      var DUR = 5;
      [P.sonA, P.sonB].forEach(function (s, i) {
        if (seul && seul !== 'AB'.charAt(i)) return;
        var t0 = t + (seul ? 0 : i * (DUR + 1));
        if (S) {
          var db = s.g < 1 ? -20 * Math.log10(s.g) : 0;
          oscs = oscs.concat(
            noteReelle(a, g, S, s.mb, 0, t0, { dur: DUR, faible: s.wl ? { n: s.wl, db: db } : null }),
            noteReelle(a, g, S, s.mb + s.k, s.dc, t0, { dur: DUR, faible: s.wh ? { n: s.wh, db: db } : null }));
          return;
        }
        var f1 = Bat.freq(s.mb, la4()), f2 = Bat.freq(s.mb + s.k, la4()) * Math.pow(2, s.dc / 1200);
        oscs = oscs.concat(
          Bat.piano(a, g, f1, B, t0, { dur: DUR, faible: s.wl ? { n: s.wl, gain: s.g } : null }),
          Bat.piano(a, g, f2, B, t0, { dur: DUR, faible: s.wh ? { n: s.wh, gain: s.g } : null }));
      });
      voix = { g: g, oscs: oscs, cle: 'paire', hz: 0, t0: t };
      $('barreTexte').textContent = seul ? 'Test : ' + seul : 'Test : A puis B';
      $('pouls').style.visibility = 'hidden';
      $('barre').hidden = false;
      stopTimer = setTimeout(arreter, seul ? 5300 : 11300);
      return;
    }
    if (seul === 'B') { jouerBattement(P.sonB.hz, 'son B', false); return; }
    jouerBattement(P.sonA.hz, 'son A', false);
    if (seul === 'A') return;
    clearTimeout(stopTimer);
    pairTimer = setTimeout(function () {
      arreter(true);
      pairTimer = setTimeout(function () {
        jouerBattement(P.sonB.hz, 'son B', false);
        clearTimeout(stopTimer); stopTimer = setTimeout(arreter, 3000);
      }, 600);
    }, 3000);
  }

  // Tierces et sixtes de l'octave qui battent assez vite pour être comparées
  function paireCompare() {
    var nv = niveau(), liste = [];
    [3, 4, 8, 9].forEach(function (k) {
      var iv = ivDe(k);
      for (var m = PART_MIN; m + k <= PART_MAX; m++) liste.push({ iv: iv, m: m, hz: calcAff(m, iv).hz });
    });
    var classes = { plus: [], pareil: [], moins: [] };
    liste.forEach(function (x) {
      liste.forEach(function (y) {
        if (x.iv.k === y.iv.k || x.hz < 6 || y.hz < 6) return;
        var e = Math.log(y.hz / x.hz), ae = Math.abs(e);
        if (ae <= nv.pareil) classes.pareil.push([x, y]);
        else if (ae >= nv.min && ae < nv.max) classes[e > 0 ? 'plus' : 'moins'].push([x, y]);
      });
    });
    var cles = ['plus', 'pareil', 'moins'].filter(function (c) { return classes[c].length; });
    var c = cles[alea(cles.length)];
    var p = classes[c][alea(classes[c].length)];
    P.sonA = { mb: p[0].m, k: p[0].iv.k, dc: 0, hz: p[0].hz };
    P.sonB = { mb: p[1].m, k: p[1].iv.k, dc: 0, hz: p[1].hz };
    P.vrai = c;
    P.question = "Écoute A puis B. Le son B bat-il plus vite, pareil ou plus lentement que A ?";
    P.detail = 'A : ' + nomIv(p[0].m, p[0].iv) + ' (' + p[0].iv.nom.toLowerCase() + ')  ·  B : ' + nomIv(p[1].m, p[1].iv) + ' (' + p[1].iv.nom.toLowerCase() + ')';
    P.retour = 'A bat à ' + fmt(p[0].hz) + ' Hz, B à ' + fmt(p[1].hz) + ' Hz.';
  }

  // Une tierce juste (A), puis la même avec la note aiguë décalée de quelques cents (B)
  function paireCents() {
    var nv = niveau(), iv = ivDe(4), B = inh(), m, dc, hzA, hzB, essais = 0;
    do {
      m = TM_MIN + alea(TM_MAX - TM_MIN + 1);
      dc = nv.cents[alea(nv.cents.length)] * (Math.random() < 0.5 ? -1 : 1);
      hzA = battAff(m, iv, 0);
      hzB = battAff(m, iv, dc);
      essais++;
    } while (Math.abs(Math.log(hzB / hzA)) < 0.025 && essais < 50);
    P.sonA = { mb: m, k: 4, dc: 0, hz: hzA };
    P.sonB = { mb: m, k: 4, dc: dc, hz: hzB };
    P.vrai = hzB > hzA ? 'plus' : 'moins';
    P.question = "Écoute A (tierce juste) puis B (même tierce, note aiguë décalée). B bat-il plus vite ou plus lentement ?";
    P.detail = 'Tierce majeure ' + nomIv(m, iv);
    P.retour = 'A (théorie) ' + fmt(hzA) + ' Hz, B ' + fmt(hzB) + ' Hz : la note aiguë était ' + (dc > 0 ? 'trop haute' : 'trop basse') + ' de ' + Math.abs(dc) + ' ct.';
  }

  // Ton contrôle d'octave dans les basses : tierce mineure du bas contre sixte majeure du haut.
  // La note haute est décalée par rapport à l'octave 6:3 pure (là où les deux battements sont égaux).
  function paireOctave() {
    var nv = niveau(), B = inh(), S = SR(), X = S ? [42, 45, 48, 51, 54][alea(5)] : 41 + alea(13);  // note du bas ; enregistré : trois notes non transposées
    var delta = [-nv.oct, 0, nv.oct][alea(3)];
    var dc = (S ? S.octaveEgale(X) : Bat.octaveEgale(X, la4(), B)) + delta;
    var ivA = ivDe(3), ivB = ivDe(9), fb = $('exoFaible').value, att = $('exoAtt').value;
    if (fb === 'hasard') fb = ['y5', 'x6', 't3'][alea(3)];
    var db = !fb ? 0 : (att === 'hasard' ? [0, 10, 20, 30, 50][alea(5)] : parseInt(att, 10));
    var gw = Math.pow(10, -db / 20);
    var hzA = battAff(X, ivA, 0), hzB = battAff(X + 3, ivB, dc);
    P.sonA = { mb: X, k: 3, dc: 0, wl: fb === 'x6' ? 6 : 0, wh: fb === 'y5' ? 5 : 0, g: gw, hz: hzA };
    P.sonB = { mb: X + 3, k: 9, dc: dc, wl: fb === 'y5' ? 5 : 0, wh: fb === 't3' ? 3 : 0, g: gw, hz: hzB };
    P.vrai = delta === 0 ? 'pareil' : (hzB > hzA ? 'plus' : 'moins');
    P.question = 'Octave ' + Bat.nomNote(X) + '–' + Bat.nomNote(X + 12) + ". Écoute A (tierce mineure du bas) puis B (sixte majeure du haut). B bat-il plus vite, pareil ou plus lentement que A ?";
    P.detail = 'A : ' + nomIv(X, ivA) + '  ·  B : ' + nomIv(X + 3, ivB);
    P.retour = 'A bat à ' + fmt(hzA) + ' Hz, B à ' + fmt(hzB) + ' Hz. Note haute ' +
      (delta === 0 ? 'juste (octave 6:3 pure).' : (delta > 0 ? 'trop haute' : 'trop basse') + ' de ' + Math.abs(delta) + ' ct par rapport à l’octave 6:3 pure.') + faibleTexte(fb, db);
  }

  function faibleTexte(qui, db) {
    if (!qui || !db) return ' Aucun partiel affaibli.';
    var lib = { y5: '5e partiel de la note du milieu', x6: '6e partiel de la note grave', t3: '3e partiel de la note haute' };
    return ' Partiel affaibli : ' + lib[qui] + (db >= 50 ? ' (quasi absent)' : ', −' + db + ' dB') + '.' +
      (db >= 20 ? ' Quand le battement de base disparaît, on entend celui du partiel suivant, deux fois plus rapide.' : '');
  }

  function pairScore() { $('cmpScore').textContent = P.n ? 'Juste : ' + P.ok + ' sur ' + P.n : 'Pas encore de réponse.'; }

  function pairNouvelle(e, son) {
    arreter();
    if (e === 'compare') paireCompare(); else if (e === 'cents') paireCents(); else paireOctave();
    P.type = e; P.repondu = false;
    document.querySelectorAll('#cmpRep .rep').forEach(function (x) { x.classList.remove('bon', 'mauvais'); });
    $('cmpPareil').hidden = e === 'cents';
    $('cmpQuestion').textContent = P.question;
    $('cmpDetail').textContent = P.detail;
    $('cmpRetour').textContent = '';
    $('cmpSuite').hidden = true;
    pairScore();
    if (son) jouerPaire();
  }

  $('cmpRep').addEventListener('click', function (e) {
    var b = e.target.closest('[data-c]');
    if (!b || P.repondu) return;
    var c = b.getAttribute('data-c'), bon = c === P.vrai;
    var mots = { plus: 'plus rapide', pareil: 'pareil', moins: 'plus lent' };
    P.repondu = true; P.n++; if (bon) P.ok++;
    document.querySelector('#cmpRep [data-c="' + P.vrai + '"]').classList.add('bon');
    if (!bon) b.classList.add('mauvais');
    $('cmpRetour').innerHTML = '<b>' + (bon ? 'Juste' : 'Réponse : B est ' + mots[P.vrai]) + '.</b> ' + P.retour;
    $('cmpSuite').hidden = false;
    pairScore();
  });
  $('cmpSuite').addEventListener('click', function () { pairNouvelle(P.type, true); });
  $('cmpEcoute').addEventListener('click', function () { jouerPaire(''); });
  $('cmpA').addEventListener('click', function () { jouerPaire('A'); });
  $('cmpB').addEventListener('click', function () { jouerPaire('B'); });

  // ---------- Règle toi-même la vitesse ----------
  var R = { mb: 0, iv: null, lo: 1, hi: 10, repondu: false, n: 0, ok: 0 };
  function regleHz() { return R.lo + (R.hi - R.lo) * parseFloat($('regleCur').value) / 1000; }
  function hzFr(h) { return h.toFixed(1).replace('.', ','); }
  function regleScore() { $('regleScore').textContent = R.n ? 'Verts : ' + R.ok + ' sur ' + R.n : 'Pas encore de réponse.'; }
  function regleNouvelle(son) {
    arreter();
    var m, iv;
    do { iv = ivDe([3, 4, 5, 8][alea(4)]); m = PART_MIN + alea(PART_MAX - iv.k - PART_MIN + 1); } while (m === R.mb && iv === R.iv);
    R.mb = m; R.iv = iv; R.repondu = false;
    var th = calcAff(m, iv).hz;
    R.lo = th * (0.15 + Math.random() * 0.35); R.hi = th * (1.8 + Math.random() * 1.2);
    $('regleQ').textContent = 'Règle la vitesse : ' + iv.nom.toLowerCase() + ' ' + nomIv(m, iv) + '.';
    $('regleCur').value = 100 + alea(800);
    $('regleRetour').textContent = ''; $('regleSuite').hidden = true; $('regleValide').disabled = false;
    regleScore();
    if (son) jouerBattement(regleHz(), 'ta vitesse', false);
  }
  $('regleCur').addEventListener('input', function () {
    var h = regleHz();
    if (voix && voix.cle === 'test' && voix.oscs[1]) { voix.oscs[1].frequency.value = 1000 + h; voix.hz = h; }
  });
  $('regleEcoute').addEventListener('click', function () { jouerBattement(regleHz(), 'ta vitesse', false); });
  $('regleValide').addEventListener('click', function () {
    if (R.repondu) return;
    var h = regleHz(), r = calcAff(R.mb, R.iv), e = Math.abs(h - r.hz) / r.hz;
    var cls = e <= 0.08 ? 'vert' : e <= 0.2 ? 'orange' : 'rouge';
    R.repondu = true; R.n++; if (cls === 'vert') R.ok++;
    $('regleRetour').innerHTML = '<b class="res-' + cls + '">' + { vert: 'Vert', orange: 'Orange', rouge: 'Rouge' }[cls] + '.</b> Tu as réglé ' + hzFr(h) +
      ' Hz, l’intervalle bat à ' + hzFr(r.hz) + ' Hz (' + (e < 0.005 ? '' : h > r.hz ? '+' : '−') + (e * 100).toFixed(0) + ' %).';
    $('regleSuite').hidden = false; $('regleValide').disabled = true;
    regleScore();
    jouer(R.mb, IV.indexOf(R.iv));
  });
  $('regleSuite').addEventListener('click', function () { regleNouvelle(true); });

  // Choix de l'exercice
  function exoOuvre() {
    var e = $('exo').value;
    if (e === 'tierce') { if (!Q.mb) quizNouvelle(true); }
    else if (e === 'regle') { if (!R.mb) regleNouvelle(true); }
    else if (!P.sonA || P.type !== e) pairNouvelle(e, true);
  }
  function exoChange() {
    var e = $('exo').value;
    $('exoTierce').hidden = e !== 'tierce';
    $('exoDeux').hidden = e === 'tierce' || e === 'regle';
    $('exoRegle').hidden = e !== 'regle';
    $('exoSon').hidden = e === 'octave';
    $('exoFaibleLigne').hidden = e !== 'octave';
    arreter();
    P.n = 0; P.ok = 0;
    if (e === 'tierce') quizNouvelle(true); else if (e === 'regle') regleNouvelle(true); else pairNouvelle(e, true);
  }
  $('exo').addEventListener('change', exoChange);
  ['exoSon', 'exoNiveau', 'exoFaible', 'exoAtt'].forEach(function (id) {
    $(id).addEventListener('change', function () { P.n = 0; P.ok = 0; pairNouvelle($('exo').value, true); });
  });
  function exoRafraichir() {
    var e = $('exo').value;
    if (e === 'tierce') quizNouvelle(false); else if (e === 'regle') regleNouvelle(false); else pairNouvelle(e, false);
  }

  // ---------- Compter les battements sur 10 s ----------
  var C = { actif: false, t0: 0, taps: 0, timer: 0 };
  var cptListe = [];
  [5, 7].forEach(function (k) {
    var i = IV.findIndex(function (x) { return x.k === k; });
    for (var m = PART_MIN; m + k <= PART_MAX; m++) cptListe.push({ m: m, i: i, k: k });
  });
  cptListe.sort(function (x, y) { return x.k - y.k || x.m - y.m; });
  cptListe.forEach(function (x) {
    var o = document.createElement('option'); o.value = x.m + '-' + x.i;
    o.textContent = Bat.nomNote(x.m) + '–' + Bat.nomNote(x.m + x.k) + ' (' + IV[x.i].nom.toLowerCase() + ')';
    $('cptIv').appendChild(o);
  });

  function cptFin() {
    clearInterval(C.timer); C.actif = false;
    $('cptTemps').textContent = '10,0 s';
    $('cptStart').disabled = false; $('cptTap').disabled = true; $('cptIv').disabled = false;
    var v = $('cptIv').value.split('-'), iv = IV[parseInt(v[1], 10)], r = calcAff(parseInt(v[0], 10), iv);
    var th = r.hz * 10, d = C.taps - th;
    var ct = (Math.abs(d) / 10) * 1200 / (iv.m * r.f2 * Math.LN2);
    var verdict = Math.abs(d) < 1.5 ? 'Dans la marge de comptage (±1 battement).' : (d > 0 ? 'Plus de battements que la théorie.' : 'Moins de battements que la théorie.');
    $('cptRes').innerHTML = '<b>' + C.taps + ' battements comptés</b> en 10 s. Théorie : ' + th.toFixed(1) + ' (' + fmt(r.hz) + ' Hz).<br>' +
      verdict + ' Écart ≈ ' + ct.toFixed(1) + ' ct sur la note aiguë.';
  }
  $('cptStart').addEventListener('click', function () {
    C.actif = true; C.taps = 0; C.t0 = performance.now();
    $('cptStart').disabled = true; $('cptTap').disabled = false; $('cptIv').disabled = true;
    $('cptRes').textContent = ''; $('cptTap').textContent = 'Battement (0)';
    C.timer = setInterval(function () {
      var reste = 10 - (performance.now() - C.t0) / 1000;
      if (reste <= 0) cptFin(); else $('cptTemps').textContent = reste.toFixed(1).replace('.', ',') + ' s';
    }, 100);
  });
  $('cptTap').addEventListener('pointerdown', function () {
    if (!C.actif) return;
    C.taps++; $('cptTap').textContent = 'Battement (' + C.taps + ')';
  });

  // ---------- Écoute au micro ----------
  var MIC = { actif: false, stream: null, src: null, proc: null, buf: null, n: 0, sr: 16000, fac: 1, timer: 0, seul: null, propres: {}, hist: [] };
  var MIC_KS = [3, 4, 5, 7, 8, 9];
  (function () {
    for (var m = PART_MIN; m < PART_MAX; m++) { var o = document.createElement('option'); o.value = m; o.textContent = Bat.nomNote(m); $('micNote').appendChild(o); }
    $('micNote').value = 57;
    MIC_KS.forEach(function (k) { var o = document.createElement('option'); o.value = k; o.textContent = ivDe(k).nom; $('micIv').appendChild(o); });
    $('micIv').value = 4;
  })();
  function micIv() { return ivDe(parseInt($('micIv').value, 10)); }
  function micNote() { return parseInt($('micNote').value, 10); }
  function micCibleAuto() {
    var iv = micIv(), mb = micNote();
    if (mb + iv.k > PART_MAX) { mb = PART_MAX - iv.k; $('micNote').value = mb; }
    $('micCible').value = calcAff(mb, iv).hz.toFixed(1);
    MIC.propres = {};
  }
  ['micNote', 'micIv'].forEach(function (id) { $(id).addEventListener('change', micCibleAuto); });
  $('micCibleAuto').addEventListener('click', micCibleAuto);
  micCibleAuto();

  function micDernieres(T) {
    var n = Math.min(MIC.n, Math.floor(T * MIC.sr)), x = new Float32Array(n), L = MIC.buf.length, fin = MIC.n;
    for (var i = 0; i < n; i++) x[i] = MIC.buf[(fin - n + i) % L];
    return x;
  }
  function micBande(fc) { return Math.max(10, fc * 0.02); }

  function micAnalyse() {
    if (!MIC.actif) return;
    var iv = micIv(), mb = micNote(), r = calcAff(mb, iv), cible = parseFloat($('micCible').value);
    if (!(cible > 0)) cible = r.hz;
    var seul = MIC.seul;
    var T = seul ? 3 : Math.max(1.2, Math.min(6, 3 / cible));
    if (MIC.n < MIC.sr * Math.min(T, 1.2)) { $('micEtat').textContent = 'Écoute…'; return; }
    var x = micDernieres(T), rms = 0;
    for (var i = 0; i < x.length; i++) rms += x[i] * x[i];
    rms = Math.sqrt(rms / x.length);
    if (rms < 0.002) { $('micHz').textContent = '— Hz'; $('micHz').className = 'quiz-hz'; $('micEtat').textContent = 'Trop faible : joue plus fort ou rapproche le téléphone.'; return; }
    if (seul) {
      var note = seul === 1 ? mb : mb + iv.k, n = seul === 1 ? iv.n : iv.m, fc = seul === 1 ? r.p1 : r.p2;
      var a = Mes.analyser(x, MIC.sr, fc, micBande(fc), 0.3, 25), p = a.pics[0];
      var cle = seul;
      if (p && p.prof > 0.15) { MIC.propres[cle] = p.hz; $('micEtat').innerHTML = Bat.nomNote(note) + ' seule : <b>bat à ' + fmt(p.hz) + ' Hz</b> (fausse corde ?). Ce battement sera ignoré.'; }
      else { delete MIC.propres[cle]; $('micEtat').textContent = Bat.nomNote(note) + ' seule : propre, aucun battement.'; }
      $('micHz').textContent = p ? fmt(p.hz) + ' Hz' : '— Hz';
      return;
    }
    var fc2 = (r.p1 + r.p2) / 2, a2 = Mes.analyser(x, MIC.sr, fc2, micBande(fc2), 0.3, 25);
    var propres = Object.keys(MIC.propres).map(function (k) { return MIC.propres[k]; });
    var gardes = [], ignores = [];
    a2.pics.forEach(function (p) {
      var faux = propres.some(function (h) { return Math.abs(h - p.hz) < 0.4; });
      (faux ? ignores : gardes).push(p);
    });
    var pres = gardes.filter(function (p) { return Math.abs(p.hz - cible) <= 0.35 * cible; })[0];
    var autres = a2.pics.filter(function (p) { return p !== pres; }).slice(0, 4).map(function (p) { return fmt(p.hz) + ' Hz'; });
    $('micAutres').textContent = autres.length ? 'Autres ondulations : ' + autres.join(', ') + (ignores.length ? ' (dont fausse corde ignorée)' : '') : '';
    if (!pres) {
      $('micHz').textContent = '— Hz'; $('micHz').className = 'quiz-hz';
      $('micEtat').textContent = a2.pics.length ? 'Pas de battement près de la cible.' : 'Pas de battement net : joue l’intervalle plus fort ou attends un peu.';
      return;
    }
    MIC.hist.push(pres.hz); if (MIC.hist.length > 3) MIC.hist.shift();
    var h = MIC.hist.slice().sort(function (u, v) { return u - v; })[Math.floor(MIC.hist.length / 2)];
    var e = Math.abs(h - cible) / cible, cls = e <= 0.08 ? 'vert' : e <= 0.2 ? 'orange' : 'rouge';
    $('micHz').textContent = fmt(h) + ' Hz';
    $('micHz').className = 'quiz-hz res-' + cls;
    $('micEtat').textContent = (cls === 'vert' ? 'Cible atteinte.' : h > cible ? 'Trop rapide.' : 'Trop lent.') + ' Écart ' + (h > cible ? '+' : '−') + (e * 100).toFixed(0) + ' %.';
  }

  function micStop() {
    clearInterval(MIC.timer); MIC.actif = false; MIC.seul = null;
    try { if (MIC.proc) { MIC.proc.disconnect(); MIC.proc.onaudioprocess = null; } if (MIC.src) MIC.src.disconnect(); } catch (e) {}
    if (MIC.stream) MIC.stream.getTracks().forEach(function (t) { t.stop(); });
    MIC.stream = null;
    $('micStart').textContent = 'Démarrer l’écoute';
  }
  function micDemarre(seul) {
    MIC.seul = seul || null; MIC.hist = []; MIC.n = 0;
    if (MIC.actif) { MIC.n = 0; return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      $('micEtat').textContent = 'Micro indisponible ici. Il fonctionne dans la version Android (APK).'; return;
    }
    arreter();
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }).then(function (st) {
      var a = ctxAudio();
      MIC.stream = st; MIC.fac = Math.max(1, Math.floor(a.sampleRate / 16000)); MIC.sr = a.sampleRate / MIC.fac;
      MIC.buf = new Float32Array(Math.floor(MIC.sr * 8)); MIC.n = 0;
      MIC.src = a.createMediaStreamSource(st);
      MIC.proc = a.createScriptProcessor(4096, 1, 1);
      MIC.proc.onaudioprocess = function (ev) {
        var d = ev.inputBuffer.getChannelData(0), f = MIC.fac, L = MIC.buf.length;
        for (var i = 0; i + f <= d.length; i += f) {
          var s = 0; for (var j = 0; j < f; j++) s += d[i + j];
          MIC.buf[MIC.n % L] = s / f; MIC.n++;
        }
      };
      var mute = a.createGain(); mute.gain.value = 0;
      MIC.src.connect(MIC.proc); MIC.proc.connect(mute); mute.connect(a.destination);
      MIC.actif = true;
      $('micStart').textContent = 'Arrêter l’écoute';
      $('micEtat').textContent = 'Écoute…';
      MIC.timer = setInterval(micAnalyse, 400);
    }, function () {
      $('micEtat').textContent = 'Micro refusé ou indisponible. Dans une page web du navigateur il est bloqué : utilise la version Android.';
    });
  }
  $('micStart').addEventListener('click', function () { if (MIC.actif && !MIC.seul) micStop(); else if (MIC.actif) { MIC.seul = null; MIC.n = 0; $('micEtat').textContent = 'Écoute…'; } else micDemarre(null); });
  $('micSeul1').addEventListener('click', function () { micDemarre(1); MIC.seul = 1; $('micEtat').textContent = 'Joue la note grave seule…'; });
  $('micSeul2').addEventListener('click', function () { micDemarre(2); MIC.seul = 2; $('micEtat').textContent = 'Joue la note aiguë seule…'; });

  // ---------- Événements ----------
  function clic(e) {
    var el = e.target.closest('[data-mb]');
    if (el) jouer(parseInt(el.getAttribute('data-mb'), 10), parseInt(el.getAttribute('data-i'), 10));
  }
  $('liste').addEventListener('click', clic);
  $('tableau').addEventListener('click', clic);
  $('btnStop').addEventListener('click', function () { arreter(); rendre(); });

  function reglage() {
    try { localStorage.setItem('bat.la4', la4()); localStorage.setItem('bat.inh', $('inh').value); } catch (e) {}
    $('inh').disabled = reelOk();
    arreter(); rendre();
    if (!$('vueTest').hidden) exoRafraichir(); else { Q.mb = 0; R.mb = 0; P.sonA = null; }
  }
  ['la4', 'inh', 'selNote', 'selIv', 'mode'].forEach(function (id) { $(id).addEventListener('change', reglage); });

  var VUES = ['Depuis', 'Tempe', 'Test', 'Compte', 'Ecoute'];
  function onglet(nom) {
    VUES.forEach(function (v) {
      $('vue' + v).hidden = v !== nom;
      $('tab' + v).classList.toggle('actif', v === nom);
    });
    arreter();
    if (MIC.actif && nom !== 'Ecoute') micStop();
    if (nom === 'Test') exoOuvre();
  }
  VUES.forEach(function (v) { $('tab' + v).addEventListener('click', function () { onglet(v); }); });

  $('inh').disabled = reelOk();
  if (DATA) chargerReel().catch(function () {});
  rendre();
  if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }
})();
