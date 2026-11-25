# Accordeur Pro — contexte du projet

À lire en premier par toute nouvelle session de travail.

## Qui et quoi
- Utilisateur : Thomas, accordeur-technicien de piano professionnel. Réponses en français, courtes, directes, honnêtes ; contredire quand c'est justifié.
- But : une appli d'accordage professionnelle (PWA puis Android + iOS via Capacitor) plus moderne et plus fiable que Yamaha PT-A1, TuneLab, etc.
- Usage pour l'instant personnel ; diffusion large plus tard si convaincant. Anglais à terme.
- Téléphones de test : Google Pixel et iPhone 11. Micro du Pixel vérifié : echoCancellation, noiseSuppression, autoGainControl = false.
- Ne pas utiliser les noms « Yamaha » ni « PT-A1 » dans l'appli (marques déposées).

## Façon d'accorder de Thomas
- Bande de feutre sur tout le piano, une seule corde mesurée par note, accord de la note 1 à 88.
- L'appli sert à accorder la référence de chaque note ; les unissons se font à l'oreille.
- Tempérament égal uniquement pour l'instant.
- Dans les aigus, il accorde sur l'attaque : il faut une lecture rapide, pas forcément au centième.
- Problèmes du PT-A1 : détection de note lente, et prend souvent l'octave au lieu de la fondamentale.

## Déjà fait (étape 1 et suite)
- Vite + React + TypeScript + Tailwind, code dans `accordeur-pro/` ; version compilée dans `docs/accordeur/`, en ligne : https://chopnov.github.io/Battements-piano/accordeur/
- `src/dsp/` : FFT, Blackman-Harris, zero-padding ×4, pics paraboliques, plancher de bruit dynamique, détection d'attaque (RMS 5 ms), 40 ms de marteau ignorées, cohérence harmonique, gel de la mesure, ajustement de Fletcher f_k = k·f0·√(1+B·k²) sans dépendre de k=1, fusion des fenêtres.
- `tuningCurve.ts` : calibration 7 notes (A0, F1, D2, C3, A3, F4, C5), courbe B(n) avec rupture filé/acier, cibles par moindres carrés (octaves 2:1, 4:2, 6:3, quintes, douzièmes), presets Doux / Standard / Concert. Pas encore branché dans l'interface.
- Détection automatique de la note (hypothèses f0, f0/2, 2f0) et cadran ±50 cents (`src/ui/dial.ts`).
- 33 tests automatisés (`npm test`) ; précision vérifiée seulement sur signaux synthétiques, pas encore sur vrais pianos.

## Étape 2 — fait le 2026-11-25 (points 1, 2, 5)
- `src/dsp/noteTracker.ts` : détection qui suit la séquence. Recherche guidée dans c±2,5 demi-tons (pas d'octave possible), détection libre seulement pour repérer les grands sauts (2 frappes concordantes, 3 si octave/douzième/double octave). Glissement (note précédente juste + écart > 15 ct dans le sens d'accord → touche suivante), continuité (note pas encore juste qui franchit ±50 ct → même touche), sens appris, cadenas, flèches ◀ ▶ (cadenas + flèches = mode manuel).
- Fenêtre selon le registre : 16384 (< A2), 8192 (A2–D♯4), 4096 (≥ E4), pas = fenêtre/8.
- `src/dsp/recorder.ts` : bouton ⏺ Enregistrer → WAV 24 bits mono + journal JSON (note, cents, f0, B, σ, première lecture en ms, corrections, sauts en attente, réglages).
- Corrigé : la moyenne servant à détecter les attaques portait sur 0,5 s au lieu de 20 ms (fausses « nouvelles frappes » pendant 150 ms, lecture retardée). Plancher de bruit spectral recalculé sans tri (calcul ~8× plus léger).
- Test `sequence.test.ts` : accord 1→88 simulé (264 frappes, zone à remonter de 40–70 ct, 30 % de notes à fondamentale faible) : 0 erreur de touche ; première lecture graves ≤ 425 ms, médium ≤ 215 ms, aigus ≤ 140 ms (synthétique). Essai navigateur avec micro simulé OK.
- Reste à faire : valider sur vrai piano avec les enregistrements ; analyse dans un Worker si le téléphone peine.

