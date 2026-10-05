@echo off
setlocal
title Flowdeck - BTC perpetual order flow
cd /d "%~dp0backend"

set "PY=python"
where py >nul 2>nul && set "PY=py -3"

if not exist ".venv\Scripts\python.exe" (
  echo Creating the Python environment ^(first run only^)...
  %PY% -m venv .venv
  if errorlevel 1 goto nopython
)
call ".venv\Scripts\activate.bat"
echo Checking dependencies...
python -m pip install --disable-pip-version-check -q -r requirements.txt
if errorlevel 1 goto pipfail

echo.
echo  Flowdeck is starting on http://127.0.0.1:8000
echo  Your browser opens automatically. Close this window to stop the server.
echo.
python run.py --open %*
goto end

:nopython
echo.
echo Python 3.9 or newer is required. Install it from https://www.python.org/downloads/
echo (tick "Add python.exe to PATH"), then run start.bat again.
pause
goto end

:pipfail
echo.
echo Installing the dependencies failed. Check your internet connection and run start.bat again.
pause

:end
endlocal
