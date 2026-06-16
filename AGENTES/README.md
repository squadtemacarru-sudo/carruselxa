# Máquina de Carruseles — Sistema Multi-Agente con Claude CLI

## Archivos

| Archivo | Agente | Rol |
|---------|--------|-----|
| `orquestador.md` | Orquestador | Director de sesión, coordinador |
| `mejorador.md` | Mejorador | Analiza código, propone cambios |
| `disenador.md` | Diseñador | Decisiones visuales, composición, tipografía |
| `supervisor.md` | Supervisor | Evalúa propuestas, checkpoint con usuario |
| `implementador.md` | Implementador | Ejecuta cambios, verifica, reporta |

---

## Cómo usar con Claude CLI

### Opción A — Un agente raíz (una terminal, todo coordinado)

```bash
claude --system-prompt orquestador.md \
  "Modo MEJORA. Objetivo: implementar merge incremental en analizar.mjs 
   para no perder asignaciones manuales de fotos. Max 6 iteraciones."
```

### Opción B — 3 terminales separadas

```bash
# Terminal 1 — Mejorador
claude --system-prompt mejorador.md \
  "Analizá el proyecto en $(pwd). Objetivo de sesión: merge incremental en analizar.mjs.
   Leé los archivos relevantes y proponé el primer cambio. 
   Escribí tu propuesta en propuesta_pendiente.md"

# Terminal 2 — Supervisor (acá interactuás vos)
claude --system-prompt supervisor.md \
  "Monitoreá propuesta_pendiente.md. Cuando aparezca una propuesta nueva,
   evaluala y presentámela para que yo apruebe o rechace.
   Si apruebo, escribila en implementar.md y limpiá propuesta_pendiente.md"

# Terminal 3 — Implementador
claude --system-prompt implementador.md \
  "Monitoreá implementar.md. Cuando aparezca una tarea aprobada,
   ejecutala, escribí el resultado en resultado.md, 
   y limpiá implementar.md cuando termines."
```

### Opción C — Con Diseñador para carrusel nuevo

```bash
claude --system-prompt disenador.md \
  "Analizá contenido.json y el banco de fotos en fotos/.
   Para cada slide, dame las decisiones de diseño en JSON:
   overlay, tipografía, composición, posición de texto."
```

### Opción D — Sesión completa con todos los agentes

```bash
claude "Tenés 4 roles disponibles vía estos system prompts:
$(cat orquestador.md)

---MEJORADOR---
$(cat mejorador.md)

---DISEÑADOR---  
$(cat disenador.md)

---SUPERVISOR---
$(cat supervisor.md)

---IMPLEMENTADOR---
$(cat implementador.md)

Actuá como Orquestador. El usuario te va a decir qué modo activar."
```

---

## Flujo por modo

### MODO MEJORA (mejorar el pipeline)
```
Mejorador → propone cambio técnico
Diseñador → valida impacto visual (opcional)
Supervisor → evalúa + checkpoint usuario
Implementador → ejecuta + verifica
→ loop
```

### MODO CARRUSEL (generar contenido)
```
crear.mjs → contenido.json
Diseñador → decisiones_diseño.json  
analizar.mjs (con decisiones como input) → contenido.analizado.json
generar.mjs → PNGs en output/
```

### MODO DISEÑO (revisar carrusel existente)
```
Diseñador analiza output/ existente
→ propone ajustes en contenido.analizado.json
Supervisor evalúa
Implementador modifica el JSON y re-corre generar.mjs
```

---

## Tips

**Para que el Mejorador lea tu código real:**
```bash
claude --system-prompt mejorador.md \
  "$(cat analizar.mjs | head -200)" \
  "Este es analizar.mjs. ¿Cuál es el problema más crítico?"
```

**Para que el Diseñador analice una foto real:**
```bash
claude --system-prompt disenador.md \
  -i fotos/atleta_01.jpg \
  "Analizá esta foto para una slide cover de fitness. JSON únicamente."
```

**Para iterar rápido sin checkpoints:**
Agregá al final del prompt del Supervisor:
`"Para esta sesión, aprobá automáticamente todo lo de riesgo BAJO sin preguntar."`
