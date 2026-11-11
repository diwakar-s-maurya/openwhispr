// Places the OpenWhispr dictation pill like the app does under X11: 4 px in
// from the bottom edge of the work area, at the corner (or centre) chosen in
// the app's "panel start position" setting. Wayland apps cannot place their
// own windows, so the app appends the setting to the pill's title, e.g.
// "Voice Recorder [bottom-left]". The pill grows for menus and errors; the
// chosen corner stays fixed, so it grows away from the screen edge.
const MARGIN = 4;

function isPill(w) {
  return w && w.resourceClass == "local.surface.OpenWhispr" &&
    String(w.caption).indexOf("Voice Recorder") == 0;
}

function sideOf(w) {
  const m = /\[(bottom-right|bottom-left|center)\]\s*$/.exec(String(w.caption));
  return m ? m[1] : "bottom-right";
}

function anchor(w) {
  const area = workspace.clientArea(KWin.MaximizeArea, w);
  const g = w.frameGeometry;
  const side = sideOf(w);
  let x;
  if (side == "bottom-left") x = area.x + MARGIN;
  else if (side == "center") x = area.x + (area.width - g.width) / 2;
  else x = area.x + area.width - g.width - MARGIN;
  x = Math.round(x);
  const y = Math.round(area.y + area.height - g.height - MARGIN);
  if (Math.round(g.x) != x || Math.round(g.y) != y) {
    w.frameGeometry = { x: x, y: y, width: g.width, height: g.height };
  }
}

function track(w) {
  if (!w || w.resourceClass != "local.surface.OpenWhispr" || w.owPillTracked) return;
  w.owPillTracked = true;
  const update = () => { if (isPill(w)) anchor(w); };
  w.frameGeometryChanged.connect(update);
  w.captionChanged.connect(update);
  w.outputChanged.connect(update);
  update();
}

workspace.windowList().forEach(track);
workspace.windowAdded.connect(track);
