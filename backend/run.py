"""Start the order-flow server:  python run.py [--demo] [--lan] [--venue usdm|coinm] [--port 8000] [--host 127.0.0.1]"""
import argparse
import logging
import os
import socket
import sys
import webbrowser


def lan_addresses() -> list[str]:
    """This PC's IPv4 addresses on the local network (Wi-Fi / Ethernet), best guess first."""
    found: list[str] = []
    try:   # the interface that would carry internet traffic; no packet is actually sent
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        found.append(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            found.append(info[4][0])
    except OSError:
        pass
    private = ("10.", "192.168.") + tuple(f"172.{i}." for i in range(16, 32))
    out = []
    for ip in found:
        if ip.startswith(private) and ip not in out:
            out.append(ip)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--demo", action="store_true", help="synthetic market (no internet needed)")
    ap.add_argument("--venue", default="usdm", choices=["usdm", "coinm"])
    ap.add_argument("--host", default=None, help="address to listen on (default 127.0.0.1, or 0.0.0.0 with --lan)")
    ap.add_argument("--lan", action="store_true", help="let phones, tablets and other PCs on your network open it")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--open", action="store_true", help="open the sign-in page in the browser")
    a = ap.parse_args()
    host = a.host or ("0.0.0.0" if a.lan else "127.0.0.1")
    os.environ["FLOW_VENUE"] = a.venue
    if a.demo:
        os.environ["FLOW_DEMO"] = "1"
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")

    print()
    # "localhost", not 127.0.0.1: Google sign-in only works on the addresses registered with Google
    print(f"  On this computer:      http://localhost:{a.port}")
    if host in ("0.0.0.0", "::"):
        ips = lan_addresses()
        for ip in ips:
            print(f"  On your other devices: http://{ip}:{a.port}   (same Wi-Fi / network)")
        if not ips:
            print(f"  On your other devices: http://<this PC's IPv4 address>:{a.port}  (run 'ipconfig' to find it)")
        print("  If Windows asks whether Python may use the network, tick 'Private networks' and click Allow.")
    print()
    sys.stdout.flush()

    if a.open:
        import threading
        local = "localhost" if host in ("0.0.0.0", "::", "127.0.0.1") else host
        threading.Timer(2.0, lambda: webbrowser.open(f"http://{local}:{a.port}/login")).start()
    import uvicorn
    uvicorn.run("app.main:app", host=host, port=a.port, log_level="warning", ws_max_size=16 * 1024 * 1024)


if __name__ == "__main__":
    main()
