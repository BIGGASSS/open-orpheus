//! Button-press tracking: remember the latest press (root window, button,
//! root coordinates) so a synthetic move can synthesize a matching release.

use super::super::codec::*;
use super::super::state::X11Conn;

/// Tracks the latest button press. Returns `true` when the message is a press
/// (core ButtonPress or XI2 ButtonPress).
pub(crate) fn track_button(
    conn: &mut X11Conn,
    evt_code: u8,
    off: usize,
    inspect_len: usize,
) -> bool {
    if evt_code == 4 || evt_code == 5 || evt_code == 6 {
        conn.root_window = r32(&conn.rx_buf[off + 8..off + 12], conn.is_le);
        if evt_code == 4 {
            conn.button = conn.rx_buf[off + 1];
            conn.root_x = r16(&conn.rx_buf[off + 20..off + 22], conn.is_le) as i16;
            conn.root_y = r16(&conn.rx_buf[off + 22..off + 24], conn.is_le) as i16;
            return true;
        }
    } else if evt_code == 35 && inspect_len >= 40 {
        let evtype = r16(&conn.rx_buf[off + 8..off + 10], conn.is_le);
        if evtype == 4 || evtype == 5 || evtype == 6 {
            conn.root_window = r32(&conn.rx_buf[off + 20..off + 24], conn.is_le);
            if evtype == 4 {
                conn.button = r32(&conn.rx_buf[off + 16..off + 20], conn.is_le) as u8;
                let rx_fp = r32(&conn.rx_buf[off + 32..off + 36], conn.is_le) as i32;
                let ry_fp = r32(&conn.rx_buf[off + 36..off + 40], conn.is_le) as i32;
                conn.root_x = (rx_fp >> 16) as i16;
                conn.root_y = (ry_fp >> 16) as i16;
                return true;
            }
        }
    }
    false
}

/// Tracks an XI2 `XI_TouchBegin` (touch equivalent of a press). Returns `true`
/// when the message starts a touch sequence, so the caller can capture its
/// bytes for a later synthetic `XI_TouchEnd`.
pub(crate) fn track_touch_begin(
    conn: &mut X11Conn,
    evt_code: u8,
    off: usize,
    inspect_len: usize,
) -> bool {
    if evt_code == XI_GENERIC_EVENT && inspect_len >= 40 {
        let evtype = r16(&conn.rx_buf[off + 8..off + 10], conn.is_le);
        if evtype == XI_EV_TOUCH_BEGIN {
            // xXIDeviceEvent wire offsets (0-based, incl. 32-byte header):
            // detail(touch id)@16, root@20, root_x@32, root_y@36.
            conn.root_window = r32(&conn.rx_buf[off + 20..off + 24], conn.is_le);
            let rx_fp = r32(&conn.rx_buf[off + 32..off + 36], conn.is_le) as i32;
            let ry_fp = r32(&conn.rx_buf[off + 36..off + 40], conn.is_le) as i32;
            conn.root_x = (rx_fp >> 16) as i16;
            conn.root_y = (ry_fp >> 16) as i16;
            conn.button = 1; // Left Click for the _NET_WM_MOVERESIZE payload
            return true;
        }
    }
    false
}
