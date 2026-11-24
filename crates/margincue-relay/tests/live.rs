//! The relay against the installed Codex, in a fresh home with inert credentials and a dead
//! API endpoint: no model is reached. The test holds MarginCue's end of the pipe. Run on each
//! Codex release: `cargo test --release --test live -- --ignored --test-threads=1`.

mod support;

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::time::{Duration, Instant};

use margincue_relay::io::Size;
use serde_json::{Value, json};
use support::{LiveCase, Terminal};

const WAIT: Duration = Duration::from_secs(12);

/// MarginCue's side of the pipe, as the test plays it.
struct Card {
    link: UnixStream,
    inbox: Vec<u8>,
    seen: Vec<Value>,
}

impl Card {
    fn new(link: UnixStream) -> Self {
        Self { link, inbox: Vec::new(), seen: Vec::new() }
    }

    fn pump(&mut self) {
        let mut buffer = [0; 8192];
        while let Ok(count) = self.link.read(&mut buffer) {
            if count == 0 {
                break;
            }
            self.inbox.extend_from_slice(&buffer[..count]);
        }
        while let Some(end) = self.inbox.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.inbox.drain(..=end).collect();
            self.seen.push(serde_json::from_slice(&line[..line.len() - 1]).unwrap());
        }
    }

    fn send(&mut self, message: Value) {
        let mut line = serde_json::to_vec(&message).unwrap();
        line.push(b'\n');
        self.link.write_all(&line).unwrap();
    }

    fn last(&self, kind: &str) -> Option<&Value> {
        self.seen.iter().rev().find(|m| m["t"] == kind)
    }

    fn draft(&self) -> Option<&str> {
        self.last("draft").and_then(|m| m["text"].as_str())
    }
}

fn until(term: &mut Terminal, card: &mut Card, what: &str, mut ready: impl FnMut(&Terminal, &Card) -> bool) {
    let started = Instant::now();
    let deadline = Instant::now() + WAIT;
    struct Log<'a>(&'a str, Instant);
    impl Drop for Log<'_> {
        fn drop(&mut self) {
            eprintln!("step {:<24} {:>6} ms", self.0, self.1.elapsed().as_millis());
        }
    }
    let _log = Log(what, started);
    loop {
        term.read(Duration::from_millis(10));
        card.pump();
        if ready(term, card) {
            return;
        }
        assert!(Instant::now() < deadline, "timed out: {what}\n{}\n{:?}", term.dump(), card.seen.last());
    }
}

fn composer_ready(term: &Terminal) -> bool {
    term.contains("Ask Codex") && !term.contains("Trust this folder")
}

