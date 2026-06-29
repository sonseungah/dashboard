from flask import Flask, render_template, jsonify, request, Response
import psutil
import platform
import time
from datetime import datetime
import threading
import sqlite3
import os
import sys

# PyInstaller 번들 실행 시 경로를 올바르게 설정
if getattr(sys, 'frozen', False):
    _BASE = sys._MEIPASS
else:
    _BASE = os.path.dirname(os.path.abspath(__file__))

app = Flask(__name__,
            template_folder=os.path.join(_BASE, 'templates'),
            static_folder=os.path.join(_BASE, 'static'))


def _get_cpu_name():
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,
                            r"HARDWARE\DESCRIPTION\System\CentralProcessor\0") as key:
            return winreg.QueryValueEx(key, "ProcessorNameString")[0].strip()[:80]
    except Exception:
        return (platform.processor() or 'Unknown')[:80]


GPU_BACKEND = None
try:
    import pynvml
    pynvml.nvmlInit()
    GPU_BACKEND = 'pynvml'
except Exception:
    pass

history = {
    'timestamps': [],
    'cpu': [],
    'memory': [],
    'gpu': [],
    'net_download': [],
    'net_upload': [],
    'disk_read': [],
    'disk_write': [],
}
MAX_HISTORY = 1800

_prev_net_io = None
_prev_disk_io = None
_prev_time = None
_lock = threading.Lock()
_stats_cache = None   # written by background thread, read by /api/stats

# 패키지 실행 시 exe 옆에, 개발 실행 시 소스 폴더에 DB 저장
if getattr(sys, 'frozen', False):
    DB_PATH = os.path.join(os.path.dirname(sys.executable), 'history.db')
else:
    DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'history.db')
_last_db_minute = None


def init_db():
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute('''
            CREATE TABLE IF NOT EXISTS metrics (
                ts      INTEGER PRIMARY KEY,
                cpu     REAL, memory  REAL, gpu    REAL,
                dl      REAL, ul      REAL,
                disk_r  REAL, disk_w  REAL
            )
        ''')
        conn.execute('CREATE INDEX IF NOT EXISTS idx_ts ON metrics (ts)')


