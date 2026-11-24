mod support;

use std::fs;
use std::time::Duration;

use memchr::memmem;
use spike_pty::editor;
use spike_pty::host::{Draft, Host};
use spike_pty::io::Size;
use support::{LiveCase, Terminal};

const WAIT: Duration = Duration::from_secs(9);

fn ready(term: &mut Terminal, host: Host) {
    if host == Host::Claude {
        term.wait_text("Yes, I trust this folder");
        assert!(term.band(2).contains("no composer"));
        // This is a new empty test project in the in-crate scratch directory.
        term.settle(Duration::from_millis(200));
        term.send(b"\x1b[B");
        term.wait_text("❯ Yes, I trust this folder");
        term.send(b"\r");
    }
    draft(term, "");
}

fn draft(term: &mut Terminal, expected: &str) -> Duration {
    let label = format!(
        "MarginCue | draft {} | {}",
        expected.chars().count(),
        expected
            .replace('\\', "\\\\")
            .replace('\n', "\\n")
            .replace('\t', "\\t")
    );
    term.until(WAIT, |term| {
        // The band intentionally truncates previews. Cross-check the full
        // draft against the application's cells above it as well.
        let reads = matches!(composite_draft(term), Draft::Visible { text, approximate: false, .. } if text == expected);
        let visible_label = label.chars().take(usize::from(term.size.cols - 4)).collect::<String>();
        reads && term.band(2).starts_with(&visible_label)
    })
}

fn composite_draft(term: &Terminal) -> Draft {
    let mut screen = term.parser.screen().clone();
    screen.set_size(
        (term.size.rows - 2).try_into().unwrap(),
        term.size.cols.try_into().unwrap(),
    );
    let host = if term.contains("Claude Code") {
        Host::Claude
    } else {
        Host::Codex
    };
    host.read(&screen)
}

fn leader(term: &mut Terminal, key: u8, kitty: bool) {
    if kitty {
        term.send(b"\x1b[93;5:1u");
    } else {
        term.send(b"\x1d");
    }
    term.send(&[key]);
}

fn count(bytes: &[u8], needle: &[u8]) -> usize {
    memmem::find_iter(bytes, needle).count()
}

fn measures(term: &Terminal, before: usize, elapsed: Duration, method: &str) {
    let bytes = &term.bytes[before..];
    let reads = term.reads.iter().filter(|read| read.0 > before);
    let in_main = reads.clone().filter(|read| !read.2).count();
    let clock = |at: usize| {
        reads
            .clone()
            .find(|read| read.0 >= before + at)
            .map(|read| read.1)
    };
    let gap = memmem::find_iter(bytes, b"\x1b[?1049l")
        .filter_map(|leave| {
            let enter = leave + memmem::find(&bytes[leave..], b"\x1b[?1049h")?;
            Some(
                clock(enter + 8)?
                    .saturating_duration_since(clock(leave + 8)?)
                    .as_secs_f64()
                    * 1000.0,
            )
        })
        .fold(None::<f64>, |largest, next| {
            Some(largest.map_or(next, |max| max.max(next)))
        });
    println!(
        "{method}: {:.2} ms, alt leave={}, enter={}, sync ends={}, {} output bytes, caret={:?}",
        elapsed.as_secs_f64() * 1000.0,
        count(bytes, b"\x1b[?1049l"),
        count(bytes, b"\x1b[?1049h"),
        count(bytes, b"\x1b[?2026l"),
        bytes.len(),
        term.parser.screen().cursor_position()
    );
    println!("  main-buffer reads={in_main}, longest alt round trip from PTY reads (ms)={gap:?}");
}

fn composer_menu(term: &mut Terminal, host: Host) {
    term.send(b"/");
    term.until(WAIT, |term| {
        term.band(2).contains("no composer")
            && term.above(2).contains(if host == Host::Claude {
                "/add-dir"
            } else {
                "model"
            })
    });
    term.send(b"\x7f");
    draft(term, "");
}

fn at_composer_start(term: &Terminal, host: Host) -> bool {
    let screen = term.parser.screen();
    let (row, col) = screen.cursor_position();
    col == 2
        && screen
            .cell(row, 0)
            .is_some_and(|cell| cell.contents() == if host == Host::Claude { "❯" } else { "›" })
}

#[cfg(target_os = "macos")]
fn measure_idle(term: &mut Terminal) {
    let pid = term.process.child.id();
    let before = support::usage(pid);
    let start = std::time::Instant::now();
    let bytes = term.bytes.len();
    term.settle(Duration::from_secs(2));
    let after = support::usage(pid);
    let cpu_us = (after.ri_user_time + after.ri_system_time
        - before.ri_user_time
        - before.ri_system_time) as f64
        / 1000.0;
    println!(
        "wrapper idle: {:.0} ms wall, {cpu_us:.1} us CPU, {} KiB RSS, {} bytes drawn",
        start.elapsed().as_secs_f64() * 1000.0,
        after.ri_resident_size / 1024,
        term.bytes.len() - bytes,
    );
}

