//! macOS only: the NSApplication subclass CEF requires (`CefAppProtocol`), created before CEF or winit touch `NSApp`.
//! Adapted from cef-rs's `examples/cefsimple/src/mac/mod.rs` (Apache-2.0 OR MIT). winit 0.30 accepts an existing
//! application object and swizzles its own `sendEvent:` in front of this one, which it then calls.

use cef::application_mac::{CefAppProtocol, CrAppControlProtocol, CrAppProtocol};
use objc2::{ClassType, DefinedClass, MainThreadMarker, define_class, extern_methods, msg_send, rc::Retained, runtime::{Bool, NSObjectProtocol}};
use objc2_app_kit::{NSApp, NSApplication, NSEvent};
use std::cell::Cell;

#[derive(Default)]
pub struct SpikeApplicationIvars {
    handling_send_event: Cell<Bool>,
}

define_class!(
    #[unsafe(super(NSApplication))]
    #[ivars = SpikeApplicationIvars]
    pub struct SpikeApplication;

    impl SpikeApplication {
        #[unsafe(method(sendEvent:))]
        unsafe fn send_event(&self, event: &NSEvent) {
            let was_sending_event = self.is_handling_send_event();
            if !was_sending_event {
                self.set_handling_send_event(true);
            }
            let _: () = msg_send![super(self), sendEvent: event];
            if !was_sending_event {
                self.set_handling_send_event(false);
            }
        }
    }

    unsafe impl CrAppControlProtocol for SpikeApplication {
        #[unsafe(method(setHandlingSendEvent:))]
        unsafe fn _set_handling_send_event(&self, handling_send_event: Bool) {
            self.ivars().handling_send_event.set(handling_send_event);
        }
    }

    unsafe impl CrAppProtocol for SpikeApplication {
        #[unsafe(method(isHandlingSendEvent))]
        unsafe fn _is_handling_send_event(&self) -> Bool {
            self.ivars().handling_send_event.get()
        }
    }

    unsafe impl CefAppProtocol for SpikeApplication {}
);

impl SpikeApplication {
    extern_methods! {
        #[unsafe(method(sharedApplication))]
        fn shared_application() -> Retained<Self>;

        #[unsafe(method(setHandlingSendEvent:))]
        fn set_handling_send_event(&self, handling_send_event: bool);

        #[unsafe(method(isHandlingSendEvent))]
        fn is_handling_send_event(&self) -> bool;
    }
}

/// Makes `NSApp` a `SpikeApplication`. Must run on the main thread before anything else asks for `NSApp`.
pub fn setup_application() -> bool {
    let _ = SpikeApplication::shared_application();
    NSApp(MainThreadMarker::new().expect("main thread")).isKindOfClass(SpikeApplication::class())
}

/// Loads `Chromium Embedded Framework.framework` from the bundle: `Contents/Frameworks` for the main executable,
/// three folders up for a helper app's executable. Nothing in CEF can be called before this.
pub fn load_framework() -> cef::library_loader::LibraryLoader {
    let helper = std::env::args().any(|a| a.starts_with("--type="));
    let loader = cef::library_loader::LibraryLoader::new(&std::env::current_exe().expect("current exe"), helper);
    assert!(loader.load(), "loading Chromium Embedded Framework failed");
    loader
}
