#!/usr/bin/env python3
import sys
import os
import json
import threading
import gi
gi.require_version('AyatanaAppIndicator3', '0.1')
gi.require_version('Gtk', '3.0')
from gi.repository import GLib, AyatanaAppIndicator3, Gtk

APP_ID = 'spotify-lyrics-rpc'
menu = None
indicator = None
exit_item = None
status_item = None
loop = None

def on_exit_clicked(*_):
    print(json.dumps({"type": "clicked", "item": "exit"}), flush=True)
    Gtk.main_quit()

def create_indicator(icon_path=None):
    global indicator, menu, exit_item, status_item

    indicator = AyatanaAppIndicator3.Indicator.new(
        APP_ID, '', AyatanaAppIndicator3.IndicatorCategory.APPLICATION_STATUS
    )
    indicator.set_status(AyatanaAppIndicator3.IndicatorStatus.ACTIVE)

    if icon_path and os.path.exists(icon_path):
        indicator.set_icon_full(icon_path, 'Spotify Lyrics')
    else:
        indicator.set_icon('audio-x-generic')

    menu = Gtk.Menu()
    status_item = Gtk.MenuItem(label='Starting...')
    status_item.set_sensitive(False)
    menu.append(status_item)
    menu.append(Gtk.SeparatorMenuItem())
    exit_item = Gtk.MenuItem(label='Exit')
    exit_item.connect('activate', on_exit_clicked)
    menu.append(exit_item)
    menu.show_all()
    indicator.set_menu(menu)

def stdin_reader():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
            if msg.get('type') == 'update-status':
                text = msg.get('text', '')[:128]
                GLib.idle_add(lambda t=text: status_item.set_label(t) or True)
            elif msg.get('type') == 'exit':
                GLib.idle_add(Gtk.main_quit)
        except json.JSONDecodeError:
            pass

if __name__ == '__main__':
    icon_path = sys.argv[1] if len(sys.argv) > 1 else None
    create_indicator(icon_path)
    print(json.dumps({"type": "ready"}), flush=True)
    t = threading.Thread(target=stdin_reader, daemon=True)
    t.start()
    Gtk.main()
