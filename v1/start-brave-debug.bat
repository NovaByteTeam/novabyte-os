@echo off
echo Starting Brave Browser with Remote Debugging Port...
echo This allows Horizon to use real browser tabs for web browsing.
echo.
echo IMPORTANT: Keep this window open while using Horizon!
echo Close this window to stop Brave.
echo.
REM Launch Brave with debug port - runs in background
REM --disable-blink-features=AutomationDetection hides automation
REM --noerrdialogs suppresses error dialogs  
REM --start-maximized opens maximized
REM --quiet reduces startup noise
start "" "C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe" --remote-debugging-port=9222 --disable-blink-features=AutomationDetection --noerrdialogs --quiet