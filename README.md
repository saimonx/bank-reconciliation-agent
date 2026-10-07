# Bank reconciliation agent

An agent that, every morning, takes the new movements from the company's bank
accounts, gives each one an accounting category, and matches it to the customer
payment or supplier invoice it settles. It is an extract of the operations
platform behind [NomadFlight](https://nomadflight.com), a travel agency, where it
has run in production since December 2024 (this version since August 2026).

Before it existed I reconciled the bank by hand. Now I review and accept its
proposals, which takes about half the time.

## How a movement is processed

Cheapest and most certain first. The model is the last resort, not the first.

1. **Deterministic rules** (`src/categoryRules.js`). Known counterparties and
   concepts map straight to a category. Transfers between own accounts and card
   top-ups are ignored. No model involved. The rules are data, not code: see
   [Categories and rules](#categories-and-rules).
2. **History** (`src/historyClassifier.js`). If the exact same bank concept has
   been categorised the same way by a human at least four times, that category
   is offered as strong evidence.
3. **Candidate selection** (`src/reconciliationRules.js`). Plain code builds the
   short list of payments and invoices a movement could settle: unassociated,
   matching amount, date within tolerance, some text in common. Anything already
   matched or stale is never offered.
4. **The model decides among those candidates only** (OpenAI Responses API,
   strict JSON schema, batches of 25, `store: false`). It must return one result
   per movement, use only allowed categories, and associate only IDs it was
   given. If it has any doubt it returns no association.
5. **The answer is validated before anything is written.** IDs outside the batch,
   unknown categories, or associations that do not add up to the exact amount
   reject the result.
6. **Writes are claimed and compensated** (`src/reconciliationService.js`). Each
   candidate is claimed with a conditional update, so two runs cannot match the
   same invoice twice. If a later step fails, earlier claims are rolled back.
   Everything is saved as unverified: a person confirms it.

## Design choices

- **The model cannot invent a match.** It chooses from a list the code built, and
  the code re-checks the choice.
- **A deterministic rule always beats the model.** If a rule matched, the prompt
  says so and the validator enforces it.
- **Money has to add up.** Selected candidates must sum to the movement's exact
  amount or the association is dropped.
- **Only new movements are touched.** The agent takes the IDs just imported and
  refuses to run as a backfill over history.
- **Measured before trusted.** `scripts/` holds read-only evaluators that replay
  the rules and the history classifier against already-verified production data
  and report accuracy. They refuse any flag that would write.

## Categories and rules

Nothing about the business is hard-coded.

- **Categories come from the database.** Each run loads the leaf expense
  categories (`BankAccountTransactionCategory`) and builds the model's JSON
  schema from them, so the model can only answer with a category that exists.
- **Rules come from a JSON file** whose path is set in `CATEGORY_RULES_PATH`.
  The production file is private. `config/categoryRules.example.json` shows the
  format with a few invented suppliers, and is what the tests run against.
- **A rule names its category; the database decides if it is valid.** If the
  name does not match exactly one leaf category, the run fails closed.

```json
{
  "ruleId": "skytickets",
  "category": "Flights/Hotels",
  "patterns": ["\\bsky tickets\\b", "\\bskytickets\\b"]
}
```

## Layout

```
config/
  categoryRules.example.json  example rules (real ones are private)
src/
  categoryRules.js          loads the rule file, deterministic categories
  historyClassifier.js      categories learned from verified history
  reconciliationRules.js    candidates, prompt, schema, validation (pure)
  reconciliationService.js  loading context, calling the model, atomic writes
  openaiConfig.js
  adapters/                 interfaces to the rest of the platform (not included)
scripts/                    read-only evaluators against verified data
test/
```

## Run the tests

```bash
npm install
npm test
```

The tests make no network calls and need no API key.

## Using this in your own system

This is an extract, not a package: it runs inside a larger platform. To plug it
into yours:

1. Copy `.env.example` to `.env` and fill it in.
2. Write your own rule file from `config/categoryRules.example.json` and point
   `CATEGORY_RULES_PATH` at it. Category names must match the ones in your database.
3. Implement the modules in `src/adapters/`: the database connection and the
   models for accounts, movements, categories, payments and supplier invoices.
4. After each bank import, call `analyzeNewBankTransactions()` in `src/reconciliationService.js`
   with the IDs of the movements just imported.

## Notes

The model instructions and the bank concepts in the tests are in Spanish, as in
production. The bank feed, the scheduler and the review screen are not part of this extract.

Built with Claude Code and Codex.
