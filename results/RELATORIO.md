# Avaliação das malhas do HoloScene em A-Frame com física

**Cena:** `replica_room_0` (Replica), saída do Stage 3 do HoloScene (Xia et al., 2025)
**Data de execução:** 2026-11-02
**Diretório:** `aframe_test/` — os arquivos originais entregues pelo Stage 3 do HoloScene
não foram modificados; `meshes_src/` é uma cópia marcada como somente-leitura.

---

## Resumo executivo

As malhas do HoloScene **são utilizáveis para renderização web** e **não são utilizáveis,
sem retrabalho, para simulação física interativa**.

- Renderização: as 28 malhas convertem para glTF sem um único erro de validação, a cena
  carrega em ~1,1 s e roda com folga enorme (frametime de 0,40 ms com física ativa num
  RTX 3060). **6 de 8 critérios pré-registrados foram aprovados.**
- Física: os dois critérios reprovados são os que medem plausibilidade física. Partindo
  das poses reconstruídas, a cena **colapsa**: o deslocamento mediano dos objetos em 10 s
  é de 0,87 m (limite: 0,10 m) e 5 a 6 objetos da versão original são ejetados para fora
  do mundo (1 na versão otimizada).
- A causa não é desempenho nem qualidade de malha: é que **25 dos 27 objetos (92,6%) têm
  envoltórias convexas que se interpenetram já em t=0**. O HoloScene segmenta objetos que
  repousam dentro das concavidades uns dos outros (almofadas em sofás, itens sobre mesas);
  a envoltória convexa preenche essas concavidades e transforma contato em interpenetração.

Encontrei também um **defeito na biblioteca de física** que quebra silenciosamente a
integração; está documentado na seção 6 com a correção aplicada.

A seção 8 examina os arquivos USD da mesma saída, que trazem esquemas `UsdPhysics`. Eles
confirmam de forma independente a divisão estático/dinâmico, a orientação e a colocação dos
objetos, mas **têm massa, densidade e inércia zeradas**. O mais revelador é que pedem
`approximation = "sdf"`: **o próprio HoloScene não espera que seus objetos sejam simulados
como sólidos convexos** — o que corrobora o diagnóstico acima.

---

## 1. Ambiente e versões

Registro completo em [`environment.json`](environment.json).

| | |
|---|---|
| CPU | AMD Ryzen 5 3600, 6C/12T, 3600 MHz |
| GPU | NVIDIA GeForce RTX 3060, driver 32.0.16.1656 |
| RAM | 31,9 GB |
| SO | Windows 11 Pro 10.0.22631 (build 22631), 64 bits |
| Navegador | Google Chrome 156.0.8078.80 |

Todas as versões foram fixadas (`--save-exact`) e nenhuma dependência é carregada de CDN
em tempo de execução — `scene/vendor/` contém cópias locais.

| Componente | Versão |
|---|---|
| A-Frame | 1.8.0 |
| @c-frame/aframe-physics-system | 4.2.4 (driver Ammo) |
| ammo.js | MozillaReality/ammo.js@`8bbc0ea` (`ammo.wasm.js` + `.wasm`) |
| obj2gltf | 3.2.0 |
| @gltf-transform/core, /functions, /extensions, /cli | 4.5.1 |
| meshoptimizer | 1.3.0 |
| sharp | 0.35.5 |
| gltf-validator | 2.0.0-dev.3.10 |
| http-server | 14.1.1 |
| playwright-core | 1.64.1 |
| Node / npm | v20.19.0 / 10.8.2 |
| Python | 3.12.3 (venv; `requirements.lock.txt`) |
| trimesh / numpy / manifold3d | 5.2.0 / 2.5.4 / 3.5.4 |

---

## 2. Critérios de sucesso

> **Nota de procedimento.** A seção 4 do enunciado, que traria os critérios de sucesso, veio
> truncada no texto recebido (junto com o final da frase “Automatize com…”). Os critérios
> abaixo foram definidos por mim e **congelados em [`criterios.json`](criterios.json) antes de
> qualquer medição de desempenho ou física**, e não foram alterados depois. As etapas 1 e 2 já
> estavam concluídas quando o arquivo foi escrito, de modo que C1 e C8 eram verificáveis de
> imediato; C2 a C7 dependiam das medições.

| ID | Critério | Limiar | Medido | Resultado |
|---|---|---|---|---|
| C1 | Malhas convertidas sem erro do gltf-validator | ≥ 90% | 100% (28/28, nas duas versões) | **Passou** |
| C2 | Tempo de carga da cena completa | ≤ 15000 ms | 1134 ms (pior cenário) | **Passou** |
| C3 | FPS efetivo com física | ≥ 30 | 2497 | **Passou** |
| C4 | FPS do 1% pior dos quadros | ≥ 20 | 502 | **Passou** |
| C5 | 28 corpos criados, zero exceções | == 28, 0 | 28/28, 0 exceções | **Passou** |
| C6 | Deslocamento mediano após 10 s | ≤ 0,10 m | 0,869 m | **Reprovou** |
| C7 | Objetos abaixo de (piso − 0,5 m) | == 0 | 5 | **Reprovou** |
| C8 | Versão otimizada ≤ 50% dos triângulos e dos bytes | ≤ 0,50 | 0,5001 tri / 0,187 bytes | **Passou** |

