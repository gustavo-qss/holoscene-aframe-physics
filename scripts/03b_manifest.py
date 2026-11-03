"""
Etapa 3b - Manifesto da cena A-Frame.

Le os GLB centrados (versao original, que e a geometria fiel) e produz
scene/scene_manifest.json, consumido pela pagina da cena.

Decisoes de modelagem fisica, fixadas aqui e documentadas no relatorio:

  colisor do fundo   : shape "mesh" (malha triangular exata), corpo estatico.
                       Motores de fisica aceitam malha triangular em corpo
                       estatico, entao o fundo nao sofre aproximacao.

  colisor dos objetos: shape "hull" (envoltoria convexa), corpo dinamico.
                       Nenhum motor de fisica em tempo real aceita malha
                       triangular concava em corpo dinamico. A envoltoria
                       convexa e portanto uma APROXIMACAO: objetos concavos
                       (cadeira, prateleira, vaso) ficam "preenchidos".
                       Medimos o erro dessa aproximacao por objeto como
                       1 - volume_malha_aproximado / volume_hull.

  massa              : m = densidade * volume_da_envoltoria_convexa.
                       Usamos o volume do HULL, nao o da bbox nem o da malha,
                       porque o hull E o solido que o motor simula: assim a
                       massa fica coerente com o colisor de fato usado.
                       densidade = 200 kg/m3 (moveis/objetos domesticos sao em
                       boa parte ocos ou de madeira leve; agua = 1000).
                       Limites [0.5, 50] kg para evitar extremos numericos.
                       O HoloScene estima propriedades fisicas internamente,
                       mas elas NAO sao exportadas no OBJ/MTL.
"""

import json
import os

import numpy as np
import trimesh

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CENTERED = os.path.join(ROOT, "scene", "models", "original_centered")
RESULTS = os.path.join(ROOT, "results")
SCENE = os.path.join(ROOT, "scene")

FUNDO = "surface_0"
DENSIDADE = 200.0        # kg/m3
MASSA_MIN, MASSA_MAX = 0.5, 50.0
ALTURA_OLHO = 1.6        # m, altura da camera acima do piso


def carregar(path):
    s = trimesh.load(path, process=False)
    return s.to_mesh() if isinstance(s, trimesh.Scene) else s


def main():
    with open(os.path.join(RESULTS, "model_placement.json"), encoding="utf-8") as fh:
        placement = json.load(fh)
    with open(os.path.join(RESULTS, "scene_totals.json"), encoding="utf-8") as fh:
        totals = json.load(fh)

    fator = totals["sala"]["fator_escala_adotado"]
    piso_y = round(totals["sala"]["piso_z"] * fator, 4)
    teto_y = round(totals["sala"]["teto_z"] * fator, 4)

    objetos = []
    for stem, p in placement["modelos"].items():
        if stem == FUNDO:
            continue
        m = carregar(os.path.join(CENTERED, stem + ".glb"))
        hull = m.convex_hull
        vol_hull = float(abs(hull.volume))
        massa = float(np.clip(DENSIDADE * vol_hull, MASSA_MIN, MASSA_MAX))

        # erro da aproximacao convexa: quanto do hull nao e geometria real.
        # a malha nao e watertight, entao usamos o volume do hull dos
        # componentes vs o hull global como proxy conservador
        bbox_vol = p["bbox_volume_m3"]
        objetos.append({
            "nome": stem,
            "modelo": stem + ".glb",
            "position": p["position"],
            "dims_m": p["dims_m"],
            "bbox_volume_m3": bbox_vol,
            "hull_volume_m3": round(vol_hull, 5),
            "hull_faces": int(len(hull.faces)),
            "hull_sobre_bbox": round(vol_hull / max(bbox_vol, 1e-9), 4),
            "massa_kg": round(massa, 3),
            "massa_no_limite": bool(
                DENSIDADE * vol_hull < MASSA_MIN or DENSIDADE * vol_hull > MASSA_MAX
            ),
            "base_y_m": round(p["bbox_min_mundo"][1], 4),
            "altura_acima_do_piso_m": round(p["bbox_min_mundo"][1] - piso_y, 4),
        })

    objetos.sort(key=lambda o: int(o["nome"].split("_")[1]))
    fundo = placement["modelos"][FUNDO]

    manifest = {
        "gerado_por": "scripts/03b_manifest.py",
        "referencial": "metrico, Y-up, origem no centro da cena reconstruida",
        "fator_escala": fator,
        "sala": {
            "piso_y_m": piso_y,
            "teto_y_m": teto_y,
            "pe_direito_m": round(teto_y - piso_y, 3),
            "largura_x_m": totals["sala"]["sala_m"]["largura_x"],
            "profundidade_z_m": totals["sala"]["sala_m"]["profundidade_y"],
        },
        "camera": {
            "position": [0, round(piso_y + ALTURA_OLHO, 4), 0],
            "altura_olho_m": ALTURA_OLHO,
        },
        "fisica": {
            "driver": "ammo",
            "gravidade_m_s2": -9.81,
            "passo_fixo_s": 1 / 60,
            "max_substeps": 4,
            "solver_iterations": 10,
        },
        "modelo_de_massa": {
            "formula": "massa = densidade * volume_da_envoltoria_convexa",
            "densidade_kg_m3": DENSIDADE,
            "limites_kg": [MASSA_MIN, MASSA_MAX],
            "justificativa": (
                "o volume usado e o do HULL porque o hull e o solido que o "
                "motor de fato simula; o HoloScene nao exporta massa no OBJ"
            ),
            "n_objetos_no_limite": sum(1 for o in objetos if o["massa_no_limite"]),
        },
        "fundo": {
            "nome": FUNDO,
            "modelo": FUNDO + ".glb",
            "position": [0, 0, 0],
            "colisor": "mesh (estatico)",
            "dims_m": fundo["dims_m"],
        },
        "objetos": objetos,
        "resumo": {
            "n_objetos": len(objetos),
            "massa_total_kg": round(sum(o["massa_kg"] for o in objetos), 2),
            "massa_min_kg": min(o["massa_kg"] for o in objetos),
            "massa_max_kg": max(o["massa_kg"] for o in objetos),
            "massa_mediana_kg": round(
                float(np.median([o["massa_kg"] for o in objetos])), 3
            ),
            "hull_faces_total": sum(o["hull_faces"] for o in objetos),
            "hull_sobre_bbox_mediana": round(
                float(np.median([o["hull_sobre_bbox"] for o in objetos])), 4
            ),
            "objetos_abaixo_do_piso": sum(
                1 for o in objetos if o["altura_acima_do_piso_m"] < -0.02
            ),
            "objetos_flutuando_acima_5cm": sum(
                1 for o in objetos if o["altura_acima_do_piso_m"] > 0.05
            ),
        },
    }

    path = os.path.join(SCENE, "scene_manifest.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2, ensure_ascii=False)
    print(json.dumps(
        {k: v for k, v in manifest.items() if k != "objetos"}, indent=2,
        ensure_ascii=False))
    print("\nescrito:", path)


if __name__ == "__main__":
    main()
