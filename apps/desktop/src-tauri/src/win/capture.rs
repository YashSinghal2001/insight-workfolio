//! Windows screenshot capture: the primary monitor through GDI (BitBlt + GetDIBits), physical
//! pixels (the process is per-monitor DPI aware v2: tao sets it when the event loop is created).
//! Only `primary()` touches Win32; the size checks and pixel conversion are pure and tested on
//! every host. Scaling, masks, blur and WebP are the shared pipeline in `screenshot.rs`.

/// Largest monitor edge accepted (16K); anything larger is treated as a bogus rectangle.
const MAX_EDGE: i64 = 16_384;

/// Width and height of a monitor rectangle (virtual-screen coordinates, may be negative).
#[cfg_attr(not(windows), allow(dead_code))]
pub fn monitor_size(left: i32, top: i32, right: i32, bottom: i32) -> Result<(usize, usize), String> {
    let (w, h) = (i64::from(right) - i64::from(left), i64::from(bottom) - i64::from(top));
    if w <= 0 || h <= 0 || w > MAX_EDGE || h > MAX_EDGE {
        return Err(format!("unexpected display size {w}x{h}"));
    }
    Ok((w as usize, h as usize))
}

/// 32-bit BGRA rows (`stride` bytes apart, padding ignored, alpha dropped) → packed RGB in `dst`.
/// Wrong sizes are an error, never a panic (release builds abort on panic).
#[cfg_attr(not(windows), allow(dead_code))]
pub fn bgra_to_rgb(src: &[u8], dst: &mut Vec<u8>, width: usize, height: usize, stride: usize) -> Result<(), String> {
    let row = width.checked_mul(4).ok_or("unexpected image size")?;
    if width == 0 || height == 0 || stride < row {
        return Err("unexpected image size".into());
    }
    let need = stride.checked_mul(height - 1).and_then(|n| n.checked_add(row)).ok_or("unexpected image size")?;
    if src.len() < need {
        return Err("truncated pixel data".into());
    }
    dst.clear();
    dst.reserve(width * height * 3);
    for y in 0..height {
        for px in src[y * stride..y * stride + row].as_chunks::<4>().0 {
            dst.extend_from_slice(&[px[2], px[1], px[0]]);
        }
    }
    Ok(())
}

