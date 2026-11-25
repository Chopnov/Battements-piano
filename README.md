# Battements Piano

Aide à l'accordage du piano par les battements (tempérament égal, partition Yamaha Fa3–Fa4).

- Vitesses de battement des intervalles, mesurées sur un piano enregistré (Yamaha C5) ou calculées
- Exercices d'oreille : deviner une tierce, comparer deux battements, juger une note, contrôle d'octave m3/M6, régler soi-même une vitesse
- Onglet Écoute : mesure au micro la vitesse de battement réelle d'un intervalle, détecte une fausse corde

## Utiliser
Page web : https://chopnov.github.io/Battements-piano/ (Chrome Android → menu → Ajouter à l'écran d'accueil).

## Développer
- `src/` : code (battements.js, mesure.js, app.js, page.template.html) ; `data/reel.json` : partiels mesurés
- `node tools/build.js` produit `docs/index.html` (page unique servie par GitHub Pages) ; `npm test` lance les tests
- `docs/piano/` : enregistrements, Salamander Grand Piano (Yamaha C5), Alexander Holm, CC BY 3.0
- APK Android (facultatif) : onglet Actions → « Compiler l'APK »

## Accordeur Pro (moteur DSP, étape 1)
- Application : https://chopnov.github.io/Battements-piano/accordeur/
- Code : `accordeur-pro/` (Vite + React + TypeScript + Tailwind ; `npm test`, `npx vite build --base=./`, copier `dist/` dans `docs/accordeur/`)
