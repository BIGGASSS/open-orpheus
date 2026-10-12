//! Role transactions: deciding a surface's role exactly once.
//!
//! A role has to be assigned before its title can be sent, so the managed
//! window is unknown when the client asks for its toplevel. A compositor keeps
//! a surface's role for the surface's whole life, so the decision can be made
//! once and re-applied to every later role object on that surface.
//!
//! Only the role's own requests are held. Anything else completes the
//! transaction first and is then dispatched normally: a request that creates a
//! new object id must not reach the compositor before the `get_toplevel` this
//! transaction holds, and a request can also carry a file descriptor, which
//! travels with the message and cannot be stored in a byte buffer. The
//! transaction ends at the title, the commit, the destruction of the role
//! object or its surface, or a message cap.

use std::os::fd::RawFd;

use super::super::codec::{
    Iface, REQ_COMMIT, REQ_DESTROY, REQ_GET_TOPLEVEL, REQ_GET_TOPLEVEL_DECORATION, REQ_SET_ICON,
    REQ_SET_TITLE, WlMessage, parse_custom_title,
};
use super::super::state::{SurfaceRole, WaylandConn, layer_policy, role_decision_needed};
use super::{Action, Effects, conversion, dispatch_request_inner, objects};

/// Most messages one transaction may sweep before it is decided anyway.
const MAX_SWEPT_ROLE_REQUESTS: usize = 32;

/// A role the client is building and the proxy has not decided yet.
pub(crate) struct PendingRole {
    xdg_surface: u32,
    wl_surface: u32,
    /// The client's id for the `xdg_toplevel` it is building, reused as the
    /// layer surface id when the role is converted.
    toplevel: u32,
    toplevel_msg: WlMessage,
    /// The managed window id the decorated title named, once it was seen.
    marker: Option<String>,
    /// Requests belonging to this role that arrived while it was held.
    swept: Vec<WlMessage>,
    /// Decoration objects introduced by this role's swept requests.
    decoration_ids: Vec<u32>,
}

impl PendingRole {
    fn new(xdg_surface: u32, wl_surface: u32, msg: &WlMessage) -> Option<Self> {
        Some(Self {
            xdg_surface,
            wl_surface,
            toplevel: msg.u32_arg(8)?,
            toplevel_msg: WlMessage::new(msg.object_id, msg.opcode, msg.raw().to_vec()),
            marker: None,
            swept: Vec::new(),
            decoration_ids: Vec::new(),
        })
    }
}

pub(crate) fn dispatch(
    fd: RawFd,
    conn: &mut WaylandConn,
    msg: &WlMessage,
    fx: &mut Effects,
) -> Action {
    if conn.pending_role.is_some() {
        return continue_role(fd, conn, msg, fx);
    }
    if conn.ifaces.get(&msg.object_id) == Some(&Iface::XdgSurface) && msg.opcode == REQ_GET_TOPLEVEL
    {
        return begin_role(fd, conn, msg, fx);
    }
    dispatch_request_inner(fd, conn, msg, fx)
}

/// Answer `get_toplevel`: re-apply a role already decided for this surface,
/// open a transaction when the window identity could still change it, or
/// forward it as an ordinary toplevel.
fn begin_role(fd: RawFd, conn: &mut WaylandConn, msg: &WlMessage, fx: &mut Effects) -> Action {
    let xdg_surface = msg.object_id;
    let Some(wl_surface) = conn.xdg_to_wl.get(&xdg_surface).copied() else {
        return dispatch_request_inner(fd, conn, msg, fx);
    };
    let Some(pending) = PendingRole::new(xdg_surface, wl_surface, msg) else {
        return dispatch_request_inner(fd, conn, msg, fx);
    };
    if conn.surface_roles.contains_key(&wl_surface) {
        // The role is settled for this surface: re-apply it without waiting for
        // the title again.
        return Action::Replace(flush_role(fd, conn, &pending, fx));
    }
    if !role_decision_needed(fd) {
        return dispatch_request_inner(fd, conn, msg, fx);
    }
    conn.pending_role = Some(pending);
    Action::Suppress
}

