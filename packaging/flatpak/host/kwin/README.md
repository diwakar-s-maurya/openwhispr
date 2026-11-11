# KDE Plasma (KWin) helpers for the dictation pill

Native Wayland gives an app no way to position its windows, keep them on
top, skip the taskbar or refuse focus. The upstream app gets all of this
from X11 under XWayland, which this sandbox deliberately does not allow.

- `kwinrulesrc.snippet`: window rule (no border, skip taskbar/switcher/pager,
  keep above, no focus) for the `local.surface.OpenWhispr` window whose
  title ends in a `[position]` suffix: the dictation pill, in any language.
- `openwhispr-pill-corner/`: KWin script that places the pill 4 px inside the
  bottom of the work area, at the corner chosen in the app ("Panel start
  position"), which the app appends to the title, e.g.
  `Voice Recorder [bottom-left]`.

Install the script:

    kpackagetool6 --type=KWin/Script -i openwhispr-pill-corner   # -u to upgrade
    kwriteconfig6 --file kwinrc --group Plugins --key openwhispr-pill-cornerEnabled true
    qdbus6 org.kde.KWin /KWin reconfigure