#[test]
#[ignore = "requires installed Codex 0.171.0"]
fn codex_fullscreen_editor_resize_and_paste() {
    let case = LiveCase::new();
    let mut term = case.spawn("codex", true, true, Size::cells(30, 110));
    ready(&mut term, Host::Codex);
    assert!(term.parser.screen().alternate_screen());
    assert!(term.above(2).contains("OpenAI Codex (v0.171.0)"));
    assert!(term.above(2).contains("Ask Codex to do anything"));
    composer_menu(&mut term, Host::Codex);

    term.send("export naïve 🚀".as_bytes());
    draft(&mut term, "export naïve 🚀");
    assert!(term.above(2).contains("› export naïve 🚀"));
    let (row, _) = term.parser.screen().cursor_position();
    term.send(format!("\x1b[<0;5;{}M\x1b[<0;5;{}m", row + 1, row + 1).as_bytes());
    term.until(WAIT, |term| term.parser.screen().cursor_position().1 == 4);
    term.send(b"\x1b[O\x1b[I\x05");
    term.until(WAIT, |term| {
        matches!(composite_draft(term), Draft::Visible { at_end: true, .. })
    });
    term.send(b"\x1b[200~\n\nsecond line\x1b[201~");
    let initial = "export naïve 🚀\n\nsecond line";
    draft(&mut term, initial);
    term.resize(Size::cells(24, 85));
    draft(&mut term, initial);
    term.resize(Size::cells(32, 119));
    draft(&mut term, initial);
    assert!(
        !term
            .above(2)
            .lines()
            .any(|line| line.starts_with("MarginCue | ")),
        "{}",
        term.dump()
    );

    term.send(b"\x1b[A\x1b[A\x01");
    term.until(WAIT, |term| at_composer_start(term, Host::Codex));
    let before = term.bytes.len();
    leader(&mut term, b'1', true);
    let edited = initial.to_owned() + &editor::suffix(1);
    let elapsed = draft(&mut term, &edited);
    assert!(term.above(2).contains(editor::DECISIONS[0]));
    assert!(term.parser.screen().cursor_position().1 > 2);
    measures(&term, before, elapsed, "codex editor");

    // Move to the very first logical row before the second write channel.
    term.send(b"\x1b[A\x1b[A\x1b[A\x1b[A\x1b[A\x01");
    term.until(WAIT, |term| at_composer_start(term, Host::Codex));
    leader(&mut term, b'n', true);
    let before = term.bytes.len();
    leader(&mut term, b'p', true);
    let pasted = edited + &editor::suffix(2);
    let elapsed = draft(&mut term, &pasted);
    assert!(term.above(2).contains(editor::DECISIONS[1]));
    measures(&term, before, elapsed, "codex paste");

    assert!(count(&term.bytes, b"\x1b[>5u") > 0 || count(&term.bytes, b"\x1b[>7u") > 0);
    assert!(count(&term.bytes, b"\x1b[?2004h") > 0);
    assert!(count(&term.bytes, b"\x1b[?1004h") > 0);
    assert!(count(&term.bytes, b"\x1b[?1006h") > 0);
    assert!(count(&term.bytes, b"\x1b[?2026h") > 0);
    #[cfg(target_os = "macos")]
    measure_idle(&mut term);
    term.hangup();
    let metrics = case.metrics();
    println!("{metrics}");
    assert!(
        metrics.contains("$CASE/home/.codex/editor/.tmp"),
        "{metrics}"
    );
    assert!(
        metrics.lines().any(|line| line.starts_with("paste\t")),
        "{metrics}"
    );
}