/// Sweep one message while a role transaction is open, and decide it when
/// something makes the identity irrelevant or the block has to end.
fn continue_role(fd: RawFd, conn: &mut WaylandConn, msg: &WlMessage, fx: &mut Effects) -> Action {
    let Some(mut pending) = conn.pending_role.take() else {
        return dispatch_request_inner(fd, conn, msg, fx);
    };

    // The decorated title names the managed window, so the role can be decided
    // as soon as it arrives instead of waiting for the commit.
    if msg.object_id == pending.toplevel
        && msg.opcode == REQ_SET_TITLE
        && let Some((id, _)) = msg.str_text(8).and_then(parse_custom_title)
    {
        pending.marker = Some(id.to_string());
    }

    let is_commit = msg.object_id == pending.wl_surface
        && msg.opcode == REQ_COMMIT
        && conn.ifaces.get(&msg.object_id) == Some(&Iface::WlSurface);

    // A window cancelled before its title is gone: the role objects (or the
    // surface behind them) are being destroyed, so there is nothing left to
    // decide for. Ending the transaction here is what lets every later window
    // open one of its own.
    let abandons_role = msg.opcode == REQ_DESTROY
        && (msg.object_id == pending.toplevel
            || msg.object_id == pending.xdg_surface
            || (msg.object_id == pending.wl_surface
                && conn.ifaces.get(&msg.object_id) == Some(&Iface::WlSurface)));

    if belongs_to_role(conn, &mut pending, msg) {
        pending.swept.push(WlMessage::new(
            msg.object_id,
            msg.opcode,
            msg.raw().to_vec(),
        ));

        let decided = pending.marker.is_some()
            || is_commit
            || abandons_role
            || pending.swept.len() >= MAX_SWEPT_ROLE_REQUESTS;
        if !decided {
            conn.pending_role = Some(pending);
            return Action::Suppress;
        }

        return Action::Replace(flush_role(fd, conn, &pending, fx));
    }

    // Not part of the role. Complete the role first, so the held `get_toplevel`
    // and the object id it allocates reach the compositor before this request,
    // then let it take its normal path. It is never held: a request can carry
    // file descriptors, which travel with the message and cannot be kept in a
    // byte buffer; holding it would leave the replay with no descriptor to send.
    let mut out = flush_role(fd, conn, &pending, fx);
    append_action(&mut out, msg, dispatch(fd, conn, msg, fx));
    Action::Replace(out)
}

/// Whether `msg` belongs to the role being built.
///
/// Only these are ever held. None of them carries a file descriptor, which is
/// what makes holding them safe.
fn belongs_to_role(conn: &mut WaylandConn, pending: &mut PendingRole, msg: &WlMessage) -> bool {
    let toplevel = pending.toplevel;
    if msg.object_id == toplevel || msg.object_id == pending.xdg_surface {
        return true;
    }
    if msg.object_id == pending.wl_surface && matches!(msg.opcode, REQ_COMMIT | REQ_DESTROY) {
        return true;
    }
    if pending.decoration_ids.contains(&msg.object_id) {
        return true;
    }
    if conn.ifaces.get(&msg.object_id) == Some(&Iface::ZxdgDecorationManager)
        && msg.opcode == REQ_GET_TOPLEVEL_DECORATION
        && msg.u32_arg(12) == Some(toplevel)
    {
        if let Some(id) = msg.u32_arg(8) {
            pending.decoration_ids.push(id);
        }
        return true;
    }
    conn.ifaces.get(&msg.object_id) == Some(&Iface::XdgToplevelIconManager)
        && msg.opcode == REQ_SET_ICON
        && msg.u32_arg(8) == Some(toplevel)
}

