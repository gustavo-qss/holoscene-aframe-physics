/** Confirma se os atributos de vertice dos GLB chegam interleaved ao three.js. */
import { chromium } from "playwright-core";

const browser = await chromium.launch({ channel: "chrome", headless: false });
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
await page.goto(
  "http://127.0.0.1:8088/index.html?variant=original&physics=off&warmup=0&window=1&nav=off",
  { waitUntil: "load", timeout: 120000 },
);
await page.waitForFunction(() => window.__DONE === true, null, { timeout: 180000 });

const r = await page.evaluate(() => {
  const out = [];
  document.getElementById("cena").object3D.traverse((o) => {
    if (!o.isMesh) return;
    let p = o, nome = "?";
    while (p) { if (p.el && p.el.dataset && p.el.dataset.nome) { nome = p.el.dataset.nome; break; } p = p.parent; }
    const a = o.geometry.attributes.position;
    out.push({
      nome,
      interleaved: !!a.isInterleavedBufferAttribute,
      count: a.count,
      itemSize: a.itemSize,
      arrayLen: a.array ? a.array.length : (a.data ? a.data.array.length : -1),
      stride: a.data ? a.data.stride : null,
      offset: a.offset !== undefined ? a.offset : null,
      indexado: !!o.geometry.index,
      nIndices: o.geometry.index ? o.geometry.index.count : 0,
      maxIndice: o.geometry.index
        ? Math.max.apply(null, Array.from(o.geometry.index.array.slice(0, 3000)))
        : null,
    });
  });
  return out;
});

console.log("nome         interleaved count    arrayLen  stride indexado nIdx     maxIdx(parcial)");
for (const m of r) {
  console.log(
    `${m.nome.padEnd(12)} ${String(m.interleaved).padEnd(11)} ${String(m.count).padEnd(8)} ` +
    `${String(m.arrayLen).padEnd(9)} ${String(m.stride).padEnd(6)} ${String(m.indexado).padEnd(8)} ` +
    `${String(m.nIndices).padEnd(8)} ${m.maxIndice}`,
  );
}
const n = r.filter((m) => m.interleaved).length;
console.log(`\n${n}/${r.length} malhas com atributos interleaved`);
await browser.close();
