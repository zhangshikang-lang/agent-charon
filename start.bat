@echo off
title MARK 42
set ELECTRON_RUN_AS_NODE=
cd /d "%~dp0"
start "" node_modules\electron\dist\electron.exe .
exit
