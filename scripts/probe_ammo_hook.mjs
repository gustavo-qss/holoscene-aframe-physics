/**
 * Intercepta as chamadas reais do three-to-ammo ao Ammo para descobrir que
 * dados chegam ao construtor de btBvhTriangleMeshShape quando ele falha.
 * Escreve results/ammo_hook.json
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(path.dirname(__dirname), "results");

const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });

// instala o gancho antes de qualquer script da pagina rodar
await page.addInitScript(() => {
  window.__HOOK = { chamadas: [], instalado: false };
  const tentar = () => {
    const A = window.Ammo;
    if (!A || typeof A.btTriangleMesh !== "function" || window.__HOOK.instalado) return;
    window.__HOOK.instalado = true;

    const OrigMesh = A.btTriangleMesh;
    const OrigBvh = A.btBvhTriangleMeshShape;

    A.btTriangleMesh = function (a, b) {
      const inst = new OrigMesh(a, b);
      const reg = {
        args: [a, b], nTri: 0,
        min: [Infinity, Infinity, Infinity],
        max: [-Infinity, -Infinity, -Infinity],
        naoFinitos: 0, escala: null,
      };
      inst.__reg = reg;
      window.__HOOK.chamadas.push(reg);

      const addOrig = inst.addTriangle.bind(inst);
      inst.addTriangle = function (p, q, r, dedup) {
        for (const v of [p, q, r]) {
          const x = v.x(), y = v.y(), z = v.z();
          if (!isFinite(x) || !isFinite(y) || !isFinite(z)) reg.naoFinitos++;
          else {
            if (x < reg.min[0]) reg.min[0] = x;
            if (y < reg.min[1]) reg.min[1] = y;
            if (z < reg.min[2]) reg.min[2] = z;
            if (x > reg.max[0]) reg.max[0] = x;
            if (y > reg.max[1]) reg.max[1] = y;
            if (z > reg.max[2]) reg.max[2] = z;
          }
        }
        reg.nTri++;
        return addOrig(p, q, r, dedup);
      };
      const scaleOrig = inst.setScaling.bind(inst);
      inst.setScaling = function (v) {
        reg.escala = [v.x(), v.y(), v.z()];
        return scaleOrig(v);
      };
      return inst;
    };

    A.btBvhTriangleMeshShape = function (mesh, quant, build) {
      const reg = mesh && mesh.__reg;
      if (reg) { reg.quantizado = quant; reg.buildBvh = build; }
      try {
        const s = new OrigBvh(mesh, quant, build);
        if (reg) reg.resultado = "ok";
        return s;
      } catch (e) {
        if (reg) reg.resultado = "FALHOU: " + String(e).slice(0, 120);
        throw e;
      }
    };
  };
  const iv = setInterval(() => { tentar(); if (window.__HOOK.instalado) clearInterval(iv); }, 5);
  setTimeout(() => clearInterval(iv), 60000);
});

const errs = [];
page.on("pageerror", (e) => errs.push(String(e).split("\n")[0]));

await page.goto(
  "http://127.0.0.1:8088/index.html?variant=original&physics=on&warmup=0&window=2&nav=off&only=bg",
  { waitUntil: "load", timeout: 120000 },
);
await page.waitForFunction(() => window.__DONE === true, null, { timeout: 240000 });

const hook = await page.evaluate(() => window.__HOOK);
console.log("gancho instalado:", hook.instalado);
console.log("chamadas a btTriangleMesh:", hook.chamadas.length);
for (const [i, c] of hook.chamadas.entries()) {
  const dim = c.max.map((v, k) => +(v - c.min[k]).toFixed(4));
  console.log(
    `  [${i}] args=${JSON.stringify(c.args)} tri=${c.nTri} naoFinitos=${c.naoFinitos}\n` +
      `      min=${c.min.map((v) => +v.toFixed(4))}  max=${c.max.map((v) => +v.toFixed(4))}\n` +
      `      dims=${dim}  escala=${JSON.stringify(c.escala)}  quant=${c.quantizado}\n` +
      `      resultado=${c.resultado}`,
  );
}
console.log("\nerros observados:", errs.length ? errs.join(" | ") : "nenhum");

fs.writeFileSync(
  path.join(RESULTS, "ammo_hook.json"),
  JSON.stringify({ chamadas: hook.chamadas, erros: errs }, null, 2),
);
await browser.close();
