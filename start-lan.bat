@echo off
rem Same as start.bat, but phones, tablets and other PCs on your Wi-Fi can open Flowdeck too.
rem The addresses to type on those devices are printed when the server starts.
call "%~dp0start.bat" --lan %*
