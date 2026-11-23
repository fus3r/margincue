# General decision catalog

This file uses the card format of ARCHITECTURE.md and adds three fields: `plain_fr` and `expert_fr` are the French wordings of `plain` and `expert`, and `evidence` says what a card rests on: `owner-history (N)`, the number of the 44 regrets in the owner's mined history whose missing decision is this card's (mapped by a model judge), and `reasoned (...)`, the argument that the decision is general. Population evidence from public datasets is to be added. Each `pair` has an `open` draft and one `settled` change to it. An empty `opens:` has no outgoing link. These are decisions that any user of a coding agent can leave open, mostly about actions outside the workspace, so most of them are guards.

### ship_authority
tier: essential
rigor: explore
guard: yes
when: The draft asks the agent to finish, wrap up or resume work in a project whose result reaches people only after a push, deploy, release or publish, and neither the draft nor the conversation says whether the agent may take that last step.
settled: The draft or a Decisions line says to ship or to stop short ("build and deploy", "keep it local"); the user already granted shipping, or the conversation shows the agent merging or deploying; there is no outward step; or the user is answering the agent.
plain: When done, the work is {} | kept local for your review | pushed, but not made live | pushed and made live
expert: Delivery stops at {} | uncommitted local changes | a pushed branch or PR | merge and production deploy
plain_fr: Une fois fini, le travail est {} | gardé en local pour relecture | poussé, mais pas mis en ligne | poussé et mis en ligne
expert_fr: La livraison s'arrête à {} | des changements locaux non commités | une branche poussée ou PR | fusion et déploiement en production
why: A deploy puts unreviewed work in front of users at once, while stopping short leaves a finished fix unshipped and costs another round trip.
source: MarginCue owner history, authoring half; Saltzer and Schroeder 1975, fail-safe defaults
opens:
evidence: owner-history (3); reasoned (a deploy reaches users before review)
pair:
  open: Finish the checkout page fixes from this morning. The site deploys whenever main is updated.
  settled: Append "Push to a branch and stop there; I will deploy."

### send_or_draft
tier: essential
rigor: explore
guard: yes
when: The draft has the agent write an email, message, reply, comment or post that the agent could send or publish itself through a connected account or tool, and the draft does not say whether the agent sends it or hands back a draft.
settled: The draft says who sends ("draft only", "I'll send it", "post it"); the user is approving or editing a draft the agent already showed; a standing instruction covers sending; or the agent has no way to send.
plain: The message is {} | drafted for you to send | sent by me directly
expert: Outbound messages are {} | returned as drafts | sent through the connected account
plain_fr: Le message est {} | rédigé pour que tu l'envoies | envoyé directement par moi
expert_fr: Les messages sortants sont {} | rendus comme brouillons | envoyés via le compte connecté
why: A sent message or public post cannot be recalled, while a draft that was meant to go out leaves people waiting for an answer.
source: MarginCue owner history, authoring half
opens: message_audience
evidence: owner-history (4); reasoned (a sent message cannot be recalled)
pair:
  open: Answer the two support tickets about the failed export with the workaround we found. You can use the team's helpdesk account.
  settled: Append "Send both replies directly."

### message_audience
tier: essential
rigor: explore
guard: yes
when: The draft asks for a message or question that could go privately to one person or publicly to a shared channel, forum, tracker or thread, who can read it matters (a personal request, a complaint, an unreleased detail), and the draft does not say which.
settled: The draft names the channel or recipients, or says private or public; only one channel exists; the user is replying inside an existing thread; or the user has already chosen where to send it.
plain: The message goes {} | to the shared channel | privately to the person
expert: Visibility is {} | the public thread or forum | a private direct message
plain_fr: Le message part {} | sur le canal partagé | en privé à la personne
expert_fr: La visibilité est {} | le fil ou forum public | un message privé direct
why: A question posted where others can read it cannot be made private again and may expose a request meant for one person.
source: MarginCue owner history, authoring half
opens:
evidence: owner-history (1); reasoned (a public post cannot be made private)
pair:
  open: Write to the maintainers about the input that makes their parser leak memory. They have a public issue tracker and a security address.
  settled: Append "Send it privately to the security address."