**6/8 aprovados.** Detalhamento em [`runtime_summary.json`](runtime_summary.json).

Sobre C5: contabilizei separadamente *exceções de JavaScript* (zero) e *abortos de requisição
HTTP* (1 a 3 por execução, `net::ERR_ABORTED`). Os abortos são ruído do servidor local com 28
downloads em paralelo e não impedem o carregamento — `n_modelos_carregados` é 28 em todas as
execuções. Abortos de rede não são exceções, então não contam contra o critério como redigido.

---

## 3. Inventário das malhas

Dados por malha em [`mesh_stats.csv`](mesh_stats.csv); agregados em
[`scene_totals.json`](scene_totals.json).

### 3.1 Composição

O enunciado descrevia “28 objetos mais o fundo”. A saída real tem **28 malhas no total:
1 fundo + 27 objetos**. Confirmado por duas vias independentes: `surface_0` é a malha de maior
área (250.000 triângulos contra ~21.000 dos demais), e o `graph_node_dict.pkl` do HoloScene
descreve 28 nós, sendo o nó 0 a raiz com 27 descendentes.

| Métrica | Valor |
|---|---|
| Malhas | 28 (1 fundo + 27 objetos) |
| Triângulos da cena | 818.182 (fundo 250.000 + objetos 568.182) |
| Vértices (soldados) | 409.469 |
| Tamanho total OBJ+MTL+PNG | 84,04 MB (48,11 MB OBJ + 35,93 MB texturas) |
| Texturas | 28 PNG, todas 2048×2048 |
| Só triângulos / com UV / MTL válido | 28 / 28 / 28 |

Todos os 28 MTL referenciam corretamente seu PNG e são mínimos: contêm apenas `newmtl mesh`
e `map_Kd`. Não há `Kd`, `Ks` nem `Ns` — nenhuma informação de material além da textura.

### 3.2 Topologia

| Métrica | Valor |
|---|---|
| Watertight | **0 de 28** |
| Manifold (nenhuma aresta com 3+ faces) | **0 de 28** |
| Arestas de borda | 1.268 no total (mediana 28, máx. 280) |
| Arestas não-manifold | 512 no total (mediana 14, máx. 61) |
| Componentes conexos | 793 no total (mediana 17, máx. 138) |

Nenhuma malha é watertight, o que significa que **volume não é definido para nenhuma delas** —
daí a necessidade de usar o volume da envoltória convexa no modelo de massa (seção 5.3).

O fundo é um caso à parte: 49 componentes conexos, **zero arestas de borda** e apenas 7 arestas
não-manifold. Ou seja, é essencialmente fechado, mas **20,1% da sua área está fora do componente
dominante** — são destroços de reconstrução flutuando fora das paredes. Isso infla a caixa
envolvente do fundo de 7,5 × 2,7 × 4,4 m (a sala) para 12,1 × 3,7 × 10,8 m.

> **Armadilha metodológica registrada.** A primeira execução do inventário reportou 1.464
> componentes para o fundo e uma contagem de vértices *maior* que a do arquivo. Causa:
> `trimesh.load` divide vértices nas costuras de UV, e `Trimesh.merge_vertices()` **sem
> argumentos preserva essa divisão**. A solda topológica correta exige
> `merge_vertices(merge_tex=True, merge_norm=True)`. Após a correção, os vértices soldados
> (409.469) batem com os do arquivo (409.470) e o fundo cai para 49 componentes. Os números
> da primeira execução estavam errados e foram descartados.

### 3.3 Escala — o export **não** está em metros

Esta foi a descoberta mais consequente da etapa 1.

O pé-direito medido no fundo vale **0,3786 unidades**, incompatível com os 2,5–3 m esperados.
Procurei o fator de normalização e **ele não existe em nenhum arquivo entregue**: nem no
OBJ/MTL/PNG, nem no `bg_info.pkl` (que contém apenas dados de captura por quadro — `rgb`,
`normal`, `depth`, `mask`, `pose`, `intrinsics`), nem no `translation_dict.pkl` (que traz apenas
deslocamentos de refinamento da ordem de milímetros).

Medi a sala pelos **planos dominantes de parede, piso e teto** (histograma de área ponderada
por orientação de normal), e não pela caixa envolvente, que está contaminada pelos destroços:

