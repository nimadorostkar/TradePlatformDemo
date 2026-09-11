@echo off
REM ---------------------------------------------------------------------------
REM One-shot update of the Go gateway. Native cmd.exe -- no PowerShell, no
REM execution policy to fight. Run from an elevated prompt:
REM
REM     C:\opomtsocket-go\update.bat
REM
REM It backs up the running binary, swaps in the new one, and ROLLS BACK
REM automatically if the gateway does not come back healthy.
REM ---------------------------------------------------------------------------
setlocal enabledelayedexpansion

set "DIR=C:\opomtsocket-go"
set "TASK=OpoGatewayGo"
set "PORT=5070"
set "NEW=%DIR%\gateway.new.exe"
set "CUR=%DIR%\gateway.exe"
set "PREV=%DIR%\gateway.exe.prev"
set "ENVF=%DIR%\gateway.env"

echo.
echo === OpoMTSocket Go gateway update ===
echo.

REM -- 1. Preflight -----------------------------------------------------------
if not exist "%NEW%" (
  echo [FAIL] %NEW% not found.
  echo        Copy the new gateway.exe there, named gateway.new.exe, then re-run.
  exit /b 1
)
if not exist "%ENVF%" (
  echo [FAIL] %ENVF% not found. Nothing was changed.
  exit /b 1
)
echo [ok]   new binary present

REM -- 2. Account-type guard --------------------------------------------------
REM The new default admits types 57-67 only. The previous build also admitted
REM 11 and 26. A trader holding ONLY those would get a token with no accounts
REM claim and be 401'd on every protected endpoint -- locked out, not merely
REM hidden from the selector. Add the previous list so this update changes
REM nothing until someone decides otherwise.
findstr /C:"CRM_ALLOWED_ACCOUNT_TYPES" "%ENVF%" >nul 2>&1
if errorlevel 1 (
  echo [add]  CRM_ALLOWED_ACCOUNT_TYPES was missing - appending the previous list
  echo.>>"%ENVF%"
  echo CRM_ALLOWED_ACCOUNT_TYPES=11,26,57,58,59,60,61,62,63,64,65,66,67>>"%ENVF%"
) else (
  echo [ok]   CRM_ALLOWED_ACCOUNT_TYPES already set
)

REM -- 3. Stop, back up, swap -------------------------------------------------
echo [..]   stopping %TASK%
schtasks /end /tn %TASK% >nul 2>&1
timeout /t 3 /nobreak >nul
taskkill /F /IM gateway.exe >nul 2>&1
timeout /t 2 /nobreak >nul

if exist "%CUR%" (
  copy /Y "%CUR%" "%PREV%" >nul
  echo [ok]   previous binary saved to %PREV%
)
copy /Y "%NEW%" "%CUR%" >nul
if errorlevel 1 (
  echo [FAIL] could not replace %CUR% - is gateway.exe still running?
  schtasks /run /tn %TASK% >nul 2>&1
  exit /b 1
)
echo [ok]   new binary installed

echo [..]   starting %TASK%
schtasks /run /tn %TASK% >nul 2>&1

REM -- 4. Verify --------------------------------------------------------------
echo [..]   waiting for startup
set "CODE=000"
for /L %%i in (1,1,15) do (
  timeout /t 2 /nobreak >nul
  for /f %%c in ('curl -s -o nul -w "%%{http_code}" http://localhost:%PORT%/healthz 2^>nul') do set "CODE=%%c"
  if "!CODE!"=="200" goto :healthy
)

echo [FAIL] /healthz never returned 200. Rolling back.
schtasks /end /tn %TASK% >nul 2>&1
timeout /t 3 /nobreak >nul
taskkill /F /IM gateway.exe >nul 2>&1
if exist "%PREV%" (
  copy /Y "%PREV%" "%CUR%" >nul
  schtasks /run /tn %TASK% >nul 2>&1
  echo [ok]   rolled back to the previous binary and restarted it
)
echo.
echo Last log lines:
powershell -NoProfile -Command "Get-Content '%DIR%\logs\gateway.log' -Tail 40" 2>nul
exit /b 1

:healthy
echo [ok]   /healthz alive
for /f %%c in ('curl -s -o nul -w "%%{http_code}" http://localhost:%PORT%/readyz 2^>nul') do set "RDY=%%c"
if "!RDY!"=="200" (
  echo [ok]   /readyz ready
) else (
  echo [warn] /readyz not ready yet - the MT5 session may still be authenticating
)

REM The NEW build must be the one running: this endpoint does not exist in the
REM old binary, so a 404 here means the swap silently did not take effect.
for /f %%c in ('curl -s -o nul -w "%%{http_code}" http://localhost:%PORT%/api/Capabilities 2^>nul') do set "CAP=%%c"
if not "!CAP!"=="200" (
  echo [FAIL] /api/Capabilities returned !CAP! - the OLD binary is still running.
  echo        No rollback needed, but the update did not take effect.
  exit /b 1
)
echo [ok]   new build confirmed live
echo.
echo Capabilities:
curl -s http://localhost:%PORT%/api/Capabilities
echo.
echo.
echo === Update complete ===
if defined PUBLIC_BASE_URL (
  echo Verify externally: %PUBLIC_BASE_URL%/api/Capabilities
) else (
  echo Verify externally: ^<this deployment's public base URL^>/api/Capabilities
  echo   ^(set PUBLIC_BASE_URL to have this line name the host^)
)
exit /b 0
