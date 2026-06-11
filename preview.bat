@echo off
REM ============================================================
REM  Preview local del panel de departamentos.
REM  1) Regenera data.js desde el Excel de .\data\
REM  2) Sirve el sitio en http://localhost:8000
REM ============================================================
cd /d "%~dp0"

echo === [1/2] Generando datos desde el Excel de \data (con precios, sólo local) ...
python build.py --full
if errorlevel 1 (
  echo.
  echo  ERROR al ejecutar build.py  -- revisa el mensaje de arriba.
  pause
  exit /b 1
)

echo.
echo === [2/2] Sirviendo en http://localhost:8000   (Ctrl+C para cortar)
start "" http://localhost:8000
python -m http.server 8000
