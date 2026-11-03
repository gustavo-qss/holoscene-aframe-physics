/**
 * Etapa 3a - Recentragem dos objetos dinamicos.
 *
 * Por que: um corpo rigido do Ammo tem o centro de massa na origem local da
 * entidade. Os GLB saem da etapa 2 com a geometria na posicao de mundo, longe
 * da origem. Se usassemos esses arquivos direto, cada objeto giraria em torno
 * de um ponto fora de si mesmo.
 *
 * O que faz: para cada objeto (surface_1..27) translada a geometria de -centro
 * (centro da caixa envolvente), assa a translacao nos vertices e grava em
 * models/<versao>_centered/. Registra o centro, que vira a position da entidade
 * na cena A-Frame.
 *
 * O fundo (surface_0) NAO e recentrado: e corpo estatico, fica na origem.
 *
 * Saida: results/model_placement.json
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { NodeIO, getBounds } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { clearNodeTransform } from "@gltf-transform/functions";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(__dirname);
const MODELS = path.join(ROOT, "scene", "models");
const RESULTS = path.join(ROOT, "results");

const FUNDO = "surface_0";
const VERSOES = ["original", "optimized"];

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

async function boundsOf(doc) {
  const b = getBounds(doc.getRoot().getDefaultScene());
  return { min: b.min, max: b.max };
}

async function main() {
  const placement = {};

  for (const versao of VERSOES) {
    const srcDir = path.join(MODELS, versao);
    const dstDir = path.join(MODELS, `${versao}_centered`);
    fs.mkdirSync(dstDir, { recursive: true });

    const stems = fs
      .readdirSync(srcDir)
      .filter((f) => f.endsWith(".glb"))
      .map((f) => f.slice(0, -4))
      .sort((a, b) => +a.split("_")[1] - +b.split("_")[1]);

    for (const stem of stems) {
      const doc = await io.read(path.join(srcDir, `${stem}.glb`));
      const { min, max } = await boundsOf(doc);
      const centro = [0, 1, 2].map((i) => (min[i] + max[i]) / 2);
      const dims = [0, 1, 2].map((i) => max[i] - min[i]);

      if (stem !== FUNDO) {
        for (const node of doc.getRoot().listNodes()) {
          node.setTranslation([-centro[0], -centro[1], -centro[2]]);
          clearNodeTransform(node);
        }
      }
      fs.writeFileSync(path.join(dstDir, `${stem}.glb`), await io.writeBinary(doc));

      const depois = await boundsOf(doc);
      if (versao === "original") {
        placement[stem] = {
          fundo: stem === FUNDO,
          bbox_min_mundo: min.map((v) => +v.toFixed(4)),
          bbox_max_mundo: max.map((v) => +v.toFixed(4)),
          dims_m: dims.map((v) => +v.toFixed(4)),
          // position da entidade A-Frame (o fundo fica na origem)
          position: stem === FUNDO ? [0, 0, 0] : centro.map((v) => +v.toFixed(4)),
          bbox_volume_m3: +(dims[0] * dims[1] * dims[2]).toFixed(5),
          // confirmacao de que a geometria ficou centrada
          centro_residual: [0, 1, 2]
            .map((i) => (depois.min[i] + depois.max[i]) / 2)
            .map((v) => +v.toFixed(5)),
        };
      }
    }
    console.log(`  ${versao}: ${stems.length} modelos -> ${versao}_centered`);
  }

  const maxResidual = Math.max(
    ...Object.entries(placement)
      .filter(([k]) => k !== FUNDO)
      .map(([, v]) => Math.max(...v.centro_residual.map(Math.abs))),
  );

  const out = {
    fundo: FUNDO,
    n_objetos: Object.keys(placement).length - 1,
    maior_centro_residual_m: +maxResidual.toFixed(6),
    nota:
      "position = centro da caixa envolvente no referencial metrico Y-up. " +
      "A geometria de cada objeto foi transladada de -position e a translacao " +
      "assada nos vertices, de modo que o centro de massa do corpo rigido " +
      "coincida com o centro geometrico.",
    modelos: placement,
  };
  fs.writeFileSync(
    path.join(RESULTS, "model_placement.json"),
    JSON.stringify(out, null, 2),
    "utf8",
  );
  console.log(`\nmaior centro residual: ${maxResidual.toExponential(2)} m`);
  console.log("escrito: results/model_placement.json");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