| Plano | Posição (unidades) |
|---|---|
| Piso | z = −0,1988 |
| Teto | z = +0,1798 |
| Paredes X | −0,5341 e +0,5186 |
| Paredes Y | −0,2940 e +0,3186 |

Adotando pé-direito = **2,7 m** (hipótese declarada antes da medição), o fator é
**7,13078**, do qual resulta uma sala de **7,51 × 4,37 × 2,70 m** (32,8 m² de piso) —
plausível para o `room_0` do Replica.

**Esse fator é uma suposição, não uma medição.** Quem reproduzir este trabalho com o valor
métrico verdadeiro deve alterar apenas a constante `fator_escala` e reexecutar; todo o
pipeline depende dela por um único ponto.

### 3.4 Eixo vertical

O OBJ é **Z-up**; A-Frame e glTF são **Y-up**. A rotação necessária é **−90° em X**, que mapeia
`(x, y, z)_obj → (x, z, −y)`.

Isso não foi inferido: foi verificado contra o `scene.glb` que o próprio HoloScene exporta. As
extensões do OBJ `(1,698; 1,513; 0,516)` aparecem no GLB como `(1,698; 0,516; 1,513)`, e o
intervalo `y_obj ∈ [−0,701; 0,812]` aparece como `z_glb ∈ [−0,812; 0,701]` — exatamente a
negação e troca que a rotação de −90° em X produz.

---

## 4. Conversão para glTF

Script: [`scripts/02_convert.mjs`](../scripts/02_convert.mjs) · comando: `node scripts/02_convert.mjs`
Dados: [`conversion.csv`](conversion.csv), [`conversion_summary.json`](conversion_summary.json),
relatórios do validador em [`validator/`](validator/).

### 4.1 Correção de referencial (aplicada às duas versões)

Rotação de −90° em X e escala uniforme de 7,13078 foram **assadas nos vértices**
(`clearNodeTransform`), não deixadas como transformação de nó, para que o colisor de malha do
Ammo receba coordenadas já métricas. Isso não é otimização: é pré-requisito de correção, e por
isso é idêntico nas duas versões, mantendo a comparação justa.

Como o MTL só traz `map_Kd`, fixei `metallic = 0`, `roughness = 1` e `doubleSided = true` —
este último porque as malhas têm winding inconsistente e a sala é vista por dentro.

Verificação independente em [`glb_verification.csv`](glb_verification.csv): nos 28 GLB o nó raiz
tem transformação identidade, o eixo vertical passou a ser Y, piso em y = −1,418 m e teto em
y = +1,282 m (2,70 m de diferença), e as caixas envolventes das versões original e otimizada
coincidem com desvio máximo de 2 mm.

### 4.2 Parâmetros e resultados

Otimização: `weld(tolerance 0)` → `simplify(ratio 0.5, error 0.001, meshoptimizer)` →
`textureCompress(webp, 1024×1024, quality 80, sharp)` → `prune()`.

| | OBJ+PNG | GLB original | GLB otimizado |
|---|---|---|---|
| Triângulos | 818.182 | 818.182 | 409.202 (0,5001×) |
| Tamanho | 84,04 MB | 51,07 MB | **9,53 MB** (−81,3%) |
| Texturas | 28 × PNG 2048² | 28 × PNG 2048² | 28 × WebP 1024² |

Tempo total de conversão das 28 malhas: **13,1 s**.

**Validação: 28/28 sem erros e sem avisos, nas duas versões.** Nenhuma falha de conversão.

---

## 5. Cena A-Frame com física

Arquivos: [`scene/index.html`](../scene/index.html), [`scene/bench.js`](../scene/bench.js),
manifesto em [`scene/scene_manifest.json`](../scene/scene_manifest.json).

### 5.1 Parâmetros de simulação

```
physics="driver: ammo; gravity: -9.81; fixedTimeStep: 0.0166666667;
         maxSubSteps: 4; iterations: 10"
```

Gravidade −9,81 m/s², passo fixo de 1/60 s, até 4 subpassos por quadro, 10 iterações do solver.

### 5.2 Colisores

- **Fundo (`surface_0`)**: corpo **estático** com `ammo-shape="type: mesh"` — malha triangular
  exata, 250.000 triângulos. Sem aproximação.
- **Objetos (27)**: corpos **dinâmicos** com `ammo-shape="type: hull"` — envoltória convexa.

A envoltória convexa é uma **aproximação imposta pelo motor**: nenhum motor de física em tempo
real aceita malha triangular côncava em corpo dinâmico. Para os objetos desta cena o custo
dessa aproximação é alto: a mediana da razão entre volume do hull e volume da caixa envolvente
é 0,516, e objetos côncavos (poltronas, prateleiras) ficam efetivamente “preenchidos”. A seção 7
mostra que é exatamente aí que a simulação falha.

