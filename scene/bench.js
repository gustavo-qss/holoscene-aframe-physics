/**
 * Instrumentacao da cena HoloScene -> A-Frame + Ammo.
 *
 * Parametros de query:
 *   variant  = original | optimized   (conjunto de GLB; padrao original)
 *   physics  = on | off               (criar ou nao os corpos rigidos)
 *   warmup   = segundos de aquecimento descartados   (padrao 3)
 *   window   = segundos da janela de medicao          (padrao 10)
 *
 * Ao terminar expoe window.__RESULT (objeto) e window.__DONE = true, que e o
 * que o Playwright le. Erros nao sao escondidos: vao para __RESULT.erros.
 *
 * Colisores:
 *   fundo (surface_0) -> ammo-body type static + ammo-shape type mesh
 *                        (malha triangular exata; so e permitida em corpo estatico)
 *   objetos           -> ammo-body type dynamic + ammo-shape type hull
 *                        (envoltoria convexa; APROXIMACAO documentada)
 */
/* global AFRAME, THREE */
(function () {
  "use strict";

  var q = new URLSearchParams(location.search);
  var VARIANT = q.get("variant") === "optimized" ? "optimized" : "original";
  var PHYSICS = q.get("physics") !== "off";
  var WARMUP_S = parseFloat(q.get("warmup") || "3");
  var WINDOW_S = parseFloat(q.get("window") || "10");
  // Navegacao ligada por padrao (uso manual). O arnes de medicao passa
  // nav=off para que todas as repeticoes rendam o mesmo ponto de vista.
  var NAV = q.get("nav") !== "off";
  // only=bg | objects | all  -> subconjunto da cena, usado para isolar falhas
  var ONLY = q.get("only") || "all";
  // desinterleave=off reproduz o defeito descrito abaixo, para fins de medicao
  var DESINTERLEAVE = q.get("desinterleave") !== "off";
  // depenetrar=on levanta os objetos que nascem abaixo do piso antes de ligar
  // a fisica, para testar se a instabilidade vem da interpenetracao inicial
  var DEPENETRAR = q.get("depenetrar") === "on";
  var FOLGA_DEPENETRACAO = 0.01; // 1 cm acima do piso

  var hud = document.getElementById("hud");
  var sceneEl = document.getElementById("cena");

  var erros = [];
  window.addEventListener("error", function (e) {
    erros.push("window.error: " + (e.message || String(e.error)));
  });
  window.addEventListener("unhandledrejection", function (e) {
    erros.push("unhandledrejection: " + String(e.reason));
  });

  /**
   * Correcao de um defeito encontrado durante este experimento.
   *
   * O gltf-transform grava os atributos de vertice intercalados (stride 5:
   * 3 floats de posicao + 2 de UV num unico bufferView). Isso e glTF valido e
   * o three.js carrega como InterleavedBufferAttribute. Mas three-to-ammo
   * (iterateGeometries, index.js:710) converte esse caso com o laco
   *
   *     for (let i = 0; i < verticesAttribute.count; i += 3) {
   *       vertices.push(verticesAttribute.getX(i)); ...
   *
   * getX(i) ja indexa POR VERTICE, entao o passo 3 descarta dois tercos dos
   * vertices. O buffer de indices continua referenciando a numeracao original,
   * de modo que 2/3 das buscas caem fora do array e viram undefined -> NaN.
   *
   * Consequencias medidas:
   *   - colisor "mesh" do fundo: btBvhTriangleMeshShape lanca
   *     "RuntimeError: float unrepresentable in integer range" ao quantizar
   *     a BVH com coordenadas NaN;
   *   - colisores "hull" dos objetos: nao lancam erro, mas sao construidos a
   *     partir de um terco dos pontos, degradando a envoltoria em silencio.
   *
   * Correcao aplicada aqui: desintercalar os atributos logo apos o
   * model-loaded, antes de criar os corpos. Fica no nosso codigo, sem alterar
   * a biblioteca.
   */
  function desintercalarGeometria(raiz) {
    var convertidas = 0;
    raiz.traverse(function (o) {
      if (!o.isMesh || !o.geometry) return;
      var geom = o.geometry;
      Object.keys(geom.attributes).forEach(function (nome) {
        var a = geom.attributes[nome];
        if (!a.isInterleavedBufferAttribute) return;
        var plano = new Float32Array(a.count * a.itemSize);
        for (var i = 0; i < a.count; i++) {
          for (var k = 0; k < a.itemSize; k++) {
            plano[i * a.itemSize + k] = a.getComponent(i, k);
          }
        }
        geom.setAttribute(
          nome,
          new THREE.BufferAttribute(plano, a.itemSize, a.normalized)
        );
        convertidas++;
      });
    });
    return convertidas;
  }

  var T0 = performance.now();
  function agora() {
    return performance.now() - T0;
  }
  var DICA_NAV = "\n\nclique na cena para travar o cursor\nWASD anda · mouse olha · ESC solta";
  function log(txt) {
    hud.textContent = txt + (NAV ? DICA_NAV : "");
  }

  // ---------------------------------------------------------------- metricas
  var M = {
    variante: VARIANT,
    fisica: PHYSICS ? "on" : "off",
    desinterleave: DESINTERLEAVE ? "on" : "off",
    atributos_desintercalados: 0,
    aquecimento_s: WARMUP_S,
    janela_s: WINDOW_S,
    t_manifesto_ms: null,
    t_modelos_ms: null,
    t_corpos_ms: null,
    t_pronto_ms: null,
    n_modelos: 0,
    n_modelos_carregados: 0,
    n_corpos_criados: 0,
    n_corpos_esperados: 0,
    triangulos_renderizados: 0,
    draw_calls: null,
    erros: erros,
  };

  function pct(arr, p) {
    if (!arr.length) return null;
    var s = arr.slice().sort(function (a, b) { return a - b; });
    var i = Math.min(s.length - 1, Math.max(0, Math.floor((p / 100) * s.length)));
    return s[i];
  }
  function media(a) {
    return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : null;
  }
  function desvio(a) {
    if (a.length < 2) return 0;
    var m = media(a);
    return Math.sqrt(
      a.reduce(function (s, v) { return s + (v - m) * (v - m); }, 0) / (a.length - 1)
    );
  }

  // -------------------------------------------------------------- construcao
  // A cena so pode receber filhos depois que o A-Frame inicializou seus
  // sistemas (camera, light, gltf-model). Anexar antes disso quebra com
  // "Cannot read properties of undefined (reading 'activeCameraEl')".
  function cenaPronta() {
    return new Promise(function (resolve) {
      if (sceneEl.hasLoaded) resolve();
      else sceneEl.addEventListener("loaded", function () { resolve(); }, { once: true });
    });
  }

  Promise.all([
    fetch("scene_manifest.json").then(function (r) {
      if (!r.ok) throw new Error("manifesto HTTP " + r.status);
      return r.json();
    }),
    cenaPronta(),
  ])
    .then(function (v) {
      montar(v[0]);
    })
    .catch(function (e) {
      erros.push("inicializacao: " + String(e));
      finalizar(null);
    });

  function montar(man) {
    M.t_manifesto_ms = Math.round(agora());
    M.manifesto = {
      piso_y: man.sala.piso_y_m,
      fator_escala: man.fator_escala,
      n_objetos: man.objetos.length,
    };

    var dir = "models/" + VARIANT + "_centered/";
    var itens = [{ def: man.fundo, fundo: true }].concat(
      man.objetos.map(function (o) { return { def: o, fundo: false }; })
    );
    if (ONLY === "bg") itens = itens.filter(function (i) { return i.fundo; });
    else if (ONLY === "objects") itens = itens.filter(function (i) { return !i.fundo; });
    M.subconjunto = ONLY;
    M.n_modelos = itens.length;
    M.n_corpos_esperados = PHYSICS ? itens.length : 0;

    // Camera na altura dos olhos, dentro da sala. Em modo medicao os controles
    // ficam desligados para que todas as repeticoes rendam o mesmo quadro.
    var cam = document.createElement("a-entity");
    cam.setAttribute("camera", "fov: 70; near: 0.05; far: 100");
    cam.setAttribute("position", man.camera.position.join(" "));
    // yaw -90 enquadra a sala inteira a partir do centro (verificado na sonda
    // scripts/probe_scene.mjs); a orientacao anterior apontava para um canto vazio
    cam.setAttribute("rotation", "0 -90 0");
    if (NAV) {
      cam.setAttribute("look-controls", "pointerLockEnabled: true");
      // fly: false mantem a altura dos olhos constante ao andar
      cam.setAttribute("wasd-controls", "fly: false; acceleration: 25");
    } else {
      cam.setAttribute("look-controls", "enabled: false");
      cam.setAttribute("wasd-controls", "enabled: false");
    }
    sceneEl.appendChild(cam);

    // iluminacao: as texturas ja vem com a iluminacao assada da captura,
    // entao usamos ambiente forte e uma direcional fraca so para dar relevo
    var amb = document.createElement("a-entity");
    amb.setAttribute("light", "type: ambient; color: #ffffff; intensity: 2.0");
    sceneEl.appendChild(amb);
    var dirl = document.createElement("a-entity");
    dirl.setAttribute("light", "type: directional; color: #ffffff; intensity: 0.5");
    dirl.setAttribute("position", "3 6 2");
    sceneEl.appendChild(dirl);

    var pendentes = itens.length;
    var corposPendentes = PHYSICS ? itens.length : 0;
    var registros = [];

    itens.forEach(function (it) {
      var d = it.def;
      var pos = (d.position || [0, 0, 0]).slice();

      // levanta o objeto se a pose reconstruida o deixa cravado no piso
      if (DEPENETRAR && !it.fundo && d.altura_acima_do_piso_m < 0) {
        pos[1] += -d.altura_acima_do_piso_m + FOLGA_DEPENETRACAO;
        M.n_depenetrados = (M.n_depenetrados || 0) + 1;
        M.levantamento_total_m =
          (M.levantamento_total_m || 0) +
          (-d.altura_acima_do_piso_m + FOLGA_DEPENETRACAO);
      }

      var el = document.createElement("a-entity");
      el.setAttribute("gltf-model", "url(" + dir + d.modelo + ")");
      el.setAttribute("position", pos.join(" "));
      el.dataset.nome = d.nome;

      var reg = {
        nome: d.nome,
        fundo: it.fundo,
        pos_inicial: pos.slice(),
        massa: it.fundo ? 0 : d.massa_kg,
        el: el,
        modelo_ms: null,
        corpo_ms: null,
      };
      registros.push(reg);

      el.addEventListener("model-loaded", function () {
        reg.modelo_ms = Math.round(agora());
        M.n_modelos_carregados++;
        if (DESINTERLEAVE) {
          M.atributos_desintercalados =
            (M.atributos_desintercalados || 0) + desintercalarGeometria(el.object3D);
        }
        log(
          "modelos " + M.n_modelos_carregados + "/" + M.n_modelos +
          "\nvariante " + VARIANT + "  fisica " + (PHYSICS ? "on" : "off")
        );

        if (PHYSICS) {
          // so agora o object3DMap.mesh existe, que e o que o ammo-shape usa
          if (it.fundo) {
            el.setAttribute("ammo-body", "type: static; mass: 0; emitCollisionEvents: false");
            el.setAttribute("ammo-shape", "type: mesh");
          } else {
            el.setAttribute(
              "ammo-body",
              "type: dynamic; mass: " + d.massa_kg + "; emitCollisionEvents: false"
            );
            el.setAttribute("ammo-shape", "type: hull");
          }
        }

        if (--pendentes === 0) {
          M.t_modelos_ms = Math.round(agora());
          if (!PHYSICS) prontoParaMedir(registros, man);
        }
      });

      el.addEventListener("model-error", function (ev) {
        erros.push("model-error " + d.nome + ": " + JSON.stringify(ev.detail || {}));
        if (--pendentes === 0) {
          M.t_modelos_ms = Math.round(agora());
          if (!PHYSICS) prontoParaMedir(registros, man);
        }
      });

      if (PHYSICS) {
        el.addEventListener("body-loaded", function () {
          reg.corpo_ms = Math.round(agora());
          M.n_corpos_criados++;
          if (--corposPendentes === 0) {
            M.t_corpos_ms = Math.round(agora());
            prontoParaMedir(registros, man);
          }
        });
      }

      sceneEl.appendChild(el);
    });

    // rede de seguranca: se algum evento nunca chegar, mede assim mesmo e
    // registra a pendencia em vez de travar o experimento
    setTimeout(function () {
      if (!M.t_pronto_ms) {
        erros.push(
          "timeout de montagem: modelos " + M.n_modelos_carregados + "/" + M.n_modelos +
          ", corpos " + M.n_corpos_criados + "/" + M.n_corpos_esperados
        );
        prontoParaMedir(registros, man);
      }
    }, 120000);
  }

  // ----------------------------------------------------------------- medicao
  var jaMedindo = false;
  function prontoParaMedir(registros, man) {
    if (jaMedindo) return;
    jaMedindo = true;
    M.t_pronto_ms = Math.round(agora());

    // contagem real do que foi para a GPU
    var tris = 0;
    sceneEl.object3D.traverse(function (o) {
      if (o.isMesh && o.geometry) {
        var g = o.geometry;
        tris += g.index ? g.index.count / 3 : g.attributes.position.count / 3;
      }
    });
    M.triangulos_renderizados = Math.round(tris);

    // O laco de rAF abaixo mede a cadencia de QUADROS DO NAVEGADOR. Isso nao
    // prova que o A-Frame esta desenhando: se o render loop dele morre por uma
    // excecao, o compositor volta a 60 Hz e o rAF continua disparando. Por isso
    // contamos tambem os quadros efetivamente renderizados pelo three.js.
    var ri0 = sceneEl.renderer && sceneEl.renderer.info;
    var frameInicial = ri0 ? ri0.render.frame : null;

    var deltas = [];
    var tInicio = performance.now();
    var tFimAquec = tInicio + WARMUP_S * 1000;
    var tFim = tFimAquec + WINDOW_S * 1000;
    var anterior = tInicio;
    var quadrosAquecimento = 0;

    function quadro() {
      var t = performance.now();
      var dt = t - anterior;
      anterior = t;
      if (t < tFimAquec) {
        quadrosAquecimento++;
      } else if (dt > 0) {
        deltas.push(dt);
      }
      if (t < tFim) {
        requestAnimationFrame(quadro);
      } else {
        concluir(registros, man, deltas, quadrosAquecimento, frameInicial);
      }
      var restante = Math.max(0, (tFim - t) / 1000);
      if (deltas.length % 15 === 0) {
        log(
          "variante " + VARIANT + "   fisica " + (PHYSICS ? "on" : "off") +
          "\nmedindo… " + restante.toFixed(1) + " s" +
          "\nquadros " + deltas.length +
          "\ntri " + M.triangulos_renderizados.toLocaleString("pt-BR") +
          "\ncorpos " + M.n_corpos_criados + "/" + M.n_corpos_esperados
        );
      }
    }
    requestAnimationFrame(quadro);
  }

  function concluir(registros, man, deltas, quadrosAquecimento, frameInicial) {
    // O FPS e derivado do tempo de quadro, nunca da media de 1000/dt: essa
    // media e dominada pelos quadros mais rapidos e chega a inflar o valor em
    // uma ordem de grandeza quando o vsync esta desligado.
    //   fps_efetivo    = numero de quadros / tempo decorrido  (a taxa real)
    //   fps_1pct_low   = 1000 / percentil 99 do tempo de quadro (os piores 1%)
    var somaMs = deltas.reduce(function (a, b) { return a + b; }, 0);
    M.quadros_aquecimento = quadrosAquecimento;
    M.quadros_medidos = deltas.length;
    M.duracao_medida_s = +(somaMs / 1000).toFixed(3);

    M.frametime_medio_ms = media(deltas);
    M.frametime_mediano_ms = pct(deltas, 50);
    M.frametime_p95_ms = pct(deltas, 95);
    M.frametime_p99_ms = pct(deltas, 99);
    M.frametime_max_ms = deltas.length ? Math.max.apply(null, deltas) : null;
    M.frametime_desvio_ms = desvio(deltas);

    M.fps_efetivo = somaMs > 0 ? (deltas.length * 1000) / somaMs : null;
    M.fps_mediano = M.frametime_mediano_ms ? 1000 / M.frametime_mediano_ms : null;
    M.fps_1pct_low = M.frametime_p99_ms ? 1000 / M.frametime_p99_ms : null;
    M.fps_5pct_low = M.frametime_p95_ms ? 1000 / M.frametime_p95_ms : null;
    M.fps_min = M.frametime_max_ms ? 1000 / M.frametime_max_ms : null;
    M.quadros_acima_50ms = deltas.filter(function (d) { return d > 50; }).length;

    // deslocamento em relacao a pose reconstruida pelo HoloScene
    var pisoY = man.sala.piso_y_m;
    var desl = [];
    var detalhe = [];
    registros.forEach(function (r) {
      if (r.fundo) return;
      var p = r.el.object3D.position;
      var dx = p.x - r.pos_inicial[0];
      var dy = p.y - r.pos_inicial[1];
      var dz = p.z - r.pos_inicial[2];
      var dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      desl.push(dist);
      detalhe.push({
        nome: r.nome,
        massa_kg: r.massa,
        x0: +r.pos_inicial[0].toFixed(4),
        y0: +r.pos_inicial[1].toFixed(4),
        z0: +r.pos_inicial[2].toFixed(4),
        x1: +p.x.toFixed(4),
        y1: +p.y.toFixed(4),
        z1: +p.z.toFixed(4),
        deslocamento_m: +dist.toFixed(4),
        queda_y_m: +(-dy).toFixed(4),
        abaixo_do_piso: p.y < pisoY - 0.5,
        modelo_ms: r.modelo_ms,
        corpo_ms: r.corpo_ms,
      });
    });

    if (PHYSICS && desl.length) {
      M.desloc_mediano_m = pct(desl, 50);
      M.desloc_medio_m = media(desl);
      M.desloc_max_m = Math.max.apply(null, desl);
      M.desloc_min_m = Math.min.apply(null, desl);
      M.n_abaixo_do_piso = detalhe.filter(function (d) { return d.abaixo_do_piso; }).length;
      M.n_praticamente_parados = desl.filter(function (d) { return d < 0.01; }).length;
      M.n_movidos_acima_10cm = desl.filter(function (d) { return d > 0.10; }).length;
    } else {
      M.desloc_mediano_m = null;
      M.desloc_medio_m = null;
      M.desloc_max_m = null;
      M.n_abaixo_do_piso = null;
    }

    // Custo de construcao dos colisores. A diferenca entre "ultimo corpo" e
    // "ultimo modelo" nao serve: os corpos sao criados a medida que cada
    // modelo chega, entao as duas janelas se sobrepoem e o resultado da ~0.
    // O que interessa e a latencia por entidade (corpo_ms - modelo_ms) e,
    // em especial, a do fundo, que usa colisor de malha com 250 mil triangulos.
    var lat = registros
      .filter(function (r) { return r.corpo_ms !== null && r.modelo_ms !== null; })
      .map(function (r) {
        return { nome: r.nome, fundo: r.fundo, ms: r.corpo_ms - r.modelo_ms };
      });
    if (lat.length) {
      var todos = lat.map(function (l) { return l.ms; });
      var objs = lat.filter(function (l) { return !l.fundo; }).map(function (l) { return l.ms; });
      var fundoLat = lat.filter(function (l) { return l.fundo; });
      M.t_colisor_max_ms = Math.max.apply(null, todos);
      M.t_colisor_medio_objetos_ms = media(objs);
      M.t_colisor_mediano_objetos_ms = pct(objs, 50);
      M.t_colisor_fundo_ms = fundoLat.length ? fundoLat[0].ms : null;
      M.t_colisores_span_ms = M.t_corpos_ms;
    } else {
      M.t_colisor_max_ms = null;
      M.t_colisor_medio_objetos_ms = null;
      M.t_colisor_mediano_objetos_ms = null;
      M.t_colisor_fundo_ms = null;
      M.t_colisores_span_ms = null;
    }

    if (performance.memory) {
      M.heap_usado_mb = +(performance.memory.usedJSHeapSize / 1048576).toFixed(1);
      M.heap_total_mb = +(performance.memory.totalJSHeapSize / 1048576).toFixed(1);
    }
    var ri = sceneEl.renderer && sceneEl.renderer.info;
    if (ri) {
      M.draw_calls = ri.render.calls;
      M.geometrias = ri.memory.geometries;
      M.texturas = ri.memory.textures;
      if (frameInicial !== null) {
        M.quadros_renderizados_aframe = ri.render.frame - frameInicial;
        M.fps_render_aframe =
          somaMs > 0 ? (M.quadros_renderizados_aframe * 1000) / somaMs : null;
        // se o A-Frame desenhou muito menos do que o navegador apresentou,
        // o render loop esta travado e o "fps" acima nao mede desempenho
        M.render_loop_vivo =
          M.quadros_renderizados_aframe > 0.5 * M.quadros_medidos;
      }
    }

    M.objetos = detalhe;
    finalizar(M);
  }

  function finalizar(res) {
    window.__RESULT = res || { erro_fatal: true, erros: erros, variante: VARIANT };
    window.__DONE = true;
    log(
      "PRONTO  " + VARIANT + " / fisica " + (PHYSICS ? "on" : "off") +
      (res
        ? "\nfps efetivo " + res.fps_efetivo.toFixed(1) +
          "   1% low " + res.fps_1pct_low.toFixed(1) +
          "\nframetime " + res.frametime_medio_ms.toFixed(2) + " ms" +
          "   p99 " + res.frametime_p99_ms.toFixed(2) + " ms" +
          "\ncarga " + res.t_modelos_ms + " ms   colisor fundo " +
          (res.t_colisor_fundo_ms === null ? "—" : res.t_colisor_fundo_ms + " ms") +
          "\ncorpos " + res.n_corpos_criados + "/" + res.n_corpos_esperados +
          "\ntri " + res.triangulos_renderizados.toLocaleString("pt-BR") +
          (res.desloc_mediano_m !== null
            ? "\ndesloc mediano " + res.desloc_mediano_m.toFixed(3) + " m"
            : "")
        : "\nFALHA") +
      (erros.length ? "\nerros: " + erros.length : "")
    );
  }
})();
