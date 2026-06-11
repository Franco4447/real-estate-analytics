# 🏠 Comparativa de Departamentos — Panel + Mapa (CABA)

Panel analítico y mapa interactivo para decidir **a qué departamento mudarme**, alimentado
por un único Excel. Pensado para publicarse en **GitHub Pages**: editás el Excel, hacés
`git push`, y el sitio se reconstruye y redespliega solo.

![flujo](https://img.shields.io/badge/fuente-Excel-217346) ![deploy](https://img.shields.io/badge/deploy-GitHub%20Pages-2f6df0)

---

## ¿Qué hace?

- **KPIs** generales (precio promedio, USD/m², superficie, mejor valor, más cerca de subte…).
- **Listado rankeable** con un **score 0–100** por cada depto, compuesto por 4 dimensiones
  ajustables con sliders **en vivo**: 💵 Precio/USD·m² · 📍 Ubicación+transporte · 📐 Tamaño/ambientes · ✨ Estado/luz.
- **Filtros**: barrio, ambientes, balcón/terraza, apto crédito, precio máx, m² mín, minutos a la subte.
- **Mapa** (Leaflet + OpenStreetMap) con un pin por depto coloreado por score. Click → **popup**
  con datos clave + botón **“Ver detalle”** que abre el panel lateral con todo el desglose.
- **Sincronización** lista ↔ mapa (hover resalta el pin; click en el pin selecciona la tarjeta).
- **🧭 Planear recorrido** (botón en el mapa): agrupa los deptos a < *radio* m en **zonas** (un
  círculo por zona), traza el **recorrido más corto** para visitarlas todas y abre el **recorrido
  completo en Google Maps**. Distancia y tiempo **reales por calle** (OSRM/OpenStreetMap), con
  **radio configurable**, **punto de partida** (tu ubicación) e **ida y vuelta** opcionales.
- **Análisis** (gráficos): Precio vs. Superficie (burbuja = score), USD/m² y minutos a la subte.
- **Valor agregado calculado**: distancia caminando a la **subte más cercana**, margen de
  negociación, expensas estimadas en USD, y aviso de **datos faltantes** (`?` en el Excel).

---

## Estructura

```
real-estate-analytics/
├─ data/
│  ├─ Departamentos Comparativa.xlsx   ← TU EXCEL (única fuente de verdad)
│  ├─ geocode_cache.json               ← coords cacheadas (no re-geocodifica lo ya resuelto)
│  └─ subte_stations.json              ← estaciones de subte CABA (para distancias)
├─ build.py                            ← ETL: lee Excel → limpia → métricas → geocodifica → data.js
├─ data.js                             ← GENERADO (lo consume el sitio; no editar a mano)
├─ index.html · styles.css · app.js    ← el sitio estático
├─ .github/workflows/deploy.yml        ← pipeline: push → rebuild → deploy a Pages
├─ requirements.txt · preview.bat · README.md
```

---

## Actualizar los datos

1. Abrí y editá **`data/Departamentos Comparativa.xlsx`** (agregá/quitá/modificá filas).
2. Guardá, `git add -A && git commit -m "datos" && git push`.
3. La **GitHub Action** corre `build.py` (limpia, recalcula métricas, geocodifica sólo
   direcciones nuevas) y **redespliega Pages** en ~1 minuto. Listo.

> El código es **adaptativo**: detecta las columnas por nombre (sin importar acentos ni
> mayúsculas) y arrastra columnas extra al detalle. Si renombrás razonablemente o agregás
> columnas, sigue funcionando.

### Preview local (sin esperar a Pages)
Doble-click a **`preview.bat`** (Windows). Regenera `data.js` y sirve en `http://localhost:8000`.
Manual:
```bash
pip install -r requirements.txt
python build.py
python -m http.server 8000   # abrir http://localhost:8000
```

---

## Publicar en GitHub Pages (una sola vez)

1. Creá el repo en GitHub y subí esta carpeta (rama `main`).
2. **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. El primer push dispara el workflow; la URL aparece en la pestaña **Actions** y en Settings → Pages.

---

## Metodología del score

Cada dimensión se normaliza **0–1 contra el conjunto** (min-max) y luego se pondera por el
slider correspondiente. Los datos faltantes se imputan a neutro (0.5) y se marcan en el detalle.

| Dimensión | Cómo se calcula |
|---|---|
| 💵 **Precio** | 60% USD/m² (menos = mejor) + 40% precio total (menos = mejor) |
| 📍 **Ubicación** | 80% cercanía a la subte (más cerca = mejor) + 20% menciones de transporte en “Motivo” |
| 📐 **Tamaño** | 70% m² (más = mejor) + 30% ambientes |
| ✨ **Estado** | 35% antigüedad (más nuevo = mejor) + 25% orientación + 25% balcón/terraza + 15% frente/contrafrente; penaliza 15% si el “Motivo” menciona refacciones |

El **score final** = promedio ponderado de las 4 dimensiones × 100, según los pesos que elijas.
Cambiá los pesos y el ranking + el color de los pines se recalculan al instante.

---

## Geocodificación

- Se usa **Nominatim (OpenStreetMap)**, acotado al *bounding box* de CABA para evitar
  falsos positivos (p. ej. calles homónimas en el interior).
- Los resultados se **cachean** en `data/geocode_cache.json` (clave = dirección normalizada),
  así no se vuelve a pedir lo ya resuelto.
- **¿Un pin mal ubicado?** Dos opciones:
  1. Editá la entrada correspondiente en `data/geocode_cache.json` (`lat`/`lng`), **o**
  2. Agregá columnas **`lat`** y **`lng`** (o `latitud`/`longitud`) al Excel: tienen prioridad.

---

## Notas

- Mezcla de monedas: precios en **USD**, expensas en **ARS**. El detalle muestra las expensas
  también en USD usando el tipo de cambio (editable con `python build.py --rate 1150`).
- El sitio publicado sólo expone `index.html`, `styles.css`, `app.js` y `data.js`. El Excel
  y `build.py` quedan en el repo pero **no se sirven** (mirá el paso “Armar el sitio” del workflow).
- **Planear recorrido**: el ruteo por calle usa el **servidor público de demo de OSRM**
  (`router.project-osrm.org`, perfil auto, sin API key). Es *best-effort* y con límite de uso; si
  no responde, el recorrido cae automáticamente a **distancia en línea recta**. El medio de
  transporte (auto/transporte/a pie) se aplica al **link de Google Maps**; la vista previa en el
  mapa siempre usa la red vial de auto.