/// Decide the role, emit it, and replay everything that was swept for it.
fn flush_role(
    fd: RawFd,
    conn: &mut WaylandConn,
    pending: &PendingRole,
    fx: &mut Effects,
) -> Vec<Vec<u8>> {
    let toplevel = pending.toplevel;
    let resolved = pending
        .marker
        .clone()
        .or_else(|| conn.surface_ids.get(&pending.wl_surface).cloned());
    let cached = conn.surface_roles.get(&pending.wl_surface).cloned();
    let policy = resolved.as_deref().and_then(layer_policy);

    // A surface that is already an ordinary toplevel can never take the layer
    // role: the compositor keeps the role for the surface's whole life and
    // answers the attempt with a fatal protocol error. Refuse, report once, and
    // leave the window an ordinary toplevel.
    let refused = matches!(cached, Some(SurfaceRole::Toplevel { .. })) && policy.is_some();
    if refused
        && let Some(SurfaceRole::Toplevel { reported }) =
            conn.surface_roles.get_mut(&pending.wl_surface)
        && !*reported
    {
        *reported = true;
        eprintln!(
            "[proxy:wayland] layer-shell refused: the window's surface is already an xdg_toplevel, so it cannot become a layer surface (re-create the window to apply it)"
        );
        fx.layer_shell_refused = resolved
            .clone()
            .or_else(|| conn.surface_ids.get(&pending.wl_surface).cloned());
    }

    let layer_options = match cached {
        Some(SurfaceRole::Layer(options)) => Some(options),
        Some(SurfaceRole::Toplevel { .. }) => None,
        None if !refused => policy,
        None => None,
    };
    let had_cached_role = conn.surface_roles.contains_key(&pending.wl_surface);

    let mut out = Vec::new();
    let mut converted = false;
    if let Some(options) = layer_options {
        if let Some(messages) = conversion::convert_to_layer_surface(
            conn,
            pending.xdg_surface,
            pending.wl_surface,
            toplevel,
            options,
            fx,
        ) {
            out.extend(messages);
            converted = true;
        } else if had_cached_role {
            // Already a layer surface and the conversion cannot be sent: drop
            // the role rather than hand the surface one it cannot take.
            return out;
        }
    }
    if !converted {
        append_action(
            &mut out,
            &pending.toplevel_msg,
            objects::on_get_toplevel(fd, conn, &pending.toplevel_msg, fx, resolved.as_deref()),
        );
    }

    // Replay the role's own held requests through the normal dispatch, in
    // order, after the role decision they belong to.
    for swept in &pending.swept {
        append_action(&mut out, swept, dispatch(fd, conn, swept, fx));
    }
    out
}

