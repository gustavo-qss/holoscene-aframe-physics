"""
Etapa 7 - O que os USD do HoloScene carregam que o OBJ nao carrega.

Motivacao: a avaliacao original usou apenas os surface_*.obj do Stage 3 e,
como o OBJ nao transporta propriedades fisicas, o modelo de massa teve de ser
inventado (densidade 200 kg/m3 x volume da envoltoria convexa). Mas a saida
tambem traz usd/obj_*.usd, e uma varredura de tokens mostrou esquemas
UsdPhysics em 28/28 arquivos. Este script le os valores de fato e compara com
o que foi estimado.

Escreve results/usd_physics.csv e results/usd_physics.json
"""

import csv
import json
import os

import numpy as np
from pxr import Usd, UsdGeom, UsdPhysics, UsdShade

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RESULTS = os.path.join(ROOT, "results")
USD_DIR = os.environ.get(
    "HOLOSCENE_USD", r"C:\Users\lurik\Downloads\saidas\usd"
)


def attrs_de(prim):
    """Todos os atributos physics:* de um prim, com valor."""
    out = {}
    for a in prim.GetAttributes():
        n = a.GetName()
        if not n.startswith("physics:"):
            continue
        v = a.Get()
        if v is None:
            out[n] = None
        elif hasattr(v, "__len__") and not isinstance(v, str):
            out[n] = [float(x) for x in v]
        else:
            out[n] = float(v) if isinstance(v, (int, float)) else str(v)
    return out


def esquemas(prim):
    return [str(s) for s in prim.GetAppliedSchemas()]


