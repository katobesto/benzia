@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"

echo ============================================
echo   benzIA - dashboard con gateway y chat multiusuario Para tu ia local
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js no esta instalado o no esta en el PATH.
    echo Descargalo desde https://nodejs.org
    pause
    exit /b 1
)

if not exist node_modules (
    echo [INFO] Primera ejecucion: instalando dependencias...
    call npm install
    if errorlevel 1 (
        echo [ERROR] npm install fallo.
        pause
        exit /b 1
    )
)

if not exist .env (
    echo [INFO] No existe .env: se crea a partir de .env.example
    copy .env.example .env >nul
    echo [AVISO] Edita .env y cambia ADMIN_TOKEN antes de usar el panel.
    echo         Si no lo haces, se generara un token temporal en cada arranque.
    echo.
)

rem --- Puertos configurados (por defecto 3400/3401, se leen de .env) ---
set "ADMIN_PORT=3400"
set "GATEWAY_PORT=3401"
set "MAX_KILLS=5"
if exist .env (
    for /f "tokens=1,* delims==" %%A in ('findstr /r /b "ADMIN_PORT=\|GATEWAY_PORT=" .env 2^>nul') do (
        if "%%A"=="ADMIN_PORT" set "ADMIN_PORT=%%B"
        if "%%A"=="GATEWAY_PORT" set "GATEWAY_PORT=%%B"
    )
)

echo [INFO] Puertos: panel=%ADMIN_PORT% gateway=%GATEWAY_PORT%
call :liberar-puerto %ADMIN_PORT%
call :liberar-puerto %GATEWAY_PORT%

echo.
echo [INFO] Arrancando benzIA...
echo.
node --disable-warning=ExperimentalWarning src\server.js

if errorlevel 1 (
    echo.
    echo [ERROR] El servicio termino con un error.
    pause
)

endlocal
goto :eof

:liberar-puerto
set "PUERTO=%~1"
set /a "MATES=0"
for /f "tokens=1,* delims=|" %%P in ('powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort %PUERTO% -State Listen -EA SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { $p = Get-Process -Id $_ -EA SilentlyContinue; if ($p) { Write-Output ($_.ToString() + '|' + $p.ProcessName) } }"') do (
    set "NOMBRE=%%Q"
    if /i "!NOMBRE!"=="node" (
        if !MATES! LSS %MAX_KILLS% (
            echo [KILL] Puerto %PUERTO% ocupado por !NOMBRE! PID %%P: terminando proceso
            taskkill /F /PID %%P >nul 2>nul
            set /a MATES+=1
        ) else (
            echo [SKIP] Maximo %MAX_KILLS% procesos alcanzado: !NOMBRE! PID %%P no se toca
        )
    ) else (
        echo [SKIP] Puerto %PUERTO% ocupado por !NOMBRE! PID %%P: no es node, no se toca
    )
)
if !MATES! EQU 0 echo [OK]   Puerto %PUERTO% libre.
goto :eof
