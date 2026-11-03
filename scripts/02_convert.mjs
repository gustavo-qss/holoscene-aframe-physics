/**
 * Etapa 2 - Conversao OBJ+MTL+PNG -> GLB, em duas versoes.
 *
 *   (a) original   : geometria integral, textura PNG original
 *   (b) otimizada  : simplificacao para ~50% dos triangulos + textura WebP 1024
 *
 * Correcao de referencial aplicada IGUALMENTE as duas versoes (nao e otimizacao,
 * e pre-requisito de correcao):
 *   - rotacao de -90 deg em X  : OBJ e Z-up, glTF/A-Frame e Y-up.
 *     (x,y,z)_obj -> (x, z, -y). Confere com o scene.glb do proprio HoloScene.
 *   - escala uniforme S        : o export do HoloScene nao e metrico; S vem do
 *     pe-direito medido (0.37864 u) contra a hipotese declarada de 2.7 m.
 *   A transformacao e "assada" nos vertices (clearNodeTransform), nao deixada
 *   como transform de no, para que o colisor de malha do Ammo receba
 *   coordenadas ja metricas.
 *
 * Material: o MTL do HoloScene so traz map_Kd. Fixamos metallic=0, roughness=1
 * e doubleSided=true (malha de reconstrucao tem winding inconsistente).
 *
 * Saidas: scene/models/{original,optimized}/surface_N.glb
 *         results/conversion.csv, results/validator/*.json
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

import obj2gltf from "obj2gltf";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import {
  clearNodeTransform,
  weld,
  simplify,
  textureCompress,
  prune,
  dedup,
} from "@gltf-transform/functions";
import { MeshoptSimplifier } from "meshoptimizer";
import sharp from "sharp";
import validator from "gltf-validator";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(__dirname);
const SRC = path.join(ROOT, "meshes_src");
const OUT_ORIG = path.join(ROOT, "scene", "models", "original");
const OUT_OPT = path.join(ROOT, "scene", "models", "optimized");
const RESULTS = path.join(ROOT, "results");
const VALDIR = path.join(RESULTS, "validator");

// ---- parametros fixados ANTES da execucao ----
const PARAMS = {
  escala: 7.13078, // de results/scene_totals.json -> sala.fator_escala_adotado
  rotacao_x_graus: -90,
  simplify_ratio: 0.5, // ~50% dos triangulos
  simplify_error: 0.001, // erro maximo relativo ao tamanho da malha
  weld_tolerance: 0, // solda apenas vertices exatamente coincidentes
  textura_formato: "webp",
  textura_lado: 1024, // 2048 -> 1024
  textura_qualidade: 80,
  material_metallic: 0,
  material_roughness: 1,
  material_double_sided: true,
};

for (const d of [OUT_ORIG, OUT_OPT, VALDIR]) fs.mkdirSync(d, { recursive: true });

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

// quaternion de -90 deg em torno de X
const half = (PARAMS.rotacao_x_graus * Math.PI) / 180 / 2;
const QUAT = [Math.sin(half), 0, 0, Math.cos(half)];

function triCount(doc) {
  let n = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices();
      n += idx
        ? idx.getCount() / 3
        : prim.getAttribute("POSITION").getCount() / 3;
    }
  }
  return Math.round(n);
}

async function validate(glbPath, tag) {
  const bytes = new Uint8Array(fs.readFileSync(glbPath));
  try {
    const report = await validator.validateBytes(bytes, {
      uri: path.basename(glbPath),
      maxIssues: 100,
    });
    fs.writeFileSync(
      path.join(VALDIR, `${tag}.json`),
      JSON.stringify(report, null, 2),
    );
    const s = report.issues;
    return {
      ok: s.numErrors === 0,
      erros: s.numErrors,
      avisos: s.numWarnings,
      infos: s.numInfos,
      dicas: s.numHints,
      primeiro:
        s.messages && s.messages.length
          ? `${s.messages[0].severity}:${s.messages[0].code}`
          : "",
    };
  } catch (e) {
    fs.writeFileSync(
      path.join(VALDIR, `${tag}.json`),
      JSON.stringify({ erro: String(e) }, null, 2),
    );
    return { ok: false, erros: -1, avisos: -1, infos: -1, dicas: -1,
             primeiro: `EXCECAO:${String(e).slice(0, 120)}` };
  }
}

async function convertOne(stem) {
  const row = { nome: stem };
  const objPath = path.join(SRC, `${stem}.obj`);
  row.obj_bytes = fs.statSync(objPath).size;
  row.png_bytes = fs.statSync(path.join(SRC, `${stem}.png`)).size;

  // ---------- (a) original ----------
  let t = performance.now();
  const glbBuf = await obj2gltf(objPath, {
    binary: true,
    separate: false,
    unlit: false,
    metallicRoughness: true,
  });
  row.ms_obj2gltf = Math.round(performance.now() - t);

  t = performance.now();
  const doc = await io.readBinary(new Uint8Array(glbBuf));

  // assa rotacao + escala nos vertices
  for (const node of doc.getRoot().listNodes()) {
    node.setRotation(QUAT).setScale([PARAMS.escala, PARAMS.escala, PARAMS.escala]);
    clearNodeTransform(node);
  }
  for (const mat of doc.getRoot().listMaterials()) {
    mat
      .setMetallicFactor(PARAMS.material_metallic)
      .setRoughnessFactor(PARAMS.material_roughness)
      .setDoubleSided(PARAMS.material_double_sided);
  }
  await doc.transform(dedup(), prune());
  row.tri_original = triCount(doc);

  const origPath = path.join(OUT_ORIG, `${stem}.glb`);
  fs.writeFileSync(origPath, await io.writeBinary(doc));
  row.ms_transform_original = Math.round(performance.now() - t);
  row.glb_original_bytes = fs.statSync(origPath).size;

  // ---------- (b) otimizada ----------
  t = performance.now();
  const docOpt = await io.readBinary(new Uint8Array(fs.readFileSync(origPath)));
  await MeshoptSimplifier.ready;
  try {
    await docOpt.transform(
      weld({ tolerance: PARAMS.weld_tolerance }),
      simplify({
        simplifier: MeshoptSimplifier,
        ratio: PARAMS.simplify_ratio,
        error: PARAMS.simplify_error,
      }),
      textureCompress({
        encoder: sharp,
        targetFormat: PARAMS.textura_formato,
        resize: [PARAMS.textura_lado, PARAMS.textura_lado],
        quality: PARAMS.textura_qualidade,
      }),
      prune(),
    );
    row.otim_erro = "";
  } catch (e) {
    row.otim_erro = String(e).slice(0, 300);
  }
  row.tri_otimizado = triCount(docOpt);
  const optPath = path.join(OUT_OPT, `${stem}.glb`);
  fs.writeFileSync(optPath, await io.writeBinary(docOpt));
  row.ms_otimizacao = Math.round(performance.now() - t);
  row.glb_otimizado_bytes = fs.statSync(optPath).size;

  // ---------- metricas derivadas ----------
  row.razao_triangulos = +(row.tri_otimizado / row.tri_original).toFixed(4);
  row.razao_bytes = +(row.glb_otimizado_bytes / row.glb_original_bytes).toFixed(4);
  row.reducao_bytes_pct = +(100 * (1 - row.razao_bytes)).toFixed(2);

  // ---------- validacao ----------
  const vo = await validate(origPath, `${stem}.original`);
  const vt = await validate(optPath, `${stem}.optimized`);
  row.val_orig_ok = vo.ok;
  row.val_orig_erros = vo.erros;
  row.val_orig_avisos = vo.avisos;
  row.val_orig_primeiro = vo.primeiro;
  row.val_otim_ok = vt.ok;
  row.val_otim_erros = vt.erros;
  row.val_otim_avisos = vt.avisos;
  row.val_otim_primeiro = vt.primeiro;

  return row;
}

async function main() {
  let stems = fs
    .readdirSync(SRC)
    .filter((f) => f.endsWith(".obj"))
    .map((f) => f.replace(/\.obj$/, ""))
    .sort((a, b) => +a.split("_")[1] - +b.split("_")[1]);

  // argumentos opcionais = subconjunto de malhas (usado para piloto/depuracao;
  // nesse modo NAO sobrescreve os CSV/JSON consolidados)
  const alvo = process.argv.slice(2);
  const piloto = alvo.length > 0;
  if (piloto) stems = stems.filter((s) => alvo.includes(s));

  const rows = [];
  const tAll = performance.now();
  for (const stem of stems) {
    process.stdout.write(`  convertendo ${stem} ... `);
    try {
      const row = await convertOne(stem);
      rows.push(row);
      console.log(
        `${row.tri_original}->${row.tri_otimizado} tri, ` +
          `${(row.glb_original_bytes / 1048576).toFixed(2)}->` +
          `${(row.glb_otimizado_bytes / 1048576).toFixed(2)} MB, ` +
          `${row.ms_obj2gltf + row.ms_transform_original + row.ms_otimizacao} ms` +
          (row.otim_erro ? `  [FALHA OTIM: ${row.otim_erro.slice(0, 80)}]` : ""),
      );
    } catch (e) {
      console.log(`FALHA: ${String(e).slice(0, 200)}`);
      rows.push({ nome: stem, erro: String(e).slice(0, 500) });
    }
  }
  const totalMs = Math.round(performance.now() - tAll);

  // CSV
  const cols = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
  const esc = (v) =>
    v === undefined || v === null
      ? ""
      : /[",\n]/.test(String(v))
        ? `"${String(v).replace(/"/g, '""')}"`
        : String(v);
  const csv = [cols.join(",")]
    .concat(rows.map((r) => cols.map((c) => esc(r[c])).join(",")))
    .join("\n");
  if (piloto) {
    console.log("\n[piloto] resultados nao consolidados:\n" + csv);
    return;
  }
  fs.writeFileSync(path.join(RESULTS, "conversion.csv"), csv, "utf8");

  // resumo
  const ok = rows.filter((r) => !r.erro);
  const sum = (f) => ok.reduce((a, r) => a + (f(r) || 0), 0);
  const resumo = {
    ferramentas: {
      obj2gltf: "3.2.0",
      "@gltf-transform/core": "4.5.1",
      "@gltf-transform/functions": "4.5.1",
      meshoptimizer: "1.3.0",
      sharp: "0.35.5",
      "gltf-validator": "2.0.0-dev.3.10",
      node: process.version,
    },
    parametros: PARAMS,
    comando: "node scripts/02_convert.mjs",
    n_malhas: ok.length,
    n_falhas: rows.length - ok.length,
    n_falhas_otimizacao: ok.filter((r) => r.otim_erro).length,
    triangulos_original: sum((r) => r.tri_original),
    triangulos_otimizado: sum((r) => r.tri_otimizado),
    razao_triangulos_cena: +(
      sum((r) => r.tri_otimizado) / sum((r) => r.tri_original)
    ).toFixed(4),
    obj_mb: +(sum((r) => r.obj_bytes + r.png_bytes) / 1048576).toFixed(2),
    glb_original_mb: +(sum((r) => r.glb_original_bytes) / 1048576).toFixed(2),
    glb_otimizado_mb: +(sum((r) => r.glb_otimizado_bytes) / 1048576).toFixed(2),
    reducao_total_pct: +(
      100 *
      (1 - sum((r) => r.glb_otimizado_bytes) / sum((r) => r.glb_original_bytes))
    ).toFixed(2),
    tempo_total_ms: totalMs,
    tempo_total_s: +(totalMs / 1000).toFixed(1),
    validacao: {
      originais_sem_erro: ok.filter((r) => r.val_orig_ok).length,
      otimizados_sem_erro: ok.filter((r) => r.val_otim_ok).length,
      originais_com_aviso: ok.filter((r) => r.val_orig_avisos > 0).length,
      otimizados_com_aviso: ok.filter((r) => r.val_otim_avisos > 0).length,
    },
  };
  fs.writeFileSync(
    path.join(RESULTS, "conversion_summary.json"),
    JSON.stringify(resumo, null, 2),
    "utf8",
  );
  console.log("\n" + JSON.stringify(resumo, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
