# Cadence Glossary

The canonical names for concepts in the Cadence course platform. Code, UI copy, emails, and docs use these terms.

## Refunds

**Refund request**:
A learner's request to cancel a purchase and get their money back. It stays `requested` until someone approves or declines it by hand. Stored in the `refund_requests` table.
_Avoid_: Refund (for the request itself), chargeback, reversal, cancellation

**Refund**:
The money returned to the learner once a refund request is approved. It is always the purchase's `amountPaid`, never the course's list price.
_Avoid_: Reversal, chargeback

**Refund window**:
The 14 calendar days after a purchase during which the learner can raise a refund request. The fourteenth day counts in full.
_Avoid_: Cancel window

In the UI, "Cancel and refund my purchase" is the label on the button that raises a refund request. "Chargeback" and "reversal" mean other things in payments (a dispute filed through the cardholder's bank, and a voided authorization), so this codebase never uses them for refund requests.
