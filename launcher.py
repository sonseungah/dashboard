"""
배포용 진입점.
Flask 서버를 백그라운드 스레드에서 실행하고 시스템 트레이 아이콘을 표시합니다.
트레이 아이콘 우클릭 → 종료로 앱을 닫을 수 있습니다.
"""
import sys
import os
import threading
import webbrowser
import time

# PyInstaller 번들 실행 시 작업 디렉터리를 exe 위치로 설정
if getattr(sys, 'frozen', False):
    os.chdir(os.path.dirname(sys.executable))

import pystray
from PIL import Image, ImageDraw

PORT = 5000
URL  = f"http://localhost:{PORT}"


def _make_icon() -> Image.Image:
    """트레이 아이콘을 프로그래밍 방식으로 생성합니다 (64×64 RGBA)."""
    size = 64
    img  = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d    = ImageDraw.Draw(img)

    # 파란 원형 배경
    d.ellipse([0, 0, size - 1, size - 1], fill='#5397F5')

    # 모니터 외곽
    d.rounded_rectangle([11, 13, 53, 41], radius=3, outline='white', width=3)

    # 미니 막대 차트 (화면 안)
    bars = [(16, 34), (23, 28), (30, 31), (37, 22), (44, 26)]
    for x, top in bars:
        d.rectangle([x, top, x + 4, 37], fill='white')

    # 스탠드
    d.rectangle([29, 41, 35, 48], fill='white')
    d.rectangle([22, 48, 42, 51], fill='white')

    return img


def _open_browser(_icon=None, _item=None):
    webbrowser.open(URL)


def _quit(icon: pystray.Icon, _item):
    icon.stop()
    os._exit(0)


def _wait_then_open():
    """Flask 워밍업 후 브라우저를 자동으로 엽니다."""
    time.sleep(2)
    webbrowser.open(URL)


def main():
    # Flask를 데몬 스레드에서 실행
    from app import run_server
    flask_thread = threading.Thread(target=run_server, kwargs={'port': PORT}, daemon=True)
    flask_thread.start()

    # 2초 후 브라우저 자동 오픈
    threading.Thread(target=_wait_then_open, daemon=True).start()

    # 시스템 트레이 아이콘
    menu = pystray.Menu(
        pystray.MenuItem('대시보드 열기', _open_browser, default=True),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem('종료', _quit),
    )
    icon = pystray.Icon(
        name='PC Dashboard',
        icon=_make_icon(),
        title='PC 모니터링 대시보드',
        menu=menu,
    )
    icon.run()   # 메인 스레드를 점유 (트레이 이벤트 루프)


if __name__ == '__main__':
    main()
