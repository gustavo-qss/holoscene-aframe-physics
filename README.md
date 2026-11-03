# HoloScene → A-Frame + física: avaliação reprodutível

Avaliação das malhas texturizadas produzidas pelo **HoloScene** (Xia et al., 2025) quanto ao
uso em uma aplicação web interativa com física, usando **A-Frame** e o driver **Ammo**
(Bullet via WebAssembly). Cena avaliada: `replica_room_0`, do dataset Replica.

Material de apoio de um TCC. O relatório completo está em
**[`results/RELATORIO.md`](results/RELATORIO.md)**.

---

## Conclusão em uma frase

As malhas **servem para renderização web** (28/28 convertem sem um único erro de validação,
0,40 ms por quadro com física num RTX 3060) e **não servem para física interativa sem
retrabalho**: partindo das poses reconstruídas a cena colapsa, porque **25 dos 27 objetos
(92,6%) já têm envoltórias convexas se interpenetrando no instante zero**.

**6 de 8 critérios pré-registrados foram aprovados.** Os 2 reprovados são justamente os de
plausibilidade física.

| | Sem física | Com física |
|---|---|---|
| Carga (original / otimizado) | 1012 ms / 381 ms | 1134 ms / 518 ms |
| Frametime | 0,24 ms / 0,28 ms | 0,40 ms / 0,40 ms |
| Deslocamento mediano em 10 s | — | **0,87 m** (limite: 0,10 m) |
| Objetos ejetados do mundo | — | **5 a 6** de 27 |

Três achados que valem destaque:

1. **O export do HoloScene não está em metros.** O fator de normalização não existe em
   nenhum arquivo entregue. Medi a sala pelos planos de parede e adotei pé-direito = 2,7 m,
   o que dá fator **7,13078** e uma sala de 7,51 × 4,37 × 2,70 m. É uma suposição declarada,
   isolada em uma única constante.
