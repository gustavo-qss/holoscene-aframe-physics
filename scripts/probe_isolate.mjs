/** Isola qual entidade dispara o RuntimeError do Ammo. */
import { chromium } from "playwright-core";

const browser = await chromium.launch({ channel: "chrome", headless: false });

for (const only of ["bg", "objects", "all"]) {
  for (const variant of ["original", "optimized"]) {
    const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
    const errs = [];
    page.on("pageerror", (e) => errs.push(String(e).split("\n")[0].slice(0, 90)));
    const url =
      `http://127.0.0.1:8088/index.html?variant=${variant}&physics=on` +
      `&warmup=0&window=2&nav=off&only=${only}`;
    await page.goto(url, { waitUntil: "load", timeout: 120000 });
    await page.waitForFunction(() => window.__DONE === true, null, { timeout: 240000 });
    const r = await page.evaluate(() => ({
      modelos: window.__RESULT.n_modelos_carregados,
      corpos: window.__RESULT.n_corpos_criados,
      esperados: window.__RESULT.n_corpos_esperados,
      colisorFundo: window.__RESULT.t_colisor_fundo_ms,
      colisorMax: window.__RESULT.t_colisor_max_ms,
      desloc: window.__RESULT.desloc_mediano_m,
      deslocMax: window.__RESULT.desloc_max_m,
    }));
    console.log(
      `only=${only.padEnd(8)} ${variant.padEnd(10)} modelos ${r.modelos} ` +
        `corpos ${r.corpos}/${r.esperados} colisorFundo ${r.colisorFundo ?? "-"}ms ` +
        `colisorMax ${r.colisorMax ?? "-"}ms desloc ${r.desloc ?? "-"}/${r.deslocMax ?? "-"} m ` +
        `| erros: ${errs.length ? errs.join(" ; ") : "nenhum"}`,
    );
    await page.close();
  }
}
await browser.close();
