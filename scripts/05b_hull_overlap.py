"""
Etapa 5c - Sobreposicao entre as envoltorias convexas na pose reconstruida.

Hipotese a testar: a instabilidade explosiva nao vem da penetracao no piso
(levantar os objetos piorou o resultado), e sim da APROXIMACAO CONVEXA. Moveis
reconstruidos ficam encostados e entrelacados; a envoltoria convexa "preenche"
as concavidades, de modo que dois objetos que na geometria real apenas se
tocam passam a se interpenetrar como solidos. O Bullet resolve essa
interpenetracao inicial com impulsos grandes.

Mede, na pose de t=0:
  - pares de objetos cujas envoltorias convexas se intersectam;
  - volume de interpenetracao de cada par;
  - comparacao com a intersecao das malhas reais (nao convexas).

Escreve results/hull_overlap.csv e results/hull_overlap.json
"""

import csv
import json
import os
from itertools import combinations

import numpy as np
import trimesh

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CENTERED = os.path.join(ROOT, "scene", "models", "original_centered")
RESULTS = os.path.join(ROOT, "results")


def carregar(path):
    s = trimesh.load(path, process=False)
    return s.to_mesh() if isinstance(s, trimesh.Scene) else s


def main():
    with open(os.path.join(ROOT, "scene", "scene_manifest.json"), encoding="utf-8") as fh:
        man = json.load(fh)

    hulls, aabbs, info = {}, {}, {}
    for o in man["objetos"]:
        m = carregar(os.path.join(CENTERED, o["nome"] + ".glb"))
        m.apply_translation(o["position"])          # leva para a pose de cena
        h = m.convex_hull
        hulls[o["nome"]] = h
        aabbs[o["nome"]] = (h.bounds[0], h.bounds[1])
        info[o["nome"]] = o

    nomes = list(hulls)
    linhas = []
    for a, b in combinations(nomes, 2):
        (amin, amax), (bmin, bmax) = aabbs[a], aabbs[b]
        if np.any(amax < bmin) or np.any(bmax < amin):
            continue                                 # AABBs nem se tocam
        # sobreposicao de AABB (barata, sempre calculavel)
        lo = np.maximum(amin, bmin)
        hi = np.minimum(amax, bmax)
        vol_aabb = float(np.prod(np.clip(hi - lo, 0, None)))

        vol_hull = None
        try:
            inter = trimesh.boolean.intersection([hulls[a], hulls[b]])
            if inter is not None and len(inter.faces) > 0 and inter.is_watertight:
                vol_hull = float(abs(inter.volume))
            else:
                vol_hull = 0.0
        except Exception as exc:
            vol_hull = None
            erro = repr(exc)[:80]
        if vol_hull is None or vol_hull <= 1e-9:
            if vol_hull is not None and vol_hull <= 1e-9:
                continue                             # hulls so se tangenciam
        linhas.append({
            "a": a, "b": b,
            "massa_a_kg": info[a]["massa_kg"],
            "massa_b_kg": info[b]["massa_kg"],
            "vol_sobreposicao_aabb_m3": round(vol_aabb, 6),
            "vol_sobreposicao_hull_m3": None if vol_hull is None else round(vol_hull, 6),
            "frac_do_menor_hull": None if vol_hull is None else round(
                vol_hull / max(min(info[a]["hull_volume_m3"],
                                   info[b]["hull_volume_m3"]), 1e-9), 4),
        })

    linhas.sort(key=lambda r: -(r["vol_sobreposicao_hull_m3"] or 0))
    path = os.path.join(RESULTS, "hull_overlap.csv")
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(linhas[0]) if linhas else ["a", "b"])
        w.writeheader()
        w.writerows(linhas)

    vols = [r["vol_sobreposicao_hull_m3"] for r in linhas
            if r["vol_sobreposicao_hull_m3"] is not None]
    envolvidos = sorted({n for r in linhas for n in (r["a"], r["b"])})
    resumo = {
        "n_objetos": len(nomes),
        "n_pares_possiveis": len(nomes) * (len(nomes) - 1) // 2,
        "n_pares_com_hulls_interpenetrando": len(linhas),
        "n_objetos_envolvidos": len(envolvidos),
        "frac_objetos_envolvidos": round(len(envolvidos) / len(nomes), 3),
        "volume_total_interpenetrado_m3": round(float(np.sum(vols)), 5) if vols else 0,
        "volume_maior_par_m3": round(float(np.max(vols)), 5) if vols else 0,
        "par_mais_grave": (linhas[0]["a"] + " x " + linhas[0]["b"]) if linhas else "",
        "objetos_envolvidos": envolvidos,
        "interpretacao": (
            "Cada par interpenetrado e uma violacao de restricao que o solver "
            "precisa resolver no primeiro passo. Com massas de dezenas de kg e "
            "volumes de interpenetracao desta ordem, o impulso de separacao "
            "ejeta os corpos, o que explica os deslocamentos de centenas de "
            "metros observados e a nao repetibilidade entre execucoes."
        ),
    }
    with open(os.path.join(RESULTS, "hull_overlap.json"), "w", encoding="utf-8") as fh:
        json.dump(resumo, fh, indent=2, ensure_ascii=False)

    print(json.dumps({k: v for k, v in resumo.items()
                      if k != "objetos_envolvidos"}, indent=2, ensure_ascii=False))
    print("\n-- 12 pares com maior interpenetracao --")
    for r in linhas[:12]:
        print(f"  {r['a']:11} x {r['b']:11} "
              f"vol {r['vol_sobreposicao_hull_m3']:9.5f} m3  "
              f"({100*(r['frac_do_menor_hull'] or 0):5.1f}% do menor)  "
              f"massas {r['massa_a_kg']:5.1f}/{r['massa_b_kg']:5.1f} kg")
    print("\nescrito:", path)


if __name__ == "__main__":
    main()