2. **São 27 objetos + 1 fundo**, não 28 objetos. Confirmado pelo `graph_node_dict.pkl`.
3. **Há um defeito na `three-to-ammo`** que quebra a integração silenciosamente — detalhado
   na [seção 6 do relatório](results/RELATORIO.md#6-defeito-encontrado-na-integração-e-sua-correção).
   O laço de `iterateGeometries` descarta dois terços dos vértices quando os atributos são
   *interleaved*, que é exatamente o que o gltf-transform produz. Isso mata o laço de render
   do A-Frame e degrada os colisores convexos sem emitir aviso. A correção está aplicada em
   `scene/bench.js`.

E um quarto, vindo dos arquivos USD da mesma saída (seção 8): eles trazem esquemas
`UsdPhysics` com **massa, densidade e inércia zeradas**, mas pedem
`physics:approximation = "sdf"` nos 28 prims. Colisão por campo de distância com sinal
representa geometria côncava em corpo dinâmico — existe no PhysX, não existe em nenhum motor
de física da web. Ou seja, **o próprio HoloScene não espera que seus objetos sejam simulados
como sólidos convexos**, o que corrobora o achado 2 pela via do autor do dataset.

---

## O que você precisa

| Requisito | Versão usada | Observação |
|---|---|---|
| Node.js | 20.19.0 | `>= 20` |
| Python | 3.12.3 | para o inventário geométrico (trimesh) |
| Google Chrome | 156 | o arnês dirige o Chrome **instalado**, via `playwright-core` |
| Saída do HoloScene | Stage 3 | `surface_*.obj` + `.mtl` + `.png` |
| Espaço em disco | ~1 GB | dependências + GLB gerados |
| GPU | — | medidas de FPS exigem GPU real; o pipeline roda sem ela |

**As malhas não estão neste repositório** (84 MB de entrada, 121 MB de GLB gerado). Você
precisa da pasta de saída do Stage 3 do HoloScene para a cena `replica_room_0`.

---

## Como rodar

### 1. Dependências

```bash
npm ci

python -m venv .venv
# Windows
.venv\Scripts\pip install -r requirements.lock.txt
# Linux / macOS
.venv/bin/pip install -r requirements.lock.txt
```

### 2. Trazer as malhas

```bash
node scripts/00_copy_meshes.mjs /caminho/para/saida/do/holoscene
```

Copia os `surface_*.{obj,mtl,png}` para `meshes_src/` e marca como somente-leitura — nenhuma
etapa seguinte consegue alterar os dados originais.

### 3. Pipeline

Os comandos abaixo usam `python` como atalho para o interpretador da venv.

```bash
# Etapa 1 — inventário geométrico
python scripts/01_inventory.py          # results/mesh_stats.csv, scene_totals.json
python scripts/01b_room_extent.py       # dimensões da sala e fator de escala

# Etapa 2 — conversão para glTF (original e otimizada) + validação
node   scripts/02_convert.mjs           # results/conversion.csv, validator/*.json
python scripts/02b_verify_glb.py        # confere eixo Y-up, escala e transformação assada

# Etapa 3 — preparação da cena
node   scripts/03_center_models.mjs     # recentra os objetos dinâmicos
python scripts/03b_manifest.py          # scene/scene_manifest.json (massas, colisores)
python scripts/03c_check_geometry.py    # NaN, triângulos degenerados, razão de aspecto
```

### 4. Servir e medir

```bash
npm run serve        # http-server em http://127.0.0.1:8088  (deixe rodando)
```

Em outro terminal:

```bash
npm run bench:smoke  # 1 repetição, janela curta — valida o arnês
npm run bench        # protocolo completo: 7 cenários × 3 repetições (~10 min)

python scripts/05_analyse_stability.py  # estabilidade física por objeto
python scripts/05b_hull_overlap.py      # interpenetração entre envoltórias convexas
npm run shots                           # capturas ilustrativas
```

### 5. Opcional — o que os USD carregam

```bash
HOLOSCENE_USD=/caminho/para/saida/usd python scripts/07_usd_physics.py
```

Lê os esquemas `UsdPhysics` dos `usd/obj_*.usd` e compara com o que foi estimado a partir do
OBJ. Usa `usd-core`, já incluído no `requirements.lock.txt`. Não é necessário para o
pipeline principal — alimenta a seção 8 do relatório.

O `npm run bench` abre janelas do Chrome e as dirige. **Não interaja com elas durante a
execução** — fechar uma janela aborta o cenário em curso.

---

## Explorar a cena manualmente

Com o servidor no ar, abra <http://127.0.0.1:8088/index.html>.
Clique para travar o cursor; **WASD** anda, **mouse** olha, **ESC** solta.

Parâmetros de query:

| Parâmetro | Valores | Efeito |
|---|---|---|
| `variant` | `original` \| `optimized` | conjunto de GLB |
| `physics` | `on` \| `off` | criar ou não os corpos rígidos |
| `only` | `all` \| `bg` \| `objects` | subconjunto da cena (usado para isolar falhas) |
| `desinterleave` | `on` \| `off` | `off` **reproduz o defeito da seção 6** |
| `depenetrar` | `on` \| `off` | levanta os 7 objetos que nascem cravados no piso |
| `nav` | `on` \| `off` | controles de navegação |
| `warmup` / `window` | segundos | aquecimento e janela de medição |

Exemplo — ver o defeito da `three-to-ammo` em ação:

```
http://127.0.0.1:8088/index.html?variant=original&physics=on&desinterleave=off
```

---

## Estrutura

```
scripts/      pipeline completo, numerado na ordem de execução
  00_environment.ps1       hardware, SO, navegador e versões
  00_copy_meshes.mjs       traz as malhas do HoloScene
  01_inventory.py          inventário geométrico (trimesh)
  01b_room_extent.py       dimensões da sala pelos planos de parede
  02_convert.mjs           OBJ → GLB, duas versões, com gltf-validator
  02b_verify_glb.py        verifica a transformação assada
  03_center_models.mjs     recentra os objetos dinâmicos
  03b_manifest.py          manifesto da cena: massas e colisores
  03c_check_geometry.py    saúde numérica da geometria
  04_bench.mjs             medição automatizada (Playwright → Chrome)
  05_analyse_stability.py  estabilidade física por objeto
  05b_hull_overlap.py      interpenetração entre envoltórias convexas
  06_screenshots.mjs       capturas ilustrativas
  07_usd_physics.py        lê os esquemas UsdPhysics dos USD (seção 8)
  probe_*.mjs              sondas que isolaram o defeito da seção 6

scene/        index.html, bench.js, scene_manifest.json
  vendor/     A-Frame 1.8.0, aframe-physics-system 4.2.4, ammo.wasm — fixados
              e versionados: a cena não depende de CDN em tempo de execução

results/      RELATORIO.md + todos os dados medidos, capturas e relatórios
              do validador. criterios.json tem os critérios de sucesso,
              congelados antes de qualquer medição.

logs/         saída bruta de cada etapa
```

### Não versionado

`meshes_src/` (84 MB), `scene/models/` (121 MB), `node_modules/`, `.venv/`. Tudo
regenerável pelos passos acima. Os resultados medidos **estão** versionados.

---

## Reprodutibilidade

- Todas as versões fixadas: `package-lock.json` (`npm ci`) e `requirements.lock.txt`.
- Nenhuma dependência de CDN em tempo de execução: `scene/vendor/` traz o `ammo.wasm` do
  commit `8bbc0ea` de MozillaReality/ammo.js, versionado de propósito para sobreviver ao CDN.
- Critérios de sucesso congelados em `results/criterios.json` **antes** das medições.
- Cada medição tem 3 repetições; o relatório traz média e desvio padrão.
- Ambiente de referência registrado em `results/environment.json`
  (Ryzen 5 3600, RTX 3060, 32 GB, Windows 11, Chrome 156).

Duas ressalvas de honestidade metodológica:

- **A escala métrica é suposição**, não medição (ver conclusão, item 1). Se o valor real do
  Replica for outro, basta alterar `fator_escala` e reexecutar; as conclusões qualitativas
  não mudam.
- **O FPS foi medido sem vsync** (`--disable-gpu-vsync`), para comparar vazão de renderização
  entre as versões. São números de folga disponível, não de taxa percebida.

---

## Licença

MIT para o código deste repositório. As malhas do HoloScene e o dataset Replica têm licenças
próprias e não estão incluídos aqui.

## Referência

Xia et al. (2025), *HoloScene*.
