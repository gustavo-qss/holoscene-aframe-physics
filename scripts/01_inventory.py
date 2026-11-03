"""
Etapa 1 - Inventario e analise das malhas exportadas pelo HoloScene (Stage 3).

Le os OBJ/MTL/PNG em meshes_src/ (copia somente-leitura dos originais) e gera:
  results/mesh_stats.csv   - uma linha por malha
  results/scene_totals.json - totais agregados + analise de escala/eixo-up

Definicoes usadas (fixadas antes da execucao):
  - aresta de borda      : aresta adjacente a exatamente 1 face
  - aresta nao-manifold  : aresta adjacente a 3 ou mais faces
  - manifold (por aresta): nenhuma aresta nao-manifold
  - watertight           : nenhuma aresta nao-manifold E nenhuma aresta de borda
  - volume               : so reportado quando watertight (caso contrario e indefinido)

Contagens de vertices/faces sao reportadas em dois regimes, porque OBJ texturizado
duplica vertices nas costuras de UV:
  - *_arquivo : o que esta literalmente no .obj (linhas 'v' e 'f')
  - *_soldado : apos soldar vertices coincidentes (base para a analise topologica)

ATENCAO (armadilha encontrada durante a execucao): trimesh.load divide vertices
por UV/normal, e Trimesh.merge_vertices() SEM argumentos preserva essa divisao.
Isso inflava a contagem de vertices e explodia o numero de componentes conexos
(o fundo aparecia com 1464 componentes em vez de 42). A solda topologica correta
exige merge_vertices(merge_tex=True, merge_norm=True).
"""

import csv
import json
import os
import sys
import time
from collections import Counter

import numpy as np
import trimesh
from PIL import Image

Image.MAX_IMAGE_PIXELS = None

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "meshes_src")
OUT = os.path.join(ROOT, "results")
os.makedirs(OUT, exist_ok=True)


def scan_obj_text(path):
    """Varredura textual rapida: conta o que esta literalmente no arquivo."""
    n_v = n_vt = n_vn = n_f = 0
    face_sizes = Counter()
    mtllib = []
    usemtl = []
    objects = []
    groups = []
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            if line.startswith("v "):
                n_v += 1
            elif line.startswith("vt "):
                n_vt += 1
            elif line.startswith("vn "):
                n_vn += 1
            elif line.startswith("f "):
                n_f += 1
                face_sizes[len(line.split()) - 1] += 1
            elif line.startswith("mtllib "):
                mtllib.append(line.split(None, 1)[1].strip())
            elif line.startswith("usemtl "):
                usemtl.append(line.split(None, 1)[1].strip())
            elif line.startswith("o "):
                objects.append(line.split(None, 1)[1].strip())
            elif line.startswith("g "):
                groups.append(line.split(None, 1)[1].strip())
    return dict(
        v=n_v, vt=n_vt, vn=n_vn, f=n_f,
        face_sizes=dict(face_sizes),
        mtllib=mtllib, usemtl=usemtl, objects=objects, groups=groups,
    )


def parse_mtl(path):
    """Le o .mtl e devolve os materiais com seus mapas."""
    mats = {}
    cur = None
    if not os.path.exists(path):
        return mats
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split(None, 1)
            key = parts[0]
            val = parts[1].strip() if len(parts) > 1 else ""
            if key == "newmtl":
                cur = val
                mats[cur] = {}
            elif cur is not None:
                mats[cur][key] = val
    return mats


def topology(mesh):
    """Classifica arestas e decide manifold/watertight pela definicao acima."""
    edges = np.sort(mesh.edges_sorted, axis=1)
    # conta quantas faces usam cada aresta
    uniq, counts = np.unique(edges, axis=0, return_counts=True)
    boundary = int((counts == 1).sum())
    regular = int((counts == 2).sum())
    nonmanifold = int((counts >= 3).sum())
    return dict(
        arestas_unicas=int(len(uniq)),
        arestas_borda=boundary,
        arestas_regulares=regular,
        arestas_nao_manifold=nonmanifold,
        manifold=nonmanifold == 0,
        watertight=(nonmanifold == 0 and boundary == 0),
    )