#[test]
#[ignore = "requires installed Claude Code 2.1.330"]
fn claude_fullscreen_editor_resize_and_paste() {
    let case = LiveCase::new();
    let mut term = case.spawn("claude", true, true, Size::cells(30, 110));
    ready(&mut term, Host::Claude);
    assert!(term.above(2).contains("Claude Code v2.1.330"));
    composer_menu(&mut term, Host::Claude);
    // A one-line paste of ordinary words is wrapped by the host when the
    // window becomes narrower, so it cannot be read as an exact newline.
    let long = "export the report for the team ".repeat(2) + "after approval";
    term.send(format!("\x1b[200~{long}\x1b[201~").as_bytes());
    draft(&mut term, &long);
    term.resize(Size::cells(30, 70));
    term.until(WAIT, |term| term.band(2).contains(" | approx ")
        && matches!(composite_draft(term), Draft::Visible { text, approximate: true, .. } if text == long));
    term.resize(Size::cells(30, 110));
    draft(&mut term, &long);
    term.send(b"\x15");
    draft(&mut term, "");
    term.send("export naïve 🚀".as_bytes());
    draft(&mut term, "export naïve 🚀");
    term.send(b"\x1b[13;2u\x1b[13;2usecond line");
    let initial = "export naïve 🚀\n\nsecond line";
    draft(&mut term, initial);
    term.resize(Size::cells(24, 85));
    draft(&mut term, initial);
    term.resize(Size::cells(32, 119));
    draft(&mut term, initial);
    assert!(
        !term
            .above(2)
            .lines()
            .any(|line| line.starts_with("MarginCue | ")),
        "{}",
        term.dump()
    );

    term.send(b"\x1b[A\x1b[A\x01");
    term.until(WAIT, |term| at_composer_start(term, Host::Claude));
    let before = term.bytes.len();
    leader(&mut term, b'1', false);
    let edited = initial.to_owned() + &editor::suffix(1);
    let elapsed = draft(&mut term, &edited);
    assert!(term.above(2).contains(editor::DECISIONS[0]));
    measures(&term, before, elapsed, "claude editor");

    // Claude compresses this multiline paste to a placeholder. The regular
    // editor handoff is a separate readback of the underlying prompt bytes.
    term.send(b"\x1b[A\x1b[A\x1b[A\x1b[A\x1b[A\x01");
    term.until(WAIT, |term| at_composer_start(term, Host::Claude));
    leader(&mut term, b'n', false);
    let before = term.bytes.len();
    leader(&mut term, b'p', false);
    let elapsed = term.until(WAIT, |term| {
        term.above(2).contains("[Pasted text #") && term.band(2).contains(" | approx ")
    });
    measures(&term, before, elapsed, "claude paste placeholder");
    term.send(b"\x07");
    term.until(WAIT, |_| case.editor_seed.is_file());
    let seed = fs::read_to_string(&case.editor_seed).unwrap();
    assert_eq!(seed, edited + &editor::suffix(2));
    #[cfg(target_os = "macos")]
    {
        term.settle(Duration::from_millis(100));
        measure_idle(&mut term);
    }
    term.hangup();
    let metrics = case.metrics();
    println!("{metrics}");
    assert!(
        metrics.contains("$CASE/tmp/") && metrics.contains("claude-prompt-"),
        "{metrics}"
    );
}

#[test]
#[ignore = "requires installed Codex 0.171.0"]
fn codex_inline_picker_history_and_missing_draft_information() {
    let case = LiveCase::new();
    let mut term = case.spawn("codex", false, false, Size::cells(20, 70));
    ready(&mut term, Host::Codex);
    assert!(!term.parser.screen().alternate_screen());

    term.send(b"/model");
    term.until(WAIT, |term| {
        term.above(2).contains("› /model") && term.band(2).contains("no composer")
    });
    term.send(b"\r"); // built-in Codex picker, no model turn
    term.until(WAIT, |term| {
        term.above(2).contains("Select Model") && term.band(2).contains("no composer")
    });
    term.send(b"\x1b");
    draft(&mut term, "");

    let history = term.parser.screen().scrollback_len();
    for _ in 0..2 {
        term.send(b"/status");
        term.until(WAIT, |term| {
            term.above(2).contains("› /status") && term.band(2).contains("no composer")
        });
        term.send(b"\r"); // built-in local status display
        draft(&mut term, "");
    }
    let new_history = term.parser.screen().scrollback_len();
    assert!(new_history > history, "{}", term.dump());
    term.parser.screen_mut().set_scrollback(new_history);
    assert!(!term.contains("MarginCue | "));
    term.parser.screen_mut().set_scrollback(0);
    println!(
        "Codex inline /status added {} outer scrollback rows",
        new_history - history
    );

    let first = "fragment".repeat(7);
    let word = "longerboundary";
    let soft = format!("{first} {word}");
    let hard = format!("{first}\n{word}");
    let signature = |term: &Terminal| {
        let screen = term.parser.screen();
        let (row, col) = screen.cursor_position();
        let cells = [row - 1, row]
            .into_iter()
            .flat_map(|line| (0..term.size.cols).map(move |col| screen.cell(line, col).cloned()))
            .collect::<Vec<_>>();
        (col, cells, screen.row_wrapped(row - 1))
    };
    let mut observations = Vec::new();
    for text in [&soft, &hard] {
        term.send(format!("\x1b[200~{text}\x1b[201~").as_bytes());
        term.until(WAIT, |term| term.band(2).contains(" | approx ") &&
            matches!(composite_draft(term), Draft::Visible { text, approximate: true, .. } if text == soft));
        observations.push(signature(&term));
        term.send(b"\x03");
        draft(&mut term, "");
    }
    assert_eq!(observations[0], observations[1]);
    assert!(!observations[0].2);

    let collapsed = "timbre".repeat(180);
    term.send(format!("\x1b[200~{collapsed}\x1b[201~").as_bytes());
    term.until(WAIT, |term| {
        term.above(2).contains("[Pasted Content 1080 chars]") && term.band(2).contains(" | approx ")
    });
    assert!(!term.above(2).contains("timbre"));
    term.send(b"\x07");
    term.until(WAIT, |_| case.editor_seed.is_file());
    assert_eq!(fs::read_to_string(&case.editor_seed).unwrap(), collapsed);
    term.hangup();
}
