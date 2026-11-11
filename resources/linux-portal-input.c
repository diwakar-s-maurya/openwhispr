/*
 * linux-portal-input: holds one xdg-desktop-portal RemoteDesktop session
 * (keyboard only) with the Clipboard portal attached, and pastes on request.
 *
 * linux-fast-paste --portal opens a new session for every paste, so the desktop
 * shows its "remote control" notice each time, and it relies on the app having
 * written the clipboard. On Wayland a compositor may ignore clipboard writes from
 * a window without keyboard focus (KWin does), and a dictation app rarely has
 * focus when it pastes. Here the session itself owns the selection through the
 * Clipboard portal, and stays open for the life of the app.
 *
 * The helper only WRITES the clipboard (SetSelection + SelectionWrite). It never
 * calls SelectionRead.
 *
 * Protocol, one line per command on stdin:
 *   PASTE <ctrl-v|ctrl-shift-v|shift-insert> <base64 utf-8 text>
 *   COPY <base64 utf-8 text>          clipboard only, no key events
 *   QUIT
 * Replies on stdout, one line each:
 *   TOKEN <restore token>             after Start, when the portal hands one out
 *   READY clipboard=<0|1>
 *   OK | ERR <reason> [detail]        one per PASTE/COPY; reasons:
 *                                     clipboard-unavailable, keyboard, selection, usage
 *   CLOSED                            the portal or the user ended the session
 *
 * Exit codes: 0 normal, 1 no session bus, 2 CreateSession failed,
 *             3 SelectDevices denied/failed, 4 Start denied/failed.
 *
 * The restore token from an earlier run comes in PORTAL_INPUT_RESTORE_TOKEN
 * (or --restore-token TOKEN; argv is world-readable in /proc, the environment
 * is not).
 */
#include <gio/gio.h>
#include <gio/gunixfdlist.h>
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

#define PORTAL_BUS "org.freedesktop.portal.Desktop"
#define PORTAL_PATH "/org/freedesktop/portal/desktop"
#define RD_IFACE "org.freedesktop.portal.RemoteDesktop"
#define CB_IFACE "org.freedesktop.portal.Clipboard"
#define REQ_IFACE "org.freedesktop.portal.Request"
#define SESS_IFACE "org.freedesktop.portal.Session"
#define CALL_TIMEOUT_MS 3000
/* How long the user has to answer the first permission dialog. */
#define RESPONSE_TIMEOUT_S 120

#define DEVICE_KEYBOARD 1u
#define PERSIST_UNTIL_REVOKED 2u

#define XK_Shift_L 0xffe1
#define XK_Control_L 0xffe3
#define XK_Insert 0xff63
#define XK_v 0x0076

static GDBusConnection *conn;
static GMainLoop *loop;
static char *session_handle;
static GBytes *offered; /* text currently offered as the selection */
static gboolean clipboard_enabled;

static void reply(const char *fmt, ...) G_GNUC_PRINTF(1, 2);
static void reply(const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    vprintf(fmt, ap);
    va_end(ap);
    putchar('\n');
    fflush(stdout);
}

static char *sender_path(void)
{
    char *p = g_strdup(g_dbus_connection_get_unique_name(conn) + 1);
    for (char *c = p; *c; c++)
        if (*c == '.') *c = '_';
    return p;
}

static char *new_token(void)
{
    static unsigned n;
    return g_strdup_printf("owpi_%d_%u", getpid(), ++n);
}

/* ---- Calls that answer through a Request object's Response signal ---- */
typedef struct {
    GMainLoop *loop;
    guint32 code;
    GVariant *results;
} Response;

static void on_response(GDBusConnection *c, const char *sender, const char *path,
                        const char *iface, const char *signal, GVariant *params, gpointer data)
{
    Response *r = data;
    g_variant_get(params, "(u@a{sv})", &r->code, &r->results);
    g_main_loop_quit(r->loop);
}

static gboolean on_response_timeout(gpointer data)
{
    Response *r = data;
    r->code = 99;
    g_main_loop_quit(r->loop);
    return G_SOURCE_REMOVE;
}

