use regex::Regex;
use std::sync::LazyLock;
use unicode_normalization::UnicodeNormalization;

// Keep the order and matching semantics of mods/claude-code/core/kickoff.ts.
const JS_SPACE: &str =
    r"\x09-\x0D\x20\x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";

fn js_space(c: char) -> bool {
    matches!(c, '\u{9}'..='\u{D}' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'..='\u{200A}'
        | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}')
}

fn compile(pattern: &str) -> Regex {
    // JavaScript uses ASCII word boundaries, even with /u, and its own whitespace set.
    Regex::new(
        &pattern
            .replace(r"\b", r"(?-u:\b)")
            .replace(r"\w", "A-Za-z0-9_")
            .replace(r"\d", "[0-9]")
            .replace(r"\s", &format!("[{JS_SPACE}]"))
            .replace(r"\S", &format!("[^{JS_SPACE}]")),
    )
    .expect("valid kick-off regex")
}

macro_rules! pattern {
    ($name:ident, $pattern:expr) => {
        static $name: LazyLock<Regex> = LazyLock::new(|| compile(&$pattern));
    };
}

const ARTIFACT: &str = r"(?:app(?:lication)?|tool|utility|website|site(?: web)?|page|dashboard|script|game|bot|prototype|notebook|api|cli|service|widget|extension|form|report|generator|viewer|tracker|portal|plugin|component|workflow|pipeline|library|module|package|project|program|calendar|panel|screen|endpoint|command|parser|connector|test suite|outil|appli|tableau de bord|jeu|formulaire|rapport|générateur|portail|suivi|composant|bibliothèque|carnet|simulateur|programme|calendrier|écran|panneau)";
pattern!(
    HOST_COMMAND,
    r#"^(?:\/[a-z][\w:-]*(?:\s|$)|(?:\$|>)\s|```|(?:git|gh|npm|npx|pnpm|yarn|bun|docker|kubectl|cargo|pip|uv|brew|sudo|cd|ls|rm|mv|cp|grep|rg|curl|wget|chmod|chown)\s+\S|(?:python3?|node|bash|zsh)\s+(?:[./~-]|\S+\.[a-z]+\b)|@\S+\s*$)"#
);
pattern!(
    POLITE,
    r#"^(?:(?:please|stp|svp|s'il (?:te|vous) plaît)[, ]+|(?:can|could|would|will) you\s+|(?:(?:i|we) (?:want|need|would like)(?: you)?(?: to)?|(?:i|we)'d like(?: you)?(?: to)?|we should|let'?s)\s+|(?:peux-tu|pourrais-tu|pouvez-vous|pourriez-vous|est-ce que tu peux|merci de|je (?:veux|voudrais|souhaite)(?: que tu)?|j'aimerais(?: que tu)?)\s+)*"#
);
pattern!(
    ACKNOWLEDGMENT,
    r#"^(?:ok(?:ay)?|yes|oui|alright|d'accord|bon|next|now|maintenant)(?:\s*[,.:!]\s*|\s+)"#
);
pattern!(
    CONTINUATION,
    r#"^(?:ok(?:ay)?|oui|yes|no|non|d'accord|continue|go ahead|do it|carry on|try again|same again|as before|instead|actually|also|still|next|reprends|poursuis|vas-y|fais-le|comme avant|plutôt|en fait|toujours|aussi|ensuite)(?:\b|,)"#
);
pattern!(
    ORDINARY,
    r#"^(?:fix|debug|troubleshoot|repair|correct|resolve|investigate|refactor|update|change|modify|edit|replace|remove|rename|revert|undo|adjust|optimi[sz]e|clean up|polish|review|audit|explain|describe|summari[sz]e|check|verify|confirm|look at|take a look|run|rerun|execute|deploy|commit|push|pull|install|why|how|what|where|when|who|which|is|are|does|did|do i|should|bug|error|exception|corrige(?:r|z)?|répare(?:r|z)?|modifi(?:e|er|ez)|change(?:r|z)?|supprime(?:r|z)?|renomme(?:r|z)?|remplace(?:r|z)?|met(?:s|tre) à jour|débogue(?:r|z)?|vérifi(?:e|er|ez)|explique(?:r|z)?|résume(?:r|z)?|relis|exécute(?:r|z)?|lance(?:r|z)?|déploie(?:r|z)?|pourquoi|comment|quel(?:le|s|les)?|quoi|qui|quand|où|est-ce que|erreur|problème)\b"#
);
pattern!(
    CREATION,
    r#"^(?:create|build|make|write|design|develop|implement|generate|scaffold|draft|produce|set up|start|crée(?:r|z)?|fais|faites|faire|écri(?:s|re|vez)|construi(?:s|re|sez)|génère|générer|développe(?:r|z)?|implémente(?:r|z)?|conçois|concevoir|réalise(?:r|z)?|mets en place|mettre en place)\b"#
);
pattern!(
    CREATION_IN_EXISTING,
    r#"^(?:make|build|implement|add|write|create|develop|fais|implémente|ajoute|écris|crée)\s+(?:(?:it|this|that|them|these|those|ça|cela|ceci)\b|(?:the|le|la|les)\s+(?:existing|current|same|actuel(?:le)?|même)\b)"#
);
pattern!(
    REPORT,
    r#"\b(?:still (?:fails|breaks|doesn't work)|(?:doesn't|does not) work|keeps crashing|fails to (?:start|load|build)|ne (?:marche|fonctionne) pas|plante (?:encore|au))\b"#
);
pattern!(
    ROUTINE,
    r#"^(?:start|stop|restart)\s+(?:(?:the|a|my|our)\s+)?(?:dev server|server|container|service|database|test runner)\b|^(?:tell me|show me (?:how|why|what|where)|dis-moi|montre-moi (?:comment|pourquoi))\b"#
);
pattern!(
    ROUTINE_VERB,
    r#"^(?:add|open|file|prepare|ajoute(?:r|z)?|ouvre|ouvrir|prépare(?:r|z)?)\b"#
);
pattern!(
    OBJECT_MODIFIERS,
    r#"^(?:(?:a|an|the|some|my|our|un|une|le|la|les|du|des|mon|ma|nos|ce|cette|new|local|locale|remote|temporary|temporaire|scratch|backup|git|github|gitlab|brief|short|quick|inline|conventional|unit|regression|integration|smoke|simple|nouve(?:au|lle|aux|lles)|court(?:e|es|s)?|petit(?:e|es|s)?|bref|brève|rapide|one|two|three|deux|trois|\d+|(?:one|two|three|\d+)-(?:line|sentence))\s+)*"#
);
pattern!(
    ROUTINE_OBJECT,
    r#"^((?:branch(?:es)?|branches?|commits?(?: (?:messages?|subjects?))?|(?:messages?|titres?) (?:de|du) commits?|(?:pull|merge) requests?|prs?|mrs?|demandes? (?:de fusion|de tirage|de pull)|issues?|tickets?|signalements?|tags?|étiquettes?|tests?(?: suites?)?|(?:cas|suites?|scénarios?) de tests?|changelogs?|release notes?|(?:entrées?|notes?) (?:du|de) (?:changelogs?|journ(?:al|aux) des changements)|journ(?:al|aux) des changements|notes? de (?:version|publication|livraison|release)|summar(?:y|ies)|résumés?|synthèses?|lists?|listes?|comments?|commentaires?|doc[- ]?strings?|chaînes? de documentation|regular expressions?|expressions? régulières?|regex(?:es)?|to[- ]?dos?|tâches? à faire))(?:$|[^\p{L}\p{N}_])"#
);
pattern!(
    BARE_ARTIFACT,
    r#"^(?:(?:a|an|un|une|new|nouveau|nouvelle)\s+)?(?:(?:[\p{L}0-9-]+)\s+){0,2}{ARTIFACT}\b"#
        .replace("{ARTIFACT}", ARTIFACT)
);
pattern!(ADD_ARTIFACT, r#"^(?:add|ajoute(?:r|z)?)\s+(?:a|an|new|un|une|nouveau|nouvelle)\s+(?:[\p{L}0-9-]+\s+){0,3}{ARTIFACT}\b"#.replace("{ARTIFACT}", ARTIFACT));
pattern!(EMBEDDED_CREATION, r#"\b(?:create|build|write|make|implement|generate|add|créer|construire|écrire|ajouter)\s+(?:a|an|new|un|une|nouveau|nouvelle)\s+(?:[\p{L}0-9-]+\s+){0,3}{ARTIFACT}\b"#.replace("{ARTIFACT}", ARTIFACT));
pattern!(ROUTINE_ARTIFACT, r#"^(?:(?:management|automation|reporting)\s+)?(?:{ARTIFACT}|runners?|managers?|testers?|editors?|builders?)\b"#.replace("{ARTIFACT}", ARTIFACT));
pattern!(LETTER, r"\p{L}");
pattern!(LEADING_SCOPE, r"^(?:for|in|on|pour|dans|sur)\b[^,]*,\s*");

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(test, derive(serde::Deserialize), serde(rename_all = "lowercase"))]
enum Signal {
    Creation,
    Ordinary,
    Unclear,
}

pub fn starts_something_new(draft: &str, first_of_session: bool) -> bool {
    match kickoff_signal(draft) {
        Signal::Creation => true,
        Signal::Ordinary => false,
        Signal::Unclear => first_of_session,
    }
}

fn kickoff_signal(draft: &str) -> Signal {
    let trimmed = draft.trim_matches(js_space);
    let words = trimmed
        .split(js_space)
        .filter(|word| !word.is_empty())
        .take(61)
        .count();
    if !(3..=60).contains(&words) {
        return Signal::Ordinary;
    }
    let text = trimmed
        .nfc()
        .collect::<String>()
        .replace(['’', '‘'], "'")
        .to_lowercase();
    if HOST_COMMAND.is_match(&text) || !LETTER.is_match(&text) {
        return Signal::Ordinary;
    }
    let lead = strip_prefix(&POLITE, &text);
    let request = strip_prefix(&POLITE, strip_prefix(&ACKNOWLEDGMENT, lead));
    if CONTINUATION.is_match(request)
        || ORDINARY.is_match(request)
        || ROUTINE.is_match(request)
        || CREATION_IN_EXISTING.is_match(request)
        || creates_routine_object(request)
    {
        return Signal::Ordinary;
    }
    if CREATION.is_match(request) || ADD_ARTIFACT.is_match(request) {
        return Signal::Creation;
    }
    if REPORT.is_match(request) || request.trim_end_matches(js_space).ends_with(['?', '？']) {
        return Signal::Ordinary;
    }
    if BARE_ARTIFACT.is_match(request) || EMBEDDED_CREATION.is_match(request) {
        return Signal::Creation;
    }
    if CONTINUATION.is_match(lead) {
        Signal::Ordinary
    } else {
        Signal::Unclear
    }
}

fn strip_prefix<'a>(pattern: &Regex, text: &'a str) -> &'a str {
    pattern
        .find(text)
        .map_or(text, |matched| &text[matched.end()..])
}

fn creates_routine_object(request: &str) -> bool {
    let lead = strip_prefix(&LEADING_SCOPE, request);
    let Some(verb) = CREATION.find(lead).or_else(|| ROUTINE_VERB.find(lead)) else {
        return false;
    };
    let object = strip_prefix(
        &OBJECT_MODIFIERS,
        lead[verb.end()..].trim_start_matches(js_space),
    );
    // In “commit message generator”, the generator is the thing being built.
    ROUTINE_OBJECT.captures(object).is_some_and(|captures| {
        let routine = captures.get(1).expect("routine object capture");
        !ROUTINE_ARTIFACT.is_match(object[routine.end()..].trim_start_matches(js_space))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_claude_code_vectors() {
        let vectors: Vec<(String, Signal)> =
            serde_json::from_str(include_str!("../../../spec/kickoff-vectors.json")).unwrap();
        for (draft, signal) in vectors {
            assert_eq!(kickoff_signal(&draft), signal, "{draft}");
            assert_eq!(
                starts_something_new(&draft, false),
                signal == Signal::Creation,
                "{draft}"
            );
            assert_eq!(
                starts_something_new(&draft, true),
                signal != Signal::Ordinary,
                "{draft}"
            );
        }
    }
}
