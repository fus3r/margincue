mod support;

use std::io::Read;
use std::os::fd::AsRawFd;
use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

use margincue_relay::io::{PtyChild, Size, event, poll};
use support::{CRATE, Terminal, WRAPPER};

fn fixture(mode: &str, band: Option<u16>) -> Command {
    let mut command = if let Some(band) = band {
        let mut command = Command::new(WRAPPER);
        command.args(["--band", &band.to_string(), "--", "python3"]);
        command
    } else {
        Command::new("python3")
    };
    command
        .arg(Path::new(CRATE).join("tests/tty_child.py"))
        .arg(mode)
        .current_dir(CRATE);
    command
}

#[test]
fn viewport_resets_geometry_and_history() {
    let mut term = Terminal::spawn(
        fixture("relay", Some(3)),
        Size::cells(18, 80),
        true,
        (18, 1),
    );
    term.wait_text("READY");
    assert_eq!(term.band(3), " MarginCue\n\n");
    for (key, marker) in [
        (b'z', "SIZE (15, 80, 0, 0)"),
        (b'j', "after"),
        (b'n', "CLEARED"),
        (b'o', "ORIGIN"),
        (b'a', "IN ALT"),
        (b'b', "BACK"),
        (b'r', "RESET"),
        (b't', "SOFT RESET"),
        (b'q', "4;7R|8;15;80|4;300;800|4;382;814|6;20;10|9;60;200"),
        (b's', "history-47"),
    ] {
        term.send(&[key]);
        term.wait_text(marker);
        assert!(term.above(3).contains(marker), "{}", term.dump());
        assert_eq!(
            term.band(3),
            " MarginCue\n\n",
            "{}",
            term.dump()
        );
        if key == b'o' {
            assert!(!term.above(3).contains("before"), "{}", term.dump());
        }
        if key == b'a' {
            assert!(term.parser.screen().alternate_screen());
        }
        if key == b'b' {
            assert!(!term.parser.screen().alternate_screen());
        }
    }
    let history = term.parser.screen().scrollback_len();
    assert!(term.parser.callbacks().sync_frames > 0);
    assert_eq!(history, 33);
    term.parser.screen_mut().set_scrollback(history);
    assert!(term.contains("history-00"));
    assert!(!term.contains("MarginCue"));
    term.parser.screen_mut().set_scrollback(0);
    term.resize(Size::cells(22, 72));
    term.send(b"z");
    term.wait_text("SIZE (19, 72, 0, 0)");
    assert_eq!(term.band(3), " MarginCue\n\n");
    assert!(!term.above(3).contains("MarginCue"), "{}", term.dump());
    term.resize(Size::cells(4, 48));
    term.send(b"z");
    term.wait_text("SIZE (4, 48, 0, 0)");
    assert!(!term.contains("MarginCue"), "{}", term.dump());
    term.send(b"e");
    assert!(term.wait_exit().success());
}

#[test]
fn input_protocols_and_leader() {
    let mut term = Terminal::spawn(
        fixture("relay", Some(2)),
        Size::cells(18, 100),
        true,
        (1, 1),
    );
    term.wait_text("READY");
    term.send(b"m");
    term.wait_text("INPUT");
    for bytes in [
        b"legacy \x1b1 \xc2\xa1 \x1b[49;3u \x1b[I\x1b[O".as_slice(),
        b"\x1b[<0;5;12M\x1b[<32;6;18M\x1b[<0;6;18m\x1b[<0;10;18M\x1b[<0;10;18m",
        b"\x1b[200~paste\x1d1\x1b]x\x1b[2",
        b"01~\x1b[93;5:1u\x1b[116;1:1u\x1b[116;1:3u\x1b[93;5:3u\x1b[27;5;93~d",
    ] {
        term.send(bytes);
        term.settle(Duration::from_millis(12));
    }
    term.settle(Duration::from_millis(50));
    term.send(b"\x1d\x1d\x1dXGO");
    let expected = b"legacy \x1b1 \xc2\xa1 \x1b[49;3u \x1b[I\x1b[O\x1b[<0;5;12M\x1b[<32;6;16M\x1b[<0;6;16m\x1b[200~paste\x1d1\x1b]x\x1b[201~\x1d\x1dX";
    let expected = expected
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    term.until(Duration::from_secs(2), |term| {
        term.above(2).replace('\n', "").contains(&expected)
    });
    assert!(term.bytes.windows(5).any(|bytes| bytes == b"\x1b[>7u"));
    term.send(b"e");
}

