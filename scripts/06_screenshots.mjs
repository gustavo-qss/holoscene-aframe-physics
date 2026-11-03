/**
 * Etapa 6 - Capturas ilustrativas para o relatorio.
 *
 * Nao fazem parte do protocolo de medicao (nao sao repetidas 3x): servem para
 * mostrar visualmente a cena e o colapso da simulacao.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(path.dirname(__dirname), "results", "screenshots");
fs.mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({
  channel: "chrome",
  headless: false,
  args: ["--disable-gpu-vsync", "--disable-frame-rate-limit"],
});

async function capturar(nome, query, esperas) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(`http://127.0.0.1:8088/index.html?${query}`, {
    waitUntil: "load", timeout: 120000,
  });
  // espera os modelos carregarem (antes de a fisica agir de forma visivel)
  await page.waitForFunction(
    () => window.__RESULT || document.getElementById("hud").textContent.includes("medindo"),
    null, { timeout: 180000 },
  ).catch(() => {});
  for (const { rotulo, ms } of esperas) {
    await page.waitForTimeout(ms);
    const p = path.join(SHOTS, `${nome}_${rotulo}.png`);
    await page.screenshot({ path: p });
    console.log("  " + path.basename(p));
  }
  await page.close();
}

// a cena como o HoloScene entrega, sem fisica: referencia visual
await capturar("vista_sem_fisica", "variant=original&physics=off&warmup=0&window=30&nav=off", [
  { rotulo: "t0", ms: 500 },
]);

// com fisica: logo no inicio e depois do colapso
await capturar("vista_com_fisica", "variant=original&physics=on&warmup=0&window=30&nav=off", [
  { rotulo: "t0", ms: 300 },
  { rotulo: "t2s", ms: 1700 },
  { rotulo: "t10s", ms: 8000 },
]);

// versao otimizada com fisica
await capturar("vista_otimizado_fisica", "variant=optimized&physics=on&warmup=0&window=30&nav=off", [
  { rotulo: "t0", ms: 300 },
  { rotulo: "t10s", ms: 9700 },
]);

await browser.close();
console.log("\ncapturas em results/screenshots/");