Cada objeto foi **recentrado na origem** antes de virar corpo rígido (geometria transladada de
−centro, translação assada nos vértices, `position` da entidade recebendo o centro). Sem isso o
centro de massa cairia fora do objeto e cada móvel giraria em torno de um ponto externo.
Resíduo de centragem medido: 0,00 m.

### 5.3 Modelo de massa

O HoloScene estima propriedades físicas internamente, mas **elas não são exportadas** no
OBJ/MTL. Adotei:

```
massa = 200 kg/m³ × volume_da_envoltória_convexa,  limitada a [0,5 ; 50] kg
```

O volume usado é o **do hull**, não o da caixa envolvente nem o da malha, porque o hull é o
sólido que o motor de fato simula — assim a massa fica coerente com o colisor realmente usado.
A densidade de 200 kg/m³ reflete móveis domésticos, em boa parte ocos ou de madeira leve
(água = 1000). Nenhuma malha é watertight, então o volume da malha real sequer é definido.

Resultado: massa total 454,45 kg, mediana 5,27 kg, 9 dos 27 objetos atingindo um dos limites.

### 5.4 Posição inicial dos objetos

Medida relevante obtida do manifesto, antes de qualquer simulação:

- **7 objetos nascem abaixo do piso** (penetrando de 1,7 a 3,9 cm);
- **18 objetos flutuam mais de 5 cm acima do piso** (a maioria repousando sobre móveis);
- apenas 2 estão a menos de 5 cm do piso.

---

## 6. Defeito encontrado na integração (e sua correção)

Este foi o principal obstáculo técnico e merece registro detalhado, porque **quebra a
integração silenciosamente**.

### 6.1 Sintoma

Com física ativa, toda execução emitia:

```
RuntimeError: float unrepresentable in integer range
  at ammo.wasm.wasm:wasm-function[1878]
  ...
  at g._emscripten_bind_btBvhTriangleMeshShape_btBvhTriangleMeshShape_3
  at Object.createCollisionShapes (aframe-physics-system.js:11805)
  at n._createCollisionShape (aframe-physics-system.js:14111)
```

### 6.2 Isolamento

| Experimento | Resultado |
|---|---|
| Só o fundo (`only=bg`) | **Reproduz** o erro |
| Só os objetos (`only=objects`) | Não reproduz |
| Construir o mesmo `btBvhTriangleMeshShape` direto da API do Ammo, com a mesma geometria, em 7 configurações (integral, sem quantização, sem triângulos degenerados, recortado, metade, com `setScaling`) | **Todas as 7 funcionam** ([`ammo_mesh_experiment.json`](ammo_mesh_experiment.json)) |

Ou seja: o colisor é o do fundo, mas a geometria do fundo é perfeitamente aceitável para o Ammo.
A corrupção acontecia no caminho entre o three.js e o Ammo.

### 6.3 Causa raiz

Instrumentei as chamadas reais ao Ammo ([`ammo_hook.json`](ammo_hook.json)): das 750.000
leituras de vértice entregues ao `btTriangleMesh`, **489.711 chegavam não-finitas (NaN)** — 65%,
ou seja, dois terços.

A origem é `three-to-ammo/index.js:710`:

```js
for (let i = 0; i < verticesAttribute.count; i += 3) {
  vertices.push(verticesAttribute.getX(i));
  vertices.push(verticesAttribute.getY(i));
  vertices.push(verticesAttribute.getZ(i));
}
```

`getX(i)` **já indexa por vértice**, mas o laço avança de 3 em 3. O array resultante fica com um
terço dos vértices, enquanto o buffer de índices continua referenciando a numeração original —
dois terços das buscas caem fora do array, viram `undefined` e produzem NaN. O
`btBvhTriangleMeshShape` então estoura ao quantizar a BVH com coordenadas NaN.

Esse ramo só é executado quando os atributos são **interleaved**, e é exatamente o que o
gltf-transform produz: verifiquei que **28 de 28 malhas chegam ao three.js como
`InterleavedBufferAttribute`** com stride 5 (3 floats de posição + 2 de UV). É glTF válido.

**Consequência mais grave que o erro visível:** os 27 colisores `hull` não lançam exceção, mas
são construídos a partir de **um terço dos pontos**. A envoltória convexa sai degradada **em
silêncio**. Qualquer integração ingênua deste tipo de cena herda esse defeito sem perceber.

### 6.4 Correção aplicada

Desintercalo os atributos logo após o `model-loaded`, antes de criar os corpos
(`desintercalarGeometria` em [`scene/bench.js`](../scene/bench.js)). A correção fica no código
da aplicação, sem alterar a biblioteca.

Medi os dois estados para quantificar o impacto (3 repetições cada):

| | Com correção | Sem correção |
|---|---|---|
| Exceções de JS | 0 | 1 por execução |
| Tempo de construção do colisor do fundo | 4,3 ± 0,6 ms | 0,3 ± 0,6 ms |
| **Quadros renderizados pelo A-Frame** | 2.602 ± 271 /s | **0** |
| Frametime aparente | 0,40 ms | 16,40 ms |

