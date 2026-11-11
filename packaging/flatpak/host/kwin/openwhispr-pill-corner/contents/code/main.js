// Places the OpenWhispr dictation pill like the app does under X11: 4 px in
// from the bottom edge of the work area, at the corner (or centre) chosen in
// the app's "panel start position" setting. Wayland apps cannot place their
// own windows, so under native Wayland the app appends the setting to the
// pill's title, e.g. "Voice Recorder [bottom-left]". The suffix is the same in
// every language; the title before it is translated. The pill grows for menus
// and errors; the chosen corner stays fixed, so it grows away from the edge.
const APP_ID = "local.surface.OpenWhispr";
const PLACEMENT = /\[(bottom-right|bottom-left|center)\]$/;
const MARGIN = 4;

function anchor(w, side) {
  const area = workspace.clientArea(KWin.MaximizeArea, w);
  const g = w.frameGeometry;
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
  if (!w || w.resourceClass != APP_ID || w.owPillTracked) return;
  w.owPillTracked = true;
  const update = () => {
    const match = PLACEMENT.exec(String(w.caption));
    if (match) anchor(w, match[1]);
  };
  w.frameGeometryChanged.connect(update);
  w.captionChanged.connect(update);
  w.outputChanged.connect(update);
  update();
}

workspace.windowList().forEach(track);
workspace.windowAdded.connect(track);