## Étape 2 (validée par Thomas, plan d'origine)
1. Détection de note intelligente qui connaît la séquence (même note ou suivante probables, grands sauts acceptés seulement après 2–3 frappes concordantes, sens appris, correction par glissement ±1 demi-ton, cadenas, mode manuel). Objectif : zéro erreur d'octave sur un accord 1→88, première lecture < 250 ms dans les aigus, < 600 ms dans les graves.
2. Fenêtre d'analyse adaptée au registre (≈16384 échantillons graves, ≈4096 aigus).
3. Plusieurs affichages à comparer : cadran à aiguille physique (ressort amorti), stroboscope ; état « juste » net avec hystérésis, vibration, son optionnel ; couleurs lisibles par les daltoniens ; mode sombre / plein soleil ; écran maintenu allumé. Thomas choisira à la fin.
4. Réglages : diapason 410–470 Hz, décalage global et par note en cents, tolérance, cibles d'étirement issues de la calibration.
5. Bouton « Enregistrer » : WAV brut 48 kHz + journal (note, cents, B, corrections) pour valider sur de vrais pianos. Thomas peut faire autant de mesures que nécessaire, y compris des accords complets.
6. Robustesse : jauge de niveau, alertes saturation et bruit, repli 44,1 kHz, hors ligne.
7. Architecture prête pour Capacitor, module audio natif possible sur iOS.

Ordre conseillé : enregistrement + détection intelligente d'abord, affichages ensuite.

## Nouvelle demande : page « Battements de la partition »
- Vitesse théorique des tierces, quartes, quintes et sixtes de la partition, avec écoute. Repère auditif pour apprendre le métier.
- Réutiliser le travail de Battements Piano (même dépôt, `src/battements.js`, sons réels `docs/piano/`, `data/reel.json`).
- Idée : afficher aussi les battements calculés pour le piano calibré (avec son inharmonicité), pas seulement la théorie.
- À demander : ordre exact des notes de sa partition (Fa3–Fa4, partition Yamaha).

## Dépôt
- GitHub : Chopnov/Battements-piano (public), Pages sur main /docs.
- `tools/build.js` assemble Battements Piano dans `docs/index.html`.
- Accordeur : `cd accordeur-pro && npm install && npm test && npm run build`, puis copier `dist/` dans `docs/accordeur/`.

## Base d'accords réels (2026-11-25, branche `claude/project-thread-1mm59z`, au-dessus de l'étape 2)
- Thomas enregistre ses accords (pianos Yamaha uniquement) pour valider le moteur sur vrais pianos. Accordeur Pro enregistre sur un téléphone pendant qu'il accorde au PTA-1 sur l'autre.
- `src/seance/` : séance stockée au fil de l'eau dans IndexedDB (blocs de 10 s, WAV 16 bits, ≈ 350 Mo/h, récupérable après plantage), écran maintenu allumé, Pause (conversation, unissons), marque « passe de contrôle », test d'intervalle (bas seul / haut seul / ensemble + verdict juste/large/étroite et paire 2:1/4:2/6:3), fiche du piano (modèle, n° de série, taille, La4, réglage de l'accordeur, position du téléphone, relevé facultatif note par note), envoi WAV + JSON par la feuille de partage (Drive) ou téléchargement.
- `Recorder` : options `bits` (16/24) et `onChunk` ; pause/reprise gardent le journal calé sur le WAV. Comportement par défaut de l'étape 2 inchangé.
- Point clé d'analyse : comme Thomas amène chaque note au zéro du PTA-1, la hauteur finale de chaque note dans l'enregistrement donne la courbe d'étirement du PTA-1 sur ce piano, sans rien recopier.
- Fichiers attendus dans un dossier Drive « Accordeur Pro – séances ». Analyse hors ligne (rejouer le WAV dans AudioProcessor, comparer) à écrire à l'arrivée des premières séances.