### account_access
tier: essential
rigor: explore
guard: yes
when: The draft mentions material or records that live in the user's own external account (mailbox, messaging app, calendar, cloud drive, task manager) that the agent can reach through a browser or connector, without saying whether the agent may open, fetch from or change that account.
settled: The draft grants or withholds access ("you may fetch it", "update my calendar", "don't touch my mail"); a standing instruction covers that account; the material is already in the workspace; or the request plainly requires reading there, such as summarising what changed.
plain: In your account, I {} | change nothing, you handle it | only read what is needed | read and make the edits
expert: External account access is {} | none, user supplies material | read-only via the connector | read-write via the connector
plain_fr: Dans ton compte, je {} | ne touche à rien | lis seulement le nécessaire | lis et fais les modifications
expert_fr: L'accès au compte externe est {} | nul, tu fournis le contenu | en lecture seule | en lecture et écriture
why: Acting in a personal account can expose or change private data, while holding back leaves the agent waiting for files it could have fetched.
source: MarginCue owner history, authoring half; Saltzer and Schroeder 1975, least privilege
opens:
evidence: owner-history (4); reasoned (personal accounts hold other people's data)
pair:
  open: The vendor emailed the signed contract this morning. Add its renewal date to the tracker.
  settled: Append "You may open my mailbox and download it."

### rule_reach
tier: standard
rigor: build
guard: no
when: The draft states a new rule or limit for recurring entries (calendar events, records, uploads, files, names) while entries made under the old practice already exist, and does not say whether those existing entries are changed or only new ones must follow it.
settled: The draft says "from now on" or "fix the existing ones", or its wording covers what exists ("everywhere"); a Decisions line fixes it; no old entries exist; the rule constrains a deliverable still being made; or the user is answering the agent.
plain: The new rule applies to {} | new entries from now on | existing entries too
expert: The constraint is enforced {} | prospectively only | retroactively on existing records
plain_fr: La nouvelle règle s'applique {} | aux nouvelles entrées seulement | aux entrées existantes aussi
expert_fr: La contrainte s'applique {} | seulement à l'avenir | rétroactivement aux données existantes
why: Applying a rule to existing entries rewrites data people rely on, while applying it only forward leaves the exceptions the user may have meant to remove.
source: MarginCue owner history, authoring half
opens:
evidence: owner-history (1); reasoned (retroactive rules rewrite existing data)
pair:
  open: Uploads are limited to 20 MB. Several customers already store larger files.
  settled: Append "Existing files stay; only new uploads are checked."

### undo_scope
tier: essential
rigor: explore
guard: yes
when: The draft asks to cancel, stop, undo or roll back ("undo all that", "cancel it") while the agent has both running work and lasting effects (edited files, created or shared resources, sent changes), and does not say which of these to reverse.
settled: The draft names what to reverse or keep ("just stop the job", "revert the files too"); a Decisions line fixes it; only one thing could be undone; or the user is picking from the agent's own list of undo options.
plain: Cancelling means {} | only stopping what is running | stopping and reverting the edits | reverting and deleting what was created
expert: Rollback scope is {} | halt running processes only | halt and revert file edits | full revert, delete created resources
plain_fr: Annuler veut dire {} | arrêter seulement ce qui tourne | arrêter et défaire les modifications | tout défaire et supprimer les créations
expert_fr: La portée du retour arrière est {} | arrêt des processus seulement | arrêt et retour des fichiers | retour complet, ressources créées supprimées
why: Reverting or deleting more than intended destroys hours of work and items others use, while only stopping may leave unwanted edits in place.
source: MarginCue owner history, authoring half
opens:
evidence: owner-history (1); reasoned (an over-broad revert destroys work)
pair:
  open: Undo all of that, we are dropping the migration. The import job is still running and you already opened a pull request.
  settled: Append "Just stop the import job; leave the pull request open."

### cleanup_reach
tier: essential
rigor: explore
guard: yes
when: The draft asks to delete, prune or clean up items named by a loose category (old, unused, temporary, duplicate, test) where some items sit on the boundary, such as ones still referenced, recently used or owned by others, and the line is not drawn.
settled: The draft or a Decisions line gives an exact rule or list (paths, a name pattern, an age); the items sit in a scratch area the agent created; the removal is a text edit in a draft; or it is reversible, such as archiving.
plain: Cleanup deletes {} | everything matching the description | only items nothing still uses | only items made in this task
expert: Deletion targets {} | all pattern matches | unreferenced matches only | task-created artifacts only
plain_fr: Le nettoyage supprime {} | tout ce qui correspond | seulement ce qui ne sert plus | seulement ce que j'ai créé ici
expert_fr: La suppression vise {} | toutes les correspondances | les éléments non référencés | les artefacts créés par la tâche
why: Deleting an item that is still referenced or belongs to someone else breaks it with no undo, while keeping too much leaves the clutter the user wanted gone.
source: reasoned; the dry-run option that destructive command-line tools commonly offer
opens:
evidence: reasoned (deletion by loose category is irreversible)
pair:
  open: Delete the old test databases on the shared dev server.
  settled: Append "Only those whose names start with tmp_."

### costly_launch
tier: essential
rigor: explore
guard: yes
when: The draft resumes, continues or approves work while queued or planned runs would cost real money, quota or hours of exclusive machine time (paid compute, long benchmark jobs, bulk API calls), and it does not say whether those runs start now.
settled: The draft names which runs to start or hold; the user already approved the launch; the draft meets the condition the agent set for launching, such as a resource now being free; the pending steps are cheap; or no costly run is in view.
plain: Queued costly runs are {} | held for your go-ahead | started now, one after another | started now, in parallel
expert: Pending expensive jobs are {} | held pending approval | launched sequentially now | launched concurrently now
plain_fr: Les lancements coûteux en attente sont {} | gardés jusqu'à ton feu vert | lancés maintenant, l'un après l'autre | lancés maintenant, en parallèle
expert_fr: Les tâches coûteuses en attente sont {} | retenues jusqu'à validation | lancées en séquence maintenant | lancées en parallèle maintenant
why: A launched run spends money, quota or machine hours that cannot be recovered, while holding it stalls work the user expected to find done.
source: MarginCue owner history, authoring half
opens: spend_cap
evidence: owner-history (3); reasoned (spent compute and quota are not recoverable)
pair:
  open: Pick up where you stopped yesterday. Two load tests are queued, and each one occupies the shared staging cluster for most of an afternoon.
  settled: Append "Run only the first load test today."

### spend_cap
tier: standard
rigor: build
guard: yes
when: The draft starts or extends open-ended work that pays per use beyond the normal session (cloud compute, pay-per-call APIs, purchased credits, a paid service), and sets no limit, so the agent must choose how much to spend before stopping.
settled: The draft or a Decisions line sets a cap, a share of credits, a number of runs or a stopping rule; the user says there is no cap or wants credits used up before they expire; or the work is a single bounded call.
plain: Spending is capped at {} | a small trial, then I ask | whatever the goal needs
expert: Resource budget is {} | a pilot allotment, then review | uncapped until the goal
plain_fr: La dépense va jusqu'à {} | un petit essai, puis je demande | ce qu'il faut pour l'objectif
expert_fr: Le budget de ressources est {} | une enveloppe pilote, puis revue | sans plafond jusqu'à l'objectif
why: An uncapped loop can burn a month of credits overnight, while a cap set too low stops the run before it shows anything.
source: reasoned
opens:
evidence: reasoned (metered spending cannot be recovered)
pair:
  open: Use cloud GPUs to sweep learning rates until the model beats the baseline.
  settled: Append "Stop at 20 GPU-hours."

### check_in_policy
tier: standard
rigor: build
guard: no
when: The draft hands over an open-ended, multi-hour task with licence for large changes (big refactors, many experiments, heavy token use), and says nothing about whether the agent should stop for approval at major forks or decide alone and keep going.
settled: The draft delegates ("carte blanche", "you decide", "don't ask") or asks for check-ins ("ask me before merging", named checkpoints); a standing instruction covers autonomy; or the task is a bounded change, a question or a suggestion.
plain: At real forks, I {} | stop and ask you | decide and keep going
expert: Mid-task design decisions are {} | escalated to the user | made autonomously and logged
plain_fr: Aux vrais choix, je {} | m'arrête pour te demander | décide et continue
expert_fr: Les décisions en cours de tâche sont {} | remontées à l'utilisateur | prises seul et consignées
why: Stopping to ask can leave an unattended run idle for hours, while deciding alone can spend the whole budget on a direction the user would have vetoed.
source: MarginCue owner history, authoring half; Parasuraman, Sheridan and Wickens 2000, levels of automation
opens: spend_cap
evidence: owner-history (1); reasoned (unattended runs either stall or drift)
pair:
  open: Rework the search indexing so it scales to ten times the data. I am offline until tomorrow.
  settled: Append "Decide everything yourself; don't wait for me."

### style_reference
tier: standard
rigor: build
guard: no
when: The draft asks to redesign or substantially improve one part of a product, site or document while the rest shares the old look or approach, and does not say whether the other parts are a model to follow or also due for replacement.
settled: The draft says to match the existing style, or names a reference to follow or to avoid; the rest of the product is an approved design system; or the change is a small fix inside a design the user accepts.
plain: The redesign follows {} | the style of existing pages | a new direction, ignoring old pages
expert: Design reference is {} | current in-product patterns | external references, current UI excluded
plain_fr: La refonte suit {} | le style des pages existantes | une nouvelle direction, sans les anciennes
expert_fr: La référence de design est {} | les motifs actuels du produit | des références externes, l'existant exclu
why: Copying the look the user wants to replace makes the redesign inherit what they disliked, and the work is redone.
source: MarginCue owner history, authoring half
opens:
evidence: owner-history (1); reasoned (copying the disliked look forces a redo)
pair:
  open: Redesign the onboarding screens; they look generic and unfinished. The rest of the app was built the same way.
  settled: Append "Don't model it on the other screens; they get redone next."

### preview_first
tier: standard
rigor: build
guard: no
when: The draft asks for a new or wholly redone result whose look or creative direction is a matter of taste (a page, a redesign, a slide deck, a public piece) and takes hours to build, without saying whether to show a mockup or sample first.
settled: The draft asks for a preview first or says to build it all directly; the user already approved a mockup or direction; the change adds to an approved design; or the result is functional and small enough to review whole.
plain: Before building it all, I {} | build it straight through | show a quick preview first
expert: Delivery is {} | the complete build in one pass | a mockup for sign-off first
plain_fr: Avant de tout construire, je {} | construis tout d'une traite | montre d'abord un aperçu rapide
expert_fr: La livraison est {} | la version complète en une passe | une maquette à valider d'abord
why: A full build in the wrong direction wastes hours of work and review, while a preview costs a short pause.
source: reasoned; Buxton 2007, Sketching User Experiences
opens:
evidence: reasoned (taste-dependent builds are costly to redo)
pair:
  open: Build the new landing page for the beta announcement, with animations and a pricing section.
  settled: Append "Show me a static mockup before animating anything."

### content_placement
tier: standard
rigor: build
guard: no
when: The draft adds new content (a post, an article, a guide, release notes) to an existing site or document with a main page and room for separate sections, and does not say whether it goes into the existing page or a section of its own.
settled: The draft names the location (a path, a section, "a new page for articles"); the site already has one obvious home for that kind of content; or the content replaces an existing item in place.
plain: The new content goes {} | on the existing main page | in a separate new section
expert: New content is placed {} | inline in the current page | under a dedicated new route
plain_fr: Le nouveau contenu va {} | sur la page principale existante | dans une nouvelle section séparée
expert_fr: Le nouveau contenu est placé {} | dans la page actuelle | sous une nouvelle route dédiée
why: Content put in the wrong place reshapes a public site in a way the user then has to undo, links included.
source: MarginCue owner history, authoring half
opens:
evidence: owner-history (1); reasoned (public site structure is costly to undo)
pair:
  open: Add the release notes for version 2 to the project website, which has a single landing page.
  settled: Append "Put them in a new /notes section."

### filter_boundary
tier: standard
rigor: build
guard: no
when: The draft sets up a recurring search, watch, digest or alert from criteria the user gave, and real items will straddle them (a date window they partly overlap, a nearby region, an adjacent tier or category), without saying how to treat borderline items.
settled: The draft or a Decisions line says to include or exclude near matches; the criteria are exact identifiers with no boundary; or the user is answering the agent's question about the criteria.
plain: Borderline items are {} | left out | included, marked as partial matches
expert: Near-miss matches are {} | excluded by the strict filter | included and flagged as partial
plain_fr: Les cas limites sont {} | écartés | inclus, marqués comme partiels
expert_fr: Les correspondances approchantes sont {} | exclues par le filtre strict | incluses et signalées comme partielles
why: A strict filter silently drops items the user would have wanted, while a loose one fills every digest with noise they stop reading.
source: MarginCue owner history, authoring half
opens:
evidence: owner-history (1); reasoned (silent exclusion in recurring digests)
pair:
  open: Set up a weekly digest of calls for speakers at conferences held between March and June.
  settled: Append "Include events only partly inside the window, marked as such."
