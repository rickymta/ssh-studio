//! System tray (F7): show the window, number of open sessions, quit.
//!
//! Quitting goes through the frontend (`quit-requested`) so the same confirmation as closing
//! the window is asked when sessions or transfers are still running.
use tauri::{
    AppHandle, Emitter, Manager, Wry,
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

pub struct Tray {
    sessions: MenuItem<Wry>,
}

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Hiện cửa sổ", true, None::<&str>)?;
    let sessions = MenuItem::with_id(app, "sessions", label(0), false, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Thoát SSH Studio", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&show, &sessions, &separator, &quit])?;
    TrayIconBuilder::with_id("main")
        .icon(Image::from_bytes(include_bytes!(
            "../../assets/exports/statusbar/32x32.png"
        ))?)
        .tooltip("SSH Studio")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_window(app),
            "quit" => {
                show_window(app);
                let _ = app.emit("quit-requested", ());
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_window(tray.app_handle());
            }
        })
        .build(app)?;
    app.manage(Tray { sessions });
    Ok(())
}

pub fn label(connected: usize) -> String {
    match connected {
        0 => "Không có phiên nào đang kết nối".into(),
        n => format!("{n} phiên đang kết nối"),
    }
}

pub fn set_sessions(app: &AppHandle, connected: usize) -> tauri::Result<()> {
    if let Some(tray) = app.try_state::<Tray>() {
        tray.sessions.set_text(label(connected))?;
    }
    if let Some(icon) = app.tray_by_id("main") {
        icon.set_tooltip(Some(match connected {
            0 => "SSH Studio".to_string(),
            n => format!("SSH Studio · {n} phiên"),
        }))?;
    }
    Ok(())
}

pub fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn session_label() {
        assert_eq!(super::label(0), "Không có phiên nào đang kết nối");
        assert_eq!(super::label(3), "3 phiên đang kết nối");
    }
}