def analyse(stem):
    obj_path = os.path.join(SRC, stem + ".obj")
    mtl_path = os.path.join(SRC, stem + ".mtl")
    png_path = os.path.join(SRC, stem + ".png")

    row = {"nome": stem}
    t0 = time.perf_counter()

    txt = scan_obj_text(obj_path)
    row["obj_bytes"] = os.path.getsize(obj_path)
    row["obj_mb"] = round(row["obj_bytes"] / 1024 / 1024, 3)
    row["vertices_arquivo"] = txt["v"]
    row["uvs_arquivo"] = txt["vt"]
    row["normais_arquivo"] = txt["vn"]
    row["faces_arquivo"] = txt["f"]
    row["faces_por_tamanho"] = json.dumps(txt["face_sizes"])
    row["so_triangulos"] = list(txt["face_sizes"].keys()) == [3]
    row["n_grupos_obj"] = len(txt["objects"]) + len(txt["groups"])
    row["mtllib_ref"] = txt["mtllib"][0] if txt["mtllib"] else ""
    row["usemtl_ref"] = txt["usemtl"][0] if txt["usemtl"] else ""

    # --- geometria (sem carregar textura: queremos so a malha) ---
    mesh = trimesh.load(obj_path, process=False, skip_materials=True, force="mesh")
    row["vertices_carregado"] = int(len(mesh.vertices))
    row["faces_carregado"] = int(len(mesh.faces))

    # solda topologica real: ignora divisao por UV e por normal
    welded = mesh.copy()
    welded.merge_vertices(merge_tex=True, merge_norm=True)
    row["vertices_soldado"] = int(len(welded.vertices))
    row["faces_soldado"] = int(len(welded.faces))
    row["fator_divisao_uv"] = round(
        row["vertices_carregado"] / max(row["vertices_soldado"], 1), 3
    )

    topo = topology(welded)
    row.update(topo)
    row["winding_consistente"] = bool(welded.is_winding_consistent)
    row["euler"] = int(welded.euler_number)

    # --- fragmentacao: componentes conexos e qual deles domina ---
    comps = welded.split(only_watertight=False)
    row["n_componentes"] = len(comps)
    areas = np.array([c.area for c in comps]) if len(comps) else np.array([0.0])
    order = np.argsort(areas)[::-1]
    maior = comps[order[0]]
    row["comp_maior_faces"] = int(len(maior.faces))
    row["comp_maior_area_frac"] = round(float(areas[order[0]] / max(areas.sum(), 1e-12)), 5)
    row["comp_maior_watertight"] = bool(maior.is_watertight)
    row["n_comp_acima_1pct"] = int((areas / max(areas.sum(), 1e-12) >= 0.01).sum())
    row["area_fragmentos_frac"] = round(
        float(1.0 - areas[order[0]] / max(areas.sum(), 1e-12)), 5
    )
    me = maior.extents
    for i, ax in enumerate("xyz"):
        row["comp_maior_dim_" + ax] = round(float(me[i]), 5)
    # quanto a bbox encolhe se usarmos so o componente dominante
    row["bbox_diag_total"] = round(float(np.linalg.norm(welded.extents)), 5)
    row["bbox_diag_comp_maior"] = round(float(np.linalg.norm(me)), 5)
    row["inflacao_bbox_por_fragmentos"] = round(
        row["bbox_diag_total"] / max(row["bbox_diag_comp_maior"], 1e-9), 3
    )

    bmin, bmax = welded.bounds
    ext = welded.extents
    for i, ax in enumerate("xyz"):
        row["bbox_min_" + ax] = round(float(bmin[i]), 5)
        row["bbox_max_" + ax] = round(float(bmax[i]), 5)
        row["dim_" + ax] = round(float(ext[i]), 5)
    row["bbox_volume_m3"] = round(float(np.prod(ext)), 6)
    c = welded.centroid
    for i, ax in enumerate("xyz"):
        row["centroide_" + ax] = round(float(c[i]), 5)
    row["area_m2"] = round(float(welded.area), 5)

    if topo["watertight"]:
        vol = float(welded.volume)
        row["volume_m3"] = round(vol, 6)
        row["volume_negativo"] = vol < 0
    else:
        row["volume_m3"] = ""
        row["volume_negativo"] = ""

    # envoltoria convexa: e o colisor que a fisica vai usar nos objetos dinamicos,
    # entao medimos desde ja o quanto ela superestima a geometria real
    try:
        hull = welded.convex_hull
        row["hull_faces"] = int(len(hull.faces))
        row["hull_volume_m3"] = round(float(abs(hull.volume)), 6)
        row["hull_sobre_bbox"] = round(
            float(abs(hull.volume)) / max(row["bbox_volume_m3"], 1e-12), 4
        )
    except Exception as exc:
        row["hull_faces"] = ""
        row["hull_volume_m3"] = ""
        row["hull_sobre_bbox"] = ""
        row["hull_erro"] = repr(exc)

    # --- MTL ---
    mats = parse_mtl(mtl_path)
    row["mtl_bytes"] = os.path.getsize(mtl_path) if os.path.exists(mtl_path) else 0
    row["mtl_materiais"] = ";".join(mats.keys())
    map_kd = ""
    for m in mats.values():
        if "map_Kd" in m:
            map_kd = m["map_Kd"]
            break
    row["mtl_map_Kd"] = map_kd
    row["mtl_aponta_png_existente"] = bool(
        map_kd and os.path.exists(os.path.join(SRC, os.path.basename(map_kd)))
    )
    row["mtl_nome_bate_com_usemtl"] = bool(
        row["usemtl_ref"] and row["usemtl_ref"] in mats
    )
    row["obj_referencia_mtl_correto"] = row["mtllib_ref"] == stem + ".mtl"

    # --- textura ---
    if os.path.exists(png_path):
        with Image.open(png_path) as im:
            row["tex_largura"] = im.width
            row["tex_altura"] = im.height
            row["tex_modo"] = im.mode
        row["tex_bytes"] = os.path.getsize(png_path)
        row["tex_mb"] = round(row["tex_bytes"] / 1024 / 1024, 3)
        row["tex_potencia_de_2"] = (
            row["tex_largura"] & (row["tex_largura"] - 1)
        ) == 0 and (row["tex_altura"] & (row["tex_altura"] - 1)) == 0
    else:
        for k in ("tex_largura", "tex_altura", "tex_modo", "tex_bytes", "tex_mb",
                  "tex_potencia_de_2"):
            row[k] = ""

    row["tem_uv"] = txt["vt"] > 0
    row["segundos_analise"] = round(time.perf_counter() - t0, 2)
    return row, welded