/* `options` must already hold handle_token=tok. */
static GVariant *request(const char *method, GVariant *params, const char *tok, GError **error)
{
    char *sp = sender_path();
    char *req_path = g_strdup_printf("/org/freedesktop/portal/desktop/request/%s/%s", sp, tok);
    Response r = { g_main_loop_new(NULL, FALSE), 0, NULL };
    /* Subscribe before calling, so the Response can't arrive first. */
    guint sub = g_dbus_connection_signal_subscribe(conn, PORTAL_BUS, REQ_IFACE, "Response",
        req_path, NULL, G_DBUS_SIGNAL_FLAGS_NONE, on_response, &r, NULL);

    GVariant *ret = g_dbus_connection_call_sync(conn, PORTAL_BUS, PORTAL_PATH, RD_IFACE, method,
        params, NULL, G_DBUS_CALL_FLAGS_NONE, CALL_TIMEOUT_MS, NULL, error);
    GVariant *out = NULL;
    if (ret) {
        g_variant_unref(ret);
        GSource *to = g_timeout_source_new_seconds(RESPONSE_TIMEOUT_S);
        g_source_set_callback(to, on_response_timeout, &r, NULL);
        g_source_attach(to, NULL);
        g_main_loop_run(r.loop);
        g_source_destroy(to);
        g_source_unref(to);
        if (r.code == 0) {
            out = r.results;
        } else {
            g_set_error(error, G_IO_ERROR, G_IO_ERROR_FAILED, "%s %s (%u)", method,
                r.code == 1 ? "denied" : r.code == 99 ? "timed out" : "failed", r.code);
            if (r.results) g_variant_unref(r.results);
        }
    }
    g_dbus_connection_signal_unsubscribe(conn, sub);
    g_main_loop_unref(r.loop);
    g_free(req_path);
    g_free(sp);
    return out;
}

/* ---- keyboard ---- */
static gboolean key(guint32 keysym, gboolean pressed)
{
    GError *err = NULL;
    GVariant *r = g_dbus_connection_call_sync(conn, PORTAL_BUS, PORTAL_PATH, RD_IFACE,
        "NotifyKeyboardKeysym",
        g_variant_new("(oa{sv}iu)", session_handle, NULL, (gint32)keysym, pressed ? 1u : 0u),
        NULL, G_DBUS_CALL_FLAGS_NONE, CALL_TIMEOUT_MS, NULL, &err);
    if (!r) {
        fprintf(stderr, "NotifyKeyboardKeysym: %s\n", err->message);
        g_error_free(err);
        return FALSE;
    }
    g_variant_unref(r);
    return TRUE;
}

/* Presses the modifiers, taps k, releases the modifiers in reverse order. */
static gboolean chord(const guint32 *mods, int nmods, guint32 k)
{
    gboolean ok = TRUE;
    for (int i = 0; i < nmods; i++) ok &= key(mods[i], TRUE);
    g_usleep(20000);
    ok &= key(k, TRUE);
    g_usleep(20000);
    ok &= key(k, FALSE);
    for (int i = nmods - 1; i >= 0; i--) ok &= key(mods[i], FALSE);
    return ok;
}

/* ---- clipboard (write only) ---- */
static gboolean offer(GBytes *text)
{
    if (!clipboard_enabled) {
        reply("ERR clipboard-unavailable");
        return FALSE;
    }
    if (offered) g_bytes_unref(offered);
    offered = g_bytes_ref(text);

    const char *mimes[] = { "text/plain;charset=utf-8", "text/plain", "UTF8_STRING", "STRING",
                            "TEXT", NULL };
    GVariantBuilder opts;
    g_variant_builder_init(&opts, G_VARIANT_TYPE("a{sv}"));
    g_variant_builder_add(&opts, "{sv}", "mime_types", g_variant_new_strv(mimes, -1));
    GError *err = NULL;
    GVariant *r = g_dbus_connection_call_sync(conn, PORTAL_BUS, PORTAL_PATH, CB_IFACE,
        "SetSelection", g_variant_new("(oa{sv})", session_handle, &opts), NULL,
        G_DBUS_CALL_FLAGS_NONE, CALL_TIMEOUT_MS, NULL, &err);
    if (!r) {
        reply("ERR selection %s", err->message);
        g_error_free(err);
        return FALSE;
    }
    g_variant_unref(r);
    return TRUE;
}

static gboolean write_all(int fd, const char *buf, gsize len)
{
    gsize done = 0;
    while (done < len) {
        ssize_t n = write(fd, buf + done, len - done);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) return FALSE;
        done += (gsize)n;
    }
    return TRUE;
}

