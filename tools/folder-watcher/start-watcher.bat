@echo off
rem CC CREST folder watcher - double click to start (keep the window open; close it to stop)
cd /d "%~dp0"
if not exist config.json (
  echo config.json not found. Copy config.example.json to config.json and fill it in first.
  pause
  exit /b 1
)
node watcher.js
pause
