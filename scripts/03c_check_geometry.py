"""
Etapa 3c - Saude numerica da geometria entregue ao motor de fisica.

Motivo: a execucao com fisica emitiu
  RuntimeError: float unrepresentable in integer range
que e um trap do WASM ao converter float para inteiro. No Bullet isso aparece
tipicamente quando a malha tem NaN/Inf, triangulos degenerados ou uma AABB
desproporcional (a BVH quantiza as coordenadas em inteiros de 16 bits).

Verifica, para cada GLB centrado: NaN/Inf, vertices repetidos em triangulo,
area nula, razao de aspecto da AABB e extremos de coordenada.

Escreve results/geometry_health.csv
"""

import csv
import json
import os

import numpy as np
import trimesh

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RESULTS = os.path.join(ROOT, "results")
DIRS = {
    "original": os.path.join(ROOT, "scene", "models", "original_centered"),
    "optimized": os.path.join(ROOT, "scene", "models", "optimized_centered"),
}


def carregar(path):
    s = trimesh.load(path, process=False)
    return s.to_mesh() if isinstance(s, trimesh.Scene) else s


def main():
    rows = []
    for versao, d in DIRS.items():
        stems = sorted(
            (f[:-4] for f in os.listdir(d) if f.endswith(".glb")),
            key=lambda s: int(s.split("_")[1]),
        )
        for stem in stems:
            m = carregar(os.path.join(d, stem + ".glb"))
            v = np.asarray(m.vertices, dtype=np.float64)
            f = np.asarray(m.faces)

            nan = int(np.isnan(v).any(axis=1).sum())
            inf = int(np.isinf(v).any(axis=1).sum())
            finitos = v[np.isfinite(v).all(axis=1)]
            amax = float(np.abs(finitos).max()) if len(finitos) else 0.0

            # triangulos com vertices repetidos (indices iguais)
            deg_idx = int(
                ((f[:, 0] == f[:, 1]) | (f[:, 1] == f[:, 2]) | (f[:, 0] == f[:, 2])).sum()
            )
            # triangulos de area praticamente nula
            areas = m.area_faces
            deg_area = int((areas < 1e-12).sum())

            ext = m.extents
            razao = float(ext.max() / max(ext.min(), 1e-12))

            rows.append({
                "versao": versao,
                "nome": stem,
                "vertices": len(v),
                "faces": len(f),
                "vertices_nan": nan,
                "vertices_inf": inf,
                "coord_abs_max": round(amax, 4),
                "tri_indices_repetidos": deg_idx,
                "tri_area_nula": deg_area,
                "tri_area_min": float(areas.min()) if len(areas) else 0.0,
                "aabb_x": round(float(ext[0]), 4),
                "aabb_y": round(float(ext[1]), 4),
                "aabb_z": round(float(ext[2]), 4),
                "aabb_razao_aspecto": round(razao, 2),
                "saudavel": nan == 0 and inf == 0 and deg_idx == 0,
            })

    path = os.path.join(RESULTS, "geometry_health.csv")
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)

    resumo = {
        "n_malhas": len(rows),
        "com_nan": sum(1 for r in rows if r["vertices_nan"]),
        "com_inf": sum(1 for r in rows if r["vertices_inf"]),
        "com_tri_indices_repetidos": sum(1 for r in rows if r["tri_indices_repetidos"]),
        "com_tri_area_nula": sum(1 for r in rows if r["tri_area_nula"]),
        "total_tri_area_nula": sum(r["tri_area_nula"] for r in rows),
        "coord_abs_max_global": max(r["coord_abs_max"] for r in rows),
        "maior_razao_aspecto": max(r["aabb_razao_aspecto"] for r in rows),
        "malha_maior_razao": max(rows, key=lambda r: r["aabb_razao_aspecto"])["nome"],
        "todas_saudaveis": all(r["saudavel"] for r in rows),
    }
    with open(os.path.join(RESULTS, "geometry_health.json"), "w", encoding="utf-8") as fh:
        json.dump(resumo, fh, indent=2, ensure_ascii=False)
    print(json.dumps(resumo, indent=2, ensure_ascii=False))

    piores = sorted(rows, key=lambda r: -r["tri_area_nula"])[:8]
    print("\n-- malhas com mais triangulos de area nula --")
    for r in piores:
        print(f"  {r['versao']:10} {r['nome']:11} area_nula={r['tri_area_nula']:6} "
              f"area_min={r['tri_area_min']:.3e}  razao={r['aabb_razao_aspecto']}")
    print("\nescrito:", path)


if __name__ == "__main__":
    main()
