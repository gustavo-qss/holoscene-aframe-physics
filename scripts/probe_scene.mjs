/** Sonda de diagnostico: por que o fundo nao aparece? Tira fotos em 4 direcoes. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(__dirname);
const OUT = path.join(ROOT, "results", "diagnostico");
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", String(e).slice(0, 200)));

await page.goto(
  "http://127.0.0.1:8088/index.html?variant=original&physics=off&warmup=0&window=1&nav=off",
  { waitUntil: "load", timeout: 120000 },
);
await page.waitForFunction(() => window.__DONE === true, null, { timeout: 180000 });

const info = await page.evaluate(() => {
  const sceneEl = document.getElementById("cena");
  const cam = sceneEl.camera;
  const out = { camera: {}, malhas: [] };
  cam.getWorldPosition(new THREE.Vector3());
  out.camera = {
    pos: cam.getWorldPosition(new THREE.Vector3()).toArray().map((v) => +v.toFixed(3)),
    near: cam.near, far: cam.far, fov: cam.fov,
  };
  const frustum = new THREE.Frustum();
  frustum.setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse),
  );
  sceneEl.object3D.traverse((o) => {
    if (!o.isMesh) return;
    let nome = "?";
    let p = o;
    while (p) { if (p.el && p.el.dataset && p.el.dataset.nome) { nome = p.el.dataset.nome; break; } p = p.parent; }
    const bs = o.geometry.boundingSphere
      || (o.geometry.computeBoundingSphere(), o.geometry.boundingSphere);
    const wp = o.getWorldPosition(new THREE.Vector3());
    out.malhas.push({
      nome,
      visible: o.visible,
      frustumCulled: o.frustumCulled,
      noFrustum: frustum.intersectsObject(o),
      side: o.material && o.material.side,
      transparent: o.material && o.material.transparent,
      opacity: o.material && o.material.opacity,
      temMapa: !!(o.material && o.material.map),
      raio: +bs.radius.toFixed(3),
      posMundo: wp.toArray().map((v) => +v.toFixed(2)),
      tris: o.geometry.index ? o.geometry.index.count / 3 : o.geometry.attributes.position.count / 3,
    });
  });
  out.sideConstants = { FrontSide: THREE.FrontSide, BackSide: THREE.BackSide, DoubleSide: THREE.DoubleSide };
  return out;
});

console.log(JSON.stringify(info.camera, null, 2));
console.log("constantes side:", JSON.stringify(info.sideConstants));
console.log("\nnome        vis  culled  noFrustum  side  mapa  raio    tris     posMundo");
for (const m of info.malhas) {
  console.log(
    `${m.nome.padEnd(11)} ${String(m.visible).padEnd(5)} ${String(m.frustumCulled).padEnd(6)} ` +
    `${String(m.noFrustum).padEnd(10)} ${String(m.side).padEnd(5)} ${String(m.temMapa).padEnd(5)} ` +
    `${String(m.raio).padEnd(8)} ${String(m.tris).padEnd(8)} ${m.posMundo.join(",")}`,
  );
}
fs.writeFileSync(path.join(OUT, "probe_scene.json"), JSON.stringify(info, null, 2));

// fotos em 4 direcoes a partir da posicao da camera
for (const yaw of [0, -90, 180, 90]) {
  await page.evaluate((y) => {
    const cam = document.getElementById("cena").camera;
    cam.el.setAttribute("rotation", `0 ${y} 0`);
  }, yaw);
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, `vista_yaw_${yaw}.png`) });
}
// uma vista de cima, de fora da sala
await page.evaluate(() => {
  const cam = document.getElementById("cena").camera;
  cam.el.setAttribute("position", "0 6 0");
  cam.el.setAttribute("rotation", "-90 0 0");
});
await page.waitForTimeout(800);
await page.screenshot({ path: path.join(OUT, "vista_topo.png") });

await browser.close();
console.log("\nfotos em results/diagnostico/");
