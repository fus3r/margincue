import { fillStatement } from './decisions'

// Match concrete actions and outcomes in the filled decision.
const EFFECTS = [
  // Data loss and history rewrites.
  /\b(?:hard[- ]delet(?:e|es|ed|ing|ion)|permanent(?:ly)? (?:delet(?:e|es|ed|ing|ion)|remov(?:e|es|ed|ing|al)))\b/,
  /(?:^|: |\b(?:add|create|enable|run|schedule|with|using) )(?:(?:a|the|new|scheduled|automatic|nightly|daily|background) )*(?:purge|clean[- ]?up) (?:job|task|cron)\b(?! (?:will|should|runs?|is|are) )/,
  /\b(?:delet(?:e|es|ed|ing)|purg(?:e|es|ed|ing))(?! (?:jobs?|tasks?|cron|buttons?)\b)(?: [\w-]+){0,4} (?:data|records?|rows?|accounts?|teams?|users?|logs?|files?|backups?|databases?)\b/,
  /\b(?:drop|truncate)(?: [\w-]+){0,4} (?:tables?|columns?|databases?)\b/,
  /\boverwrit(?:e|es|ing|ten)(?: [\w-]+){0,4} (?:files?|backups?|[\w./-]+\.[a-z0-9]+)\b/,
  /\b(?:force[- ]push(?:es|ed|ing)?|rewrit(?:e|es|ing)(?: [\w-]+){0,3} (?:git|commit|branch) history)\b/,

  // Database migrations and dependency changes.
  /(?:^|: |\b(?:with|using|via) )(?:(?:a|the|new|background|one-time) )*(?:schema|data|database) migrations?\b(?! (?:will|should|is|are) )/,
  /\b(?:add|apply|create|run|perform|ship)(?: [\w-]+){0,4} migrations?\b/,
  /\b(?:migrate|backfill)(?: [\w-]+){0,4} (?:data|records?|rows?|tables?|columns?|schema|databases?)\b/,

  /\b(?:add|install|upgrade|bump|update|introduce|replace)(?: (?:a|the|new|existing|pinned|direct|runtime|dev|npm|python|cargo)){0,4} (?:dependenc(?:y|ies)|packages?)\b/,
  /\b(?:add|install|introduce|use) [@\w][\w@./-]* as (?:a |a new )?dependenc(?:y|ies)\b/,
  /\b(?:add|install|upgrade|bump) @[\w.-]+\/[\w.-]+\b/,
  /\b(?:upgrade|bump) [\w.-]+ to v?\d+\.\d+(?:\.\d+)?\b/,
  /\b(?:npm (?:install|add|update)|(?:pnpm|yarn) (?:add|up(?:grade)?)|(?:pip|uv pip) install|cargo add|go get) [@\w][\w@./-]*/,

  // Changes to an existing interface or a security policy.
  /\b(?:chang(?:e|es|ing)|renam(?:e|es|ing)|remov(?:e|es|ing)|replac(?:e|es|ing)|break|move|redirect)(?: (?:the|our|its))? (?:public|existing|stable|documented|legacy) (?:apis?|endpoints?|routes?|urls?|cli(?: commands?| flags?)?|file formats?|(?:csv|json) (?:format|schema|headers))\b/,
  /\b(?:rename|remove|replace|move|redirect) (?:the )?\/api\/[\w/-]+/,
  /\b(?:change|replace|remove|disable|relax|tighten|require|enforce|rotate|enable|switch to)(?: (?:the|default|existing|current|team|tenant|admin)){0,3} (?:auth(?:entication|ori[sz]ation)?|permissions?|access (?:controls?|polic(?:y|ies))|security polic(?:y|ies)|api keys?|sso|mfa|2fa|oauth|rbac|cors)\b/,
  /\b(?:grant|revoke|allow|restrict)(?: [\w-]+){0,4} (?:(?:unauthenticated|anonymous) (?:access|requests|reads|writes)|(?:write|read|admin) access|permissions?|admin roles?)\b/,

  // Delivery, money, and releases outside the repo.
  /\b(?:send|schedule)(?: [\w-]+){0,4} (?:emails?|notifications?|digests?|invitations?) (?:to|for)(?: [\w-]+){0,4} (?:customers?|users?|members?|owners?|subscribers?|channels?|everyone)\b/,
  /\b(?:email|notify)(?: [\w-]+){0,4} (?:customers?|users?|members?|owners?|subscribers?|teams?|everyone)\b/,
  /\b(?:charge|bill|refund|debit)(?: [\w$.-]+){0,4} (?:cards?|customers?|payments?|invoices?)\b/,
  /\b(?:capture|issue|make|process)(?: [\w$.-]+){0,4} (?:payments?|refunds?)\b/,
  /\b(?:deploy|publish|release)(?: [\w./@-]+){0,5} (?:to|on) (?:the )?(?:prod(?:uction)?|staging|npm|pypi|crates\.io|github|(?:app|play) store)\b/,
  /\b(?:publish|release)(?: [\w-]+){0,3} (?:packages?|(?:new|public) versions?|public (?:site|docs)|repository)\b/,
]

const NOT_DOING = /\b(?:soft-|(?:soft|no|not|never|don't|avoid|skip|prevent|without|instead of|rather than|dry[- ]run|mock|simulate|document(?:ing)?|describe|explain|plan|preview|review|check|show(?:ing)?)(?: [\w-]+){0,4} )$/
const NON_EFFECT = /^ (?:buttons?|icons?|labels?|screens?|tabs?|dialogs?|headings?|tooltips?|badges?|templates?|graphs?|reports?|status|docs|documentation|(?:in|from|on) (?:the )?(?:(?:table |chart |in-app )?preview|mock|sandbox|test inbox|(?:dry[- ]run|(?:stripe )?test) mode))\b/
const NO_ACTION = /^(?:off|disabled|never|skip|none(?: of these)?|nothing|log only|report only|preview only|dry[- ]run)$/i

/** Test the statement with its default filled in. */
export function isHardToUndo(statement: string, option: string): boolean {
  if (NO_ACTION.test(option.trim())) return false
  const decision = fillStatement(statement, option).toLowerCase().replace(/’/g, "'").replace(/`/g, '').replace(/\s+/g, ' ')
  return decision.split(/[,;]|[.!?] |\b(?:and|but|then)\b/).map((clause) => clause.trim()).some((clause) => EFFECTS.some((rule) => {
    const match = rule.exec(clause)
    return match !== null && !NOT_DOING.test(clause.slice(0, match.index)) &&
      !NON_EFFECT.test(clause.slice(match.index + match[0].length))
  }))
}