#[test]
#[ignore = "requires an installed Codex CLI"]
fn codex_draft_card_rows_and_enter() {
    let case = LiveCase::new();
    std::fs::create_dir_all(case.project.join("src")).unwrap();
    std::fs::write(case.project.join("src/report.ts"), "export const report = 1\n").unwrap();
    let (mut term, link) = case.spawn_codex(true, Size::cells(34, 110));
    let mut card = Card::new(link);
    until(&mut term, &mut card, "hello", |_, card| card.last("hello").is_some());
    let hello = card.last("hello").unwrap().clone();
    assert_eq!(hello["protocol"], 1);
    until(&mut term, &mut card, "composer", |term, card| composer_ready(term) && card.draft() == Some(""));
    assert_eq!(card.last("size").map(|m| m["full"].clone()), Some(json!(true)), "Codex is on its full-screen view");

    // The draft as typed, exact.
    let prompt = "Add a CSV export to the weekly report";
    term.send(prompt.as_bytes());
    until(&mut term, &mut card, "draft", |_, card| card.draft() == Some(prompt));
    let draft = card.last("draft").unwrap();
    assert_eq!(draft["plain"], true);
    assert_eq!(draft["approx"], false);

    // The card grows to its rows; Codex is redrawn above it.
    let max = card.last("size").unwrap()["max"].as_u64().unwrap();
    assert!(max >= 4, "{max}");
    card.send(json!({"t": "band", "lines": ["\u{1b}[1m MarginCue \u{1b}[0m reading", " rows exported  all rows", " date format  ISO 8601"]}));
    card.send(json!({"t": "claims", "enter": true, "arrows": true}));
    until(&mut term, &mut card, "card rows", |term, _| term.band(3).contains("rows exported") && term.band(3).contains("ISO 8601"));
    until(&mut term, &mut card, "codex above the card", |term, _| term.above(3).contains(prompt));

    // alt+↓ goes to the card, not to Codex.
    term.send(b"\x1b[1;3B");
    until(&mut term, &mut card, "key", |_, card| card.last("key").is_some_and(|m| m["key"] == "down"));

    // A popup open above the box: Enter is Codex's.
    term.send(b" in @repo");
    // Wait for Codex's search to list the file: Enter in an empty popup sends the prompt.
    until(&mut term, &mut card, "popup", |term, card| {
        term.contains("esc close") && term.above(3).contains("report.ts") && card.last("draft").is_some_and(|m| m["plain"] == false)
    });
    term.send(b"\r");
    until(&mut term, &mut card, "mention inserted", |_, card| card.draft().is_some_and(|d| d.contains("src/report.ts")));
    assert!(card.last("enter").is_none(), "Enter in a popup reached the card");

    // Enter on the plain box: the card adds its Decisions, then the prompt goes.
    until(&mut term, &mut card, "plain again", |_, card| card.last("draft").is_some_and(|m| m["plain"] == true));
    term.send(b"\r");
    until(&mut term, &mut card, "enter", |_, card| card.last("enter").is_some());
    let asked = card.last("enter").unwrap()["text"].as_str().unwrap().to_owned();
    assert!(asked.starts_with(prompt), "{asked}");
    card.send(json!({"t": "enter", "do": "append", "text": "\n\nDecisions:\n- Export covers the filtered rows."}));
    until(&mut term, &mut card, "sent", |term, _| term.contains("Decisions:") && term.contains("Export covers the filtered rows."));
    until(&mut term, &mut card, "box empty", |_, card| card.draft() == Some(""));

    // A write MarginCue asks for: an amendment into the empty box.
    card.send(json!({"t": "write", "id": 7, "text": "Amendment to my last prompt: for scope, use all rows instead of the filtered rows."}));
    until(&mut term, &mut card, "wrote", |_, card| card.last("wrote").is_some_and(|m| m["id"] == 7 && m["ok"] == true));
    assert!(card.draft().is_some_and(|d| d.starts_with("Amendment to my last prompt")));
    // Replacing it goes through Codex's editor handoff.
    card.send(json!({"t": "write", "id": 8, "text": "Amendment to my last prompt: for scope, use the selected rows instead of the filtered rows.",
        "expect": "Amendment to my last prompt: for scope, use all rows instead of the filtered rows."}));
    until(&mut term, &mut card, "replaced", |_, card| card.last("wrote").is_some_and(|m| m["id"] == 8 && m["ok"] == true));
    until(&mut term, &mut card, "replaced draft", |_, card| card.draft().is_some_and(|d| d.contains("the selected rows")));

    // The person's own ctrl+g still opens their editor.
    term.send(b"\x15");
    term.send(b"for my editor");
    until(&mut term, &mut card, "typed", |_, card| card.draft().is_some_and(|d| d.ends_with("for my editor")));
    term.send(b"\x07");
    until(&mut term, &mut card, "own editor", |_, _| case.editor_seed.is_file());
    assert_eq!(std::fs::read_to_string(&case.editor_seed).unwrap(), "for my editor");

    // Quitting Codex ends the relay with Codex's status and leaves no card behind.
    until(&mut term, &mut card, "back from the editor", |_, card| card.draft().is_some_and(|d| d.ends_with("for my editor")));
    // Ctrl+C interrupts the turn, clears the box, then quits.
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut pressed = Instant::now() - Duration::from_secs(1);
    let status = loop {
        if let Some(status) = term.process.child.try_wait().unwrap() {
            break status;
        }
        assert!(Instant::now() < deadline, "Codex did not quit\n{}", term.dump());
        if pressed.elapsed() > Duration::from_millis(400) {
            term.send(b"\x03");
            pressed = Instant::now();
        }
        term.read(Duration::from_millis(20));
    };
    // A press can land as Codex restores the terminal on its way out: SIGINT, as without the relay.
    assert!(status.success() || status.code() == Some(130), "{status:?}");
    while term.read(Duration::from_millis(20)) {}
    assert!(!term.band(3).contains("MarginCue"), "{}", term.dump());
}