/// The primary monitor at full resolution (physical pixels), without the cursor. Re-queried on
/// every call, so display changes are picked up; any failure (secure desktop, display removed
/// mid-capture) is an error for this interval, and the next interval tries again.
#[cfg(windows)]
pub fn primary() -> Result<crate::screenshot::Frame, String> {
    use std::ptr::null_mut;
    use windows_sys::Win32::Foundation::{GetLastError, POINT};
    use windows_sys::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits, GetMonitorInfoW, MonitorFromPoint, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
        CAPTUREBLT, DIB_RGB_COLORS, MONITORINFO, MONITOR_DEFAULTTOPRIMARY, SRCCOPY,
    };

    /// Runs the cleanup on every exit path.
    struct Guard<F: FnMut()>(F);
    impl<F: FnMut()> Drop for Guard<F> {
        fn drop(&mut self) {
            (self.0)()
        }
    }

    // SAFETY: plain Win32 calls on handles created here; each one is released by its guard
    // (bitmap before its DC: guards drop in reverse order), and the bitmap is deselected
    // before GetDIBits as the API requires.
    unsafe {
        let monitor = MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY);
        let mut info = MONITORINFO { cbSize: size_of::<MONITORINFO>() as u32, ..Default::default() };
        if monitor.is_null() || GetMonitorInfoW(monitor, &mut info) == 0 {
            return Err("primary display not available".into());
        }
        let r = info.rcMonitor;
        let (w, h) = monitor_size(r.left, r.top, r.right, r.bottom)?;
        let (wi, hi) = (w as i32, h as i32);

        let screen = GetDC(null_mut());
        if screen.is_null() {
            return Err("cannot access the screen".into());
        }
        let _screen = Guard(|| {
            ReleaseDC(null_mut(), screen);
        });
        let mem = CreateCompatibleDC(screen);
        if mem.is_null() {
            return Err("cannot create a drawing context".into());
        }
        let _mem = Guard(|| {
            DeleteDC(mem);
        });
        let bitmap = CreateCompatibleBitmap(screen, wi, hi);
        if bitmap.is_null() {
            return Err("cannot allocate the screenshot bitmap".into());
        }
        let _bitmap = Guard(|| {
            DeleteObject(bitmap);
        });
        let old = SelectObject(mem, bitmap);
        if old.is_null() {
            return Err("cannot select the screenshot bitmap".into());
        }
        let copied = BitBlt(mem, 0, 0, wi, hi, screen, r.left, r.top, SRCCOPY | CAPTUREBLT);
        let error = GetLastError();
        SelectObject(mem, old);
        if copied == 0 {
            return Err(format!("screen copy failed (error {error}); the secure desktop may be active"));
        }

        let mut bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: wi,
                biHeight: -hi, // negative = top-down rows
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bgra = vec![0u8; w * h * 4];
        if GetDIBits(mem, bitmap, 0, hi as u32, bgra.as_mut_ptr().cast(), &mut bmi, DIB_RGB_COLORS) != hi {
            return Err("cannot read the screenshot pixels".into());
        }
        let mut rgb = Vec::new();
        bgra_to_rgb(&bgra, &mut rgb, w, h, w * 4)?; // 32-bit DIB rows are always DWORD aligned
        Ok(crate::screenshot::Frame { width: w as u32, height: h as u32, rgb })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::screenshot::{downscale, Frame};
    use std::time::Instant;

    #[test]
    fn bgra_rows_become_packed_rgb_and_row_padding_is_skipped() {
        // 2x2, stride 12 (4 bytes of padding per row), last row unpadded.
        let src = [1, 2, 3, 255, 4, 5, 6, 255, 9, 9, 9, 9, 7, 8, 9, 0, 10, 11, 12, 0];
        let mut dst = vec![42; 3]; // stale contents are replaced
        bgra_to_rgb(&src, &mut dst, 2, 2, 12).unwrap();
        assert_eq!(dst, [3, 2, 1, 6, 5, 4, 9, 8, 7, 12, 11, 10]);
        bgra_to_rgb(&src[..16], &mut dst, 2, 2, 8).unwrap();
        assert_eq!(dst, [3, 2, 1, 6, 5, 4, 9, 9, 9, 9, 8, 7], "tight rows");
    }

    #[test]
    fn wrong_bgra_sizes_are_errors_not_panics() {
        let mut dst = Vec::new();
        assert!(bgra_to_rgb(&[0; 16], &mut dst, 0, 2, 8).is_err(), "zero width");
        assert!(bgra_to_rgb(&[0; 16], &mut dst, 2, 0, 8).is_err(), "zero height");
        assert!(bgra_to_rgb(&[0; 16], &mut dst, 2, 2, 7).is_err(), "stride shorter than a row");
        assert!(bgra_to_rgb(&[0; 15], &mut dst, 2, 2, 8).is_err(), "truncated");
        assert!(bgra_to_rgb(&[0; 19], &mut dst, 2, 2, 12).is_err(), "truncated last row");
        assert!(bgra_to_rgb(&[0; 16], &mut dst, usize::MAX, 1, usize::MAX).is_err(), "overflow");
        assert!(bgra_to_rgb(&[0; 16], &mut dst, 1, usize::MAX, 4).is_err(), "overflow");
    }

    #[test]
    fn monitor_rectangles() {
        assert_eq!(monitor_size(0, 0, 2560, 1440), Ok((2560, 1440)));
        assert_eq!(monitor_size(-1920, -200, 0, 880), Ok((1920, 1080)), "left of / above the origin");
        assert!(monitor_size(0, 0, 0, 1080).is_err(), "empty");
        assert!(monitor_size(100, 0, 0, 1080).is_err(), "inverted");
        assert!(monitor_size(i32::MIN, 0, i32::MAX, 1080).is_err(), "absurd, no overflow");
    }

    /// Windows capture → shared pipeline cost on synthetic BGRA (no screen capture). Run
    /// `cargo test --release capture_conversion_benchmark -- --nocapture` for release timings.
    #[test]
    fn capture_conversion_benchmark() {
        for (w, h) in [(1920usize, 1080usize), (3840, 2160)] {
            let bgra: Vec<u8> = (0..w * h * 4).map(|i| (i * 7 % 251) as u8).collect();
            let mut rgb = Vec::new();
            let t = Instant::now();
            bgra_to_rgb(&bgra, &mut rgb, w, h, w * 4).unwrap();
            let convert = t.elapsed();
            let t = Instant::now();
            let out = downscale(Frame { width: w as u32, height: h as u32, rgb }, 1920).unwrap();
            let scale = t.elapsed();
            assert_eq!((out.width, out.height), (1920, 1080));
            eprintln!(
                "[bench] {w}x{h} BGRA→RGB {} ms, downscale to {}x{} {} ms ({})",
                convert.as_millis(),
                out.width,
                out.height,
                scale.as_millis(),
                if cfg!(debug_assertions) { "debug" } else { "release" }
            );
        }
    }

    /// Windows CI only: captures the runner's (virtual) primary display into memory and runs the
    /// whole pipeline. Nothing is written to disk.
    #[cfg(windows)]
    #[test]
    fn captures_the_primary_display_and_encodes_it_in_memory() {
        use crate::screenshot::{encode, redact, Config, Mask};
        let frame = primary().expect("GDI capture of the primary display");
        assert!(frame.width > 0 && frame.height > 0);
        assert_eq!(frame.rgb.len(), frame.width as usize * frame.height as usize * 3);
        let mut frame = downscale(frame, 1280).unwrap();
        assert!(frame.width.max(frame.height) <= 1280);
        let cfg = Config { interval_ms: 300_000, quality: 70.0, max_dimension: 1280, masks: vec![Mask { x: 0, y: 0, w: 5000, h: 5000 }], blur: Some(true) };
        redact(&mut frame, &cfg);
        assert_eq!(&frame.rgb[..3], [0, 0, 0], "masked corner stays black");
        let webp = encode(&frame, 70.0).unwrap();
        assert_eq!(&webp[8..12], b"WEBP");
    }

    #[cfg(windows)]
    #[test]
    fn repeated_captures_release_their_gdi_objects() {
        use windows_sys::Win32::System::Threading::{GetCurrentProcess, GetGuiResources, GR_GDIOBJECTS};
        let count = || unsafe { GetGuiResources(GetCurrentProcess(), GR_GDIOBJECTS) };
        primary().unwrap();
        let before = count();
        for _ in 0..20 {
            primary().unwrap();
        }
        assert!(count() <= before + 2, "GDI objects leaked: {before} -> {}", count());
    }
}