A linha decisiva é a dos quadros renderizados. Sem a correção, a exceção mata o laço de render
do A-Frame: **o three.js não desenha nenhum quadro**. Os “61 fps / 16,4 ms” que o laço de
`requestAnimationFrame` registra nesse caso **não são medida de desempenho** — são o compositor
do navegador voltando a 60 Hz com a página congelada. Instrumentei `renderer.info.render.frame`
justamente para não confundir cadência do navegador com renderização efetiva.

---

## 7. Resultados de execução

Protocolo: 7 cenários × **3 repetições**, 3 s de aquecimento descartados + 10 s de janela de
medição, viewport 1280×720, vsync desligado. Média ± desvio padrão sobre as repetições.
Dados por execução em [`runtime_runs.csv`](runtime_runs.csv).

> O vsync foi desligado (`--disable-gpu-vsync --disable-frame-rate-limit`) para que a medida
> fosse a **vazão de renderização**, e não o teto do monitor — sem isso, todos os cenários
> marcariam 60 fps e a comparação entre versões não revelaria nada. Os números de FPS abaixo
> são, portanto, de folga disponível, não de taxa percebida. O FPS é derivado do tempo de
> quadro (quadros ÷ tempo decorrido); a média de `1000/dt` foi evitada por ser dominada pelos
> quadros mais rápidos e inflar o valor em uma ordem de grandeza.

### 7.1 Desempenho

| Cenário | Carga (ms) | Frametime (ms) | p99 (ms) | FPS efetivo | FPS 1% low | Heap (MB) |
|---|---|---|---|---|---|---|
| original, sem física | 1012 ± 46 | 0,244 ± 0,043 | 0,67 | 4172 ± 667 | 1528 ± 241 | 84,2 ± 1,9 |
| original, com física | 1134 ± 2 | 0,404 ± 0,046 | 4,33 | 2497 ± 280 | 697 ± 525 | 84,6 ± 5,6 |
| otimizado, sem física | 381 ± 58 | 0,281 ± 0,007 | 0,80 | 3563 ± 90 | 1250 ± 0 | 36,1 ± 0,4 |
| otimizado, com física | 518 ± 216 | 0,399 ± 0,009 | 2,40 | 2511 ± 57 | 502 ± 221 | 35,1 ± 1,8 |

Leituras:

- **Carga:** a otimização reduz o tempo de carga em 2,7× (1012 → 381 ms) e o heap em 2,3×
  (84 → 36 MB). É o ganho mais concreto da otimização.
- **Renderização:** a diferença de desempenho entre 818k e 409k triângulos é desprezível nesta
  GPU — ambos ficam em ~0,25–0,28 ms por quadro. A cena é limitada por outros fatores, não pela
  contagem de triângulos. Só 10 a 13 draw calls por quadro (frustum culling descarta o resto).
- **Custo da física:** ligar a física aumenta o frametime de ~0,26 para ~0,40 ms (+55%) e
  degrada bem mais o percentil 99 (0,7 → 4,3 ms no original). É o custo dominante, mas ainda
  muito abaixo do orçamento de 16,7 ms de um quadro a 60 Hz.
- **Construção dos colisores:** o colisor de malha do fundo com 250.000 triângulos leva apenas
  **4,3 ± 0,6 ms** (2,3 ms na versão otimizada, com 125.000). Custo irrelevante.

### 7.2 Plausibilidade física — onde a avaliação falha

Dados em [`stability_summary.csv`](stability_summary.csv) e
[`stability_summary.json`](stability_summary.json).

| Cenário | Desloc. mediano | Desloc. máx | Estáveis (≤10 cm) | Ejetados do mundo |
|---|---|---|---|---|
| original, com física | 0,907 m | 781 m | **0 de 27** | 6 |
| otimizado, com física | 0,789 m | 772 m | 5 de 27 | 1 |
| original, despenetrado | 1,006 m | 782 m | 1 de 27 | 8 |

> Duas agregações diferentes aparecem neste relatório e convém não confundi-las. Em C6
> (seção 2) o valor 0,869 m é a **média, sobre as 3 repetições, da mediana por execução** —
> é assim que o critério foi redigido. Na tabela acima, 0,907 m é a **mediana, sobre os 27
> objetos, do deslocamento médio de cada objeto** — é a forma útil para analisar objeto a
> objeto. O mesmo vale para a contagem de ejetados: C7 conta o pior caso por execução (5),
> a tabela conta objetos cujo y final médio ficou abaixo do piso (6).

Nenhum objeto da versão original fica onde o HoloScene o colocou. O deslocamento mediano é
quase 1 m — os objetos que “apenas” caem sobre o piso percorrem a distância que antes os
separava dele. E vários são **ejetados a centenas de metros**, com desvio padrão entre
repetições de ±450 m: a simulação é **caótica e não repetível**, e o conjunto de objetos que
escapa muda de execução para execução.