def main():
    arquivos = sorted(
        (f for f in os.listdir(USD_DIR) if f.endswith(".usd")),
        key=lambda s: int(s.split("_")[1].split(".")[0]),
    )

    linhas = []
    estrutura_exemplo = None
    for f in arquivos:
        caminho = os.path.join(USD_DIR, f)
        stage = Usd.Stage.Open(caminho)
        if stage is None:
            linhas.append({"arquivo": f, "erro": "nao abriu"})
            continue

        linha = {"arquivo": f, "indice": int(f.split("_")[1].split(".")[0])}
        linha["metros_por_unidade"] = UsdGeom.GetStageMetersPerUnit(stage)
        linha["eixo_up"] = str(UsdGeom.GetStageUpAxis(stage))

        prims = list(stage.Traverse())
        linha["n_prims"] = len(prims)
        linha["tipos"] = ";".join(sorted({p.GetTypeName() for p in prims if p.GetTypeName()}))

        todos_phys = {}
        esq = set()
        n_tri = 0
        for p in prims:
            esq.update(esquemas(p))
            todos_phys.update(attrs_de(p))
            if p.IsA(UsdGeom.Mesh):
                m = UsdGeom.Mesh(p)
                counts = m.GetFaceVertexCountsAttr().Get()
                if counts:
                    n_tri += sum(max(0, c - 2) for c in counts)
        linha["esquemas"] = ";".join(sorted(esq))
        linha["triangulos"] = n_tri

        # colocacao na cena: o USD traz rotacao e translacao como xformOps
        for p in prims:
            x = UsdGeom.Xformable(p)
            if not x or p.GetPath() == "/World":
                continue
            ops = [o.GetOpName() for o in x.GetOrderedXformOps()]
            if not ops:
                continue
            t = x.GetLocalTransformation().ExtractTranslation()
            linha["xform_ops"] = ";".join(ops)
            linha["usd_translate"] = [round(float(v), 6) for v in t]
            break

        # os atributos que importam
        linha["mass"] = todos_phys.get("physics:mass")
        linha["density"] = todos_phys.get("physics:density")
        linha["centerOfMass"] = todos_phys.get("physics:centerOfMass")
        linha["diagonalInertia"] = todos_phys.get("physics:diagonalInertia")
        linha["principalAxes"] = todos_phys.get("physics:principalAxes")
        linha["approximation"] = todos_phys.get("physics:approximation")
        linha["collisionEnabled"] = todos_phys.get("physics:collisionEnabled")
        linha["rigidBodyEnabled"] = todos_phys.get("physics:rigidBodyEnabled")
        linha["kinematicEnabled"] = todos_phys.get("physics:kinematicEnabled")
        linha["todos_physics"] = json.dumps(todos_phys, ensure_ascii=False)

        if estrutura_exemplo is None and linha["indice"] == 5:
            estrutura_exemplo = [
                {
                    "caminho": str(p.GetPath()),
                    "tipo": str(p.GetTypeName()),
                    "esquemas": esquemas(p),
                    "physics": attrs_de(p),
                }
                for p in prims
            ]

        linhas.append(linha)

    path = os.path.join(RESULTS, "usd_physics.csv")
    cols = []
    for l in linhas:
        for k in l:
            if k not in cols:
                cols.append(k)
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=cols)
        w.writeheader()
        w.writerows(linhas)

    # ---- comparacao com o que foi estimado no manifesto ----
    comparacao = []
    manifesto = os.path.join(ROOT, "scene", "scene_manifest.json")
    if os.path.exists(manifesto):
        with open(manifesto, encoding="utf-8") as fh:
            man = json.load(fh)
        fator = man["fator_escala"]
        por_indice = {int(o["nome"].split("_")[1]): o for o in man["objetos"]}
        for l in linhas:
            i = l.get("indice")
            if i in por_indice and l.get("mass") is not None:
                est = por_indice[i]["massa_kg"]
                real = l["mass"]
                item = {
                    "indice": i,
                    "massa_usd_kg": round(real, 4),
                    "massa_estimada_kg": est,
                    "razao_estimada_sobre_usd": round(est / real, 3) if real else None,
                    "erro_absoluto_kg": round(est - real, 3),
                }
                # validacao cruzada da colocacao: a position que derivamos
                # (metrica) dividida pelo fator deve bater com o translate do USD
                t = l.get("usd_translate")
                if t:
                    nossa = [round(v / fator, 6) for v in por_indice[i]["position"]]
                    item["usd_translate"] = t
                    item["nossa_position_em_unidades"] = nossa
                    item["delta_unidades"] = [
                        round(abs(a - b), 6) for a, b in zip(t, nossa)
                    ]
                comparacao.append(item)

    com_massa = [l for l in linhas if l.get("mass") is not None]
    resumo = {
        "fonte": USD_DIR,
        "n_arquivos": len(linhas),
        "metros_por_unidade": sorted({l.get("metros_por_unidade") for l in linhas}),
        "eixo_up": sorted({str(l.get("eixo_up")) for l in linhas}),
        "esquemas_observados": sorted({e for l in linhas
                                       for e in (l.get("esquemas") or "").split(";") if e}),
        "n_com_physics_mass": len(com_massa),
        "n_com_density": sum(1 for l in linhas if l.get("density") is not None),
        "n_com_inertia": sum(1 for l in linhas if l.get("diagonalInertia") is not None),
        "n_com_approximation": sum(1 for l in linhas if l.get("approximation") is not None),
        "massas_usd_kg": {
            str(l["indice"]): round(l["mass"], 4) for l in com_massa
        },
    }
    if com_massa:
        ms = [l["mass"] for l in com_massa]
        resumo["massa_usd_min"] = round(min(ms), 4)
        resumo["massa_usd_max"] = round(max(ms), 4)
        resumo["massa_usd_mediana"] = round(float(np.median(ms)), 4)
        resumo["massa_usd_total"] = round(sum(ms), 3)
    if comparacao:
        razoes = [c["razao_estimada_sobre_usd"] for c in comparacao
                  if c["razao_estimada_sobre_usd"]]
        cmp_out = {
            "n": len(comparacao),
            "massa_total_estimada_kg": round(
                sum(c["massa_estimada_kg"] for c in comparacao), 2),
            "massa_total_usd_kg": round(sum(c["massa_usd_kg"] for c in comparacao), 2),
            "n_massas_usd_zeradas": sum(1 for c in comparacao
                                        if not c["massa_usd_kg"]),
        }
        if razoes:
            cmp_out["razao_mediana"] = round(float(np.median(razoes)), 3)
            cmp_out["razao_min"] = round(min(razoes), 3)
            cmp_out["razao_max"] = round(max(razoes), 3)
        else:
            cmp_out["observacao"] = (
                "nenhuma razao calculavel: todas as massas do USD valem 0, "
                "ou seja o atributo physics:mass esta presente mas nao autorado"
            )
        deltas = [d for c in comparacao for d in (c.get("delta_unidades") or [])]
        if deltas:
            cmp_out["validacao_colocacao"] = {
                "n_objetos": sum(1 for c in comparacao if c.get("delta_unidades")),
                "delta_mediano_unidades": round(float(np.median(deltas)), 6),
                "delta_max_unidades": round(float(np.max(deltas)), 6),
                "delta_max_em_cm_metricos": round(
                    float(np.max(deltas)) * fator * 100, 2),
                "nota": (
                    "compara o xformOp:translate do USD com a position que "
                    "derivamos do OBJ (centro da bbox), dividida pelo fator de "
                    "escala adotado. Concordancia confirma que OBJ e USD estao "
                    "no mesmo referencial e que a colocacao foi derivada "
                    "corretamente; o residuo e a diferenca entre pivo do USD e "
                    "centro da caixa envolvente."
                ),
            }
        resumo["comparacao_com_estimativa"] = cmp_out
        resumo["detalhe_comparacao"] = comparacao
    if estrutura_exemplo:
        resumo["estrutura_exemplo_obj_5"] = estrutura_exemplo

    with open(os.path.join(RESULTS, "usd_physics.json"), "w", encoding="utf-8") as fh:
        json.dump(resumo, fh, indent=2, ensure_ascii=False)

    print(json.dumps({k: v for k, v in resumo.items()
                      if k not in ("estrutura_exemplo_obj_5", "detalhe_comparacao",
                                   "massas_usd_kg")},
                     indent=2, ensure_ascii=False))
    print("\n-- estrutura de usd/obj_5.usd --")
    for p in (estrutura_exemplo or []):
        print(f"  {p['caminho']:38} {p['tipo']:10} {p['esquemas']}")
        for k, v in p["physics"].items():
            print(f"       {k} = {v}")
    print("\nescrito:", path)


if __name__ == "__main__":
    main()
