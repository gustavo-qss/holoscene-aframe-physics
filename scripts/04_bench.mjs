/**
 * Etapa 5 - Medicao automatizada da cena A-Frame.
 *
 * Dirige o Chrome instalado na maquina (playwright-core, channel "chrome"),
 * em janela real (headed) para que o WebGL use a GPU de verdade. O vsync e
 * desligado para que o FPS medido seja a vazao real de renderizacao e nao o
 * teto do monitor; so assim da para comparar a versao original com a otimizada.
 *
 * Cenarios: {original, optimized} x {fisica on, fisica off}
 * Repeticoes: 3 por cenario (configuravel), reportando media e desvio padrao.
 *
 * Saidas:
 *   results/runtime_runs.csv       - uma linha por execucao
 *   results/runtime_summary.json   - media e desvio por cenario + criterios
 *   results/stability_<cenario>_r<N>.csv - deslocamento por objeto
 *   results/screenshots/*.png
 *   results/console_<cenario>_r<N>.json  - mensagens de console e page errors
 *
 * Uso:  node scripts/04_bench.mjs [--smoke] [--reps N] [--port P]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(__dirname);
const RESULTS = path.join(ROOT, "results");
const SHOTS = path.join(RESULTS, "screenshots");

const argv = process.argv.slice(2);
const SMOKE = argv.includes("--smoke");
const REPS = (() => {
  const i = argv.indexOf("--reps");
  return i >= 0 ? +argv[i + 1] : SMOKE ? 1 : 3;
})();
const PORT = (() => {
  const i = argv.indexOf("--port");
  return i >= 0 ? +argv[i + 1] : 8088;
})();

const WARMUP_S = SMOKE ? 1 : 3;
const WINDOW_S = SMOKE ? 3 : 10;
const VIEWPORT = { width: 1280, height: 720 };

// Os quatro primeiros sao o experimento principal (com a correcao de
// desintercalamento aplicada). Os dois ultimos reproduzem deliberadamente o
// defeito do three-to-ammo para quantificar seu impacto.
const CENARIOS = [
  { id: "original_sem_fisica", variant: "original", physics: "off", fix: "on" },
  { id: "original_com_fisica", variant: "original", physics: "on", fix: "on" },
  { id: "otimizado_sem_fisica", variant: "optimized", physics: "off", fix: "on" },
  { id: "otimizado_com_fisica", variant: "optimized", physics: "on", fix: "on" },
  { id: "original_com_fisica_SEM_correcao", variant: "original", physics: "on", fix: "off" },
  { id: "otimizado_com_fisica_SEM_correcao", variant: "optimized", physics: "on", fix: "off" },
  // mitigacao: levanta os 7 objetos que nascem cravados no piso
  { id: "original_com_fisica_depenetrado", variant: "original", physics: "on", fix: "on", dep: "on" },
];
// Apenas os cenarios corrigidos contam para os criterios congelados.
const CENARIOS_PRINCIPAIS = CENARIOS.filter(
  (c) => c.fix === "on" && c.dep !== "on",
).map((c) => c.id);

fs.mkdirSync(SHOTS, { recursive: true });

function media(a) {
  const v = a.filter((x) => typeof x === "number" && isFinite(x));
  return v.length ? v.reduce((x, y) => x + y, 0) / v.length : null;
}
function desvio(a) {
  const v = a.filter((x) => typeof x === "number" && isFinite(x));
  if (v.length < 2) return 0;
  const m = media(v);
  return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1));
}
const r2 = (x) => (x === null || x === undefined ? null : +x.toFixed(2));
const r3 = (x) => (x === null || x === undefined ? null : +x.toFixed(3));

async function rodar(browser, cen, rep) {
  const tag = `${cen.id}_r${rep}`;
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();

  const console_msgs = [];
  const page_errors = [];
  page.on("console", (m) => {
    console_msgs.push({ tipo: m.type(), texto: m.text().slice(0, 500) });
  });
  page.on("pageerror", (e) =>
    page_errors.push(((e && e.stack) || String(e)).slice(0, 1500)),
  );
  // Abortos de requisicao HTTP sao contabilizados a parte das excecoes de JS:
  // sao ruido do servidor local com 28 downloads em paralelo e nao impedem o
  // carregamento (n_modelos_carregados continua 28).
  const req_abortadas = [];
  page.on("requestfailed", (r) =>
    req_abortadas.push(`${r.url().split("/").pop()} ${r.failure()?.errorText}`),
  );
  // crash do processo de renderizacao: a causa mais provavel de perder a
  // pagina no meio de uma execucao pesada (memoria de textura, colisor grande)
  let crashou = false;
  page.on("crash", () => {
    crashou = true;
    page_errors.push("PAGE CRASH: o processo de renderizacao morreu");
  });
  // NAO registrar o fechamento da pagina em page_errors: ele e disparado pelo
  // proprio ctx.close() no fim da execucao e inflaria a contagem de excecoes.

  const url =
    `http://127.0.0.1:${PORT}/index.html` +
    `?variant=${cen.variant}&physics=${cen.physics}` +
    `&warmup=${WARMUP_S}&window=${WINDOW_S}&nav=off` +
    `&desinterleave=${cen.fix}&depenetrar=${cen.dep || "off"}`;

  let res = null;
  let falha = "";
  try {
    await page.goto(url, { waitUntil: "load", timeout: 120000 });
    await page.waitForFunction(() => window.__DONE === true, null, {
      timeout: 300000,
      polling: 250,
    });
    res = await page.evaluate(() => window.__RESULT);
    await page.screenshot({ path: path.join(SHOTS, `${tag}.png`) });
  } catch (e) {
    falha =
      (crashou ? "CRASH DO RENDERIZADOR: " : "") + String(e).slice(0, 400);
    try {
      await page.screenshot({ path: path.join(SHOTS, `${tag}_FALHA.png`) });
    } catch {}
  }

  fs.writeFileSync(
    path.join(RESULTS, `console_${tag}.json`),
    JSON.stringify(
      {
        url,
        n_console: console_msgs.length,
        n_excecoes_js: page_errors.length,
        n_requisicoes_abortadas: req_abortadas.length,
        requisicoes_abortadas: req_abortadas,
        page_errors,
        console: console_msgs.filter(
          (m) => m.tipo === "error" || m.tipo === "warning",
        ),
      },
      null,
      2,
    ),
  );

  await ctx.close();

  if (!res) {
    return { cenario: cen.id, repeticao: rep, falha: falha || "sem resultado" };
  }

  // estabilidade por objeto
  if (res.objetos && res.objetos.length) {
    const cols = Object.keys(res.objetos[0]);
    const csv = [cols.join(",")]
      .concat(res.objetos.map((o) => cols.map((c) => o[c]).join(",")))
      .join("\n");
    fs.writeFileSync(path.join(RESULTS, `stability_${tag}.csv`), csv, "utf8");
  }

  return {
    cenario: cen.id,
    repeticao: rep,
    variante: res.variante,
    fisica: res.fisica,
    correcao_desinterleave: res.desinterleave,
    atributos_desintercalados: res.atributos_desintercalados,
    n_depenetrados: res.n_depenetrados || 0,
    levantamento_total_m: r3(res.levantamento_total_m || 0),
    t_manifesto_ms: res.t_manifesto_ms,
    t_modelos_ms: res.t_modelos_ms,
    t_corpos_ms: res.t_corpos_ms,
    t_colisor_fundo_ms: res.t_colisor_fundo_ms,
    t_colisor_max_ms: res.t_colisor_max_ms,
    t_colisor_medio_objetos_ms: r2(res.t_colisor_medio_objetos_ms),
    t_colisor_mediano_objetos_ms: r2(res.t_colisor_mediano_objetos_ms),
    n_modelos_carregados: res.n_modelos_carregados,
    n_corpos_criados: res.n_corpos_criados,
    n_corpos_esperados: res.n_corpos_esperados,
    triangulos_renderizados: res.triangulos_renderizados,
    draw_calls: res.draw_calls,
    geometrias: res.geometrias,
    texturas: res.texturas,
    quadros_medidos: res.quadros_medidos,
    duracao_medida_s: res.duracao_medida_s,
    fps_efetivo: r2(res.fps_efetivo),
    fps_mediano: r2(res.fps_mediano),
    fps_1pct_low: r2(res.fps_1pct_low),
    fps_5pct_low: r2(res.fps_5pct_low),
    fps_min: r2(res.fps_min),
    frametime_medio_ms: r3(res.frametime_medio_ms),
    frametime_mediano_ms: r3(res.frametime_mediano_ms),
    frametime_p95_ms: r3(res.frametime_p95_ms),
    frametime_p99_ms: r3(res.frametime_p99_ms),
    frametime_max_ms: r3(res.frametime_max_ms),
    quadros_acima_50ms: res.quadros_acima_50ms,
    desloc_mediano_m: r3(res.desloc_mediano_m),
    desloc_medio_m: r3(res.desloc_medio_m),
    desloc_max_m: r3(res.desloc_max_m),
    n_abaixo_do_piso: res.n_abaixo_do_piso,
    n_praticamente_parados: res.n_praticamente_parados,
    n_movidos_acima_10cm: res.n_movidos_acima_10cm,
    heap_usado_mb: res.heap_usado_mb,
    quadros_renderizados_aframe: res.quadros_renderizados_aframe,
    fps_render_aframe: r2(res.fps_render_aframe),
    render_loop_vivo: res.render_loop_vivo,
    n_excecoes_js: page_errors.length,
    n_requisicoes_abortadas: req_abortadas.length,
    n_erros_cena: (res.erros || []).length,
    erros_cena: (res.erros || []).join(" | ").slice(0, 300),
    falha: "",
  };
}

async function main() {
  console.log(
    `protocolo: ${CENARIOS.length} cenarios x ${REPS} repeticoes, ` +
      `aquecimento ${WARMUP_S}s, janela ${WINDOW_S}s, ${VIEWPORT.width}x${VIEWPORT.height}` +
      (SMOKE ? "   [SMOKE]" : ""),
  );

  const browser = await chromium.launch({
    channel: "chrome",
    headless: false,
    args: [
      // sem teto de vsync: medimos vazao real, nao o refresh do monitor
      "--disable-gpu-vsync",
      "--disable-frame-rate-limit",
      // impede o Chrome de estrangular rAF quando a janela perde o foco
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  const versaoNavegador = browser.version();

  const linhas = [];
  for (const cen of CENARIOS) {
    for (let rep = 1; rep <= REPS; rep++) {
      process.stdout.write(`  ${cen.id} rep ${rep}/${REPS} ... `);
      const l = await rodar(browser, cen, rep);
      linhas.push(l);
      if (l.falha) {
        console.log(`FALHA: ${l.falha}`);
      } else {
        console.log(
          `fps ${l.fps_efetivo} (1% low ${l.fps_1pct_low}) | ` +
            `frametime ${l.frametime_medio_ms} ms | ` +
            `carga ${l.t_modelos_ms} ms | colisor fundo ${l.t_colisor_fundo_ms ?? "-"} ms | ` +
            `corpos ${l.n_corpos_criados}/${l.n_corpos_esperados}` +
            (l.desloc_mediano_m !== null
              ? ` | desloc med ${l.desloc_mediano_m} m`
              : "") +
            `${l.render_loop_vivo === false ? "  [RENDER LOOP MORTO]" : ""}` +
            (l.n_excecoes_js || l.n_erros_cena
              ? `  [excecoes ${l.n_excecoes_js} cena ${l.n_erros_cena}]`
              : "") +
            (l.n_requisicoes_abortadas
              ? `  (abortos http ${l.n_requisicoes_abortadas})`
              : ""),
        );
      }
    }
  }
  await browser.close();

  if (SMOKE) {
    console.log("\n[smoke] nao consolida resultados.");
    console.log(JSON.stringify(linhas, null, 2));
    return;
  }

  // ---- CSV por execucao ----
  const cols = [];
  for (const l of linhas) for (const k of Object.keys(l)) if (!cols.includes(k)) cols.push(k);
  const esc = (v) =>
    v === null || v === undefined
      ? ""
      : /[",\n]/.test(String(v))
        ? `"${String(v).replace(/"/g, '""')}"`
        : String(v);
  fs.writeFileSync(
    path.join(RESULTS, "runtime_runs.csv"),
    [cols.join(",")].concat(linhas.map((l) => cols.map((c) => esc(l[c])).join(","))).join("\n"),
    "utf8",
  );

  // ---- resumo por cenario ----
  const METRICAS = [
    "t_modelos_ms", "t_colisor_fundo_ms", "t_colisor_max_ms",
    "t_colisor_medio_objetos_ms",
    "fps_efetivo", "fps_1pct_low", "fps_5pct_low", "fps_min",
    "frametime_medio_ms", "frametime_p95_ms", "frametime_p99_ms",
    "frametime_max_ms", "quadros_acima_50ms",
    "fps_render_aframe", "quadros_renderizados_aframe",
    "desloc_mediano_m", "desloc_medio_m", "desloc_max_m", "heap_usado_mb",
    "triangulos_renderizados", "draw_calls",
  ];
  const resumo = {};
  for (const cen of CENARIOS) {
    const ls = linhas.filter((l) => l.cenario === cen.id && !l.falha);
    const o = { n_execucoes: ls.length, n_falhas: REPS - ls.length };
    for (const m of METRICAS) {
      const vals = ls.map((l) => l[m]).filter((v) => typeof v === "number");
      o[m] = { media: r3(media(vals)), desvio: r3(desvio(vals)), n: vals.length };
    }
    o.n_corpos_criados = ls.length ? ls[0].n_corpos_criados : 0;
    o.n_corpos_esperados = ls.length ? ls[0].n_corpos_esperados : 0;
    o.n_modelos_carregados = ls.length ? ls[0].n_modelos_carregados : 0;
    o.excecoes_js_total = ls.reduce((s, l) => s + (l.n_excecoes_js || 0), 0);
    o.requisicoes_abortadas_total = ls.reduce(
      (s, l) => s + (l.n_requisicoes_abortadas || 0), 0);
    o.erros_cena_total = ls.reduce((s, l) => s + (l.n_erros_cena || 0), 0);
    o.render_loop_vivo = ls.every((l) => l.render_loop_vivo !== false);
    resumo[cen.id] = o;
  }

  // ---- avaliacao dos criterios congelados ----
  const crit = JSON.parse(
    fs.readFileSync(path.join(RESULTS, "criterios.json"), "utf8"),
  );
  const conv = JSON.parse(
    fs.readFileSync(path.join(RESULTS, "conversion_summary.json"), "utf8"),
  );
  // os criterios congelados sao avaliados so nos cenarios corrigidos; os
  // cenarios "_SEM_correcao" existem apenas para documentar o defeito
  const comFisica = [resumo.original_com_fisica, resumo.otimizado_com_fisica];
  const todos = CENARIOS_PRINCIPAIS.map((id) => resumo[id]);
  const linhasPrincipais = linhas.filter((l) =>
    CENARIOS_PRINCIPAIS.includes(l.cenario),
  );

  const aval = [
    {
      id: "C1",
      valor: conv.validacao.originais_sem_erro / conv.n_malhas,
      limiar: ">= 0.90",
      passou:
        conv.validacao.originais_sem_erro / conv.n_malhas >= 0.9 &&
        conv.validacao.otimizados_sem_erro / conv.n_malhas >= 0.9,
    },
    {
      id: "C2",
      valor: Math.max(...todos.map((r) => r.t_modelos_ms.media ?? Infinity)),
      limiar: "<= 15000 ms",
      passou: todos.every((r) => (r.t_modelos_ms.media ?? Infinity) <= 15000),
    },
    {
      id: "C3",
      valor: Math.min(...comFisica.map((r) => r.fps_efetivo.media ?? 0)),
      limiar: ">= 30 fps",
      passou: comFisica.every((r) => (r.fps_efetivo.media ?? 0) >= 30),
    },
    {
      id: "C4",
      valor: Math.min(...comFisica.map((r) => r.fps_1pct_low.media ?? 0)),
      limiar: ">= 20 fps",
      passou: comFisica.every((r) => (r.fps_1pct_low.media ?? 0) >= 20),
    },
    {
      id: "C5",
      valor:
        comFisica.map((r) => `${r.n_corpos_criados}/${r.n_corpos_esperados} corpos`).join(", ") +
        `; excecoes JS ${comFisica.reduce((s, r) => s + r.excecoes_js_total, 0)}` +
        `; abortos HTTP ${comFisica.reduce((s, r) => s + r.requisicoes_abortadas_total, 0)}`,
      limiar: "== 28 corpos, zero excecoes",
      // abortos de requisicao HTTP nao sao excecoes e nao sao contados aqui:
      // os 28 modelos carregam em todas as execucoes
      passou: comFisica.every(
        (r) =>
          r.n_corpos_criados === 28 &&
          r.n_modelos_carregados === 28 &&
          r.excecoes_js_total === 0 &&
          r.erros_cena_total === 0 &&
          r.render_loop_vivo,
      ),
    },
    {
      id: "C6",
      valor: Math.max(...comFisica.map((r) => r.desloc_mediano_m.media ?? Infinity)),
      limiar: "<= 0.10 m",
      passou: comFisica.every((r) => (r.desloc_mediano_m.media ?? Infinity) <= 0.1),
    },
    {
      id: "C7",
      valor: Math.max(
        ...linhasPrincipais.filter((l) => !l.falha && l.fisica === "on")
          .map((l) => l.n_abaixo_do_piso ?? 0),
      ),
      limiar: "== 0",
      passou: linhasPrincipais
        .filter((l) => !l.falha && l.fisica === "on")
        .every((l) => (l.n_abaixo_do_piso ?? 0) === 0),
    },
    {
      id: "C8",
      valor: `tri ${conv.razao_triangulos_cena}, bytes ${(
        conv.glb_otimizado_mb / conv.glb_original_mb
      ).toFixed(4)}`,
      limiar: "<= 0.50 nos dois",
      passou:
        conv.razao_triangulos_cena <= 0.5001 &&
        conv.glb_otimizado_mb / conv.glb_original_mb <= 0.5,
    },
  ];
  for (const a of aval) {
    const c = crit.criterios.find((x) => x.id === a.id);
    a.enunciado = c ? c.enunciado : "";
  }

  const out = {
    protocolo: {
      cenarios: CENARIOS.map((c) => c.id),
      repeticoes: REPS,
      aquecimento_s: WARMUP_S,
      janela_s: WINDOW_S,
      viewport: VIEWPORT,
      vsync: "desligado (--disable-gpu-vsync --disable-frame-rate-limit)",
      observacao_fps:
        "FPS medido sem teto de vsync: representa vazao de renderizacao, " +
        "nao a taxa percebida (que o monitor limita).",
      navegador: versaoNavegador,
      playwright_core: "1.64.1",
      aframe: "1.8.0",
      physics_system: "@c-frame/aframe-physics-system 4.2.4",
      ammo: "MozillaReality/ammo.js@8bbc0ea (ammo.wasm)",
    },
    resumo_por_cenario: resumo,
    criterios: aval,
    criterios_aprovados: aval.filter((a) => a.passou).length,
    criterios_total: aval.length,
  };
  fs.writeFileSync(
    path.join(RESULTS, "runtime_summary.json"),
    JSON.stringify(out, null, 2),
    "utf8",
  );

  console.log("\n==== criterios ====");
  for (const a of aval) {
    console.log(`  ${a.passou ? "PASSOU " : "FALHOU "} ${a.id}  ${a.valor}  (${a.limiar})`);
  }
  console.log(`\n${out.criterios_aprovados}/${out.criterios_total} criterios aprovados`);
  console.log("escrito: results/runtime_runs.csv, results/runtime_summary.json");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
