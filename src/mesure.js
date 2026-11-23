/* Mesure de battements dans un signal audio (micro ou fichier).
 * On isole la bande autour des deux partiels qui battent, on prend l'enveloppe du signal,
 * et on cherche à quelle vitesse elle ondule. Plusieurs ondulations peuvent coexister
 * (fausse corde, autre coïncidence de partiels) : on les renvoie toutes.
 */
(function (root) {
  function pow2(n) { var p = 1; while (p < n) p <<= 1; return p; }

  // FFT complexe sur place (tailles puissances de 2). inv = true : transformée inverse (non normalisée).
  function fft(re, im, inv) {
    var n = re.length, i, j, k, t;
    for (i = 1, j = 0; i < n; i++) {
      var bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (var len = 2; len <= n; len <<= 1) {
      var ang = 2 * Math.PI / len * (inv ? 1 : -1), wr = Math.cos(ang), wi = Math.sin(ang), h = len >> 1;
      for (i = 0; i < n; i += len) {
        var cr = 1, ci = 0;
        for (k = 0; k < h; k++) {
          var a = i + k, b = a + h;
          var xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
          var nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
        }
      }
    }
  }

  // Enveloppe de x dans la bande [f1, f2] Hz
  function enveloppe(x, sr, f1, f2) {
    var N = pow2(x.length), re = new Float64Array(N), im = new Float64Array(N), i;
    var taper = Math.floor(x.length * 0.05);
    for (i = 0; i < x.length; i++) {
      var w = i < taper ? 0.5 - 0.5 * Math.cos(Math.PI * i / taper) : (i >= x.length - taper ? 0.5 - 0.5 * Math.cos(Math.PI * (x.length - 1 - i) / taper) : 1);
      re[i] = x[i] * w;
    }
    fft(re, im, false);
    var b1 = Math.max(1, Math.floor(f1 / sr * N)), b2 = Math.min(N / 2 - 1, Math.ceil(f2 / sr * N));
    for (i = 0; i < N; i++) {
      if (i >= b1 && i <= b2) { re[i] *= 2; im[i] *= 2; } else { re[i] = 0; im[i] = 0; }
    }
    fft(re, im, true);
    var e = new Float64Array(x.length);
    for (i = 0; i < x.length; i++) e[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]) / N;
    return e;
  }

  // Retire une tendance polynomiale de degré 2 (décroissance de la note), renvoie l'ondulation relative
  function ondulation(e, couper) {
    var n = e.length, a = Math.floor(n * couper), b = n - a, m = b - a, i;
    // moindres carrés degré 2 sur t in [-1,1]
    var S = [0, 0, 0, 0, 0], T = [0, 0, 0];
    for (i = a; i < b; i++) {
      var t = 2 * (i - a) / (m - 1) - 1, p = 1;
      for (var k = 0; k < 5; k++) { S[k] += p; if (k < 3) T[k] += p * e[i]; p *= t; }
    }
    // résoudre 3x3
    var A = [[S[0], S[1], S[2], T[0]], [S[1], S[2], S[3], T[1]], [S[2], S[3], S[4], T[2]]];
    for (var c = 0; c < 3; c++) {
      var piv = c; for (i = c + 1; i < 3; i++) if (Math.abs(A[i][c]) > Math.abs(A[piv][c])) piv = i;
      var tmp = A[c]; A[c] = A[piv]; A[piv] = tmp;
      for (i = c + 1; i < 3; i++) { var f = A[i][c] / A[c][c]; for (var j = c; j < 4; j++) A[i][j] -= f * A[c][j]; }
    }
    var co = [0, 0, 0];
    for (i = 2; i >= 0; i--) { var s = A[i][3]; for (var j2 = i + 1; j2 < 3; j2++) s -= A[i][j2] * co[j2]; co[i] = s / A[i][i]; }
    var r = new Float64Array(m);
    for (i = 0; i < m; i++) {
      var tt = 2 * i / (m - 1) - 1, base = co[0] + co[1] * tt + co[2] * tt * tt;
      r[i] = base > 1e-12 ? (e[a + i] - base) / base : 0;
    }
    return r;
  }

  // Pics de modulation (Hz) de r (échantillonné à sr). Renvoie [{hz, prof}] triés par profondeur décroissante.
  // prof = profondeur relative de l'ondulation (0 à 1, 1 = battement qui s'annule complètement).
  function pics(r, sr, fmin, fmax) {
    var m = r.length, N = pow2(m * 8), re = new Float64Array(N), im = new Float64Array(N), i, somme = 0;
    for (i = 0; i < m; i++) { var w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (m - 1)); re[i] = r[i] * w; somme += w; }
    fft(re, im, false);
    var df = sr / N, k1 = Math.max(1, Math.ceil(fmin / df)), k2 = Math.min(N / 2 - 2, Math.floor(fmax / df));
    var mag = new Float64Array(N / 2);
    for (i = 0; i < N / 2; i++) mag[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]) * 2 / somme;
    var out = [];
    for (i = Math.max(2, k1); i <= k2; i++) {
      if (mag[i] > mag[i - 1] && mag[i] >= mag[i + 1]) {
        var y0 = mag[i - 1], y1 = mag[i], y2 = mag[i + 1], d = (y0 - 2 * y1 + y2), p = d ? 0.5 * (y0 - y2) / d : 0;
        out.push({ hz: (i + p) * df, prof: y1 });
      }
    }
    out.sort(function (a, b) { return b.prof - a.prof; });
    return out;
  }

  // Analyse d'un signal x autour de fc (Hz) : bande fc ± larg.
  // Renvoie {pics:[{hz,prof}], bruit}. fmin/fmax : plage de vitesses cherchées.
  function analyser(x, sr, fc, larg, fmin, fmax) {
    var env = enveloppe(x, sr, fc - larg, fc + larg);
    var rate = sr; // l'enveloppe garde la cadence d'origine ; on sous-échantillonne pour alléger
    var pas = Math.max(1, Math.floor(sr / 400)), ed = new Float64Array(Math.floor(env.length / pas)), i, j;
    for (i = 0; i < ed.length; i++) { var s = 0; for (j = 0; j < pas; j++) s += env[i * pas + j]; ed[i] = s / pas; }
    var r = ondulation(ed, 0.04), sr2 = sr / pas;
    var p = pics(r, sr2, fmin || 0.3, fmax || 25);
    var mx = p.length ? p[0].prof : 0;
    return { pics: p.filter(function (q) { return q.prof >= 0.25 * mx && q.prof > 0.04; }), duree: x.length / sr, niveau: mx };
  }

  var api = { analyser: analyser, enveloppe: enveloppe, ondulation: ondulation, pics: pics, fft: fft };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Mes = api;
})(typeof self !== 'undefined' ? self : this);
