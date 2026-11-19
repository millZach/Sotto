//! The composer demo for the browser: the same Slint composer and the same pill logic as the desktop build.

#[path = "../../src/composer.rs"]
mod composer;

slint::include_modules!();

use slint::{ComponentHandle, Model, ModelRc, VecModel};
use std::cell::RefCell;
use std::rc::Rc;
use std::time::Duration;
use wasm_bindgen::prelude::*;

fn starts_rtl(text: &str) -> bool {
    for ch in text.chars() {
        let c = ch as u32;
        if (0x0590..=0x08FF).contains(&c) || (0xFB1D..=0xFDFF).contains(&c) || (0xFE70..=0xFEFF).contains(&c) {
            return true;
        }
        if ch.is_alphabetic() {
            return false;
        }
    }
    false
}

fn menu(items: &[(&str, &str)]) -> ModelRc<MenuItem> {
    ModelRc::new(VecModel::from(items.iter().map(|(l, d)| MenuItem { label: (*l).into(), detail: (*d).into() }).collect::<Vec<_>>()))
}

#[wasm_bindgen(start)]
pub fn main() {
    let ui = AppWindow::new().expect("create the window");
    ui.set_models(menu(&[("Opus 5.5", ""), ("Sonnet 5.5", ""), ("Haiku 5.5", "")]));
    ui.set_efforts(menu(&[("Low", ""), ("Medium", ""), ("High", ""), ("XHigh", ""), ("Max", ""), ("Ultracode", "")]));
    ui.set_permissions(menu(&[("Ask for approval", ""), ("Allow edits", ""), ("Auto", ""), ("Full access", "")]));
    ui.set_composer_text(composer::initial_text());
    ui.set_effort_offer(composer::suggested_effort(&ui.get_composer_text(), -1).into());
    {
        let w = ui.as_weak();
        ui.on_take_offer(move || {
            let ui = w.unwrap();
            let offer = ui.get_effort_offer();
            let efforts = ui.get_efforts();
            if let Some(i) = (0..efforts.row_count()).find(|&i| efforts.row_data(i).is_some_and(|m| m.label == offer)) {
                ui.set_effort_index(i as i32);
                ui.set_effort_offer("".into());
            }
        });
    }
    let pills = Rc::new(RefCell::new(composer::parse(&ui.get_composer_text()).0));
    {
        let w = ui.as_weak();
        let pills = pills.clone();
        ui.on_composer_edited(move |text| {
            let ui = w.unwrap();
            let (found, cleaned) = composer::parse(&text);
            if let Some(cleaned) = cleaned {
                ui.set_composer_text(cleaned.into());
            }
            ui.set_composer_rtl(starts_rtl(&ui.get_composer_text()));
            ui.set_effort_offer(composer::suggested_effort(&ui.get_composer_text(), ui.get_effort_index()).into());
            *pills.borrow_mut() = found;
            composer::measure(&ui, &pills.borrow());
        });
    }
    {
        let pills = pills.clone();
        ui.on_pill_key(move |key, shift, anchor, cursor| composer::key_action(&pills.borrow(), &key, shift, anchor as usize, cursor as usize));
    }
    {
        let w = ui.as_weak();
        let pills = pills.clone();
        ui.on_caret_moved(move |anchor, cursor| {
            if anchor != cursor {
                return;
            }
            if let Some(to) = composer::snap(&pills.borrow(), cursor as usize) {
                let w = w.clone();
                slint::Timer::single_shot(Duration::ZERO, move || {
                    if let Some(ui) = w.upgrade() {
                        ui.invoke_place_cursor(to as i32, to as i32);
                    }
                });
            }
        });
    }
    {
        let w = ui.as_weak();
        let pills = pills.clone();
        ui.on_composer_layout_changed(move || {
            let w = w.clone();
            let pills = pills.clone();
            slint::Timer::single_shot(Duration::from_millis(16), move || {
                if let Some(ui) = w.upgrade() {
                    composer::measure(&ui, &pills.borrow());
                }
            });
        });
    }
    {
        let w = ui.as_weak();
        let next = Rc::new(RefCell::new(0usize));
        ui.on_attach(move || {
            let ui = w.unwrap();
            let names = composer::attach_names();
            let name = names[*next.borrow() % names.len()];
            *next.borrow_mut() += 1;
            let mut text = ui.get_composer_text().to_string();
            text.push(' ');
            text.push_str(&composer::pill_text(composer::FILE, name));
            text.push(' ');
            ui.set_composer_text(text.clone().into());
            ui.invoke_composer_edited(text.into());
            ui.invoke_focus_composer();
            let end = ui.get_composer_text().len() as i32;
            ui.invoke_place_cursor(end, end);
        });
    }
    // Follow the browser's viewport: Slint sizes the canvas to the window, not the other way round.
    let fit = {
        let w = ui.as_weak();
        let last = Rc::new(RefCell::new((0.0f64, 0.0f64)));
        move || {
            let Some(win) = web_sys::window() else { return };
            let (Some(vw), Some(vh)) = (win.inner_width().ok().and_then(|v| v.as_f64()), win.inner_height().ok().and_then(|v| v.as_f64())) else { return };
            if *last.borrow() == (vw, vh) {
                return;
            }
            *last.borrow_mut() = (vw, vh);
            if let Some(ui) = w.upgrade() {
                ui.window().set_size(slint::LogicalSize::new(vw as f32, vh as f32));
                ui.invoke_composer_layout_changed();
                let got = ui.window().size();
                web_sys::console::log_1(&format!("viewport {vw}x{vh}, window {}x{} physical at {}", got.width, got.height, ui.window().scale_factor()).into());
            }
        }
    };
    fit();
    let viewport = slint::Timer::default();
    viewport.start(slint::TimerMode::Repeated, Duration::from_millis(400), fit);
    std::mem::forget(viewport);
    let w = ui.as_weak();
    let p = pills.clone();
    slint::Timer::single_shot(Duration::from_millis(200), move || {
        if let Some(ui) = w.upgrade() {
            composer::measure(&ui, &p.borrow());
        }
    });
    ui.run().expect("run");
}