/* A client asked for the selection: hand the portal an fd's worth of our text. */
static void on_selection_transfer(GDBusConnection *c, const char *sender, const char *path,
                                  const char *iface, const char *signal, GVariant *params,
                                  gpointer data)
{
    const char *sess, *mime;
    guint32 serial;
    g_variant_get(params, "(&o&su)", &sess, &mime, &serial);
    if (g_strcmp0(sess, session_handle) != 0) return;

    gboolean ok = FALSE;
    GUnixFDList *fds = NULL;
    GError *err = NULL;
    GVariant *r = g_dbus_connection_call_with_unix_fd_list_sync(conn, PORTAL_BUS, PORTAL_PATH,
        CB_IFACE, "SelectionWrite", g_variant_new("(ou)", session_handle, serial),
        G_VARIANT_TYPE("(h)"), G_DBUS_CALL_FLAGS_NONE, CALL_TIMEOUT_MS, NULL, &fds, NULL, &err);
    if (r && fds) {
        gint32 idx;
        g_variant_get(r, "(h)", &idx);
        int fd = g_unix_fd_list_get(fds, idx, NULL);
        if (fd >= 0) {
            gsize len = 0;
            const char *buf = offered ? g_bytes_get_data(offered, &len) : "";
            ok = write_all(fd, buf, len);
            close(fd);
        }
    } else if (err) {
        fprintf(stderr, "SelectionWrite: %s\n", err->message);
        g_error_free(err);
    }
    if (r) g_variant_unref(r);
    if (fds) g_object_unref(fds);

    GVariant *d = g_dbus_connection_call_sync(conn, PORTAL_BUS, PORTAL_PATH, CB_IFACE,
        "SelectionWriteDone", g_variant_new("(oub)", session_handle, serial, ok), NULL,
        G_DBUS_CALL_FLAGS_NONE, CALL_TIMEOUT_MS, NULL, NULL);
    if (d) g_variant_unref(d);
    if (!ok) fprintf(stderr, "selection transfer (%s) failed\n", mime);
}

static void on_session_closed(GDBusConnection *c, const char *sender, const char *path,
                              const char *iface, const char *signal, GVariant *params,
                              gpointer data)
{
    reply("CLOSED");
    g_main_loop_quit(loop);
}

/* ---- stdin commands ---- */
static GBytes *decode(const char *b64)
{
    gsize n = 0;
    guchar *raw = g_base64_decode(b64, &n);
    return g_bytes_new_take(raw, n);
}

static void paste(const char *keys, GBytes *text)
{
    static const guint32 ctrl[] = { XK_Control_L };
    static const guint32 ctrl_shift[] = { XK_Control_L, XK_Shift_L };
    static const guint32 shift[] = { XK_Shift_L };

    if (!offer(text)) return;
    g_usleep(30000); /* let the compositor announce the new selection */
    gboolean ok;
    if (g_strcmp0(keys, "ctrl-v") == 0) ok = chord(ctrl, 1, XK_v);
    else if (g_strcmp0(keys, "ctrl-shift-v") == 0) ok = chord(ctrl_shift, 2, XK_v);
    else ok = chord(shift, 1, XK_Insert);
    if (ok) reply("OK");
    else reply("ERR keyboard");
}

static gboolean on_stdin(GIOChannel *ch, GIOCondition cond, gpointer data)
{
    char *line = NULL;
    gsize len = 0;
    GIOStatus st = g_io_channel_read_line(ch, &line, &len, NULL, NULL);
    if (st == G_IO_STATUS_EOF || st == G_IO_STATUS_ERROR) {
        g_main_loop_quit(loop);
        return G_SOURCE_REMOVE;
    }
    if (!line) return G_SOURCE_CONTINUE;
    g_strchomp(line);

    char **parts = g_strsplit(line, " ", 3);
    if (g_strcmp0(parts[0], "QUIT") == 0) {
        g_main_loop_quit(loop);
    } else if (g_strcmp0(parts[0], "COPY") == 0 && parts[1]) {
        GBytes *b = decode(parts[1]);
        if (offer(b)) reply("OK");
        g_bytes_unref(b);
    } else if (g_strcmp0(parts[0], "PASTE") == 0 && parts[1] && parts[2]) {
        GBytes *b = decode(parts[2]);
        paste(parts[1], b);
        g_bytes_unref(b);
    } else {
        reply("ERR usage");
    }
    g_strfreev(parts);
    g_free(line);
    return G_SOURCE_CONTINUE;
}