def maybe_flush_to_db():
    """매 분마다 직전 60초 평균을 DB에 저장하고 7일 초과 데이터를 삭제합니다."""
    global _last_db_minute
    cur_min = int(time.time() // 60)
    if cur_min == _last_db_minute:
        return
    _last_db_minute = cur_min

    with _lock:
        n = min(60, len(history['cpu']))
        if n < 1:
            return
        def avg(k):
            return round(sum(history[k][-n:]) / n, 2)
        row = (
            cur_min * 60,
            avg('cpu'), avg('memory'), avg('gpu'),
            avg('net_download'), avg('net_upload'),
            avg('disk_read'), avg('disk_write'),
        )

    try:
        cutoff = cur_min * 60 - 7 * 24 * 3600
        with sqlite3.connect(DB_PATH) as conn:
            conn.execute('INSERT OR REPLACE INTO metrics VALUES (?,?,?,?,?,?,?,?)', row)
            conn.execute('DELETE FROM metrics WHERE ts < ?', (cutoff,))
    except Exception as e:
        print(f'[DB] 저장 오류: {e}')


def get_gpu_info():
    if GPU_BACKEND == 'pynvml':
        try:
            h = pynvml.nvmlDeviceGetHandleByIndex(0)
            util = pynvml.nvmlDeviceGetUtilizationRates(h)
            mem  = pynvml.nvmlDeviceGetMemoryInfo(h)
            temp = pynvml.nvmlDeviceGetTemperature(h, pynvml.NVML_TEMPERATURE_GPU)
            name = pynvml.nvmlDeviceGetName(h)
            return {
                'available': True,
                'name': name,
                'usage': round(util.gpu, 1),
                'memory_used': round(mem.used / (1024**2)),
                'memory_total': round(mem.total / (1024**2)),
                'temperature': temp,
            }
        except Exception:
            pass

    return {
        'available': False,
        'name': 'N/A',
        'usage': None,
        'memory_used': None,
        'memory_total': None,
        'temperature': None,
    }


def collect_stats():
    global _prev_net_io, _prev_disk_io, _prev_time

    now = time.time()

    cpu_usage = psutil.cpu_percent(interval=None)
    cpu_per_core = psutil.cpu_percent(percpu=True)
    cpu_freq = psutil.cpu_freq()

    mem = psutil.virtual_memory()
    swap = psutil.swap_memory()

    disk_partitions = []
    for p in psutil.disk_partitions():
        try:
            usage = psutil.disk_usage(p.mountpoint)
            disk_partitions.append({
                'device': p.device,
                'total_gb': round(usage.total / (1024**3), 1),
                'used_gb': round(usage.used / (1024**3), 1),
                'usage': round(usage.percent, 1),
            })
        except (PermissionError, OSError):
            pass

    current_disk_io = psutil.disk_io_counters()
    disk_read_mbps = 0.0
    disk_write_mbps = 0.0

    current_net_io = psutil.net_io_counters()
    net_dl_mbps = 0.0
    net_ul_mbps = 0.0

    if _prev_time:
        elapsed = max(now - _prev_time, 0.001)
        if _prev_disk_io:
            disk_read_mbps = max(0, (current_disk_io.read_bytes - _prev_disk_io.read_bytes) / elapsed / (1024**2))
            disk_write_mbps = max(0, (current_disk_io.write_bytes - _prev_disk_io.write_bytes) / elapsed / (1024**2))
        if _prev_net_io:
            net_dl_mbps = max(0, (current_net_io.bytes_recv - _prev_net_io.bytes_recv) / elapsed / (1024**2))
            net_ul_mbps = max(0, (current_net_io.bytes_sent - _prev_net_io.bytes_sent) / elapsed / (1024**2))

    interfaces = []
    net_stats = psutil.net_if_stats()
    net_addrs = psutil.net_if_addrs()
    for name, stat in net_stats.items():
        if stat.isup and name.lower() not in ('lo', 'loopback'):
            ip = None
            for addr in net_addrs.get(name, []):
                if getattr(addr.family, 'name', '') == 'AF_INET' or addr.family == 2:
                    ip = addr.address
                    break
            interfaces.append({'name': name, 'speed_mbps': stat.speed, 'ip': ip})

    gpu = get_gpu_info()

    boot_ts = psutil.boot_time()
    uptime_s = int(now - boot_ts)
    uptime_str = f"{uptime_s // 3600}h {(uptime_s % 3600) // 60}m"

    _prev_disk_io = current_disk_io
    _prev_net_io = current_net_io
    _prev_time = now

    result = {
        'cpu': {
            'usage': round(cpu_usage, 1),
            'per_core': [round(c, 1) for c in cpu_per_core],
            'freq_ghz': round(cpu_freq.current / 1000, 2) if cpu_freq else None,
            'cores': psutil.cpu_count(logical=False),
            'threads': psutil.cpu_count(logical=True),
            'name': _get_cpu_name(),
        },
        'memory': {
            'total_gb': round(mem.total / (1024**3), 1),
            'used_gb': round(mem.used / (1024**3), 1),
            'available_gb': round(mem.available / (1024**3), 1),
            'usage': round(mem.percent, 1),
            'swap_total_gb': round(swap.total / (1024**3), 1),
            'swap_used_gb': round(swap.used / (1024**3), 1),
            'swap_usage': round(swap.percent, 1),
        },
        'gpu': gpu,
        'disk': {
            'partitions': disk_partitions,
            'read_mbps': round(disk_read_mbps, 2),
            'write_mbps': round(disk_write_mbps, 2),
        },
        'network': {
            'download_mbps': round(net_dl_mbps, 2),
            'upload_mbps': round(net_ul_mbps, 2),
            'total_recv_gb': round(current_net_io.bytes_recv / (1024**3), 2),
            'total_sent_gb': round(current_net_io.bytes_sent / (1024**3), 2),
            'interfaces': interfaces[:3],
        },
        'system': {
            'hostname': platform.node(),
            'os': f"{platform.system()} {platform.release()}",
            'uptime': uptime_str,
        },
    }

    ts = datetime.now().strftime('%H:%M:%S')
    with _lock:
        history['timestamps'].append(ts)
        history['cpu'].append(result['cpu']['usage'])
        history['memory'].append(result['memory']['usage'])
        history['gpu'].append(result['gpu']['usage'] or 0)
        history['net_download'].append(result['network']['download_mbps'])
        history['net_upload'].append(result['network']['upload_mbps'])
        history['disk_read'].append(result['disk']['read_mbps'])
        history['disk_write'].append(result['disk']['write_mbps'])
        for key in history:
            if len(history[key]) > MAX_HISTORY:
                history[key] = history[key][-MAX_HISTORY:]

    return result


def _background_collector():
    """백그라운드에서 정확히 1초 간격으로 시스템 정보를 수집합니다.
    cpu_percent(interval=None)은 직전 호출 이후 경과 시간을 기준으로 측정하므로
    요청마다 호출하면 경쟁 조건이 발생합니다. 이 스레드가 단독으로 호출합니다."""
    global _stats_cache
    while True:
        start = time.monotonic()
        try:
            result = collect_stats()
            with _lock:
                _stats_cache = result
            maybe_flush_to_db()
        except Exception as e:
            print(f"[Collector] 오류: {e}")
        elapsed = time.monotonic() - start
        time.sleep(max(0, 1.0 - elapsed))


def get_processes():
    cpu_count = psutil.cpu_count(logical=True) or 1
    skip = {'system idle process', 'idle'}
    procs = []
    for proc in psutil.process_iter(['pid', 'name', 'cpu_percent', 'memory_percent', 'memory_info']):
        try:
            info = proc.info
            if info['memory_info'] is None:
                continue
            if (info['name'] or '').lower() in skip:
                continue
            cpu_norm = round(min((info['cpu_percent'] or 0) / cpu_count, 100), 1)
            procs.append({
                'pid': info['pid'],
                'name': info['name'],
                'cpu': cpu_norm,
                'memory_pct': round(info['memory_percent'] or 0, 1),
                'memory_mb': round(info['memory_info'].rss / (1024**2), 1),
            })
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            pass

    cpu_top = sorted(procs, key=lambda x: x['cpu'], reverse=True)[:5]
    mem_top = sorted(procs, key=lambda x: x['memory_pct'], reverse=True)[:5]
    return {'cpu_top': cpu_top, 'memory_top': mem_top}


@app.after_request
def add_security_headers(resp):
    resp.headers['X-Frame-Options'] = 'SAMEORIGIN'
    resp.headers['X-Content-Type-Options'] = 'nosniff'
    resp.headers['X-XSS-Protection'] = '1; mode=block'
    resp.headers['Content-Security-Policy'] = (
        "default-src 'self'; "
        "script-src 'self' 'unsafe-inline'; "
        "style-src 'self' 'unsafe-inline'; "
        "font-src 'self'; "
        "img-src 'self' data:;"
    )
    return resp


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/stats')
def api_stats():
    with _lock:
        if _stats_cache is None:
            return jsonify({'error': 'initializing'}), 503
        return jsonify(_stats_cache)


@app.route('/api/processes')
def api_processes():
    return jsonify(get_processes())


@app.route('/api/history')
def api_history():
    try:
        points = int(request.args.get('points', 60))
    except (ValueError, TypeError):
        points = 60
    points = min(max(points, 1), MAX_HISTORY)
    with _lock:
        return jsonify({k: v[-points:] for k, v in history.items()})


@app.route('/api/history/long')
def api_history_long():
    try:
        days = int(request.args.get('days', 1))
    except (ValueError, TypeError):
        days = 1
    days = min(max(days, 1), 7)

    cutoff = int(time.time()) - days * 24 * 3600
    try:
        with sqlite3.connect(DB_PATH) as conn:
            rows = conn.execute(
                'SELECT ts,cpu,memory,gpu,dl,ul,disk_r,disk_w FROM metrics WHERE ts >= ? ORDER BY ts',
                (cutoff,)
            ).fetchall()
    except Exception:
        rows = []

    result = {k: [] for k in ('timestamps','cpu','memory','gpu','net_download','net_upload','disk_read','disk_write')}
    for r in rows:
        try:
            ts_str = datetime.fromtimestamp(r[0]).strftime('%m/%d %H:%M')
        except (OSError, ValueError, OverflowError):
            continue
        result['timestamps'].append(ts_str)
        result['cpu'].append(r[1])
        result['memory'].append(r[2])
        result['gpu'].append(r[3])
        result['net_download'].append(r[4])
        result['net_upload'].append(r[5])
        result['disk_read'].append(r[6])
        result['disk_write'].append(r[7])

    return jsonify(result)


@app.route('/api/export/csv')
def export_csv():
    import csv, io
    try:
        with sqlite3.connect(DB_PATH) as conn:
            rows = conn.execute(
                'SELECT ts,cpu,memory,gpu,dl,ul,disk_r,disk_w FROM metrics ORDER BY ts'
            ).fetchall()
    except Exception:
        rows = []

    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(['시간', 'CPU(%)', '메모리(%)', 'GPU(%)',
                '다운로드(MB/s)', '업로드(MB/s)', '디스크읽기(MB/s)', '디스크쓰기(MB/s)'])
    for r in rows:
        try:
            ts_str = datetime.fromtimestamp(r[0]).strftime('%Y-%m-%d %H:%M')
        except (OSError, ValueError, OverflowError):
            continue
        w.writerow([ts_str] + list(r[1:]))

    filename = f"history_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
    return Response(
        buf.getvalue().encode('utf-8-sig'),   # utf-8-sig: Excel 한글 깨짐 방지
        mimetype='text/csv',
        headers={'Content-Disposition': f'attachment; filename="{filename}"'}
    )


def run_server(port=5000):
    """서버 초기화 및 실행 (직접 실행 / launcher.py 공용)."""
    global _prev_disk_io, _prev_net_io, _prev_time

    init_db()

    psutil.cpu_percent(interval=None)
    psutil.cpu_percent(percpu=True)
    for proc in psutil.process_iter(['cpu_percent']):
        try:
            proc.cpu_percent()
        except Exception:
            pass
    _prev_disk_io = psutil.disk_io_counters()
    _prev_net_io = psutil.net_io_counters()
    _prev_time = time.time()

    collector = threading.Thread(target=_background_collector, daemon=True)
    collector.start()

    app.run(debug=False, port=port, host='127.0.0.1')


if __name__ == '__main__':
    print("=" * 50)
    print(" PC 모니터링 대시보드 시작")
    print(" 브라우저에서 http://localhost:5000 을 여세요")
    print("=" * 50)
    run_server()