#[test]
fn band_paint_waits_for_complete_wire_units_and_preserves_saved_cursor() {
    use margincue_relay::output::{Output, screen};

    let size = Size::cells(9, 40);
    let mut output = Output::new(size, 2);
    let mut display = Vec::new();
    let mut replies = Vec::new();
    output.start(1, 1, &mut display);
    let start = display.len();
    let fragments: &[&[u8]] = &[
        b"\x1b]0;an ordinary OSC title\x1b",
        b"\\\x1b[3;4H\x1b7\x1b[1;1H\xe2",
        b"\x80",
        b"\xba",
    ];
    for fragment in &fragments[..3] {
        output.process(fragment, &mut display, &mut replies);
        output.paint(&[b"MarginCue band".to_vec()], &mut display);
        assert!(!display.windows(9).any(|w| w == b"MarginCue"));
    }
    output.process(fragments[3], &mut display, &mut replies);
    output.paint(&[b"MarginCue band".to_vec()], &mut display);
    assert!(display[start..].starts_with(&fragments.concat()));
    output.process(b"\x1b8Q", &mut display, &mut replies);

    let mut outer = screen(size, 0);
    outer.process(&display);
    assert_eq!(outer.screen().cell(0, 0).unwrap().contents(), "›");
    assert_eq!(outer.screen().cell(2, 3).unwrap().contents(), "Q");
    assert!(outer.screen().contents().contains("MarginCue band"));
    assert!(replies.is_empty());
}

#[test]
#[ignore = "release-mode latency and idle measurement"]
fn relay_cost() {
    let case = support::LiveCase::new();
    let terminal_size = Size::cells(30, 100);
    let mut direct = Terminal::spawn(fixture("bench", None), terminal_size, false, (1, 1));
    let mut command = Command::new(WRAPPER);
    command
        .arg("--metrics")
        .arg(&case.metrics)
        .args(["--", "python3"])
        .arg(Path::new(CRATE).join("tests/tty_child.py"))
        .arg("bench")
        .current_dir(CRATE);
    let mut wrapped = Terminal::spawn(command, terminal_size, false, (1, 1));
    direct.wait_text("READY");
    wrapped.wait_text("READY");
    wrapped.wait_text("MarginCue");
    direct.settle(Duration::from_millis(30));
    wrapped.settle(Duration::from_millis(30));

    let mut results = [
        Vec::new(),
        Vec::new(),
        Vec::new(),
        Vec::new(),
        Vec::new(),
        Vec::new(),
    ];
    for (offset, (kind, count)) in [(b'x', 1500), (b'y', 400), (0x1b, 150)]
        .into_iter()
        .enumerate()
    {
        let offset = offset * 2;
        for index in 0..count {
            if index % 2 == 0 {
                results[offset].push(echo(&mut direct.process, kind));
                results[offset + 1].push(echo(&mut wrapped.process, kind));
            } else {
                results[offset + 1].push(echo(&mut wrapped.process, kind));
                results[offset].push(echo(&mut direct.process, kind));
            }
        }
    }
    for (label, values) in [
        "direct small",
        "wrapped small",
        "direct 4 KiB",
        "wrapped 4 KiB",
        "direct Escape",
        "wrapped Escape",
    ]
    .into_iter()
    .zip(&mut results)
    {
        values.sort_unstable();
        let at = |p: usize| values[(values.len() - 1) * p / 100].as_secs_f64() * 1e6;
        println!(
            "{label}: n={} p50={:.2} us p95={:.2} us p99={:.2} us",
            values.len(),
            at(50),
            at(95),
            at(99)
        );
    }
    #[cfg(target_os = "macos")]
    {
        let pid = wrapped.process.child.id();
        let before = support::usage(pid);
        let started = Instant::now();
        std::thread::sleep(Duration::from_secs(5));
        let after = support::usage(pid);
        let cpu_ns =
            after.ri_user_time + after.ri_system_time - before.ri_user_time - before.ri_system_time;
        println!(
            "idle wall_ms={:.1} cpu_us={:.1} RSS_KiB={} footprint_KiB={}",
            started.elapsed().as_secs_f64() * 1000.0,
            cpu_ns as f64 / 1000.0,
            after.ri_resident_size / 1024,
            after.ri_phys_footprint / 1024
        );
    }
    direct.send(b"e");
    wrapped.send(b"e");
    assert!(direct.wait_exit().success());
    assert!(wrapped.wait_exit().success());
    println!("{}", case.metrics());
}

fn echo(process: &mut PtyChild, key: u8) -> Duration {
    use std::io::Write;
    let start = Instant::now();
    process.master.write_all(&[key]).unwrap();
    let terminal_length = if key == b'y' { 4055 } else { 54 };
    let fd = process.master.as_raw_fd();
    let mut total = 0;
    let mut bytes = [0; 8192];
    while total < terminal_length {
        assert!(poll(&mut [event(fd, libc::POLLIN)], 2000).unwrap() > 0);
        let count = process.master.read(&mut bytes).unwrap();
        assert!(count > 0);
        total += count;
    }
    assert_eq!(total, terminal_length);
    start.elapsed()
}