int main(int argc, char **argv)
{
    const char *restore_token = g_getenv("PORTAL_INPUT_RESTORE_TOKEN");
    for (int i = 1; i < argc; i++)
        if (strcmp(argv[i], "--restore-token") == 0 && i + 1 < argc) restore_token = argv[++i];

    GError *err = NULL;
    conn = g_bus_get_sync(G_BUS_TYPE_SESSION, NULL, &err);
    if (!conn) {
        fprintf(stderr, "session bus: %s\n", err->message);
        return 1;
    }
    loop = g_main_loop_new(NULL, FALSE);

    GVariantBuilder b;
    char *tok = new_token(), *session_tok = new_token();
    g_variant_builder_init(&b, G_VARIANT_TYPE("a{sv}"));
    g_variant_builder_add(&b, "{sv}", "handle_token", g_variant_new_string(tok));
    g_variant_builder_add(&b, "{sv}", "session_handle_token", g_variant_new_string(session_tok));
    GVariant *res = request("CreateSession", g_variant_new("(a{sv})", &b), tok, &err);
    g_free(tok);
    g_free(session_tok);
    if (!res) {
        fprintf(stderr, "%s\n", err->message);
        return 2;
    }
    g_variant_lookup(res, "session_handle", "s", &session_handle);
    g_variant_unref(res);

    /* Keyboard only, kept until the user revokes it. */
    tok = new_token();
    g_variant_builder_init(&b, G_VARIANT_TYPE("a{sv}"));
    g_variant_builder_add(&b, "{sv}", "handle_token", g_variant_new_string(tok));
    g_variant_builder_add(&b, "{sv}", "types", g_variant_new_uint32(DEVICE_KEYBOARD));
    g_variant_builder_add(&b, "{sv}", "persist_mode", g_variant_new_uint32(PERSIST_UNTIL_REVOKED));
    if (restore_token && *restore_token)
        g_variant_builder_add(&b, "{sv}", "restore_token", g_variant_new_string(restore_token));
    res = request("SelectDevices", g_variant_new("(oa{sv})", session_handle, &b), tok, &err);
    g_free(tok);
    if (!res) {
        fprintf(stderr, "%s\n", err->message);
        return 3;
    }
    g_variant_unref(res);

    /* RequestClipboard must come before Start. It answers directly. Portals
     * without the Clipboard interface fail here; PASTE then reports
     * clipboard-unavailable and the caller falls back. */
    GVariant *rc = g_dbus_connection_call_sync(conn, PORTAL_BUS, PORTAL_PATH, CB_IFACE,
        "RequestClipboard", g_variant_new("(oa{sv})", session_handle, NULL), NULL,
        G_DBUS_CALL_FLAGS_NONE, CALL_TIMEOUT_MS, NULL, &err);
    if (rc) g_variant_unref(rc);
    else {
        fprintf(stderr, "RequestClipboard: %s\n", err->message);
        g_clear_error(&err);
    }

    tok = new_token();
    g_variant_builder_init(&b, G_VARIANT_TYPE("a{sv}"));
    g_variant_builder_add(&b, "{sv}", "handle_token", g_variant_new_string(tok));
    res = request("Start", g_variant_new("(osa{sv})", session_handle, "", &b), tok, &err);
    g_free(tok);
    if (!res) {
        fprintf(stderr, "%s\n", err->message);
        return 4;
    }
    char *new_restore = NULL;
    if (g_variant_lookup(res, "restore_token", "s", &new_restore) && new_restore) {
        reply("TOKEN %s", new_restore);
        g_free(new_restore);
    }
    g_variant_lookup(res, "clipboard_enabled", "b", &clipboard_enabled);
    g_variant_unref(res);

    g_dbus_connection_signal_subscribe(conn, PORTAL_BUS, CB_IFACE, "SelectionTransfer",
        PORTAL_PATH, NULL, G_DBUS_SIGNAL_FLAGS_NONE, on_selection_transfer, NULL, NULL);
    g_dbus_connection_signal_subscribe(conn, PORTAL_BUS, SESS_IFACE, "Closed", session_handle,
        NULL, G_DBUS_SIGNAL_FLAGS_NONE, on_session_closed, NULL, NULL);

    reply("READY clipboard=%d", clipboard_enabled ? 1 : 0);

    GIOChannel *in = g_io_channel_unix_new(STDIN_FILENO);
    g_io_add_watch(in, G_IO_IN | G_IO_HUP | G_IO_ERR, on_stdin, NULL);
    g_main_loop_run(loop);

    GVariant *c = g_dbus_connection_call_sync(conn, PORTAL_BUS, session_handle, SESS_IFACE,
        "Close", NULL, NULL, G_DBUS_CALL_FLAGS_NONE, CALL_TIMEOUT_MS, NULL, NULL);
    if (c) g_variant_unref(c);
    if (offered) g_bytes_unref(offered);
    return 0;
}
