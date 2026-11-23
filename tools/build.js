// Assemble la page unique docs/index.html à partir de src/ (lancer : node tools/build.js)
const fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..'), r = f => fs.readFileSync(path.join(R, f), 'utf8');
const app = r('src/app.js').split('\n');
const i = app.findIndex(l => l.includes("'serviceWorker' in navigator"));
if (i >= 0) app.splice(i, 3);
const data = JSON.stringify(JSON.parse(r('data/reel.json')));
const t = r('src/page.template.html')
  .replace('/*MES*/', () => r('src/mesure.js')).replace('/*DATA*/null', () => data)
  .replace('/*BAT*/', () => r('src/battements.js')).replace('/*APP*/', () => app.join('\n'));
fs.writeFileSync(path.join(R, 'docs/index.html'), t);
console.log('docs/index.html', t.length, 'octets');