As capturas mostram o efeito: em `vista_sem_fisica_t0.png` a sala está completa; em
`vista_com_fisica_t10s.png`, 10 s depois, **todas as almofadas, uma poltrona, o tapete e o
objeto sobre a mesa desapareceram**, restando os sofás mais pesados.

### 7.3 Diagnóstico da instabilidade

Minha primeira hipótese foi a penetração inicial no piso (7 objetos nascem cravados nele).
Testei a mitigação óbvia — levantar cada um até 1 cm acima do piso antes de ligar a física — e
**o resultado piorou**: de 6 para 8 objetos ejetados. A hipótese está descartada.

A causa real está na **aproximação convexa**. Medi as interseções par a par entre as
envoltórias convexas na pose de t=0 ([`hull_overlap.csv`](hull_overlap.csv)):

| Métrica | Valor |
|---|---|
| Pares com hulls se interpenetrando | 25 de 351 |
| **Objetos envolvidos** | **25 de 27 (92,6%)** |
| Volume total interpenetrado | 0,353 m³ |
| Par mais grave | `surface_10` × `surface_14` — 0,157 m³ (82% do menor) |

Os casos extremos são eloquentes:

| Par | Interpenetração | Massas |
|---|---|---|
| `surface_1` × `surface_2` | **100% do menor** | 50,0 / 3,6 kg |
| `surface_3` × `surface_4` | **100% do menor** | 50,0 / 3,3 kg |
| `surface_15` × `surface_16` | 99,9% do menor | 50,0 / 0,9 kg |
| `surface_10` × `surface_12` | 90,6% do menor | 50,0 / 4,9 kg |

Uma almofada de 3,6 kg está **inteiramente contida** na envoltória convexa do sofá de 50 kg.
Na geometria real ela apenas repousa na concavidade do assento; o hull preenche essa
concavidade e converte contato em sobreposição total. No primeiro passo de simulação o solver
precisa resolver 25 violações simultâneas dessa magnitude, e o impulso de separação ejeta os
corpos — o que explica tanto os deslocamentos de centenas de metros quanto a não repetibilidade.

Isso é um **conflito estrutural entre a decomposição do HoloScene e a física de corpos rígidos
convexos**: o HoloScene segmenta corretamente objetos que, no mundo real, repousam dentro das
concavidades uns dos outros. Quanto melhor a segmentação, pior o problema.

A versão otimizada se sai melhor (1 ejetado contra 6) não por ser mais correta, e sim porque a
simplificação a 50% encolhe ligeiramente as envoltórias, reduzindo as sobreposições. É um
efeito colateral, não uma solução.

---

## 8. E se tivéssemos usado os USD em vez dos OBJ?

A saída do HoloScene também traz `usd/obj_0..27.usd` (e os `.usdz` equivalentes), que não
foram usados na avaliação principal. Como o formato USD suporta os esquemas **UsdPhysics**,
é legítimo perguntar se eles teriam sido a fonte melhor para a física. Verifiquei.

Script: [`scripts/07_usd_physics.py`](../scripts/07_usd_physics.py) ·
dados: [`usd_physics.csv`](usd_physics.csv), [`usd_physics.json`](usd_physics.json).

### 8.1 Os USD declaram física — e isso é real

Os 28 arquivos são USDC binários, e **todos** trazem esquemas de física aplicados:

| Prim | Esquemas aplicados |
|---|---|
| `obj_0` (fundo) | `PhysicsCollisionAPI`, `PhysicsMeshCollisionAPI`, `PhysicsMaterialAPI` |
| `obj_1..27` (objetos) | as anteriores **+** `PhysicsRigidBodyAPI`, `PhysicsMassAPI` |

Isso é informação que o OBJ não tem, e ela **confirma independentemente três decisões** que na
avaliação principal eu tive de inferir:

1. **A divisão estático/dinâmico.** O fundo recebe apenas colisão, sem `RigidBodyAPI`; os 27
   objetos recebem corpo rígido. É exatamente a divisão adotada na seção 5.2.
2. **A orientação e a colocação.** Cada prim traz `xformOp:rotateX:tilt` + `xformOp:translate`,
   ou seja, a conversão Z-up → Y-up e a posição na cena já vêm resolvidas. O palco USD declara
   `upAxis = Y`.
3. **O tipo de colisor pretendido:** `physics:approximation = "sdf"` nos 28.

**Validação cruzada da colocação.** Comparei o `xformOp:translate` de cada USD com a `position`
que derivei do OBJ (centro da caixa envolvente), dividida pelo fator de escala adotado:
delta mediano de **0,0015 unidades** e máximo de 0,0148 (1,1 cm e 10,5 cm métricos). A
concordância confirma que OBJ e USD estão no mesmo referencial e que a derivação de
posicionamento da seção 5.2 está correta — o resíduo é a diferença entre o pivô do USD e o
centro da caixa envolvente.

