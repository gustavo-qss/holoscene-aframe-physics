"""
Etapa 2b - Verificacao da transformacao assada nos GLB.

Confere, para cada GLB gerado, que:
  - o eixo vertical passou a ser Y (convencao glTF/A-Frame);
  - as dimensoes estao em metros (pe-direito do fundo ~2.7 m);
  - o no raiz tem transform identidade (transformacao assada nos vertices);
  - a versao otimizada manteve a mesma caixa envolvente da original.

Escreve results/glb_verification.csv e imprime o resumo.
"""

import csv
import json
import os

import numpy as np
import trimesh

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ORIG = os.path.join(ROOT, "scene", "models", "original")
OPT = os.path.join(ROOT, "scene", "models", "optimized")
RESULTS = os.path.join(ROOT, "results")

ESCALA = 7.13078
PE_DIREITO_ESPERADO = 2.7
TOL_BBOX = 0.05  # 5 cm de tolerancia entre original e otimizado


def carregar(path):
    """Carrega um GLB preservando o referencial do arquivo (sem conversao de eixo)."""
    s = trimesh.load(path, process=False)
    if isinstance(s, trimesh.Scene):
        transforms_identidade = all(
            np.allclose(s.graph[n][0], np.eye(4))
            for n in s.graph.nodes_geometry
        )
        m = s.to_mesh() if hasattr(s, "to_mesh") else s.dump(concatenate=True)
    else:
        transforms_identidade = True
        m = s
    return m, transforms_identidade


def main():
    stems = sorted(
        (f[:-4] for f in os.listdir(ORIG) if f.endswith(".glb")),
        key=lambda s: int(s.split("_")[1]),
    )
    rows = []
    for stem in stems:
        mo, ident_o = carregar(os.path.join(ORIG, stem + ".glb"))
        mt, ident_t = carregar(os.path.join(OPT, stem + ".glb"))
        eo, et = mo.extents, mt.extents
        r = {
            "nome": stem,
            "tri_original": len(mo.faces),
            "tri_otimizado": len(mt.faces),
            "no_identidade_original": ident_o,
            "no_identidade_otimizado": ident_t,
        }
        for i, ax in enumerate("xyz"):
            r["orig_dim_" + ax] = round(float(eo[i]), 4)
            r["otim_dim_" + ax] = round(float(et[i]), 4)
            r["delta_dim_" + ax] = round(float(abs(eo[i] - et[i])), 4)
        r["bbox_bate"] = bool(np.all(np.abs(eo - et) <= TOL_BBOX))
        r["delta_bbox_max_m"] = round(float(np.max(np.abs(eo - et))), 4)
        # altura do piso: min Y em metros
        r["orig_min_y"] = round(float(mo.bounds[0][1]), 4)
        r["orig_max_y"] = round(float(mo.bounds[1][1]), 4)
        rows.append(r)

    path = os.path.join(RESULTS, "glb_verification.csv")
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)

    fundo = rows[0]  # surface_0
    pe = fundo["orig_max_y"] - fundo["orig_min_y"]
    resumo = {
        "n_glb": len(rows),
        "todos_no_identidade": all(
            r["no_identidade_original"] and r["no_identidade_otimizado"] for r in rows
        ),
        "todos_bbox_batem": all(r["bbox_bate"] for r in rows),
        "maior_delta_bbox_m": max(r["delta_bbox_max_m"] for r in rows),
        "fundo_dims_m": [fundo["orig_dim_" + a] for a in "xyz"],
        "fundo_extensao_y_m": round(pe, 4),
        "eixo_vertical_e_y": bool(
            fundo["orig_dim_y"] < fundo["orig_dim_x"]
            and fundo["orig_dim_y"] < fundo["orig_dim_z"]
        ),
        "piso_y_m": fundo["orig_min_y"],
        "teto_y_m": fundo["orig_max_y"],
        "escala_aplicada": ESCALA,
    }
    with open(os.path.join(RESULTS, "glb_verification.json"), "w", encoding="utf-8") as fh:
        json.dump(resumo, fh, indent=2, ensure_ascii=False)
    print(json.dumps(resumo, indent=2, ensure_ascii=False))
    print("\nescrito:", path)


if __name__ == "__main__":
    main()