fn append_action(out: &mut Vec<Vec<u8>>, msg: &WlMessage, action: Action) {
    match action {
        Action::Forward => out.push(msg.raw().to_vec()),
        Action::Suppress => {}
        Action::Replace(messages) => out.extend(messages),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::MutexGuard;

    use super::super::super::{
        codec::{
            DECORATION_CLIENT_SIDE, EVT_DECORATION_CONFIGURE, REQ_BIND, REQ_COMMIT, REQ_DESTROY,
            REQ_GET_LAYER_SURFACE, REQ_GET_TOPLEVEL, REQ_GET_TOPLEVEL_DECORATION, REQ_SET_ICON,
            REQ_SET_TITLE, decorate_title,
        },
        state::{self, PENDING_POPUPS, PendingPopup, SurfaceRole},
        test_support::{header, message, options, serial, u32_at, wl_string, word},
    };
    use super::*;

    /// A connection with a pending popup reservation for `fd`, so a role
    /// transaction opens without registering a process-global policy.
    fn reserved(fd: RawFd) -> (MutexGuard<'static, ()>, WaylandConn) {
        let guard = serial();
        state::init_state();
        state::clear_all_layer_policies();
        state::clear_runtime_state_for_fd(fd);
        PENDING_POPUPS.get().unwrap().lock().unwrap().insert(
            fd,
            PendingPopup {
                token: fd as u32,
                parent_xdg_surface_id: 20,
                width: 100,
                height: 80,
                shadow_inset: 0,
                anchor_x: 4,
                anchor_y: 5,
                positioner_id: 900,
                target_window_id: "menu-target".into(),
            },
        );
        let mut conn = WaylandConn::new();
        conn.xdg_wm_base_id = Some(2);
        conn.ifaces.insert(40, Iface::XdgSurface);
        conn.ifaces.insert(41, Iface::XdgSurface);
        conn.ifaces.insert(10, Iface::WlSurface);
        conn.xdg_to_wl.insert(40, 10);
        conn.xdg_to_wl.insert(41, 11);
        // The layer-shell machinery a conversion needs.
        conn.registry_id = Some(5);
        conn.ifaces.insert(5, Iface::WlRegistry);
        conn.layer_shell_global = Some((63, 5));
        conn.stolen_ids.push(60);
        (guard, conn)
    }

    /// A reserved connection whose popup is withdrawn, so `role_decision_needed`
    /// is false unless some policy is registered.
    fn unreserved(fd: RawFd) -> (MutexGuard<'static, ()>, WaylandConn) {
        let (guard, conn) = reserved(fd);
        PENDING_POPUPS.get().unwrap().lock().unwrap().remove(&fd);
        (guard, conn)
    }

    fn dispatch_and_collect(
        fd: RawFd,
        conn: &mut WaylandConn,
        msg: &WlMessage,
    ) -> (Vec<Vec<u8>>, Effects) {
        let mut fx = Effects::default();
        let mut out = Vec::new();
        append_action(&mut out, msg, dispatch(fd, conn, msg, &mut fx));
        (out, fx)
    }

    fn send(fd: RawFd, conn: &mut WaylandConn, msg: &WlMessage) -> Vec<Vec<u8>> {
        dispatch_and_collect(fd, conn, msg).0
    }

    #[test]
    fn a_get_toplevel_without_a_pending_decision_is_forwarded_untouched() {
        let fd = 94_000;
        let (_guard, mut conn) = unreserved(fd);
        assert!(!state::role_decision_needed(fd));

        let role = message(40, REQ_GET_TOPLEVEL, &word(50));
        let (out, _fx) = dispatch_and_collect(fd, &mut conn, &role);

        assert_eq!(out, vec![role.raw().to_vec()]);
        assert!(conn.pending_role.is_none());
        assert_eq!(conn.ifaces.get(&50), Some(&Iface::XdgToplevel));
        assert_eq!(conn.wl_to_top.get(&10), Some(&50));
        assert!(matches!(
            conn.surface_roles.get(&10),
            Some(SurfaceRole::Toplevel { .. })
        ));
    }

    #[test]
    fn commit_without_identity_flushes_an_ordinary_role_instead_of_guessing() {
        let fd = 94_001;
        let (_guard, mut conn) = reserved(fd);
        assert!(send(fd, &mut conn, &message(40, REQ_GET_TOPLEVEL, &word(50))).is_empty());
        let commit = message(10, REQ_COMMIT, &[]);
        let out = send(fd, &mut conn, &commit);
        assert_eq!(out[0], message(40, REQ_GET_TOPLEVEL, &word(50)).raw());
        assert_eq!(out[1], commit.raw());
        assert!(conn.pending_role.is_none());
        assert_eq!(conn.ifaces.get(&50), Some(&Iface::XdgToplevel));
        state::clear_runtime_state_for_fd(fd);
    }

    #[test]
    fn a_foreign_message_is_held_until_the_role_is_decided() {
        let fd = 94_002;
        let (_guard, mut conn) = reserved(fd);
        assert!(send(fd, &mut conn, &message(40, REQ_GET_TOPLEVEL, &word(50))).is_empty());
        assert!(conn.pending_role.is_some());

        let foreign = message(77, 1, &word(1));
        let out = send(fd, &mut conn, &foreign);

        // The held creation goes out first, then the foreign request is
        // dispatched normally. It is never held: it may carry a file
        // descriptor, and the transport closes descriptors of a message the
        // proxy does not forward.
        assert_eq!(out[0], message(40, REQ_GET_TOPLEVEL, &word(50)).raw());
        assert_eq!(out[1], foreign.raw());
        assert!(conn.pending_role.is_none());
        assert_eq!(conn.ifaces.get(&50), Some(&Iface::XdgToplevel));
        state::clear_runtime_state_for_fd(fd);
    }

    #[test]
    fn a_later_construction_is_sent_after_the_held_role() {
        let fd = 94_013;
        let (_guard, mut conn) = reserved(fd);
        let role = message(40, REQ_GET_TOPLEVEL, &word(50));
        assert!(send(fd, &mut conn, &role).is_empty());

        // `wl_display.sync(new_id)` allocates an id greater than the held
        // toplevel's; sending it first is exactly what the compositor refuses as
        // "not a valid new object id", so the role is completed first.
        let sync = message(1, 0, &word(70));
        let out = send(fd, &mut conn, &sync);

        assert_eq!(out[0], role.raw(), "the role reaches the compositor first");
        assert_eq!(out[1], sync.raw(), "then the construction behind it");
        assert!(conn.pending_role.is_none());
        state::clear_runtime_state_for_fd(fd);
    }

    #[test]
    fn destroying_the_role_objects_ends_the_transaction_in_order() {
        let fd = 94_014;
        let (_guard, mut conn) = reserved(fd);
        let role = message(40, REQ_GET_TOPLEVEL, &word(50));
        assert!(send(fd, &mut conn, &role).is_empty());

        let destroy_toplevel = message(50, REQ_DESTROY, &[]);
        let out = send(fd, &mut conn, &destroy_toplevel);

        // The held creation is emitted first, so the destroy that follows it
        // names an object the compositor now has.
        assert_eq!(out[0], role.raw());
        assert_eq!(out[1], destroy_toplevel.raw());
        assert!(
            conn.pending_role.is_none(),
            "a window cancelled before its title releases the transaction"
        );
        state::clear_runtime_state_for_fd(fd);
    }

    #[test]
    fn destroying_the_pending_surface_ends_the_transaction() {
        let fd = 94_015;
        let (_guard, mut conn) = reserved(fd);
        let role = message(40, REQ_GET_TOPLEVEL, &word(50));
        assert!(send(fd, &mut conn, &role).is_empty());

        let destroy_surface = message(10, REQ_DESTROY, &[]);
        let out = send(fd, &mut conn, &destroy_surface);

        assert_eq!(out[0], role.raw());
        assert_eq!(out[1], destroy_surface.raw());
        assert!(conn.pending_role.is_none());
        state::clear_runtime_state_for_fd(fd);
    }

    #[test]
    fn a_decorated_title_resolves_the_marker_and_converts() {
        let fd = 94_003;
        let (_guard, mut conn) = reserved(fd);
        assert!(send(fd, &mut conn, &message(40, REQ_GET_TOPLEVEL, &word(50))).is_empty());
        assert!(
            conn.pending_role.is_some(),
            "the role waits for its window identity"
        );
        // The decided role supplies the options; seeding it here keeps this
        // test off the process-global policy map so it cannot race other tests.
        conn.surface_roles.insert(10, SurfaceRole::Layer(options()));

        let title = message(
            50,
            REQ_SET_TITLE,
            &wl_string(&decorate_title("layer-a", "Real")),
        );
        let out = send(fd, &mut conn, &title);

        // bind, get_layer_surface and the five state requests; the title itself
        // is swallowed because a layer surface has none.
        assert_eq!(out.len(), 7);
        assert_eq!(header(&out[0]).0, 5, "bound on the client's registry");
        assert_eq!(header(&out[0]).1, REQ_BIND);
        assert_eq!(header(&out[1]).0, 60, "the stolen shell id");
        assert_eq!(header(&out[1]).1, REQ_GET_LAYER_SURFACE);
        assert_eq!(u32_at(&out[1], 8), 50, "under the client's toplevel id");
        assert_eq!(u32_at(&out[1], 12), 10, "for the role's wl_surface");
        // The layer surface replaces the toplevel, while the xdg_surface the
        // client still owns stays real.
        assert_eq!(conn.ifaces.get(&50), Some(&Iface::ZwlrLayerSurface));
        assert_eq!(conn.ifaces.get(&40), Some(&Iface::XdgSurface));
        assert_eq!(conn.xdg_to_layer.get(&40), Some(&50));
        assert_eq!(conn.wl_to_layer.get(&10), Some(&50));
        assert_eq!(conn.layer_windows.get(&50).map(|w| w.wl_surface), Some(10));
        assert_eq!(conn.layer_windows.get(&50).map(|w| w.xdg_surface), Some(40));
        assert!(matches!(
            conn.surface_roles.get(&10),
            Some(SurfaceRole::Layer(cached)) if *cached == options()
        ));
        assert!(conn.pending_role.is_none());
        // The swallowed title still named the surface for later lookups.
        assert_eq!(
            conn.surface_ids.get(&10).map(String::as_str),
            Some("layer-a")
        );
        state::clear_runtime_state_for_fd(fd);
    }

    #[test]
    fn pre_marker_decoration_and_icon_are_swept_and_shadowed_after_conversion() {
        let fd = 94_004;
        let (_guard, mut conn) = reserved(fd);
        conn.ifaces.insert(7, Iface::ZxdgDecorationManager);
        conn.ifaces.insert(8, Iface::XdgToplevelIconManager);

        let role = message(40, REQ_GET_TOPLEVEL, &word(50));
        let decoration = message(
            7,
            REQ_GET_TOPLEVEL_DECORATION,
            &[word(60), word(50)].concat(),
        );
        let mode = message(60, 1, &word(2));
        let icon = message(8, REQ_SET_ICON, &[word(50), word(70)].concat());
        for request in [&role, &decoration, &mode, &icon] {
            assert!(send(fd, &mut conn, request).is_empty());
        }
        // The decided role supplies the options; seeding it here keeps this
        // test off the process-global policy map so it cannot race other tests.
        conn.surface_roles.insert(10, SurfaceRole::Layer(options()));
        // An unadorned title must not assign the role prematurely.
        assert!(send(fd, &mut conn, &message(50, REQ_SET_TITLE, &wl_string(""))).is_empty());
        assert!(conn.pending_role.is_some());

        let out = send(
            fd,
            &mut conn,
            &message(
                50,
                REQ_SET_TITLE,
                &wl_string(&decorate_title("layer-a", "Menu")),
            ),
        );

        assert_eq!(conn.ifaces.get(&50), Some(&Iface::ZwlrLayerSurface));
        assert_eq!(conn.ifaces.get(&60), Some(&Iface::ZxdgToplevelDecoration));
        assert_eq!(conn.pending_to_client.len(), 1);
        // No request typed as xdg_toplevel may reach the compositor after the
        // role became a layer surface; the decoration is answered client-side.
        assert!(
            !out.iter()
                .any(|raw| raw == decoration.raw() || raw == mode.raw() || raw == icon.raw())
        );
        let event = &conn.pending_to_client[0];
        assert_eq!(header(event), (60, EVT_DECORATION_CONFIGURE, 12));
        assert_eq!(u32_at(event, 8), DECORATION_CLIENT_SIDE);

        // The stub decoration lives on until the client destroys it.
        assert!(send(fd, &mut conn, &message(60, REQ_DESTROY, &[])).is_empty());
        assert!(!conn.ifaces.contains_key(&60));
        assert!(!conn.injected_ids.contains(&60));
        state::clear_runtime_state_for_fd(fd);
    }

    #[test]
    fn foreign_window_cannot_consume_popup_and_initial_requests_keep_order() {
        let fd = 94_005;
        let (_guard, mut conn) = reserved(fd);
        assert!(send(fd, &mut conn, &message(40, REQ_GET_TOPLEVEL, &word(50))).is_empty());
        assert!(send(fd, &mut conn, &message(50, 3, &wl_string("orpheus"))).is_empty());
        let foreign = message(
            50,
            REQ_SET_TITLE,
            &wl_string(&decorate_title("foreign", "Other")),
        );
        let out = send(fd, &mut conn, &foreign);
        assert_eq!(out[0], message(40, REQ_GET_TOPLEVEL, &word(50)).raw());
        assert_eq!(out[1], message(50, 3, &wl_string("orpheus")).raw());
        assert_eq!(conn.ifaces.get(&50), Some(&Iface::XdgToplevel));
        assert!(
            PENDING_POPUPS
                .get()
                .unwrap()
                .lock()
                .unwrap()
                .contains_key(&fd)
        );
        assert!(send(fd, &mut conn, &message(41, REQ_GET_TOPLEVEL, &word(51))).is_empty());
        // Chromium may send a bare initial title before the decorated title.
        assert!(send(fd, &mut conn, &message(51, REQ_SET_TITLE, &wl_string(""))).is_empty());
        send(
            fd,
            &mut conn,
            &message(
                51,
                REQ_SET_TITLE,
                &wl_string(&decorate_title("menu-target", "Menu")),
            ),
        );
        assert_eq!(conn.ifaces.get(&51), Some(&Iface::XdgPopupShim));
        assert!(
            !PENDING_POPUPS
                .get()
                .unwrap()
                .lock()
                .unwrap()
                .contains_key(&fd)
        );
        assert!(conn.pending_role.is_none());
        state::clear_runtime_state_for_fd(fd);
    }

    #[test]
    fn cancellation_before_title_does_not_convert_a_destroyed_menu() {
        let fd = 94_006;
        let (_guard, mut conn) = reserved(fd);
        assert!(send(fd, &mut conn, &message(40, REQ_GET_TOPLEVEL, &word(50))).is_empty());
        state::clear_runtime_state_for_fd(fd);
        send(
            fd,
            &mut conn,
            &message(
                50,
                REQ_SET_TITLE,
                &wl_string(&decorate_title("menu-target", "Menu")),
            ),
        );
        assert_eq!(conn.ifaces.get(&50), Some(&Iface::XdgToplevel));
        assert!(conn.pending_role.is_none());
    }

    #[test]
    fn cancellation_with_queued_decoration_preserves_an_ordinary_window() {
        let fd = 94_007;
        let (_guard, mut conn) = reserved(fd);
        conn.ifaces.insert(7, Iface::ZxdgDecorationManager);
        let role = message(40, REQ_GET_TOPLEVEL, &word(50));
        let decoration = message(
            7,
            REQ_GET_TOPLEVEL_DECORATION,
            &[word(60), word(50)].concat(),
        );
        assert!(send(fd, &mut conn, &role).is_empty());
        assert!(send(fd, &mut conn, &decoration).is_empty());
        state::clear_runtime_state_for_fd(fd);
        let title = message(
            50,
            REQ_SET_TITLE,
            &wl_string(&decorate_title("menu-target", "Menu")),
        );
        let out = send(fd, &mut conn, &title);
        assert_eq!(out[0], role.raw());
        assert_eq!(out[1], decoration.raw());
        assert_eq!(conn.ifaces.get(&50), Some(&Iface::XdgToplevel));
        assert!(conn.pending_role.is_none());
        assert!(conn.pending_to_client.is_empty());
    }

    #[test]
    fn a_swept_decoration_destroy_is_replayed_in_order() {
        let fd = 94_008;
        let (_guard, mut conn) = reserved(fd);
        conn.ifaces.insert(7, Iface::ZxdgDecorationManager);
        let role = message(40, REQ_GET_TOPLEVEL, &word(50));
        let decoration = message(
            7,
            REQ_GET_TOPLEVEL_DECORATION,
            &[word(60), word(50)].concat(),
        );
        let destroy = message(60, REQ_DESTROY, &[]);
        assert!(send(fd, &mut conn, &role).is_empty());
        assert!(send(fd, &mut conn, &decoration).is_empty());
        // A destroy is swept with the role it belongs to; it does not decide the
        // transaction by itself.
        assert!(send(fd, &mut conn, &destroy).is_empty());
        assert!(conn.pending_role.is_some());

        let commit = message(10, REQ_COMMIT, &[]);
        let out = send(fd, &mut conn, &commit);
        assert_eq!(
            out,
            vec![
                role.raw().to_vec(),
                decoration.raw().to_vec(),
                destroy.raw().to_vec(),
                commit.raw().to_vec()
            ]
        );
        assert_eq!(conn.ifaces.get(&50), Some(&Iface::XdgToplevel));
        assert!(conn.pending_role.is_none());
        state::clear_runtime_state_for_fd(fd);
    }

    #[test]
    fn an_icon_for_another_window_completes_the_role_first() {
        let fd = 94_009;
        let (_guard, mut conn) = reserved(fd);
        conn.ifaces.insert(8, Iface::XdgToplevelIconManager);
        let role = message(40, REQ_GET_TOPLEVEL, &word(50));
        assert!(send(fd, &mut conn, &role).is_empty());
        // set_icon names toplevel 51, not the role's 50.
        let foreign = message(8, REQ_SET_ICON, &[word(51), word(70)].concat());
        let out = send(fd, &mut conn, &foreign);

        // The role is completed and emitted first; the icon then takes its
        // normal path, unshadowed by the transaction.
        assert_eq!(out[0], role.raw());
        assert_eq!(out[1], foreign.raw());
        assert!(conn.pending_role.is_none());
        state::clear_runtime_state_for_fd(fd);
    }

    #[test]
    fn a_later_role_object_reapplies_a_cached_layer_role_without_a_title() {
        let fd = 94_010;
        let (_guard, mut conn) = reserved(fd);

        // The first role was converted, caching the role on the surface.
        let mut fx = Effects::default();
        let first = conversion::convert_to_layer_surface(&mut conn, 40, 10, 50, options(), &mut fx)
            .expect("converted");
        assert_eq!(first.len(), 7);

        // The client builds a new role object over the same wl_surface, with a
        // fresh toplevel id and no title.
        conn.ifaces.insert(41, Iface::XdgSurface);
        conn.xdg_to_wl.insert(41, 10);
        let out = send(fd, &mut conn, &message(41, REQ_GET_TOPLEVEL, &word(51)));

        // No bind and no title: the cached role is applied immediately, under
        // the new toplevel id.
        assert_eq!(out.len(), 6);
        assert_eq!(header(&out[0]).0, 60, "the already-bound shell object");
        assert_eq!(header(&out[0]).1, REQ_GET_LAYER_SURFACE);
        assert_eq!(u32_at(&out[0], 8), 51, "the new toplevel id");
        assert_eq!(conn.ifaces.get(&51), Some(&Iface::ZwlrLayerSurface));
        assert_eq!(conn.ifaces.get(&41), Some(&Iface::XdgSurface));
        assert_eq!(conn.wl_to_layer.get(&10), Some(&51));
        assert_eq!(conn.layer_windows.get(&51).map(|w| w.wl_surface), Some(10));
        assert!(matches!(
            conn.surface_roles.get(&10),
            Some(SurfaceRole::Layer(cached)) if *cached == options()
        ));
        assert!(conn.pending_role.is_none());
        state::clear_runtime_state_for_fd(fd);
    }

    #[test]
    fn a_transaction_is_decided_after_the_sweep_limit() {
        let fd = 94_011;
        let (_guard, mut conn) = reserved(fd);
        let role = message(40, REQ_GET_TOPLEVEL, &word(50));
        assert!(send(fd, &mut conn, &role).is_empty());

        // The limit counts the requests swept for the role; the deciding one is
        // flushed together with them.
        for _ in 0..MAX_SWEPT_ROLE_REQUESTS - 1 {
            assert!(send(fd, &mut conn, &message(50, 9, &word(1))).is_empty());
        }
        assert!(conn.pending_role.is_some());

        let out = send(fd, &mut conn, &message(50, 9, &word(1)));
        assert_eq!(out.len(), MAX_SWEPT_ROLE_REQUESTS + 1);
        assert_eq!(out[0], role.raw(), "the role is emitted first");
        assert!(conn.pending_role.is_none());
        assert_eq!(conn.ifaces.get(&50), Some(&Iface::XdgToplevel));
        state::clear_runtime_state_for_fd(fd);
    }

    #[test]
    fn a_surface_that_is_already_a_toplevel_refuses_the_layer_role_and_reports_it_once() {
        let fd = 94_012;
        let (_guard, mut conn) = reserved(fd);
        conn.surface_roles
            .insert(10, SurfaceRole::Toplevel { reported: false });
        conn.surface_ids.insert(10, "4711".into());
        assert!(state::set_layer_policy("4711", options()));

        // The name lives on the surface itself, which is what the refusal
        // report resolves; there is no separate application-level lookup to be
        // cleared any more.
        assert_eq!(conn.surface_ids.get(&10).map(String::as_str), Some("4711"));

        let (out, fx) =
            dispatch_and_collect(fd, &mut conn, &message(40, REQ_GET_TOPLEVEL, &word(50)));
        assert_eq!(out.len(), 1, "the surface is left an ordinary toplevel");
        assert_eq!(conn.ifaces.get(&50), Some(&Iface::XdgToplevel));
        assert_eq!(conn.ifaces.get(&40), Some(&Iface::XdgSurface));
        assert!(matches!(
            conn.surface_roles.get(&10),
            Some(SurfaceRole::Toplevel { reported: true })
        ));
        assert!(!conn.layer_windows.contains_key(&50));
        assert_eq!(fx.layer_shell_refused.as_deref(), Some("4711"));

        // A later role object on the same surface is refused again, but the
        // application is told only once.
        conn.xdg_to_wl.insert(41, 10);
        let (again, fx) =
            dispatch_and_collect(fd, &mut conn, &message(41, REQ_GET_TOPLEVEL, &word(51)));
        // The policy has been consulted; drop it before asserting so the
        // process-global map is empty again as soon as possible.
        state::clear_all_layer_policies();
        assert_eq!(again.len(), 1);
        assert_eq!(conn.ifaces.get(&51), Some(&Iface::XdgToplevel));
        assert!(!conn.layer_windows.contains_key(&51));
        assert!(
            fx.layer_shell_refused.is_none(),
            "reported once per surface"
        );
        state::clear_runtime_state_for_fd(fd);
    }
}
