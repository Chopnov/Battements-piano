/* Théorie des battements en tempérament égal.
 *
 * Deux notes f1 (grave) et f2 (aiguë) forment un intervalle de k demi-tons : f2 = f1 * 2^(k/12).
 * Si le rapport pur est n/m, le partiel n de la note grave coïncide presque avec le
 * partiel m de la note aiguë. Leur écart est la vitesse de battement : |n*f1 - m*f2|.
 * Avec inharmonicité : fréquence du partiel h = h * f * sqrt(1 + B*h²).
 */
(function (root) {
  var NOMS = ['Do', 'Do♯', 'Ré', 'Ré♯', 'Mi', 'Fa', 'Fa♯', 'Sol', 'Sol♯', 'La', 'La♯', 'Si'];

  // n:m = partiel de la note grave : partiel de la note aiguë qui coïncident
  var INTERVALLES = [
    { k: 1,  nom: 'Seconde mineure',  n: 16, m: 15 },
    { k: 2,  nom: 'Seconde majeure',  n: 9,  m: 8  },
    { k: 3,  nom: 'Tierce mineure',   n: 6,  m: 5  },
    { k: 4,  nom: 'Tierce majeure',   n: 5,  m: 4  },
    { k: 5,  nom: 'Quarte juste',     n: 4,  m: 3  },
    { k: 6,  nom: 'Triton',           n: 7,  m: 5  },
    { k: 7,  nom: 'Quinte juste',     n: 3,  m: 2  },
    { k: 8,  nom: 'Sixte mineure',    n: 8,  m: 5  },
    { k: 9,  nom: 'Sixte majeure',    n: 5,  m: 3  },
    { k: 10, nom: 'Septième mineure', n: 16, m: 9  },
    { k: 11, nom: 'Septième majeure', n: 15, m: 8  },
    { k: 12, nom: 'Octave',           n: 2,  m: 1  }
  ];

  function freq(midi, la4) { return la4 * Math.pow(2, (midi - 69) / 12); }
  function nomNote(midi) { return NOMS[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1); }
  function partiel(f, h, B) { return f * h * Math.sqrt(1 + (B || 0) * h * h); }

  function calc(midiBas, iv, la4, B) {
    var f1 = freq(midiBas, la4), f2 = freq(midiBas + iv.k, la4);
    var p1 = partiel(f1, iv.n, B), p2 = partiel(f2, iv.m, B);
    var d = p1 - p2;
    return {
      f1: f1, f2: f2, p1: p1, p2: p2,
      hz: Math.abs(d),
      // d > 0 : la note aiguë est plus basse que le rapport pur -> intervalle étroit
      sens: Math.abs(d) < 0.0005 ? 'juste' : (d > 0 ? 'étroit' : 'large'),
      cents: 1200 * Math.log2((f2 / f1) / (iv.n / iv.m))
    };
  }

  // Battement (Hz) d'un intervalle, la note haute décalée de dc cents
  function battement(midiBas, iv, la4, B, dc) {
    var f1 = freq(midiBas, la4), f2 = freq(midiBas + iv.k, la4) * Math.pow(2, (dc || 0) / 1200);
    return Math.abs(partiel(f1, iv.n, B) - partiel(f2, iv.m, B));
  }

  // Contrôle d'octave : tierce mineure du bas (X, X+3) contre sixte majeure du haut (X+3, X+12).
  // Quand la tierce est étroite et la sixte large (cas normal), battements égaux <=> 6e partiel de X
  // = 3e partiel de X+12 (octave 6:3 pure). Renvoie le décalage (cents) de la note haute qui réalise cette égalité.
  function octaveEgale(mb, la4, B) {
    var fX = freq(mb, la4), fY = freq(mb + 3, la4), fT = freq(mb + 12, la4);
    var dm3 = Math.abs(partiel(fX, 6, B) - partiel(fY, 5, B));
    var p5 = partiel(fY, 5, B);
    var s = (p5 - partiel(fT, 3, B)) < 0 ? -1 : 1;
    var cible = p5 - s * dm3;
    return 1200 * Math.log2(cible / partiel(fT, 3, B));
  }

  // Note de piano (modèle) : synthèse additive.
  // Partiels étirés par l'inharmonicité, amplitudes fixées par le point de frappe du marteau
  // (un partiel est quasi absent si la frappe tombe sur son nœud), décroissance plus rapide pour les aigus.
  // a : AudioContext ou OfflineAudioContext. Renvoie les oscillateurs créés.
  function piano(a, dest, f0, B, t0, opts) {
    opts = opts || {};
    var x = opts.frappe || 1 / 8.3, tau1 = opts.tau || 9, dur = opts.dur || 8, vol = opts.vol || 0.1;
    var oscs = [];
    for (var n = 1; n <= 24; n++) {
      var f = partiel(f0, n, B);
      if (f > 14000) break;
      var amp = vol * Math.pow(n, -0.6) * Math.abs(Math.sin(Math.PI * n * x)) / (1 + Math.pow(n / 14, 2));
      if (opts.faible && opts.faible.n === n) amp *= opts.faible.gain;
      var tau = tau1 / (1 + 0.35 * (n - 1));
      var o = a.createOscillator(), g = a.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(amp, t0 + 0.004);
      g.gain.setTargetAtTime(0, t0 + 0.004, tau);
      g.gain.setTargetAtTime(0, t0 + dur - 0.15, 0.03);
      o.connect(g); g.connect(dest);
      o.start(t0); o.stop(t0 + dur);
      oscs.push(o);
    }
    return oscs;
  }

  // Piano enregistré : partiels mesurés sur des enregistrements (data.samples[note] = {f0, B, g, f[16]}).
  // Une note jouée = l'échantillon le plus proche, accéléré/ralenti de rapport r (au plus 1 demi-ton).
  function reel(data, la4) {
    var cles = Object.keys(data.samples).map(Number);
    function proche(note) {
      var b = cles[0];
      cles.forEach(function (k) { if (Math.abs(k - note) < Math.abs(b - note)) b = k; });
      return b;
    }
    function rapport(note) { return freq(note, la4) / data.samples[proche(note)].f0; }
    function part(note, n) { return rapport(note) * data.samples[proche(note)].f[n - 1]; }
    function bat(mb, iv, dc) { return Math.abs(part(mb, iv.n) - part(mb + iv.k, iv.m) * Math.pow(2, (dc || 0) / 1200)); }
    function calcS(mb, iv) {
      var f1 = freq(mb, la4), f2 = freq(mb + iv.k, la4), p1 = part(mb, iv.n), p2 = part(mb + iv.k, iv.m), d = p1 - p2;
      return { f1: f1, f2: f2, p1: p1, p2: p2, hz: Math.abs(d),
        sens: Math.abs(d) < 0.0005 ? 'juste' : (d > 0 ? 'étroit' : 'large'),
        cents: 1200 * Math.log2((f2 / f1) / (iv.n / iv.m)) };
    }
    function octave(mb) {
      var p6 = part(mb, 6), p5 = part(mb + 3, 5), p3 = part(mb + 12, 3);
      var dm3 = Math.abs(p6 - p5), s = (p5 - p3) < 0 ? -1 : 1;
      return 1200 * Math.log2((p5 - s * dm3) / p3);
    }
    return { proche: proche, rapport: rapport, partiel: part, battement: bat, calc: calcS, octaveEgale: octave,
      gain: function (note) { return data.samples[proche(note)].g; } };
  }

  // Joue un échantillon décodé. opts : dur, gain, faible {freq, db} (creux étroit sur un partiel).
  function echantillon(a, buf, dest, rate, t0, opts) {
    opts = opts || {};
    var dur = opts.dur || 8, s = a.createBufferSource(), g = a.createGain(), nd = s;
    s.buffer = buf; s.playbackRate.value = rate;
    g.gain.setValueAtTime(opts.gain || 1, t0);
    g.gain.setTargetAtTime(0, t0 + dur - 0.2, 0.06);
    if (opts.faible) {
      var q = a.createBiquadFilter();
      q.type = 'peaking'; q.frequency.value = opts.faible.freq; q.Q.value = 50; q.gain.value = -opts.faible.db;
      s.connect(q); nd = q;
    }
    nd.connect(g); g.connect(dest);
    s.start(t0); s.stop(t0 + dur);
    return [s];
  }

  var api = { reel: reel, echantillon: echantillon, battement: battement, octaveEgale: octaveEgale, piano: piano, NOMS: NOMS, INTERVALLES: INTERVALLES, freq: freq, nomNote: nomNote, partiel: partiel, calc: calc };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Bat = api;
})(typeof self !== 'undefined' ? self : this);
