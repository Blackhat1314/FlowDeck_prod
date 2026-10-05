@echo off
rem Run this ONCE with a right-click > "Run as administrator" if other devices can't reach Flowdeck.
rem It lets devices on PRIVATE networks (your home Wi-Fi) connect to port 8000. Public Wi-Fi stays blocked.
net session >nul 2>&1
if errorlevel 1 (
  echo.
  echo  Please right-click this file and choose "Run as administrator".
  echo.
  pause
  exit /b 1
)
netsh advfirewall firewall delete rule name="Flowdeck (port 8000)" >nul 2>&1
netsh advfirewall firewall add rule name="Flowdeck (port 8000)" dir=in action=allow protocol=TCP localport=8000 profile=private
echo.
echo  Done. Devices on your private network can now open Flowdeck on port 8000.
echo  If it still fails, check that your Wi-Fi is set to "Private network" in Windows Settings ^> Network ^& internet.
echo.
pause