### 8.2 Mas os valores de física não estão preenchidos

Os esquemas estão **aplicados**, os atributos **não estão autorados**. Valores lidos de
`usd/obj_5.usd`, representativos dos 27 objetos:

| Atributo | Valor | Leitura |
|---|---|---|
| `physics:mass` | `0.0` | **zerado nos 27** |
| `physics:density` | `0.0` | zerado nos 28 |
| `physics:diagonalInertia` | `[0, 0, 0]` | zerado |
| `physics:centerOfMass` | `[-inf, -inf, -inf]` | sentinela de “não definido” |
| `physics:principalAxes` | `(0, 0, 0, 0)` | quatérnio inválido |
| `physics:staticFriction` / `dynamicFriction` | `1.0e+20` | sentinela de “não definido” |
| `physics:restitution` | `0.0` | — |
| `physics:rigidBodyEnabled` | `1.0` | — |

Ou seja: **o modelo de massa da seção 5.3 continuaria sendo necessário**. O HoloScene estima
propriedades físicas internamente, mas o que chega ao USD são apenas os *slots* dos esquemas,
sem os números. A afirmação da seção 5.3 — “o HoloScene não exporta massa” — se sustenta, e
agora com evidência direta em vez de inferência a partir da ausência no OBJ.

A escala também não se resolve: o palco declara `metersPerUnit = 0.01` (centímetros), mas a
geometria tem os mesmos valores do OBJ (fundo com 1,698 × 1,513 × 0,516). Tomado ao pé da
letra, o pé-direito mediria meio centímetro. O `metersPerUnit` é o padrão do exportador, não
uma medição — **nenhum arquivo entregue carrega a escala métrica verdadeira**, como concluído
na seção 3.3.

### 8.3 `approximation = "sdf"`: o colisor certo, indisponível na web

O achado mais interessante é que o HoloScene pede **colisão por campo de distância com sinal
(SDF)** para todos os 28 prims. SDF é justamente o tipo de colisor que resolveria o problema
central da seção 7.3: ele representa geometria **côncava** em corpo dinâmico, sem a
aproximação convexa que faz as almofadas se interpenetrarem com o sofá.

O problema é de disponibilidade. Colisores SDF existem no **NVIDIA PhysX 5** (e portanto no
Isaac Sim / Omniverse, que é claramente o alvo desse export). **Nenhum motor de física para
web os oferece** — nem Ammo/Bullet, nem Cannon, nem Rapier. Também não há carregador de USD
utilizável no A-Frame: o `USDZLoader` do three.js é experimental e lê apenas geometria e
material, ignorando os esquemas de física.

### 8.4 Resposta

Para o alvo desta avaliação — uma aplicação **web** com A-Frame — usar os USD **não teria
mudado o resultado**, por três razões:

1. A geometria é a mesma (mesmas contagens de vértices e faces dos OBJ correspondentes), então
   o colapso da seção 7.3 aconteceria igual: ele é consequência da aproximação convexa, e o
   USD não traz convexidade nenhuma de brinde.
2. As propriedades físicas estão zeradas, então o modelo de massa inventado continuaria necessário.
3. Não há caminho de carregamento de USD para o navegador; seria preciso converter para glTF
   de qualquer forma, descartando os esquemas de física no caminho.

Os USD **teriam economizado trabalho** em três pontos — a rotação Z-up → Y-up, a colocação dos
objetos e a decisão estático/dinâmico já vêm declaradas — e, como mostrado em 8.1, servem
muito bem como **validação independente** dessas três inferências. Esse é o uso correto deles
neste trabalho, e é como estão sendo usados agora.

O ponto mais valioso, porém, é o `approximation = "sdf"`: ele revela que **o próprio HoloScene
não espera que seus objetos sejam simulados como sólidos convexos**. Isso reforça, vindo do
autor do dataset, o diagnóstico da seção 7.3 — e explica por que a cena é fisicamente coerente
em PhysX e colapsa em Ammo.

---

## 9. Limitações

1. **A escala métrica é uma suposição.** O fator 7,13078 vem de assumir pé-direito de 2,7 m.
   Se o valor verdadeiro do Replica for outro, todas as grandezas em metros (massas, velocidades,
   distâncias) escalam junto. As conclusões qualitativas não mudam.
2. **O FPS foi medido sem vsync**, o que mede folga de renderização, não experiência percebida.
3. **Uma única cena, uma única máquina.** `replica_room_0` num RTX 3060. As conclusões de
   desempenho não se transferem para hardware móvel; as de física, sim, por serem geométricas.