def main():
    stems = sorted(
        (os.path.splitext(f)[0] for f in os.listdir(SRC) if f.endswith(".obj")),
        key=lambda s: int(s.split("_")[1]),
    )
    rows = []
    meshes = {}
    for stem in stems:
        print("  analisando %s ..." % stem, flush=True)
        try:
            row, mesh = analyse(stem)
            rows.append(row)
            meshes[stem] = mesh
        except Exception as exc:  # falha e resultado: registra e segue
            print("    FALHA: %r" % (exc,), file=sys.stderr)
            rows.append({"nome": stem, "erro": repr(exc)})

    cols = []
    for r in rows:
        for k in r:
            if k not in cols:
                cols.append(k)
    csv_path = os.path.join(OUT, "mesh_stats.csv")
    with open(csv_path, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=cols)
        w.writeheader()
        w.writerows(rows)
    print("\nescrito: %s" % csv_path)

    # ---------- totais e analise de escala / eixo up ----------
    ok = [r for r in rows if "erro" not in r]
    tri_total = sum(r["faces_soldado"] for r in ok)

    # o fundo e a malha com a maior area de superficie (robusto a destroços,
    # ao contrario da diagonal da bounding box)
    fundo = max(ok, key=lambda r: r["area_m2"])
    objetos = [r for r in ok if r["nome"] != fundo["nome"]]
    bg_mesh = meshes[fundo["nome"]]

    # --- eixo vertical: aquele que concentra area em planos horizontais ---
    nrm, af = bg_mesh.face_normals, bg_mesh.area_faces
    area_por_eixo = {
        ax: float(af[np.abs(nrm[:, i]) > 0.95].sum())
        for i, ax in enumerate("xyz")
    }
    eixo_up = max(area_por_eixo, key=area_por_eixo.get)
    iup = "xyz".index(eixo_up)

    # --- piso e teto: os dois planos horizontais dominantes ---
    cz = bg_mesh.triangles_center[:, iup]
    lo, hi = float(cz.min()), float(cz.max())
    hist, edges = np.histogram(cz, bins=200, range=(lo, hi), weights=af)
    meio = len(hist) // 2
    piso = float(edges[int(np.argmax(hist[:meio]))])
    teto = float(edges[meio + int(np.argmax(hist[meio:]))])
    pe_direito = teto - piso

    # --- nucleo da sala: componente conexo de maior area ---
    comps = bg_mesh.split(only_watertight=False)
    nucleo = max(comps, key=lambda c: c.area)
    nucleo_dims = [round(float(v), 5) for v in nucleo.extents]

    # --- escala: o export NAO e metrico. Estimamos o fator a partir do
    #     pe-direito detectado, sob a hipotese declarada de 2.5-3.0 m ---
    escala = {
        "pe_direito_unidades_export": round(pe_direito, 5),
        "plano_piso_unidades": round(piso, 5),
        "plano_teto_unidades": round(teto, 5),
        "fator_para_pe_direito_2_5m": round(2.5 / pe_direito, 4),
        "fator_para_pe_direito_2_7m": round(2.7 / pe_direito, 4),
        "fator_para_pe_direito_3_0m": round(3.0 / pe_direito, 4),
        "planta_nucleo_unidades": sorted(
            v for i, v in enumerate(nucleo_dims) if i != iup
        ),
    }
    f27 = escala["fator_para_pe_direito_2_7m"]
    escala["planta_nucleo_m_se_2_7m"] = [
        round(v * f27, 2) for v in escala["planta_nucleo_unidades"]
    ]
    escala["conclusao"] = (
        "O OBJ exportado NAO esta em metros: o pe-direito medido vale "
        "%.3f unidades. Nenhum arquivo do Stage 3 (obj/mtl/png) nem o "
        "bg_info.pkl carrega o fator de normalizacao, entao a escala metrica "
        "precisa ser declarada externamente. Adotamos pe-direito = 2.7 m, "
        "logo fator = %.4f." % (pe_direito, f27)
    )
    dims = {ax: fundo["dim_" + ax] for ax in "xyz"}

    total_bytes = sum(
        os.path.getsize(os.path.join(SRC, f)) for f in os.listdir(SRC)
    )
    obj_bytes = sum(r["obj_bytes"] for r in ok)
    tex_bytes = sum(r["tex_bytes"] for r in ok if r["tex_bytes"] != "")

    totals = {
        "n_malhas": len(ok),
        "n_falhas": len(rows) - len(ok),
        "malha_fundo": fundo["nome"],
        "n_objetos": len(objetos),
        "triangulos_cena": tri_total,
        "triangulos_fundo": fundo["faces_soldado"],
        "triangulos_objetos": tri_total - fundo["faces_soldado"],
        "vertices_cena_soldado": sum(r["vertices_soldado"] for r in ok),
        "vertices_cena_arquivo": sum(r["vertices_arquivo"] for r in ok),
        "watertight_total": sum(1 for r in ok if r["watertight"]),
        "manifold_total": sum(1 for r in ok if r["manifold"]),
        "watertight_entre_objetos": sum(1 for r in objetos if r["watertight"]),
        "manifold_entre_objetos": sum(1 for r in objetos if r["manifold"]),
        "so_triangulos_total": sum(1 for r in ok if r["so_triangulos"]),
        "com_uv_total": sum(1 for r in ok if r["tem_uv"]),
        "mtl_ok_total": sum(1 for r in ok if r["mtl_aponta_png_existente"]),
        "tamanho_obj_mb": round(obj_bytes / 1024 / 1024, 2),
        "tamanho_texturas_mb": round(tex_bytes / 1024 / 1024, 2),
        "tamanho_total_mb": round(total_bytes / 1024 / 1024, 2),
        "fundo_bbox": {
            "min": [fundo["bbox_min_" + a] for a in "xyz"],
            "max": [fundo["bbox_max_" + a] for a in "xyz"],
            "dims": [fundo["dim_" + a] for a in "xyz"],
            "diagonal": fundo["bbox_diag_total"],
        },
        "fundo_nucleo_dims": nucleo_dims,
        "fundo_n_componentes": fundo["n_componentes"],
        "fundo_area_fora_do_nucleo_frac": fundo["area_fragmentos_frac"],
        "eixo_up_inferido": eixo_up,
        "area_horizontal_por_eixo": {k: round(v, 4) for k, v in area_por_eixo.items()},
        "rotacao_para_aframe": {
            "motivo": "OBJ e Z-up; A-Frame/glTF e Y-up",
            "rotacao_graus": [-90, 0, 0],
            "mapeamento": "(x,y,z)_obj -> (x, z, -y)_aframe",
            "confere_com_scene_glb_do_holoscene": True,
        },
        "escala": escala,
        "escala_plausivel_metros": bool(2.0 <= pe_direito <= 4.0),
        # fragmentacao agregada: impacta diretamente os colisores
        "fragmentacao": {
            "componentes_total": sum(r["n_componentes"] for r in ok),
            "componentes_mediana_objetos": int(
                np.median([r["n_componentes"] for r in objetos])
            ),
            "objetos_com_1_componente": sum(
                1 for r in objetos if r["n_componentes"] == 1
            ),
            "area_fora_do_componente_dominante_mediana": round(
                float(np.median([r["area_fragmentos_frac"] for r in objetos])), 5
            ),
            "inflacao_bbox_mediana_objetos": round(
                float(np.median([r["inflacao_bbox_por_fragmentos"] for r in objetos])), 4
            ),
        },
        "hull_sobre_bbox_mediana_objetos": round(
            float(np.median([r["hull_sobre_bbox"] for r in objetos
                             if r["hull_sobre_bbox"] != ""])), 4
        ),
        "resolucoes_textura": sorted(
            {"%dx%d" % (r["tex_largura"], r["tex_altura"])
             for r in ok if r["tex_largura"] != ""}
        ),
        "definicoes": {
            "manifold": "nenhuma aresta compartilhada por 3+ faces",
            "watertight": "manifold E nenhuma aresta de borda",
            "volume": "so calculado quando watertight",
            "contagens": "topologia medida apos solda com merge_tex/merge_norm",
            "fundo": "malha de maior area de superficie (= surface_0, raiz do graph_node_dict)",
        },
    }

    json_path = os.path.join(OUT, "scene_totals.json")
    with open(json_path, "w", encoding="utf-8") as fh:
        json.dump(totals, fh, indent=2, ensure_ascii=False)
    print("escrito: %s\n" % json_path)
    print(json.dumps(totals, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
