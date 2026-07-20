---
name: writing-docs
description: Write and edit technical documentation for a software project. Use whenever the task involves creating or editing README files, developer guides, tutorials, how-to guides, API references, explanations, changelogs, release notes, or any markdown documentation.
---

# Writing docs

This skill defines how to write documentation for this project. Follow it for
every README, guide, tutorial, reference page, changelog, and other markdown
document. The goal is documentation that a reader can act on: correct,
verifiable, and shaped by what the reader is trying to do.

## Standards this skill is built on

The rules below come from established standards. Know the lineage so you can
resolve conflicts. Higher entries win:

1. **Diátaxis** (diataxis.fr) — the structural backbone: four document types,
   never mixed.
2. **Google Developer Documentation Style Guide** — the default style
   authority for anything this skill does not cover: word choice, UI
   instructions, code formatting, accessibility.
3. **Microsoft Writing Style Guide** — secondary style reference. When Google
   and Microsoft disagree, follow Google.
4. **Plain language guidelines** (plainlanguage.gov, ISO 24495-1) — the
   sentence-level rules: active voice, short sentences, no hidden verbs
   ("perform an installation" → "install").
5. **ASD-STE100 Simplified Technical English** — the discipline behind the
   strictest rules: one meaning per word, one instruction per sentence,
   consistent terms. Do not adopt its restricted dictionary. Do adopt its
   rigor for procedural steps and warnings.
6. **Minimalism** (John Carroll) — task-first writing: start with the
   reader's goal, cut preamble, support error recovery instead of pretending
   nothing fails.
7. **DITA / Information Mapping** — topic-based writing: each section is
   self-contained, has one purpose, and works out of order. Readers arrive
   via search, not page 1.
8. **Keep a Changelog + Semantic Versioning** — the exact format for
   changelogs and release notes.
9. **OpenAPI / JSON Schema / TSDoc** — when these machine-readable specs
   exist in the repo, reference docs must be anchored to them, never written
   freehand.
10. **Standard Readme** — the README section ordering convention.
11. **Vale** — if the repo has a Vale config, treat its rules as hard
    constraints. State that the output must pass it.

## Step 1: classify the document

Before you write anything, classify the document as one of the four Diátaxis
types. Then follow that type's rules strictly.

| Type | Orientation | The reader wants to… |
| --- | --- | --- |
| Tutorial | Learning | learn by doing, from zero |
| How-to guide | Task | get a specific job done |
| Reference | Information | look up exact facts |
| Explanation | Understanding | understand why it is this way |

**Tutorial.** Take a beginner from zero to a working result. Make every step
concrete and verifiable. Do not explain theory. Do not offer options or
alternatives. The reader follows; the author decides.

**How-to guide.** Assume a competent reader with a specific goal. Start from
a real-world starting point, not from installation. Keep preamble minimal.
Do not teach. Link out for background.

**Reference.** Be complete, accurate, and dry. Describe the machinery: every
parameter, type, default, and error. Mirror the structure of the code. Never
mix in opinions or tutorial content.

**Explanation.** Discuss context, design decisions, trade-offs, and
alternatives. Do not include step-by-step instructions.

If a draft mixes types — for example, a how-to guide that stops to explain
theory — split the content or move it to the right document. Do not blend.
Link between the documents instead.

## Workflow

1. Identify the audience and the document type. If the type is ambiguous,
   ask the user one clarifying question. Then proceed.
2. Read the relevant source code before you document behavior. If the repo
   has OpenAPI, JSON Schema, or TSDoc definitions, read those too.
3. For anything longer than a README section, draft an outline of headings
   before you write prose.
4. Write the draft.
5. Self-review against the language rules below. Hunt for passive voice,
   multi-action steps, filler words, unverified claims, and type-mixing.
   If the repo has a Vale config, the output must pass it. Fix everything
   before you present the draft.

## Language rules (hard constraints)