4. **Repetições insuficientes para os casos caóticos.** Três repetições bastam para as métricas
   de desempenho (desvios pequenos), mas não para caracterizar os objetos ejetados, cujo desvio
   padrão é da ordem da própria média.
5. **Os 10 s de janela** não garantem que a cena tenha atingido repouso; medem o transiente.
6. **Não testei colisores côncavos aproximados** (HACD/VHACD), que são o caminho natural de
   mitigação — ver abaixo.
7. **Não executei a cena em PhysX**, que é o alvo implícito do export USD e o único ambiente
   onde o colisor SDF pedido pelo HoloScene existe. A hipótese da seção 8.4 — de que a cena
   seria fisicamente coerente lá — é plausível, mas **não foi verificada**.

## 10. Recomendações para o próximo passo

1. **Testar `shape: hacd` ou `vhacd`** nos objetos: decomposição convexa aproximada produz
   vários hulls por objeto e respeitaria as concavidades. É a mitigação mais promissora para o
   problema da seção 7.3. O `three-to-ammo` já suporta ambos, com custo de construção alto.
2. **Resolver as sobreposições antes de simular**, por relaxamento iterativo das poses, em vez
   da despenetração vertical ingênua que testei e que piorou o resultado.
3. **Congelar como estáticos** os objetos que não precisam ser manipulados (sofás, poltronas),
   deixando dinâmicos apenas os que o usuário vai interagir. Elimina o problema na origem.
4. **Reportar o defeito do `three-to-ammo`** (laço de `iterateGeometries`) ao projeto c-frame.
5. **Limpar os destroços do fundo** (20,1% da área fora do componente dominante) antes de gerar
   o colisor.
6. **Rodar a mesma cena no Isaac Sim / PhysX**, a partir dos USD, com o colisor SDF que o
   HoloScene pede. Serviria de grupo de controle: separaria o que é limitação do HoloScene do
   que é limitação do motor de física da web — que é a distinção que este trabalho não
   consegue fazer sozinho.

---

## 11. Arquivos gerados

**Dados**
`mesh_stats.csv` · `scene_totals.json` · `conversion.csv` · `conversion_summary.json` ·
`glb_verification.csv` · `geometry_health.csv` · `model_placement.json` ·
`runtime_runs.csv` · `runtime_summary.json` · `stability_*.csv` · `stability_summary.csv/json` ·
`hull_overlap.csv/json` · `ammo_mesh_experiment.json` · `ammo_hook.json` ·
`usd_physics.csv/json` · `criterios.json` · `environment.json` · `validator/*.json` ·
`console_*.json`

**Capturas** — `screenshots/`: as 21 execuções do protocolo, mais
`vista_sem_fisica_t0`, `vista_com_fisica_{t0,t2s,t10s}`, `vista_otimizado_fisica_{t0,t10s}`,
e `diagnostico/` com as vistas usadas para validar a câmera.

**Scripts** (ordem de execução)

| Script | Função |
|---|---|
| `00_environment.ps1` | registra hardware, SO, navegador e versões |
| `01_inventory.py` | inventário das malhas |
| `01b_room_extent.py` | dimensões da sala pelos planos de parede |
| `02_convert.mjs` | OBJ → GLB, original e otimizado, com validação |
| `02b_verify_glb.py` | confere a transformação assada |
| `03_center_models.mjs` | recentra os objetos dinâmicos |
| `03b_manifest.py` | manifesto da cena, massas e colisores |
| `03c_check_geometry.py` | saúde numérica da geometria |
| `04_bench.mjs` | medição automatizada (Playwright) |
| `05_analyse_stability.py` | análise de estabilidade física |
| `05b_hull_overlap.py` | interpenetração entre envoltórias convexas |
| `06_screenshots.mjs` | capturas ilustrativas |
| `07_usd_physics.py` | lê os esquemas UsdPhysics dos USD (seção 8) |
| `probe_*.mjs` | sondas de diagnóstico da seção 6 |

**Reprodução**

```bash
cd aframe_test
npm ci
python -m venv .venv && .venv/Scripts/pip install -r requirements.lock.txt
.venv/Scripts/python scripts/01_inventory.py
.venv/Scripts/python scripts/01b_room_extent.py
node scripts/02_convert.mjs
.venv/Scripts/python scripts/02b_verify_glb.py
node scripts/03_center_models.mjs
.venv/Scripts/python scripts/03b_manifest.py
node node_modules/http-server/bin/http-server scene -p 8088 -c-1 &
node scripts/04_bench.mjs
.venv/Scripts/python scripts/05_analyse_stability.py
.venv/Scripts/python scripts/05b_hull_overlap.py
```

Para explorar a cena manualmente: <http://127.0.0.1:8088/index.html> (WASD + mouse).
Parâmetros de query: `variant=original|optimized`, `physics=on|off`, `only=all|bg|objects`,
`desinterleave=on|off`, `depenetrar=on|off`, `nav=on|off`.
