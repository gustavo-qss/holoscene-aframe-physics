"""
Etapa 1b - Dimensoes da sala a partir dos planos de parede.

O componente conexo dominante do fundo esta contaminado por destrocos de
reconstrucao (20% da area fica fora do nucleo), entao a bounding box nao serve
para medir a sala. Aqui localizamos os planos dominantes (piso, teto e as quatro
paredes) por histograma de area ponderada e medimos a sala de parede a parede.

Atualiza results/scene_totals.json com a chave "sala".
"""

import json
import os

import numpy as np
import trimesh

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "meshes_src")
OUT = os.path.join(ROOT, "results")

PE_DIREITO_ADOTADO_M = 2.7  # hipotese declarada antes da medicao


def planos_dominantes(mesh, eixo, n_picos=2, bins=400, tol_normal=0.9):
    """Localiza planos perpendiculares a `eixo` com maior area acumulada."""
    nrm, af = mesh.face_normals, mesh.area_faces
    sel = np.abs(nrm[:, eixo]) > tol_normal
    if sel.sum() == 0:
        return []
    c = mesh.triangles_center[sel, eixo]
    a = af[sel]
    lo, hi = float(c.min()), float(c.max())
    hist, edges = np.histogram(c, bins=bins, range=(lo, hi), weights=a)
    centros = 0.5 * (edges[:-1] + edges[1:])

    picos = []
    h = hist.copy()
    # separacao minima entre picos: 5% da extensao, evita pegar o mesmo plano 2x
    minsep = max(1, int(0.05 * bins))
    for _ in range(n_picos):
        i = int(np.argmax(h))
        if h[i] <= 0:
            break
        picos.append({"pos": round(float(centros[i]), 5),
                      "area": round(float(hist[i]), 5)})
        h[max(0, i - minsep): i + minsep + 1] = 0
    return sorted(picos, key=lambda p: p["pos"])


def main():
    mesh = trimesh.load(os.path.join(SRC, "surface_0.obj"), process=False,
                        skip_materials=True, force="mesh")
    mesh.merge_vertices(merge_tex=True, merge_norm=True)

    res = {"metodo": "picos de area em histograma de planos perpendiculares a cada eixo",
           "eixo_up": "z"}

    eixos = {}
    for i, ax in enumerate("xyz"):
        p = planos_dominantes(mesh, i, n_picos=2)
        eixos[ax] = p
        if len(p) == 2:
            res["extensao_" + ax] = round(p[1]["pos"] - p[0]["pos"], 5)
    res["planos"] = eixos

    piso_teto = eixos["z"]
    res["piso_z"] = piso_teto[0]["pos"]
    res["teto_z"] = piso_teto[1]["pos"]
    pe = piso_teto[1]["pos"] - piso_teto[0]["pos"]
    res["pe_direito_unidades"] = round(pe, 5)

    fator = PE_DIREITO_ADOTADO_M / pe
    res["pe_direito_adotado_m"] = PE_DIREITO_ADOTADO_M
    res["fator_escala_adotado"] = round(fator, 5)
    res["sala_m"] = {
        "largura_x": round(res.get("extensao_x", float("nan")) * fator, 2),
        "profundidade_y": round(res.get("extensao_y", float("nan")) * fator, 2),
        "altura_z": PE_DIREITO_ADOTADO_M,
    }
    res["area_piso_m2"] = round(
        res["sala_m"]["largura_x"] * res["sala_m"]["profundidade_y"], 2
    )
    res["observacao"] = (
        "Fator derivado da hipotese pe-direito = %.1f m, declarada antes da "
        "medicao. O export do HoloScene nao carrega escala metrica."
        % PE_DIREITO_ADOTADO_M
    )

    path = os.path.join(OUT, "scene_totals.json")
    with open(path, "r", encoding="utf-8") as fh:
        totals = json.load(fh)
    totals["sala"] = res
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(totals, fh, indent=2, ensure_ascii=False)

    print(json.dumps(res, indent=2, ensure_ascii=False))
    print("\natualizado:", path)


if __name__ == "__main__":
    main()
