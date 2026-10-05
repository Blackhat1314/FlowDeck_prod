@echo off
rem Installs the frontend packages listed in package.json (framer-motion, React, Vite, three ...) into node_modules.
cd /d "%~dp0"
echo Installing the frontend packages into %CD%\node_modules ...
where npm >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed on this PC. Install the LTS version from https://nodejs.org and run this file again.> npm-install.log
  type npm-install.log
  timeout /t 20
  exit /b 1
)
call npm install > npm-install.log 2>&1
echo exit code %errorlevel%>> npm-install.log
call npm ls framer-motion >> npm-install.log 2>&1
type npm-install.log
echo.
echo Finished. This window closes by itself.
timeout /t 15