- Use active voice and the imperative mood for instructions: "Run the
  server", not "The server should be run".
- One action per numbered step. State the expected result when it is not
  obvious: "Run `make build`. The binary appears in `./bin`."
- Keep sentences under 25 words. One idea per sentence.
- Use the present tense: "The function returns", not "will return".
- No marketing language. No filler: "simply", "easily", "just", "powerful",
  "seamless". No anthropomorphizing: never "the API wants".
- Define each acronym on first use.
- Use one term per concept, everywhere. Never alternate between synonyms
  ("endpoint" vs "route" vs "URL") for the same thing.
- Address the reader as "you". Never use "we" for the reader's actions.
- For anything not covered above, follow the Google developer documentation
  style guide.

## Code samples

- Make every code sample complete enough to run. If a sample is a fragment,
  mark it as one and state its context.
- Show expected output after commands where it helps the reader verify.
- Use realistic values in user-facing examples. Never `foo` or `bar`.
- Check each command mentally against the stated platform. Note OS
  differences where they exist.
- Never invent API parameters, flags, or config keys. Verify each one
  against the source code, or against the OpenAPI, JSON Schema, or TSDoc
  definitions when present. If you cannot verify an item, mark it as TODO.
  Do not guess.

## Structure rules

- Write topic-based sections: each section is self-contained and useful when
  a reader lands on it directly from search.
- Lead with what the reader gets, not with background. The first paragraph
  answers: what is this, who is it for, what will I be able to do.
- READMEs follow Standard Readme ordering: one-line description → quick
  start (under 5 steps) → usage → configuration → links to deeper docs.
- Write headings in sentence case. Make them descriptive and front-loaded
  with keywords: "Configure retries", not "How you can go about configuring
  retries".
- List prerequisites explicitly at the top of tutorials and how-to guides.
- Include error recovery. For steps likely to fail, add: "If X happens,
  do Y."

## Changelogs

Follow the Keep a Changelog format with Semantic Versioning:

- One section per release, newest first, with the version and an ISO date:
  `## [1.2.0] - 2026-07-20`.
- Group entries under `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`,
  and `Security`. Omit empty groups.
- Keep an `## [Unreleased]` section at the top for pending changes.
- Write entries for humans: what changed and why it matters to the user,
  not commit messages.

## Before/after examples

Calibrate against these rewrites.

### 1. Passive, filler-heavy quick start → imperative steps with verification

Before:

> Getting started is easy! First, the dependencies should be installed, after
> which the configuration file can simply be edited to reflect your setup, and
> then the server is able to be started.

After:

> 1. Install the dependencies: `npm install`.
> 2. Open `config.yaml`. Set `port` to a free port on your machine.
> 3. Start the server: `npm start`. The log prints `listening on :3000`.
>
> If the port is in use, the server exits with `EADDRINUSE`. Pick another
> port in `config.yaml`.

### 2. How-to guide with a theory detour → task only, theory linked out

Before:

> To rotate your API key, it helps to first understand our key hierarchy.
> Keys derive from a root credential using HKDF, which is a key-derivation
> function based on HMAC, and this design was chosen because... [three
> paragraphs later] ...now, to rotate the key, click **Rotate**.

After:

> ## Rotate an API key
>
> Prerequisites: an admin role on the project.
>
> 1. Open **Settings → API keys**.
> 2. Click **Rotate** next to the key. The old key stays valid for 24 hours.
> 3. Update every client with the new key within that window.
>
> For how key derivation works, see [Key hierarchy](./key-hierarchy.md).

### 3. Marketing README intro → what it is, who it is for

Before:

> Acme is a blazingly fast, next-generation data platform that seamlessly
> unifies your workflows and empowers teams to unlock insights at scale.

After:

> Acme syncs rows between Postgres and your data warehouse. It is for
> backend teams that need sub-minute replication without managing Kafka.
> After the quick start, you have a running sync between two databases.
