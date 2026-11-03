"""
Etapa 5b - Analise da estabilidade fisica.

Cruza o deslocamento medido de cada objeto (results/stability_*.csv) com a
geometria inicial (scene/scene_manifest.json) para responder:
  - quais objetos nao ficam em equilibrio sob gravidade;
  - se a queda se explica por penetracao inicial no piso, por flutuacao, ou
    por buracos na malha do fundo;
  - quao repetivel e o resultado entre as 3 repeticoes.

Escreve results/stability_summary.csv e results/stability_summary.json
"""

import csv
import glob
import json
import os
from collections import defaultdict

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RESULTS = os.path.join(ROOT, "results")

CENARIOS = [
    "original_com_fisica",
    "otimizado_com_fisica",
    "original_com_fisica_depenetrado",
]


def main():
    with open(os.path.join(ROOT, "scene", "scene_manifest.json"), encoding="utf-8") as fh:
        man = json.load(fh)
    piso = man["sala"]["piso_y_m"]
    info = {o["nome"]: o for o in man["objetos"]}

    # agrega as repeticoes por cenario e objeto
    dados = defaultdict(lambda: defaultdict(list))
    for cen in CENARIOS:
        for path in sorted(glob.glob(os.path.join(RESULTS, f"stability_{cen}_r*.csv"))):
            with open(path, encoding="utf-8") as fh:
                for row in csv.DictReader(fh):
                    dados[cen][row["nome"]].append(row)

    linhas = []
    for cen in CENARIOS:
        for nome, reps in dados[cen].items():
            desl = [float(r["deslocamento_m"]) for r in reps]
            yfin = [float(r["y1"]) for r in reps]
            queda = [float(r["queda_y_m"]) for r in reps]
            o = info[nome]
            base0 = o["base_y_m"]
            linhas.append({
                "cenario": cen,
                "nome": nome,
                "n_rep": len(reps),
                "massa_kg": o["massa_kg"],
                "dim_max_m": round(max(o["dims_m"]), 4),
                "hull_volume_m3": o["hull_volume_m3"],
                "base_inicial_y": base0,
                "folga_inicial_ao_piso_m": round(base0 - piso, 4),
                "penetrava_o_piso": base0 < piso - 0.02,
                "flutuava_acima_5cm": base0 - piso > 0.05,
                "desloc_media_m": round(float(np.mean(desl)), 4),
                "desloc_desvio_m": round(float(np.std(desl, ddof=1)) if len(desl) > 1 else 0.0, 4),
                "queda_media_m": round(float(np.mean(queda)), 4),
                "y_final_medio": round(float(np.mean(yfin)), 4),
                "abaixo_do_piso_final": bool(np.mean(yfin) < piso - 0.5),
                "estavel_10cm": bool(np.mean(desl) <= 0.10),
            })

    linhas.sort(key=lambda r: (r["cenario"], -r["desloc_media_m"]))
    path = os.path.join(RESULTS, "stability_summary.csv")
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(linhas[0]))
        w.writeheader()
        w.writerows(linhas)

    resumo = {"piso_y_m": piso, "por_cenario": {}}
    for cen in CENARIOS:
        ls = [r for r in linhas if r["cenario"] == cen]
        d = [r["desloc_media_m"] for r in ls]
        caidos = [r for r in ls if r["abaixo_do_piso_final"]]
        estaveis = [r for r in ls if r["estavel_10cm"]]
        resumo["por_cenario"][cen] = {
            "n_objetos": len(ls),
            "desloc_mediano_m": round(float(np.median(d)), 4),
            "desloc_medio_m": round(float(np.mean(d)), 4),
            "desloc_max_m": round(float(np.max(d)), 4),
            "repetibilidade_desvio_mediano_m": round(
                float(np.median([r["desloc_desvio_m"] for r in ls])), 5),
            "n_estaveis_ate_10cm": len(estaveis),
            "n_caidos_abaixo_do_piso": len(caidos),
            "nomes_caidos": [r["nome"] for r in caidos],
            "n_que_penetravam_o_piso": sum(1 for r in ls if r["penetrava_o_piso"]),
            "n_que_flutuavam": sum(1 for r in ls if r["flutuava_acima_5cm"]),
            # os que cairam penetravam o piso de inicio?
            "caidos_que_penetravam": sum(1 for r in caidos if r["penetrava_o_piso"]),
            "caidos_que_flutuavam": sum(1 for r in caidos if r["flutuava_acima_5cm"]),
        }

    # correlacao entre folga inicial e deslocamento
    ls = [r for r in linhas if r["cenario"] == "original_com_fisica"]
    folga = np.array([r["folga_inicial_ao_piso_m"] for r in ls])
    desl = np.array([r["desloc_media_m"] for r in ls])
    resumo["correlacao_folga_inicial_vs_deslocamento"] = round(
        float(np.corrcoef(folga, desl)[0, 1]), 4)
    massa = np.array([r["massa_kg"] for r in ls])
    resumo["correlacao_massa_vs_deslocamento"] = round(
        float(np.corrcoef(massa, desl)[0, 1]), 4)

    with open(os.path.join(RESULTS, "stability_summary.json"), "w", encoding="utf-8") as fh:
        json.dump(resumo, fh, indent=2, ensure_ascii=False)
    print(json.dumps(resumo, indent=2, ensure_ascii=False))

    print("\n-- 10 maiores deslocamentos (original) --")
    for r in ls[:10]:
        print(f"  {r['nome']:11} desloc {r['desloc_media_m']:7.3f} ±{r['desloc_desvio_m']:.3f} m  "
              f"massa {r['massa_kg']:5.1f} kg  folga inicial {r['folga_inicial_ao_piso_m']:+.3f} m  "
              f"{'CAIU' if r['abaixo_do_piso_final'] else ''}")
    print("\nescrito:", path)


if __name__ == "__main__":
    main()
