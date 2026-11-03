/**
 * Etapa 0 - Reconstroi meshes_src/ a partir da saida do Stage 3 do HoloScene.
 *
 * meshes_src/ nao e versionado (84 MB). Este script copia os surface_*.obj,
 * .mtl e .png da pasta de saida e marca a copia como somente-leitura, para que
 * nenhuma etapa seguinte consiga alterar os dados originais.
 *
 * Uso:
 *   node scripts/00_copy_meshes.mjs <pasta-da-saida-do-holoscene>
 *   HOLOSCENE_OUT=/caminho/saidas node scripts/00_copy_meshes.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(__dirname);
const DEST = path.join(ROOT, "meshes_src");

const src = process.argv[2] || process.env.HOLOSCENE_OUT;
if (!src) {
  console.error(
    "Informe a pasta de saida do HoloScene (Stage 3).\n" +
      "  node scripts/00_copy_meshes.mjs <pasta>\n" +
      "  HOLOSCENE_OUT=<pasta> node scripts/00_copy_meshes.mjs\n\n" +
      "Deve conter surface_0..N com extensoes .obj, .mtl e .png.",
  );
  process.exit(1);
}
if (!fs.existsSync(src)) {
  console.error(`pasta nao encontrada: ${src}`);
  process.exit(1);
}

const arquivos = fs
  .readdirSync(src)
  .filter((f) => /^surface_\d+\.(obj|mtl|png)$/.test(f));

if (arquivos.length === 0) {
  console.error(`nenhum surface_*.{obj,mtl,png} em ${src}`);
  process.exit(1);
}

fs.mkdirSync(DEST, { recursive: true });
let bytes = 0;
for (const f of arquivos) {
  const alvo = path.join(DEST, f);
  // remove o somente-leitura de uma execucao anterior antes de sobrescrever
  if (fs.existsSync(alvo)) fs.chmodSync(alvo, 0o644);
  fs.copyFileSync(path.join(src, f), alvo);
  bytes += fs.statSync(alvo).size;
  fs.chmodSync(alvo, 0o444); // somente-leitura
}

const objs = arquivos.filter((f) => f.endsWith(".obj")).length;
console.log(
  `copiados ${arquivos.length} arquivos (${(bytes / 1048576).toFixed(1)} MB) ` +
    `para meshes_src/, somente-leitura`,
);
console.log(`malhas: ${objs}  (esperado para replica_room_0: 28 = 1 fundo + 27 objetos)`);
if (objs !== 28) {
  console.log(
    "AVISO: contagem diferente de 28. O pipeline funciona, mas os numeros do " +
      "RELATORIO.md foram medidos com 28 malhas.",
  );
}
