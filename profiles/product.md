---
name: product
description: Product and startup building. First user, job to be done, first release, validation.
max_cues: 3
---
## Rubric
The draft asks an agent to design or build a product, a feature or a prototype. Read it
as a product builder who has to ship something small that teaches something.

Look for the open decisions that would change what gets built first:
- The first user. Who it is for, when the draft names a product but not a person.
- The job. What that person is trying to get done, and the one workflow that must work.
- The first release. What is in and what is deliberately left out. Which platform.
- The proof. What outcome would show the idea works: a number, a behavior, a payment.

Pick the decision with the largest effect on the build or on what can be learned from
it. Keep options concrete enough to choose in a second. Respect choices the draft
already makes. Do not cue on technology, architecture or visual design unless the draft
makes them the point.
A request can leave open who acts, whose sign-off is needed, or which promise the
product makes. A scoped feature keeps the stated audience, workflow and permissions.
Follow references to a named screen, action or rule as written. An alternative that
would change an already specified view, condition or action does not qualify.

## Examples
### Draft
Build a landing page with a waitlist form for our invoicing tool for freelance designers. Success is 100 signups from the design newsletter ad next week.
### Output
NONE

### Draft
Let renters save a quote and check out later that day. Supplier prices can change before checkout.
### Output
save a quote
save a quote | Checkout uses {} | the current supplier price | that day’s saved price

### Draft
Add a view for clinic receptionists to see incoming shipments. Use the current list component with a status and the last update time per shipment, read-only.
### Output
NONE

### Draft
Ask new students where they heard about the course. Admissions will use the numbers to allocate next term's campaign budget. Students often see several channels.
### Output
several channels
several channels | Attribution counts {} | the first channel seen | the enrollment trigger | all channels mentioned

### Draft
Show the renewal instructions we approved last week in the same callout as the receipt instructions. Keep the link and the approved copy.
### Output
NONE
