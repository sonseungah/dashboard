@echo off
echo ====================================
echo  PC 모니터링 대시보드 시작 중...
echo ====================================

cd /d "%~dp0"

python -c "import flask,psutil" 2>nul
if errorlevel 1 (
    echo 필요한 패키지를 설치합니다...
    if exist wheels\ (
        echo [오프라인 모드] wheels 폴더에서 설치합니다.
        pip install --no-index --find-links=wheels flask psutil nvidia-ml-py
    ) else (
        echo [온라인 모드] 인터넷에서 설치합니다.
        pip install flask psutil nvidia-ml-py
    )
)

echo.
echo 브라우저에서 http://localhost:5000 을 여세요
echo 종료하려면 이 창에서 Ctrl+C 를 누르세요
echo.

start /b cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:5000"

python app.py
pause
