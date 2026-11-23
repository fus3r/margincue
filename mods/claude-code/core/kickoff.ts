const HOST_COMMAND = /^(?:\/[a-z][\w:-]*(?:\s|$)|(?:\$|>)\s|```|(?:git|gh|npm|npx|pnpm|yarn|bun|docker|kubectl|cargo|pip|uv|brew|sudo|cd|ls|rm|mv|cp|grep|rg|curl|wget|chmod|chown)\s+\S|(?:python3?|node|bash|zsh)\s+(?:[./~-]|\S+\.[a-z]+\b)|@\S+\s*$)/;
const POLITE = /^(?:(?:please|stp|svp|s'il (?:te|vous) plaît)[, ]+|(?:can|could|would|will) you\s+|(?:(?:i|we) (?:want|need|would like)(?: you)?(?: to)?|(?:i|we)'d like(?: you)?(?: to)?|we should|let'?s)\s+|(?:peux-tu|pourrais-tu|pouvez-vous|pourriez-vous|est-ce que tu peux|merci de|je (?:veux|voudrais|souhaite)(?: que tu)?|j'aimerais(?: que tu)?)\s+)*/;
const ACKNOWLEDGMENT = /^(?:ok(?:ay)?|yes|oui|alright|d'accord|bon|next|now|maintenant)(?:\s*[,.:!]\s*|\s+)/;
const CONTINUATION = /^(?:ok(?:ay)?|oui|yes|no|non|d'accord|continue|go ahead|do it|carry on|try again|same again|as before|instead|actually|also|still|next|reprends|poursuis|vas-y|fais-le|comme avant|plutôt|en fait|toujours|aussi|ensuite)(?:\b|,)/;
const ORDINARY = /^(?:fix|debug|troubleshoot|repair|correct|resolve|investigate|refactor|update|change|modify|edit|replace|remove|rename|revert|undo|adjust|optimi[sz]e|clean up|polish|review|audit|explain|describe|summari[sz]e|check|verify|confirm|look at|take a look|run|rerun|execute|deploy|commit|push|pull|install|why|how|what|where|when|who|which|is|are|does|did|do i|should|bug|error|exception|corrige(?:r|z)?|répare(?:r|z)?|modifi(?:e|er|ez)|change(?:r|z)?|supprime(?:r|z)?|renomme(?:r|z)?|remplace(?:r|z)?|met(?:s|tre) à jour|débogue(?:r|z)?|vérifi(?:e|er|ez)|explique(?:r|z)?|résume(?:r|z)?|relis|exécute(?:r|z)?|lance(?:r|z)?|déploie(?:r|z)?|pourquoi|comment|quel(?:le|s|les)?|quoi|qui|quand|où|est-ce que|erreur|problème)\b/u;
const CREATION = /^(?:create|build|make|write|design|develop|implement|generate|scaffold|draft|produce|set up|start|crée(?:r|z)?|fais|faites|faire|écri(?:s|re|vez)|construi(?:s|re|sez)|génère|générer|développe(?:r|z)?|implémente(?:r|z)?|conçois|concevoir|réalise(?:r|z)?|mets en place|mettre en place)\b/u;
const CREATION_IN_EXISTING = /^(?:make|build|implement|add|write|create|develop|fais|implémente|ajoute|écris|crée)\s+(?:(?:it|this|that|them|these|those|ça|cela|ceci)\b|(?:the|le|la|les)\s+(?:existing|current|same|actuel(?:le)?|même)\b)/u;
const REPORT = /\b(?:still (?:fails|breaks|doesn't work)|(?:doesn't|does not) work|keeps crashing|fails to (?:start|load|build)|ne (?:marche|fonctionne) pas|plante (?:encore|au))\b/u;
const ROUTINE = /^(?:start|stop|restart)\s+(?:(?:the|a|my|our)\s+)?(?:dev server|server|container|service|database|test runner)\b|^(?:tell me|show me (?:how|why|what|where)|dis-moi|montre-moi (?:comment|pourquoi))\b/u;
const ARTIFACT = '(?:app(?:lication)?|tool|utility|website|site(?: web)?|page|dashboard|script|game|bot|prototype|notebook|api|cli|service|widget|extension|form|report|generator|viewer|tracker|portal|plugin|component|workflow|pipeline|library|module|package|project|program|calendar|panel|screen|endpoint|command|parser|connector|test suite|outil|appli|tableau de bord|jeu|formulaire|rapport|générateur|portail|suivi|composant|bibliothèque|carnet|simulateur|programme|calendrier|écran|panneau)';
const BARE_ARTIFACT = new RegExp(`^(?:(?:a|an|un|une|new|nouveau|nouvelle)\\s+)?(?:(?:[\\p{L}0-9-]+)\\s+){0,2}${ARTIFACT}\\b`, 'u');
const ADD_ARTIFACT = new RegExp(`^(?:add|ajoute(?:r|z)?)\\s+(?:a|an|new|un|une|nouveau|nouvelle)\\s+(?:[\\p{L}0-9-]+\\s+){0,3}${ARTIFACT}\\b`, 'u');
const EMBEDDED_CREATION = new RegExp(`\\b(?:create|build|write|make|implement|generate|add|créer|construire|écrire|ajouter)\\s+(?:a|an|new|un|une|nouveau|nouvelle)\\s+(?:[\\p{L}0-9-]+\\s+){0,3}${ARTIFACT}\\b`, 'u');
const ROUTINE_VERB = /^(?:add|open|file|prepare|ajoute(?:r|z)?|ouvre|ouvrir|prépare(?:r|z)?)\b/u;
const OBJECT_MODIFIERS = /^(?:(?:a|an|the|some|my|our|un|une|le|la|les|du|des|mon|ma|nos|ce|cette|new|local|locale|remote|temporary|temporaire|scratch|backup|git|github|gitlab|brief|short|quick|inline|conventional|unit|regression|integration|smoke|simple|nouve(?:au|lle|aux|lles)|court(?:e|es|s)?|petit(?:e|es|s)?|bref|brève|rapide|one|two|three|deux|trois|\d+|(?:one|two|three|\d+)-(?:line|sentence))\s+)*/u;
const ROUTINE_OBJECT = /^(?:branch(?:es)?|branches?|commits?(?: (?:messages?|subjects?))?|(?:messages?|titres?) (?:de|du) commits?|(?:pull|merge) requests?|prs?|mrs?|demandes? (?:de fusion|de tirage|de pull)|issues?|tickets?|signalements?|tags?|étiquettes?|tests?(?: suites?)?|(?:cas|suites?|scénarios?) de tests?|changelogs?|release notes?|(?:entrées?|notes?) (?:du|de) (?:changelogs?|journ(?:al|aux) des changements)|journ(?:al|aux) des changements|notes? de (?:version|publication|livraison|release)|summar(?:y|ies)|résumés?|synthèses?|lists?|listes?|comments?|commentaires?|doc[- ]?strings?|chaînes? de documentation|regular expressions?|expressions? régulières?|regex(?:es)?|to[- ]?dos?|tâches? à faire)(?=$|[^\p{L}\p{N}_])/u;
const ROUTINE_ARTIFACT = new RegExp(`^(?:(?:management|automation|reporting)\\s+)?(?:${ARTIFACT}|runners?|managers?|testers?|editors?|builders?)\\b`, 'u');

type Signal = 'creation' | 'ordinary' | 'unclear';

export function kickoffSignal(draft: string): Signal {
  const text = draft.trim().normalize('NFC').replace(/[’‘]/g, "'").toLowerCase();
  const words = text.match(/\S+/g)?.length ?? 0;
  if (words < 3 || words > 60 || HOST_COMMAND.test(text) || !/\p{L}/u.test(text)) {
    return 'ordinary';
  }

  const lead = text.replace(POLITE, '');
  const request = lead.replace(ACKNOWLEDGMENT, '').replace(POLITE, '');
  if (CONTINUATION.test(request) || ORDINARY.test(request) || ROUTINE.test(request) || CREATION_IN_EXISTING.test(request)) {
    return 'ordinary';
  }
  if (createsRoutineObject(request)) return 'ordinary';
  if (CREATION.test(request) || ADD_ARTIFACT.test(request)) {
    return 'creation';
  }
  if (REPORT.test(request) || /[?？]\s*$/.test(request)) {
    return 'ordinary';
  }
  if (BARE_ARTIFACT.test(request) || EMBEDDED_CREATION.test(request)) {
    return 'creation';
  }
  return CONTINUATION.test(lead) ? 'ordinary' : 'unclear';
}

function createsRoutineObject(request: string): boolean {
  const lead = request.replace(/^(?:for|in|on|pour|dans|sur)\b[^,]*,\s*/u, '');
  const verb = CREATION.exec(lead) ?? ROUTINE_VERB.exec(lead);
  if (!verb) return false;
  const object = lead.slice(verb[0].length).trimStart().replace(OBJECT_MODIFIERS, '');
  const routine = ROUTINE_OBJECT.exec(object);
  // In “commit message generator”, the generator is the thing being built.
  return routine !== null && !ROUTINE_ARTIFACT.test(object.slice(routine[0].length).trimStart());
}

export function startsSomethingNew(draft: string, context: { firstOfSession: boolean }): boolean {
  const signal = kickoffSignal(draft);
  return signal === 'creation' || (signal === 'unclear' && context.firstOfSession);
}
