/**
 * Experimento controlado: por que btBvhTriangleMeshShape falha com o fundo?
 *
 * Testa variacoes da malha do fundo diretamente contra a API do Ammo,
 * isolando uma hipotese por vez. Escreve results/ammo_mesh_experiment.json
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(__dirname);
const RESULTS = path.join(ROOT, "results");

const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", String(e).slice(0, 160)));

// carrega a cena so para ter Ammo e os GLB disponiveis
await page.goto(
  "http://127.0.0.1:8088/index.html?variant=original&physics=off&warmup=0&window=1&nav=off",
  { waitUntil: "load", timeout: 120000 },
);
await page.waitForFunction(() => window.__DONE === true, null, { timeout: 180000 });

const out = await page.evaluate(async () => {
  // Ammo ja foi inicializado pelo sistema de fisica
  const Ammo = window.Ammo;
  const resultados = [];

  function geometriaDe(nome) {
    let g = null;
    document.getElementById("cena").object3D.traverse((o) => {
      if (!o.isMesh) return;
      let p = o;
      while (p) {
        if (p.el && p.el.dataset && p.el.dataset.nome === nome) { g = o.geometry; return; }
        p = p.parent;
      }
    });
    return g;
  }

  function construir(pos, idx, quantizado, rotulo, escala) {
    const t0 = performance.now();
    const triMesh = new Ammo.btTriangleMesh(true, false);
    const a = new Ammo.btVector3(), b = new Ammo.btVector3(), c = new Ammo.btVector3();
    let nTri = 0;
    for (let j = 0; j < idx.length; j += 3) {
      const ai = idx[j] * 3, bi = idx[j + 1] * 3, ci = idx[j + 2] * 3;
      a.setValue(pos[ai], pos[ai + 1], pos[ai + 2]);
      b.setValue(pos[bi], pos[bi + 1], pos[bi + 2]);
      c.setValue(pos[ci], pos[ci + 1], pos[ci + 2]);
      triMesh.addTriangle(a, b, c, false);
      nTri++;
    }
    const tAdd = performance.now() - t0;
    // replica a linha do three-to-ammo que o teste anterior nao cobria
    if (escala) {
      const ls = new Ammo.btVector3(escala[0], escala[1], escala[2]);
      triMesh.setScaling(ls);
      Ammo.destroy(ls);
    }
    let status = "ok", erro = "";
    const t1 = performance.now();
    try {
      // eslint-disable-next-line no-new
      new Ammo.btBvhTriangleMeshShape(triMesh, quantizado, true);
    } catch (e) {
      status = "FALHOU";
      erro = String(e).slice(0, 160);
    }
    const tBvh = performance.now() - t1;
    Ammo.destroy(a); Ammo.destroy(b); Ammo.destroy(c);
    return {
      rotulo, quantizado, escala: escala || null, triangulos: nTri, status, erro,
      ms_add: +tAdd.toFixed(1), ms_bvh: +tBvh.toFixed(1),
    };
  }

  function semDegenerados(pos, idx, eps) {
    const keep = [];
    const ax = new Float64Array(3), bx = new Float64Array(3), cx = new Float64Array(3);
    for (let j = 0; j < idx.length; j += 3) {
      const i0 = idx[j], i1 = idx[j + 1], i2 = idx[j + 2];
      if (i0 === i1 || i1 === i2 || i0 === i2) continue;
      for (let k = 0; k < 3; k++) {
        ax[k] = pos[i0 * 3 + k]; bx[k] = pos[i1 * 3 + k]; cx[k] = pos[i2 * 3 + k];
      }
      // area via produto vetorial
      const ux = bx[0] - ax[0], uy = bx[1] - ax[1], uz = bx[2] - ax[2];
      const vx = cx[0] - ax[0], vy = cx[1] - ax[1], vz = cx[2] - ax[2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      if (0.5 * Math.hypot(nx, ny, nz) < eps) continue;
      keep.push(i0, i1, i2);
    }
    return keep;
  }

  function recortar(pos, idx, limites) {
    // mantem so triangulos cujo centroide cai dentro da caixa da sala
    const keep = [];
    for (let j = 0; j < idx.length; j += 3) {
      let cx = 0, cy = 0, cz = 0;
      for (let k = 0; k < 3; k++) {
        const i = idx[j + k] * 3;
        cx += pos[i]; cy += pos[i + 1]; cz += pos[i + 2];
      }
      cx /= 3; cy /= 3; cz /= 3;
      if (cx >= limites[0] && cx <= limites[3] &&
          cy >= limites[1] && cy <= limites[4] &&
          cz >= limites[2] && cz <= limites[5]) {
        keep.push(idx[j], idx[j + 1], idx[j + 2]);
      }
    }
    return keep;
  }

  const g = geometriaDe("surface_0");
  const pos = g.attributes.position.array;
  const idx = g.index ? Array.from(g.index.array) : (() => {
    const a = []; for (let i = 0; i < g.attributes.position.count; i++) a.push(i); return a;
  })();

  // caixa real da malha
  g.computeBoundingBox();
  const bb = g.boundingBox;
  const info = {
    triangulos: idx.length / 3,
    vertices: g.attributes.position.count,
    aabb_min: [bb.min.x, bb.min.y, bb.min.z].map((v) => +v.toFixed(4)),
    aabb_max: [bb.max.x, bb.max.y, bb.max.z].map((v) => +v.toFixed(4)),
  };

  // H1: malha integral, com compressao quantizada (o que o three-to-ammo faz)
  resultados.push(construir(pos, idx, true, "H1 integral + quantizado"));
  // H2: malha integral, SEM compressao quantizada
  resultados.push(construir(pos, idx, false, "H2 integral + NAO quantizado"));
  // H3: sem triangulos degenerados, quantizado
  const semDeg = semDegenerados(pos, idx, 1e-10);
  resultados.push(
    construir(pos, semDeg, true, `H3 sem degenerados (${(idx.length - semDeg.length) / 3} removidos) + quantizado`),
  );
  // H4: so a sala (recorte da caixa), quantizado
  const sala = recortar(pos, idx, [-4.2, -1.6, -2.6, 4.0, 1.5, 2.4]);
  resultados.push(
    construir(pos, sala, true, `H4 recorte da sala (${sala.length / 3} tri) + quantizado`),
  );
  // H5: metade dos triangulos, quantizado (o numero importa?)
  const metade = idx.slice(0, Math.floor(idx.length / 6) * 3);
  resultados.push(construir(pos, metade, true, `H5 metade (${metade.length / 3} tri) + quantizado`));
  // H6: identica a H1, mas com setScaling(1,1,1) antes de construir -- a unica
  // linha do three-to-ammo que as hipoteses anteriores nao cobriam
  resultados.push(construir(pos, idx, true, "H6 integral + setScaling(1,1,1)", [1, 1, 1]));
  // H7: sem degenerados E com setScaling, para separar as duas variaveis
  resultados.push(
    construir(pos, semDeg, true, "H7 sem degenerados + setScaling(1,1,1)", [1, 1, 1]),
  );

  return { info, resultados };
});

console.log(JSON.stringify(out.info, null, 2));
console.log("\nhipotese                                              quant  tri      status   bvh(ms)  erro");
for (const r of out.resultados) {
  console.log(
    `${r.rotulo.padEnd(52)} ${String(r.quantizado).padEnd(6)} ${String(r.triangulos).padEnd(8)} ` +
    `${r.status.padEnd(8)} ${String(r.ms_bvh).padEnd(8)} ${r.erro}`,
  );
}
fs.writeFileSync(
  path.join(RESULTS, "ammo_mesh_experiment.json"),
  JSON.stringify(out, null, 2),
);
await browser.close();
console.log("\nescrito: results/ammo_mesh_experiment.json");
