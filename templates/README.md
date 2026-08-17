# Templates — how to support a new industry

**Adding an industry requires no code change.** Drop two JSON files here, restart, done. If you
find yourself editing anything under `src/` to support a vertical, the abstraction has been
broken and should be fixed rather than worked around.

```
templates/
  industries/
    core.json          ← universal questions, asked of every brand (required)
    generic.json       ← fallback branch for unlisted industries (required)
    <your-industry>.json
  compliance/
    generic.json       ← fallback rule set, the floor for every brand (required)
    <your-industry>.json
```

## 1. Write the intake questions

`templates/industries/dentistry.json`:

```json
{
  "key": "dentistry",
  "label": "Dental practices",
  "version": 1,
  "complianceTemplate": "dentistry",
  "questions": [
    {
      "id": "treatments",
      "prompt": "Which treatments do you offer?",
      "type": "multi_text",
      "required": true,
      "minItems": 1,
      "mapsTo": "industry.treatments"
    }
  ]
}
```

Rules the loader enforces at startup:

- `key` must match the filename.
- Question ids must not collide with a core question.
- `mapsTo` must be `core.<field>` or `industry.<field>` — it decides where the answer is stored.
- `single_select` / `multi_select` must declare `options`; nothing else may.
- `complianceTemplate` must name a template that exists. Omit it to inherit `generic`.

Question types: `text`, `long_text`, `multi_text`, `single_select`, `multi_select`, `color_list`,
`font_pair`, `number`.

## 2. Write the compliance rules

`templates/compliance/dentistry.json`:

```json
{
  "key": "dentistry",
  "label": "Dental advertising",
  "version": 1,
  "basedOn": "healthcare",
  "rules": [
    {
      "id": "dent-painless",
      "title": "Painless-procedure claims",
      "severity": "BLOCK",
      "mandatory": true,
      "reason": "No procedure can be promised as painless. This is a misrepresentation.",
      "appliesTo": ["headline", "primaryText"],
      "match": { "kind": "FORBID_TERMS", "terms": ["painless", "no pain at all"] }
    }
  ]
}
```

`basedOn` composes: a dentistry rule set built on `healthcare` inherits healthcare's rules,
which in turn inherit `generic`. A rule id defined in a derived template **replaces** the same
id from its base, so an industry can tighten a generic rule without duplicating it.

### Severity

| | Effect |
|---|---|
| `BLOCK` | Content never reaches review as usable. The database refuses to approve it. |
| `FLAG` | Content reaches review with the reason attached, for a human to judge. |

### `mandatory`

A mandatory rule **cannot be switched off by the client**. They may add rules on top and may
disable non-mandatory ones, but an attempt to disable a mandatory rule is recorded and refused.
Mark a rule mandatory when it reflects a regulator or the law — not merely a preference.

### Match kinds

| Kind | Fires when |
|---|---|
| `FORBID_TERMS` | Any term appears (word-boundary, case-insensitive) |
| `FORBID_PATTERN` | A regular expression matches |
| `REQUIRE_ONE_OF` | None of the terms appear |
| `REQUIRE_TEXT` | An exact string is absent |
| `REQUIRE_WHEN` | A trigger pattern matches **and** none of the required terms appear |

`REQUIRE_WHEN` is the conditional disclosure primitive: *"if the copy mentions investment, it
must also carry a capital-at-risk warning."*

There is deliberately **no arbitrary-code rule kind**. A compliance layer that executes
template-supplied code is a remote code execution surface wearing a safety jacket.

## 3. Restart

Templates load and validate once at startup. A malformed template is a startup failure that
names the file and the field — never a surprise during generation.

## What you get for free

- The industry appears in the onboarding chooser.
- Intake asks the universal core, then your branch.
- Answers route into the brand profile by `mapsTo`.
- Generated creative is checked against your rules before any human sees it.
- An unlisted industry still gets the generic questions and the generic rule set, so onboarding
  never dead-ends and content is never generated unchecked.
